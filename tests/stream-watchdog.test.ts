// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeStream, LATE_TIMER_MS, MAX_RETRY_MS, retryDelay, streamSilence } from "../src/client-api";
import { FakeEventSource } from "./fake-event-source";

// A stream that a proxy, a sleeping laptop or a phone's radio cut can stay open and silent. Each stream
// has its own watchdog, which replaces a stream silent past two ping intervals and five seconds. One
// retry deadline, with jitter, governs every connection after a failure, whoever asks for it.
const START = Date.parse("2026-11-10T12:00:00Z");
// The middle of the jitter's range, so each wait is three quarters of its ceiling.
const middle = () => 0.5;
// The watchdog judges after a zero-delay task, which the fake clock runs 1 ms later.
const VERDICT = 1;
let visibility: DocumentVisibilityState;
beforeEach(() => {
  vi.useFakeTimers({ now: START });
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

const opened = () => FakeEventSource.created.length;
const live = () => [...FakeEventSource.streams].at(-1)!;
/** Opens a stream as a `?ping=10` server answers it: connected, with its first ping at once. */
function start(path = "/bots/shared/events?inflight=3", onChange = vi.fn(), random = middle) {
  const stream = changeStream(path, onChange, undefined, {}, undefined, { random });
  stream.open();
  live().connect();
  live().emit("ping", "10");
  return { stream, onChange };
}
/** A stream that has been live for a minute, its pings arriving on time, so it has recovered. */
function healthy(random = middle) {
  const started = start(undefined, undefined, random);
  for (let ping = 0; ping < 6; ping++) { vi.advanceTimersByTime(10_000); live().emit("ping", "10"); }
  return started;
}
/**
 * Runs `minutes` of an outage in one-second steps, letting `serve` answer each new connection, and calls
 * the owner's `open` every `ownerMs` as the household, room and chat owners do. Returns the second, from
 * the outage's start, of each new connection.
 */
function outage(stream: { open: () => void }, serve: (source: FakeEventSource) => void, ownerMs: number, minutes = 10) {
  const from = Date.now(), seen = opened();
  FakeEventSource.serve = serve;
  try {
    for (let step = 1; step <= minutes * 60; step++) {
      vi.advanceTimersByTime(1_000);
      if (step * 1000 % ownerMs === 0) stream.open();
    }
  } finally { FakeEventSource.serve = undefined; }
  // To a tenth of a second: the network and each silent verdict add a millisecond on the fake clock.
  return FakeEventSource.opened.slice(seen).map(source => Math.round((source.at - from) / 100) / 10);
}

describe("stream silence", () => {
  it("is two pings and five seconds, whatever the retries before it", () => {
    expect(streamSilence(10_000)).toBe(25_000);
    expect(streamSilence(25_000)).toBe(55_000);
  });
});

describe("the retry delay", () => {
  // Equal jitter: a random half or more of a ceiling that doubles from 2 seconds to five minutes.
  it.each([
    ["the first, at its floor", 1, 0, 1_000],
    ["the first, at its top", 1, 0.999_999, 1_999.999],
    ["the fourth, in the middle", 4, 0.5, 12_000],
    ["the twentieth, at the ceiling's top", 20, 0.999_999, MAX_RETRY_MS - 0.15],
    ["the twentieth, at the ceiling's floor", 20, 0, MAX_RETRY_MS / 2],
  ])("waits for %s", (_name, failures, random, wait) => {
    expect(retryDelay(failures, () => random)).toBeCloseTo(wait, 1);
  });
});

describe("the stream watchdog", () => {
  it("asks the server to ping every 10 seconds, whatever the path's query", () => {
    changeStream("/events", vi.fn()).open();
    changeStream("/events?group=room", vi.fn()).open();
    expect(FakeEventSource.created).toEqual(["/api/events?ping=10", "/api/events?group=room&ping=10"]);
  });

  it("keeps a stream whose ping arrives just before the deadline, and closes it to retry just after the next one", () => {
    const { onChange } = start();
    const first = live();
    vi.advanceTimersByTime(24_999);
    first.emit("ping", "10");
    vi.advanceTimersByTime(24_999 + VERDICT);
    expect(first.readyState).toBe(FakeEventSource.OPEN);
    vi.advanceTimersByTime(1);
    // Silent 25 seconds: the old connection is closed, so its socket is not left open beside the new one.
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.streams.has(first)).toBe(false);
    // The first retry waits 1.5 seconds at the middle of its jitter.
    vi.advanceTimersByTime(1_499);
    expect(opened()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(2);
    // The replacement reads on connect, as every connect does: notices sent meanwhile are lost.
    onChange.mockClear();
    live().connect();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("ignores a ping from the stream it replaced, so a late one never keeps a dead replacement", () => {
    start();
    const first = live();
    vi.advanceTimersByTime(26_500 + VERDICT);
    expect(opened()).toBe(2);
    // The old connection delivers a ping it had buffered, just after the deadline.
    first.emit("ping", "10");
    // The replacement never connects. Had the old ping counted, the deadline would be 25 seconds from it.
    vi.advanceTimersByTime(54_999 + VERDICT);
    expect(opened()).toBe(2);
    vi.advanceTimersByTime(1);
    // 55 seconds, the default interval's silence, then the second failure's 3-second retry.
    vi.advanceTimersByTime(2_999);
    expect(opened()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(3);
  });

  it.each([
    ["an older server's ping", "ping"],
    ["a ping naming no number", "soon"],
    ["an empty ping", ""],
    ["a ping naming zero", "0"],
    ["a ping naming a fraction of a second", "0.5"],
    ["a ping naming an hour", "3600"],
  ])("waits 55 seconds, the default interval's silence, after %s", (_name, data) => {
    const stream = changeStream("/events", vi.fn(), undefined, {}, undefined, { random: middle });
    stream.open();
    live().connect();
    live().emit("ping", data);
    vi.advanceTimersByTime(54_999 + VERDICT);
    expect(live().readyState).toBe(FakeEventSource.OPEN);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.streams.size).toBe(0);
  });

  it("closes a dropped stream instead of letting EventSource retry it on the server's 3 seconds, and retries sooner", () => {
    healthy();
    const dropped = live();
    dropped.drop();
    expect(dropped.readyState).toBe(FakeEventSource.CLOSED);
    vi.advanceTimersByTime(1_499);
    expect(opened()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(2);
  });

  it("retries a refused stream after the retry delay, which EventSource never does itself", () => {
    start();
    live().fail();
    vi.advanceTimersByTime(1_499);
    expect(opened()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(2);
  });

  it("spreads the retry by the random source it was given", () => {
    const early = start(undefined, undefined, () => 0);
    live().fail();
    vi.advanceTimersByTime(1_000);
    expect(opened()).toBe(2);
    early.stream.close();
    FakeEventSource.reset();
    start(undefined, undefined, () => 0.999);
    live().fail();
    vi.advanceTimersByTime(1_998);
    expect(opened()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(2);
  });

  // The schedules in the ledger, at the middle of the jitter, with the household owner calling `open`
  // every 45 seconds and the chat owner every 30: neither adds an attempt.
  it.each([45_000, 30_000])("follows one schedule through a ten-minute outage whatever the owner asks, every %i ms", ownerMs => {
    const refusing = healthy();
    live().fail();
    expect(outage(refusing.stream, source => source.fail(), ownerMs))
      .toEqual([1.5, 4.5, 10.5, 22.5, 46.5, 94.5, 190.5, 382.5]);
    refusing.stream.close();
    FakeEventSource.reset();

    // A server that accepts and never speaks: each connection gets the default interval's 55 seconds.
    const silent = healthy();
    expect(outage(silent.stream, source => source.connect(), ownerMs))
      .toEqual([26.5, 84.5, 145.5, 212.5, 291.5, 394.5, 545.5]);
    silent.stream.close();
    FakeEventSource.reset();

    // A server that greets and then stalls. The greeting is not recovery, so the backoff keeps growing.
    const stalling = healthy();
    expect(outage(stalling.stream, source => { source.connect(); source.emit("ping", "10"); }, ownerMs))
      .toEqual([26.5, 54.5, 85.5, 122.5, 171.5, 244.5, 365.5, 582.5]);
  });

  it("does not count the greeting of a connection that took long to open as recovery", () => {
    start();
    live().fail();
    vi.advanceTimersByTime(1_500);
    // The headers arrive 20 seconds after the request, then the greeting, then nothing.
    vi.advanceTimersByTime(20_000);
    live().connect();
    live().emit("ping", "10");
    live().fail();
    // The second failure in a row: 3 seconds, not a first failure's 1.5.
    vi.advanceTimersByTime(2_999);
    expect(opened()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(3);
  });

  it("counts a ping half an interval after opening as recovery, allowing for delivery jitter, and not one sooner", () => {
    start();
    live().fail();
    vi.advanceTimersByTime(1_500);
    live().connect();
    live().emit("ping", "10");
    vi.advanceTimersByTime(4_999);
    live().emit("ping", "10");
    live().fail();
    vi.advanceTimersByTime(2_999);
    expect(opened(), "4.999 seconds is not recovery").toBe(2);
    vi.advanceTimersByTime(1);
    live().connect();
    live().emit("ping", "10");
    vi.advanceTimersByTime(5_000);
    live().emit("ping", "10");
    live().fail();
    vi.advanceTimersByTime(1_500);
    expect(opened(), "5 seconds is").toBe(4);
  });

  it("counts a connection as recovered only once it is heard a ping interval after it opened", () => {
    start();
    live().fail();
    vi.advanceTimersByTime(1_500);
    live().connect();
    live().emit("ping", "10");
    // The groups notice the household stream sends on connect is no more proof than the greeting.
    live().emit("message", "change");
    live().fail();
    // Third attempt: the second failure's 3 seconds.
    vi.advanceTimersByTime(2_999);
    expect(opened()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(3);
    live().connect();
    live().emit("ping", "10");
    vi.advanceTimersByTime(10_000);
    live().emit("ping", "10");
    live().fail();
    // Recovered: the next failure is a first one again.
    vi.advanceTimersByTime(1_500);
    expect(opened()).toBe(4);
  });

  it("starts at once when the owner reconnects for the network returning, dropping the backoff", () => {
    const { stream } = start();
    for (let failure = 0; failure < 6; failure++) { live().fail(); vi.runOnlyPendingTimers(); }
    live().fail();
    const before = opened();
    stream.open();
    expect(opened(), "open waits for the retry deadline").toBe(before);
    stream.reconnect();
    expect(opened()).toBe(before + 1);
    live().fail();
    vi.advanceTimersByTime(1_500);
    expect(opened(), "the next failure is a first one").toBe(before + 2);
    // A stream that is open is never replaced by a reconnect.
    stream.reconnect();
    expect(opened()).toBe(before + 2);
  });

  it("ends an outage when its owner closes it, so the next signal after the page is shown connects at once", () => {
    const { stream } = start();
    live().fail();
    stream.reconnect();
    live().fail();
    // A hidden page's owner closes the stream; the network returns as it is shown again.
    stream.close();
    stream.reconnect();
    expect(opened(), "no forced gap carries over a close").toBe(3);
  });

  it("waits for queued events before judging, so a ping held behind the timer by a long task keeps the stream", () => {
    start();
    const first = live();
    vi.advanceTimersByTime(24_000);
    // The page is busy for three seconds. A ping arrives meanwhile and waits in the queue behind the watchdog.
    vi.setSystemTime(Date.now() + 3_000);
    setTimeout(() => first.emit("ping", "10"), 1_000);
    vi.advanceTimersByTime(1_000);
    expect(first.readyState).toBe(FakeEventSource.OPEN);
    vi.advanceTimersByTime(24_999 + VERDICT);
    expect(first.readyState).toBe(FakeEventSource.OPEN);
    vi.advanceTimersByTime(1);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("restarts the deadline once after a device wakes, instead of replacing a stream it never gave a chance", () => {
    const household = start("/events");
    start("/bots/shared/events?inflight=3");
    const [first, second] = FakeEventSource.streams;
    // An hour asleep: the clock jumps, and the timers that were due fire together on wake.
    vi.setSystemTime(START + 3_600_000);
    vi.advanceTimersByTime(25_000);
    expect(opened()).toBe(2);
    // The page's focus handler calls open too, which leaves a stream to its watchdog.
    household.stream.open();
    expect(opened()).toBe(2);
    // The household stream's connection survived and pings; the chat's did not.
    vi.advanceTimersByTime(1_000);
    first.emit("ping", "10");
    vi.advanceTimersByTime(23_999 + VERDICT);
    expect(second.readyState).toBe(FakeEventSource.OPEN);
    vi.advanceTimersByTime(1);
    expect(second.readyState).toBe(FakeEventSource.CLOSED);
    expect(first.readyState).toBe(FakeEventSource.OPEN);
  });

  it("forgives only one late timer: a second without an event between replaces the stream", () => {
    start();
    const first = live();
    vi.setSystemTime(Date.now() + LATE_TIMER_MS + 1);
    vi.advanceTimersByTime(25_000 + VERDICT);
    expect(first.readyState).toBe(FakeEventSource.OPEN);
    vi.setSystemTime(Date.now() + LATE_TIMER_MS + 1);
    vi.advanceTimersByTime(25_000 + VERDICT);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("judges a timer late by exactly the threshold on time", () => {
    start();
    const first = live();
    vi.setSystemTime(Date.now() + LATE_TIMER_MS);
    vi.advanceTimersByTime(25_000 + VERDICT);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("replaces nothing while the page is hidden, however late its timer fires, and connects at once when shown", () => {
    const { stream } = start();
    visibility = "hidden";
    vi.advanceTimersByTime(10 * 60_000);
    expect(opened()).toBe(1);
    // Owners close a hidden page's stream, which ends the episode: showing it connects without waiting.
    stream.close();
    visibility = "visible";
    stream.open();
    expect(opened()).toBe(2);
    stream.open();
    expect(opened(), "a second wake handler finds the new stream").toBe(2);
  });

  it("connects at once when shown after its owner closed it mid-backoff, then backs off from the first failure", () => {
    const { stream } = start();
    for (let failure = 0; failure < 6; failure++) { live().fail(); vi.runOnlyPendingTimers(); }
    // The sixth failure in a row waits about a minute.
    live().fail();
    const before = opened();
    stream.close();
    stream.open();
    expect(opened()).toBe(before + 1);
    live().fail();
    vi.advanceTimersByTime(1_500);
    expect(opened()).toBe(before + 2);
  });

  it("reconnects a stream whose growth notice it cannot apply, without counting a failure", () => {
    const onChange = vi.fn();
    const stream = changeStream("/bots/shared/events?inflight=3", onChange, vi.fn(), {}, () => false, { random: middle });
    stream.open();
    const first = live();
    first.connect();
    first.emit("inflight-delta", "{}");
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(opened()).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("stops watching once closed, leaving no timer behind, whether a stream or a retry was pending", () => {
    const { stream } = start();
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
    stream.open();
    live().fail();
    expect(vi.getTimerCount()).toBe(1);
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(opened()).toBe(2);
  });
});
