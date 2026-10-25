import type { AccountRepository } from "./store-accounts.js";
import { presenceTtl } from "./store-notifications.js";
import type { PersonalRepository } from "./store-personal.js";
import type { StoreDatabase } from "./store-database.js";

/** Removals that span every area: a deleted assistant's records, and rows past their retention. */
export class RetentionRepository {
  constructor(private readonly database: StoreDatabase, private readonly accounts: AccountRepository, private readonly personal: PersonalRepository) {}
  private get db() { return this.database.db; }
  /** Removes what this app keeps about a deleted assistant, so a new one reusing its ID starts clean. */
  // Its news, runs and receipts go too: with no owner left on record, anything kept would
  // reach former participants and followers, or attribute a reused ID's messages.
  forgetBot(botId: string) {
    this.database.transaction(() => {
      const ids = (sql: string) => (this.db.prepare(sql).all(botId, botId) as { id: string | null }[]).flatMap(row => row.id ? [row.id] : []);
      const runs = ids("SELECT json_extract(value,'$.runId') AS id FROM notification_events WHERE json_extract(value,'$.botId')=? UNION SELECT json_extract(receipt,'$.runId') FROM submissions WHERE bot_id=?");
      const routines = ids("SELECT json_extract(value,'$.routineId') AS id FROM notification_events WHERE json_extract(value,'$.botId')=? UNION SELECT routine_id FROM routine_trials WHERE bot_id=?");
      const outbox = "SELECT id FROM outbox WHERE json_extract(payload,'$.botId')=?";
      this.db.prepare(`DELETE FROM delivered WHERE outbox_id IN (${outbox})`).run(botId);
      this.db.prepare(`DELETE FROM notification_batch_items WHERE outbox_id IN (${outbox})`).run(botId);
      this.db.prepare("DELETE FROM outbox WHERE json_extract(payload,'$.botId')=?").run(botId);
      this.db.prepare("DELETE FROM notification_batches WHERE NOT EXISTS(SELECT 1 FROM notification_batch_items i WHERE i.batch_id=notification_batches.id)").run();
      this.db.prepare("DELETE FROM notification_events WHERE json_extract(value,'$.botId')=?").run(botId);
      for (const run of runs) this.db.prepare("DELETE FROM participants WHERE run_id=?").run(run);
      for (const routine of routines) this.db.prepare("DELETE FROM routine_recipients WHERE routine_id=?").run(routine);
      for (const table of ["bot_presentation", "bot_visibility_periods", "bot_names", "drafts", "draft_revisions", "read_positions", "chat_presence", "chat_reads", "card_state", "submissions", "approval_attribution", "routine_trials", "push_action_tokens"])
        this.db.prepare(`DELETE FROM ${table} WHERE bot_id=?`).run(botId);
      this.db.prepare("DELETE FROM saved_items WHERE json_extract(value,'$.botId')=?").run(botId);
      for (const user of this.accounts.users()) {
        const value = this.personal.preferences(user.id);
        const kept = (id: string) => id !== botId;
        const next = { ...value, favorites: value.favorites.filter(kept), followBots: value.followBots.filter(kept),
          sections: value.sections.map(section => ({ ...section, botIds: section.botIds.filter(kept) })),
          defaultBotId: value.defaultBotId === botId ? undefined : value.defaultBotId };
        if (JSON.stringify(next) !== JSON.stringify(value)) this.personal.savePreferences(user.id, next);
      }
    });
  }
  pruneRetention(now = Date.now()) {
    // Only rows whose event has aged out of notification_events, so enqueueKnownEvents cannot re-create them.
    const stale = "SELECT id FROM outbox WHERE state<>'pending' AND created_at<? AND NOT EXISTS(SELECT 1 FROM notification_events e WHERE e.id=outbox.event_id)";
    const cutoff = now - 30 * 86400000;
    return this.database.transaction(() => {
      const sessions = this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(now).changes;
      this.db.prepare("DELETE FROM chat_presence WHERE updated_at<?").run(now - presenceTtl);
      this.db.prepare("DELETE FROM push_action_tokens WHERE expires<=?").run(now);
      this.db.prepare(`DELETE FROM delivered WHERE outbox_id IN (${stale})`).run(cutoff);
      this.db.prepare(`DELETE FROM notification_batch_items WHERE outbox_id IN (${stale})`).run(cutoff);
      const notifications = this.db.prepare(`DELETE FROM outbox WHERE id IN (${stale})`).run(cutoff).changes;
      this.db.prepare("DELETE FROM notification_batches WHERE NOT EXISTS(SELECT 1 FROM notification_batch_items i WHERE i.batch_id=notification_batches.id)").run();
      return { sessions: Number(sessions), notifications: Number(notifications) };
    });
  }
}
