import { randomUUID } from "node:crypto";
import { Conflict, InvalidInput, NotFound } from "../shared/errors.js";
import {
  CONFIRMATION_KINDS,
  type ActionConfirmation,
  type ConfirmationField,
  type ConfirmationKind,
  type ConfirmationStatus,
} from "../shared/confirmations.js";
import type { StoreDatabase } from "./store-database.js";

type ConfirmationRow = {
  id: string;
  bot_id: string;
  kind: ConfirmationKind;
  title: string;
  summary: string;
  target: string | null;
  payload_json: string;
  status: ConfirmationStatus;
  decided_by: string | null;
  decision_note: string | null;
  created_at: number;
  decided_at: number | null;
};

function toConfirmation(row: ConfirmationRow): ActionConfirmation {
  let fields: ConfirmationField[] = [];
  try {
    const parsed = JSON.parse(row.payload_json);
    if (Array.isArray(parsed)) {
      fields = parsed.filter(
        (item): item is ConfirmationField =>
          !!item &&
          typeof item === "object" &&
          typeof item.label === "string" &&
          typeof item.value === "string",
      );
    }
  } catch {
    fields = [];
  }
  return {
    id: row.id,
    botId: row.bot_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    target: row.target,
    fields,
    status: row.status,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    createdAt: new Date(row.created_at).toISOString(),
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
  };
}

type Waiter = {
  resolve: (result: ActionConfirmation) => void;
  reject: (error: Error) => void;
};

export class ConfirmationRepository {
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly listeners = new Set<(confirmation: ActionConfirmation) => void>();

  constructor(private readonly database: StoreDatabase) {}
  private get db() {
    return this.database.db;
  }

  onChange(listener: (confirmation: ActionConfirmation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(confirmation: ActionConfirmation) {
    for (const listener of this.listeners) {
      try {
        listener(confirmation);
      } catch {
        /* Keep other listeners running. */
      }
    }
  }

  get(id: string): ActionConfirmation | undefined {
    const row = this.db.prepare("SELECT * FROM action_confirmations WHERE id=?").get(id) as
      | ConfirmationRow
      | undefined;
    return row ? toConfirmation(row) : undefined;
  }

  listPendingForBots(botIds: readonly string[], limit = 100): ActionConfirmation[] {
    if (!botIds.length) return [];
    const placeholders = botIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM action_confirmations
         WHERE bot_id IN (${placeholders}) AND status='pending'
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(...botIds, Math.max(1, Math.min(200, limit))) as ConfirmationRow[];
    return rows.map(toConfirmation);
  }

  createPending(input: {
    botId: string;
    kind: ConfirmationKind;
    title: string;
    summary: string;
    target?: string | null;
    fields?: ConfirmationField[];
    now?: number;
  }): ActionConfirmation {
    if (!CONFIRMATION_KINDS.includes(input.kind))
      throw new InvalidInput("Choose a supported external action kind.");
    const title = input.title.trim();
    if (!title || title.length > 200)
      throw new InvalidInput("Confirmation title must be between 1 and 200 characters.");
    const summary = input.summary.trim();
    if (!summary || summary.length > 4_000)
      throw new InvalidInput("Confirmation summary must be between 1 and 4000 characters.");
    const target = input.target?.trim() ? input.target.trim().slice(0, 500) : null;
    const fields = (input.fields ?? [])
      .slice(0, 20)
      .map((field) => ({
        label: field.label.trim().slice(0, 120),
        value: field.value.trim().slice(0, 4_000),
      }))
      .filter((field) => field.label && field.value);
    const id = randomUUID();
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO action_confirmations(
          id,bot_id,kind,title,summary,target,payload_json,status,decided_by,decision_note,created_at,decided_at
        ) VALUES(?,?,?,?,?,?,?,'pending',NULL,NULL,?,NULL)`,
      )
      .run(id, input.botId, input.kind, title, summary, target, JSON.stringify(fields), now);
    const created = this.get(id)!;
    this.emit(created);
    return created;
  }

  decide(
    botId: string,
    id: string,
    decision: "approved" | "declined",
    decidedBy: string,
    note?: string,
    now = Date.now(),
  ): ActionConfirmation {
    const existing = this.db
      .prepare("SELECT * FROM action_confirmations WHERE id=? AND bot_id=?")
      .get(id, botId) as ConfirmationRow | undefined;
    if (!existing) throw new NotFound("Confirmation request not found.");
    if (existing.status !== "pending")
      throw new Conflict("This confirmation request has already been decided.", "already_decided");
    const cleanNote = note?.trim() ? note.trim().slice(0, 2_000) : null;
    this.db
      .prepare(
        `UPDATE action_confirmations
         SET status=?,decided_by=?,decision_note=?,decided_at=?
         WHERE id=? AND status='pending'`,
      )
      .run(decision, decidedBy, cleanNote, now, id);
    const updated = this.get(id)!;
    this.resolveWaiters(id, updated);
    this.emit(updated);
    return updated;
  }

  expire(id: string, now = Date.now()): ActionConfirmation | undefined {
    const existing = this.db.prepare("SELECT * FROM action_confirmations WHERE id=?").get(id) as
      | ConfirmationRow
      | undefined;
    if (!existing || existing.status !== "pending")
      return existing ? toConfirmation(existing) : undefined;
    this.db
      .prepare(
        "UPDATE action_confirmations SET status='expired',decided_at=? WHERE id=? AND status='pending'",
      )
      .run(now, id);
    const updated = this.get(id)!;
    this.resolveWaiters(id, updated);
    this.emit(updated);
    return updated;
  }

  waitForDecision(
    id: string,
    signal?: AbortSignal,
    timeoutMs = 15 * 60_000,
  ): Promise<ActionConfirmation> {
    const existing = this.get(id);
    if (!existing) return Promise.reject(new NotFound("Confirmation request not found."));
    if (existing.status !== "pending") return Promise.resolve(existing);
    if (signal?.aborted) {
      const expired = this.expire(id);
      return Promise.resolve(expired ?? existing);
    }
    return new Promise<ActionConfirmation>((resolve, reject) => {
      const entry: Waiter = {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      let bucket = this.waiters.get(id);
      if (!bucket) {
        bucket = new Set();
        this.waiters.set(id, bucket);
      }
      bucket.add(entry);
      const timer = setTimeout(() => {
        const expired = this.expire(id);
        entry.resolve(expired ?? { ...existing, status: "expired" });
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        const expired = this.expire(id);
        entry.resolve(expired ?? { ...existing, status: "expired" });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const current = this.waiters.get(id);
        current?.delete(entry);
        if (current && current.size === 0) this.waiters.delete(id);
      };
    });
  }

  private resolveWaiters(id: string, value: ActionConfirmation) {
    const bucket = this.waiters.get(id);
    if (!bucket) return;
    for (const waiter of [...bucket]) waiter.resolve(value);
  }

  forgetBot(botId: string) {
    const pending = this.db
      .prepare("SELECT id FROM action_confirmations WHERE bot_id=? AND status='pending'")
      .all(botId) as { id: string }[];
    for (const row of pending) this.expire(row.id);
    this.db.prepare("DELETE FROM action_confirmations WHERE bot_id=?").run(botId);
  }
}
