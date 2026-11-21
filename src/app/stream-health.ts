import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Which event streams are live, by a name each stream's owner chooses: `household`, `chat:<botId>`.
 * A poll that only stands in for a stream runs while that stream is down, and the connection notice
 * says when live updates have stopped. A stream is down from the moment it connects or fails until an
 * event arrives, and a closed one, as on a hidden page, is not listed at all.
 */
const streams = new Map<string, { up: boolean; since: number }>();
/** How often each stream has closed, so a stream closed and reopened between renders is a new one. */
const closings = new Map<string, number>();
/**
 * How long a stream stays down before the connection notice says live updates stopped. Longer than a
 * deploy's restart or a network handoff, which reconnect in a few seconds, so those never show it.
 */
export const STREAM_NOTICE_MS = 20_000;
/**
 * How often a poll still reads while the stream that announces its changes is live. The stream is the
 * fast path and the poll the safety net: streams do not announce everything, and a notice can always be
 * missed, so a poll never stops, and nothing stays stale longer than this and one poll tick. While the
 * stream is down, polls read at their own interval.
 */
export const LIVE_POLL_MS = 2 * 60_000;
/** The name the open chat's change stream reports under, which the draft's poll reads too. */
export const chatStream = (botId: string) => `chat:${botId}`;
const listeners = new Set<() => void>();
let version = 0;

/** Records a stream's state; `undefined` forgets it. A state it already has keeps its time. */
export function reportStream(name: string, up: boolean | undefined) {
  const held = streams.get(name);
  if (up === undefined) {
    if (!held) return;
    streams.delete(name);
    closings.set(name, (closings.get(name) ?? 0) + 1);
  } else if (held?.up === up) return;
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
    if (held && !held.up && (earliest === undefined || held.since < earliest))
      earliest = held.since;
  }
  return earliest;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

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
    const timer = setTimeout(() => wake((count) => count + 1), wait);
    return () => clearTimeout(timer);
  }, [since, afterMs]);
  return since !== undefined && Date.now() - since >= afterMs;
}

/** Where a set of streams stands: all heard from, all open with one still waiting, or one closed. */
export type StreamsLive = "up" | "waiting" | "closed";
/**
 * `live` is `up` while every one of `names` is open and has heard from the server since it last
 * connected or failed. A stream that is closed, as on a hidden page or an offline device, or not yet
 * opened, makes them `closed`: nothing says live updates are back until the streams themselves do.
 *
 * `scope` names these streams as they are now opened. It changes when the names do and whenever one of
 * them closes, even when it reopens before the next render, as a chat's stream does for a new session:
 * what a replacement stream hears says nothing about the stream it replaced.
 */
export function useStreamsLive(names: readonly string[]): { live: StreamsLive; scope: string } {
  useSyncExternalStore(subscribe, () => version);
  const scope = names.map((name) => `${name}#${closings.get(name) ?? 0}`).join(" ");
  if (names.some((name) => !streams.has(name))) return { live: "closed", scope };
  return { live: names.every(streamUp) ? "up" : "waiting", scope };
}

/** Forgets every stream, as a test's fresh page would. */
export function resetStreamHealth() {
  streams.clear();
  closings.clear();
  version++;
}
