import { createHash } from "node:crypto";
import { Conflict, NotFound } from "../../shared/errors.js";
import type { ManagedBotRecord } from "../../shared/harness.js";
import type {
  AutomationOverview,
  AutomationRequest,
  AutomationRequester,
  AutomationResult,
  AutomationTask,
  PendingSkill,
  SkillContent,
  SkillDiff,
} from "../../shared/automation.js";
import type { NativeTask } from "../../shared/tasks.js";
import { httpError } from "../http-error.js";
import type { Revision } from "../store-memory.js";
import type { Store } from "../store.js";

/** Maps a SQLite revision ID to the 8-hex pending ID expected by `/automation/skills/pending/:pendingId`. */
export function pendingShortId(revisionId: string): string {
  return createHash("sha256").update(revisionId).digest("hex").slice(0, 8);
}

/** Optimistic concurrency digest for a pending learning revision. */
export function pendingRevisionDigest(rev: Revision): string {
  return createHash("sha256")
    .update(JSON.stringify([rev.id, rev.version, rev.status, rev.next]))
    .digest("hex");
}

function summarizePending(rev: Revision): string {
  const verb =
    rev.action === "create"
      ? "Add"
      : rev.action === "update"
        ? "Update"
        : rev.action === "retire"
          ? "Retire"
          : rev.action === "restore"
            ? "Restore"
            : "Change";
  const noun = rev.target === "skill" ? "skill" : "memory";
  return `${verb} ${noun}: ${rev.name}`;
}

function formatRevisionDiff(rev: Revision): string {
  const lines: string[] = [
    `--- ${rev.target}/${rev.name} (before)`,
    `+++ ${rev.target}/${rev.name} (proposed)`,
    `@@ ${rev.action} · ${rev.reason} @@`,
  ];
  if (rev.target === "skill") {
    if (rev.previous?.title !== undefined && rev.previous.title !== rev.next.title)
      lines.push(`- Title: ${rev.previous.title}`);
    if (rev.next.title !== undefined && rev.previous?.title !== rev.next.title)
      lines.push(`+ Title: ${rev.next.title}`);
    if (
      rev.previous?.description !== undefined &&
      rev.previous.description !== rev.next.description
    )
      lines.push(`- Description: ${rev.previous.description}`);
    if (rev.next.description !== undefined && rev.previous?.description !== rev.next.description)
      lines.push(`+ Description: ${rev.next.description}`);
  }
  if (rev.previous?.text) {
    for (const line of rev.previous.text.split(/\r?\n/)) lines.push(`- ${line}`);
  }
  if (rev.next.status !== "retired" && rev.next.text) {
    for (const line of rev.next.text.split(/\r?\n/)) lines.push(`+ ${line}`);
  } else if (rev.next.status === "retired") {
    lines.push("+ [retired]");
  }
  return lines.join("\n");
}

function mapTask(task: NativeTask): AutomationTask {
  return {
    id: task.id,
    title: task.title,
    body: task.notes,
    status: task.status,
    priority: 0,
    assignee: task.botId,
    owner: task.createdBy,
    dependencies: [],
    ...(task.status === "needs_input" && task.summary ? { blockedReason: task.summary } : {}),
  };
}

/**
 * Native implementation of `Runtime.automationRequest` backed by SQLite `store.memory`
 * (learned skills, pending proposals, approval policy) and `store.tasks`.
 */
export function createNativeAutomationHandler({
  store,
  requireBot,
}: {
  store: Store;
  requireBot: (id: string) => ManagedBotRecord;
}): AutomationRequester {
  function findPending(botId: string, shortId: string): Revision {
    const match = store.memory.listPending(botId).find((rev) => pendingShortId(rev.id) === shortId);
    if (!match) throw new NotFound("That pending learning change no longer exists.");
    return match;
  }

  return (async <R extends AutomationRequest>(
    input: R,
  ): Promise<AutomationResult<R["operation"]>> => {
    const bot = requireBot(input.profile);
    switch (input.operation) {
      case "overview": {
        const settings = store.memory.settings(bot.id);
        const installed = store.memory.listSkills(bot.id, "active").map((skill) => ({
          name: skill.slug,
          description: skill.description,
        }));
        const pending: PendingSkill[] = store.memory.listPending(bot.id).map((rev) => ({
          id: pendingShortId(rev.id),
          summary: summarizePending(rev),
          origin: rev.actor,
          revision: pendingRevisionDigest(rev),
        }));
        const tasks = store.tasks.listForBots([bot.id], { limit: 100 }).map(mapTask);
        const overview: AutomationOverview = {
          botId: bot.id,
          owner: "WildBots",
          goals: {
            supported: false,
            reason: "Use Tasks to track multi-step work for this assistant.",
            goal: null,
          },
          tasks: {
            supported: true,
            items: tasks,
            limit: 100,
          },
          triggers: {
            supported: false,
            reason: "Scheduled work is configured under Routines.",
            items: [],
            platformEnabled: false,
          },
          skills: {
            supported: true,
            installed,
            pending,
            approvalRequired: !settings.autoApply,
            lockSupported: false,
          },
        };
        return overview as AutomationResult<R["operation"]>;
      }

      case "skill_content": {
        const skill = store.memory.skill(bot.id, input.name);
        if (!skill || skill.status !== "active")
          throw new NotFound(`Skill "${input.name}" was not found.`);
        const result: SkillContent = {
          name: skill.slug,
          content: `# ${skill.title}\n\n${skill.bodyMarkdown}`,
          truncated: false,
        };
        return result as AutomationResult<R["operation"]>;
      }

      case "skill_diff": {
        const rev = findPending(bot.id, input.pendingId);
        const result: SkillDiff = {
          id: input.pendingId,
          diff: formatRevisionDiff(rev),
          revision: pendingRevisionDigest(rev),
          truncated: false,
        };
        return result as AutomationResult<R["operation"]>;
      }

      case "skill_decide": {
        const rev = findPending(bot.id, input.pendingId);
        if (pendingRevisionDigest(rev) !== input.revision)
          throw new Conflict(
            "This pending change updated before your decision. Refresh and review it again.",
          );
        if (input.decision === "approve") store.memory.approve(bot.id, rev.id, "human");
        else store.memory.rejectProposal(bot.id, rev.id, "human");
        return { ok: true } as AutomationResult<R["operation"]>;
      }

      case "skill_policy": {
        store.memory.updateSettings(bot.id, { autoApply: !input.approvalRequired });
        return { ok: true } as AutomationResult<R["operation"]>;
      }

      case "task_get": {
        const task = store.tasks.get(input.taskId);
        if (!task || task.botId !== bot.id) throw new NotFound("Task not found.");
        return mapTask(task) as AutomationResult<R["operation"]>;
      }

      case "task_create": {
        const created = store.tasks.create({
          botId: bot.id,
          title: input.task.title,
          notes: input.task.body,
          createdBy: "human",
        });
        return mapTask(created) as AutomationResult<R["operation"]>;
      }

      case "task_update": {
        const updated = store.tasks.update(
          input.taskId,
          {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { notes: input.body } : {}),
          },
          { id: "human", allowComplete: true, expectedBotId: bot.id },
        );
        return mapTask(updated) as AutomationResult<R["operation"]>;
      }

      case "task_action": {
        const status =
          input.action === "block"
            ? "needs_input"
            : input.action === "request_review"
              ? "ready_for_review"
              : "working";
        const updated = store.tasks.update(
          input.taskId,
          {
            status,
            ...(input.reason ? { summary: input.reason } : {}),
          },
          { id: "human", allowComplete: true, expectedBotId: bot.id },
        );
        return mapTask(updated) as AutomationResult<R["operation"]>;
      }

      case "approval_settings":
        throw httpError(
          409,
          "Command approval allowlists are not used by native WildBots harnesses.",
          { code: "approval_settings_unsupported" },
        );

      case "skill_lock":
      case "approval_mode":
      case "approval_allowlist_remove":
      case "goal_set":
      case "goal_pause":
      case "goal_clear":
      case "goal_resume":
      case "task_dependency":
      case "trigger_create":
      case "trigger_update":
      case "trigger_toggle":
      case "trigger_delete":
        throw new Conflict("This automation control is not used by native WildBots assistants.");
    }
  }) as AutomationRequester;
}
