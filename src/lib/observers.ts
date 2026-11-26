import { useSyncExternalStore } from "react";

type ResizeCallback = (entry: ResizeObserverEntry) => void;
type IntersectionCallback = (entry: IntersectionObserverEntry) => void;

type ObserverPool<Ctor, Observer, Entry, Callback extends (entry: Entry) => void> = {
  ctor: Ctor | undefined;
  observer: Observer | undefined;
  byTarget: WeakMap<Element, Set<Callback>>;
  all: Set<Callback>;
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
  all: new Set(),
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
  all: new Set(),
};

function dispatchEntries<
  Entry extends { target?: Element },
  Callback extends (entry: Entry) => void,
>(
  entries: readonly Entry[] | undefined,
  byTarget: WeakMap<Element, Set<Callback>>,
  all: Set<Callback>,
) {
  if (!entries) {
    for (const callback of [...all]) callback(undefined as unknown as Entry);
    return;
  }
  for (const entry of entries) {
    if (entry?.target) {
      const set = byTarget.get(entry.target);
      if (!set) continue;
      for (const callback of [...set]) callback(entry);
    } else {
      for (const callback of [...all]) callback(entry);
    }
  }
}

/**
 * Observes `element` with a single shared `ResizeObserver` and WeakMap dispatch table.
 * Gracefully no-ops when `ResizeObserver` is unavailable, and allocates a fresh singleton
 * if a test replaces `globalThis.ResizeObserver`.
 */
export function observeResize(element: Element, callback: ResizeCallback): () => void {
  const Ctor = typeof ResizeObserver === "function" ? ResizeObserver : undefined;
  if (!Ctor) return () => {};
  if (resizePool.ctor !== Ctor || !resizePool.observer) {
    resizePool.observer?.disconnect?.();
    const byTarget = new WeakMap<Element, Set<ResizeCallback>>();
    const all = new Set<ResizeCallback>();
    resizePool.ctor = Ctor;
    resizePool.byTarget = byTarget;
    resizePool.all = all;
    resizePool.observer = new Ctor((entries) => dispatchEntries(entries, byTarget, all));
  }
  const { observer, byTarget, all } = resizePool;
  let set = byTarget.get(element);
  if (!set) {
    set = new Set();
    byTarget.set(element, set);
    observer.observe(element);
  }
  set.add(callback);
  all.add(callback);
  return () => {
    all.delete(callback);
    const current = byTarget.get(element);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) {
      byTarget.delete(element);
      observer.unobserve?.(element);
    }
  };
}

/**
 * Observes `element` against the viewport (`root: null`) with a single shared
 * `IntersectionObserver` and WeakMap dispatch table. Gracefully no-ops when
 * `IntersectionObserver` is unavailable, and allocates a fresh singleton if a test
 * replaces `globalThis.IntersectionObserver`.
 */
export function observeIntersection(element: Element, callback: IntersectionCallback): () => void {
  const Ctor = typeof IntersectionObserver === "function" ? IntersectionObserver : undefined;
  if (!Ctor) return () => {};
  if (intersectionPool.ctor !== Ctor || !intersectionPool.observer) {
    intersectionPool.observer?.disconnect?.();
    const byTarget = new WeakMap<Element, Set<IntersectionCallback>>();
    const all = new Set<IntersectionCallback>();
    intersectionPool.ctor = Ctor;
    intersectionPool.byTarget = byTarget;
    intersectionPool.all = all;
    intersectionPool.observer = new Ctor((entries) => dispatchEntries(entries, byTarget, all));
  }
  const { observer, byTarget, all } = intersectionPool;
  let set = byTarget.get(element);
  if (!set) {
    set = new Set();
    byTarget.set(element, set);
    observer.observe(element);
  }
  set.add(callback);
  all.add(callback);
  return () => {
    all.delete(callback);
    const current = byTarget.get(element);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) {
      byTarget.delete(element);
      observer.unobserve?.(element);
    }
  };
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
  resizePool.all.clear();
  intersectionPool.observer?.disconnect?.();
  intersectionPool.ctor = undefined;
  intersectionPool.observer = undefined;
  intersectionPool.byTarget = new WeakMap();
  intersectionPool.all.clear();
  reducedMotionListeners.clear();
  detachReducedMotion();
}
