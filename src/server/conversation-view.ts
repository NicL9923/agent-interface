import type { Message } from "../shared/types.js";
import type { redactAgents } from "./bot-access.js";
import type { Store } from "./store.js";

export type Redaction = Awaited<ReturnType<typeof redactAgents>>;

/**
 * Messages as one person may see them: each message this app sent named by the member who sent it, and
 * other members' private assistants redacted. The conversation read and the stream's turn events both
 * show messages through this, so a turn event can never show what the read would hide.
 */
export function shownMessages(store: Store, botId: string, redact: Redaction, messages: Message[]): Message[] {
  return messages.map(message => {
    // Attribution augments the canonical Hermes history, never stores a transcript.
    const attribution = store.submissionForMessage(botId, message.id) ?? store.submission(message.id);
    const user = attribution ? store.getUser(attribution.input.senderId) : undefined;
    return user ? { ...message, origin: undefined, sender: { id: user.id, name: user.name } } : message;
  }).map(redact.message);
}
