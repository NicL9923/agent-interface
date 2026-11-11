import { useEffect, useState } from "react";
import type { Message, SubmissionReceipt, User } from "../shared/types";
import { compareVersions } from "../shared/inflight";
import { isSentCopy, sameDraft } from "./storage";
import type { Draft, Pending, SavedConversation } from "./storage";
/** How long an accepted message may stay missing from a conversation that never shows its run. */
export const ECHO_PATIENCE = 30_000;
/**
 * How long the early thinking row stays while the send's request has not answered. A healthy admission,
 * including one that first stops an idle compaction, answers in well under two seconds; past this the
 * request is in trouble, and the message's own "Sending…" says so without claiming the assistant is on it.
 */
export const SENDING_ROW_MS = 5_000;
/**
 * How long the early thinking row stays after Hermes's copy arrives in a read without the turn's report.
 * The report is normally the next change notice; past this no turn is coming that the row could stand for.
 */
export const COPY_HANDOFF_MS = 5_000;
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
  /** Hermes admitted it into the task that was already running. */
  steered?: boolean;
  /** What Hermes's answer said about its turn, and the version past its admission; see SubmissionReceipt. */
  turn?: SubmissionReceipt["turn"];
  admittedVersion?: string;
  /** The chat showed work when it was sent, so it can only join that work or wait behind it. */
  duringWork?: boolean;
  /** When the request last went out, and whether it has been out longer than SENDING_ROW_MS. */
  sendingSince?: number;
  slow?: boolean;
  /** When Hermes's copy arrived while the chat showed no work yet, and the version of that read; see handingOff. */
  copiedAt?: number;
  copiedVersion?: string;
};
const active = (state: string) => ["thinking", "working", "waiting", "blocked"].includes(state);
/**
 * The index of Hermes's copy of a message in the conversation, or -1. Hermes names a staged prompt by its
 * request ID. Other rows, such as image-only prompts, are matched by their words once it accepted them,
 * after the message that was last when it was sent. A row another member sent is never the copy.
 */
function copyIndex(send: { requestId: string; messageId?: string; text: string; after?: string; senderId: string }, messages: Message[], skip?: ReadonlySet<string>) {
  const named = messages.findIndex(message => (message.id === send.requestId || message.id === send.messageId) && !skip?.has(message.id));
  if (named >= 0) return named;
  const text = send.text.trim();
  if (!text) return -1;
  // Without its anchor, an older message with the same words could pass for this one.
  const start = send.after ? messages.findIndex(message => message.id === send.after) + 1 : 0;
  if (send.after && !start) return -1;
  const found = messages.slice(start).findIndex(message => message.role === "user" && message.text.trim() === text && !skip?.has(message.id)
    && (!message.sender || message.sender.id === send.senderId));
  return found < 0 ? -1 : start + found;
}
/** Whether Hermes's own copy of the message is in the conversation. */
export function echoShown(echo: SentEcho, conversation: SavedConversation) {
  const { request, messageId, sender, after } = echo;
  const { messages } = conversation;
  if (messages.some(message => message.id === request.requestId || message.id === messageId)) return true;
  // Only a message Hermes accepted is matched by its words.
  return echo.status === "accepted" && copyIndex({ requestId: request.requestId, text: request.text, after, senderId: sender.id }, messages) >= 0;
}
/**
 * A message this person sent and Hermes accepted, kept after its echo leaves. A steer and a send Hermes
 * queued or redirected are saved without the sender, so once the echo is gone the row would otherwise read
 * as another member's. It lives in memory with the session that sent it, so it ends with the account's
 * generation, and a chat keeps its newest OWN_SENDS_KEPT. The anchor keeps an older row with the same words
 * from matching, so a send without one (restored after a reload, before the chat was read) claims only a row
 * Hermes named for it. A record ends with its echo when the echo leaves with its copy not shown (see nextSends),
 * as for a send Hermes never saved under its own words, such as a steer joined with another into one row. Equal
 * words cannot tell two rows apart, so the label is a hint, not a binding.
 */
export type OwnSend = { requestId: string; messageId?: string; botId: string; senderId: string; text: string; after?: string };
export const OWN_SENDS_KEPT = 20;
/**
 * The saved rows that are this person's own sends, by the match the echo makes. Each send claims one row,
 * the first that fits after its anchor, so another member's later message with the same words, which has no
 * send of the person's behind it, stays unclaimed.
 */
export function ownSentRows(sends: OwnSend[], conversation: SavedConversation | null): Set<string> {
  const claimed = new Set<string>();
  if (!conversation) return claimed;
  for (const send of sends) {
    if (send.botId !== conversation.botId) continue;
    // Without its anchor, words could match an older row of another member's; only an ID is evidence.
    const index = copyIndex(send.after ? send : { ...send, text: "" }, conversation.messages, claimed);
    if (index >= 0) claimed.add(conversation.messages[index].id);
  }
  return claimed;
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
      request: pending, sender, sentAt: new Date(now).toISOString(), status: "sending", sendingSince: now,
      ...(conversation?.botId === pending.botId && active(conversation.activity.state) ? { duringWork: true } : {}),
      // A live reply's row is replaced as it is saved, so it cannot anchor anything.
      after: conversation?.botId === pending.botId
        ? conversation.messages.findLast(message => !message.id.endsWith("-inflight"))?.id : undefined,
    };
  }
  if (!next) return null;
  if (pending?.requestId === next.request.requestId) {
    const status = sending ? "sending" : "unconfirmed";
    // A retry goes out again, so its bound starts over.
    if (next.status !== status) next = { ...next, status, ...status === "sending" ? { sendingSince: now, slow: false } : {} };
    if (status === "sending" && !next.slow && now - (next.sendingSince ?? now) >= SENDING_ROW_MS) next = { ...next, slow: true };
  } else if (next.status !== "accepted") {
    // A refused, interrupted or abandoned send leaves only the draft it came from.
    if (receipt?.requestId !== next.request.requestId || receipt.status !== "accepted") return null;
    // A typed stop phrase ended Hermes's voice chat and admitted nothing, so no copy is coming; the composer says why.
    if (receipt.turn === "none") return null;
    next = { ...next, status: "accepted", messageId: receipt.messageId, acceptedAt: now, ...(receipt.steered ? { steered: true } : {}),
      ...(receipt.turn ? { turn: receipt.turn } : {}), ...(receipt.admittedVersion ? { admittedVersion: receipt.admittedVersion } : {}) };
  }
  // The handoff's bound runs while another chat is open, so a return never finds the echo still standing for a turn.
  if (next.copiedAt !== undefined && now - next.copiedAt >= COPY_HANDOFF_MS) return null;
  if (conversation?.botId !== next.request.botId) return next;
  if (echoShown(next, conversation)) {
    if (!handingOff(next, conversation)) return null;
    return next.copiedAt === undefined ? { ...next, copiedAt: now, ...conversation.version ? { copiedVersion: conversation.version } : {} } : next;
  }
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
/**
 * Whether the open chat shows its assistant thinking before Hermes reports the turn. A message sent
 * while the chat showed no work starts a turn, so the activity row appears with its echo instead of a
 * round trip later, and Hermes's own report takes over the same row. It ends when the send is refused,
 * fails, is given up or comes back uncertain (the echo leaves or reads as unconfirmed), while its request
 * has been out longer than SENDING_ROW_MS (it returns if Hermes then accepts it), when Hermes steers it
 * into a running task or puts it into the running turn (`joined`), when a typed stop phrase admitted nothing
 * (the echo leaves), when the chat shows the turn's work, when Hermes's copy is followed by a reply or by
 * nothing for COPY_HANDOFF_MS, when a read reports this turn finished, failed or interrupted (`settledHere`), and at the latest
 * when the echo's own patience runs out. While the chat shows work, that work's row is already there, so a
 * message sent then never adds one. Both bounds are read from `now`, so a render never shows a row whose bound
 * passed before its timer stepped the echo, as on returning from another chat.
 */
export function awaitingTurn(echoes: SentEcho[], conversation: SavedConversation | null, now: number): boolean {
  if (!conversation || active(conversation.activity.state)) return false;
  return echoes.some(echo => echo.request.botId === conversation.botId && !echo.duringWork && !joinedWork(echo) && !echo.ran
    && (echo.status === "sending" ? !echo.slow && now - (echo.sendingSince ?? now) < SENDING_ROW_MS
      : echo.status === "accepted" && (!echoShown(echo, conversation)
        || handingOff(echo, conversation) && now - (echo.copiedAt ?? now) < COPY_HANDOFF_MS)));
}
/**
 * Hermes's copy of a message that starts a turn is in the chat, and the turn's report is not yet: they can
 * come in separate reads. The row stays through that gap, so the report takes over the same node and is not
 * announced twice. It ends with the report, with a reply after the copy, or after COPY_HANDOFF_MS.
 */
function handingOff(echo: SentEcho, conversation: SavedConversation) {
  return echo.status === "accepted" && !echo.duringWork && !joinedWork(echo) && !echo.ran && !active(conversation.activity.state)
    && conversation.messages.at(-1)?.role === "user" && !settledHere(echo, conversation);
}
/** Hermes put the message into work already running: steered by the add-on, or into the running turn by Hermes. */
const joinedWork = (echo: SentEcho) => echo.steered || echo.turn === "joined";
/**
 * Whether the chat reports this message's turn finished, failed or interrupted, so its own row, with its Retry,
 * replaces the early one. While Hermes admits a message it has saved the copy but not opened the run, and a read
 * then still reports the turn before. Nothing in that report names its turn: a settled one carries no run ID, and
 * what the chat showed at the send may be a cached copy or nothing.
 *
 * When Hermes's answer says the turn started, a read the server's structural version orders after the answer's
 * arrival (`admittedVersion`) was asked after admission finished, so the run it reports is this one: its settled
 * report counts at once, also in the read that brings the copy, and an earlier read's never does, however late it
 * arrives. Reads from another server process do not compare and fall back to the rule below.
 *
 * A queued turn's report never counts. Hermes saves its row when it accepts it, so the copy shows while the turn it
 * queued behind still runs, and the settle that follows (usually `interrupted`, the default busy mode) is that
 * turn's, in this read or any later one: a settled report carries nothing that tells it from this turn's own. Only
 * a read that shows the run start, which hands the row to Hermes's report, or the handoff bound ends the row.
 *
 * Otherwise, as from an older add-on, an unknown turn, or a receipt without the version, a settled report
 * counts only from a read that began after the one that brought the copy. In the read that brought the copy it
 * never does; the next read or the handoff bound ends the row. Two reads asked inside one admission, the second
 * ordered after the first, still end the row on the turn before's report there.
 */
function settledHere(echo: SentEcho, conversation: SavedConversation) {
  if (!["done", "failed", "interrupted"].includes(conversation.activity.state)) return false;
  if (echo.turn === "queued") return false;
  const admitted = echo.turn === "started" ? compareVersions(conversation.version, echo.admittedVersion) : undefined;
  if (admitted !== undefined) return admitted > 0;
  return (compareVersions(conversation.version, echo.copiedVersion) ?? 0) > 0;
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
    ...(echo.steered ? { steered: true } : {}),
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
/**
 * The person's sends after a change: one is added when Hermes accepts it, from the echo it had until then,
 * and the other person's, or sends past a chat's newest OWN_SENDS_KEPT, are dropped. A send ends with its echo
 * when the echo leaves while its own chat is open and its copy is not shown, the evidence the echo itself
 * uses that no copy is coming: Hermes joined it with other steers, or merged or dropped its queued text.
 * Time cannot bound it, since a queued send may wait as long as the work before it. The same list comes back
 * when nothing changed. A typed stop phrase admitted nothing, so it is never a send.
 * `before` and `after` are the echoes of the same change.
 */
export function nextSends(sends: OwnSend[], before: SentEcho[], after: SentEcho[], { receipt, sender, conversation }: Pick<EchoInput, "receipt" | "sender" | "conversation">): OwnSend[] {
  let next = sends.filter(send => send.senderId === sender?.id);
  const echo = receipt?.status === "accepted" && receipt.turn !== "none" && sender
    ? before.find(each => each.request.requestId === receipt.requestId && each.sender.id === sender.id) : undefined;
  if (echo && receipt && !next.some(send => send.requestId === echo.request.requestId)) {
    const { request, after: anchor } = echo;
    const messageId = echo.messageId ?? receipt.messageId;
    next = [...next, { requestId: request.requestId, botId: request.botId, senderId: echo.sender.id, text: request.text, after: anchor, ...messageId ? { messageId } : {} }];
    const ofChat = next.filter(send => send.botId === request.botId);
    const dropped = new Set(ofChat.slice(0, Math.max(0, ofChat.length - OWN_SENDS_KEPT)));
    if (dropped.size) next = next.filter(send => !dropped.has(send));
  }
  if (conversation) {
    const noCopyComing = (send: OwnSend) => conversation.botId === send.botId
      && before.some(each => each.request.requestId === send.requestId) && !after.some(each => each.request.requestId === send.requestId)
      && copyIndex(send, conversation.messages) < 0;
    if (next.some(noCopyComing)) next = next.filter(send => !noCopyComing(send));
  }
  return next.length === sends.length && next.every((send, index) => send === sends[index]) ? sends : next;
}
export type EchoState = { echoes: SentEcho[]; sends: OwnSend[] };
/** Both lists after a change, together so a send ends in the same step as its echo. */
export const advance = (current: EchoState, input: EchoInput): EchoState => {
  const echoes = nextEchoes(current.echoes, input);
  const sends = nextSends(current.sends, current.echoes, echoes, input);
  return echoes === current.echoes && sends === current.sends ? current : { echoes, sends };
};
/**
 * Follows the open assistant's submissions, and keeps each echo until Hermes's copy replaces it. Also
 * keeps the person's accepted sends, for as long as this mounted app lives (see OwnSend).
 */
export function useSentEchoes(input: Omit<EchoInput, "now">) {
  const { pending, receipt, sending, conversation, sender } = input;
  const [{ echoes, sends }, setState] = useState<EchoState>({ echoes: [], sends: [] });
  const step = () => setState(current => advance(current, { pending, receipt, sending, conversation, sender, now: Date.now() }));
  useEffect(step, [pending, receipt, sending, conversation, sender?.id]);
  const waiting = echoes.some(echo => echo.status === "accepted" && !echo.ran);
  // An accepted message that never shows is checked again once its patience runs out.
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(step, ECHO_PATIENCE + 100);
    return () => clearTimeout(timer);
  }, [waiting, pending, receipt, sending, conversation, sender?.id]);
  // The early row's two bounds: a request still out, and Hermes's copy without the turn's report.
  const deadline = Math.min(...echoes.map(echo => echo.status === "sending" && !echo.slow ? (echo.sendingSince ?? 0) + SENDING_ROW_MS
    : echo.copiedAt !== undefined ? echo.copiedAt + COPY_HANDOFF_MS : Infinity));
  useEffect(() => {
    if (deadline === Infinity) return;
    const timer = setTimeout(step, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline, pending, receipt, sending, conversation, sender?.id]);
  return { echoes, sends };
}
