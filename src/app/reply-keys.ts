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
 * `live:N`, new for each live reply.
 *
 * A saved reply takes the live row's key only when the client sees the hand-off happen, in one update:
 * the live row it last showed is gone, or now shows text that does not continue it, and exactly one
 * new row appeared, a saved assistant row whose text continues the live row's. Anything else, such as
 * a progress line saved with the reply, or a reply saved under different text, is not guessed at: the
 * saved reply renders under its own ID, in a new node, as it did before rows were kept.
 */
export function replyKeys(record: ReplyKeyRecord, rows: Message[]): { key(message: Message): string; record: ReplyKeyRecord } {
  const ids = new Set(rows.map(message => message.id)), shown = new Set(record.shown);
  const handed = new Map([...record.handed].filter(([id]) => ids.has(id)));
  const live = rows.find(isLiveRow);
  let lives = record.lives;
  const last = record.live;
  if (last && !(live && live.text.startsWith(last.text))) {
    const added = rows.filter(message => !shown.has(message.id));
    const [only] = added;
    if (added.length === 1 && only.role === "assistant" && !isLiveRow(only) && only.text.trim().startsWith(last.text.trim()))
      handed.set(only.id, last.key);
    // Handed on or gone, that key has shown its message.
    lives++;
  }
  const liveKey = `live:${lives}`;
  return {
    key: message => isLiveRow(message) ? liveKey : handed.get(message.id) ?? message.id,
    record: { shown: [...ids], live: live && { key: liveKey, text: live.text }, handed, lives },
  };
}
