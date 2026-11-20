import type { Message } from "./types";
import { isConversationReply, isHumanMessage, withMessageOrigins } from "./message-origin";

/**
 * Reaction answers: a person answers the assistant's reply with one emoji, and the emoji shows on that
 * reply instead of as a message of its own. A reaction is an ordinary message; nothing about it is
 * stored apart from its text. docs/native-api.md#reaction-answers states the rule for other clients.
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
const bare = (text: string) => text.trim().replace(/\uFE0F/gu, "");
const byBare = new Map<string, Reaction>(
  REACTIONS.map((reaction) => [bare(reaction.emoji), reaction]),
);

/** The reaction a message's whole text is, trimmed and without variation selectors, if it is one. */
export const reactionOf = (text: string): Reaction | undefined => byBare.get(bare(text));

/**
 * A row the transcript does not show as a message: a tool result, or an assistant row with no words
 * and no files, which carries a tool call or reasoning. A reaction looks past these to its reply.
 */
const isToolRow = (message: Message) =>
  message.role === "tool" ||
  (message.role === "assistant" && !message.text.trim() && !message.files?.length);

/** What the reaction rule finds in a list of messages. */
export type ReactionReading = {
  /** Each reaction answer's ID, mapped to the ID of the reply it answers. */
  answers: Map<string, string>;
  /**
   * The reply a reaction sent now would answer, when it is the last message apart from reactions to
   * it. A tool row after it leaves none, since the reply is then no longer what the chat ends with.
   */
  latest?: string;
};

/**
 * Which messages are reaction answers, and which reply a new one would answer. A message is a
 * reaction answer when a person sent it, it has no files, its text is one reaction, and the nearest
 * earlier message that is neither a tool row nor a reaction is an assistant reply, not a progress
 * line. Several reactions in a row, from one member or several, answer the same reply.
 *
 * Only `messages` are read, so the first loaded message is never a reaction: what it follows is not known.
 */
export function readReactions(messages: readonly Message[]): ReactionReading {
  const answers = new Map<string, string>();
  // The reply a reaction here would answer, or undefined when the last shown message is not one.
  let reply: string | undefined;
  let latest: string | undefined;
  // Origins decide what is activity: a reply to an agent's or diagnostic prompt is not a conversation reply.
  for (const message of withMessageOrigins(messages)) {
    if (isToolRow(message)) {
      latest = undefined;
      continue;
    }
    if (
      reply &&
      isHumanMessage(message) &&
      !message.files?.length &&
      reactionOf(message.text) !== undefined
    ) {
      answers.set(message.id, reply);
      continue;
    }
    reply = latest = isConversationReply(message) ? message.id : undefined;
  }
  return { answers, latest };
}

/** Each reaction answer's ID, mapped to the reply it answers. See readReactions. */
export const reactionAnswers = (messages: readonly Message[]) => readReactions(messages).answers;
