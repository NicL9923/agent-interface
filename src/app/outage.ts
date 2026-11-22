import { useEffect, useLayoutEffect, useState } from "react";

/**
 * How long a lost connection stays off the screen. Most losses are over inside it: a deploy's restart, a
 * network handoff, a phone waking before its radio does. Actions that need the connection are refused
 * from the first moment and say why; only the notice, the dimmed assistants and the announcement wait.
 */
export const OUTAGE_GRACE_MS = 3_000;
/**
 * How long an outage lasts before the notice adds its reason, a retry and details. Until then it is one
 * plain line, because the app is already retrying and there is nothing for the person to do.
 */
export const OUTAGE_LASTING_MS = 10_000;
/** The least time a notice stays once it shows, so one that is answered right after never flashes. */
export const OUTAGE_MIN_SHOWN_MS = 1_000;

export type Outage = {
  /** The outage is on screen, which it still is for its minimum time after it ends. */
  shown: boolean;
  /** It has gone on long enough, or is certain enough, to explain itself and offer a retry. */
  lasting: boolean;
  /** The loss is over, and its notice is only staying out its minimum time. */
  lingering: boolean;
  /**
   * How many losses that were on screen have ended because the connection came back. One that never
   * showed, or was left behind with its `scope`, is not counted: nothing came back that anyone was told
   * was gone.
   */
  recoveries: number;
};

/**
 * One outage: whose it is, where it stands, when it began and when it was drawn on screen. It waits out
 * its grace period, falls due, is shown, and lingers after it ends until it has been shown long enough.
 * Due is not yet shown: the read that ends a loss can land with the timer that ends its grace period,
 * and a loss is only ever shown by a commit in which it still is one.
 */
type Timed = {
  scope: string;
  phase: "grace" | "due" | "shown" | "lingering";
  lasting: boolean;
  since: number;
  shownAt: number;
};
type State = { timed: Timed | null; recoveries: number };

/**
 * When to show that something is down, from the fact that it is (`down`). A loss that may be brief shows
 * after `OUTAGE_GRACE_MS` and clears when it ends, staying at least `OUTAGE_MIN_SHOWN_MS` from when it
 * was drawn. A `definite` one, which waiting cannot fix or which never worked on this page, shows at
 * once and counts as lasting from the start.
 *
 * `scope` names what the loss is a loss of, such as the open chat. When it changes, the outage being
 * timed is dropped in the same render: its notice does not linger over the next scope, a loss there
 * waits its own grace period, and nothing counts as a recovery.
 *
 * Every step is taken by a timer or by `down` changing, and the render only reads where the outage
 * stands, never the clock. A timer that runs late, as in a background tab, moves each step later and
 * skips none.
 */
export function useOutage(down: boolean, definite = false, scope = ""): Outage {
  const [state, setState] = useState<State>({ timed: null, recoveries: 0 });
  const held = state.timed?.scope === scope ? state.timed : null;
  // Before paint, so a loss that has just ended is never drawn for a frame as if it had not.
  useLayoutEffect(() => {
    const now = Date.now();
    setState((was) => {
      const held = was.timed?.scope === scope ? was.timed : null;
      if (down) {
        // A definite loss is shown by this effect's next pass, which the new phase asks for.
        if (!held)
          return {
            ...was,
            timed: { scope, phase: "grace", lasting: false, since: now, shownAt: now },
          };
        // Down again while its notice lingers is the same outage going on.
        if (held.phase === "lingering")
          return { ...was, timed: { ...held, phase: "shown", lasting: held.lasting || definite } };
        // Still a loss as it falls due, or certain before then: this commit is the one that shows it.
        if (held.phase === "due" || (definite && !held.lasting))
          return {
            ...was,
            timed: {
              ...held,
              phase: "shown",
              lasting: held.lasting || definite,
              shownAt: held.phase === "shown" ? held.shownAt : now,
            },
          };
        return was;
      }
      // Another scope's outage is left behind, and one that never showed is simply over.
      if (!held || held.phase === "grace" || held.phase === "due")
        return was.timed ? { ...was, timed: null } : was;
      if (held.phase === "lingering") return was;
      // On screen, and the connection is back.
      return {
        recoveries: was.recoveries + 1,
        timed: now - held.shownAt < OUTAGE_MIN_SHOWN_MS ? { ...held, phase: "lingering" } : null,
      };
    });
  }, [down, definite, scope, held?.phase]);
  useEffect(() => {
    if (!held || held.phase === "due" || (held.phase === "shown" && held.lasting)) return;
    const due =
      held.phase === "grace"
        ? held.since + OUTAGE_GRACE_MS
        : held.phase === "shown"
          ? held.since + OUTAGE_LASTING_MS
          : held.shownAt + OUTAGE_MIN_SHOWN_MS;
    // A deadline already behind the clock is taken at once, not dropped.
    const timer = setTimeout(
      () =>
        setState((was) => {
          // Changed meanwhile: that change set its own timer.
          if (was.timed !== held) return was;
          if (held.phase === "grace") return { ...was, timed: { ...held, phase: "due" } };
          return { ...was, timed: held.phase === "shown" ? { ...held, lasting: true } : null };
        }),
      Math.max(0, due - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [held]);
  // A definite loss shows in the render that first reports it, before the effect above has timed it.
  const certain = down && definite;
  // Due and still a loss is drawn by this very render, so the loss cannot end before its notice shows.
  const drawn =
    held?.phase === "shown" || held?.phase === "lingering" || (held?.phase === "due" && down);
  return {
    shown: certain || drawn,
    lasting: certain || (drawn && !!held?.lasting),
    lingering: !certain && held?.phase === "lingering",
    recoveries: state.recoveries,
  };
}
