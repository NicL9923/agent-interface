import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installAuth, hash } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';
import { loadConfig } from '../src/server/config.js';
import { installExperienceRoutes } from '../src/server/experience.js';
import type { Runtime } from '../src/shared/types.js';
const origin = 'https://experience.example.invalid';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup() {
  const app = Fastify({ logger: false }); apps.push(app);
  const store = new Store(':memory:');
  const config = loadConfig({ NODE_ENV: 'production', APP_ORIGIN: origin, APP_DATABASE: ':memory:', GOOGLE_CLIENT_ID: 'fixture', HOUSEHOLD_EMAILS: 'first@example.invalid,second@example.invalid' });
  await app.register(cookie); await installAuth(app, store, config);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 502).send({ error: (error as Error).message }));
  const conversation = vi.fn(async (id: string) => {
    if (id === 'offline') throw new Error('private transport failure');
    return { botId: id, messages: [{ id: 'reply', role: 'assistant', text: '```agent-ui\n{"version":1,"cards":[{"id":"list","type":"checklist","title":"Groceries","items":[{"id":"milk","text":"Milk"}]}]}\n```', createdAt: new Date().toISOString(), files: [{ id: 'file', name: 'plan.pdf', mime: 'application/pdf' }] }], activity: { state: 'blocked' }, approvals: [{ id: 'pending', status: 'pending' }, { id: 'resolved', status: 'approved' }], attention: [{ id: 'clarify', kind: 'clarify', title: 'Which day?', detail: 'Confirm Saturday' }], files: [] };
  });
  const experienceRequest = vi.fn(async (value: unknown) => value);
  const routines = vi.fn(async () => [{ id: 'routine', botId: 'ranch' }]);
  const runtime = { conversation, experienceRequest, routines, listBots: vi.fn(async () => [{ id: 'ranch', name: 'Ranch' }, { id: 'offline', name: 'Offline' }]) } as unknown as Runtime;
  await installExperienceRoutes(app, runtime, store);
  const login = (id: string) => {
    store.user({ id, name: id, email: `${id}@example.invalid` });
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
    store.session(hash(token), id, csrf, Date.now() + 600000);
    return { origin, cookie: `session=${token}`, 'x-csrf-token': csrf };
  };
  app.addHook('onClose', async () => store.close());
  return { app, store, runtime, experienceRequest, conversation, routines, first: login('first'), second: login('second') };
}
it('authenticates profile memory reads, protects edits and validates native profile identity', async () => {
  const s = await setup();
  expect((await s.app.inject('/api/bots/ranch/memory')).statusCode).toBe(401);
  expect((await s.app.inject({ url: '/api/bots/ranch/memory', headers: s.first })).json()).toEqual({ operation: 'memory', profile: 'ranch' });
  const payload = { revision: 'a'.repeat(64), entries: [{ text: 'Quick dinners' }] };
  expect((await s.app.inject({ method: 'PUT', url: '/api/bots/ranch/memory/memory', headers: { origin, cookie: s.first.cookie }, payload })).statusCode).toBe(403);
  expect((await s.app.inject({ method: 'PUT', url: '/api/bots/missing/memory/memory', headers: s.first, payload })).statusCode).toBe(404);
  expect((await s.app.inject({ method: 'PUT', url: '/api/bots/ranch/memory/memory', headers: s.first, payload: { ...payload, arbitraryPath: '/private/.env' } })).statusCode).toBe(400);
  const response = await s.app.inject({ method: 'PUT', url: '/api/bots/ranch/memory/memory', headers: s.first, payload });
  expect(response.statusCode).toBe(200); expect(s.experienceRequest).toHaveBeenLastCalledWith({ operation: 'save_memory', profile: 'ranch', target: 'memory', ...payload });
  s.runtime.experienceRequest = undefined;
  expect((await s.app.inject({ url: '/api/bots/ranch/memory', headers: s.first })).statusCode).toBe(409);
});
it('builds Today from canonical activity and attention without hiding unavailable assistants', async () => {
  const s = await setup();
  const since = new Date(Date.now() - 3600000).toISOString();
  s.store.recordEvents([{ id: 'event', botId: 'ranch', kind: 'completed', title: 'Finished', occurredAt: new Date().toISOString() }, { id: 'gone', botId: 'deleted', kind: 'completed', title: 'Deleted profile', occurredAt: new Date().toISOString() }], '1');
  const response = await s.app.inject({ url: `/api/today?since=${encodeURIComponent(since)}`, headers: s.first });
  expect(response.statusCode).toBe(200); const today = response.json();
  expect(today.since).toBe(since); expect(today.events.map((x: { id: string }) => x.id)).toEqual(['event']);
  expect(today.items[0].approvals.map((x: { id: string }) => x.id)).toEqual(['pending']); expect(today.items[0].attention[0].id).toBe('clarify');
  expect(today.items[0].files[0].name).toBe('plan.pdf'); expect(today.unavailableBots).toEqual(['offline']); expect(today.items[1].activity.state).toBe('disconnected'); expect(JSON.stringify(today)).not.toContain('private transport');
  await s.app.inject({ method: 'PUT', url: '/api/today/seen', headers: s.first, payload: { seenAt: since, frontier: today.frontier } });
  expect((await s.app.inject({ url: '/api/today', headers: s.first })).json().since).toBe(since);
  expect((await s.app.inject({ url: '/api/today', headers: s.second })).json().since).not.toBe(since);
  expect((await s.app.inject({ method: 'PUT', url: '/api/today/seen', headers: s.first, payload: { seenAt: new Date(Date.now() + 86400000).toISOString(), frontier: today.frontier } })).statusCode).toBe(400);
});
it('keeps reply choices private and rejects nonexistent or forged card items', async () => {
  const s = await setup(), url = '/api/bots/ranch/messages/reply/cards/list/state';
  const payload = { checkedIds: ['milk'], notes: {} };
  expect((await s.app.inject({ method: 'PUT', url, headers: s.first, payload })).json()).toEqual(payload);
  expect((await s.app.inject({ url, headers: s.first })).json()).toEqual(payload);
  expect((await s.app.inject({ url, headers: s.second })).json()).toEqual({ checkedIds: [], notes: {} });
  for (const payload of [{ checkedIds: ['poison'], notes: {} }, { checkedIds: ['milk', 'milk'], notes: {} }, { checkedIds: [], notes: { milk: 'forged itinerary' } }]) expect((await s.app.inject({ method: 'PUT', url, headers: s.first, payload })).statusCode).toBe(400);
  expect((await s.app.inject({ url: '/api/bots/ranch/messages/forged/cards/list/state', headers: s.first })).statusCode).toBe(404);
});
it('keeps trial receipt scope after a one-shot routine disappears and refuses cross-person reuse', async () => {
  const s = await setup(), requestId = randomUUID();
  const response = await s.app.inject({ method: 'POST', url: '/api/routines/routine/run', headers: s.first, payload: { requestId } });
  expect(response.statusCode).toBe(200); expect(s.experienceRequest).toHaveBeenCalledWith({ operation: 'run', profile: 'ranch', routineId: 'routine', requestId, senderId: 'first' });
  s.routines.mockResolvedValue([]);
  expect((await s.app.inject({ url: `/api/routines/routine/runs/${requestId}`, headers: s.first })).statusCode).toBe(200);
  expect((await s.app.inject({ method: 'POST', url: '/api/routines/routine/run', headers: s.first, payload: { requestId } })).statusCode).toBe(200);
  expect((await s.app.inject({ method: 'POST', url: '/api/routines/routine/run', headers: s.second, payload: { requestId } })).statusCode).toBe(409);
  expect((await s.app.inject({ url: `/api/routines/routine/runs/${requestId}`, headers: s.second })).statusCode).toBe(404);
  expect((await s.app.inject({ method: 'POST', url: '/api/routines/preview', headers: s.first, payload: { botId: 'ranch', schedule: '0 7 * * *' } })).json()).toEqual({ operation: 'preview', profile: 'ranch', schedule: '0 7 * * *' });
});
it('fences routine edits during a trial and stops rereading terminal trial history', async () => {
  const { assertRoutineEditable } = await import('../src/server/experience.js');
  const s = await setup(), requestId = randomUUID();
  s.store.rememberRoutineTrial(requestId, 'first', 'routine', 'ranch');
  s.experienceRequest.mockResolvedValueOnce({ status: 'accepted' });
  await expect(assertRoutineEditable(s.runtime, s.store, 'routine')).rejects.toMatchObject({ statusCode: 409 });
  s.experienceRequest.mockResolvedValueOnce({ status: 'completed' });
  await assertRoutineEditable(s.runtime, s.store, 'routine');
  expect(s.store.routineTrials('routine')).toEqual([]);
  const count = s.experienceRequest.mock.calls.length;
  await assertRoutineEditable(s.runtime, s.store, 'routine');
  expect(s.experienceRequest.mock.calls.length).toBe(count);
});
it('shows late native completions and their attributed artifacts after a catch-up marker', async () => {
  const s = await setup();
  const original = (await s.app.inject({ url: '/api/today', headers: s.first })).json();
  expect((await s.app.inject({ method: 'PUT', url: '/api/today/seen', headers: s.first, payload: { seenAt: original.generatedAt, frontier: original.frontier } })).statusCode).toBe(200);
  const oldTime = new Date(Date.now() - 2 * 86400000).toISOString();
  s.store.recordEvents([{ id: 'delayed', botId: 'ranch', runId: 'late-run', kind: 'completed', title: 'Delayed completion', occurredAt: oldTime }], 'delayed');
  s.runtime.conversation = async botId => ({ botId, activity: { state: 'done' }, approvals: [], files: [], messages: [
    { id: 'old-tool', role: 'tool', runId: 'late-run', createdAt: oldTime, text: 'Created file', files: [{ id: 'late-artifact', name: 'late-plan.pdf', mime: 'application/pdf' }] },
    { id: 'unrelated-tool', role: 'tool', runId: 'other-run', createdAt: oldTime, text: 'Earlier file', files: [{ id: 'unrelated-artifact', name: 'unrelated.pdf', mime: 'application/pdf' }] },
  ] });
  const refreshed = (await s.app.inject({ url: '/api/today', headers: s.first })).json();
  expect(refreshed.events.map((event: { id: string }) => event.id)).toEqual(['delayed']);
  expect(refreshed.events[0].files.map((file: { id: string }) => file.id)).toEqual(['late-artifact']);
  expect(refreshed.items[0].files.map((file: { id: string }) => file.id)).toEqual(['late-artifact']);
  expect(refreshed.frontier).not.toBe(original.frontier);
});
it('does not acknowledge completion events arriving during native snapshot reads', async () => {
  const s = await setup(), originalList = s.runtime.listBots;
  let inserted = false;
  s.runtime.listBots = async () => {
    if (!inserted) { inserted = true; s.store.recordEvents([{ id: 'during-read', botId: 'ranch', kind: 'completed', title: 'Arrived during read', occurredAt: new Date(Date.now() - 86400000).toISOString() }], 'during-read'); }
    return originalList();
  };
  const overview = (await s.app.inject({ url: '/api/today', headers: s.first })).json();
  expect(overview.frontier).toBe('0'); expect(overview.events).toEqual([]);
  await s.app.inject({ method: 'PUT', url: '/api/today/seen', headers: s.first, payload: { seenAt: overview.generatedAt, frontier: overview.frontier } });
  expect((await s.app.inject({ url: '/api/today', headers: s.first })).json().events.map((event: { id: string }) => event.id)).toEqual(['during-read']);
});
it('acknowledges only presented pages and keeps the durable frontier through retention', async () => {
  const s = await setup(), occurredAt = new Date().toISOString();
  s.store.recordEvents(Array.from({ length: 102 }, (_, index) => ({ id: `event-${index}`, botId: 'ranch', kind: 'completed' as const, title: String(index), occurredAt })), '102');
  const first = (await s.app.inject({ url: '/api/today', headers: s.first })).json();
  expect(first.events).toHaveLength(100); expect(first.hasMore).toBe(true); expect(first.frontier).toBe('100');
  await s.app.inject({ method: 'PUT', url: '/api/today/seen', headers: s.first, payload: { seenAt: first.generatedAt, frontier: first.frontier } });
  const next = (await s.app.inject({ url: '/api/today', headers: s.first })).json();
  expect(next.events).toHaveLength(2); expect(next.hasMore).toBe(false); expect(next.frontier).toBe('102');
  await s.app.inject({ method: 'PUT', url: '/api/today/seen', headers: s.first, payload: { seenAt: next.generatedAt, frontier: next.frontier } });
  s.store.db.exec('DELETE FROM notification_events');
  s.store.recordEvents([{ id: 'after-retention', botId: 'ranch', kind: 'completed', title: 'New after pruning', occurredAt }], '103');
  const after = (await s.app.inject({ url: '/api/today', headers: s.first })).json();
  expect(after.frontier).toBe('103'); expect(after.events[0].id).toBe('after-retention');
  expect((await s.app.inject({ method: 'PUT', url: '/api/today/seen', headers: s.first, payload: { seenAt: after.generatedAt, frontier: '104' } })).statusCode).toBe(400);
});
it('filters departed profiles before pagination so their backlog cannot hide household results', async () => {
  const s = await setup(), occurredAt = new Date().toISOString();
  s.store.recordEvents([
    ...Array.from({ length: 105 }, (_, index) => ({ id: `departed-${index}`, botId: 'deleted', kind: 'completed' as const, title: 'Departed profile', occurredAt })),
    { id: 'visible-result', botId: 'ranch', kind: 'completed', title: 'Household result', occurredAt },
  ], '106');
  const overview = (await s.app.inject({ url: '/api/today', headers: s.first })).json();
  expect(overview.events.map((event: { id: string }) => event.id)).toEqual(['visible-result']);
  expect(overview.hasMore).toBe(false); expect(overview.frontier).toBe('106');
});
