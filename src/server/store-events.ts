import type { RuntimeEvent } from "../shared/types.js";
import type { NotificationRepository } from "./store-notifications.js";
import type { PresentationRepository } from "./store-presentation.js";
import type { StoreDatabase } from "./store-database.js";
import type { CheckInRepository } from "./store-check-ins.js";

/** The durable Hermes event log, its discovery cursor, and each person's Today feed over it. */
export class EventRepository {
  // The presentation repository's sharing rules decide which events eventPage returns.
  constructor(private readonly database: StoreDatabase, private readonly notifications: NotificationRepository, readonly presentation: PresentationRepository,
    private readonly checkIns?: CheckInRepository) {}
  private get db() { return this.database.db; }
  cursor(): string {
    return (
      (
        this.db
          .prepare("SELECT value FROM metadata WHERE key='event_cursor'")
          .get() as { value: string } | undefined
      )?.value ?? ""
    );
  }
  recordEvents(events: RuntimeEvent[], cursor: string) {
    this.database.transaction(() => {
      for (const found of events)
        if (found.kind !== "activity") {
          // A silent check-in is kept, for run settlement, but marked so nothing tells anyone about it.
          const event = this.checkIns?.quiet(found) ? { ...found, quiet: true } : found;
          this.db
            .prepare("INSERT OR IGNORE INTO notification_events VALUES(?,?,?)")
            .run(event.id, JSON.stringify(event), Date.now());
          this.db.prepare("INSERT INTO notification_ingestion(event_id) SELECT ? WHERE NOT EXISTS(SELECT 1 FROM notification_ingestion WHERE event_id=?)").run(event.id, event.id);
          if (event.runId && ["completed", "failed", "interrupted"].includes(event.kind))
            this.db.prepare("INSERT OR IGNORE INTO run_settlements(bot_id,run_id,ingestion_id) SELECT ?,?,id FROM notification_ingestion WHERE event_id=?").run(event.botId, event.runId, event.id);
          this.notifications.enqueue(event);
        }
      this.db
        .prepare(
          "INSERT INTO metadata VALUES('event_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(cursor);
    });
  }
  enqueueKnownEvents(now = Date.now()) {
    this.database.transaction(() => {
      // Late participants still receive recent events; a new follower never gets a month of history.
      for (const row of this.db
        .prepare("SELECT value FROM notification_events WHERE created_at>=?")
        .all(now - 86400000) as { value: string }[])
        this.notifications.enqueue(JSON.parse(row.value));
      this.db
        .prepare("DELETE FROM notification_events WHERE created_at<?")
        .run(now - 30 * 86400000);
    });
  }
  /** How Hermes last reported a run ending, from discovered events, or undefined before it has. */
  runOutcome(botId: string, runId: string): "completed" | "failed" | "interrupted" | undefined {
    const row = this.db.prepare(`SELECT json_extract(e.value,'$.kind') AS kind FROM run_settlements s JOIN notification_ingestion i ON i.id=s.ingestion_id
      JOIN notification_events e ON e.id=i.event_id WHERE s.bot_id=? AND s.run_id=? ORDER BY s.ingestion_id DESC LIMIT 1`).get(botId, runId) as { kind: string } | undefined;
    return row && ["completed", "failed", "interrupted"].includes(row.kind) ? row.kind as "completed" | "failed" | "interrupted" : undefined;
  }
  latestEventFrontier(): number {
    return (this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='notification_ingestion'").get() as { seq: number } | undefined)?.seq ?? 0;
  }
  /**
   * One page of this person's events. Events they may not receive, by mayReceive, are
   * skipped and never move the returned frontier, so it reveals nothing about hidden activity.
   * Older visible events before `initialSince` are passed over but do move it.
   */
  eventPage(userId: string, frontier: number, upperFrontier: number, botIds: string[], initialSince?: string) {
    const receiver = this.presentation.receiver(userId, botIds);
    if (!receiver.botIds.length) return { events: [], frontier: String(frontier), hasMore: false };
    const since = initialSince ? Date.parse(initialSince) : null;
    // One ordered pass over light columns: whole events are read only for the page. Sharing is
    // checked here, once per assistant, instead of per row in SQL. Past a full page the rest is
    // never read; otherwise the pass has seen every visible event and so the newest one.
    const candidates = this.db.prepare(`SELECT i.id,e.id AS eventId,json_extract(e.value,'$.botId') AS botId,json_extract(e.value,'$.occurredAt') AS occurredAt,e.created_at AS createdAt,json_extract(e.value,'$.quiet') AS quiet
      FROM notification_ingestion i JOIN notification_events e ON e.id=i.event_id
      WHERE i.id>? AND i.id<=? AND json_extract(e.value,'$.botId') IN (${receiver.botIds.map(() => "?").join(",")}) ORDER BY i.id`);
    const rows: { id: number; eventId: string }[] = [];
    let last = frontier;
    for (const row of candidates.iterate(frontier, upperFrontier, ...receiver.botIds) as Iterable<{ id: number; eventId: string; botId: string; occurredAt: unknown; createdAt: number; quiet: unknown }>) {
      if (!receiver.mayReceive(row.botId, row.occurredAt)) continue;
      last = row.id;
      if (row.quiet) continue;
      if (since !== null && !(row.createdAt >= since)) continue;
      rows.push(row);
      if (rows.length > 100) break;
    }
    const hasMore = rows.length > 100;
    const page = rows.slice(0, 100);
    const values = new Map((this.db.prepare("SELECT id,value FROM notification_events WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(page.map(row => row.eventId))) as { id: string; value: string }[]).map(row => [row.id, row.value]));
    return { events: page.map(row => JSON.parse(values.get(row.eventId)!) as RuntimeEvent), frontier: String(hasMore ? page.at(-1)!.id : Math.max(frontier, last)), hasMore };
  }
  todaySeen(userId: string): string | undefined {
    return (this.db.prepare("SELECT seen_at FROM today_seen WHERE user_id=?").get(userId) as { seen_at: string } | undefined)?.seen_at;
  }
  todayFrontier(userId: string): number {
    return (this.db.prepare("SELECT event_frontier FROM today_seen WHERE user_id=?").get(userId) as { event_frontier: number } | undefined)?.event_frontier ?? 0;
  }
  markTodaySeen(userId: string, seenAt: string, frontier: number) {
    this.db.prepare("INSERT INTO today_seen VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET seen_at=max(today_seen.seen_at,excluded.seen_at),event_frontier=max(today_seen.event_frontier,excluded.event_frontier)").run(userId, seenAt, frontier);
  }
}
