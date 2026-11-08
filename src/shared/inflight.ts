import type { Inflight, InflightDelta } from "./types";

/**
 * Applies a streamed growth notice to the live reply a client holds. Returns undefined when the
 * notice does not continue exactly what the client holds, such as another message, or lengths that
 * differ, so the caller reloads instead of guessing. Lengths count UTF-16 code units, as
 * JavaScript's `String.length` does.
 */
export function applyInflightDelta(held: Inflight | undefined, delta: InflightDelta): Inflight | undefined {
  if (!held || held.botId !== delta.botId || held.message.id !== delta.messageId
    || held.message.text.length !== delta.baseTextLength
    || (held.message.reasoning ?? "").length !== delta.baseReasoningLength) return undefined;
  const reasoning = (held.message.reasoning ?? "") + (delta.appendReasoning ?? "");
  return {
    ...held,
    message: { ...held.message, text: held.message.text + (delta.appendText ?? ""), ...(reasoning ? { reasoning } : {}) },
    activity: delta.activity,
    toolCalls: delta.toolCalls ?? held.toolCalls,
  };
}
