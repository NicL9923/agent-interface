import { randomUUID } from "node:crypto";
import { Conflict, InvalidInput, NotFound, submissionConflictMessage } from "../shared/errors.js";
import type {
  QueueItem,
  QueueItemPriority,
  QueueListRequest,
  QueueListResponse,
} from "../shared/queue.js";
import type { StoreDatabase } from "./store-database.js";

export type EnqueueInput = Pick<
  QueueItem,
  "botId" | "requestId" | "senderId" | "senderName" | "text"
> &
  Partial<Pick<QueueItem, "files" | "priority">> & { expectedVersion?: number };

type QueueRow = Omit<QueueItem, "files" | "priority" | "claimedAt" | "settledAt" | "error"> & {
  files: string;
  priority: number;
  claimedAt: number | null;
  settledAt: number | null;
  error: string | null;
};
type QueueOrder = { id: string; position: number; priority: number };

const columns = `id, bot_id AS botId, request_id AS requestId, sender_id AS senderId,
  sender_name AS senderName, text, files, position, status, priority,
  conversation_version AS conversationVersion, created_at AS createdAt, updated_at AS updatedAt,
  claimed_at AS claimedAt, settled_at AS settledAt, error`;
const order = "priority DESC, position ASC, created_at ASC, id ASC";
const priorityValue = (priority?: QueueItemPriority) => (priority === "send_now" ? 1 : 0);
const missingItem = () => new NotFound("Queued message not found", "queue_item_not_found");

function queueItem({ files, priority, claimedAt, settledAt, error, ...row }: QueueRow): QueueItem {
  return {
    ...row,
    files: JSON.parse(files) as QueueItem["files"],
    priority: priority === 1 ? "send_now" : "normal",
    ...(claimedAt !== null ? { claimedAt } : {}),
    ...(settledAt !== null ? { settledAt } : {}),
    ...(error !== null ? { error } : {}),
  };
}

/** Durable admission and dispatch. SQLite serializes writers across store connections. */
export class QueueRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() {
    return this.database.db;
  }

  version(botId: string): number {
    const row = this.db
      .prepare("SELECT version FROM bot_conversation_versions WHERE bot_id=?")
      .get(botId) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  /** Runtime callers can also advance this in the transaction that records an external turn or prompt. */
  bumpVersion(botId: string): number {
    const row = this.db
      .prepare(`INSERT INTO bot_conversation_versions(bot_id,version) VALUES(?,1)
        ON CONFLICT(bot_id) DO UPDATE SET version=version+1 RETURNING version`)
      .get(botId) as { version: number };
    return row.version;
  }

  enqueue(input: EnqueueInput): QueueItem {
    return this.database.transaction(() => {
      const existing = this.db
        .prepare(`SELECT ${columns} FROM bot_queue WHERE request_id=?`)
        .get(input.requestId) as QueueRow | undefined;
      if (existing) {
        if (existing.botId !== input.botId || existing.senderId !== input.senderId)
          throw new Conflict(submissionConflictMessage, "submission_conflict");
        return queueItem(existing);
      }
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== this.version(input.botId)
      )
        throw new Conflict(
          "The conversation changed before your action was sent.",
          "conversation_changed",
        );
      const now = Date.now();
      const version = this.bumpVersion(input.botId);
      const row = this.db
        .prepare(`INSERT INTO bot_queue(id,bot_id,request_id,sender_id,sender_name,text,files,position,status,
          priority,conversation_version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,(SELECT coalesce(max(position),0)+1 FROM bot_queue WHERE bot_id=?),
            'queued',?,?,?,?) RETURNING ${columns}`)
        .get(
          randomUUID(),
          input.botId,
          input.requestId,
          input.senderId,
          input.senderName,
          input.text,
          JSON.stringify(input.files ?? []),
          input.botId,
          priorityValue(input.priority),
          version,
          now,
          now,
        ) as QueueRow;
      return queueItem(row);
    });
  }

  list(botId: string, { includeSettled = false }: QueueListRequest = {}): QueueItem[] {
    const statuses = includeSettled ? "" : "AND status IN ('queued','running')";
    return (
      this.db
        .prepare(`SELECT ${columns} FROM bot_queue WHERE bot_id=? ${statuses} ORDER BY ${order}`)
        .all(botId) as QueueRow[]
    ).map(queueItem);
  }

  snapshot(botId: string, options: QueueListRequest): QueueListResponse {
    return this.database.transaction(() => ({
      items: this.list(botId, options),
      conversationVersion: this.version(botId),
    }));
  }

  private item(botId: string, itemId: string): QueueItem {
    const row = this.db
      .prepare(`SELECT ${columns} FROM bot_queue WHERE bot_id=? AND id=?`)
      .get(botId, itemId) as QueueRow | undefined;
    if (!row) throw missingItem();
    return queueItem(row);
  }

  private requireQueued(item: QueueItem) {
    if (item.status !== "queued")
      throw new Conflict("This message is no longer queued.", "queue_item_not_queued");
    return item;
  }

  edit(
    botId: string,
    itemId: string,
    userId: string,
    text: string,
    { allowHousehold = false } = {},
  ): QueueItem {
    return this.database.transaction(() => {
      const item = this.item(botId, itemId);
      if (item.senderId !== userId && !allowHousehold) throw missingItem();
      this.requireQueued(item);
      if (!text.trim() && !item.files.length) throw new InvalidInput("Message cannot be empty");
      if (text === item.text) return item;
      const row = this.db
        .prepare(`UPDATE bot_queue SET text=?,updated_at=? WHERE id=? RETURNING ${columns}`)
        .get(text, Date.now(), itemId) as QueueRow;
      this.bumpVersion(botId);
      return queueItem(row);
    });
  }

  reorder(botId: string, itemId: string, beforeItemId: string | null): QueueItem {
    return this.database.transaction(() => {
      const item = this.requireQueued(this.item(botId, itemId));
      if (beforeItemId === itemId) return item;
      const target =
        beforeItemId === null ? undefined : this.requireQueued(this.item(botId, beforeItemId));
      // A move across the priority boundary takes the destination's priority so every drop has its requested position.
      return this.move(item, target?.id ?? null, priorityValue(target?.priority));
    });
  }

  promoteToSendNow(botId: string, itemId: string): QueueItem {
    return this.database.transaction(() => {
      const item = this.requireQueued(this.item(botId, itemId));
      const first = this.db
        .prepare(`SELECT id FROM bot_queue WHERE bot_id=? AND status='queued' AND id<>?
        ORDER BY ${order} LIMIT 1`)
        .get(botId, itemId) as { id: string } | undefined;
      return this.move(item, first?.id ?? null, priorityValue("send_now"));
    });
  }

  private move(item: QueueItem, beforeItemId: string | null, priority: number): QueueItem {
    const rows = this.db
      .prepare(`SELECT id,position,priority FROM bot_queue
      WHERE bot_id=? AND status='queued' ORDER BY ${order}`)
      .all(item.botId) as QueueOrder[];
    // Reuse the queued positions. Settled and running rows stay in place and new admissions still append at max+1.
    const positions = rows.map((row) => row.position).sort((a, b) => a - b);
    const [moving] = rows.splice(
      rows.findIndex((row) => row.id === item.id),
      1,
    );
    rows.splice(
      beforeItemId === null ? rows.length : rows.findIndex((row) => row.id === beforeItemId),
      0,
      moving,
    );
    const update = this.db.prepare(
      "UPDATE bot_queue SET position=?,priority=?,updated_at=? WHERE id=?",
    );
    const now = Date.now();
    let changed = false;
    for (const [index, row] of rows.entries()) {
      const nextPriority = row.id === item.id ? priority : row.priority;
      const position = positions[index];
      if (row.position === position && nextPriority === row.priority) continue;
      update.run(position, nextPriority, now, row.id);
      changed = true;
    }
    if (!changed) return item;
    this.bumpVersion(item.botId);
    return this.item(item.botId, item.id);
  }

  cancel(botId: string, itemId: string): QueueItem {
    return this.database.transaction(() => {
      this.requireQueued(this.item(botId, itemId));
      return this.settle(botId, itemId, "cancelled");
    });
  }

  claimNext(botId: string, runId: string): QueueItem | undefined {
    return this.database.transaction(() => {
      const now = Date.now();
      const row = this.db
        .prepare(`UPDATE bot_queue SET status='running',run_id=?,claimed_at=?,updated_at=?
        WHERE id=(SELECT id FROM bot_queue WHERE bot_id=? AND status='queued'
          AND NOT EXISTS(SELECT 1 FROM bot_queue WHERE bot_id=? AND status='running')
          ORDER BY ${order} LIMIT 1) RETURNING ${columns}`)
        .get(runId, now, now, botId, botId) as QueueRow | undefined;
      if (!row) return undefined;
      this.bumpVersion(botId);
      return queueItem(row);
    });
  }

  complete(botId: string, itemId: string): QueueItem {
    return this.finishRun(botId, itemId, "completed");
  }

  fail(botId: string, itemId: string, error: string): QueueItem {
    return this.finishRun(botId, itemId, "interrupted", error);
  }

  private finishRun(
    botId: string,
    itemId: string,
    status: "completed" | "interrupted",
    error?: string,
  ): QueueItem {
    return this.database.transaction(() => {
      const item = this.item(botId, itemId);
      if (item.status === status) return item;
      if (item.status !== "running")
        throw new Conflict("This message is no longer running.", "queue_item_not_running");
      return this.settle(botId, itemId, status, error);
    });
  }

  private settle(
    botId: string,
    itemId: string,
    status: "completed" | "interrupted" | "cancelled",
    error?: string,
  ): QueueItem {
    const now = Date.now();
    const row = this.db
      .prepare(`UPDATE bot_queue SET status=?,error=?,settled_at=?,updated_at=?
      WHERE id=? RETURNING ${columns}`)
      .get(status, error ?? null, now, now, itemId) as QueueRow;
    this.bumpVersion(botId);
    return queueItem(row);
  }

  markRunningInterrupted(botId?: string): number {
    return this.database.transaction(() => {
      const now = Date.now();
      const scope = botId === undefined ? "" : "AND bot_id=?";
      const interrupted = this.db
        .prepare(`UPDATE bot_queue SET status='interrupted',settled_at=?,updated_at=?
        WHERE status='running' ${scope} RETURNING bot_id AS botId`)
        .all(now, now, ...(botId === undefined ? [] : [botId])) as { botId: string }[];
      for (const row of interrupted) this.bumpVersion(row.botId);
      return interrupted.length;
    });
  }
}
