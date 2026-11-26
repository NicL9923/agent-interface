// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTENT_DWELL_MS,
  MAX_PREFETCH_CONCURRENCY,
  cancelIntentPrefetch,
  intentPrefetchHandlers,
  isSaveData,
  prefetchChunk,
  resetIntentPrefetchForTest,
  scheduleIntentPrefetch,
} from "../src/app/intent-prefetch";

const originalConnection = Object.getOwnPropertyDescriptor(navigator, "connection");

function setConnection(value: { saveData?: boolean } | undefined) {
  if (value === undefined) Reflect.deleteProperty(navigator, "connection");
  else Object.defineProperty(navigator, "connection", { configurable: true, value });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetIntentPrefetchForTest();
  setConnection(undefined);
});

afterEach(() => {
  resetIntentPrefetchForTest();
  if (originalConnection) Object.defineProperty(navigator, "connection", originalConnection);
  else Reflect.deleteProperty(navigator, "connection");
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(navigator, "onLine");
});

describe("intent chunk prefetcher", () => {
  it("waits for the 60 ms dwell and cancels if the pointer leaves early", () => {
    const preload = vi.fn();
    scheduleIntentPrefetch(preload);
    vi.advanceTimersByTime(INTENT_DWELL_MS - 1);
    expect(preload).not.toHaveBeenCalled();
    cancelIntentPrefetch(preload);
    vi.advanceTimersByTime(100);
    expect(preload).not.toHaveBeenCalled();

    scheduleIntentPrefetch(preload);
    vi.advanceTimersByTime(INTENT_DWELL_MS);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrency to 2, deduplicates in-flight/loaded chunks, and retries failed loads", async () => {
    const resolvers: (() => void)[] = [];
    const loaders = Array.from({ length: 4 }, () =>
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    );
    for (const loader of loaders) prefetchChunk(loader);
    // Duplicates while queued or in flight are ignored.
    prefetchChunk(loaders[0]!);
    prefetchChunk(loaders[2]!);
    await Promise.resolve();
    expect(loaders[0]).toHaveBeenCalledTimes(1);
    expect(loaders[1]).toHaveBeenCalledTimes(1);
    expect(loaders[2]).not.toHaveBeenCalled();
    expect(loaders[3]).not.toHaveBeenCalled();
    expect(MAX_PREFETCH_CONCURRENCY).toBe(2);

    // Finishing one drains the next queued loader.
    resolvers[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(loaders[2]).toHaveBeenCalledTimes(1);
    expect(loaders[3]).not.toHaveBeenCalled();

    // Already loaded chunks are never fetched again.
    prefetchChunk(loaders[0]!);
    expect(loaders[0]).toHaveBeenCalledTimes(1);

    // A rejected prefetch remains retryable.
    let shouldFail = true;
    const flaky = vi.fn(() =>
      shouldFail ? Promise.reject(new Error("offline")) : Promise.resolve(),
    );
    resolvers[1]!();
    resolvers[2]!();
    await Promise.resolve();
    await Promise.resolve();
    resolvers[3]!();
    await Promise.resolve();
    await Promise.resolve();

    prefetchChunk(flaky);
    await Promise.resolve();
    await Promise.resolve();
    expect(flaky).toHaveBeenCalledTimes(1);
    shouldFail = false;
    prefetchChunk(flaky);
    await Promise.resolve();
    await Promise.resolve();
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("gates prefetching on navigator.connection.saveData, offline, and hidden visibility", () => {
    const loader = vi.fn(() => Promise.resolve());
    setConnection({ saveData: true });
    expect(isSaveData()).toBe(true);
    prefetchChunk(loader);
    expect(loader).not.toHaveBeenCalled();

    setConnection({ saveData: false });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    prefetchChunk(loader);
    expect(loader).not.toHaveBeenCalled();

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    prefetchChunk(loader);
    expect(loader).not.toHaveBeenCalled();
  });

  it("starts immediately on pointerDown and returns empty handlers when disabled", () => {
    const preload = vi.fn();
    expect(intentPrefetchHandlers(preload, false)).toEqual({});
    const handlers = intentPrefetchHandlers(preload, true);
    handlers.onPointerEnter?.();
    handlers.onPointerDown?.();
    expect(preload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INTENT_DWELL_MS * 2);
    expect(preload).toHaveBeenCalledTimes(1);
  });
});
