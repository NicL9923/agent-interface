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

  it("hands nothing while the live reply still continues, even if a saved row appears beside it", () => {
    const { keys: before } = commit([question, live("The gate")]);
    const { keys } = commit([question, live("The gate")], [question, reply("m2", "The gate is latched."), live("The gate is")]);
    expect(keys.get("m2")).toBe("m2");
    expect(keys.get("s1-inflight")).toBe(before.get("s1-inflight"));
  });

  it("hands nothing to a row that is not a saved assistant reply", () => {
    const { keys } = commit([question, live("The gate")], [question, { id: "u2", role: "user", text: "The gate" }]);
    expect(keys.get("u2")).toBe("u2");
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
