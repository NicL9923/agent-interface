/** Orders strings by UTF-16 code unit, which is what `Array.prototype.sort()` does without a comparator. */
export const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Orders string tuples the way the default sort orders them: by their comma-joined text. */
export const byTuple = (a: readonly string[], b: readonly string[]) =>
  byText(a.join(","), b.join(","));
