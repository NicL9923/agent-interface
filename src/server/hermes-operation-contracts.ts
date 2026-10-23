import { z } from 'zod';
import type { ExperienceOperation, ExperienceResult } from '../shared/experience.js';
import type { AutomationOperation, AutomationResult } from '../shared/automation.js';
import type { FileRef, Message } from '../shared/types.js';
import { withMessageOrigins, wireOrigin } from '../shared/message-origin.js';
import { exposedText, toolDetails } from './hermes-mapping.js';
import { httpError } from './http-error.js';

const text = z.string();
const number = z.number();
const flag = z.boolean();
const role = z.enum(['user', 'assistant', 'tool', 'system']);
const memory = z.object({
  botId: text, profile: text, scope: z.literal('profile'), owner: z.literal('Hermes'), notice: text,
  documents: z.array(z.object({ target: z.enum(['memory', 'user']), label: text, revision: text, enabled: flag,
    entries: z.array(z.object({ id: text, text })), charLimit: number, charCount: number })),
  refresh: z.object({ revision: text, state: z.enum(['next_turn', 'pending', 'applied']), busy: flag, message: text }).optional(),
});
const receipt = z.object({ requestId: text, routineId: text, botId: text,
  status: z.enum(['accepted', 'completed', 'failed', 'uncertain']), message: text.optional(), startedAt: text,
  finishedAt: text.optional(), executionId: text.optional(), ownerStatus: text.optional() });
const message = z.object({ id: text, role, text });
// These fields are native display hints and tool payloads. Their existing mappers
// validate what they consume; no raw metadata is returned to callers.
const historyRow = z.object({
  id: z.union([text, number]), role, text: text.optional(), createdAt: text.optional(),
  reasoning: text.nullish(), toolName: text.nullish(), app_sender_id: text.optional(),
  app_display_text: text.optional(), app_tool_result: z.unknown().optional(),
  name: text.nullish(), args: z.unknown().optional(), tool_call_id: z.union([text, number]).nullish(),
  display_metadata: z.unknown().optional(), display_kind: z.unknown().optional(),
  app_artifacts: z.unknown().optional(), app_attachments: z.unknown().optional(),
});
const priorPrompt = z.object({ text: text.optional(), app_sender_id: text.optional(),
  display_metadata: z.unknown().optional(), display_kind: z.unknown().optional() });
export type HermesHistoryRow = z.infer<typeof historyRow>;
type Artifacts = (profile: string, row: HermesHistoryRow) => FileRef[];

function experienceSchemas(profile: string, artifacts: Artifacts): { [O in ExperienceOperation]: z.ZodType<ExperienceResult<O>> } {
  return {
    search: z.array(z.object({ botId: text, botName: text, sessionId: text, title: text, snippet: text,
      messageId: text.optional(), offset: number.optional(), routineId: text.optional(), resultId: text.optional(), updatedAt: text.optional() })),
    history: z.object({ botId: text, sessionId: text, messages: z.array(historyRow), offset: number, hasMore: flag,
      targetMessageId: text.optional(), app_prior_prompt: priorPrompt.optional() }).transform(value => {
      const seed = value.app_prior_prompt;
      const origin = seed ? wireOrigin({ id: 'prior', role: 'user', text: seed.text ?? '' }, seed) : undefined;
      const messages = value.messages.map((row): Message => {
        const result: Message & { app_sender_id?: string } = {
          id: String(row.id), role: row.role, text: exposedText(row.app_tool_result) ?? row.app_display_text ?? row.text ?? '',
          createdAt: row.createdAt, reasoning: row.reasoning ?? undefined, toolName: row.toolName ?? undefined,
          files: artifacts(profile, row),
          ...(typeof row.app_sender_id === 'string' ? { app_sender_id: row.app_sender_id } : {}),
          ...(row.role === 'tool' ? { toolCall: toolDetails({ name: row.name, args: row.args, result: row.app_tool_result ?? row.text }, String(row.tool_call_id ?? row.id), 'completed') } : {}),
        };
        const own = wireOrigin(result, row);
        return own ? { ...result, origin: own } : result;
      });
      return { botId: value.botId, sessionId: value.sessionId, offset: value.offset, hasMore: value.hasMore,
        ...(value.targetMessageId ? { targetMessageId: value.targetMessageId } : {}),
        messages: withMessageOrigins(messages, origin?.kind === 'human' ? undefined : origin) };
    }),
    usage: z.object({ botId: text, days: number, sessions: number, inputTokens: number, outputTokens: number,
      actualCost: number.nullable(), estimatedCost: number.nullable(), partial: flag, notice: text }),
    // Python emits null when native result metadata is absent. Normalize that to
    // the app's optional fields rather than rejecting legitimate saved runs.
    routine_results: z.array(z.object({ id: text, title: text, startedAt: text.nullish(), preview: text.nullish(), previewOnly: flag })
      .transform(row => ({ ...row, startedAt: row.startedAt ?? undefined, preview: row.preview ?? undefined }))),
    routine_output: z.object({ messages: z.array(message), previewOnly: flag }),
    memory, save_memory: memory, delete_memory: memory,
    preview: z.object({ botId: text, schedule: text, timezone: text, nextRuns: z.array(text), kind: z.enum(['once', 'interval', 'cron']) }),
    run: receipt, run_receipt: receipt,
  };
}
const support = { supported: flag, reason: text.optional() };
const task = z.object({ id: text, title: text, body: text, status: text, priority: number, assignee: text.nullable(), owner: text,
  dependencies: z.array(text), blockedReason: text.optional() });
const subscription = z.object({ id: text, description: text, events: z.array(text), routineId: text, enabled: flag,
  url: text, secretSet: flag, revision: text });
const overview = z.object({ botId: text, owner: z.literal('Hermes'),
  goals: z.object({ ...support, goal: z.object({ title: text, status: text, turnsUsed: number, maxTurns: number, pausedReason: text.optional() }).nullable(),
    interruptionPending: flag.optional(), resume: z.object({ requestId: text, status: z.enum(['accepted', 'rejected', 'uncertain']), runId: text.optional(), message: text.optional() }).optional() }),
  tasks: z.object({ ...support, items: z.array(task), truncated: flag.optional(), limit: number.optional() }),
  triggers: z.object({ ...support, items: z.array(subscription), platformEnabled: flag }),
  skills: z.object({ ...support, installed: z.array(z.object({ name: text, description: text })),
    pending: z.array(z.object({ id: text, summary: text, origin: text, revision: text })), approvalRequired: flag }),
});
const ok = z.object({ ok: z.literal(true) });
const automationSchemas: { [O in AutomationOperation]: z.ZodType<AutomationResult<O>> } = {
  overview, goal_set: overview, goal_pause: overview, goal_clear: overview, goal_resume: overview,
  task_create: task, task_get: task, task_update: task, task_action: task, task_dependency: task,
  trigger_create: z.object({ subscription, secret: text }),
  trigger_update: z.object({ subscription }), trigger_toggle: z.object({ subscription }), trigger_delete: ok,
  skill_content: z.object({ name: text, content: text, truncated: flag }),
  skill_diff: z.object({ id: text, diff: text, revision: text, truncated: flag }), skill_decide: ok, skill_policy: ok,
};
function decode<T>(schema: z.ZodType<T>, value: unknown, family: string, operation: string): T {
  const result = schema.safeParse(value);
  // Do not include native payloads or Zod values in errors: these can contain
  // private history, pending skill contents, or newly minted trigger secrets.
  if (!result.success) throw httpError(502, `Hermes returned an invalid ${family} response for ${operation}.`);
  return result.data;
}
export function decodeExperience<O extends ExperienceOperation>(operation: O, value: unknown, profile: string, artifacts: Artifacts): ExperienceResult<O> {
  return decode(experienceSchemas(profile, artifacts)[operation], value, 'experience', operation);
}
export function decodeAutomation<O extends AutomationOperation>(operation: O, value: unknown): AutomationResult<O> {
  return decode(automationSchemas[operation], value, 'automation', operation);
}

/** JSON syntax failures must not echo native content or secrets through parser errors. */
export async function readOperationJson(response: Response, family: 'experience' | 'automation', operation: string): Promise<unknown> {
  try { return await response.json(); }
  catch { throw httpError(502, `Hermes returned an invalid ${family} response for ${operation}.`); }
}
