import { applyMergePatch } from "../../src/shared/merge-patch";
import type { Preferences } from "../../src/shared/types";

/**
 * A mocked PATCH /preferences that answers as the server does: each save's patch merged over what
 * the last save stored, starting from the preferences the test serves when the first save arrives.
 */
export function preferenceServer(served: () => Preferences) {
  let stored: Preferences | undefined;
  return (patch: unknown) => (stored = applyMergePatch(stored ?? served(), patch) as Preferences);
}
