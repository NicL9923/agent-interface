import type { Bot } from "../shared/types.js";

/**
 * Rosters a runtime answered with nothing because it has had no roster from Hermes since it started: the
 * socket was down, or `profiles.list` failed, before any read succeeded. Such an empty list says
 * nothing about who is on the roster. A cached roster with rows is different: the adapter keeps the
 * newest read, and visibility is filtered from this app's own store, so its membership stands.
 * Bootstrap tells clients (`Bootstrap.rosterUnknown`), so none takes an empty list for every assistant
 * being gone.
 */
const unknown = new WeakSet<readonly object[]>();

/** Marks `bots` as a roster the runtime could not know, and returns it. */
export function unknownRoster(bots: Bot[]): Bot[] {
  unknown.add(bots);
  return bots;
}

/** Whether `bots` is the very list a runtime returned as an unknown roster. */
export const isUnknownRoster = (bots: readonly Bot[]) => unknown.has(bots);

/**
 * Answers the runtime router put together while some runtime failed: a roster or a routine inventory with
 * only what the runtimes that answered listed, plus the last roster a failed runtime gave, marked
 * disconnected. Each maps to whether a given assistant's rows may be missing from it, because that
 * assistant's runtime did not answer.
 */
const partial = new WeakMap<readonly object[], (botId: string) => boolean>();

/** Marks `rows` as an answer that may leave out the rows of every assistant `omits` names, and returns it. */
export function partialAnswer<T extends object>(rows: T[], omits: (botId: string) => boolean): T[] {
  partial.set(rows, omits);
  return rows;
}

/** Whether `rows` is the very list the router returned while some runtime failed. */
export const isPartialAnswer = (rows: readonly object[]) => partial.has(rows);

/**
 * Whether `rows` cannot be trusted to list everything: it is an unknown roster or a partial answer. Nothing
 * may prune, reconcile or decide privacy by what such a list leaves out.
 */
export const isIncomplete = (rows: readonly object[]) => unknown.has(rows) || partial.has(rows);

/** Whether `rows` is a partial answer that may leave out this assistant's rows because its runtime failed. */
export const failedRuntimeOmits = (rows: readonly object[], botId: string) =>
  partial.get(rows)?.(botId) ?? false;

/** Whether `rows` may leave out this assistant's rows, so its absence says nothing about whether it exists. */
export const mayOmit = (rows: readonly object[], botId: string) =>
  unknown.has(rows) || failedRuntimeOmits(rows, botId);

/** Gives `to`, a copy of `from` with the same rows reshaped, whatever marks `from` has, and returns it. */
export function sameMarks<T extends object>(from: readonly object[], to: T[]): T[] {
  if (unknown.has(from)) unknown.add(to);
  const omits = partial.get(from);
  if (omits) partial.set(to, omits);
  return to;
}
