import type { Message } from "../shared/types";

/** This person's own messages in a chat, newest first, without repeats of the same text. */
export function ownPrompts(messages: readonly Message[] | undefined, userId: string) {
  const seen = new Set<string>();
  const prompts: string[] = [];
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = messages![index]!;
    if (message.role !== "user" || message.sender?.id !== userId || message.id.endsWith("-inflight")) continue;
    const text = message.text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    prompts.push(message.text);
  }
  return prompts;
}

/** Which earlier message the composer shows, counted from the newest; null when browsing has ended. */
export type Recall = { index: number; /** What the composer showed when browsing started. */ draft: string } | null;
export type RecallMove = { recall: Recall; text: string } | null;

/**
 * ArrowUp starts from an empty composer with the caret at the start and walks back through
 * earlier messages; ArrowDown walks forward and finally restores the draft that was there.
 * Returns null when the key should keep its normal meaning.
 */
export function recallStep(recall: Recall, key: "ArrowUp" | "ArrowDown", prompts: readonly string[], text: string, caretAtStart: boolean, caretAtEnd: boolean): RecallMove {
  if (!recall) {
    if (key !== "ArrowUp" || text !== "" || !caretAtStart || !prompts.length) return null;
    return { recall: { index: 0, draft: text }, text: prompts[0]! };
  }
  // Browsing a long recalled message moves the caret through it first.
  if (key === "ArrowUp" ? !caretAtStart : !caretAtEnd) return null;
  if (key === "ArrowUp") {
    const index = Math.min(recall.index + 1, prompts.length - 1);
    return { recall: { ...recall, index }, text: prompts[index]! };
  }
  if (recall.index === 0) return { recall: null, text: recall.draft };
  return { recall: { ...recall, index: recall.index - 1 }, text: prompts[recall.index - 1]! };
}
