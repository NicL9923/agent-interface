import type { FileRef } from "../shared/types.js";
import { fileKeys, generateFileKey, type FileKey, type FileKeys, type FileSigner } from "./hermes-files.js";
import type { StoreDatabase } from "./store-database.js";

const CURRENT = "file_key_current";
const PREFIX = "file_key:";

/** What one upgrade pass did: references re-signed, and references or rows it could not read and left as they were. */
export interface FileReferenceUpgrade { upgraded: number; unreadable: number }

/**
 * The key this installation signs file identifiers with, and the upgrade of stored identifiers to it.
 * Keys sit in the metadata table, which every release reads by key, so a rollback ignores them.
 */
export class FileKeyRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() { return this.database.db; }
  /**
   * Creates the installation's file key if it has none. The store calls this once when it opens.
   * Two processes opening at once keep whichever key landed first.
   */
  ensureFileKey() {
    // Read first: a write takes the lock, which only a new installation needs.
    if (this.db.prepare(`SELECT 1 FROM metadata WHERE key='${CURRENT}'`).get()) return;
    this.database.transaction(() => {
      if (this.db.prepare(`SELECT 1 FROM metadata WHERE key='${CURRENT}'`).get()) return;
      const key = generateFileKey();
      this.db.prepare("INSERT INTO metadata VALUES(?,?)").run(PREFIX + key.id, key.secret);
      this.db.prepare("INSERT INTO metadata VALUES(?,?)").run(CURRENT, key.id);
    });
  }
  /** Every file key, with the one new identifiers use. A store that opened without one is a programming error. */
  fileKeys(): FileKeys {
    const rows = this.db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'file\\_key:%' ESCAPE '\\'").all() as { key: string; value: string }[];
    const keys: FileKey[] = rows.map(row => ({ id: row.key.slice(PREFIX.length), secret: row.value }));
    const currentId = (this.db.prepare(`SELECT value FROM metadata WHERE key='${CURRENT}'`).get() as { value: string } | undefined)?.value;
    const current = keys.find(key => key.id === currentId);
    if (!current) throw new Error("The file signing key is missing; the store creates it when it opens.");
    return fileKeys(current, keys);
  }
  /**
   * Re-signs every stored file identifier this server can still verify with the current key: draft
   * attachments, avatars and the files on recorded events. Safe on every start: current identifiers
   * are left alone, and a row or identifier that does not parse or verify stays as it was and is counted.
   *
   * Submissions are left as sent. A retry of the same request compares its body with the stored one,
   * and the device retrying still holds the identifiers it sent. They are never verified again.
   *
   * A draft keeps its revision. A send written on that revision still clears it, and a device that
   * holds the earlier copy keeps a copy that works.
   */
  upgradeFileReferences(files: Pick<FileSigner, "isCurrent" | "resign">): FileReferenceUpgrade {
    const count: FileReferenceUpgrade = { upgraded: 0, unreadable: 0 };
    const upgrade = (ref: unknown): unknown => {
      if (!ref || typeof ref !== "object" || typeof (ref as FileRef).id !== "string") {
        count.unreadable++;
        return ref;
      }
      const file = ref as FileRef;
      if (files.isCurrent(file.id)) return ref;
      try {
        const next = files.resign(file.id);
        count.upgraded++;
        return { ...file, id: next.id, ...(file.url !== undefined ? { url: next.url } : {}) };
      } catch {
        count.unreadable++;
        return ref;
      }
    };
    const rewrite = (table: string, column: string, where: string, change: (value: Record<string, unknown>) => void) => {
      const rows = this.db.prepare(`SELECT rowid AS id,${column} AS value FROM ${table} WHERE ${where}`).all() as { id: number; value: string }[];
      for (const row of rows) {
        let value: Record<string, unknown>;
        try { value = JSON.parse(row.value); } catch { count.unreadable++; continue; }
        if (!value || typeof value !== "object") { count.unreadable++; continue; }
        change(value);
        const next = JSON.stringify(value);
        if (next !== row.value) this.db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(next, row.id);
      }
    };
    this.database.transaction(() => {
      // instr, not json_extract: one malformed row must not stop the pass.
      rewrite("drafts", "value", "instr(value,'\"attachments\"')>0", value => { if (Array.isArray(value.attachments)) value.attachments = value.attachments.map(upgrade); });
      rewrite("notification_events", "value", "instr(value,'\"files\"')>0", value => { if (Array.isArray(value.files)) value.files = value.files.map(upgrade); });
      rewrite("bot_presentation", "avatar", "avatar IS NOT NULL", value => {
        if (value.mode !== "portrait" || typeof value.src !== "string" || !value.src.startsWith("/api/files/")) return;
        let id: string;
        try { id = decodeURIComponent(value.src.slice("/api/files/".length)); } catch { count.unreadable++; return; }
        const next = upgrade({ id, url: value.src }) as FileRef;
        value.src = next.url;
      });
    });
    return count;
  }
}
