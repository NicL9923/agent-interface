import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '../shared/types.js';
import type { AutomationRequest, AutomationResult } from '../shared/automation.js';
import { signedIn } from './auth.js';
import { notFound, visibleBots } from './bot-access.js';
import { httpError } from './http-error.js';
import { apiRoute } from './api-route.js';
import type { Store } from './store.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const taskFields = { title: z.string().trim().min(1).max(500), body: z.string().max(20000), priority: z.number().int().min(-100).max(100), assignee: id.nullable() };
const triggerFields = { description: z.string().max(1000), events: z.array(z.string().regex(/^[A-Za-z0-9_.*:-]{1,100}$/)).min(1).max(20), routineId: id };
type OperationInput<T = AutomationRequest> = T extends AutomationRequest ? Omit<T, 'profile' | 'visibleProfiles'> : never;

export async function installAutomationRoutes(app: FastifyInstance, runtime: Runtime, store: Store, maintenance = () => false, canManage: (req: FastifyRequest) => boolean = () => false) {
  const request = async <I extends OperationInput>(req: FastifyRequest, input: I): Promise<AutomationResult<I["operation"]>> => {
    const profile = z.object({ id }).parse(req.params).id;
    const bots = await visibleBots(runtime, store, signedIn(req).id);
    if (!bots.some(bot => bot.id === profile)) throw httpError(404, notFound.error, { code: notFound.code });
    if (input.operation.startsWith('trigger_') && !canManage(req)) throw httpError(403, 'Only an integration administrator can change event triggers and view a new signing secret.');
    if (input.operation === 'skill_policy' && !canManage(req)) throw httpError(403, 'Only an integration administrator can change learned skill approval policy.');
    if (!runtime.automationRequest) throw httpError(409, 'Update and qualify the Hermes integration to use goals, tasks, event triggers and learned skill review.');
    if (input.operation !== 'overview' && !['task_get', 'skill_content', 'skill_diff'].includes(input.operation) && maintenance()) throw httpError(409, 'Hermes is being upgraded. Automation changes are paused.');
    const task = 'task' in input ? input.task : undefined;
    for (const candidate of ['assignee' in input ? input.assignee : undefined, 'reviewer' in input ? input.reviewer : undefined, task?.assignee])
      if (typeof candidate === 'string' && !bots.some(bot => bot.id === candidate)) throw httpError(404, notFound.error);
    const result = await runtime.automationRequest<I & AutomationRequest>({ ...input, profile, visibleProfiles: bots.map(bot => bot.id) } as I & AutomationRequest);
    return 'goals' in result ? { ...result, canManageTriggers: canManage(req), canManageLearningPolicy: canManage(req) } : result;
  };
  apiRoute(app, "GET /bots/:id/automation", {}, async (req, _, reply) => { reply.header('Cache-Control', 'no-store'); return request(req, { operation: 'overview' }); });
  apiRoute(app, "PUT /bots/:id/automation/goal", { body: z.object({ title: z.string().trim().min(1).max(10000), maxTurns: z.number().int().min(1).max(1000) }).strict() }, async (req, body) => request(req, { operation: 'goal_set', ...body }));
  for (const action of ['pause', 'clear'] as const) apiRoute(app, `POST /bots/:id/automation/goal/${action}`, { body: z.record(z.string(), z.never()).optional().default({}) }, async req => request(req, { operation: `goal_${action}` }));
  apiRoute(app, "POST /bots/:id/automation/goal/resume", { body: z.object({ requestId: z.string().uuid(), reviewedInterruption: z.boolean().optional() }).strict() }, async (req, body) => request(req, { operation: 'goal_resume', ...body, senderId: signedIn(req).id }));
  apiRoute(app, "POST /bots/:id/automation/tasks", { body: z.object({ ...taskFields, body: taskFields.body.optional(), priority: taskFields.priority.optional(), assignee: id.nullable().optional(), dependencies: z.array(id).max(20).optional(), requestId: z.string().uuid() }).strict() }, async (req, task) => request(req, { operation: 'task_create', task }));
  apiRoute(app, "GET /bots/:id/automation/tasks/:taskId", {}, async req => request(req, { operation: 'task_get', taskId: z.object({ taskId: id }).parse(req.params).taskId }));
  apiRoute(app, "PATCH /bots/:id/automation/tasks/:taskId", { body: z.object(taskFields).partial().strict().refine(value => Object.keys(value).length > 0, 'Enter a task change') }, async (req, body) => request(req, { operation: 'task_update', taskId: z.object({ taskId: id }).parse(req.params).taskId, ...body }));
  apiRoute(app, "POST /bots/:id/automation/tasks/:taskId/actions", { body: z.object({ action: z.enum(['start', 'block', 'unblock', 'request_review']), reason: z.string().trim().min(1).max(2000).optional(), reviewer: id.optional() }).strict() }, async (req, body) => request(req, { operation: 'task_action', taskId: z.object({ taskId: id }).parse(req.params).taskId, ...body }));
  apiRoute(app, "PUT /bots/:id/automation/tasks/:taskId/dependencies/:dependencyId", { body: z.object({ remove: z.boolean() }).strict() }, async (req, body) => request(req, { operation: 'task_dependency', ...z.object({ taskId: id, dependencyId: id }).parse(req.params), ...body }));
  apiRoute(app, "POST /bots/:id/automation/triggers", { body: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), ...triggerFields }).strict() }, async (req, trigger, reply) => { reply.header('Cache-Control', 'no-store'); return request(req, { operation: 'trigger_create', trigger }); });
  apiRoute(app, "PUT /bots/:id/automation/triggers/:triggerId", { body: z.object({ ...triggerFields, revision }).strict() }, async (req, { revision: expectedRevision, ...fields }) => request(req, { operation: 'trigger_update', trigger: { id: z.object({ triggerId: id }).parse(req.params).triggerId, ...fields }, revision: expectedRevision }));
  apiRoute(app, "PATCH /bots/:id/automation/triggers/:triggerId", { body: z.object({ enabled: z.boolean(), revision }).strict() }, async (req, body) => request(req, { operation: 'trigger_toggle', triggerId: z.object({ triggerId: id }).parse(req.params).triggerId, ...body }));
  apiRoute(app, "DELETE /bots/:id/automation/triggers/:triggerId", { body: z.object({ revision }).strict() }, async (req, body) => request(req, { operation: 'trigger_delete', triggerId: z.object({ triggerId: id }).parse(req.params).triggerId, ...body }));
  apiRoute(app, "GET /bots/:id/automation/skills/content", {}, async req => request(req, { operation: 'skill_content', ...z.object({ name: z.string().regex(/^[A-Za-z0-9_./-]{1,200}$/).refine(name => !name.split('/').some(part => part === '..' || !part)) }).strict().parse(req.query) }));
  apiRoute(app, "GET /bots/:id/automation/skills/pending/:pendingId", {}, async req => request(req, { operation: 'skill_diff', pendingId: z.object({ pendingId: z.string().regex(/^[a-f0-9]{8}$/) }).parse(req.params).pendingId }));
  apiRoute(app, "POST /bots/:id/automation/skills/pending/:pendingId", { body: z.object({ revision, decision: z.enum(['approve', 'reject']) }).strict() }, async (req, body) => request(req, { operation: 'skill_decide', pendingId: z.object({ pendingId: z.string().regex(/^[a-f0-9]{8}$/) }).parse(req.params).pendingId, ...body }));
  apiRoute(app, "PUT /bots/:id/automation/skills/policy", { body: z.object({ approvalRequired: z.boolean() }).strict() }, async (req, body) => request(req, { operation: 'skill_policy', ...body }));
}
