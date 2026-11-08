import { randomUUID } from "node:crypto";
import type { SavedItem } from "../shared/discovery.js";
import type { ReplyCardState } from "../shared/reply-cards.js";
import { defaultPreferences, type Preferences } from "../shared/types.js";
import type { StoreDatabase } from "./store-database.js";

/** Each person's own settings and keepsakes: preferences, read positions, reply card state and saved items. */
export class PersonalRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() { return this.database.db; }
  preferences(id: string): Preferences {
    const row = this.db
      .prepare("SELECT value FROM preferences WHERE user_id=?")
      .get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : structuredClone(defaultPreferences);
  }
  savePreferences(id: string, value: Preferences) {
    this.db
      .prepare(
        "INSERT INTO preferences VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value",
      )
      .run(id, JSON.stringify(value));
  }
  // Drafts go through draft() and saveDraft() so every change advances the revision.
  personal(table: "read_positions", userId: string, botId: string) {
    const row = this.db
      .prepare(`SELECT value FROM ${table} WHERE user_id=? AND bot_id=?`)
      .get(userId, botId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  savePersonal(
    table: "read_positions",
    userId: string,
    botId: string,
    value: unknown,
  ) {
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET value=excluded.value`,
      )
      .run(userId, botId, JSON.stringify(value));
  }
  cardState(userId: string, botId: string, messageId: string, cardId: string): ReplyCardState {
    const row = this.db.prepare("SELECT value FROM card_state WHERE user_id=? AND bot_id=? AND message_id=? AND card_id=?").get(userId, botId, messageId, cardId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { checkedIds: [], notes: {} };
  }
  saveCardState(userId: string, botId: string, messageId: string, cardId: string, value: ReplyCardState) {
    this.db.prepare("INSERT INTO card_state VALUES(?,?,?,?,?) ON CONFLICT(user_id,bot_id,message_id,card_id) DO UPDATE SET value=excluded.value").run(userId, botId, messageId, cardId, JSON.stringify(value));
  }
  savedItems(userId: string): SavedItem[] {
    return (this.db.prepare("SELECT value FROM saved_items WHERE user_id=? ORDER BY rowid DESC").all(userId) as {value: string}[]).map(row => JSON.parse(row.value));
  }
  saveItem(userId: string, pointer: Omit<SavedItem, 'id' | 'createdAt'>): SavedItem {
    const key = JSON.stringify([pointer.kind,pointer.botId,pointer.sessionId,pointer.messageId,pointer.routineId,pointer.resultId]);
    const previous = this.db.prepare("SELECT value FROM saved_items WHERE user_id=? AND pointer_key=?").get(userId,key) as {value: string} | undefined;
    if (previous) return JSON.parse(previous.value);
    const item = {...pointer,id:randomUUID(),createdAt:new Date().toISOString()};
    this.db.prepare("INSERT INTO saved_items VALUES(?,?,?,?)").run(item.id,userId,key,JSON.stringify(item));
    return item;
  }
  deleteSavedItem(userId: string,id: string) { this.db.prepare("DELETE FROM saved_items WHERE user_id=? AND id=?").run(userId,id); }
}
