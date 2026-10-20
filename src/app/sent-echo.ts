import { useEffect, useState } from "react";
import type { Message, SubmissionReceipt, User } from "../shared/types";
import { isSentCopy, sameDraft } from "./storage";
import type { Draft, Pending, SavedConversation } from "./storage";
/** How long an accepted message may stay missing from a conversation that never shows its run. */
export const ECHO_PATIENCE = 30_000;
/**
 * A sent message shown in the transcript at once, until Hermes's own copy arrives. It never
 * changes what was sent or saved: it is only drawn from the pending submission and its receipt.
 */
export type SentEcho = {
  request: Pending;
  sender: Pick<User, "id" | "name">;
  sentAt: string;
  /** The last message shown when it was sent. A copy of the same words counts only after it. */
  after?: string;
  /** Sending: the request is in flight. Unconfirmed: it ended without a receipt. */
  status: "sending" | "unconfirmed" | "accepted";
  messageId?: string;
  acceptedAt?: number;
  /** The conversation has shown activity since Hermes accepted it. */
  ran?: boolean;
};
const active = (state: string) => ["thinking", "working", "waiting", "blocked"].includes(state);
/** Whether Hermes's own copy of the message is in the conversation. */
export function echoShown(echo: SentEcho, conversation: SavedConversation) {
  const ids = [echo.request.requestId, echo.messageId];
  const { messages } = conversation;
  if (messages.some(message => ids.includes(message.id))) return true;
  // Hermes names a staged prompt by its request ID. Other rows, such as image-only prompts, are
  // matched by their words once it accepted them, after the message that was last when it was sent.
  const text = echo.request.text.trim();
  if (echo.status !== "accepted" || !text) return false;
  // Without its anchor, an older message with the same words could pass for this one.
  const start = echo.after ? messages.findIndex(message => message.id === echo.after) + 1 : 0;
  if (echo.after && !start) return false;
  return messages.slice(start).some(message => message.role === "user" && message.text.trim() === text
    && (!message.sender || message.sender.id === echo.sender.id));
}
/** The echo after the submission, its receipt or the conversation changed. Null removes it. */
export function nextEcho(echo: SentEcho | null, { pending, receipt, sending, conversation, sender, now }: {
  pending: Pending | null;
  receipt: SubmissionReceipt | null;
  sending: boolean;
  conversation: SavedConversation | null;
  sender?: Pick<User, "id" | "name">;
  now: number;
}): SentEcho | null {
  // Another person signed in: nothing of the last one's stays on screen.
  let next = echo && echo.sender.id === sender?.id ? echo : null;
  if (pending && pending.requestId !== next?.request.requestId) {
    if (!sender) return null;
    next = {
      request: pending, sender, sentAt: new Date(now).toISOString(), status: "sending",
      // A live reply's row is replaced as it is saved, so it cannot anchor anything.
      after: conversation?.botId === pending.botId
        ? conversation.messages.findLast(message => !message.id.endsWith("-inflight"))?.id : undefined,
    };
  }
  if (!next) return null;
  if (pending?.requestId === next.request.requestId) {
    const status = sending ? "sending" : "unconfirmed";
    if (next.status !== status) next = { ...next, status };
  } else if (next.status !== "accepted") {
    // A refused, interrupted or abandoned send leaves only the draft it came from.
    if (receipt?.requestId !== next.request.requestId || receipt.status !== "accepted") return null;
    next = { ...next, status: "accepted", messageId: receipt.messageId, acceptedAt: now };
  }
  if (conversation?.botId !== next.request.botId) return next;
  if (echoShown(next, conversation)) return null;
  if (next.status !== "accepted") return next;
  // Some prompts are saved only when their run finishes, so the echo stands in until then.
  if (active(conversation.activity.state)) return next.ran ? next : { ...next, ran: true };
  return next.ran || now - (next.acceptedAt ?? now) > ECHO_PATIENCE ? null : next;
}
type EchoInput = Parameters<typeof nextEcho>[1];
/**
 * Every echo after a change. A message Hermes accepted stays until its own copy arrives, even
 * when another is sent meanwhile, such as guidance after a photo whose row is saved only when its
 * run ends. The same list comes back when nothing changed.
 */
export function nextEchoes(echoes: SentEcho[], input: EchoInput): SentEcho[] {
  const { pending } = input;
  const next = echoes.flatMap(echo => {
    const advanced = nextEcho(echo, { ...input, pending: pending?.requestId === echo.request.requestId ? pending : null });
    return advanced ? [advanced] : [];
  });
  // A send gets one echo; once it leaves, the same pending submission never brings it back.
  if (pending && !echoes.some(echo => echo.request.requestId === pending.requestId)) {
    const created = nextEcho(null, input);
    if (created) next.push(created);
  }
  return next.length === echoes.length && next.every((echo, index) => echo === echoes[index]) ? echoes : next;
}
/** The conversation with its echoes at the end, as the person's own messages. */
export function withEchoes(conversation: SavedConversation | null, echoes: SentEcho[]): SavedConversation | null {
  const shown = conversation ? echoes.filter(echo => echo.request.botId === conversation.botId && !echoShown(echo, conversation)) : [];
  if (!conversation || !shown.length) return conversation;
  const messages = shown.map((echo): Message => ({
    id: echo.request.requestId,
    role: "user",
    text: echo.request.text,
    createdAt: echo.sentAt,
    sender: echo.sender,
    ...(echo.request.attachments.length ? { files: echo.request.attachments } : {}),
  }));
  return { ...conversation, messages: [...conversation.messages, ...messages] };
}
/**
 * Whether the composer is showing the copy that is on its way. The echo carries it in the
 * transcript, so the composer reads empty, and read-only so the copy stays the one sent. Once the
 * draft is anything else, such as the server's cleared copy, the composer is free again.
 */
export function sendingDraft(draft: Draft, pending: Pending | null, sending: boolean) {
  return sending && !!pending && draft.botId === pending.botId && isSentCopy(draft) && sameDraft(draft, pending);
}
/**
 * The draft after a send was refused: the sent text and files go back in front of anything that
 * replaced them meanwhile, such as an edit from another device, unless it still holds them. The
 * native client restores a discarded send the same way.
 */
export function restoreSent(draft: Draft, request: Pick<Pending, "text" | "attachments">): Draft {
  const missing = request.attachments.filter(file => !draft.attachments.some(kept => kept.id === file.id));
  const textKept = draft.text.includes(request.text);
  if (textKept && !missing.length) return draft;
  return {
    ...draft,
    dirty: true,
    text: textKept ? draft.text : [request.text, draft.text].filter(Boolean).join("\n\n"),
    attachments: [...missing, ...draft.attachments],
  };
}
/** Follows the open assistant's submissions, and keeps each echo until Hermes's copy replaces it. */
export function useSentEchoes(input: Omit<EchoInput, "now">) {
  const { pending, receipt, sending, conversation, sender } = input;
  const [echoes, setEchoes] = useState<SentEcho[]>([]);
  useEffect(() => {
    setEchoes(current => nextEchoes(current, { pending, receipt, sending, conversation, sender, now: Date.now() }));
  }, [pending, receipt, sending, conversation, sender?.id]);
  const waiting = echoes.some(echo => echo.status === "accepted" && !echo.ran);
  // An accepted message that never shows is checked again once its patience runs out.
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setEchoes(current => nextEchoes(current, { pending, receipt, sending, conversation, sender, now: Date.now() })), ECHO_PATIENCE + 100);
    return () => clearTimeout(timer);
  }, [waiting, pending, receipt, sending, conversation, sender?.id]);
  return echoes;
}
