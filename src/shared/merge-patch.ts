/** The media type of a JSON Merge Patch (RFC 7396), which marks a partial preferences save. */
export const MERGE_PATCH = "application/merge-patch+json";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * RFC 7396 MergePatch: each member of `patch` replaces the target's, `null` removes it, and an
 * object merges into the target's object. An array or other value replaces the target whole.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const result: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__") continue;
    if (value === null) delete result[key];
    else result[key] = applyMergePatch(result[key], value);
  }
  return result;
}
