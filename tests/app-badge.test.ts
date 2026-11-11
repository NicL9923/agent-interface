// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authEpochKey } from "../src/app/storage";
import { mountRoot } from "./ui-harness";

// The page's app badge goes through the service worker that controls it, which orders it with the
// account words and the pushes, and is written by the page itself only where no worker answers.
type Badging = { setAppBadge: ReturnType<typeof vi.fn>; clearAppBadge: ReturnType<typeof vi.fn> };
type Posted = { message: { type: string; user?: unknown; count?: number }; ports: FakeChannel["port2"][] };

class FakeChannel {
  static all: FakeChannel[] = [];
  readonly port1 = { onmessage: null as ((event: { data?: unknown }) => void) | null, closed: false, close: () => { this.port1.closed = true; } };
  readonly port2 = { channel: this as FakeChannel };
  constructor() { FakeChannel.all.push(this); }
}

let posted: Posted[];
let badging: Badging;
/** What the browser gives a page: a worker that controls it, or none, and whether a registration has an active worker. */
function browser({ controlled = true, active = true, slow = false }: { controlled?: boolean; active?: boolean; slow?: boolean } = {}) {
  posted = [];
  const record = (message: Posted["message"], ports: Posted["ports"] = []) => { posted.push({ message, ports }); };
  const registration = { active: active ? { postMessage: record } : null };
  // A slow registration is one the page waits on until `registered()` is called, as a browser still starting its worker makes it.
  let registered = () => {};
  const ready = slow ? new Promise<void>(resolve => { registered = resolve; }) : Promise.resolve();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
    // A page that posted to its controller directly would not wait for the registration, and would overtake an earlier word.
    controller: controlled ? { postMessage: record } : null,
    getRegistration: async () => { await ready; return registration; }, addEventListener() {}, removeEventListener() {},
  } });
  return { registered: () => registered() };
}
const badgeMessages = () => posted.filter(({ message }) => message.type === "BADGE").map(({ message }) => [message.user, message.count]);
/** The worker answers the badge write posted at `index` among the badge messages, as it does by default, or says it cannot write one. A closed port hears nothing, as in a browser. */
const answer = (index: number, data: { badge: boolean } = { badge: true }) => {
  const { port1 } = FakeChannel.all[index]!;
  if (!port1.closed) port1.onmessage?.({ data });
};
/** Ends the account generation this page is in, as a refused session does. */
async function endGeneration() {
  const epoch = await import("../src/app/account-epoch");
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "earlier", at: Date.now() - 60_000, user: "one" }));
  epoch.accountStart();
  const before = epoch.accountGeneration();
  epoch.accountRefused(true);
  expect(epoch.accountGeneration()).toBeGreaterThan(before);
}

async function load() {
  vi.resetModules();
  const { useAppBadge, BADGE_ANSWER_MS } = await import("../src/app/badge");
  const mount = mountRoot();
  const Probe = ({ count, user }: { count: number; user?: string }) => { useAppBadge(count, user); return null; };
  const show = async (count: number, user?: string) => { await mount.render(createElement(Probe, { count, user })); await vi.advanceTimersByTimeAsync(0); };
  const leave = async () => { await act(async () => mount.root.unmount()); await vi.advanceTimersByTimeAsync(0); };
  return { show, leave, BADGE_ANSWER_MS };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeChannel.all = [];
  vi.stubGlobal("MessageChannel", FakeChannel);
  badging = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
  Object.defineProperties(navigator, {
    setAppBadge: { configurable: true, value: badging.setAppBadge }, clearAppBadge: { configurable: true, value: badging.clearAppBadge },
  });
});
afterEach(() => {
  for (const name of ["setAppBadge", "clearAppBadge", "serviceWorker"]) Reflect.deleteProperty(navigator, name);
});

describe("with a worker that controls the page", () => {
  beforeEach(() => browser());

  it("asks the worker for each count, naming the account it belongs to, and never writes the badge itself", async () => {
    const page = await load();
    await page.show(3, "one");
    await page.show(0, "one");
    expect(badgeMessages()).toEqual([["one", 3], ["one", 0]]);
    expect(badging.setAppBadge).not.toHaveBeenCalled();
    expect(badging.clearAppBadge).not.toHaveBeenCalled();
    // Each carries the port the worker answers on.
    expect(posted.every(({ ports }) => ports.length === 1)).toBe(true);
  });

  it("clears for the account whose screens leave, and for none from a page that draws no account yet", async () => {
    const page = await load();
    await page.show(0);
    await page.show(2, "one");
    await page.leave();
    expect(badgeMessages()).toEqual([[null, 0], ["one", 2], ["one", 0]]);
  });

  it("says it after the account word this page sent, in that order, though the browser is slow to find the worker", async () => {
    const slow = browser({ slow: true });
    localStorage.setItem(authEpochKey, JSON.stringify({ id: "out", at: Date.now(), signedOut: true, user: "one" }));
    const page = await load();
    const epoch = await import("../src/app/account-epoch");
    epoch.accountStart();
    await page.show(0);
    expect(posted).toEqual([]);
    slow.registered();
    await vi.advanceTimersByTimeAsync(0);
    expect(posted.map(({ message }) => message.type)).toEqual(["ACCOUNT", "BADGE"]);
  });

  it("makes no write of its own once the worker answers, however long that takes", async () => {
    const page = await load();
    await page.show(3, "one");
    answer(0);
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS * 2);
    expect(badging.setAppBadge).not.toHaveBeenCalled();
    expect(FakeChannel.all[0]!.port1.closed).toBe(true);
  });

  it("writes the count itself when the worker never answers, as a worker from before this message does not", async () => {
    const page = await load();
    await page.show(3, "one");
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS - 1);
    expect(badging.setAppBadge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(badging.setAppBadge).toHaveBeenCalledExactlyOnceWith(3);
    await page.show(0, "one");
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS);
    expect(badging.clearAppBadge).toHaveBeenCalledOnce();
  });

  it("stops waiting on any later write once a worker has answered on this page", async () => {
    const page = await load();
    await page.show(2, "one");
    answer(0);
    // The next write is never answered, as when the worker is busy, and the page does not take over.
    await page.show(3, "one");
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS * 3);
    expect(badging.setAppBadge).not.toHaveBeenCalled();
  });

  it("drops the write it would make itself when the account generation it was asked in has ended", async () => {
    const page = await load();
    await page.show(3, "one");
    await endGeneration();
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS);
    expect(badging.setAppBadge).not.toHaveBeenCalled();
    expect(badging.clearAppBadge).not.toHaveBeenCalled();
    // A write asked in the new generation still falls back.
    await page.show(4, "two");
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS);
    expect(badging.setAppBadge.mock.calls).toEqual([[4]]);
  });

  it("writes the count itself at once when the worker answers that it cannot, and keeps waiting on the next one's answer", async () => {
    const page = await load();
    await page.show(3, "one");
    answer(0, { badge: false });
    expect(badging.setAppBadge.mock.calls).toEqual([[3]]);
    expect(FakeChannel.all[0]!.port1.closed).toBe(true);
    await page.show(0, "one");
    answer(1, { badge: false });
    expect(badging.clearAppBadge).toHaveBeenCalledOnce();
    // A worker that cannot write a badge is not one that answers: the next write still has the timeout.
    await page.show(5, "one");
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS);
    expect(badging.setAppBadge.mock.calls).toEqual([[3], [5]]);
  });

  it("does not write when a worker's answer that it cannot comes after the account generation ended", async () => {
    const page = await load();
    await page.show(3, "one");
    await endGeneration();
    answer(0, { badge: false });
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS);
    expect(badging.setAppBadge).not.toHaveBeenCalled();
  });

  it("waits only on the newest count, since the next one replaces the last", async () => {
    const page = await load();
    await page.show(2, "one");
    await page.show(3, "one");
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS);
    expect(badging.setAppBadge.mock.calls).toEqual([[3]]);
  });

  it("keeps waiting on the newest count when a count it replaced is answered late", async () => {
    const page = await load();
    await page.show(2, "one");
    await page.show(3, "one");
    answer(0);
    // A third replaces the second, which the late answer must not have made the page forget.
    await page.show(4, "one");
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS);
    expect(badging.setAppBadge.mock.calls).toEqual([[4]]);
  });

  it("writes it itself when the registration has no active worker to ask", async () => {
    browser({ active: false });
    const page = await load();
    await page.show(3, "one");
    expect(posted).toEqual([]);
    await vi.advanceTimersByTimeAsync(page.BADGE_ANSWER_MS);
    expect(badging.setAppBadge).toHaveBeenCalledExactlyOnceWith(3);
  });
});

describe("with no worker controlling the page", () => {
  it("writes the badge itself, a count or a clear, and posts nothing", async () => {
    browser({ controlled: false });
    const page = await load();
    await page.show(3, "one");
    await page.show(0, "one");
    expect(badging.setAppBadge.mock.calls).toEqual([[3]]);
    expect(badging.clearAppBadge).toHaveBeenCalledOnce();
    expect(posted).toEqual([]);
  });

  it("writes it itself where the browser has no service workers, or no message channels", async () => {
    const page = await load();
    await page.show(2, "one");
    expect(badging.setAppBadge).toHaveBeenLastCalledWith(2);
    browser();
    vi.stubGlobal("MessageChannel", undefined);
    await page.show(4, "one");
    expect(badging.setAppBadge).toHaveBeenLastCalledWith(4);
    expect(posted).toEqual([]);
  });
});
