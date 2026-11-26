import {
  loadBotDetails,
  loadBotSettings,
  loadCommandPalette,
  loadDiscoveryPanel,
  loadGroupCreate,
  loadGroupRoomView,
  loadPreferencesDialog,
  loadTodayPanel,
  loadUsagePanel,
} from "./panels";

type Loader = () => Promise<unknown>;

/** How long a pointer or keyboard focus rests on a trigger before speculative chunk loading starts. */
export const INTENT_DWELL_MS = 60;
/** At most this many lazy panel chunks download concurrently from hover/focus intent. */
export const MAX_PREFETCH_CONCURRENCY = 2;

const loaded = new Set<Loader>();
const inflight = new Set<Loader>();
const queue: Loader[] = [];
const timers = new Map<() => void, ReturnType<typeof setTimeout>>();

/** Whether the browser signals a data-saving preference (`navigator.connection.saveData`). */
export function isSaveData(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

function canPrefetch(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  return !isSaveData();
}

function pump() {
  while (inflight.size < MAX_PREFETCH_CONCURRENCY && queue.length > 0) {
    const loader = queue.shift()!;
    if (loaded.has(loader) || inflight.has(loader)) continue;
    inflight.add(loader);
    let pending: Promise<unknown>;
    try {
      pending = loader();
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        () => {
          loaded.add(loader);
        },
        () => {
          /* Failed prefetches leave the loader retryable on actual navigation or later intent. */
        },
      )
      .finally(() => {
        inflight.delete(loader);
        pump();
      });
  }
}

/**
 * Enqueues a chunk loader respecting save-data, deduplication, and bounded concurrency (max 2).
 */
export function prefetchChunk(loader: Loader): void {
  if (!canPrefetch()) return;
  if (loaded.has(loader) || inflight.has(loader) || queue.includes(loader)) return;
  queue.push(loader);
  pump();
}

export const preloadToday = () => prefetchChunk(loadTodayPanel);
export const preloadDiscovery = () => prefetchChunk(loadDiscoveryPanel);
export const preloadBotDetails = () => prefetchChunk(loadBotDetails);
export const preloadBotSettings = () => prefetchChunk(loadBotSettings);
export const preloadPreferences = () => prefetchChunk(loadPreferencesDialog);
export const preloadUsage = () => prefetchChunk(loadUsagePanel);
export const preloadGroupRoom = () => prefetchChunk(loadGroupRoomView);
export const preloadGroupCreate = () => prefetchChunk(loadGroupCreate);
export const preloadCommandPalette = () => prefetchChunk(loadCommandPalette);

/** Schedules `preload` after a brief hover/focus dwell so sweeping across controls does not fetch them all. */
export function scheduleIntentPrefetch(preload: () => void): void {
  if (!canPrefetch() || timers.has(preload)) return;
  timers.set(
    preload,
    setTimeout(() => {
      timers.delete(preload);
      preload();
    }, INTENT_DWELL_MS),
  );
}

/** Cancels a pending dwell timer when the pointer leaves or focus moves away before `INTENT_DWELL_MS`. */
export function cancelIntentPrefetch(preload: () => void): void {
  const timer = timers.get(preload);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(preload);
}

/**
 * Pointer and focus handlers that warm a lazy chunk after `INTENT_DWELL_MS` of hover/focus, or
 * immediately on pointer down. Returns an empty object when `enabled` is false.
 */
export function intentPrefetchHandlers(preload: () => void, enabled = true) {
  if (!enabled) return {};
  return {
    onPointerEnter: () => scheduleIntentPrefetch(preload),
    onPointerLeave: () => cancelIntentPrefetch(preload),
    onFocus: () => scheduleIntentPrefetch(preload),
    onBlur: () => cancelIntentPrefetch(preload),
    onPointerDown: () => {
      cancelIntentPrefetch(preload);
      preload();
    },
  };
}

/** Clears queue, loaded set, and pending dwell timers between tests. */
export function resetIntentPrefetchForTest() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  queue.length = 0;
  inflight.clear();
  loaded.clear();
}
