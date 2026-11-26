import { randomUUID } from "node:crypto";
import { Conflict, InvalidInput, NotFound } from "../shared/errors.js";
import {
  BOT_TASK_STATUSES,
  TASK_STATUSES,
  type BotTaskStatus,
  type NativeTask,
  type TaskStatus,
} from "../shared/tasks.js";
import type { StoreDatabase } from "./store-database.js";

type TaskRow = {
  id: string;
  bot_id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  summary: string | null;
  source_message_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  completed_by: string | null;
};

function toTask(row: TaskRow): NativeTask {
  return {
    id: row.id,
    botId: row.bot_id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    summary: row.summary,
    sourceMessageId: row.source_message_id,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    completedBy: row.completed_by,
  };
}

export class TaskRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() {
    return this.database.db;
  }

  get(id: string): NativeTask | undefined {
    const row = this.db.prepare("SELECT * FROM native_tasks WHERE id=?").get(id) as
      | TaskRow
      | undefined;
    return row ? toTask(row) : undefined;
  }

  listForBots(
    botIds: readonly string[],
    options: { status?: TaskStatus | "open"; limit?: number } = {},
  ): NativeTask[] {
    if (!botIds.length) return [];
    const placeholders = botIds.map(() => "?").join(",");
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    const params: (string | number)[] = [...botIds];
    let filter = "";
    if (options.status === "open") {
      filter = " AND status<>'done'";
    } else if (options.status) {
      filter = " AND status=?";
      params.push(options.status);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM native_tasks
         WHERE bot_id IN (${placeholders})${filter}
         ORDER BY
           CASE status
             WHEN 'ready_for_review' THEN 0
             WHEN 'needs_input' THEN 1
             WHEN 'working' THEN 2
             ELSE 3
           END,
           updated_at DESC,
           id ASC
         LIMIT ?`,
      )
      .all(...params) as TaskRow[];
    return rows.map(toTask);
  }

  create(input: {
    botId: string;
    title: string;
    notes?: string;
    status?: BotTaskStatus;
    sourceMessageId?: string | null;
    createdBy: string;
    now?: number;
  }): NativeTask {
    const title = input.title.trim();
    if (!title || title.length > 200)
      throw new InvalidInput("Task title must be between 1 and 200 characters.");
    const notes = (input.notes ?? "").trim();
    if (notes.length > 10_000) throw new InvalidInput("Task notes are too long.");
    const status = input.status ?? "working";
    if (!BOT_TASK_STATUSES.includes(status))
      throw new InvalidInput("New tasks must start as working, needs_input, or ready_for_review.");
    const id = randomUUID();
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO native_tasks(
          id,bot_id,title,notes,status,summary,source_message_id,created_by,created_at,updated_at,completed_at,completed_by
        ) VALUES(?,?,?,?,?,NULL,?,?,?,?,NULL,NULL)`,
      )
      .run(
        id,
        input.botId,
        title,
        notes,
        status,
        input.sourceMessageId ?? null,
        input.createdBy,
        now,
        now,
      );
    return this.get(id)!;
  }

  /**
   * Updates a task. When `allowComplete` is false (bot/MCP callers), transitioning to `done`
   * is refused so only a human member can formally sign off on completed work.
   */
  update(
    id: string,
    patch: {
      title?: string;
      notes?: string;
      status?: TaskStatus;
      summary?: string | null;
      feedback?: string;
    },
    actor: { id: string; allowComplete: boolean; expectedBotId?: string; now?: number },
  ): NativeTask {
    const existing = this.db.prepare("SELECT * FROM native_tasks WHERE id=?").get(id) as
      | TaskRow
      | undefined;
    if (!existing || (actor.expectedBotId && existing.bot_id !== actor.expectedBotId))
      throw new NotFound("Task not found.");
    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    if (!title || title.length > 200)
      throw new InvalidInput("Task title must be between 1 and 200 characters.");
    let notes = patch.notes !== undefined ? patch.notes.trim() : existing.notes;
    if (patch.feedback?.trim()) {
      const note = `Changes requested: ${patch.feedback.trim()}`;
      notes = notes ? `${notes}\n\n${note}` : note;
    }
    if (notes.length > 10_000) throw new InvalidInput("Task notes are too long.");
    const status = patch.status ?? existing.status;
    if (!TASK_STATUSES.includes(status)) throw new InvalidInput("Unsupported task status.");
    if (status === "done" && !actor.allowComplete)
      throw new Conflict(
        "Only a household member can mark a task done. Set status to 'ready_for_review' with a summary instead.",
        "human_signoff_required",
      );
    const summary =
      patch.summary === undefined
        ? existing.summary
        : patch.summary === null
          ? null
          : patch.summary.trim().slice(0, 4_000) || null;
    const now = actor.now ?? Date.now();
    const completedAt = status === "done" ? (existing.completed_at ?? now) : null;
    const completedBy = status === "done" ? (existing.completed_by ?? actor.id) : null;
    this.db
      .prepare(
        `UPDATE native_tasks
         SET title=?,notes=?,status=?,summary=?,updated_at=?,completed_at=?,completed_by=?
         WHERE id=?`,
      )
      .run(title, notes, status, summary, now, completedAt, completedBy, id);
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM native_tasks WHERE id=?").run(id).changes > 0;
  }

  forgetBot(botId: string) {
    this.db.prepare("DELETE FROM native_tasks WHERE bot_id=?").run(botId);
  }
}
