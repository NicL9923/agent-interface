import type { Message } from "./types";
import { isConversationReply, withMessageOrigins } from "./message-origin";

/**
 * Reaction answers: a person answers the reply that ends the chat with one emoji. A reaction is an
 * ordinary message in every way; the send names the reply in `answering`, and the server admits it only
 * while that reply still ends the chat. docs/native-api.md#reaction-answers states the rule for other clients.
 */

/** The reactions offered, in the order the picker shows them. `name` is what the choice means. */
export const REACTIONS = [
  { emoji: "👍", name: "Thumbs up" },
  { emoji: "❤️", name: "Heart" },
  { emoji: "😂", name: "Laugh" },
  { emoji: "🎉", name: "Celebrate" },
  { emoji: "👎", name: "Thumbs down" },
] as const;
export type Reaction = (typeof REACTIONS)[number];

/** Emoji compare without U+FE0F, so a heart typed as U+2764 alone matches the offered ❤️. */
const bare = (text: string) => text.trim().replace(/️/gu, "");
const byBare = new Map<string, Reaction>(
  REACTIONS.map((reaction) => [bare(reaction.emoji), reaction]),
);

/** The reaction a message's whole text is, trimmed and without variation selectors, if it is one. */
export const reactionOf = (text: string): Reaction | undefined => byBare.get(bare(text));

/**
 * A person's message that is one emoji of the set and nothing else. It reads only the message, never
 * its neighbors, so every client and every page of history agrees on it. It is still a message: the
 * transcript, find, unread and search treat it as one. Only the message rail and prompt recall pass over it.
 */
export const isReactionMessage = (message: Message) =>
  message.role === "user" && !message.files?.length && reactionOf(message.text) !== undefined;

/**
 * The reply a reaction sent now would answer: the chat's last message, when it is a settled assistant
 * reply with words or files, not a progress line or activity. Only the last message is read, with the
 * origins its prompt gives it; the server checks the same last message when the answer arrives.
 */
export function answerableReply(messages: readonly Message[]): string | undefined {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || last.id.endsWith("-inflight")) return undefined;
  const reply = withMessageOrigins(messages).at(-1)!;
  return isConversationReply(reply) ? reply.id : undefined;
}
