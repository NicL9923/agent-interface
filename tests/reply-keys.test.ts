import { describe, expect, it } from "vitest";
import { emptyReplyKeys, replyKeys } from "../src/app/reply-keys";
import type { ReplyKeyRecord } from "../src/app/reply-keys";
import type { Message } from "../src/shared/types";

const question: Message = { id: "u1", role: "user", text: "Is the north gate latched?" };
const live = (text: string): Message => ({ id: "s1-inflight", role: "assistant", text });
const reply = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "assistant", text, ...extra });

/** Commits each list of rows in turn, as the turn's view does, and returns the last keys and record. */
function commit(...renders: Message[][]) {
  let record: ReplyKeyRecord = emptyReplyKeys(), keys: Map<string, string> = new Map();
  for (const rows of renders) {
    const result = replyKeys(record, rows);
    keys = new Map(rows.map(message => [message.id, result.key(message)]));
    record = result.record;
  }
  return { keys, record };
}

describe("which key a turn's rows render under", () => {
  it("gives the one saved row that replaced the live row the live row's key, and the next live reply a new one", () => {
    const { keys: during } = commit([question, live("The gate")]);
    const { keys } = commit([question, live("The gate")], [question, reply("m2", "The gate is latched.")], [question, reply("m2", "The gate is latched."), live("Next.")]);
    expect(keys.get("m2")).toBe(during.get("s1-inflight"));
    expect(keys.get("s1-inflight")).not.toBe(during.get("s1-inflight"));
    expect(keys.get("u1")).toBe("u1");
  });

  it("does not guess when two rows appear where the live one was, even if one continues its text", () => {
    const { keys } = commit([question, live("The gate")], [question, reply("m2", "The gate is latched."), reply("p1", "Checking the trough.", { interim: true })]);
    expect(keys.get("m2")).toBe("m2");
    expect(keys.get("p1")).toBe("p1");
  });

  it("does not hand the node to a saved row whose text does not continue what the live row showed", () => {
    const { keys } = commit([question, live("The gate")], [question, reply("m2", "Something else entirely.")]);
    expect(keys.get("m2")).toBe("m2");
  });

  it("hands nothing to a row that is not a saved assistant reply", () => {
    const { keys } = commit([question, live("The gate")], [question, { id: "u2", role: "user", text: "The gate" }]);
    expect(keys.get("u2")).toBe("u2");
  });

  // The rule's four parts, in the order replyKeys states them.
  it("keys a progress line by its own ID, even the one new row and continuing the live text", () => {
    const { keys } = commit([question, live("Gate report.")], [question, reply("p1", "Gate report. Checking the east gate.", { interim: true }), live("The north gate")]);
    expect(keys.get("p1")).toBe("p1");
  });

  it("starts a new live key when a saved row arrives, even if the live text still continues", () => {
    const { keys: before } = commit([question, live("Here is the result.")]);
    const { keys } = commit([question, live("Here is the result.")],
      [question, reply("m2", "Here is the result. The north gate is latched."), live("Here is the result. The east gate is open.")]);
    expect(keys.get("m2")).toBe(before.get("s1-inflight"));
    expect(keys.get("s1-inflight")).not.toBe(before.get("s1-inflight"));
  });

  it("starts a new live key when a progress line arrives, and hands the old one to nobody", () => {
    const { keys: before } = commit([question, live("Gate report.")]);
    const { keys } = commit([question, live("Gate report.")], [question, reply("p1", "Checking the east gate.", { interim: true }), live("Gate report. The north")]);
    expect(keys.get("s1-inflight")).not.toBe(before.get("s1-inflight"));
    expect([...keys.values()]).not.toContain(before.get("s1-inflight"));
  });

  it("hands the live key to a saved reply the server trimmed", () => {
    const { keys: before } = commit([question, live("The gate is latched.\n\n")]);
    const { keys } = commit([question, live("The gate is latched.\n\n")], [question, reply("m2", "The gate is latched.")]);
    expect(keys.get("m2")).toBe(before.get("s1-inflight"));
  });

  it("never gives two rows one key, and keeps each shown row's key, across seeded random updates", () => {
    // Saved replies that continue the live text or not, progress lines, live text that continues or
    // restarts, rows removed or reordered by redaction, and a repeated update, as StrictMode or a
    // replayed event gives.
    let seed = 20261110;
    // The generator's high bits, since its low bits repeat with a short period.
    const random = (below: number) => Math.floor((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 * below);
    let record = emptyReplyKeys(), saved: Message[] = [], text: string | undefined = "The", next = 0;
    let previous = new Map<string, string>();
    for (let step = 0; step < 3000; step++) {
      const choice = random(7);
      if (choice === 0 && text !== undefined) { saved = [...saved, reply(`m${next++}`, random(2) ? `${text} done.` : "Other.")]; text = random(2) ? undefined : `${text} more`; }
      else if (choice === 1) saved = [...saved, reply(`p${next++}`, random(2) ? `${text ?? ""} step.` : "Step.", { interim: true })];
      else if (choice === 2) text = random(2) && text !== undefined ? `${text} word` : "Fresh";
      else if (choice === 3 && saved.length) saved = saved.filter((_, index) => index !== random(saved.length));
      else if (choice === 4 && saved.length > 1) saved = [...saved.slice(1), saved[0]];
      else if (choice === 5) text = undefined;
      const rows = [question, ...saved, ...text === undefined ? [] : [live(text)]];
      const result = replyKeys(record, rows);
      const keys = rows.map(result.key);
      expect(new Set(keys).size, `step ${step}`).toBe(keys.length);
      for (const message of rows) {
        if (message.interim) expect(result.key(message)).toBe(message.id);
        if (!message.id.endsWith("-inflight") && previous.has(message.id)) expect(result.key(message), `step ${step}`).toBe(previous.get(message.id));
      }
      // The same rows again change nothing.
      expect(rows.map(replyKeys(result.record, rows).key)).toEqual(keys);
      previous = new Map(rows.map((message, index) => [message.id, keys[index]]));
      record = result.record;
    }
  });

  it("forgets a handed-on key once its reply leaves the turn, so the record holds only what the turn shows", () => {
    const rows = [question, reply("m2", "The gate is latched.")];
    const { record } = commit([question, live("The gate")], rows);
    expect([...record.handed.keys()]).toEqual(["m2"]);
    const after = replyKeys(record, [question]).record;
    expect(after.handed.size).toBe(0);
    expect(after.shown).toEqual(["u1"]);
  });
});
