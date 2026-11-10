import type { Inflight, InflightDelta, Message, TurnEvent, TurnRows } from "./types";

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

const parseVersion = (value: string | undefined) => {
  const parts = value?.split(":") ?? [];
  const epoch = Number(parts[1]), generation = Number(parts[2]);
  return parts.length === 3 && parts[0] && Number.isInteger(epoch) && Number.isInteger(generation) ? { boot: parts[0], epoch, generation } : undefined;
};

/** The server process a structural version came from, or undefined for a missing or malformed version. */
export const versionBoot = (version: string | undefined) => parseVersion(version)?.boot;

/**
 * Orders two structural versions, as `boot:epoch:generation`: negative when `a` is older, zero when equal,
 * positive when newer. Undefined when either is missing or they come from different server processes,
 * whose generations restart, so neither can be called older.
 */
export function compareVersions(a: string | undefined, b: string | undefined): number | undefined {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right || left.boot !== right.boot) return undefined;
  return left.epoch - right.epoch || left.generation - right.generation;
}

const isLive = (message: Message) => message.id.endsWith("-inflight");

/**
 * The messages with a turn's saved messages in place of everything from the turn on, and no live reply.
 * The turn goes where its first message is, or just after the message it names as `after`, or, with
 * `after` null, in place of everything. Undefined when neither is held, or when a message kept before the
 * turn is also in it, so the caller reads the conversation instead of guessing.
 */
export function placeTurn(messages: Message[], turn: TurnRows): Message[] | undefined {
  const saved = messages.filter(message => !isLive(message));
  let end = turn.messages[0] ? saved.findIndex(message => message.id === turn.messages[0].id) : -1;
  if (end < 0 && typeof turn.after === "string") {
    const after = saved.findIndex(message => message.id === turn.after);
    if (after >= 0) end = after + 1;
  }
  if (end < 0 && turn.after === null) end = 0;
  if (end < 0) return undefined;
  const kept = saved.slice(0, end), ids = new Set(turn.messages.map(message => message.id));
  if (kept.some(message => ids.has(message.id))) return undefined;
  return [...kept, ...turn.messages];
}

/**
 * The conversation with a turn event's saved messages and activity, without its live reply, which the
 * caller adds. The same conversation when it is newer than the event; undefined when the turn cannot be placed.
 */
export function withTurn<C extends { messages: Message[]; activity: Inflight["activity"]; toolCalls?: Inflight["toolCalls"]; version?: string }>(
  conversation: C, turn: TurnEvent): C | undefined {
  const order = compareVersions(turn.version, conversation.version);
  if (order !== undefined && order < 0) return conversation;
  const messages = placeTurn(conversation.messages, turn);
  return messages && { ...conversation, messages, version: turn.version, activity: turn.activity, toolCalls: turn.toolCalls };
}
