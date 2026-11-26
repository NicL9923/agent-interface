import { useSyncExternalStore } from "react";

type ResizeCallback = (entry: ResizeObserverEntry) => void;
type IntersectionCallback = (entry: IntersectionObserverEntry) => void;

type ObserverPool<Ctor, Observer, Entry, Callback extends (entry: Entry) => void> = {
  ctor: Ctor | undefined;
  observer: Observer | undefined;
  byTarget: WeakMap<Element, Set<Callback>>;
  lastEntry: WeakMap<Element, Entry>;
  all: Map<Callback, number>;
};

const resizePool: ObserverPool<
  typeof ResizeObserver,
  ResizeObserver,
  ResizeObserverEntry,
  ResizeCallback
> = {
  ctor: undefined,
  observer: undefined,
  byTarget: new WeakMap(),
  lastEntry: new WeakMap(),
  all: new Map(),
};

const intersectionPool: ObserverPool<
  typeof IntersectionObserver,
  IntersectionObserver,
  IntersectionObserverEntry,
  IntersectionCallback
> = {
  ctor: undefined,
  observer: undefined,
  byTarget: new WeakMap(),
  lastEntry: new WeakMap(),
  all: new Map(),
};

function dispatchEntries<
  Entry extends { target?: Element },
  Callback extends (entry: Entry) => void,
>(
  entries: readonly Entry[] | undefined,
  byTarget: WeakMap<Element, Set<Callback>>,
  lastEntry: WeakMap<Element, Entry>,
  all: Map<Callback, number>,
) {
  if (!entries) {
    for (const callback of [...all.keys()]) callback(undefined as unknown as Entry);
    return;
  }
  for (const entry of entries) {
    if (entry?.target) {
      lastEntry.set(entry.target, entry);
      const set = byTarget.get(entry.target);
      if (!set) continue;
      for (const callback of [...set]) callback(entry);
    } else {
      for (const callback of [...all.keys()]) callback(entry);
    }
  }
}

function subscribePool<
  Entry extends { target?: Element },
  Observer extends {
    observe: (target: Element) => void;
    unobserve?: (target: Element) => void;
    disconnect?: () => void;
  },
  Ctor extends new (callback: (entries: Entry[], observer: Observer) => void) => Observer,
  Callback extends (entry: Entry) => void,
>(
  pool: ObserverPool<Ctor, Observer, Entry, Callback>,
  Ctor: Ctor | undefined,
  element: Element,
  callback: Callback,
): () => void {
  if (!Ctor) return () => {};
  if (pool.ctor !== Ctor || !pool.observer) {
    pool.observer?.disconnect?.();
    const byTarget = new WeakMap<Element, Set<Callback>>();
    const lastEntry = new WeakMap<Element, Entry>();
    const all = new Map<Callback, number>();
    pool.ctor = Ctor;
    pool.byTarget = byTarget;
    pool.lastEntry = lastEntry;
    pool.all = all;
    pool.observer = new Ctor((entries) => dispatchEntries(entries, byTarget, lastEntry, all));
  }
  const { observer, byTarget, lastEntry, all } = pool;
  let set = byTarget.get(element);
  const alreadyObserved = set !== undefined;
  if (!set) {
    set = new Set();
    byTarget.set(element, set);
    observer.observe(element);
  }
  if (!set.has(callback)) {
    set.add(callback);
    all.set(callback, (all.get(callback) ?? 0) + 1);
  }
  let stopped = false;
  if (alreadyObserved) {
    const cached = lastEntry.get(element);
    if (cached !== undefined) {
      queueMicrotask(() => {
        if (
          !stopped &&
          pool.byTarget === byTarget &&
          byTarget.get(element)?.has(callback) &&
          lastEntry.get(element) === cached
        ) {
          callback(cached);
        }
      });
    }
  }
  return () => {
    if (stopped) return;
    stopped = true;
    const current = byTarget.get(element);
    if (!current || !current.delete(callback)) return;
    const remaining = (all.get(callback) ?? 0) - 1;
    if (remaining <= 0) all.delete(callback);
    else all.set(callback, remaining);
    if (current.size === 0) {
      byTarget.delete(element);
      lastEntry.delete(element);
      observer.unobserve?.(element);
    }
  };
}

/**
 * Observes `element` with a single shared `ResizeObserver` and WeakMap dispatch table.
 * Gracefully no-ops when `ResizeObserver` is unavailable, and allocates a fresh singleton
 * if a test replaces `globalThis.ResizeObserver`.
 */
export function observeResize(element: Element, callback: ResizeCallback): () => void {
  const Ctor = typeof ResizeObserver === "function" ? ResizeObserver : undefined;
  return subscribePool(resizePool, Ctor, element, callback);
}

/**
 * Observes `element` against the viewport (`root: null`) with a single shared
 * `IntersectionObserver` and WeakMap dispatch table. Gracefully no-ops when
 * `IntersectionObserver` is unavailable, and allocates a fresh singleton if a test
 * replaces `globalThis.IntersectionObserver`.
 */
export function observeIntersection(element: Element, callback: IntersectionCallback): () => void {
  const Ctor = typeof IntersectionObserver === "function" ? IntersectionObserver : undefined;
  return subscribePool(intersectionPool, Ctor, element, callback);
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
let reducedMotionFn: typeof window.matchMedia | undefined;
let reducedMotionMql: MediaQueryList | undefined;
let reducedMotionBound = false;
const reducedMotionListeners = new Set<() => void>();

const onReducedMotionChange = () => {
  for (const listener of [...reducedMotionListeners]) listener();
};

function detachReducedMotion() {
  if (reducedMotionBound && reducedMotionMql) {
    reducedMotionMql.removeEventListener?.("change", onReducedMotionChange);
    reducedMotionBound = false;
  }
  reducedMotionMql = undefined;
  reducedMotionFn = undefined;
}

function ensureReducedMotion(): MediaQueryList | undefined {
  const fn =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia
      : undefined;
  if (!fn) {
    detachReducedMotion();
    return undefined;
  }
  if (reducedMotionFn !== fn || !reducedMotionMql) {
    detachReducedMotion();
    reducedMotionFn = fn;
    reducedMotionMql = fn.call(window, REDUCED_MOTION_QUERY);
  }
  if (reducedMotionListeners.size > 0 && !reducedMotionBound && reducedMotionMql) {
    reducedMotionMql.addEventListener?.("change", onReducedMotionChange);
    reducedMotionBound = true;
  }
  return reducedMotionMql;
}

function subscribeReducedMotion(listener: () => void) {
  reducedMotionListeners.add(listener);
  ensureReducedMotion();
  return () => {
    reducedMotionListeners.delete(listener);
    if (reducedMotionListeners.size === 0) detachReducedMotion();
  };
}

function getReducedMotionSnapshot() {
  if (reducedMotionListeners.size === 0) {
    const fn =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia
        : undefined;
    return fn ? fn.call(window, REDUCED_MOTION_QUERY).matches : false;
  }
  return ensureReducedMotion()?.matches ?? false;
}

const noopSubscribe = () => () => {};
const returnFalse = () => false;

/**
 * Shared subscription to `prefers-reduced-motion: reduce` backed by one `MediaQueryList`
 * listener across the entire page. Passing `force = true` returns `true` without subscribing.
 */
export function useReducedMotion(force?: boolean): boolean {
  const system = useSyncExternalStore(
    force ? noopSubscribe : subscribeReducedMotion,
    force ? returnFalse : getReducedMotionSnapshot,
    returnFalse,
  );
  return !!force || system;
}

/** Resets shared observer and media-query singletons for tests. */
export function resetObserversForTest() {
  resizePool.observer?.disconnect?.();
  resizePool.ctor = undefined;
  resizePool.observer = undefined;
  resizePool.byTarget = new WeakMap();
  resizePool.lastEntry = new WeakMap();
  resizePool.all.clear();
  intersectionPool.observer?.disconnect?.();
  intersectionPool.ctor = undefined;
  intersectionPool.observer = undefined;
  intersectionPool.byTarget = new WeakMap();
  intersectionPool.lastEntry = new WeakMap();
  intersectionPool.all.clear();
  reducedMotionListeners.clear();
  detachReducedMotion();
}
