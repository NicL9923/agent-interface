/** Command palette ranking, kept free of React so its order is easy to test. */
export type PaletteItem = {
  id: string;
  group: string;
  label: string;
  /** Extra words that find this item, such as "theme" for Appearance. */
  keywords?: string[];
  /** Kept at the bottom of its results whatever the score, like "Search messages for…". */
  trailing?: boolean;
};

const normalize = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();

/**
 * How well `query` finds `text`, or null when it does not. Higher is better: a whole match, then a
 * prefix, then a word start, then anywhere, then the letters in order (k c → Kitchen companion),
 * where tighter and earlier runs score higher.
 */
export function scoreText(query: string, text: string): number | null {
  const q = normalize(query), t = normalize(text);
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - Math.min(t.length - q.length, 99);
  const words = t.split(/[\s\-_/·&]+/);
  if (words.some(word => word.startsWith(q))) return 800 - t.indexOf(q);
  const at = t.indexOf(q);
  if (at >= 0) return 600 - Math.min(at, 99);
  // Initials of each word, like "kc" for Kitchen companion.
  const initials = words.map(word => word[0] ?? "").join("");
  if (initials.startsWith(q.replace(/\s+/g, ""))) return 700;
  let position = -1, gaps = 0, first = -1;
  for (const char of q.replace(/\s+/g, "")) {
    const next = t.indexOf(char, position + 1);
    if (next < 0) return null;
    if (first < 0) first = next;
    else gaps += next - position - 1;
    position = next;
  }
  return Math.max(1, 400 - gaps * 8 - first);
}

export function scoreItem(query: string, item: PaletteItem) {
  let best: number | null = scoreText(query, item.label);
  for (const keyword of item.keywords ?? []) {
    const score = scoreText(query, keyword);
    // A keyword finds the item only by its words, never scattered letters, and its own name ranks first.
    if (score !== null && score >= 600 && (best === null || score - 50 > best)) best = score - 50;
  }
  return best;
}

/**
 * Items that match, best first. An empty query keeps the given order. Equal scores keep the
 * given order too, so pinned assistants stay ahead of the rest.
 */
export function rankItems<T extends PaletteItem>(query: string, items: T[]): T[] {
  if (!normalize(query)) return items.filter(item => !item.trailing);
  const scored = items.flatMap((item, index) => {
    if (item.trailing) return [{ item, score: -Infinity, index }];
    const score = scoreItem(query, item);
    return score === null ? [] : [{ item, score, index }];
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(entry => entry.item);
}

/** Moves the highlight with wraparound, as the arrow keys do. */
export function step(index: number, delta: number, count: number) {
  if (count <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
}
