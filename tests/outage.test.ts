// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OUTAGE_GRACE_MS,
  OUTAGE_LASTING_MS,
  OUTAGE_MIN_SHOWN_MS,
  useOutage,
  type Outage,
} from "../src/app/outage";
import { mountRoot, type Mount } from "./ui-harness";

// When a lost connection goes on screen: after a grace period that hides blips, at once when waiting
// cannot fix it, in more words once it lasts, and never as a flash.
let seen: Outage[];
// Moves the clock forward as the given render commits, before its effects run, as a slow commit does.
let slowCommit: { render: number; by: number } | undefined;
function Probe({ down, definite, scope }: { down: boolean; definite?: boolean; scope?: string }) {
  seen.push(useOutage(down, definite, scope));
  useLayoutEffect(() => {
    if (!slowCommit || --slowCommit.render > 0) return;
    vi.setSystemTime(Date.now() + slowCommit.by);
    slowCommit = undefined;
  });
  return null;
}
let mount: Mount;
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-11-19T12:00:00Z") });
  seen = [];
  slowCommit = undefined;
  mount = mountRoot();
});
afterEach(() => {
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const set = (down: boolean, definite = false, scope?: string) =>
  mount.render(createElement(Probe, { down, definite, scope }));
const now = () => seen.at(-1)!;
const everShown = () => seen.some((outage) => outage.shown);

describe("an outage", () => {
  it("shows after the grace period, not a millisecond sooner, and clears when it ends", async () => {
    await set(false);
    await set(true);
    await advance(OUTAGE_GRACE_MS - 1);
    expect(everShown()).toBe(false);
    await advance(1);
    expect(now()).toMatchObject({ shown: true, lasting: false, lingering: false });
    await advance(OUTAGE_MIN_SHOWN_MS);
    await set(false);
    expect(now()).toMatchObject({ shown: false, lasting: false, lingering: false });
  });

  // The render that finds the loss due and still a loss draws it. Were it drawn a commit later, the
  // loss could end in between and its notice would first appear with the connection already back.
  it("is drawn by the first render after its grace period, with no render in between", async () => {
    await set(true);
    await advance(OUTAGE_GRACE_MS - 1);
    seen = [];
    await advance(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((outage) => outage.shown)).toBe(true);
  });

  it("never shows a loss that ends inside the grace period, and times the next one from its own start", async () => {
    await set(true);
    await advance(OUTAGE_GRACE_MS - 1);
    await set(false);
    // The app renders again for some other reason just after the grace period would have ended.
    await advance(2);
    await set(false);
    await advance(OUTAGE_GRACE_MS * 2);
    expect(everShown()).toBe(false);
    await set(true);
    await advance(OUTAGE_GRACE_MS - 1);
    expect(everShown()).toBe(false);
    await advance(1);
    expect(now().shown).toBe(true);
  });

  it("counts as lasting 10 seconds after it began, not a millisecond sooner", async () => {
    await set(true);
    await advance(OUTAGE_LASTING_MS - 1);
    expect(now()).toMatchObject({ shown: true, lasting: false });
    await advance(1);
    expect(now()).toMatchObject({ shown: true, lasting: true });
  });

  it("shows a definite loss at once and as lasting, whether it starts or becomes definite", async () => {
    await set(true, true);
    expect(seen.every((outage) => outage.shown && outage.lasting)).toBe(true);
    await set(false);
    await advance(OUTAGE_MIN_SHOWN_MS);
    seen = [];
    // A loss still inside its grace period that turns out to need a person stops waiting.
    await set(true);
    await advance(OUTAGE_GRACE_MS - 1);
    expect(everShown()).toBe(false);
    await set(true, true);
    expect(now()).toMatchObject({ shown: true, lasting: true });
  });

  // What made a loss certain can pass while the loss goes on, as when live updates return before the
  // app does. A notice already on screen must not hide for the rest of a grace period and come back,
  // or fall back to its one-line form.
  it.each([
    ["from its start", undefined],
    ["a second in", 1_000],
  ])(
    "stays as it is when a loss that was definite %s stops being definite",
    async (_name, after) => {
      if (after !== undefined) {
        await set(true);
        await advance(after);
      }
      await set(true, true);
      seen = [];
      await set(true, false);
      await advance(OUTAGE_GRACE_MS);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((outage) => outage.shown && outage.lasting)).toBe(true);
    },
  );

  // The minimum time is the notice's, from when it was drawn. Learning more about the loss later, as
  // when live updates stop too, does not start it again.
  it("clears a notice that has been shown long enough at once, though the loss became definite meanwhile", async () => {
    await set(true);
    // Two steps, so the notice is drawn when it falls due and not when this wait ends.
    await advance(OUTAGE_GRACE_MS);
    await advance(OUTAGE_MIN_SHOWN_MS);
    await set(true, true);
    await advance(OUTAGE_MIN_SHOWN_MS / 2);
    await set(false);
    expect(now()).toMatchObject({ shown: false, lingering: false });
  });

  it("keeps a notice that just appeared for a second after the loss ends, then clears it", async () => {
    await set(true);
    await advance(OUTAGE_GRACE_MS);
    await set(false);
    expect(now()).toMatchObject({ shown: true, lingering: true });
    await advance(OUTAGE_MIN_SHOWN_MS - 1);
    expect(now().shown).toBe(true);
    await advance(1);
    expect(now()).toMatchObject({ shown: false, lingering: false });
  });

  // A lingering notice keeps the words it had: one that named its reason does not shrink to one line.
  it("keeps a lingering notice in the form it had", async () => {
    await set(true, true);
    await advance(OUTAGE_MIN_SHOWN_MS - 1);
    await set(false);
    expect(now()).toMatchObject({ shown: true, lasting: true, lingering: true });
  });

  // A timer held back, as in a throttled background tab, can draw the notice long after it was due.
  // The second counts from when it was drawn, or the next successful read would flash it.
  it("keeps a notice a second from when it was first drawn, however late that was", async () => {
    await set(true);
    // The clock moves on without the grace period's timer, which then runs two seconds late.
    vi.setSystemTime(Date.now() + 2 * OUTAGE_MIN_SHOWN_MS);
    await advance(OUTAGE_GRACE_MS);
    expect(now().shown).toBe(true);
    await set(false);
    expect(now().shown).toBe(true);
    await advance(OUTAGE_MIN_SHOWN_MS - 1);
    expect(now().shown).toBe(true);
    await advance(1);
    expect(now().shown).toBe(false);
  });

  // A commit can take long enough for a deadline to pass between the render and its effects. The
  // deadline still counts: it used to be dropped, and the notice then waited for the next one.
  it("shows at once when the grace period passed before its timer could be set", async () => {
    slowCommit = { render: 2, by: OUTAGE_GRACE_MS + 1 };
    await set(true);
    expect(slowCommit, "the clock moved during the commit that timed the loss").toBeUndefined();
    await advance(0);
    expect(now().shown).toBe(true);
  });

  // The read that ends a loss can land in the same breath as its grace period's timer. The loss was
  // never on screen while it was one, so it is not drawn for a second now, and is no recovery.
  it("shows nothing and counts no recovery when the loss ends as its grace period does", async () => {
    await set(true);
    await advance(OUTAGE_GRACE_MS - 1);
    seen = [];
    await act(async () => {
      vi.advanceTimersByTime(1);
      mount.root.render(createElement(Probe, { down: false }));
    });
    await advance(OUTAGE_MIN_SHOWN_MS);
    expect(seen.length).toBeGreaterThan(0);
    expect(everShown()).toBe(false);
    expect(now().recoveries).toBe(0);
  });

  // A loss belongs to what it was a loss of, such as one chat. Another chat neither inherits its
  // notice nor the time it had already been down.
  it("starts over for another scope: nothing lingers on it, and its own loss waits its own grace period", async () => {
    await set(true, false, "a");
    await advance(OUTAGE_GRACE_MS);
    expect(now().shown).toBe(true);
    // From the first render for the other scope, so nothing derived from it is ever a render stale.
    seen = [];
    await set(false, false, "b");
    expect(seen.length).toBeGreaterThan(0);
    await set(true, false, "b");
    await advance(OUTAGE_GRACE_MS - 1);
    expect(seen.length).toBeGreaterThan(0);
    expect(everShown()).toBe(false);
    await advance(1);
    expect(now().shown).toBe(true);
  });

  it("carries a loss that returns while its notice lingers as the same outage", async () => {
    await set(true);
    await advance(OUTAGE_GRACE_MS);
    await set(false);
    await advance(OUTAGE_MIN_SHOWN_MS - 1);
    await set(true);
    // No new grace period hides it, and it lasts from when it first began.
    expect(now()).toMatchObject({ shown: true, lingering: false });
    await advance(OUTAGE_LASTING_MS - OUTAGE_GRACE_MS - OUTAGE_MIN_SHOWN_MS);
    expect(now()).toMatchObject({ shown: true, lasting: false });
    await advance(1);
    expect(now()).toMatchObject({ shown: true, lasting: true });
  });

  it("gives a loss that follows a cleared notice its own grace period", async () => {
    await set(true);
    await advance(OUTAGE_GRACE_MS);
    await set(false);
    await advance(OUTAGE_MIN_SHOWN_MS);
    expect(now().shown).toBe(false);
    seen = [];
    await set(true);
    await advance(OUTAGE_GRACE_MS - 1);
    expect(everShown()).toBe(false);
    await advance(1);
    expect(now().shown).toBe(true);
  });

  // What tells a screen reader the connection is back: a loss that was on screen ended because the
  // connection returned. One that never showed, or that ended by leaving its scope, is no recovery.
  describe("counting recoveries", () => {
    it("counts a loss that was on screen and came back, at the moment it does", async () => {
      await set(true);
      await advance(OUTAGE_GRACE_MS);
      expect(now().recoveries).toBe(0);
      await set(false);
      expect(now()).toMatchObject({ recoveries: 1, lingering: true });
      // The notice running out its minimum time is not a second recovery, whatever else changes meanwhile.
      await set(false, true);
      expect(now()).toMatchObject({ recoveries: 1, shown: true, lingering: true });
      await advance(OUTAGE_MIN_SHOWN_MS);
      expect(now()).toMatchObject({ recoveries: 1, shown: false });
    });

    it("does not count a loss that ended before it showed", async () => {
      await set(true);
      await advance(OUTAGE_GRACE_MS - 1);
      await set(false);
      await advance(OUTAGE_GRACE_MS);
      expect(now().recoveries).toBe(0);
    });

    it("does not count a loss left behind with its scope", async () => {
      await set(true, false, "a");
      await advance(OUTAGE_GRACE_MS);
      await set(false, false, "b");
      await advance(OUTAGE_MIN_SHOWN_MS);
      expect(now().recoveries).toBe(0);
    });
  });
});
