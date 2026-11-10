import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../app/reduced-motion";

/**
 * Paces how a streaming reply's text is painted, apart from when it arrives. The server sends a
 * live reply's growth at most four times a second; shown as it lands, the text jumps a line or two
 * and then stops. Here each update is revealed over the frames that follow it instead.
 *
 * Contract:
 * - What is shown is always a prefix of the text that arrived, cut between graphemes.
 * - Every character shows within CATCH_UP_MS of arriving, however much arrived at once. On each
 *   update the reveal speeds up to clear the whole backlog in CATCH_UP_MS, and never slows down
 *   while text it already had is still hidden.
 * - Text that does not continue what is shown, a row's first text, a hidden tab and reduced motion
 *   show at once, with no pacing.
 */
/**
 * How long the reveal takes to catch up with an update. A little longer than the server's
 * 250 ms between updates, so the next one lands while the last is still being revealed and the
 * text keeps moving instead of stopping and starting.
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

/**
 * The part of a live reply's `text` to show now. Re-renders on animation frames, at most once per
 * MIN_FRAME_MS, until the reveal catches up.
 */
export function useRevealed(text: string): string {
  const [state, setState] = useState(() => ({ pace: settledPace(text), length: text.length }));
  let current = state;
  // New text is taken in during render, so the frame that shows it never paints a stale cut.
  if (state.pace.text !== text) {
    const now = performance.now();
    const pace = arrive(state.pace, text, now, instant());
    current = { pace, length: visibleLength(pace, now) };
    setState(current);
  }
  const { pace, length } = current;
  const done = length >= pace.text.length;
  useEffect(() => {
    if (done) return;
    let frame = 0, last = -Infinity;
    const step = (time: number) => {
      frame = 0;
      if (instant()) { setState(previous => previous.pace === pace ? { pace, length: pace.text.length } : previous); return; }
      if (time - last >= MIN_FRAME_MS - 1) {
        last = time;
        const next = visibleLength(pace, performance.now());
        setState(previous => previous.pace === pace && previous.length !== next ? { pace, length: next } : previous);
        if (next >= pace.text.length) return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    // A hidden tab runs no frames, so the text shows whole at once instead of waiting.
    const show = () => { if (hidden()) setState(previous => previous.pace === pace ? { pace, length: pace.text.length } : previous); };
    document.addEventListener("visibilitychange", show);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", show);
    };
  }, [pace, done]);
  return length >= pace.text.length ? pace.text : pace.text.slice(0, length);
}
