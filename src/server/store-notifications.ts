import { randomUUID } from "node:crypto";
import { notificationCopy } from "../shared/event-copy.js";
import type { RuntimeEvent } from "../shared/types.js";
import { httpError } from "./http-error.js";
import type { AccountRepository } from "./store-accounts.js";
import type { PersonalRepository } from "./store-personal.js";
import type { PresentationRepository } from "./store-presentation.js";
import type { RoutineRepository } from "./store-routines.js";
import type { SubmissionRepository } from "./store-submissions.js";
import type { StoreDatabase } from "./store-database.js";

// Exponential backoff spends about an hour on these; later news is stale.
export const maxDeliveryAttempts = 12;
// Clients report an open chat every 15 seconds, so a missed beat or two never counts as leaving.
export const presenceTtl = 45000;
/** What a client reports about a chat: reading it, gone after reading it, or still open but unattended. */
export type ChatPresence = "active" | "left" | "idle";
// Discovery lags Hermes by a poll, or longer after an outage, so Hermes's own timestamp says
// when the reply could first be read. One from a clock running ahead falls back to discovery.
function eventTime(occurredAt: string | undefined, discovered: number) {
  const occurred = Date.parse(occurredAt ?? "");
  return Number.isFinite(occurred) && occurred <= discovered ? occurred : discovered;
}
// A cleared notification is recorded as a delivery to a derived endpoint, so every path that
// forgets a notification's deliveries forgets its clears too.
const clearedEndpoint = (endpoint: string) => `cleared:${endpoint}`;
export interface NotificationCollaborators {
  accounts: AccountRepository;
  personal: PersonalRepository;
  presentation: PresentationRepository;
  routines: RoutineRepository;
  submissions: SubmissionRepository;
}

/** Who hears about each event, the push outbox and its subscriptions, and which chats people have seen. */
export class NotificationRepository {
  constructor(private readonly database: StoreDatabase, private readonly areas: NotificationCollaborators) {}
  private get db() { return this.database.db; }
  recipients(event: RuntimeEvent): string[] {
    const ids = new Set<string>();
    if (event.routineId)
      for (const userId of this.areas.routines.getRoutineRecipients(event.routineId)) ids.add(userId);
    else if (event.runId)
      for (const userId of this.areas.submissions.participants(event.runId)) ids.add(userId);
    for (const user of this.areas.accounts.users())
      if (this.areas.personal.preferences(user.id).followBots.includes(event.botId))
        ids.add(user.id);
    // A private assistant's news goes only to its owner, whoever else followed or joined in.
    return [...ids].filter(userId => this.areas.presentation.mayReceive(event, userId));
  }
  queueNotification(eventId: string, userId: string, payload: object) {
    return this.db
      .prepare("INSERT OR IGNORE INTO outbox(id,event_id,user_id,payload,created_at) VALUES(?,?,?,?,?)")
      .run(randomUUID(), eventId, userId, JSON.stringify(payload), Date.now()).changes > 0;
  }
  /** Assistant display names for notification titles, refreshed by the background worker. */
  botNames = new Map<string, string>();
  enqueue(event: RuntimeEvent) {
    const copy = notificationCopy(event, this.botNames.get(event.botId));
    for (const userId of this.recipients(event))
      this.queueNotification(event.id, userId, {
        title: copy.title,
        body: copy.body,
        url: `/?bot=${encodeURIComponent(event.botId)}${event.routineId ? `&routine=${encodeURIComponent(event.routineId)}` : ''}`,
        tag: event.id,
        kind: event.kind,
        botId: event.botId,
        // Lets an iOS notification decide this approval. Without it the notification only opens the chat.
        ...(event.kind === "approval" && typeof event.approvalId === "string" && event.approvalId ? { approvalId: event.approvalId } : {}),
        queuedAt: Date.now(),
      });
  }
  /** Records what one client reports about one chat. Reading and leaving after reading both mark it read until now. */
  chatPresence(userId: string, botId: string, clientId: string, state: ChatPresence, now = Date.now()) {
    this.database.transaction(() => {
      if (state === "active")
        this.db.prepare("INSERT INTO chat_presence VALUES(?,?,?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET bot_id=excluded.bot_id,updated_at=excluded.updated_at")
          .run(userId, clientId, botId, now);
      else this.db.prepare("DELETE FROM chat_presence WHERE user_id=? AND client_id=? AND bot_id=?").run(userId, clientId, botId);
      if (state !== "idle")
        this.db.prepare("INSERT INTO chat_reads VALUES(?,?,?,?) ON CONFLICT(user_id,bot_id) DO UPDATE SET read_at=max(chat_reads.read_at,excluded.read_at),client_id=excluded.client_id")
          .run(userId, botId, now, clientId);
    });
  }
  /** When this person last read each chat, in milliseconds, for the home list's unread marks. */
  chatReads(userId: string): Map<string, number> {
    const rows = this.db.prepare("SELECT bot_id,read_at FROM chat_reads WHERE user_id=?").all(userId) as { bot_id: string; read_at: number }[];
    return new Map(rows.map(row => [row.bot_id, row.read_at]));
  }
  /**
   * Whether the recipient has a notification's chat open now, or read it after the event.
   * Security alerts and routine results are not part of a chat, so they never count as seen.
   */
  seenInChat(outboxId: string, now = Date.now()) {
    const row = this.db.prepare("SELECT o.user_id,o.payload,o.created_at,e.value,e.created_at AS discovered FROM outbox o LEFT JOIN notification_events e ON e.id=o.event_id WHERE o.id=?")
      .get(outboxId) as { user_id: string; payload: string; created_at: number; value: string | null; discovered: number | null } | undefined;
    if (!row) return false;
    const payload = JSON.parse(row.payload) as { botId?: string; kind?: string; url?: string };
    if (!payload.botId || payload.kind === "security" || new URL(payload.url ?? "/", "http://app").searchParams.has("routine")) return false;
    if (this.db.prepare("SELECT 1 FROM chat_presence WHERE user_id=? AND bot_id=? AND updated_at>?").get(row.user_id, payload.botId, now - presenceTtl)) return true;
    const read = this.db.prepare("SELECT read_at FROM chat_reads WHERE user_id=? AND bot_id=?").get(row.user_id, payload.botId) as { read_at: number } | undefined;
    const event = row.value ? JSON.parse(row.value) as RuntimeEvent : undefined;
    return !!read && read.read_at >= eventTime(event?.occurredAt, row.discovered ?? row.created_at);
  }
  /** iOS deliveries of notifications their recipient has since read, with who read them, that no clear was sent for. */
  readOnDevices(now = Date.now()) {
    // A week covers what a lock screen plausibly still shows.
    return (this.db.prepare(`SELECT d.outbox_id,d.endpoint,o.user_id,json_extract(o.payload,'$.tag') AS tag,r.client_id AS reader FROM delivered d
      JOIN outbox o ON o.id=d.outbox_id JOIN chat_reads r ON r.user_id=o.user_id AND r.bot_id=json_extract(o.payload,'$.botId')
      WHERE d.endpoint LIKE 'apns:%' AND o.created_at>? AND NOT EXISTS(SELECT 1 FROM delivered c WHERE c.outbox_id=d.outbox_id AND c.endpoint='cleared:'||d.endpoint) ORDER BY o.created_at`)
      .all(now - 7 * 86400000) as { outbox_id: string; endpoint: string; user_id: string; tag: string; reader: string }[])
      .filter(row => this.seenInChat(row.outbox_id, now));
  }
  markCleared(id: string, endpoint: string) {
    this.markDelivered(id, clearedEndpoint(endpoint));
  }
  subscribe(
    userId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    const existing = this.db
      .prepare("SELECT user_id FROM subscriptions WHERE endpoint=?")
      .get(subscription.endpoint) as { user_id: string } | undefined;
    if (existing && existing.user_id !== userId)
      throw httpError(409, "This browser push subscription belongs to another household member. Remove it from that session before subscribing.");
    this.db
      .prepare(
        "INSERT INTO subscriptions VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET value=excluded.value",
      )
      .run(subscription.endpoint, userId, JSON.stringify(subscription));
  }
  unsubscribe(userId: string, endpoint: string) {
    this.db
      .prepare("DELETE FROM subscriptions WHERE user_id=? AND endpoint=?")
      .run(userId, endpoint);
  }
  hasSubscription(userId: string, endpoint: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM subscriptions WHERE user_id=? AND endpoint=?").get(userId, endpoint);
  }
  subscriptions(userId: string) {
    return (
      this.db
        .prepare("SELECT value FROM subscriptions WHERE user_id=?")
        .all(userId) as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  outbox() {
    return this.db
      .prepare(
        "SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY rowid",
      )
      .all(Date.now()) as unknown as {
      id: string;
      user_id: string;
      payload: string;
      attempts: number;
    }[];
  }
  deliveryGroups(now = Date.now()) {
    const ready = this.outbox();
    const groups: {id: string; user_id: string; payload: string; items: typeof ready}[] = [];
    const seen = new Set<string>();
    for (const item of ready) {
      if (seen.has(item.id)) continue;
      const existing = this.db.prepare("SELECT b.* FROM notification_batches b JOIN notification_batch_items i ON i.batch_id=b.id WHERE i.outbox_id=?").get(item.id) as {id: string;user_id: string;payload: string} | undefined;
      if (existing) {
        const members = this.db.prepare("SELECT o.id FROM outbox o JOIN notification_batch_items i ON i.outbox_id=o.id WHERE i.batch_id=? AND o.state='pending'").all(existing.id) as {id: string}[];
        const ids = new Set(members.map(row => row.id));
        // A failed constituent's retry deadline applies to the entire frozen digest.
        const items = ready.filter(row => ids.has(row.id));
        items.forEach(row => seen.add(row.id));
        if (items.length === ids.size) groups.push({...existing,items});
        continue;
      }
      const prefs = this.areas.personal.preferences(item.user_id).notifications;
      const payload = JSON.parse(item.payload);
      const created = this.db.prepare("SELECT created_at FROM notification_events WHERE id=(SELECT event_id FROM outbox WHERE id=?)").get(item.id) as {created_at:number} | undefined;
      const minutes = prefs?.batchMinutes ?? 0;
      if (!minutes || !payload.kind || this.db.prepare('SELECT 1 FROM delivered WHERE outbox_id=?').get(item.id) || payload.kind === 'approval' || payload.kind === 'failed' || payload.kind === 'security') { groups.push({...item,items:[item]}); seen.add(item.id); continue; }
      if (now < (payload.queuedAt ?? created?.created_at ?? 0) + minutes * 60000) continue;
      const items = ready.filter(row => row.user_id === item.user_id && !seen.has(row.id) && !this.db.prepare("SELECT 1 FROM notification_batch_items WHERE outbox_id=?").get(row.id) && !this.db.prepare('SELECT 1 FROM delivered WHERE outbox_id=?').get(row.id) && ['completed','activity','interrupted'].includes(JSON.parse(row.payload).kind));
      const batchId = randomUUID();
      const digest = JSON.stringify({title:`${items.length} assistant update${items.length === 1 ? '' : 's'}`,body:items.slice(0,3).map(row=>JSON.parse(row.payload).title).join(' · '),url:'/?view=today',tag:batchId});
      this.database.transaction(() => {
        this.db.prepare("INSERT INTO notification_batches VALUES(?,?,?)").run(batchId,item.user_id,digest);
        for (const row of items) this.db.prepare("INSERT INTO notification_batch_items VALUES(?,?)").run(row.id,batchId);
      });
      items.forEach(row=>seen.add(row.id)); groups.push({id:batchId,user_id:item.user_id,payload:digest,items});
    }
    return groups;
  }
  delivered(id: string, endpoint: string) {
    return !!this.db
      .prepare("SELECT 1 FROM delivered WHERE outbox_id=? AND endpoint=?")
      .get(id, endpoint);
  }
  markDelivered(id: string, endpoint: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO delivered VALUES(?,?)")
      .run(id, endpoint);
  }
  finishDelivery(id: string) {
    this.db.prepare("UPDATE outbox SET state='delivered' WHERE id=?").run(id);
  }
  /** Returns true when the notification has used its last attempt and is now failed. */
  retryDelivery(id: string, attempts: number, error?: string) {
    const failed = attempts >= maxDeliveryAttempts;
    this.db
      .prepare("UPDATE outbox SET attempts=?,next_attempt=?,last_error=?,state=? WHERE id=?")
      .run(
        attempts,
        Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12)),
        error ?? null,
        failed ? "failed" : "pending",
        id,
      );
    return failed;
  }
  expireNotifications(now = Date.now()) {
    // Matches the Web Push TTL: push services drop older messages anyway. Rows queued by an
    // older release have created_at 0 and no reliable age.
    return Number(this.db
      .prepare("UPDATE outbox SET state='expired' WHERE state='pending' AND created_at>0 AND created_at<?")
      .run(now - 86400000).changes);
  }
}
