// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeStream, MAX_STREAM_SILENCE, streamSilence } from "../src/client-api";
import { FakeEventSource } from "./fake-event-source";

// A stream that a proxy, a sleeping laptop or a phone's radio cut can stay open and silent. Each stream
// has its own watchdog: it replaces a stream silent past two ping intervals and five seconds, backs off
// while replacements hear nothing, and leaves a hidden page alone.
const START = Date.parse("2026-11-10T12:00:00Z");
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
function start(path = "/bots/shared/events?inflight=3", onChange = vi.fn()) {
  const stream = changeStream(path, onChange);
  stream.open();
  live().connect();
  live().emit("ping", "10");
  return { stream, onChange };
}

describe("stream silence", () => {
  it("is two pings and five seconds, doubled for each replacement that heard nothing, up to five minutes", () => {
    expect(streamSilence(10_000, 0)).toBe(25_000);
    expect(streamSilence(25_000, 0)).toBe(55_000);
    expect(streamSilence(10_000, 2)).toBe(100_000);
    expect(streamSilence(10_000, 10)).toBe(MAX_STREAM_SILENCE);
  });
});

describe("the stream watchdog", () => {
  it("asks the server to ping every 10 seconds, whatever the path's query", () => {
    changeStream("/events", vi.fn()).open();
    changeStream("/events?group=room", vi.fn()).open();
    expect(FakeEventSource.created).toEqual(["/api/events?ping=10", "/api/events?group=room&ping=10"]);
  });

  it("keeps a stream whose ping arrives just before the deadline, and replaces it just after the next one", () => {
    const { onChange } = start();
    vi.advanceTimersByTime(24_999);
    live().emit("ping", "10");
    vi.advanceTimersByTime(24_999);
    expect(opened()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(opened(), "25 seconds after the last ping").toBe(2);
    // The replacement reads on connect, as every connect does: notices sent meanwhile are lost.
    onChange.mockClear();
    live().connect();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("ignores a ping from the stream it replaced, so a late one never keeps a dead replacement", () => {
    start();
    const first = live();
    vi.advanceTimersByTime(25_000);
    expect(opened()).toBe(2);
    // The old connection delivers a ping it had buffered, just after the deadline.
    first.emit("ping", "10");
    // The replacement never connects. Had the old ping counted, it would wait from it, and back off less.
    vi.advanceTimersByTime(54_999);
    expect(opened()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(opened(), "the replacement waits the default silence, doubled for the miss: 110 seconds").toBe(2);
    vi.advanceTimersByTime(55_000);
    expect(opened()).toBe(3);
  });

  it.each([
    ["an older server's ping", "ping"],
    ["a ping naming no number", "soon"],
    ["a ping naming zero", "0"],
    ["a ping naming an hour", "3600"],
  ])("waits 55 seconds, the default interval's silence, after %s", (_name, data) => {
    const stream = changeStream("/events", vi.fn());
    stream.open();
    live().connect();
    live().emit("ping", data);
    vi.advanceTimersByTime(54_999);
    expect(opened()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(2);
  });

  it("backs off while replacements hear nothing, and starts over once one does", () => {
    start();
    const at: number[] = [];
    let seen = opened();
    for (let step = 0; step < 6 * 60; step++) {
      vi.advanceTimersByTime(5_000);
      if (opened() > seen) { at.push((Date.now() - START) / 1000); seen = opened(); }
    }
    // The first replacement waits 25 seconds; the ones after it never heard a ping, so the default
    // interval's 55 seconds doubles each time, to the five-minute ceiling.
    expect(at.slice(0, 5)).toEqual([25, 135, 355, 655, 955]);
    live().connect();
    live().emit("ping", "10");
    const heard = Date.now();
    vi.advanceTimersByTime(24_999);
    expect(opened()).toBe(seen);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(seen + 1);
    expect(Date.now() - heard).toBe(25_000);
  });

  it("retries a refused stream at its deadline, which EventSource never does itself", () => {
    start();
    live().fail();
    vi.advanceTimersByTime(24_999);
    expect(opened()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(opened()).toBe(2);
  });

  it("replaces nothing while the page is hidden, however late its timer fires, and leaves showing it to open", () => {
    const { stream } = start();
    visibility = "hidden";
    vi.advanceTimersByTime(10 * 60_000);
    expect(opened()).toBe(1);
    visibility = "visible";
    stream.open();
    expect(opened()).toBe(2);
    stream.open();
    expect(opened(), "a second wake handler finds the new stream fresh").toBe(2);
  });

  it("replaces each stream once when a device wakes from sleep and every timer fires late at once", () => {
    const household = start("/events");
    start("/bots/shared/events?inflight=3");
    // An hour asleep: the clock jumps, and the timers that were due fire together on wake.
    vi.setSystemTime(START + 3_600_000);
    vi.advanceTimersByTime(25_000);
    expect(FakeEventSource.created.slice(2)).toEqual(["/api/events?ping=10", "/api/bots/shared/events?inflight=3&ping=10"]);
    // The page's focus and online handlers call open too, and find fresh streams.
    household.stream.open();
    vi.advanceTimersByTime(1_000);
    expect(opened()).toBe(4);
  });

  it("stops watching once closed, leaving no timer behind", () => {
    const { stream } = start();
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(opened()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
