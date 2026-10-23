import type { RuntimeEvent } from "../shared/types.js";
import type { NotificationRepository } from "./store-notifications.js";
import type { PresentationRepository } from "./store-presentation.js";
import type { StoreDatabase } from "./store-database.js";

/** The durable Hermes event log, its discovery cursor, and each person's Today feed over it. */
export class EventRepository {
  // The presentation repository registers may_receive, which eventPage filters with.
  constructor(private readonly database: StoreDatabase, private readonly notifications: NotificationRepository, readonly presentation: PresentationRepository) {}
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
      for (const event of events)
        if (event.kind !== "activity") {
          this.db
            .prepare("INSERT OR IGNORE INTO notification_events VALUES(?,?,?)")
            .run(event.id, JSON.stringify(event), Date.now());
          this.db.prepare("INSERT INTO notification_ingestion(event_id) SELECT ? WHERE NOT EXISTS(SELECT 1 FROM notification_ingestion WHERE event_id=?)").run(event.id, event.id);
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
  latestEventFrontier(): number {
    return (this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='notification_ingestion'").get() as { seq: number } | undefined)?.seq ?? 0;
  }
  /**
   * One page of this person's events. Events they may not receive, by mayReceive, are
   * skipped and never move the returned frontier, so it reveals nothing about hidden activity.
   */
  eventPage(userId: string, frontier: number, upperFrontier: number, botIds: string[], initialSince?: string) {
    if (!botIds.length) return { events: [], frontier: String(frontier), hasMore: false };
    const since = initialSince ? Date.parse(initialSince) : null;
    const mine = `FROM notification_ingestion i JOIN notification_events e ON e.id=i.event_id WHERE i.id>? AND i.id<=? AND json_extract(e.value,'$.botId') IN (${botIds.map(() => '?').join(',')}) AND may_receive(e.value,?)=1`;
    const rows = this.db.prepare(`SELECT i.id,e.value ${mine} AND (? IS NULL OR e.created_at>=?) ORDER BY i.id LIMIT 101`).all(frontier, upperFrontier, ...botIds, userId, since, since) as { id: number; value: string }[];
    const page = rows.slice(0, 100);
    // Older visible events before the recap start are passed over; hidden ones never count.
    const last = (this.db.prepare(`SELECT max(i.id) AS id ${mine}`).get(frontier, upperFrontier, ...botIds, userId) as { id: number | null }).id ?? frontier;
    return { events: page.map(row => JSON.parse(row.value) as RuntimeEvent), frontier: String(rows.length > 100 ? page.at(-1)!.id : Math.max(frontier, last)), hasMore: rows.length > 100 };
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
