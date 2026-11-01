import type { RoutineResult } from "./collaboration.js";
import type { Message, Preferences } from "./types.js";

/**
 * Routine runs shown in a conversation: each run's normalized status, where it falls among the
 * conversation's turns, and which runs a delivered scheduled message already shows. Pure, so the
 * web and its tests share one rule; the iOS app mirrors it in RoutineRuns.swift.
 */
export const routineRunStatuses = ["succeeded", "failed", "running", "unknown"] as const;
export type RoutineRunStatus = typeof routineRunStatuses[number];
export interface RoutineRun {
  /** The routine result ID, which the result output route reads. */
  id: string;
  routineId: string;
  routineName: string;
  startedAt?: string;
  finishedAt?: string;
  status: RoutineRunStatus;
  /** It ran, but Hermes could not deliver its output. */
  deliveryFailed?: boolean;
  error?: string;
  preview?: string;
  previewOnly: boolean;
}
export interface RoutineRunPage {
  runs: RoutineRun[];
  /** Routines whose history Hermes could not read this time. Their runs are missing, not absent. */
  unavailable: string[];
}

/** Any status an add-on did not name, or named in a newer way, reads as unknown. */
export const runStatus = (value: unknown): RoutineRunStatus =>
  routineRunStatuses.includes(value as RoutineRunStatus) ? value as RoutineRunStatus : "unknown";

export function routineRun(routine: { id: string; name: string }, result: RoutineResult): RoutineRun {
  return {
    id: result.id, routineId: routine.id, routineName: routine.name, startedAt: result.startedAt, finishedAt: result.finishedAt,
    status: runStatus(result.status), deliveryFailed: result.deliveryFailed || undefined, error: result.error,
    preview: result.preview, previewOnly: result.previewOnly,
  };
}

/** When the run happened, in milliseconds: its start, else its finish. NaN when undated. */
export const runTime = (run: Pick<RoutineRun, "startedAt" | "finishedAt">) => Date.parse(run.startedAt ?? run.finishedAt ?? "");

/** The words that go with the status dot, so the dot never carries meaning alone. */
export function runStatusLabel(run: Pick<RoutineRun, "status" | "deliveryFailed">) {
  if (run.status === "succeeded" && run.deliveryFailed) return "Finished, not delivered";
  return { succeeded: "Succeeded", failed: "Failed", running: "Running", unknown: "Status unknown" }[run.status];
}
/** The dot's color class: a delivery failure warns like a run that needs a look. */
export const runTone = (run: Pick<RoutineRun, "status" | "deliveryFailed">) =>
  run.status === "succeeded" && run.deliveryFailed ? "warning" : run.status;

/** Whether this person hid a routine's runs from its assistant's chat. Shown by default. */
export const runsHidden = (preferences: Pick<Preferences, "hiddenRoutineRuns">, botId: string, routineId: string) =>
  !!preferences.hiddenRoutineRuns?.some(entry => entry.botId === botId && entry.routineId === routineId);
export function withRunsShown<T extends Pick<Preferences, "hiddenRoutineRuns">>(preferences: T, botId: string, routineId: string, shown: boolean): T {
  const rest = (preferences.hiddenRoutineRuns ?? []).filter(entry => entry.botId !== botId || entry.routineId !== routineId);
  return { ...preferences, hiddenRoutineRuns: shown ? rest : [...rest, { botId, routineId }] };
}

/**
 * The runs that belong in the loaded part of the conversation: dated, not hidden, and no older
 * than its oldest loaded message unless the history reaches the start. Paging earlier history
 * then brings in earlier runs with it, so the transcript never shows a run without its neighbors.
 */
export function runsInWindow(runs: RoutineRun[], window: { oldest?: string; complete: boolean; hidden(routineId: string): boolean }) {
  const oldest = Date.parse(window.oldest ?? "");
  if (!window.complete && Number.isNaN(oldest)) return [];
  return runs.filter(run => {
    const at = runTime(run);
    return !Number.isNaN(at) && !window.hidden(run.routineId) && (window.complete || at >= oldest);
  }).sort((a, b) => runTime(a) - runTime(b));
}

// Hermes names its job in both delivery forms; a bot's job name may carry its "[bot:profile] " prefix.
const cronPrompt = /^\[Cronjob "([^\n]+)" output [—-] scheduled job/u;
const cronMirror = /^\[Cron delivery: ([^\n\]]+)\]/u;
const plainName = (name: string) => name.replace(/^\[bot:[^\]]+\]\s*/u, "").trim().toLowerCase();
/** The routine name a scheduled delivery names, or undefined for any other message. */
export function deliveredRoutineName(message: Pick<Message, "text">) {
  const match = cronPrompt.exec(message.text) ?? cronMirror.exec(message.text);
  return match ? plainName(match[1]) : undefined;
}
/** A delivery lands after its run finishes, usually within seconds; a slow agent turn can take minutes. */
export const DELIVERY_BEFORE_MS = 60_000;
export const DELIVERY_AFTER_MS = 30 * 60_000;
/**
 * The runs a scheduled delivery in the transcript already shows. Each delivery claims the one
 * run of the routine it names whose finish it follows most closely, inside the delivery window,
 * so two runs of the same routine are never both hidden by one message.
 */
export function deliveredRuns(runs: RoutineRun[], messages: Pick<Message, "text" | "createdAt">[]) {
  const claimed = new Set<string>();
  for (const message of messages) {
    const name = deliveredRoutineName(message), at = Date.parse(message.createdAt ?? "");
    if (!name || Number.isNaN(at)) continue;
    let best: { id: string; gap: number } | undefined;
    for (const run of runs) {
      if (claimed.has(run.id) || plainName(run.routineName) !== name && run.routineId.toLowerCase() !== name) continue;
      const start = runTime(run), end = Date.parse(run.finishedAt ?? "") || start;
      if (Number.isNaN(start) || at < start - DELIVERY_BEFORE_MS || at > end + DELIVERY_AFTER_MS) continue;
      const gap = Math.abs(at - end);
      if (!best || gap < best.gap) best = { id: run.id, gap };
    }
    if (best) claimed.add(best.id);
  }
  return claimed;
}

/**
 * Which runs go before each turn: `slots[i]` precede turn `i`, and `slots[turns.length]` follow the
 * last. A turn is placed at its first dated message; an undated turn keeps the previous turn's time.
 * A run goes before the first turn that started after it, so equal times keep the turn first.
 */
export function placeRuns(turnTimes: (string | undefined)[], runs: RoutineRun[]): RoutineRun[][] {
  const slots: RoutineRun[][] = Array.from({ length: turnTimes.length + 1 }, () => []);
  let previous = -Infinity;
  const times = turnTimes.map(value => {
    const at = Date.parse(value ?? "");
    previous = Number.isNaN(at) ? previous : Math.max(previous, at);
    return previous;
  });
  for (const run of [...runs].sort((a, b) => runTime(a) - runTime(b))) {
    const at = runTime(run);
    const index = times.findIndex(time => time > at);
    slots[index === -1 ? turnTimes.length : index].push(run);
  }
  return slots;
}

/** How often an open conversation rereads its runs: sooner while one is running. */
export const RUNS_POLL_MS = 60_000;
export const RUNS_RUNNING_POLL_MS = 15_000;
