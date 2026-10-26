import { flushSync } from "react-dom";

/** One animated avatar's share of the frame loop. */
export type FrameAnimation = {
  /**
   * Moves this avatar's clock to `now`, a requestAnimationFrame timestamp, without touching React.
   * Returns how many milliseconds it may sleep before its next frame: 0 for the very next display
   * refresh, or null when it has nothing left to animate.
   */
  advance(now: number): number | null;
  /** Asks React to draw what `advance` just computed. Called inside the frame's single commit. */
  commit(): void;
};

// Every running avatar shares one requestAnimationFrame callback and one synchronous commit per
// frame, so K working avatars cost one React commit, not K. A sleeping avatar is not in `awake`, so
// when every avatar sleeps no frame is requested at all: asking for every display refresh makes the
// page restyle on each one even when nothing paints.
const awake = new Set<FrameAnimation>();
const asleep = new Map<FrameAnimation, ReturnType<typeof setTimeout>>();
let requested = 0;

function request() {
  if (!requested && awake.size) requested = requestAnimationFrame(frame);
}

function frame(now: number) {
  requested = 0;
  const running = [...awake];
  const pauses = running.map(animation => {
    try {
      return animation.advance(now);
    } catch (error) {
      // One broken avatar stops itself, as it did with a loop of its own, and does not take the others with it.
      queueMicrotask(() => { throw error; });
      return null;
    }
  });
  // Committed inside this frame's callback; scheduled React work would land in a second frame, and each costs a restyle.
  flushSync(() => running.forEach(animation => animation.commit()));
  running.forEach((animation, index) => {
    // It may have stopped itself while this frame was committing.
    if (!awake.has(animation)) return;
    const pause = pauses[index];
    if (pause === 0) return;
    awake.delete(animation);
    if (pause === null) return;
    asleep.set(animation, setTimeout(() => {
      asleep.delete(animation);
      awake.add(animation);
      request();
    }, pause));
  });
  request();
}

/** Runs `animation` on the shared frame loop from the next frame until the returned function is called. */
export function startFrames(animation: FrameAnimation) {
  awake.add(animation);
  request();
  return () => {
    awake.delete(animation);
    clearTimeout(asleep.get(animation));
    asleep.delete(animation);
    if (!awake.size && requested) {
      cancelAnimationFrame(requested);
      requested = 0;
    }
  };
}
