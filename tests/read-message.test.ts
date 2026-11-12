import { describe, expect, it } from "vitest";
import { readMessage } from "../src/server/conversation-view";
import type { Conversation, ConversationOptions, Message } from "../src/shared/types";

/** Hermes at its edge: answers a window that starts at a held message, and the whole history. */
function hermes(messages: Message[]) {
  const reads: (ConversationOptions | undefined)[] = [];
  const conversation = async (_botId: string, options?: ConversationOptions): Promise<Conversation> => {
    reads.push(options);
    const base = { botId: "shared", approvals: [], files: [], activity: { state: "done" as const } };
    if (!options) return { ...base, messages };
    // A progress line is drawn from its reply's row and has no row of its own to start at.
    const start = messages.findIndex(message => message.id === options.window?.start && !message.interim);
    if (!options.window?.start || options.window.turns !== undefined) throw new Error(`Unexpected read ${JSON.stringify(options)}`);
    // A start Hermes cannot find falls back to the latest page, as the add-on does.
    return { ...base, messages: messages.slice(start < 0 ? -2 : start) };
  };
  return { runtime: { conversation }, reads };
}

const messages: Message[] = Array.from({ length: 40 }, (_, n) => ({ id: `m${n}`, role: n % 2 ? "assistant" as const : "user" as const, text: `Message ${n}` }));

describe("readMessage", () => {
  it("finds a message in the window that starts at it, without reading the whole history", async () => {
    const { runtime, reads } = hermes(messages);
    expect(await readMessage(runtime, "shared", "m31")).toEqual(messages[31]);
    expect(reads).toEqual([{ window: { start: "m31" } }]);
  });

  it("reads the whole history for a message the window does not hold, such as a progress line", async () => {
    const line: Message = { id: "m3-progress-0", role: "assistant", text: "Checking the gate", interim: true };
    const { runtime, reads } = hermes([...messages.slice(0, 4), line, ...messages.slice(4)]);
    expect(await readMessage(runtime, "shared", line.id)).toEqual(line);
    expect(reads).toEqual([{ window: { start: line.id } }, undefined]);
  });

  it("answers nothing for a message that is in neither", async () => {
    const { runtime } = hermes(messages);
    expect(await readMessage(runtime, "shared", "gone")).toBeUndefined();
  });
});
