import type { Avatar, RuntimeEvent } from "../shared/types.js";
import { visible } from "./bot-access.js";
import type { StoreDatabase } from "./store-database.js";

/**
 * Who may see each assistant, now and over time, its avatar and its names. Sharing writes carry
 * an in-memory version so a request can tell whether sharing changed while it ran.
 */
export class PresentationRepository {
  constructor(private readonly database: StoreDatabase) {
    // Today pages filter in SQL with the same rule notifications use.
    database.db.function("may_receive", (value, userId) => this.mayReceive(JSON.parse(String(value)), String(userId)) ? 1 : 0);
  }
  private get db() { return this.database.db; }
  presentation(botId: string | undefined) {
    // Alerts and test pushes have no assistant; node:sqlite on Node 24 refuses to bind undefined.
    if (!botId) return {};
    const row = this.db
      .prepare(
        "SELECT owner_id AS ownerId,shared,avatar FROM bot_presentation WHERE bot_id=?",
      )
      .get(botId) as
      | { ownerId: string | null; shared: number; avatar: string | null }
      | undefined;
    return row
      ? {
          ownerId: row.ownerId ?? undefined,
          shared: !!row.shared,
          avatar: row.avatar ? (JSON.parse(row.avatar) as Avatar) : undefined,
        }
      : {};
  }
  /** Advances whenever an assistant's sharing or owner changes, so a request can tell it changed meanwhile. */
  privacyVersion = 0;
  private privacyChanges: { version: number; botId: string }[] = [];
  /** Assistants whose sharing or owner changed after this version. */
  changedSince(version: number) {
    return this.privacyChanges.filter(change => change.version > version).map(change => change.botId);
  }
  /** Private assistants and their owners. */
  privateBots(): { botId: string; ownerId: string }[] {
    return this.db.prepare("SELECT bot_id AS botId,owner_id AS ownerId FROM bot_presentation WHERE shared=0 AND owner_id IS NOT NULL").all() as { botId: string; ownerId: string }[];
  }
  rememberNames(bots: { id: string; name: string }[]) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO bot_names VALUES(?,?)");
    for (const bot of bots) if (typeof bot.id === "string" && typeof bot.name === "string") insert.run(bot.id, bot.name);
  }
  /** Each assistant's current and earlier names. */
  nameHistory() {
    const names = new Map<string, Set<string>>();
    for (const row of this.db.prepare("SELECT bot_id AS botId,name FROM bot_names").all() as { botId: string; name: string }[])
      names.set(row.botId, (names.get(row.botId) ?? new Set()).add(row.name));
    return names;
  }
  /** Who could see the assistant from each moment on: an owner, or null for everyone. */
  visibilityPeriods(botId: string): { startedAt: number; ownerId: string | null }[] {
    return this.db.prepare("SELECT started_at AS startedAt,owner_id AS ownerId FROM bot_visibility_periods WHERE bot_id=? ORDER BY started_at").all(botId) as { startedAt: number; ownerId: string | null }[];
  }
  /**
   * Whether this person may hear about an event: they can see the assistant now, and could
   * when the event happened. An event without a readable time counts as private whenever
   * the assistant has ever been, so it reaches only someone who owned it.
   */
  mayReceive(event: Pick<RuntimeEvent, "botId" | "occurredAt">, userId: string) {
    if (!visible(this.presentation(event.botId), userId)) return false;
    const periods = this.visibilityPeriods(event.botId);
    if (!periods.length) return true;
    const at = Date.parse(event.occurredAt);
    if (Number.isNaN(at)) return periods.every(period => period.ownerId === null || period.ownerId === userId);
    const period = periods.findLast(period => period.startedAt <= at) ?? periods[0];
    return period.ownerId === null || period.ownerId === userId;
  }
  /** The latest write of each assistant's sharing, so a rollback can tell its own write from a later one. */
  private versions = new Map<string, number>();
  private writePresentation(botId: string, next: { ownerId?: string; shared: boolean }, avatar: string | null) {
    const previous = this.presentation(botId);
    this.db.prepare("INSERT INTO bot_presentation VALUES(?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET owner_id=excluded.owner_id,shared=excluded.shared,avatar=excluded.avatar")
      .run(botId, next.ownerId ?? null, +next.shared, avatar);
    const before = previous.shared === false && previous.ownerId ? previous.ownerId : null;
    const after = !next.shared && next.ownerId ? next.ownerId : null;
    if (before !== after) {
      const now = Date.now();
      // The first change also records how it was before, back to the beginning.
      if (!this.visibilityPeriods(botId).length) this.db.prepare("INSERT INTO bot_visibility_periods VALUES(?,0,?)").run(botId, before);
      this.db.prepare("INSERT INTO bot_visibility_periods VALUES(?,?,?) ON CONFLICT(bot_id,started_at) DO UPDATE SET owner_id=excluded.owner_id").run(botId, now, after);
    }
    const version = ++this.privacyVersion;
    this.versions.set(botId, version);
    if ((previous.shared !== false) !== next.shared || (previous.ownerId ?? null) !== (next.ownerId ?? null)) {
      this.privacyChanges.push({ version, botId });
      if (this.privacyChanges.length > 1000) this.privacyChanges.splice(0, 500);
    }
    return version;
  }
  /** ownerId is written as given, so a shared assistant keeps no stale owner. */
  savePresentation(botId: string, input: { ownerId?: string; shared: boolean; avatar?: Avatar }) {
    this.database.transaction(() => {
      const avatar = input.avatar ?? this.presentation(botId).avatar;
      this.writePresentation(botId, input, avatar ? JSON.stringify(avatar) : null);
    });
  }
  /**
   * Changes sharing and owner only if they are still what the caller authorized against.
   * A save that raced another member's change returns false and writes nothing.
   */
  swapPresentation(botId: string, expected: { ownerId?: string; shared?: boolean }, next: { ownerId?: string; shared: boolean }): number | false {
    return this.database.transaction(() => {
      const current = this.presentation(botId);
      if ((current.shared !== false) !== (expected.shared !== false) || (current.ownerId ?? null) !== (expected.ownerId ?? null)) return false;
      return this.writePresentation(botId, next, current.avatar ? JSON.stringify(current.avatar) : null);
    });
  }
  /** Puts sharing back, only if the write that version made is still the latest one. */
  restorePresentation(botId: string, version: number, previous: { ownerId?: string; shared?: boolean }) {
    return this.database.transaction(() => {
      if (this.versions.get(botId) !== version) return false;
      // An assistant that had no record before goes back to having none.
      if (previous.shared === undefined) {
        this.db.prepare("DELETE FROM bot_presentation WHERE bot_id=?").run(botId);
        this.db.prepare("DELETE FROM bot_visibility_periods WHERE bot_id=?").run(botId);
        this.versions.set(botId, ++this.privacyVersion);
        return true;
      }
      const current = this.presentation(botId);
      this.writePresentation(botId, { shared: previous.shared !== false, ownerId: previous.ownerId }, current.avatar ? JSON.stringify(current.avatar) : null);
      return true;
    });
  }
  /** Changes only the avatar, never who may see the assistant. */
  saveAvatar(botId: string, avatar: Avatar, shared: boolean) {
    this.db.prepare("INSERT INTO bot_presentation(bot_id,owner_id,shared,avatar) VALUES(?,NULL,?,?) ON CONFLICT(bot_id) DO UPDATE SET avatar=excluded.avatar")
      .run(botId, +shared, JSON.stringify(avatar));
  }
}
