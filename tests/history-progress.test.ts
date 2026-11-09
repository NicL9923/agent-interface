import { describe, expect, it } from "vitest";
import { decodeExperience } from "../src/server/hermes-operation-contracts.js";

// Saved-session pages are read by another add-on route than the open chat, from the same native
// projection, so they must show progress lines by the same rules.
const page = (messages: Record<string, unknown>[]) => decodeExperience("history", { botId: "ranch", sessionId: "s1", offset: 0, hasMore: false, messages }, "ranch", () => []);
const ids = (messages: { id: string; text: string; interim?: boolean }[]) => messages.map(message => [message.id, message.text, message.interim]);

describe("saved history pages", () => {
  it("show a row's progress lines ahead of it, and use Hermes's display copies of its reply and reasoning", () => {
    const { messages } = page([
      { id: 1, role: "user", text: "Weather?" },
      { id: 2, role: "assistant", text: "I'll check.\n\nSunny.", display_content: "Sunny.", display_commentary: ["I'll check."], reasoning: "I'll check.\nNotes", display_reasoning: "Notes" },
    ]);
    expect(ids(messages)).toEqual([["1", "Weather?", undefined], ["2-progress-0", "I'll check.", true], ["2", "Sunny.", undefined]]);
    expect(messages.at(-1)!.reasoning).toBe("Notes");
  });
  it("show no progress line when the profile turned commentary off, and never read raw provider items", () => {
    const { messages } = page([{ id: 2, role: "assistant", text: "Sunny.", display_content: "Sunny.", display_commentary: [],
      codex_message_items: [{ type: "message", phase: "commentary", content: [{ type: "output_text", text: "Raw." }] }] }]);
    expect(ids(messages)).toEqual([["2", "Sunny.", undefined]]);
    // An older add-on without the projection shows the row as it always did.
    expect(ids(page([{ id: 2, role: "assistant", text: "Sunny." }]).messages)).toEqual([["2", "Sunny.", undefined]]);
  });
  it("takes display copies for an assistant's row only, never a person's or a tool's", () => {
    const { messages } = page([{ id: 1, role: "user", text: "Weather?", display_content: "Hijacked", display_reasoning: "x" },
      { id: 2, role: "tool", text: "result", display_content: "Hijacked", name: "web_search" }]);
    expect(messages.map(message => message.text)).toEqual(["Weather?", "result"]);
    expect(messages[0]!.reasoning).toBeUndefined();
  });
  it.each([["a string", "I'll check."], ["null", null], ["an object", { a: 1 }]])("ignores a display_commentary that is %s", (_name, value) => {
    expect(page([{ id: 2, role: "assistant", text: "Sunny.", display_commentary: value }]).messages).toHaveLength(1);
  });
  it("keeps the row's origin on its lines, and never gives a user row any", () => {
    const origin = { kind: "agent", visibility: "activity", name: "Ledger" };
    const { messages } = page([{ id: 2, role: "assistant", text: "x", display_commentary: ["I'll ask."], display_metadata: { origin } },
      { id: 3, role: "user", text: "Hi", display_commentary: ["injected"] }]);
    expect(messages.map(message => [message.id, message.origin?.visibility])).toEqual([["2-progress-0", "activity"], ["2", "activity"], ["3", undefined]]);
  });
});
