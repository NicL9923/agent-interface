import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installAuth, hash } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';
import { loadConfig } from '../src/server/config.js';
import { installAutomationRoutes } from '../src/server/automation.js';
import type { Runtime } from '../src/shared/types.js';
const origin = 'https://automation.example.invalid';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup() {
  const app = Fastify({ logger: false }); apps.push(app);
  const store = new Store(':memory:');
  const config = loadConfig({ NODE_ENV: 'production', APP_ORIGIN: origin, APP_DATABASE: ':memory:', GOOGLE_CLIENT_ID: 'fixture', HOUSEHOLD_EMAILS: 'first@example.invalid,second@example.invalid' });
  await app.register(cookie); await installAuth(app, store, config);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 502).send({ error: (error as Error).message }));
  const automationRequest = vi.fn(async () => ({ ok: true }));
  const runtime = { automationRequest, listBots: vi.fn(async () => [{ id: 'ranch', name: 'Ranch' }, { id: 'private', name: 'Private' }]) } as unknown as Runtime;
  store.savePresentation('private', { shared: false, ownerId: 'second' });
  let maintenance = false;
  await installAutomationRoutes(app, runtime, store, () => maintenance, req => req.headers['x-admin-fixture'] === 'yes');
  const login = (id: string) => {
    store.user({ id, name: id, email: `${id}@example.invalid` });
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    store.session(hash(token), id, csrf, Date.now() + 600000);
    return { origin, cookie: `session=${token}`, 'x-csrf-token': csrf };
  };
  app.addHook('onClose', async () => store.close());
  return { app, runtime, automationRequest, first: login('first'), second: login('second'), maintain: () => { maintenance = true; } };
}
it('authenticates and scopes every automation request to the visible roster', async () => {
  const s = await setup();
  expect((await s.app.inject('/api/bots/ranch/automation')).statusCode).toBe(401);
  expect((await s.app.inject({ url: '/api/bots/private/automation', headers: s.first })).statusCode).toBe(404);
  expect((await s.app.inject({ url: '/api/bots/missing/automation', headers: s.first })).statusCode).toBe(404);
  const read = await s.app.inject({ url: '/api/bots/ranch/automation', headers: s.first });
  expect(read.statusCode).toBe(200); expect(read.headers['cache-control']).toBe('no-store');
  expect(s.automationRequest).toHaveBeenLastCalledWith({ operation: 'overview', profile: 'ranch', visibleProfiles: ['ranch'] });
  s.runtime.automationRequest = undefined;
  expect((await s.app.inject({ url: '/api/bots/ranch/automation', headers: s.first })).statusCode).toBe(409);
});
it('rejects hidden assignees and arbitrary native fields before dispatching writes', async () => {
  const s = await setup(), url = '/api/bots/ranch/automation/tasks';
  const task = { requestId: randomUUID(), title: 'Fix fence', assignee: 'ranch', dependencies: ['t_dependency'] };
  expect((await s.app.inject({ method: 'POST', url, headers: { origin, cookie: s.first.cookie }, payload: task })).statusCode).toBe(403);
  for (const payload of [{ ...task, assignee: 'private' }, { ...task, assignee: 'missing' }]) expect((await s.app.inject({ method: 'POST', url, headers: s.first, payload })).statusCode).toBe(404);
  for (const payload of [{ ...task, profile: 'private' }, { ...task, visibleProfiles: ['private'] }, { ...task, initial_status: 'running' }, { ...task, workspace_path: '/private' }]) expect((await s.app.inject({ method: 'POST', url, headers: s.first, payload })).statusCode).toBe(400);
  expect(s.automationRequest).not.toHaveBeenCalled();
  expect((await s.app.inject({ method: 'POST', url, headers: s.first, payload: task })).statusCode).toBe(200);
  expect(s.automationRequest).toHaveBeenLastCalledWith({ operation: 'task_create', profile: 'ranch', task, visibleProfiles: ['ranch'] });
  expect((await s.app.inject({ method: 'POST', url: url + '/t_task/actions', headers: s.first, payload: { action: 'request_review', reviewer: 'private' } })).statusCode).toBe(404);
});
it('gates all writes during maintenance and never retries uncertain native mutations', async () => {
  const s = await setup();
  s.automationRequest.mockRejectedValueOnce(new Error('Native outcome uncertain'));
  expect((await s.app.inject({ method: 'PUT', url: '/api/bots/ranch/automation/goal', headers: s.first, payload: { title: 'Repair fence', maxTurns: 20 } })).statusCode).toBe(502);
  expect(s.automationRequest).toHaveBeenCalledTimes(1);
  s.maintain();
  expect((await s.app.inject({ method: 'POST', url: '/api/bots/ranch/automation/goal/resume', headers: s.first, payload: { requestId: randomUUID() } })).statusCode).toBe(409);
  expect(s.automationRequest).toHaveBeenCalledTimes(1);
  expect((await s.app.inject({ url: '/api/bots/ranch/automation', headers: s.first })).statusCode).toBe(200);
});
it('requires integration administration for signing-secret mutations and bounds finite inputs', async () => {
  const s = await setup(), url = '/api/bots/ranch/automation/triggers';
  const trigger = { id: 'fence-event', description: 'New fence issue', events: ['issue.created'], routineId: 'routine' };
  expect((await s.app.inject({ method: 'POST', url, headers: s.first, payload: trigger })).statusCode).toBe(403);
  expect(s.automationRequest).not.toHaveBeenCalled();
  const admin = { ...s.first, 'x-admin-fixture': 'yes' };
  for (const payload of [{ ...trigger, secret: 'never-app-owned' }, { ...trigger, script: 'sh dangerous' }, { ...trigger, events: [] }]) expect((await s.app.inject({ method: 'POST', url, headers: admin, payload })).statusCode).toBe(400);
  const created = await s.app.inject({ method: 'POST', url, headers: admin, payload: trigger });
  expect(created.statusCode).toBe(200); expect(created.headers['cache-control']).toBe('no-store');
  expect(s.automationRequest).toHaveBeenLastCalledWith({ operation: 'trigger_create', profile: 'ranch', trigger, visibleProfiles: ['ranch'] });
  expect((await s.app.inject({ url: '/api/bots/ranch/automation/skills/content?name=../../config.yaml', headers: s.first })).statusCode).toBe(400);
  expect((await s.app.inject({ method: 'POST', url: '/api/bots/ranch/automation/skills/pending/deadbeef', headers: s.first, payload: { decision: 'approve', revision: 'a'.repeat(64), payload: { action: 'delete' } } })).statusCode).toBe(400);
});
it('injects the person and trigger permission into goal overview responses', async () => {
  const s = await setup(), requestId = randomUUID();
  const overview = { botId: 'ranch', owner: 'Hermes', goals: { supported: true, goal: null }, tasks: { supported: true, items: [] }, triggers: { supported: true, items: [], platformEnabled: false }, skills: { supported: true, installed: [], pending: [], approvalRequired: false } };
  s.automationRequest.mockResolvedValue(overview as never);
  const read = await s.app.inject({ url: '/api/bots/ranch/automation', headers: s.first });
  expect(read.json().canManageTriggers).toBe(false);
  expect(read.json().canManageLearningPolicy).toBe(false);
  const url = '/api/bots/ranch/automation/goal/resume';
  expect((await s.app.inject({ method: 'POST', url, headers: s.first, payload: {} })).statusCode).toBe(400);
  expect((await s.app.inject({ method: 'POST', url, headers: s.first, payload: { requestId, senderId: 'forged' } })).statusCode).toBe(400);
  const resumed = await s.app.inject({ method: 'POST', url, headers: { ...s.first, 'x-admin-fixture': 'yes' }, payload: { requestId } });
  expect(resumed.json().canManageTriggers).toBe(true);
  expect(resumed.json().canManageLearningPolicy).toBe(true);
  expect(s.automationRequest).toHaveBeenLastCalledWith({ operation: 'goal_resume', profile: 'ranch', visibleProfiles: ['ranch'], senderId: 'first', requestId });
});

it('restricts learning policy to administrators while allowing visible editors to review writes', async () => {
  const s = await setup();
  const base = '/api/bots/ranch/automation';
  expect((await s.app.inject({ method: 'PUT', url: base + '/skills/policy', headers: s.first, payload: { approvalRequired: false } })).statusCode).toBe(403);
  expect(s.automationRequest).not.toHaveBeenCalled();
  expect((await s.app.inject({ method: 'PUT', url: base + '/skills/policy', headers: { ...s.first, 'x-admin-fixture': 'yes' }, payload: { approvalRequired: true } })).statusCode).toBe(200);
  expect((await s.app.inject({ method: 'POST', url: base + '/skills/pending/deadbeef', headers: s.first, payload: { decision: 'approve', revision: 'a'.repeat(64) } })).statusCode).toBe(200);
  const requestId = randomUUID();
  expect((await s.app.inject({ method: 'POST', url: base + '/goal/resume', headers: s.first, payload: { requestId, reviewedInterruption: true } })).statusCode).toBe(200);
  expect(s.automationRequest).toHaveBeenLastCalledWith({ operation: 'goal_resume', profile: 'ranch', visibleProfiles: ['ranch'], senderId: 'first', requestId, reviewedInterruption: true });
});

it('distinguishes explicit null task assignment from an omitted assignment', async () => {
  const s = await setup();
  const url = '/api/bots/ranch/automation/tasks/t_task';
  expect((await s.app.inject({ method: 'PATCH', url, headers: s.first, payload: { assignee: null } })).statusCode).toBe(200);
  expect(s.automationRequest).toHaveBeenLastCalledWith({ operation: 'task_update', profile: 'ranch', taskId: 't_task', visibleProfiles: ['ranch'], assignee: null });
  expect((await s.app.inject({ method: 'PATCH', url, headers: s.first, payload: { title: 'Keep owner' } })).statusCode).toBe(200);
  expect(s.automationRequest).toHaveBeenLastCalledWith({ operation: 'task_update', profile: 'ranch', taskId: 't_task', visibleProfiles: ['ranch'], title: 'Keep owner' });
});
