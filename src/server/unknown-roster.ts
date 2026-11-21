import type { Bot } from "../shared/types.js";

/**
 * Rosters a runtime answered with nothing because it has had no roster from Hermes since it started: the
 * socket was down, or `profiles.list` failed, before any read succeeded. Such an empty list says
 * nothing about who is on the roster. A cached roster with rows is different: the adapter keeps the
 * newest read, and visibility is filtered from this app's own store, so its membership stands.
 * Bootstrap tells clients (`Bootstrap.rosterUnknown`), so none takes an empty list for every assistant
 * being gone.
 */
const unknown = new WeakSet<readonly Bot[]>();

/** Marks `bots` as a roster the runtime could not know, and returns it. */
export function unknownRoster(bots: Bot[]): Bot[] {
  unknown.add(bots);
  return bots;
}

/** Whether `bots` is the very list a runtime returned as an unknown roster. */
export const isUnknownRoster = (bots: readonly Bot[]) => unknown.has(bots);
