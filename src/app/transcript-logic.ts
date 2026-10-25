import type { ActivityState, AttentionRequest, Message } from "../shared/types";
import type { SearchHit } from "../shared/discovery";
import { activityLabels, isActivityMessage, messageOrigin } from "../shared/message-origin";

/** A message a person wrote, as opposed to scheduled prompts, agent envelopes and other activity. */
export function isHumanMessage(message: Message) {
  if (message.role !== "user" || isActivityMessage(message)) return false;
  const kind = messageOrigin(message)?.kind;
  return !kind || kind === "human";
}

/**
 * The person's message a failed turn can resend: the latest human message, when the assistant
 * failed and wrote no reply after it. Live rows and echoes never count; only saved messages can be retried.
 */
export function retryTarget(messages: Message[], state: ActivityState): Message | undefined {
  if (state !== "failed") return undefined;
  const index = messages.findLastIndex(isHumanMessage);
  if (index < 0) return undefined;
  const replied = messages.slice(index + 1).some(message =>
    message.role === "assistant" && !isActivityMessage(message) && !!message.text.trim());
  return replied || messages[index].id.endsWith("-inflight") ? undefined : messages[index];
}

/** "2m 14s", "45s", "1h 3m". Under a second rounds up, so finished work never reads as no time. */
export function formatDuration(milliseconds: number) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const nouns: Record<string, [string, string]> = {
  "Tool calls": ["tool call", "tool calls"],
  [activityLabels.scheduled]: ["scheduled job", "scheduled jobs"],
  [activityLabels.agent]: ["bot message", "bot messages"],
  [activityLabels.subagent]: ["subagent", "subagents"],
  [activityLabels.process]: ["background process", "background processes"],
  [activityLabels.diagnostic]: ["diagnostic", "diagnostics"],
  [activityLabels.human]: ["message", "messages"],
};
/** The accordion a piece of intermediate work belongs to. */
export function workGroup(message: Message) {
  const origin = messageOrigin(message);
  return origin && origin.visibility === "activity" ? activityLabels[origin.kind] : "Tool calls";
}
/** Intermediate work by accordion, in the order each kind first appeared. */
export function workGroups(messages: Message[]) {
  return [...new Set(messages.map(workGroup))].map(label => ({ label, items: messages.filter(message => workGroup(message) === label) }));
}
const time = (value?: string) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
/**
 * How long a finished turn worked: from its earliest timestamp, usually the person's prompt, to its
 * final reply. Undefined when either end has no usable timestamp.
 */
export function turnDuration(turn: { messages: Message[]; work: Message[] }) {
  const reply = turn.messages.findLast(message => message.role === "assistant" && !!message.text.trim());
  const end = time(reply?.createdAt);
  const starts = [...turn.messages, ...turn.work].flatMap(message => [time(message.createdAt), time(message.toolCall?.startedAt)])
    .filter((value): value is number => value !== undefined);
  if (end === undefined || !starts.length) return undefined;
  const start = Math.min(...starts);
  return end > start ? end - start : undefined;
}
/** The fold row: "Worked for 2m 14s · 3 tool calls, 1 subagent", without a duration when unknown. */
export function foldSummary(work: Message[], duration?: number, running = false) {
  const counts = workGroups(work).map(({ label, items }) => {
    const [one, many] = nouns[label] ?? [label.toLowerCase(), label.toLowerCase()];
    return `${items.length} ${items.length === 1 ? one : many}`;
  }).join(", ");
  const lead = running ? "Working" : duration !== undefined ? `Worked for ${formatDuration(duration)}` : "";
  if (!lead) return counts ? counts.charAt(0).toUpperCase() + counts.slice(1) : "Reasoning";
  return counts ? `${lead} · ${counts}` : lead;
}

/** A reply as a Markdown quote, ready to go at the end of a draft. */
export function quoteBlock(text: string) {
  return text.trim().replace(/\r\n?/g, "\n").split("\n").map(line => line.trim() ? `> ${line}` : ">").join("\n");
}
/** A saved reply's title: its words without Markdown marks, on one line. */
export function replyTitle(text: string) {
  return text.replace(/[#*_`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Saved reply";
}

type Question = NonNullable<AttentionRequest["questions"]>[number];
/** Whether a question has an answer worth sending. */
export const answered = (answers: Record<string, string>, question: Question) => !!answers[question.id]?.trim();
/** The next question without an answer after `from`, wrapping, or undefined when all have one. */
export function nextUnanswered(questions: Question[], answers: Record<string, string>, from: number) {
  for (let step = 1; step <= questions.length; step++) {
    const index = (from + step) % questions.length;
    if (!answered(answers, questions[index])) return index;
  }
  return undefined;
}
/** The option a number key picks, 1 to 9, or undefined. */
export function optionForKey(key: string, count: number) {
  if (!/^[1-9]$/.test(key)) return undefined;
  const index = Number(key) - 1;
  return index < count ? index : undefined;
}
/** Selected options for a question that allows several, kept in the order offered. */
export function toggleOption(options: string[], selected: string[], option: string) {
  const next = selected.includes(option) ? selected.filter(item => item !== option) : [...selected, option];
  return options.filter(item => next.includes(item));
}
/** The one answer a question sends: its choices, then the person's own words. */
export function joinAnswer(selected: string[], own: string) {
  return [...selected, own.trim()].filter(Boolean).join(", ");
}

export type FindMatch = { messageId: string; loaded: boolean };
/** Loaded messages whose shown text contains the query, case-insensitively, oldest first. */
export function localMatches(messages: { id: string; text: string }[], query: string): FindMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return messages.filter(message => message.text.toLocaleLowerCase().includes(needle)).map(message => ({ messageId: message.id, loaded: true }));
}
/**
 * Every match, oldest first: search hits from the canonical session for messages not loaded yet,
 * which are older than the loaded window, then the loaded ones. Hits for loaded messages are already
 * counted (or hidden activity), and hits from other sessions belong to the history views.
 */
export function mergeFindMatches(local: FindMatch[], hits: SearchHit[], { botId, sessionId, loadedIds }: {
  botId: string; sessionId?: string; loadedIds: Set<string>;
}): FindMatch[] {
  if (!sessionId) return local;
  const seen = new Set<string>();
  const earlier = hits
    .map((hit, order) => ({ hit, order }))
    .filter(({ hit }) => hit.botId === botId && hit.sessionId === sessionId && !!hit.messageId && !loadedIds.has(hit.messageId)
      && !seen.has(hit.messageId) && !!seen.add(hit.messageId))
    .sort((a, b) => (a.hit.offset ?? Infinity) - (b.hit.offset ?? Infinity) || a.order - b.order)
    .map(({ hit }) => ({ messageId: hit.messageId!, loaded: false }));
  return [...earlier, ...local];
}

/**
 * A stable address for a pending approval, question or secure request, so the status dock above
 * the composer can bring the first one into view with `[data-attention-id]`.
 */
export const attentionAnchor = (kind: "approval" | AttentionRequest["kind"], id: string) => ({
  id: `attention-${kind}-${id.replace(/\s+/g, "-")}`,
  "data-attention-id": id,
  "data-attention-kind": kind,
});
