import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Which event streams are live, by a name each stream's owner chooses: `household`, `chat:<botId>`.
 * A poll that only stands in for a stream runs while that stream is down, and the connection notice
 * says when live updates have stopped. A stream is down from the moment it connects or fails until an
 * event arrives, and a closed one, as on a hidden page, is not listed at all.
 */
const streams = new Map<string, { up: boolean; since: number }>();
/**
 * How long a stream stays down before the connection notice says live updates stopped. Longer than a
 * deploy's restart or a network handoff, which reconnect in a few seconds, so those never show it.
 */
export const STREAM_NOTICE_MS = 20_000;
/** The name the open chat's change stream reports under, which the draft's poll reads too. */
export const chatStream = (botId: string) => `chat:${botId}`;
const listeners = new Set<() => void>();
let version = 0;

/** Records a stream's state; `undefined` forgets it. A state it already has keeps its time. */
export function reportStream(name: string, up: boolean | undefined) {
  const held = streams.get(name);
  if (up === undefined) { if (!held) return; streams.delete(name); }
  else if (held?.up === up) return;
  else streams.set(name, { up, since: Date.now() });
  version++;
  for (const listener of listeners) listener();
}

/** Whether the named stream is open and has heard from the server since it last connected or failed. */
export function streamUp(name: string) {
  return streams.get(name)?.up === true;
}

/** The earliest moment one of `names` went down and stayed down, or undefined if all are up or closed. */
function downSince(names: readonly string[]) {
  let earliest: number | undefined;
  for (const name of names) {
    const held = streams.get(name);
    if (held && !held.up && (earliest === undefined || held.since < earliest)) earliest = held.since;
  }
  return earliest;
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/**
 * True once one of `names` has been down for `afterMs` without a break, so a brief reconnect never
 * shows. It turns false as soon as that stream hears from the server again or closes.
 */
export function useStreamsDown(names: readonly string[], afterMs: number) {
  useSyncExternalStore(subscribe, () => version);
  const since = downSince(names);
  const [, wake] = useState(0);
  useEffect(() => {
    if (since === undefined) return;
    const wait = since + afterMs - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => wake(count => count + 1), wait);
    return () => clearTimeout(timer);
  }, [since, afterMs]);
  return since !== undefined && Date.now() - since >= afterMs;
}

/** Forgets every stream, as a test's fresh page would. */
export function resetStreamHealth() {
  streams.clear();
  version++;
}
