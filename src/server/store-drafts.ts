import type { SavedDraft } from "../shared/types.js";
import type { StoreDatabase } from "./store-database.js";

/** Each person's unsent draft per assistant, with the revision every change advances. */
export class DraftRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() { return this.database.db; }
  /** The person's saved draft, or null if they never saved one for this assistant. */
  draft(userId: string, botId: string): SavedDraft | null {
    const row = this.db
      .prepare("SELECT d.value,r.revision,r.reason,r.sent_revision AS sentRevision FROM drafts d LEFT JOIN draft_revisions r ON r.user_id=d.user_id AND r.bot_id=d.bot_id WHERE d.user_id=? AND d.bot_id=?")
      .get(userId, botId) as { value: string; revision: number | null; reason: SavedDraft["reason"] | null; sentRevision: number | null } | undefined;
    if (!row) return null;
    const { text, attachments } = JSON.parse(row.value) as Pick<SavedDraft, "text" | "attachments">;
    return { text, attachments, revision: row.revision ?? 0, reason: row.reason ?? "edit", sentRevision: row.sentRevision ?? 0 };
  }
  /**
   * Saves a draft edit. With `baseRevision`, the edit applies only to that revision; otherwise the
   * current draft comes back unsaved. Without it, as from older clients, the edit always applies.
   * Content the server already has is never a conflict and does not advance the revision.
   */
  saveDraft(userId: string, botId: string, value: Pick<SavedDraft, "text" | "attachments">, baseRevision?: number) {
    return this.database.transaction((): { saved: boolean; draft: SavedDraft } => {
      const current = this.draft(userId, botId);
      const content = JSON.stringify({ text: value.text, attachments: value.attachments });
      if (current && JSON.stringify({ text: current.text, attachments: current.attachments }) === content)
        return { saved: true, draft: current };
      if (baseRevision !== undefined && baseRevision !== (current?.revision ?? 0))
        return { saved: false, draft: current ?? { text: "", attachments: [], revision: 0, reason: "edit", sentRevision: 0 } };
      this.db
        .prepare("INSERT INTO drafts(user_id,bot_id,value) VALUES(?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET value=excluded.value")
        .run(userId, botId, content);
      this.advanceDraft(userId, botId, "edit");
      return { saved: true, draft: this.draft(userId, botId)! };
    });
  }
  /**
   * Clears the sender's draft once their message is accepted, if it still holds the sent text, or
   * if nothing changed it after the revision the message was written on. The second catches a
   * send made before the last edits were saved. Runs inside the receipt transaction.
   */
  clearSubmittedDraft(userId: string, botId: string, expected: Pick<SavedDraft, "text" | "attachments">, baseRevision?: number) {
    const current = this.draft(userId, botId);
    const empty = JSON.stringify({ text: "", attachments: [] });
    const content = current ? JSON.stringify({ text: current.text, attachments: current.attachments }) : empty;
    // An empty draft still records the send, so a save dispatched before it cannot restore the text.
    if (content !== empty && content !== JSON.stringify(expected) && (baseRevision === undefined || current!.revision > baseRevision))
      return false;
    this.db
      .prepare("INSERT INTO drafts(user_id,bot_id,value) VALUES(?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET value=excluded.value")
      .run(userId, botId, empty);
    this.advanceDraft(userId, botId, "sent");
    return true;
  }
  private advanceDraft(userId: string, botId: string, reason: SavedDraft["reason"]) {
    const previous = this.db.prepare("SELECT revision,sent_revision AS sentRevision FROM draft_revisions WHERE user_id=? AND bot_id=?")
      .get(userId, botId) as { revision: number; sentRevision: number } | undefined;
    const revision = (previous?.revision ?? 0) + 1;
    this.db
      .prepare("INSERT INTO draft_revisions(user_id,bot_id,revision,reason,sent_revision) VALUES(?,?,?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET revision=excluded.revision,reason=excluded.reason,sent_revision=excluded.sent_revision")
      .run(userId, botId, revision, reason, reason === "sent" ? revision : previous?.sentRevision ?? 0);
  }
}
