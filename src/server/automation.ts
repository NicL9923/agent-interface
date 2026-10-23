import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '../shared/types.js';
import type { AutomationRequest } from '../shared/automation.js';
import { signedIn } from './auth.js';
import { notFound, visibleBots } from './bot-access.js';
import { httpError } from './http-error.js';
import type { Store } from './store.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const taskFields = { title: z.string().trim().min(1).max(500), body: z.string().max(20000), priority: z.number().int().min(-100).max(100), assignee: id.nullable() };
const triggerFields = { description: z.string().max(1000), events: z.array(z.string().regex(/^[A-Za-z0-9_.*:-]{1,100}$/)).min(1).max(20), routineId: id };
type OperationInput<T = AutomationRequest> = T extends AutomationRequest ? Omit<T, 'profile' | 'visibleProfiles'> : never;

export async function installAutomationRoutes(app: FastifyInstance, runtime: Runtime, store: Store, maintenance = () => false, canManage: (req: import('fastify').FastifyRequest) => boolean = () => false) {
  const request = async (req: import('fastify').FastifyRequest, input: OperationInput) => {
    const profile = z.object({ id }).parse(req.params).id;
    const bots = await visibleBots(runtime, store, signedIn(req).id);
    if (!bots.some(bot => bot.id === profile)) throw httpError(404, notFound.error, { code: notFound.code });
    if (input.operation.startsWith('trigger_') && !canManage(req)) throw httpError(403, 'Only an integration administrator can change event triggers and view a new signing secret.');
    if (input.operation === 'skill_policy' && !canManage(req)) throw httpError(403, 'Only an integration administrator can change learned skill approval policy.');
    if (!runtime.automationRequest) throw httpError(409, 'Update and qualify the Hermes integration to use goals, tasks, event triggers and learned skill review.');
    if (input.operation !== 'overview' && !['task_get', 'skill_content', 'skill_diff'].includes(input.operation) && maintenance()) throw httpError(409, 'Hermes is being upgraded. Automation changes are paused.');
    const row = input as Record<string, unknown>;
    const task = row.task as { assignee?: string } | undefined;
    for (const candidate of [row.assignee, row.reviewer, task?.assignee]) if (typeof candidate === 'string' && !bots.some(bot => bot.id === candidate)) throw httpError(404, notFound.error);
    const result = await runtime.automationRequest({ ...input, profile, visibleProfiles: bots.map(bot => bot.id) } as AutomationRequest);
    return 'goals' in result ? { ...result, canManageTriggers: canManage(req), canManageLearningPolicy: canManage(req) } : result;
  };
  const base = '/api/bots/:id/automation';
  app.get(base, async (req, reply) => { reply.header('Cache-Control', 'no-store'); return request(req, { operation: 'overview' }); });
  app.put(base + '/goal', async req => request(req, { operation: 'goal_set', ...z.object({ title: z.string().trim().min(1).max(10000), maxTurns: z.number().int().min(1).max(1000) }).strict().parse(req.body) }));
  app.post(base + '/goal/:action', async req => {
    const { action } = z.object({ action: z.enum(['pause', 'resume', 'clear']) }).parse(req.params);
    if (action === 'resume') return request(req, { operation: 'goal_resume', ...z.object({ requestId: z.string().uuid(), reviewedInterruption: z.boolean().optional() }).strict().parse(req.body), senderId: signedIn(req).id });
    z.object({}).strict().parse(req.body ?? {});
    return request(req, { operation: `goal_${action}` });
  });
  app.post(base + '/tasks', async req => request(req, { operation: 'task_create', task: z.object({ ...taskFields, body: taskFields.body.optional(), priority: taskFields.priority.optional(), assignee: id.nullable().optional(), dependencies: z.array(id).max(20).optional(), requestId: z.string().uuid() }).strict().parse(req.body) }));
  app.get(base + '/tasks/:taskId', async req => request(req, { operation: 'task_get', taskId: z.object({ taskId: id }).parse(req.params).taskId }));
  app.patch(base + '/tasks/:taskId', async req => request(req, { operation: 'task_update', taskId: z.object({ taskId: id }).parse(req.params).taskId, ...z.object(taskFields).partial().strict().refine(value => Object.keys(value).length > 0, 'Enter a task change').parse(req.body) }));
  app.post(base + '/tasks/:taskId/actions', async req => request(req, { operation: 'task_action', taskId: z.object({ taskId: id }).parse(req.params).taskId, ...z.object({ action: z.enum(['start', 'block', 'unblock', 'request_review']), reason: z.string().trim().min(1).max(2000).optional(), reviewer: id.optional() }).strict().parse(req.body) }));
  app.put(base + '/tasks/:taskId/dependencies/:dependencyId', async req => request(req, { operation: 'task_dependency', ...z.object({ taskId: id, dependencyId: id }).parse(req.params), ...z.object({ remove: z.boolean() }).strict().parse(req.body) }));
  app.post(base + '/triggers', async (req, reply) => { reply.header('Cache-Control', 'no-store'); return request(req, { operation: 'trigger_create', trigger: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), ...triggerFields }).strict().parse(req.body) }); });
  app.put(base + '/triggers/:triggerId', async req => {
    const triggerId = z.object({ triggerId: id }).parse(req.params).triggerId;
    const { revision: expectedRevision, ...fields } = z.object({ ...triggerFields, revision }).strict().parse(req.body);
    return request(req, { operation: 'trigger_update', trigger: { id: triggerId, ...fields }, revision: expectedRevision });
  });
  app.patch(base + '/triggers/:triggerId', async req => request(req, { operation: 'trigger_toggle', triggerId: z.object({ triggerId: id }).parse(req.params).triggerId, ...z.object({ enabled: z.boolean(), revision }).strict().parse(req.body) }));
  app.delete(base + '/triggers/:triggerId', async req => request(req, { operation: 'trigger_delete', triggerId: z.object({ triggerId: id }).parse(req.params).triggerId, ...z.object({ revision }).strict().parse(req.body) }));
  app.get(base + '/skills/content', async req => request(req, { operation: 'skill_content', ...z.object({ name: z.string().regex(/^[A-Za-z0-9_./-]{1,200}$/).refine(name => !name.split('/').some(part => part === '..' || !part)) }).strict().parse(req.query) }));
  app.get(base + '/skills/pending/:pendingId', async req => request(req, { operation: 'skill_diff', pendingId: z.object({ pendingId: z.string().regex(/^[a-f0-9]{8}$/) }).parse(req.params).pendingId }));
  app.post(base + '/skills/pending/:pendingId', async req => request(req, { operation: 'skill_decide', pendingId: z.object({ pendingId: z.string().regex(/^[a-f0-9]{8}$/) }).parse(req.params).pendingId, ...z.object({ revision, decision: z.enum(['approve', 'reject']) }).strict().parse(req.body) }));
  app.put(base + '/skills/policy', async req => request(req, { operation: 'skill_policy', ...z.object({ approvalRequired: z.boolean() }).strict().parse(req.body) }));
}
