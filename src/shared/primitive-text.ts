/**
 * The text of a string, number, boolean or bigint, and `fallback` for anything else. Wire data typed `unknown`
 * goes through this instead of `String()`, which turns an object into "[object Object]".
 */
export function primitiveText(value: unknown, fallback = ""): string {
  switch (typeof value) {
    case "string": return value;
    case "number":
    case "boolean":
    case "bigint": return String(value);
    default: return fallback;
  }
}
