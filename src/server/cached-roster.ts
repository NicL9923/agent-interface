import type { Bot } from "../shared/types.js";

/**
 * Rosters a runtime answered from its last good read because it could not ask Hermes: the socket is
 * down, or `profiles.list` failed. Who is on such a roster may be out of date in either direction, and
 * an empty one says nothing about whether any assistant is left. Bootstrap tells clients so
 * (`Bootstrap.rosterCached`), so none acts on an omission it cannot trust.
 */
const cached = new WeakSet<readonly Bot[]>();

/** Marks `bots` as a cached roster and returns it. */
export function cachedRoster(bots: Bot[]): Bot[] {
  cached.add(bots);
  return bots;
}

/**
 * Whether `bots` is a roster a runtime returned from cache. A runtime that marks only its rows, as an
 * older one did, still says so through them.
 */
export const isCachedRoster = (bots: readonly Bot[]) =>
  cached.has(bots) || bots.some((bot) => bot.activity === "disconnected");
