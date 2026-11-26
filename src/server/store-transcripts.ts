import { excerpt } from "../shared/event-copy.js";
import { isActivityMessage } from "../shared/message-origin.js";
import { markdownPlain } from "../shared/plain-text.js";
import type { Message } from "../shared/types.js";
import type { StoreDatabase } from "./store-database.js";

export type TranscriptMessageInput = Message & { sourceRowId?: string };
export type TranscriptMessage = TranscriptMessageInput & {
  seq: number;
  updatedAt: number;
  sourceRuntime: string;
};
export type TranscriptPage = {
  messages: TranscriptMessage[];
  hasMore: boolean;
  oldestSeq: number | null;
  newestSeq: number | null;
};
export type TranscriptSearchHit = {
  botId: string;
  messageId: string;
  seq: number;
  role: Message["role"];
  createdAt: string | null;
  snippet: string;
};
export type TranscriptSyncState = {
  botId: string;
  sourceRuntime: string;
  canonicalSource: "hermes" | "local";
  lastSyncedAt: number | null;
  lastMessageId: string | null;
  messageCount: number;
  shadowMismatchCount: number;
  lastMismatchAt: number | null;
};

type MessageRow = {
  seq: number;
  message_id: string;
  run_id: string | null;
  role: Message["role"];
  text: string;
  reasoning: string | null;
  tool_name: string | null;
  tool_call_json: string | null;
  files_json: string | null;
  sender_id: string | null;
  sender_name: string | null;
  origin_json: string | null;
  steered: number | null;
  interim: number | null;
  created_at: string | null;
  updated_at: number;
  source_runtime: string;
  source_row_id: string | null;
};

function messageFromRow(row: MessageRow): TranscriptMessage {
  return {
    id: row.message_id,
    role: row.role,
    text: row.text,
    seq: row.seq,
    updatedAt: row.updated_at,
    sourceRuntime: row.source_runtime,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
    ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    ...(row.tool_call_json === null ? {} : { toolCall: JSON.parse(row.tool_call_json) }),
    ...(row.files_json === null ? {} : { files: JSON.parse(row.files_json) }),
    ...(row.sender_id === null ? {} : { sender: { id: row.sender_id, name: row.sender_name! } }),
    ...(row.origin_json === null ? {} : { origin: JSON.parse(row.origin_json) }),
    ...(row.steered === null ? {} : { steered: Boolean(row.steered) }),
    ...(row.interim === null ? {} : { interim: Boolean(row.interim) }),
    ...(row.created_at === null ? {} : { createdAt: row.created_at }),
    ...(row.source_row_id === null ? {} : { sourceRowId: row.source_row_id }),
  };
}

/** One canonical ordering per bot. Append and snapshot inputs are oldest first. */
export class TranscriptRepository {
  private readonly backfills = new Map<string, Promise<TranscriptSyncState | undefined>>();
  private readonly previewCache = new Map<
    string,
    { messageId: string; text: string; at?: string } | undefined
  >();

  constructor(private readonly database: StoreDatabase) {}
  private get db() {
    return this.database.db;
  }

  appendMessages(
    botId: string,
    messages: readonly TranscriptMessageInput[],
    sourceRuntime: string,
  ) {
    const state = this.database.transaction(() => {
      const now = Date.now();
      const previous = this.syncState(botId);
      let lastAllocatedSeq = this.lastAllocatedSeq(botId);
      let messageCount = previous?.messageCount ?? 0;
      let lastMessageId = previous?.lastMessageId ?? null;
      for (const message of messages) {
        const seq = this.upsert(botId, lastAllocatedSeq + 1, message, sourceRuntime, now);
        if (seq !== undefined && seq > lastAllocatedSeq) {
          messageCount++;
          lastAllocatedSeq = seq;
          lastMessageId = message.id;
        }
      }
      return this.saveSyncState(
        botId,
        sourceRuntime,
        now,
        messageCount,
        lastMessageId,
        lastAllocatedSeq,
      );
    });
    this.previewCache.delete(botId);
    this.backfills.delete(botId);
    return state;
  }

  /** Rewrite the history in snapshot order, preserving seqs for the longest prefix still in order. */
  replaceFromSnapshot(
    botId: string,
    messages: readonly TranscriptMessageInput[],
    sourceRuntime: string,
  ) {
    const state = this.database.transaction(() => {
      const now = Date.now();
      let lastAllocatedSeq = this.lastAllocatedSeq(botId);
      // Map keeps the first occurrence's position and the last occurrence's payload, like append.
      const snapshot = new Map(messages.map((message) => [message.id, message]));
      const existing = this.db
        .prepare("SELECT message_id, seq FROM transcript_messages WHERE bot_id=?")
        .all(botId) as { message_id: string; seq: number }[];
      const existingSeqs = new Map(existing.map((row) => [row.message_id, row.seq]));
      const kept = new Set<number>();
      let lastSeq = 0;
      for (const id of snapshot.keys()) {
        const seq = existingSeqs.get(id);
        if (seq === undefined || seq <= lastSeq) break;
        kept.add(seq);
        lastSeq = seq;
      }
      const remove = this.db.prepare("DELETE FROM transcript_messages WHERE bot_id=? AND seq=?");
      for (const { seq } of existing) if (!kept.has(seq)) remove.run(botId, seq);

      let lastMessageId: string | null = null;
      for (const message of snapshot.values()) {
        const seq = this.upsert(botId, lastAllocatedSeq + 1, message, sourceRuntime, now);
        if (seq !== undefined && seq > lastAllocatedSeq) lastAllocatedSeq = seq;
        lastMessageId = message.id;
      }
      return this.saveSyncState(
        botId,
        sourceRuntime,
        now,
        snapshot.size,
        lastMessageId,
        lastAllocatedSeq,
      );
    });
    this.previewCache.delete(botId);
    this.backfills.delete(botId);
    return state;
  }

  /** Share a remote read and drop its result if a newer write or removal wins while it is pending. */
  backfill(
    botId: string,
    sourceRuntime: string,
    read: () => Promise<readonly TranscriptMessageInput[]>,
  ): Promise<TranscriptSyncState | undefined> {
    const state = this.syncState(botId);
    if (state?.canonicalSource === "local") return Promise.resolve(state);
    const existing = this.backfills.get(botId);
    if (existing) return existing;

    const pending: Promise<TranscriptSyncState | undefined> = Promise.resolve()
      .then(read)
      .then((messages) =>
        this.backfills.get(botId) === pending
          ? this.replaceFromSnapshot(botId, messages, sourceRuntime)
          : this.syncState(botId),
      )
      .finally(() => {
        if (this.backfills.get(botId) === pending) this.backfills.delete(botId);
      });
    this.backfills.set(botId, pending);
    return pending;
  }

  /** Pages contain the newest eligible rows in conversation order, oldest first. */
  listPage(
    botId: string,
    { limit, beforeSeq }: { limit: number; beforeSeq?: number },
  ): TranscriptPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit === Number.MAX_SAFE_INTEGER)
      throw new RangeError("Invalid transcript limit.");
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0))
      throw new RangeError("Invalid transcript cursor.");
    const rows = this.db
      .prepare(
        `SELECT * FROM transcript_messages WHERE bot_id=?${beforeSeq === undefined ? "" : " AND seq<?"}
        ORDER BY seq DESC LIMIT ?`,
      )
      .all(
        ...(beforeSeq === undefined ? [botId, limit + 1] : [botId, beforeSeq, limit + 1]),
      ) as MessageRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const messages = rows.reverse().map(messageFromRow);
    return {
      messages,
      hasMore,
      oldestSeq: messages[0]?.seq ?? null,
      newestSeq: messages.at(-1)?.seq ?? null,
    };
  }

  messageSeq(botId: string, messageId: string): number | undefined {
    const row = this.db
      .prepare("SELECT seq FROM transcript_messages WHERE bot_id=? AND message_id=?")
      .get(botId, messageId) as { seq: number } | undefined;
    return row?.seq;
  }

  /** Search only the bot IDs the caller is authorized to read. Snippets are plain text. */
  search(
    botIds: readonly string[],
    query: string,
    {
      limit,
      offset = 0,
      highlight = true,
    }: { limit: number; offset?: number; highlight?: boolean },
  ): TranscriptSearchHit[] {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("Invalid transcript limit.");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid search offset.");
    // Quote each word to make operators, column selectors and wildcard syntax literal.
    const words = query.match(/[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\p{M}]*/gu);
    if (!botIds.length || !words) return [];
    const match = words.map((word) => `"${word}"`).join(" ");
    return this.db
      .prepare(
        `SELECT m.bot_id AS botId, m.message_id AS messageId, m.seq, m.role, m.created_at AS createdAt,
          snippet(transcript_fts, -1, ?, ?, '…', 24) AS snippet
        FROM transcript_fts JOIN transcript_messages m ON m.row_id=transcript_fts.rowid
        WHERE transcript_fts MATCH ? AND m.bot_id IN (SELECT value FROM json_each(?))
        ORDER BY m.row_id DESC LIMIT ? OFFSET ?`,
      )
      .all(
        highlight ? "[" : "",
        highlight ? "]" : "",
        match,
        JSON.stringify(botIds),
        limit,
        offset,
      ) as TranscriptSearchHit[];
  }

  latestPreview(botId: string): { messageId: string; text: string; at?: string } | undefined {
    if (this.previewCache.has(botId)) {
      const cached = this.previewCache.get(botId);
      return cached ? { ...cached } : undefined;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM transcript_messages
        WHERE bot_id=? AND role IN ('user','assistant') AND interim IS NOT 1 AND text<>''
        ORDER BY seq DESC`,
      )
      .iterate(botId) as IterableIterator<MessageRow>;
    let preview: { messageId: string; text: string; at?: string } | undefined;
    for (const row of rows) {
      const message = messageFromRow(row);
      if (isActivityMessage(message) || !message.text.trim()) continue;
      const text = excerpt(markdownPlain(message.text), 160);
      if (text) {
        preview = { messageId: message.id, text, at: message.createdAt };
        break;
      }
    }
    this.previewCache.set(botId, preview);
    return preview ? { ...preview } : undefined;
  }

  syncState(botId: string): TranscriptSyncState | undefined {
    return this.db
      .prepare(
        `SELECT bot_id AS botId, source_runtime AS sourceRuntime, canonical_source AS canonicalSource,
          last_synced_at AS lastSyncedAt, last_message_id AS lastMessageId, message_count AS messageCount,
          shadow_mismatch_count AS shadowMismatchCount, last_mismatch_at AS lastMismatchAt
        FROM transcript_sync WHERE bot_id=?`,
      )
      .get(botId) as TranscriptSyncState | undefined;
  }

  markCanonicalLocal(botId: string) {
    this.db
      .prepare(
        `INSERT INTO transcript_sync(bot_id,source_runtime,canonical_source) VALUES(?,'local','local')
        ON CONFLICT(bot_id) DO UPDATE SET canonical_source='local'`,
      )
      .run(botId);
    this.backfills.delete(botId);
  }

  recordShadowDiff(botId: string, diffCount: number) {
    if (!Number.isSafeInteger(diffCount) || diffCount < 0)
      throw new RangeError("Invalid shadow mismatch count.");
    if (diffCount === 0) return;
    this.db
      .prepare(
        `INSERT INTO transcript_sync(bot_id,source_runtime,shadow_mismatch_count,last_mismatch_at)
        VALUES(?,'hermes',?,?) ON CONFLICT(bot_id) DO UPDATE SET
          shadow_mismatch_count=shadow_mismatch_count+excluded.shadow_mismatch_count,
          last_mismatch_at=excluded.last_mismatch_at`,
      )
      .run(botId, diffCount, Date.now());
  }

  /** Called by the bot-retention transaction. The delete trigger removes the indexed text. */
  forgetBot(botId: string) {
    this.db.prepare("DELETE FROM transcript_messages WHERE bot_id=?").run(botId);
    this.db.prepare("DELETE FROM transcript_sync WHERE bot_id=?").run(botId);
    this.previewCache.delete(botId);
    this.backfills.delete(botId);
  }

  private lastAllocatedSeq(botId: string) {
    const row = this.db
      .prepare("SELECT last_allocated_seq FROM transcript_sync WHERE bot_id=?")
      .get(botId) as { last_allocated_seq: number } | undefined;
    return row?.last_allocated_seq ?? 0;
  }

  private upsert(
    botId: string,
    nextSeq: number,
    message: TranscriptMessageInput,
    sourceRuntime: string,
    now: number,
  ) {
    const row = this.db
      .prepare(
        `INSERT INTO transcript_messages(
          bot_id,seq,message_id,run_id,role,text,reasoning,tool_name,tool_call_json,files_json,
          sender_id,sender_name,origin_json,steered,interim,created_at,updated_at,source_runtime,source_row_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(bot_id,message_id) DO UPDATE SET
          run_id=excluded.run_id, role=excluded.role, text=excluded.text,
          reasoning=excluded.reasoning, tool_name=excluded.tool_name, tool_call_json=excluded.tool_call_json,
          files_json=excluded.files_json, sender_id=excluded.sender_id, sender_name=excluded.sender_name,
          origin_json=excluded.origin_json, steered=excluded.steered, interim=excluded.interim,
          created_at=excluded.created_at, updated_at=excluded.updated_at,
          source_runtime=excluded.source_runtime, source_row_id=excluded.source_row_id
        WHERE (run_id,role,text,reasoning,tool_name,tool_call_json,files_json,sender_id,sender_name,
          origin_json,steered,interim,created_at,source_runtime,source_row_id)
        IS NOT (excluded.run_id,excluded.role,excluded.text,excluded.reasoning,excluded.tool_name,
          excluded.tool_call_json,excluded.files_json,excluded.sender_id,excluded.sender_name,
          excluded.origin_json,excluded.steered,excluded.interim,excluded.created_at,
          excluded.source_runtime,excluded.source_row_id)
        RETURNING seq`,
      )
      .get(
        botId,
        nextSeq,
        message.id,
        message.runId ?? null,
        message.role,
        message.text,
        message.reasoning ?? null,
        message.toolName ?? null,
        JSON.stringify(message.toolCall) ?? null,
        JSON.stringify(message.files) ?? null,
        message.sender?.id ?? null,
        message.sender?.name ?? null,
        JSON.stringify(message.origin) ?? null,
        message.steered === undefined ? null : Number(message.steered),
        message.interim === undefined ? null : Number(message.interim),
        message.createdAt ?? null,
        now,
        sourceRuntime,
        message.sourceRowId ?? null,
      ) as { seq: number } | undefined;
    return row?.seq;
  }

  private saveSyncState(
    botId: string,
    sourceRuntime: string,
    now: number,
    messageCount: number,
    lastMessageId: string | null,
    lastAllocatedSeq: number,
  ) {
    this.db
      .prepare(
        `INSERT INTO transcript_sync(bot_id,source_runtime,last_synced_at,message_count,last_message_id,last_allocated_seq)
        VALUES(?,?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET
          source_runtime=excluded.source_runtime, last_synced_at=excluded.last_synced_at,
          message_count=excluded.message_count, last_message_id=excluded.last_message_id,
          last_allocated_seq=excluded.last_allocated_seq`,
      )
      .run(botId, sourceRuntime, now, messageCount, lastMessageId, lastAllocatedSeq);
    return this.syncState(botId)!;
  }
}
