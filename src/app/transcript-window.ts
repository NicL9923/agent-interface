import { useRef } from "react";
import type { FileRef, Message, MessageOrigin, ToolCall } from "../shared/types";
import { continueOrigins, isActivityMessage, messageOrigin, withMessageOrigins } from "../shared/message-origin";
import { conversationArtifacts, continueReplyArtifacts, finishReplyArtifacts, replyArtifacts, startReplyArtifacts,
  type Artifact, type ReplyArtifactsState } from "../shared/artifacts";
import { continueDraftRevisions, startDraftRevisions, type DraftRevisionsState } from "../shared/draft-diff";
import type { EarlierFiles } from "../shared/history";
import { isAgentExchange } from "../components/AgentExchange";
import { isLiveRow } from "./reply-keys";
import { isHumanMessage } from "./transcript-logic";

/**
 * The transcript's derived views (turns, reply file chips, draft revisions) read every loaded message,
 * but while a reply streams only its live row changes. Each view is read once over the settled messages,
 * those before the first live row, and that reading is continued over the live rows on each change.
 * Every continuation gives what one reading of the whole window gives; tests/transcript-window.test.ts
 * holds them to it at every split.
 */

/**
 * The window split at its first live row. `settled` stays the same array while it holds the same
 * message objects in the same order, so work keyed on it is reused. The client never changes a message
 * in place: a read whose content changed builds new objects, and patches copy, so an edited or redacted
 * message is a new object and ends the reuse. A read that answers 304, or the same bytes as before,
 * returns the cached response and its objects (`src/client-api.ts`), and reuse is right there because
 * nothing changed. `live` likewise stays the same array while its rows do.
 */
export function useSettledWindow(messages: Message[]): { settled: Message[]; live: Message[] } {
  const held = useRef<{ settled: Message[]; live: Message[] }>({ settled: [], live: [] });
  const at = messages.findIndex(isLiveRow);
  const end = at < 0 ? messages.length : at;
  const same = (kept: Message[], from: number, to: number) => kept.length === to - from && kept.every((message, index) => message === messages[from + index]);
  const previous = held.current;
  const settled = same(previous.settled, 0, end) ? previous.settled : messages.slice(0, end);
  const live = same(previous.live, end, messages.length) ? previous.live : messages.slice(end);
  // Written during render: a render React discards leaves a value the next render checks again before using.
  if (settled !== previous.settled || live !== previous.live) held.current = { settled, live };
  return held.current;
}

export type Turn = { messages: Message[]; tools: Map<string, Message>; reasoning: string[]; replyAt?: string };
/** Turns over the settled messages: as the reading left them, to continue, and as shown. */
export type SettledTurns = { read: Turn[]; shown: Turn[]; prompt?: MessageOrigin; advanced: boolean };
const blankTurn = (): Turn => ({ messages: [], tools: new Map(), reasoning: [] });
const startsTurn = (message: Message) => isHumanMessage(message) || message.role === "user" && messageOrigin(message)?.kind === "scheduled";
function visibleMessage(message: Message) {
  return message.role !== "assistant" || isAgentExchange(message) || !!message.text.trim() || !!message.files?.length;
}
const running = (turn: Turn) => [...turn.tools.values()].some(message => message.toolCall?.status === "running");
/** `turns` writes only turns it owns; a turn it reuses is copied before its first change. */
type Writable = (index: number) => Turn;
function readTurns(turns: Turn[], messages: Message[], advanced: boolean, writable: Writable, own: (turn: Turn) => void) {
  for (const message of messages) {
    // A person's message or a scheduled prompt starts a turn. Subagent, process and agent rows that
    // Hermes files as user messages belong to the work of the turn they arrive in.
    if (!turns.length || startsTurn(message)) { turns.push(blankTurn()); own(turns.at(-1)!); }
    const turn = writable(turns.length - 1);
    // A turn's reasoning parts share one accordion instead of a block per reply row.
    if (advanced && !isActivityMessage(message) && message.role === "assistant" && message.reasoning?.trim()) turn.reasoning.push(message.reasoning.trim());
    // A tool-call row with no reply text would render as an empty bubble.
    if (!isActivityMessage(message) && message.role !== "tool" && visibleMessage(message)) {
      // A progress line says what the assistant is about to do, so the work still ahead is not folded above it.
      if (message.role !== "user" && !message.interim && turn.tools.size && turn.replyAt === undefined) turn.replyAt = message.id;
      turn.messages.push(message);
    }
    if (isActivityMessage(message) || message.role === "tool" || message.toolCall) {
      turn.tools.set(message.id, message);
      turn.replyAt = undefined;
    }
  }
}
export function settleTurns(settled: Message[], advanced: boolean): SettledTurns {
  const { messages, prompt } = continueOrigins(settled);
  const read: Turn[] = [];
  readTurns(read, messages, advanced, index => read[index], () => {});
  // Live calls update receipts, but only saved row order establishes where the reply starts.
  const shown = read.map(turn => running(turn) ? { ...turn, replyAt: undefined } : turn);
  return { read, shown, prompt, advanced };
}
/** The turns with the live rows and the running turn's calls. A turn neither changes keeps its object. */
export function continueTurns(settled: SettledTurns, live: Message[], calls: ToolCall[] = []): Turn[] {
  if (!live.length && !calls.length) return settled.shown;
  const turns = settled.read.slice(), owned = new Set<Turn>();
  const own = (turn: Turn) => { owned.add(turn); };
  const writable: Writable = index => {
    if (!owned.has(turns[index])) {
      const turn = turns[index];
      turns[index] = { messages: [...turn.messages], tools: new Map(turn.tools), reasoning: [...turn.reasoning], replyAt: turn.replyAt };
      owned.add(turns[index]);
    }
    return turns[index];
  };
  readTurns(turns, withMessageOrigins(live, settled.prompt), settled.advanced, writable, own);
  for (const call of calls) {
    // Native history can reuse a tool ID. Only a unique row is safe to reconcile.
    const matches = turns.flatMap((turn, index) => [...turn.tools.values()].filter(message => message.toolCall?.id === call.id)
      .map(message => ({ index, message })));
    if (matches.length === 1) {
      const { index, message } = matches[0];
      writable(index).tools.set(message.id, { ...message, toolCall: call });
    } else {
      if (!turns.length) { turns.push(blankTurn()); own(turns[0]); }
      writable(turns.length - 1).tools.set(`live-${call.id}`, { id: `live-${call.id}`, role: "tool", text: "", toolCall: call });
    }
  }
  return turns.map((turn, index) => {
    if (!owned.has(turn)) return settled.shown[index];
    if (running(turn)) turn.replyAt = undefined;
    return turn;
  });
}

/** The reply file chips of the settled messages, ready to continue. See replyArtifacts. */
export const settleChips = (settled: Message[], files: FileRef[] | undefined, earlier: EarlierFiles["messages"]): ReplyArtifactsState =>
  continueReplyArtifacts(startReplyArtifacts(conversationArtifacts(settled, earlier, files), earlier), settled);
/**
 * The chips with the live rows after the settled ones. A live row's file would change which files
 * the conversation lists and their sources, so a live row with files reads the whole window again.
 */
export function continueChips(state: ReplyArtifactsState, settled: Message[], live: Message[], files: FileRef[] | undefined,
  earlier: EarlierFiles["messages"]): Map<string, Artifact[]> {
  if (!live.some(message => message.files?.length)) return finishReplyArtifacts(live.length ? continueReplyArtifacts(state, live) : state);
  const all = [...settled, ...live];
  return replyArtifacts(all, conversationArtifacts(all, earlier, files), earlier);
}

export const settleRevisions = (settled: { id: string; role: string; text: string }[]): DraftRevisionsState => continueDraftRevisions(startDraftRevisions(), settled);
