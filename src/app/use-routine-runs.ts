import { useMemo, useState } from "react";
import { request } from "../client-api";
import { routeUrl } from "../shared/api";
import type { Message } from "../shared/types";
import { deliveredRuns, runsInWindow, RUNS_POLL_MS, RUNS_RUNNING_POLL_MS, type RoutineRun } from "../shared/routine-runs";
import { useResource } from "./use-resource";

/**
 * The routine runs that belong in the loaded conversation, oldest first, without those a
 * scheduled delivery in it already shows. The list rereads every minute while the chat is on
 * screen, every 15 seconds while a run is going, when the window regains focus, and when a new
 * saved message arrives, as a routine delivery does.
 */
export function useRoutineRuns({ botId, messages, complete, enabled, hiddenRoutines }: {
  botId: string;
  /** The conversation's saved messages, without any still drawn from this device. */
  messages: Message[] | undefined;
  /** The loaded history reaches the start of the conversation. */
  complete: boolean;
  enabled: boolean;
  /** IDs of this assistant's routines whose runs this person hid. */
  hiddenRoutines: readonly string[];
}): RoutineRun[] {
  const lastSaved = messages?.findLast(message => !message.id.endsWith("-inflight"))?.id;
  const [running, setRunning] = useState(false);
  const page = useResource(enabled ? routeUrl("GET /bots/:botId/routine-runs", { botId }) : null, {
    load: (_, signal) => request("GET /bots/:botId/routine-runs", { params: { botId }, signal }),
    onData: value => setRunning(value.runs.some(run => run.status === "running")),
    wake: true, deps: [lastSaved],
    // While a run is going, a quicker reread shows it finish.
    pollMs: running ? RUNS_RUNNING_POLL_MS : RUNS_POLL_MS,
  });
  const oldest = messages?.find(message => message.createdAt)?.createdAt;
  const hidden = hiddenRoutines.join("\n");
  return useMemo(() => {
    if (!messages || !page.data) return [];
    const skip = new Set(hidden.split("\n"));
    const shown = runsInWindow(page.data.runs, { oldest, complete, hidden: routineId => skip.has(routineId) });
    const delivered = deliveredRuns(shown, messages);
    return shown.filter(run => !delivered.has(run.id));
  }, [messages, page.data, oldest, complete, hidden]);
}
