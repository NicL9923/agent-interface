// Hermes revisions are commit hashes, which mean nothing to a person. Show the
// commit's date when the server knows it, and a short hash only as a fallback.

const hash = /^[0-9a-f]{12,64}$/i;

/** "Oct 20, 2026", or "" when the value is not a date. */
export function revisionDate(value: string | undefined, locale?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}

/** A readable version name: release names stay, full hashes shrink to seven characters. */
export function shortRevision(value: string | undefined) {
  if (!value) return "";
  return hash.test(value) ? value.slice(0, 7) : value;
}

/** The one line that names a Hermes build: its date when known, else its version or short hash. */
export function hermesVersionLabel(version: string | undefined, date: string | undefined, locale?: string) {
  return revisionDate(date, locale) || shortRevision(version);
}
