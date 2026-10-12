import { describe, expect, it } from "vitest";
import { HISTORY_PAGE_TURNS, historyWindow } from "../src/shared/history.js";
import type { Message } from "../src/shared/types.js";
// Each turn is a prompt, a tool row and a reply.
const history = (turns: number, lead: Message[] = []): Message[] => [...lead, ...Array.from({ length: turns }, (_, turn) => [
  { id: `p${turn}`, role: "user" as const, text: `Prompt ${turn}` },
  { id: `t${turn}`, role: "tool" as const, text: "" },
  { id: `a${turn}`, role: "assistant" as const, text: `Reply ${turn}` },
]).flat()];
const ids = (messages: Message[]) => messages.map(message => message.id);
describe("conversation history window", () => {
  it("opens on the latest page, starting at a prompt", () => {
    const messages = history(HISTORY_PAGE_TURNS + 5);
    const page = historyWindow(messages, { turns: HISTORY_PAGE_TURNS });
    expect(page.messages[0].id).toBe("p5");
    expect(page.messages).toHaveLength(HISTORY_PAGE_TURNS * 3);
    expect(page.earlier).toBe(15);
  });
  it("keeps a loaded window in place as turns arrive and extends it by whole turns", () => {
    const messages = history(30);
    expect(historyWindow(messages, { start: "p25" }).messages[0].id).toBe("p25");
    const extended = historyWindow(messages, { start: "p25", turns: 3 });
    expect(extended.messages[0].id).toBe("p22");
    expect(extended.earlier).toBe(66);
  });
  it("includes replies before the first prompt once the window reaches the beginning", () => {
    const messages = history(2, [{ id: "welcome", role: "assistant", text: "Hello" }]);
    const page = historyWindow(messages, { start: "p1", turns: HISTORY_PAGE_TURNS });
    expect(ids(page.messages).slice(0, 2)).toEqual(["welcome", "p0"]);
    expect(page.earlier).toBe(0);
  });
  it("falls back to the latest page when the loaded start left the history", () => {
    const page = historyWindow(history(40), { start: "session-inflight" });
    expect(page.messages[0].id).toBe("p20");
    expect(page.earlier).toBe(60);
  });
});
