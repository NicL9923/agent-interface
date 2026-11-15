import { useEffect, useRef, useState } from "react";

/**
 * Back on a phone. Home is the one screen a phone starts from; a chat, group, Today or Search, and
 * anything laid over home such as Settings, is one step in. That step is one history entry, so the
 * system Back gesture and the browser's Back button take the step back the way the on-screen Back
 * does, instead of leaving the app.
 *
 * The screen is the source of truth and history follows it. `depth` is 0 on home and 1 one step in.
 * Each entry this module pushes carries its depth in `history.state`, and `reconcile` pushes or pops
 * until the current entry's depth is the screen's: a step in pushes one entry, a step back made on the
 * screen pops it, and a Back from the browser runs the step back on the screen first. Switching between
 * chats stays one step, so it only replaces the address (see useUrlSync). A two-pane layout has depth 0
 * always, so it never gains an entry, and resizing to one drops the entry a phone layout left.
 */
const KEY = "wbDepth";

/** The depth an entry's state records. Entries this module did not make have none, which is home. */
export function depthOf(state: unknown) {
  const value = (state as Record<string, unknown> | null)?.[KEY];
  return typeof value === "number" && value > 0 ? value : 0;
}

/**
 * Whether the page was opened on an entry that stands for home, one a phone left to go a step in. The address on
 * that entry may still name a chat, so a reload or a Back that reloads the page opens home, not that chat.
 */
export const startsAtHome = () => (history.state as Record<string, unknown> | null)?.[KEY] === 0;

let leaving: Promise<void> | undefined;
/**
 * Ends the entries a previous account's screens left, before the next generation draws. The address names that
 * account's destination and the entry stands for a step in from its home, so the next generation must not meet
 * either: Back would land on the old address with nothing to step back from. The entry this step is on
 * and the home entry under it both take the address `/`, and the step is popped. Resolves once the pop has landed,
 * or after a second if it never does, as when the entry under was dropped; calls made meanwhile share it, so
 * two changes in a row never pop twice. A phone is at most one step in, so one entry is popped.
 */
export function leaveAccountEntries(): Promise<void> {
  if (leaving) return leaving;
  const depth = depthOf(history.state);
  // The entry stepped in from is the one Forward returns to, so it names nothing either.
  history.replaceState(null, "", "/");
  if (depth === 0) return Promise.resolve();
  leaving = new Promise<void>(resolve => {
    const landed = () => {
      window.removeEventListener("popstate", landed);
      clearTimeout(timer);
      history.replaceState(null, "", "/");
      leaving = undefined;
      resolve();
    };
    const timer = setTimeout(landed, 1000);
    window.addEventListener("popstate", landed);
    history.go(-depth);
  });
  return leaving;
}

type Options = {
  /** 0 on home or on a two-pane layout, 1 on a phone one step in. */
  depth: number;
  /** The screen's own Back. True when it closed something laid over the screen, so the screen's depth has not changed. */
  stepBack: () => boolean;
  /** The browser's Forward onto an entry that was a step in. */
  stepForward: () => void;
  /** Writes the address the screen shows onto the current entry, which a pop returns to an older address. */
  syncUrl: () => void;
};

export function useBackNavigation({ depth, stepBack, stepForward, syncUrl }: Options) {
  const shown = useRef(depth);
  // The depth a pop this module started lands on, so its own popstate is not taken for the person's Back.
  const expected = useRef<number | null>(null);
  const [turn, setTurn] = useState(0);
  const latest = useRef({ stepBack, stepForward, syncUrl });
  useEffect(() => { shown.current = depth; latest.current = { stepBack, stepForward, syncUrl }; });

  useEffect(() => {
    const popped = (event: PopStateEvent) => {
      const landed = depthOf(event.state), ours = expected.current === landed;
      expected.current = null;
      if (ours) latest.current.syncUrl();
      else if (landed < shown.current) {
        // A step back that changes the screen settles history itself once the screen has changed.
        if (!latest.current.stepBack()) return;
      } else if (landed > shown.current) latest.current.stepForward();
      // Something stayed open or came back, so the screen may be a step in from the entry it landed on.
      setTurn(count => count + 1);
    };
    window.addEventListener("popstate", popped);
    return () => window.removeEventListener("popstate", popped);
  }, []);

  useEffect(() => {
    const landed = depthOf(history.state);
    if (depth > landed) {
      // The entry stepped in from stands for home, so a Back that lands on it, even after a reload, shows home.
      if ((history.state as Record<string, unknown> | null)?.[KEY] === undefined) history.replaceState({ [KEY]: 0 }, "", location.href);
      history.pushState({ [KEY]: depth }, "", location.href);
    } else if (depth < landed) {
      expected.current = depth;
      history.go(depth - landed);
    }
  }, [depth, turn]);
}
