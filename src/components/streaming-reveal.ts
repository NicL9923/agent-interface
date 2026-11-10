import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../app/reduced-motion";

/**
 * Paces how a streaming reply's text is painted, apart from when it arrives. The server sends a
 * live reply's growth at most ten times a second (TURN_TICK_MS in src/server/conversation-routes.ts),
 * and Hermes itself streams in bursts; shown as it lands, the text jumps and then stops. Here each update is revealed over the frames that follow it instead.
 *
 * Contract:
 * - What is shown is always a prefix of the text that arrived, cut between graphemes.
 * - Every character shows within CATCH_UP_MS of arriving, however much arrived at once, plus the
 *   wait for the next paced paint, under MIN_FRAME_MS and a frame. On each update the reveal speeds up to clear the whole
 *   backlog in CATCH_UP_MS, and never slows down while text it already had is still hidden.
 * - Paced paints are at least MIN_FRAME_MS apart, across updates as well as frames.
 * - Text that does not continue what is shown, a row's first text, a hidden tab and reduced motion
 *   show at once, with no pacing.
 */
/**
 * How long the reveal takes to catch up with an update. Longer than the server's 100 ms between
 * updates, and long enough to carry the text through Hermes's own short pauses, so it keeps moving
 * instead of stopping and starting. With 100 ms updates, 200 or 150 here showed a word 60 to 90 ms
 * sooner, but on bursty input the 95th-percentile gap between paints grew from 83 ms to 201 and 333:
 * docs/ledger/20261110T210126Z-live-tick.md.
 */
export const CATCH_UP_MS = 300;
/**
 * The least time between two paced renders. Each one re-parses the reply's last block, so this
 * bounds that work to 30 parses a second on a 60 or 120 Hz screen. Measured with
 * .agents/tools/streaming-parse-bench.test.ts.
 */
export const MIN_FRAME_MS = 1000 / 30;

/** Where the reveal stands: `shown` characters of `text` at time `at`, moving at `speed` per millisecond. */
export type Pace = { text: string; shown: number; at: number; speed: number };

export const settledPace = (text: string, now = 0): Pace => ({ text, shown: text.length, at: now, speed: 0 });

/** The reveal's position at `now`, before it is cut to a grapheme boundary. */
export const position = (pace: Pace, now: number) =>
  Math.min(pace.text.length, pace.shown + pace.speed * Math.max(0, now - pace.at));

/** Takes in newly arrived text. `instant` shows it all at once. */
export function arrive(pace: Pace, text: string, now: number, instant = false): Pace {
  if (instant) return settledPace(text, now);
  const current = position(pace, now);
  // Text that no longer starts with what is shown, such as a new reply in the same row, is not
  // a continuation and is shown as it is.
  if (!text.startsWith(pace.text.slice(0, graphemeCut(pace.text, Math.floor(current))))) return settledPace(text, now);
  const moving = current < pace.text.length;
  const speed = Math.max(moving ? pace.speed : 0, (text.length - current) / CATCH_UP_MS);
  return { text, shown: current, at: now, speed };
}

const graphemes = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
/** The longest prefix of `text` no longer than `at` that ends between graphemes. */
export function graphemeCut(text: string, at: number): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  if (graphemes) return graphemes.segment(text).containing(at)?.index ?? at;
  // Without a segmenter, at least never split a surrogate pair.
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/** How many characters of the pace's text show at `now`. */
// The small allowance keeps floating-point error at a deadline from holding back its last character.
export const visibleLength = (pace: Pace, now: number) => graphemeCut(pace.text, Math.floor(position(pace, now) + 1e-6));

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
const instant = () => hidden() || prefersReducedMotion();

/** What the hook shows: `length` characters of `pace.text`, painted at `at`. */
type Shown = { pace: Pace; length: number; at: number };

/**
 * The part of a live reply's `text` to show now. Re-renders on animation frames until the reveal
 * catches up. Every paced paint, whether an arrival or a frame makes it, is at least MIN_FRAME_MS
 * after the last one, so the cap holds however often text arrives. When `live` is false, as once
 * the reply is saved, all of it shows at once.
 */
export function useRevealed(text: string, live = true): string {
  const [state, setState] = useState<Shown>(() => ({ pace: settledPace(text), length: text.length, at: -Infinity }));
  // What the last commit showed and when it was painted, for the frame loop. It outlives each update's loop.
  const painted = useRef({ length: state.length, at: state.at });
  let current = state;
  // New text is taken in during render, so the frame that shows it never paints a stale cut.
  if (state.pace.text !== text || !live && state.length < text.length) {
    const now = performance.now();
    const pace = arrive(state.pace, text, now, !live || instant());
    const paced = pace.shown < pace.text.length;
    const shown = state.pace.text.slice(0, state.length);
    // Text that continues what shows, arriving within MIN_FRAME_MS of the last paint, waits for the
    // next paced frame. The cut is taken again, since new text can extend the last grapheme.
    current = paced && now - state.at < MIN_FRAME_MS - 1 && text.startsWith(shown)
      ? { pace, length: graphemeCut(text, state.length), at: state.at }
      : { pace, length: visibleLength(pace, now), at: now };
    setState(current);
  }
  const { pace, length, at } = current;
  const done = length >= pace.text.length;
  useLayoutEffect(() => { painted.current = { length, at }; }, [length, at]);
  useEffect(() => {
    if (done) return;
    let frame = 0;
    const step = () => {
      frame = 0;
      const now = performance.now();
      if (instant()) { setState(previous => previous.pace === pace ? { pace, length: pace.text.length, at: now } : previous); return; }
      // The 1 ms allows for frame-time jitter, so a 60 Hz screen paints every second frame.
      if (now - painted.current.at >= MIN_FRAME_MS - 1) {
        const next = visibleLength(pace, now);
        if (next !== painted.current.length) {
          painted.current = { length: next, at: now };
          setState(previous => previous.pace === pace ? { pace, length: next, at: now } : previous);
        }
        if (next >= pace.text.length) return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    // A hidden tab runs no frames, so the text shows whole at once instead of waiting.
    const show = () => { if (hidden()) setState(previous => previous.pace === pace ? { pace, length: pace.text.length, at: performance.now() } : previous); };
    document.addEventListener("visibilitychange", show);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", show);
    };
  }, [pace, done]);
  return length >= pace.text.length ? pace.text : pace.text.slice(0, length);
}
