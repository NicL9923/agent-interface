import type { Message } from "../shared/types";

/**
 * What a turn's rows showed at its last commit, kept per turn so a streamed reply's saved copy can
 * take over the live row's node. It lives in the turn's view and goes with it.
 */
export type ReplyKeyRecord = {
  /** The IDs of the rows the turn last showed. */
  shown: string[];
  /** The live row as it last showed: the key it rendered under and its text. */
  live?: { key: string; text: string };
  /**
   * Saved replies that took over a live row's node, and the key each took. An entry is dropped once
   * its reply leaves the turn, so the record never holds more than the turn shows.
   */
  handed: Map<string, string>;
  /** How many live keys the turn has used. A key is never used for a second message. */
  lives: number;
};
export const emptyReplyKeys = (): ReplyKeyRecord => ({ shown: [], handed: new Map(), lives: 0 });

export const isLiveRow = (message: Message) => message.id.endsWith("-inflight");

/**
 * The key each of a turn's rows renders under, and the record to keep once they commit. A row's key
 * comes from its own identity, never its position: a saved row's is its ID, and the live row's is
 * `live:N`, new for each live reply. The live row's node is kept when its saved copy can take its
 * key, and the rule never has to choose between two rows for it:
 *
 * 1. A progress line, a row marked interim, never takes a live key. It is keyed by its own ID.
 * 2. Whenever an update adds a saved assistant row to the turn, the live reply that follows it, if
 *    there is one, is a new reply and gets a new live key, whatever its text. So does a live reply
 *    whose text no longer continues what the live row showed, and the live row's end.
 * 3. The saved row takes the old live key only when it is the one new row, a saved assistant row
 *    that is not a progress line, and its text continues the old live text.
 * 4. In every other case each row is keyed by its own identity and built again, as before rows were
 *    kept.
 */
export function replyKeys(record: ReplyKeyRecord, rows: Message[]): { key(message: Message): string; record: ReplyKeyRecord } {
  const ids = new Set(rows.map(message => message.id)), shown = new Set(record.shown);
  const handed = new Map([...record.handed].filter(([id]) => ids.has(id)));
  const added = rows.filter(message => !shown.has(message.id));
  const live = rows.find(isLiveRow), last = record.live;
  let lives = record.lives;
  if (last && (added.some(message => message.role === "assistant" && !isLiveRow(message)) || !live?.text.startsWith(last.text))) {
    const [only] = added;
    if (added.length === 1 && only.role === "assistant" && !isLiveRow(only) && !only.interim && only.text.trim().startsWith(last.text.trim()))
      handed.set(only.id, last.key);
    // Handed on or gone, that key has shown its message.
    lives++;
  }
  const liveKey = `live:${lives}`;
  return {
    key: message => message.interim ? message.id : isLiveRow(message) ? liveKey : handed.get(message.id) ?? message.id,
    record: { shown: [...ids], live: live && { key: liveKey, text: live.text }, handed, lives },
  };
}
