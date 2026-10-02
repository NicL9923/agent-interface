import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signedIn } from './auth.js';
import type { Runtime } from '../shared/types.js';
import type { ExperienceRequest, TodayItem, TodayOverview } from '../shared/experience.js';
import { replyCardsFromText, validReplyCardState } from '../shared/reply-cards.js';
import { routinePresets } from '../shared/routine-presets.js';
import type { Store } from './store.js';
const id = z.string().min(1).max(200);
const target = z.enum(['memory', 'user']);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.string().datetime({ offset: true });
const failure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
export async function assertRoutineEditable(runtime: Runtime, store: Store, routineId: string) {
  if (!runtime.experienceRequest) return;
  for (const trial of store.routineTrials(routineId)) {
    try {
      const response = await runtime.experienceRequest({ operation: 'run_receipt', profile: trial.botId, routineId, requestId: trial.requestId, senderId: trial.userId });
      if ('status' in response) store.recordRoutineTrialStatus(trial.requestId, response.status === 'uncertain' && response.ownerStatus === 'unknown' ? 'settled' : response.status);
      if ('status' in response && response.status === 'accepted') throw failure(409, 'This routine has a trial running. Wait for its result before changing or deleting it.');
      if ('status' in response && response.status === 'uncertain' && 'executionId' in response && (!('ownerStatus' in response) || response.ownerStatus !== 'unknown')) throw failure(409, 'The native trial owner is still unconfirmed. Check the trial result before changing this routine.');
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) continue;
      throw error;
    }
  }
}
export async function installExperienceRoutes(app: FastifyInstance, runtime: Runtime, store: Store) {
  const bot = async (botId: string) => {
    if (!(await runtime.listBots()).some(row => row.id === botId)) throw failure(404, 'Assistant not found');
  };
  const request = async (input: ExperienceRequest) => {
    await bot(input.profile);
    if (!runtime.experienceRequest) throw failure(409, 'The installed Hermes add-on needs memory and routine preview support. Update and qualify the integration.');
    return runtime.experienceRequest(input);
  };
  app.get('/api/today', async req => {
    const userId = signedIn(req).id;
    const now = new Date();
    const query = z.object({ since: iso.optional() }).strict().parse(req.query);
    const since = new Date(query.since ?? store.todaySeen(userId) ?? now.getTime() - 86400000).toISOString();
    if (Date.parse(since) > now.getTime() + 60_000) throw failure(400, 'The recap start cannot be in the future');
    // Capture the ingestion page before any awaited native read. A completion
    // discovered during those reads belongs to the next page, even when its
    // native occurredAt precedes the person's last visit.
    const upperFrontier = store.latestEventFrontier();
    const bots = await runtime.listBots();
    const page = store.eventPage(query.since ? 0 : store.todayFrontier(userId), upperFrontier, bots.map(bot => bot.id), query.since || !store.todaySeen(userId) ? since : undefined);
    const eventFiles = new Map<string, typeof page.events[number]['files']>();
    const items: TodayItem[] = [];
    for (let index = 0; index < bots.length; index += 4) {
      const batch = await Promise.all(bots.slice(index, index + 4).map(async bot => {
        try {
          const conversation = await runtime.conversation(bot.id);
          const latest = conversation.messages.findLast(message => message.role === 'assistant');
          const unreadRuns = new Set<string>();
          for (const event of page.events.filter(event => event.botId === bot.id && event.kind === 'completed' && event.runId)) {
            unreadRuns.add(event.runId!);
            const files = conversation.messages.filter(message => message.runId === event.runId && message.role !== 'user').flatMap(message => message.files ?? []);
            if (files.length) eventFiles.set(event.id, [...new Map(files.map(file => [file.id, file])).values()]);
          }
          const files = conversation.messages.filter(message => message.createdAt && Date.parse(message.createdAt) > Date.parse(since) || message.runId && unreadRuns.has(message.runId) && message.role !== 'user').flatMap(message => message.files ?? []);
          return { botId: bot.id, botName: bot.name, activity: conversation.activity,
            approvals: conversation.approvals.filter(approval => approval.status === 'pending'),
            attention: conversation.attention ?? [],
            ...(latest ? { latestMessage: { id: latest.id, text: latest.text, createdAt: latest.createdAt, files: latest.files } } : {}),
            files: [...new Map(files.map(file => [file.id, file])).values()] };
        } catch {
          return { botId: bot.id, botName: bot.name, activity: { state: 'disconnected' as const }, approvals: [], attention: [], files: [], error: 'Could not read this Hermes conversation. Open it to reconnect.' };
        }
      }));
      items.push(...batch);
    }
    const ids = new Set(bots.map(bot => bot.id));
    return { generatedAt: now.toISOString(), since, frontier: page.frontier, hasMore: page.hasMore, items,
      events: page.events.filter(event => ids.has(event.botId)).map(event => ({ ...event, ...(eventFiles.has(event.id) ? { files: eventFiles.get(event.id) } : {}) })).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
      unavailableBots: items.filter(item => item.error).map(item => item.botId) } satisfies TodayOverview;
  });
  app.put('/api/today/seen', async req => {
    const { seenAt, frontier } = z.object({ seenAt: iso, frontier: z.string().regex(/^\d{1,16}$/) }).strict().parse(req.body);
    if (Date.parse(seenAt) > Date.now() + 60_000) throw failure(400, 'Read time cannot be in the future');
    if (!Number.isSafeInteger(Number(frontier)) || Number(frontier) > store.latestEventFrontier()) throw failure(400, 'The recap frontier is not a known ingestion position');
    store.markTodaySeen(signedIn(req).id, new Date(seenAt).toISOString(), Number(frontier));
    return { ok: true };
  });
  app.get('/api/bots/:id/memory', async req => request({ operation: 'memory', profile: z.object({ id }).parse(req.params).id }));
  for (const method of ['PUT', 'PATCH'] as const) app.route({ method, url: '/api/bots/:id/memory/:target', handler: async req => {
    const params = z.object({ id, target }).parse(req.params);
    const body = z.object({ revision, entries: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/).optional(), text: z.string().trim().min(1).max(50000) }).strict()).max(100) }).strict().parse(req.body);
    return request({ operation: 'save_memory', profile: params.id, target: params.target, ...body });
  } });
  app.delete('/api/bots/:id/memory/:target', async req => {
    const params = z.object({ id, target }).parse(req.params);
    const body = z.object({ revision, entryId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    return request({ operation: 'delete_memory', profile: params.id, target: params.target, ...body });
  });
  app.get('/api/routines/templates', async () => routinePresets);
  app.post('/api/routines/preview', async req => {
    const body = z.object({ botId: id, schedule: z.string().trim().min(1).max(500) }).strict().parse(req.body);
    return request({ operation: 'preview', profile: body.botId, schedule: body.schedule });
  });
  const routine = async (routineId: string) => {
    const row = (await runtime.routines()).find(routine => routine.id === routineId);
    if (!row) throw failure(404, 'Routine not found');
    return row;
  };
  app.post('/api/routines/:id/run', async req => {
    const params = z.object({ id }).parse(req.params);
    const { requestId } = z.object({ requestId: z.string().uuid() }).strict().parse(req.body);
    const userId = signedIn(req).id;
    const previous = store.routineTrial(requestId);
    if (previous && (previous.userId !== userId || previous.routineId !== params.id)) throw failure(409, 'This trial request ID belongs to a different routine or person');
    const row = previous ? { botId: previous.botId, id: previous.routineId } : await routine(params.id);
    store.rememberRoutineTrial(requestId, userId, row.id, row.botId);
    const receipt = await request({ operation: 'run', profile: row.botId, routineId: row.id, requestId, senderId: userId });
    if ('status' in receipt) store.recordRoutineTrialStatus(requestId, receipt.status);
    return receipt;
  });
  app.get('/api/routines/:id/runs/:requestId', async req => {
    const params = z.object({ id, requestId: z.string().uuid() }).parse(req.params);
    const userId = signedIn(req).id;
    const row = store.routineTrial(params.requestId);
    if (!row || row.userId !== userId || row.routineId !== params.id) throw failure(404, 'Trial receipt not found');
    const receipt = await request({ operation: 'run_receipt', profile: row.botId, routineId: row.routineId, requestId: params.requestId, senderId: userId });
    if ('status' in receipt) store.recordRoutineTrialStatus(params.requestId, receipt.status === 'uncertain' && receipt.ownerStatus === 'unknown' ? 'settled' : receipt.status);
    return receipt;
  });
  for (const method of ['GET', 'PUT'] as const) app.route({ method, url: '/api/bots/:id/messages/:messageId/cards/:cardId/state', handler: async req => {
    const params = z.object({ id, messageId: id, cardId: id }).parse(req.params);
    await bot(params.id);
    const message = (await runtime.conversation(params.id)).messages.find(message => message.id === params.messageId && message.role === 'assistant');
    const card = message && replyCardsFromText(message.text).find(card => card.id === params.cardId);
    if (!card) throw failure(404, 'This interactive reply is no longer in the Hermes conversation');
    const userId = signedIn(req).id;
    if (method === 'PUT') {
      const state = z.object({ checkedIds: z.array(id).max(60), notes: z.record(id, z.string().max(2000)) }).strict().parse(req.body);
      if (!validReplyCardState(card, state)) throw failure(400, 'The saved choices do not belong to this reply');
      store.saveCardState(userId, params.id, params.messageId, params.cardId, state);
      return state;
    }
    const state = store.cardState(userId, params.id, params.messageId, params.cardId);
    return validReplyCardState(card, state) ? state : { checkedIds: [], notes: {} };
  } });
}
