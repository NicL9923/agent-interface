import { z } from "zod";

/**
 * A bot's server-owned memory and skills, as the review screens see them. Every change is a revision: an applied
 * one is history that can be undone, a pending one is a proposal waiting for someone to approve or reject it.
 * See docs/RuntimePlan.md, "Memory and skills".
 */
export type MemoryKind = "memory" | "user";
/** `pending_review` is an item that has never been approved: its only content is a pending proposal. */
export type LearningItemStatus = "active" | "pending_review" | "retired";
export type RevisionStatus = "pending" | "applied" | "rejected";
export type RevisionAction = "create" | "update" | "retire" | "restore" | "import" | "undo";

export interface WireMemoryEntry {
  id: string;
  kind: MemoryKind;
  key: string;
  content: string;
  sourceTaskId: string | null;
  status: LearningItemStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface WireSkill {
  id: string;
  slug: string;
  title: string;
  description: string;
  bodyMarkdown: string;
  status: LearningItemStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
/** One change to a memory entry or a skill, with the state before and after it, so the screen shows a diff. */
export interface WireRevision {
  id: string;
  target: "memory" | "skill";
  /** The memory entry or skill it changes. */
  itemId: string;
  /** The entry's key or the skill's slug. */
  name: string;
  /** The item's version once this revision applies. */
  version: number;
  action: RevisionAction;
  status: RevisionStatus;
  previous: RevisionState | null;
  next: RevisionState;
  reason: string;
  sourceTaskId: string | null;
  /** `learning`, `pruning`, `bot`, `hermes-import`, or `user:<id>`. */
  actor: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** The revision this one reverses. */
  undoes: string | null;
  /** The revision that reversed this one. */
  undoneBy: string | null;
}
export interface RevisionState {
  status: LearningItemStatus;
  /** A memory entry's content or a skill's Markdown body. */
  text: string;
  /** Skills only. */
  title?: string;
  description?: string;
}
export interface WireLearningSettings {
  /** Whether learning and cleaning apply at once (true) or wait for approval (false). */
  autoApply: boolean;
  /** For personal bots: whether active `user` facts are shared across the owner's other personal bots. */
  sharePersonalMemory?: boolean;
  memoryCharBudget: number;
  skillCountBudget: number;
  lastPrunedAt: string | null;
}
export interface MemoryOverview {
  settings: WireLearningSettings;
  /** Every entry and skill that was ever approved or is proposed, retired ones included, so they can be restored. */
  entries: WireMemoryEntry[];
  skills: WireSkill[];
  /** Proposals waiting for review, oldest first. */
  pending: WireRevision[];
}
export interface MemoryRevisionList {
  /** Newest first. */
  revisions: WireRevision[];
}
export interface MemoryDecision {
  revision: WireRevision;
}

export const learningSettingsBody = z
  .object({ autoApply: z.boolean(), sharePersonalMemory: z.boolean().optional() })
  .strict();
export type LearningSettingsUpdate = z.input<typeof learningSettingsBody>;
