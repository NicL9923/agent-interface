import { createHash, randomUUID } from "node:crypto";
import { Conflict, InvalidInput, NotFound } from "../shared/errors.js";
import type {
  LearningItemStatus,
  MemoryKind,
  RevisionAction,
  RevisionState,
  RevisionStatus,
} from "../shared/memory.js";
import type { StoreDatabase } from "./store-database.js";

export interface MemoryEntry {
  id: string;
  botId: string;
  kind: MemoryKind;
  key: string;
  content: string;
  sourceTaskId: string | null;
  status: LearningItemStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}
export interface Skill {
  id: string;
  botId: string;
  slug: string;
  title: string;
  description: string;
  bodyMarkdown: string;
  status: LearningItemStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}
export interface Revision {
  id: string;
  target: "memory" | "skill";
  itemId: string;
  botId: string;
  /** The entry's key or the skill's slug. */
  name: string;
  version: number;
  action: RevisionAction;
  status: RevisionStatus;
  previous: RevisionState | null;
  next: RevisionState;
  reason: string;
  sourceTaskId: string | null;
  actor: string;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  undoes: string | null;
  undoneBy: string | null;
}
export interface LearningSettings {
  botId: string;
  autoApply: boolean;
  memoryCharBudget: number;
  skillCountBudget: number;
  lastPrunedAt: number | null;
}

/** Who proposed a change. Every origin goes through the same checks, and the bot's auto-apply setting decides. */
export type ProposalOrigin = "learning" | "pruning" | "bot";
export type ProposalMeta = { origin: ProposalOrigin; reason: string; sourceTaskId?: string | null };
export type MemoryOp =
  | { op: "add"; kind: MemoryKind; key: string; content: string }
  | { op: "update"; key: string; content: string }
  | { op: "retire"; key: string };
export type SkillOp =
  | { op: "create"; slug: string; title: string; description: string; body: string }
  | { op: "update"; slug: string; title?: string; description?: string; body?: string }
  | { op: "retire"; slug: string };
export type ProposalOutcome =
  | { status: "applied" | "pending"; revision: Revision }
  | { status: "rejected"; reason: string };

export const MEMORY_LIMITS = {
  keyChars: 80,
  entryChars: 2_000,
  slugChars: 64,
  skillTitleChars: 120,
  skillDescriptionChars: 500,
  skillBodyChars: 20_000,
  reasonChars: 500,
} as const;
export const DEFAULT_LEARNING_SETTINGS = {
  autoApply: false,
  memoryCharBudget: 12_000,
  skillCountBudget: 40,
} as const;
const KEY = /^[a-z0-9][a-z0-9._-]*$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Learned text reaches every later session's prompt, so it must read as data. Each pattern names text that only
// makes sense as an attempt to steer the model, or that must never be remembered at all.
const GUARDS: [RegExp, string][] = [
  [
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|system|developer)\b[^.\n]{0,30}\b(instructions?|rules|prompts?|guidelines|messages)\b/i,
    "tries to override earlier instructions",
  ],
  [/<\/?\s*(system|assistant|developer|user|tool|instructions?)\b[^>]*>/i, "contains a role tag"],
  [/^\s*(system|assistant|developer)\s*:/im, "contains a role marker"],
  [/<\|[a-z_]+\|>|\[\/?INST\]|<<\/?SYS>>/i, "contains model control tokens"],
  [/\b(you are now|new (system )?instructions?\s*:)/i, "rewrites the assistant's role"],
  // eslint-disable-next-line no-control-regex
  [/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/, "contains control characters"],
  [/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/, "contains hidden characters"],
  [
    /\b(api[_ -]?key|password|passcode|secret|access[_ -]?token|bearer)\b\s*[:=]\s*\S{6,}/i,
    "looks like a secret, which belongs in the vault",
  ],
];
/** Why text may not be learned, or undefined when it may. */
export function screenText(text: string): string | undefined {
  for (const [pattern, reason] of GUARDS) if (pattern.test(text)) return reason;
  return undefined;
}

type EntryRow = Omit<MemoryEntry, "status" | "kind"> & { kind: string; status: string };
type SkillRow = Omit<Skill, "status"> & { status: string };
type RevisionRow = {
  id: string;
  item_id: string;
  bot_id: string;
  name: string;
  version: number;
  action: RevisionAction;
  status: RevisionStatus;
  previous_text: string | null;
  next_text: string;
  previous_title?: string | null;
  next_title?: string;
  previous_description?: string | null;
  next_description?: string;
  previous_status: LearningItemStatus | null;
  next_status: LearningItemStatus;
  reason: string;
  source_task_id: string | null;
  actor: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  undoes: string | null;
  undone_by: string | null;
};
const entryColumns =
  "id,bot_id AS botId,kind,key,content,source_task_id AS sourceTaskId,status,version,created_at AS createdAt,updated_at AS updatedAt";
const skillColumns =
  "id,bot_id AS botId,slug,title,description,body_markdown AS bodyMarkdown,status,version,created_at AS createdAt,updated_at AS updatedAt";
const revisionCommon =
  "id,bot_id,version,action,status,previous_status,next_status,reason,source_task_id,actor,created_at,decided_at,decided_by,undoes,undone_by";
const memoryRevisionColumns = `${revisionCommon},entry_id AS item_id,key AS name,previous_content AS previous_text,next_content AS next_text`;
const skillRevisionColumns = `${revisionCommon},skill_id AS item_id,slug AS name,previous_body AS previous_text,next_body AS next_text,previous_title,next_title,previous_description,next_description`;

const entryFromRow = (row: EntryRow): MemoryEntry => ({
  id: row.id,
  botId: row.botId,
  kind: row.kind as MemoryKind,
  key: row.key,
  content: row.content,
  sourceTaskId: row.sourceTaskId,
  status: row.status as LearningItemStatus,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const skillFromRow = (row: SkillRow): Skill => ({
  id: row.id,
  botId: row.botId,
  slug: row.slug,
  title: row.title,
  description: row.description,
  bodyMarkdown: row.bodyMarkdown,
  status: row.status as LearningItemStatus,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
function revisionFromRow(row: RevisionRow, target: Revision["target"]): Revision {
  const skillFields = (title?: string | null, description?: string | null) =>
    target === "skill" ? { title: title ?? "", description: description ?? "" } : {};
  return {
    id: row.id,
    target,
    itemId: row.item_id,
    botId: row.bot_id,
    name: row.name,
    version: row.version,
    action: row.action,
    status: row.status,
    previous:
      row.previous_status === null
        ? null
        : {
            status: row.previous_status,
            text: row.previous_text ?? "",
            ...skillFields(row.previous_title, row.previous_description),
          },
    next: {
      status: row.next_status,
      text: row.next_text,
      ...skillFields(row.next_title, row.next_description),
    },
    reason: row.reason,
    sourceTaskId: row.source_task_id,
    actor: row.actor,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    undoes: row.undoes,
    undoneBy: row.undone_by,
  };
}
const targetOf = (revisionId: string): Revision["target"] | undefined =>
  revisionId.startsWith("mrev_") ? "memory" : revisionId.startsWith("srev_") ? "skill" : undefined;
const missingRevision = () => new NotFound("That change no longer exists.");

/** Stable 64-hex identifier for a memory entry, matching the `/bots/:id/memory` wire contract. */
export function memoryEntryDigest(entryId: string): string {
  return createHash("sha256").update(entryId).digest("hex");
}

function humanEntryKey(kind: MemoryKind, content: string, taken: Set<string>): string {
  const prefix = kind === "user" ? "user" : "note";
  const slug = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  const base = slug ? `${prefix}.${slug}` : `${prefix}.entry`;
  if (!taken.has(base) && base.length <= MEMORY_LIMITS.keyChars) return base;
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = randomUUID().slice(0, 8);
    const candidate = `${base.slice(0, MEMORY_LIMITS.keyChars - suffix.length - 1)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}.${randomUUID().replace(/-/g, "")}`;
}

/** The text a model sees for one entry: continuation lines indented so an entry stays one list item. */
const entryLine = (entry: Pick<MemoryEntry, "key" | "content">) =>
  `- [${entry.key}] ${entry.content.trim().replace(/\r?\n/g, "\n  ")}`;
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

type ImportedEntry = { kind: MemoryKind; key: string; content: string; reason: string };
type ImportedSkill = {
  slug: string;
  title: string;
  description: string;
  body: string;
  reason: string;
};

/**
 * Each bot's memory entries and skills, with every change kept as a revision. Proposals are pending revisions:
 * one applies only while its item is still at the version it was proposed against, so approving an old proposal
 * never overwrites a newer change. Undo reverses the latest applied revision of an item with a new revision.
 */
export class MemorySkillsRepository {
  private last = 0;
  constructor(
    private readonly database: StoreDatabase,
    private readonly clock: () => number = Date.now,
  ) {}
  private get db() {
    return this.database.db;
  }
  /** Strictly increasing, so history orders the same way it happened even within one millisecond. */
  private now() {
    this.last = Math.max(this.clock(), this.last + 1);
    return this.last;
  }

  // Settings

  settings(botId: string): LearningSettings {
    const row = this.db
      .prepare(
        "SELECT auto_apply AS autoApply,memory_char_budget AS memoryCharBudget,skill_count_budget AS skillCountBudget,last_pruned_at AS lastPrunedAt FROM bot_learning_settings WHERE bot_id=?",
      )
      .get(botId) as
      | {
          autoApply: number;
          memoryCharBudget: number;
          skillCountBudget: number;
          lastPrunedAt: number | null;
        }
      | undefined;
    if (!row) return { botId, ...DEFAULT_LEARNING_SETTINGS, lastPrunedAt: null };
    return {
      botId,
      autoApply: row.autoApply === 1,
      memoryCharBudget: row.memoryCharBudget,
      skillCountBudget: row.skillCountBudget,
      lastPrunedAt: row.lastPrunedAt,
    };
  }
  updateSettings(
    botId: string,
    changes: Partial<
      Pick<LearningSettings, "autoApply" | "memoryCharBudget" | "skillCountBudget" | "lastPrunedAt">
    >,
  ): LearningSettings {
    for (const budget of [changes.memoryCharBudget, changes.skillCountBudget])
      if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1))
        throw new RangeError("Learning budgets are positive whole numbers.");
    const next = { ...this.settings(botId), ...changes };
    this.db
      .prepare(
        `INSERT INTO bot_learning_settings(bot_id,auto_apply,memory_char_budget,skill_count_budget,last_pruned_at) VALUES(?,?,?,?,?)
        ON CONFLICT(bot_id) DO UPDATE SET auto_apply=excluded.auto_apply,memory_char_budget=excluded.memory_char_budget,
        skill_count_budget=excluded.skill_count_budget,last_pruned_at=excluded.last_pruned_at`,
      )
      .run(
        botId,
        +next.autoApply,
        next.memoryCharBudget,
        next.skillCountBudget,
        next.lastPrunedAt ?? null,
      );
    return next;
  }

  // Reads

  listEntries(botId: string, status?: LearningItemStatus): MemoryEntry[] {
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT ${entryColumns} FROM bot_memory_entries WHERE bot_id=? AND status=? ORDER BY kind DESC,updated_at DESC,key`,
            )
            .all(botId, status)
        : this.db
            .prepare(
              `SELECT ${entryColumns} FROM bot_memory_entries WHERE bot_id=? ORDER BY kind DESC,updated_at DESC,key`,
            )
            .all(botId)
    ) as EntryRow[];
    return rows.map(entryFromRow);
  }
  entry(botId: string, key: string): MemoryEntry | undefined {
    const row = this.db
      .prepare(`SELECT ${entryColumns} FROM bot_memory_entries WHERE bot_id=? AND key=?`)
      .get(botId, key) as EntryRow | undefined;
    return row && entryFromRow(row);
  }
  private entryById(id: string): MemoryEntry | undefined {
    const row = this.db
      .prepare(`SELECT ${entryColumns} FROM bot_memory_entries WHERE id=?`)
      .get(id) as EntryRow | undefined;
    return row && entryFromRow(row);
  }
  listSkills(botId: string, status?: LearningItemStatus): Skill[] {
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT ${skillColumns} FROM bot_skills WHERE bot_id=? AND status=? ORDER BY slug`,
            )
            .all(botId, status)
        : this.db
            .prepare(`SELECT ${skillColumns} FROM bot_skills WHERE bot_id=? ORDER BY slug`)
            .all(botId)
    ) as SkillRow[];
    return rows.map(skillFromRow);
  }
  skill(botId: string, slug: string): Skill | undefined {
    const row = this.db
      .prepare(`SELECT ${skillColumns} FROM bot_skills WHERE bot_id=? AND slug=?`)
      .get(botId, slug) as SkillRow | undefined;
    return row && skillFromRow(row);
  }
  private skillById(id: string): Skill | undefined {
    const row = this.db.prepare(`SELECT ${skillColumns} FROM bot_skills WHERE id=?`).get(id) as
      | SkillRow
      | undefined;
    return row && skillFromRow(row);
  }
  /** Memory and skill revisions for one bot, newest first. */
  listRevisions(botId: string, { limit = 200 }: { limit?: number } = {}): Revision[] {
    const memory = (
      this.db
        .prepare(
          `SELECT ${memoryRevisionColumns} FROM bot_memory_revisions WHERE bot_id=? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(botId, limit) as RevisionRow[]
    ).map((row) => revisionFromRow(row, "memory"));
    const skills = (
      this.db
        .prepare(
          `SELECT ${skillRevisionColumns} FROM bot_skill_revisions WHERE bot_id=? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(botId, limit) as RevisionRow[]
    ).map((row) => revisionFromRow(row, "skill"));
    return [...memory, ...skills].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  /** Proposals waiting for review, oldest first. */
  listPending(botId: string): Revision[] {
    const memory = (
      this.db
        .prepare(
          `SELECT ${memoryRevisionColumns} FROM bot_memory_revisions WHERE bot_id=? AND status='pending' ORDER BY created_at`,
        )
        .all(botId) as RevisionRow[]
    ).map((row) => revisionFromRow(row, "memory"));
    const skills = (
      this.db
        .prepare(
          `SELECT ${skillRevisionColumns} FROM bot_skill_revisions WHERE bot_id=? AND status='pending' ORDER BY created_at`,
        )
        .all(botId) as RevisionRow[]
    ).map((row) => revisionFromRow(row, "skill"));
    return [...memory, ...skills].sort((a, b) => a.createdAt - b.createdAt);
  }
  /** One of this bot's revisions. Another bot's revision is missing, exactly as a made-up ID is. */
  revision(botId: string, revisionId: string): Revision | undefined {
    const target = targetOf(revisionId);
    if (!target) return undefined;
    const row = this.revisionRow(target, botId, revisionId);
    return row && revisionFromRow(row, target);
  }
  private revisionRow(target: Revision["target"], botId: string, revisionId: string) {
    return (
      target === "memory"
        ? this.db
            .prepare(
              `SELECT ${memoryRevisionColumns} FROM bot_memory_revisions WHERE id=? AND bot_id=?`,
            )
            .get(revisionId, botId)
        : this.db
            .prepare(
              `SELECT ${skillRevisionColumns} FROM bot_skill_revisions WHERE id=? AND bot_id=?`,
            )
            .get(revisionId, botId)
    ) as RevisionRow | undefined;
  }
  /** Active entries that mention the query's words, best match first. */
  searchMemory(botId: string, query: string, limit = 10): MemoryEntry[] {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
    if (!terms.length) return [];
    return this.listEntries(botId, "active")
      .map((entry) => {
        const text = `${entry.key} ${entry.content}`.toLowerCase();
        return { entry, score: terms.filter((term) => text.includes(term)).length };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }
  private activeMemoryChars(botId: string) {
    return (
      (
        this.db
          .prepare(
            "SELECT sum(length(content)) AS chars FROM bot_memory_entries WHERE bot_id=? AND status='active'",
          )
          .get(botId) as { chars: number | null }
      ).chars ?? 0
    );
  }
  private activeSkillCount(botId: string) {
    return (
      this.db
        .prepare("SELECT count(*) AS count FROM bot_skills WHERE bot_id=? AND status='active'")
        .get(botId) as { count: number }
    ).count;
  }

  // Rendering for prompts

  /**
   * Active memory as Markdown for a session's prompt, facts about the people first, newest first within each
   * part, cut to the bot's memory budget. A cut says how many entries were left out.
   */
  renderMemoryMarkdown(botId: string): string {
    const budget = this.settings(botId).memoryCharBudget;
    const entries = this.listEntries(botId, "active");
    const parts: [string, MemoryEntry[]][] = [
      ["## About the people", entries.filter((entry) => entry.kind === "user")],
      ["## Notes", entries.filter((entry) => entry.kind === "memory")],
    ];
    // Leave room for the note that says entries were left out.
    const room = Math.max(0, budget - 80);
    const lines: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const [heading, group] of parts) {
      if (!group.length) continue;
      let headed = false;
      for (const entry of group) {
        const line = entryLine(entry);
        const cost = line.length + 1 + (headed ? 0 : heading.length + 2);
        if (omitted || used + cost > room) {
          omitted++;
          continue;
        }
        if (!headed) {
          lines.push(lines.length ? `\n${heading}` : heading);
          headed = true;
        }
        lines.push(line);
        used += cost;
      }
    }
    if (!entries.length) return "_No memory yet._";
    if (omitted)
      lines.push(
        `\n_${omitted} more ${omitted === 1 ? "entry" : "entries"} not shown. Use memory_search to find them._`,
      );
    return lines.join("\n");
  }
  /** Active skills as a one-line-each index, cut to the bot's skill budget. */
  renderSkillIndex(botId: string): string {
    const budget = this.settings(botId).skillCountBudget;
    const skills = this.listSkills(botId, "active");
    if (!skills.length) return "_No skills yet._";
    const lines = skills
      .slice(0, budget)
      .map(
        (skill) =>
          `- ${skill.slug}: ${oneLine(skill.title, MEMORY_LIMITS.skillTitleChars)}. ${oneLine(skill.description, 200)}`,
      );
    if (skills.length > budget)
      lines.push(`_${skills.length - budget} more not shown. Use skill_list to see them all._`);
    return lines.join("\n");
  }

  /** Whether a personal bot shares its active `user` memory facts with its owner's other personal bots. Defaults to true. */
  sharedPersonalMemoryEnabled(botId: string): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM bot_shared_memory_prefs WHERE bot_id=?")
      .get(botId) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true;
  }

  setSharedPersonalMemoryEnabled(botId: string, enabled: boolean): boolean {
    this.db
      .prepare(
        "INSERT INTO bot_shared_memory_prefs(bot_id,enabled) VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET enabled=excluded.enabled",
      )
      .run(botId, enabled ? 1 : 0);
    return enabled;
  }

  /**
   * Renders active personal facts (`kind = 'user'`) from an owner's other personal bots that have
   * personal memory sharing enabled, excluding keys this bot already defines itself. Never reads
   * shared household bots or another owner's bots.
   */
  renderSharedOwnerMemoryMarkdown(
    ownerId: string,
    targetBotId: string,
    sourceBotIds: readonly string[],
    charBudget = 4_000,
  ): string {
    if (!ownerId || !sourceBotIds.length) return "";
    const eligible = sourceBotIds.filter(
      (id) => id !== targetBotId && this.sharedPersonalMemoryEnabled(id),
    );
    if (!eligible.length) return "";
    const ownKeys = new Set(this.listEntries(targetBotId, "active").map((entry) => entry.key));
    const seenKeys = new Set<string>(ownKeys);
    const lines: string[] = [];
    let used = 0;
    for (const botId of eligible) {
      for (const entry of this.listEntries(botId, "active")) {
        if (entry.kind !== "user" || seenKeys.has(entry.key)) continue;
        seenKeys.add(entry.key);
        const line = entryLine(entry);
        if (used + line.length + 1 > charBudget) return lines.join("\n");
        lines.push(line);
        used += line.length + 1;
      }
    }
    return lines.join("\n");
  }

  // Proposals

  /** Checks a memory change and records it, applied at once or pending by the bot's setting. */
  proposeMemoryEdit(botId: string, op: MemoryOp, meta: ProposalMeta): ProposalOutcome {
    const refused = checkMeta(meta) ?? checkMemoryOp(op);
    if (refused) return { status: "rejected", reason: refused };
    return this.database.transaction(() => {
      const settings = this.settings(botId);
      const now = this.now();
      let entry = this.entry(botId, op.key);
      let action: RevisionAction;
      let next: { content: string; status: LearningItemStatus };
      if (op.op === "add") {
        if (entry && entry.status !== "retired")
          return rejected(
            entry.status === "active"
              ? `Memory "${op.key}" already exists; update it instead.`
              : `Memory "${op.key}" is already proposed.`,
          );
        if (entry && entry.kind !== op.kind)
          return rejected(`Memory "${op.key}" was a ${entry.kind} entry; use another key.`);
        action = entry ? "restore" : "create";
        next = { content: op.content, status: "active" };
      } else {
        if (entry?.status !== "active") return rejected(`No active memory "${op.key}".`);
        if (op.op === "update") {
          if (entry.content === op.content)
            return rejected(`Memory "${op.key}" already says that.`);
          action = "update";
          next = { content: op.content, status: "active" };
        } else {
          action = "retire";
          next = { content: entry.content, status: "retired" };
        }
      }
      const before = entry?.status === "active" ? entry.content.length : 0;
      const after = next.status === "active" ? next.content.length : 0;
      const total = this.activeMemoryChars(botId) - before + after;
      if (after > before && total > settings.memoryCharBudget)
        return rejected(
          `That would put memory over its ${settings.memoryCharBudget}-character budget; consolidate first.`,
        );
      if (!entry) {
        entry = {
          id: `mem_${randomUUID()}`,
          botId,
          kind: (op as Extract<MemoryOp, { op: "add" }>).kind,
          key: op.key,
          content: next.content,
          sourceTaskId: meta.sourceTaskId ?? null,
          status: "pending_review",
          version: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare(
            "INSERT INTO bot_memory_entries(id,bot_id,kind,key,content,source_task_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            entry.id,
            botId,
            entry.kind,
            entry.key,
            entry.content,
            entry.sourceTaskId,
            entry.status,
            0,
            now,
            now,
          );
      }
      const id = `mrev_${randomUUID()}`;
      this.insertMemoryRevision({
        id,
        entry,
        action,
        status: "pending",
        previous: entry.version === 0 ? null : { content: entry.content, status: entry.status },
        next,
        reason: meta.reason,
        sourceTaskId: meta.sourceTaskId ?? null,
        actor: meta.origin,
        now,
      });
      if (settings.autoApply) this.applyMemory(this.revisionRow("memory", botId, id)!, meta.origin);
      return {
        status: settings.autoApply ? "applied" : "pending",
        revision: this.revision(botId, id)!,
      };
    });
  }

  /** Checks a skill change and records it, applied at once or pending by the bot's setting. */
  proposeSkillEdit(botId: string, op: SkillOp, meta: ProposalMeta): ProposalOutcome {
    const refused = checkMeta(meta) ?? checkSkillOp(op);
    if (refused) return { status: "rejected", reason: refused };
    return this.database.transaction(() => {
      const settings = this.settings(botId);
      const now = this.now();
      let skill = this.skill(botId, op.slug);
      let action: RevisionAction;
      let next: { title: string; description: string; body: string; status: LearningItemStatus };
      if (op.op === "create") {
        if (skill && skill.status !== "retired")
          return rejected(
            skill.status === "active"
              ? `Skill "${op.slug}" already exists; update it instead.`
              : `Skill "${op.slug}" is already proposed.`,
          );
        if (this.activeSkillCount(botId) >= settings.skillCountBudget)
          return rejected(
            `This bot already has ${settings.skillCountBudget} skills, its budget; merge or retire one first.`,
          );
        action = skill ? "restore" : "create";
        next = { title: op.title, description: op.description, body: op.body, status: "active" };
      } else {
        if (skill?.status !== "active") return rejected(`No active skill "${op.slug}".`);
        if (op.op === "update") {
          next = {
            title: op.title ?? skill.title,
            description: op.description ?? skill.description,
            body: op.body ?? skill.bodyMarkdown,
            status: "active",
          };
          if (
            next.title === skill.title &&
            next.description === skill.description &&
            next.body === skill.bodyMarkdown
          )
            return rejected(`Skill "${op.slug}" already says that.`);
          action = "update";
        } else {
          action = "retire";
          next = {
            title: skill.title,
            description: skill.description,
            body: skill.bodyMarkdown,
            status: "retired",
          };
        }
      }
      if (!skill) {
        skill = {
          id: `skl_${randomUUID()}`,
          botId,
          slug: op.slug,
          title: next.title,
          description: next.description,
          bodyMarkdown: next.body,
          status: "pending_review",
          version: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.insertSkill(skill);
      }
      const id = `srev_${randomUUID()}`;
      this.insertSkillRevision({
        id,
        skill,
        action,
        status: "pending",
        previous:
          skill.version === 0
            ? null
            : {
                title: skill.title,
                description: skill.description,
                body: skill.bodyMarkdown,
                status: skill.status,
              },
        next,
        reason: meta.reason,
        sourceTaskId: meta.sourceTaskId ?? null,
        actor: meta.origin,
        now,
      });
      if (settings.autoApply) this.applySkill(this.revisionRow("skill", botId, id)!, meta.origin);
      return {
        status: settings.autoApply ? "applied" : "pending",
        revision: this.revision(botId, id)!,
      };
    });
  }

  /** Applies a pending memory proposal. Refused once its entry changed after it was proposed. */
  approveProposal(botId: string, revisionId: string, actor: string): Revision {
    return this.decide("memory", botId, revisionId, actor, "applied");
  }
  /** Applies a pending skill proposal. Refused once its skill changed after it was proposed. */
  approveSkillProposal(botId: string, revisionId: string, actor: string): Revision {
    return this.decide("skill", botId, revisionId, actor, "applied");
  }
  /** Approves a memory or skill proposal, by its ID. */
  approve(botId: string, revisionId: string, actor: string): Revision {
    const target = targetOf(revisionId);
    if (!target) throw missingRevision();
    return this.decide(target, botId, revisionId, actor, "applied");
  }
  /** Rejects a memory or skill proposal. A never-approved item with no other proposal goes with it. */
  rejectProposal(botId: string, revisionId: string, actor: string): Revision {
    const target = targetOf(revisionId);
    if (!target) throw missingRevision();
    return this.decide(target, botId, revisionId, actor, "rejected");
  }
  private decide(
    target: Revision["target"],
    botId: string,
    revisionId: string,
    actor: string,
    decision: "applied" | "rejected",
  ): Revision {
    if (targetOf(revisionId) !== target) throw missingRevision();
    return this.database.transaction(() => {
      const row = this.revisionRow(target, botId, revisionId);
      if (!row) throw missingRevision();
      if (row.status !== "pending") throw new Conflict(`That change was already ${row.status}.`);
      if (decision === "applied") {
        if (target === "memory") this.applyMemory(row, actor);
        else this.applySkill(row, actor);
      } else {
        const now = this.now();
        const table = target === "memory" ? "bot_memory_revisions" : "bot_skill_revisions";
        const items = target === "memory" ? "bot_memory_entries" : "bot_skills";
        const itemColumn = target === "memory" ? "entry_id" : "skill_id";
        this.db
          .prepare(`UPDATE ${table} SET status='rejected',decided_at=?,decided_by=? WHERE id=?`)
          .run(now, actor, row.id);
        this.db
          .prepare(
            `DELETE FROM ${items} WHERE id=? AND status='pending_review' AND NOT EXISTS(SELECT 1 FROM ${table} WHERE ${itemColumn}=? AND status='pending')`,
          )
          .run(row.item_id, row.item_id);
      }
      return revisionFromRow(this.revisionRow(target, botId, revisionId)!, target);
    });
  }
  private assertMemoryBudget(
    botId: string,
    beforeStatus: LearningItemStatus,
    beforeLength: number,
    afterStatus: LearningItemStatus,
    afterLength: number,
  ) {
    const before = beforeStatus === "active" ? beforeLength : 0;
    const after = afterStatus === "active" ? afterLength : 0;
    const settings = this.settings(botId);
    const total = this.activeMemoryChars(botId) - before + after;
    if (after > before && total > settings.memoryCharBudget)
      throw new Conflict(
        `That would put memory over its ${settings.memoryCharBudget}-character budget; consolidate first.`,
      );
  }
  private assertSkillBudget(
    botId: string,
    beforeStatus: LearningItemStatus,
    afterStatus: LearningItemStatus,
  ) {
    const settings = this.settings(botId);
    if (
      beforeStatus !== "active" &&
      afterStatus === "active" &&
      this.activeSkillCount(botId) >= settings.skillCountBudget
    )
      throw new Conflict(
        `This bot already has ${settings.skillCountBudget} skills, its budget; merge or retire one first.`,
      );
  }
  private applyMemory(row: RevisionRow, actor: string) {
    const entry = this.entryById(row.item_id);
    if (!entry || entry.version !== row.version - 1)
      throw new Conflict("This memory changed after the proposal was made. Review it again.");
    this.assertMemoryBudget(
      entry.botId,
      entry.status,
      entry.content.length,
      row.next_status,
      row.next_text.length,
    );
    const now = this.now();
    this.db
      .prepare(
        "UPDATE bot_memory_entries SET content=?,status=?,version=?,source_task_id=COALESCE(?,source_task_id),updated_at=? WHERE id=?",
      )
      .run(row.next_text, row.next_status, row.version, row.source_task_id, now, entry.id);
    this.db
      .prepare(
        "UPDATE bot_memory_revisions SET status='applied',decided_at=?,decided_by=? WHERE id=?",
      )
      .run(now, actor, row.id);
  }
  private applySkill(row: RevisionRow, actor: string) {
    const skill = this.skillById(row.item_id);
    if (!skill || skill.version !== row.version - 1)
      throw new Conflict("This skill changed after the proposal was made. Review it again.");
    this.assertSkillBudget(skill.botId, skill.status, row.next_status);
    const now = this.now();
    this.db
      .prepare(
        "UPDATE bot_skills SET title=?,description=?,body_markdown=?,status=?,version=?,updated_at=? WHERE id=?",
      )
      .run(
        row.next_title!,
        row.next_description!,
        row.next_text,
        row.next_status,
        row.version,
        now,
        skill.id,
      );
    this.db
      .prepare(
        "UPDATE bot_skill_revisions SET status='applied',decided_at=?,decided_by=? WHERE id=?",
      )
      .run(now, actor, row.id);
  }

  /** Stable 64-hex optimistic-concurrency revision for all active entries of one kind. */
  documentRevision(botId: string, kind: MemoryKind): string {
    const entries = this.listEntries(botId, "active").filter((entry) => entry.kind === kind);
    const payload = entries.map((entry) => [entry.id, entry.version, entry.content]);
    return createHash("sha256")
      .update(JSON.stringify([kind, payload]))
      .digest("hex");
  }

  /**
   * Direct human edit of one memory document (`memory` or `user`), checked against `expectedRevision`,
   * prompt-injection guards, and the bot's memory character budget. Every add/edit/retire records an
   * applied revision so history and undo stay accurate.
   */
  replaceEntriesByKind(
    botId: string,
    kind: MemoryKind,
    incoming: readonly { id?: string; text: string }[],
    expectedRevision: string,
    actor = "human",
  ): { changed: boolean; revision: string } {
    return this.database.transaction(() => {
      if (this.documentRevision(botId, kind) !== expectedRevision)
        throw new Conflict("Memory changed since you loaded it. Reload and try again.");
      const normalized = incoming.map((item) => {
        const text = item.text.trim();
        const refused = checkText("Memory", text, MEMORY_LIMITS.entryChars);
        if (refused) throw new InvalidInput(refused);
        return { id: item.id, text };
      });
      const existing = this.listEntries(botId, "active").filter((entry) => entry.kind === kind);
      const byDigest = new Map<string, MemoryEntry>();
      for (const entry of existing) {
        byDigest.set(memoryEntryDigest(entry.id), entry);
        byDigest.set(entry.id, entry);
      }
      const prevKindChars = existing.reduce((sum, entry) => sum + entry.content.length, 0);
      const otherKindChars = this.activeMemoryChars(botId) - prevKindChars;
      const nextKindChars = normalized.reduce((sum, item) => sum + item.text.length, 0);
      const settings = this.settings(botId);
      if (
        nextKindChars > prevKindChars &&
        otherKindChars + nextKindChars > settings.memoryCharBudget
      )
        throw new InvalidInput(
          `That would put memory over its ${settings.memoryCharBudget}-character budget. Shorten or remove an entry first.`,
        );

      const seenExistingIds = new Set<string>();
      const updates: { entry: MemoryEntry; text: string }[] = [];
      const additions: string[] = [];
      for (const item of normalized) {
        const match = item.id ? byDigest.get(item.id) : undefined;
        if (match && !seenExistingIds.has(match.id)) {
          seenExistingIds.add(match.id);
          if (match.content !== item.text) updates.push({ entry: match, text: item.text });
        } else {
          additions.push(item.text);
        }
      }
      const retirements = existing.filter((entry) => !seenExistingIds.has(entry.id));
      let changed = false;

      for (const entry of retirements) {
        const now = this.now();
        this.insertMemoryRevision({
          id: `mrev_${randomUUID()}`,
          entry,
          action: "retire",
          status: "applied",
          previous: { content: entry.content, status: entry.status },
          next: { content: entry.content, status: "retired" },
          reason: "Removed in memory settings.",
          sourceTaskId: null,
          actor,
          now,
          decidedBy: actor,
        });
        this.db
          .prepare(
            "UPDATE bot_memory_entries SET status='retired',version=?,updated_at=? WHERE id=?",
          )
          .run(entry.version + 1, now, entry.id);
        changed = true;
      }

      for (const { entry, text } of updates) {
        const now = this.now();
        this.insertMemoryRevision({
          id: `mrev_${randomUUID()}`,
          entry,
          action: "update",
          status: "applied",
          previous: { content: entry.content, status: entry.status },
          next: { content: text, status: "active" },
          reason: "Edited in memory settings.",
          sourceTaskId: null,
          actor,
          now,
          decidedBy: actor,
        });
        this.db
          .prepare("UPDATE bot_memory_entries SET content=?,version=?,updated_at=? WHERE id=?")
          .run(text, entry.version + 1, now, entry.id);
        changed = true;
      }

      if (additions.length) {
        const takenKeys = new Set(this.listEntries(botId).map((entry) => entry.key));
        for (const content of additions) {
          const now = this.now();
          const key = humanEntryKey(kind, content, takenKeys);
          takenKeys.add(key);
          const entry: MemoryEntry = {
            id: `mem_${randomUUID()}`,
            botId,
            kind,
            key,
            content,
            sourceTaskId: null,
            status: "active",
            version: 0,
            createdAt: now,
            updatedAt: now,
          };
          this.db
            .prepare(
              "INSERT INTO bot_memory_entries(id,bot_id,kind,key,content,source_task_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'active',1,?,?)",
            )
            .run(entry.id, botId, kind, key, content, now, now);
          this.insertMemoryRevision({
            id: `mrev_${randomUUID()}`,
            entry,
            action: "create",
            status: "applied",
            previous: null,
            next: { content, status: "active" },
            reason: "Added in memory settings.",
            sourceTaskId: null,
            actor,
            now,
            decidedBy: actor,
          });
          changed = true;
        }
      }

      return { changed, revision: this.documentRevision(botId, kind) };
    });
  }

  /** Direct human deletion (retirement) of one active entry by its digest or raw ID. */
  retireEntryByDigest(
    botId: string,
    kind: MemoryKind,
    entryId: string,
    expectedRevision: string,
    actor = "human",
  ): { revision: string } {
    return this.database.transaction(() => {
      if (this.documentRevision(botId, kind) !== expectedRevision)
        throw new Conflict("Memory changed since you loaded it. Reload and try again.");
      const existing = this.listEntries(botId, "active").find(
        (entry) =>
          entry.kind === kind && (entry.id === entryId || memoryEntryDigest(entry.id) === entryId),
      );
      if (!existing) throw new NotFound("That memory entry no longer exists.");
      const now = this.now();
      this.insertMemoryRevision({
        id: `mrev_${randomUUID()}`,
        entry: existing,
        action: "retire",
        status: "applied",
        previous: { content: existing.content, status: existing.status },
        next: { content: existing.content, status: "retired" },
        reason: "Deleted in memory settings.",
        sourceTaskId: null,
        actor,
        now,
        decidedBy: actor,
      });
      this.db
        .prepare("UPDATE bot_memory_entries SET status='retired',version=?,updated_at=? WHERE id=?")
        .run(existing.version + 1, now, existing.id);
      return { revision: this.documentRevision(botId, kind) };
    });
  }

  // Undo

  /** Reverses an applied memory revision, which must be its entry's latest, with a new revision. */
  undoMemoryRevision(botId: string, revisionId: string, actor: string): Revision {
    if (targetOf(revisionId) !== "memory") throw missingRevision();
    return this.database.transaction(() => {
      const row = this.undoable("memory", botId, revisionId);
      const entry = this.entryById(row.item_id)!;
      const now = this.now();
      const id = `mrev_${randomUUID()}`;
      const nextState =
        row.previous_status === null
          ? { content: entry.content, status: "retired" as const }
          : { content: row.previous_text ?? "", status: row.previous_status };
      this.assertMemoryBudget(
        botId,
        entry.status,
        entry.content.length,
        nextState.status,
        nextState.content.length,
      );
      this.insertMemoryRevision({
        id,
        entry,
        action: "undo",
        status: "applied",
        previous: { content: entry.content, status: entry.status },
        // An entry's first revision has no earlier state, so undoing it retires the entry.
        next: nextState,
        reason: `Undid: ${oneLine(row.reason, 200)}`,
        sourceTaskId: null,
        actor,
        now,
        decidedBy: actor,
        undoes: row.id,
      });
      this.markUndone("memory", row.id, id);
      const next = this.revisionRow("memory", botId, id)!;
      this.db
        .prepare(
          "UPDATE bot_memory_entries SET content=?,status=?,version=?,updated_at=? WHERE id=?",
        )
        .run(next.next_text, next.next_status, next.version, now, entry.id);
      return revisionFromRow(next, "memory");
    });
  }
  /** Reverses an applied skill revision, which must be its skill's latest, with a new revision. */
  undoSkillRevision(botId: string, revisionId: string, actor: string): Revision {
    if (targetOf(revisionId) !== "skill") throw missingRevision();
    return this.database.transaction(() => {
      const row = this.undoable("skill", botId, revisionId);
      const skill = this.skillById(row.item_id)!;
      const now = this.now();
      const id = `srev_${randomUUID()}`;
      const current = {
        title: skill.title,
        description: skill.description,
        body: skill.bodyMarkdown,
        status: skill.status,
      };
      const nextState =
        row.previous_status === null
          ? { ...current, status: "retired" as const }
          : {
              title: row.previous_title ?? "",
              description: row.previous_description ?? "",
              body: row.previous_text ?? "",
              status: row.previous_status,
            };
      this.assertSkillBudget(botId, skill.status, nextState.status);
      this.insertSkillRevision({
        id,
        skill,
        action: "undo",
        status: "applied",
        previous: current,
        next: nextState,
        reason: `Undid: ${oneLine(row.reason, 200)}`,
        sourceTaskId: null,
        actor,
        now,
        decidedBy: actor,
        undoes: row.id,
      });
      this.markUndone("skill", row.id, id);
      const next = this.revisionRow("skill", botId, id)!;
      this.db
        .prepare(
          "UPDATE bot_skills SET title=?,description=?,body_markdown=?,status=?,version=?,updated_at=? WHERE id=?",
        )
        .run(
          next.next_title!,
          next.next_description!,
          next.next_text,
          next.next_status,
          next.version,
          now,
          skill.id,
        );
      return revisionFromRow(next, "skill");
    });
  }
  /** Undoes a memory or skill revision, by its ID. */
  undo(botId: string, revisionId: string, actor: string): Revision {
    return targetOf(revisionId) === "skill"
      ? this.undoSkillRevision(botId, revisionId, actor)
      : this.undoMemoryRevision(botId, revisionId, actor);
  }
  private undoable(target: Revision["target"], botId: string, revisionId: string) {
    const row = this.revisionRow(target, botId, revisionId);
    if (!row) throw missingRevision();
    if (row.status !== "applied") throw new Conflict("Only an applied change can be undone.");
    if (row.undone_by) throw new Conflict("That change was already undone.");
    const item = target === "memory" ? this.entryById(row.item_id) : this.skillById(row.item_id);
    if (!item || item.version !== row.version)
      throw new Conflict("A later change came after this one. Undo that first.");
    return row;
  }
  private markUndone(target: Revision["target"], revisionId: string, undoneBy: string) {
    const table = target === "memory" ? "bot_memory_revisions" : "bot_skill_revisions";
    this.db.prepare(`UPDATE ${table} SET undone_by=? WHERE id=?`).run(undoneBy, revisionId);
  }

  // Import

  /**
   * Writes imported entries and skills as each item's first revision, in one transaction. Keys and slugs the bot
   * already has are skipped and reported, so importing twice never duplicates or overwrites anything.
   */
  importItems(
    botId: string,
    { entries, skills }: { entries: ImportedEntry[]; skills: ImportedSkill[] },
  ): { imported: string[]; skipped: string[] } {
    return this.database.transaction(() => {
      const imported: string[] = [];
      const skipped: string[] = [];
      for (const item of entries) {
        if (this.entry(botId, item.key)) {
          skipped.push(item.key);
          continue;
        }
        const now = this.now();
        const entry: MemoryEntry = {
          id: `mem_${randomUUID()}`,
          botId,
          kind: item.kind,
          key: item.key,
          content: item.content,
          sourceTaskId: null,
          status: "active",
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare(
            "INSERT INTO bot_memory_entries(id,bot_id,kind,key,content,source_task_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'active',1,?,?)",
          )
          .run(entry.id, botId, entry.kind, entry.key, entry.content, now, now);
        this.insertMemoryRevision({
          id: `mrev_${randomUUID()}`,
          entry: { ...entry, version: 0 },
          action: "import",
          status: "applied",
          previous: null,
          next: { content: item.content, status: "active" },
          reason: item.reason,
          sourceTaskId: null,
          actor: "hermes-import",
          now,
          decidedBy: "hermes-import",
        });
        imported.push(item.key);
      }
      for (const item of skills) {
        if (this.skill(botId, item.slug)) {
          skipped.push(`skills/${item.slug}`);
          continue;
        }
        const now = this.now();
        const skill: Skill = {
          id: `skl_${randomUUID()}`,
          botId,
          slug: item.slug,
          title: item.title,
          description: item.description,
          bodyMarkdown: item.body,
          status: "active",
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.insertSkill(skill);
        this.insertSkillRevision({
          id: `srev_${randomUUID()}`,
          skill: { ...skill, version: 0 },
          action: "import",
          status: "applied",
          previous: null,
          next: { ...item, status: "active" },
          reason: item.reason,
          sourceTaskId: null,
          actor: "hermes-import",
          now,
          decidedBy: "hermes-import",
        });
        imported.push(`skills/${item.slug}`);
      }
      return { imported, skipped };
    });
  }

  /** Removes everything this bot learned, its history and its settings, as when the bot is deleted. */
  forgetBot(botId: string) {
    const forget = () => {
      for (const table of [
        "bot_memory_revisions",
        "bot_memory_entries",
        "bot_skill_revisions",
        "bot_skills",
        "bot_learning_settings",
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE bot_id=?`).run(botId);
    };
    // Transactions do not nest, and the store's forgetBot runs this inside its own.
    if (this.db.isTransaction) forget();
    else this.database.transaction(forget);
  }

  // Writes

  private insertSkill(skill: Skill) {
    this.db
      .prepare(
        "INSERT INTO bot_skills(id,bot_id,slug,title,description,body_markdown,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        skill.id,
        skill.botId,
        skill.slug,
        skill.title,
        skill.description,
        skill.bodyMarkdown,
        skill.status,
        skill.version,
        skill.createdAt,
        skill.updatedAt,
      );
  }
  private insertMemoryRevision(revision: {
    id: string;
    entry: MemoryEntry;
    action: RevisionAction;
    status: RevisionStatus;
    previous: { content: string; status: LearningItemStatus } | null;
    next: { content: string; status: LearningItemStatus };
    reason: string;
    sourceTaskId: string | null;
    actor: string;
    now: number;
    decidedBy?: string;
    undoes?: string;
  }) {
    const decided = revision.status === "pending" ? null : revision.now;
    this.db
      .prepare(
        `INSERT INTO bot_memory_revisions(id,entry_id,bot_id,key,version,action,status,previous_content,next_content,previous_status,next_status,
        reason,source_task_id,actor,created_at,decided_at,decided_by,undoes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        revision.id,
        revision.entry.id,
        revision.entry.botId,
        revision.entry.key,
        revision.entry.version + 1,
        revision.action,
        revision.status,
        revision.previous?.content ?? null,
        revision.next.content,
        revision.previous?.status ?? null,
        revision.next.status,
        revision.reason,
        revision.sourceTaskId,
        revision.actor,
        revision.now,
        decided,
        revision.decidedBy ?? null,
        revision.undoes ?? null,
      );
  }
  private insertSkillRevision(revision: {
    id: string;
    skill: Skill;
    action: RevisionAction;
    status: RevisionStatus;
    previous: {
      title: string;
      description: string;
      body: string;
      status: LearningItemStatus;
    } | null;
    next: { title: string; description: string; body: string; status: LearningItemStatus };
    reason: string;
    sourceTaskId: string | null;
    actor: string;
    now: number;
    decidedBy?: string;
    undoes?: string;
  }) {
    const decided = revision.status === "pending" ? null : revision.now;
    this.db
      .prepare(
        `INSERT INTO bot_skill_revisions(id,skill_id,bot_id,slug,version,action,status,previous_body,next_body,previous_title,next_title,
        previous_description,next_description,previous_status,next_status,reason,source_task_id,actor,created_at,decided_at,decided_by,undoes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        revision.id,
        revision.skill.id,
        revision.skill.botId,
        revision.skill.slug,
        revision.skill.version + 1,
        revision.action,
        revision.status,
        revision.previous?.body ?? null,
        revision.next.body,
        revision.previous?.title ?? null,
        revision.next.title,
        revision.previous?.description ?? null,
        revision.next.description,
        revision.previous?.status ?? null,
        revision.next.status,
        revision.reason,
        revision.sourceTaskId,
        revision.actor,
        revision.now,
        decided,
        revision.decidedBy ?? null,
        revision.undoes ?? null,
      );
  }
}

const rejected = (reason: string): ProposalOutcome => ({ status: "rejected", reason });

function checkText(label: string, text: string, max: number): string | undefined {
  if (!text.trim()) return `${label} is empty.`;
  if (text.length > max) return `${label} is longer than ${max} characters.`;
  const unsafe = screenText(text);
  return unsafe && `${label} ${unsafe}.`;
}
function checkMeta(meta: ProposalMeta): string | undefined {
  return checkText("The reason", meta.reason, MEMORY_LIMITS.reasonChars);
}
function checkMemoryOp(op: MemoryOp): string | undefined {
  if (op.key.length > MEMORY_LIMITS.keyChars || !KEY.test(op.key))
    return `Memory keys are lowercase letters, numbers, dots, dashes and underscores, up to ${MEMORY_LIMITS.keyChars} characters.`;
  if (op.op === "retire") return undefined;
  return checkText("Memory", op.content, MEMORY_LIMITS.entryChars);
}
function checkSkillOp(op: SkillOp): string | undefined {
  if (op.slug.length > MEMORY_LIMITS.slugChars || !SLUG.test(op.slug))
    return `Skill names are lowercase letters, numbers and dashes, up to ${MEMORY_LIMITS.slugChars} characters.`;
  if (op.op === "retire") return undefined;
  const fields: [string, string | undefined, number][] = [
    ["The skill title", op.title, MEMORY_LIMITS.skillTitleChars],
    ["The skill description", op.description, MEMORY_LIMITS.skillDescriptionChars],
    ["The skill", op.body, MEMORY_LIMITS.skillBodyChars],
  ];
  if (op.op === "update" && fields.every(([, value]) => value === undefined))
    return "A skill update changes its title, description or body.";
  for (const [label, value, max] of fields) {
    if (value === undefined) continue;
    const refused = checkText(label, value, max);
    if (refused) return refused;
  }
  return undefined;
}
