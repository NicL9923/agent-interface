import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertRoutineEditable } from "./experience.js";
import { signedIn } from './auth.js';
import type { Runtime } from '../shared/types.js';
import type { HistoryPage, AutomationOverview, SearchHit, SavedItem, Starter, UsageSummary } from '../shared/discovery.js';
import type { Store } from './store.js';
const id = z.string().min(1).max(200);
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
export async function installDiscoveryRoutes(app: FastifyInstance, runtime: Runtime, store: Store) {
  async function visible(userId: string) {
    return (await runtime.listBots()).map(bot => ({ ...bot, ...store.presentation(bot.id) })).filter(bot => bot.shared || !bot.ownerId || bot.ownerId === userId);
  }
  async function bot(userId: string, botId: string) {
    if (!(await visible(userId)).some(row => row.id === botId)) throw fail(404, 'Assistant not found');
  }
  function experience() {
    if (!runtime.experienceRequest) throw fail(409, 'Search and usage require the current qualified Hermes integration.');
    return runtime.experienceRequest.bind(runtime);
  }
  app.get('/api/search', async req => {
    const { q } = z.object({ q: z.string().trim().min(1).max(200) }).strict().parse(req.query);
    const bots = await visible(signedIn(req).id);
    const hits: SearchHit[] = []; const unavailableBots: string[] = [];
    for (let index = 0; index < bots.length; index += 4) await Promise.all(bots.slice(index, index + 4).map(async bot => {
      try { hits.push(...(await experience()({ operation: 'search', profile: bot.id, query: q }) as SearchHit[]).map(hit => ({ ...hit, botName: bot.name }))); }
      catch { unavailableBots.push(bot.id); }
    }));
    // Native session FTS covers conversation text. Cron documents are owned by
    // the scoped routine reader and contribute separately, including script previews.
    try {
      for (const routine of (await runtime.routines()).filter(row=>bots.some(bot=>bot.id===row.botId))) {
        if (!runtime.routineResults) break;
        try {
          const results = await runtime.routineResults(routine.botId,routine.id);
          for (const result of results.filter(result=>`${routine.name} ${result.title} ${result.preview||''}`.toLowerCase().includes(q.toLowerCase())).slice(0,20)) hits.push({botId:routine.botId,botName:bots.find(bot=>bot.id===routine.botId)!.name,sessionId:`routine:${routine.id}:${result.id}`,title:result.title,snippet:result.preview||routine.name,routineId:routine.id,resultId:result.id});
        } catch { if(!unavailableBots.includes(routine.botId))unavailableBots.push(routine.botId); }
      }
    } catch { /* Return successful native search hits during a scheduler outage. */ }
    return { hits, unavailableBots };
  });
  app.get('/api/bots/:botId/history/:sessionId', async req => {
    const p = z.object({ botId: id, sessionId: id }).parse(req.params);
    const { offset } = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict().parse(req.query);
    await bot(signedIn(req).id, p.botId);
    const page=await experience()({ operation: 'history', profile: p.botId, sessionId: p.sessionId, offset }) as HistoryPage;
    return {...page,messages:page.messages.map(message=>{const senderId=(message as typeof message & {app_sender_id?:string}).app_sender_id;const user=senderId&&store.getUser(senderId);return user?{...message,sender:{id:user.id,name:user.name}}:message;})};
  });
  app.get('/api/saved', async req => {
    const allowed = new Set((await visible(signedIn(req).id)).map(bot => bot.id));
    return store.savedItems(signedIn(req).id).filter(item => allowed.has(item.botId));
  });
  app.post('/api/saved', async req => {
    const body = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('session'), botId: id, sessionId: id, messageId: id.optional(), offset: z.number().int().min(0).max(100000).optional(), title: z.string().trim().min(1).max(120) }).strict(),
      z.object({ kind: z.literal('routine'), botId: id, routineId: id, resultId: id, title: z.string().trim().min(1).max(120) }).strict(),
    ]).parse(req.body);
    const userId = signedIn(req).id;
    await bot(userId, body.botId);
    if (body.kind === 'session') {
      const page = await experience()({ operation: 'history', profile: body.botId, sessionId: body.sessionId, offset: body.offset ?? 0 }) as HistoryPage;
      if (body.messageId && !page.messages.some(message=>message.id===body.messageId)) throw fail(404,'The saved reply is no longer in this history page.');
    }
    else { if (!runtime.routineOutput) throw fail(409, 'Routine outputs unavailable'); await runtime.routineOutput(body.botId, body.routineId, body.resultId); }
    return store.saveItem(userId, body);
  });
  app.delete('/api/saved/:id', async req => { store.deleteSavedItem(signedIn(req).id, z.object({ id }).parse(req.params).id); return { ok: true }; });
  app.patch('/api/routines/:id/state', async req => {
    const routineId = z.object({id}).parse(req.params).id;
    const {enabled} = z.object({enabled:z.boolean()}).strict().parse(req.body);
    const row=(await runtime.routines()).find(row=>row.id===routineId);
    if(!row)throw fail(404,'Routine not found');
    await bot(signedIn(req).id,row.botId);await assertRoutineEditable(runtime,store,routineId);
    if(!runtime.setRoutineEnabled)throw fail(409,'This integration cannot change routine state independently.');
    await runtime.setRoutineEnabled(row.botId,routineId,enabled);return {ok:true};
  });
  app.get('/api/automations', async req => {
    const { days } = z.object({ days: z.coerce.number().refine(days => [7,30,90].includes(days)).default(30) }).strict().parse(req.query);
    const bots = await visible(signedIn(req).id); const allowed = new Set(bots.map(bot => bot.id));
    const routines = (await runtime.routines()).filter(row => allowed.has(row.botId)).map(row => ({ ...row, recipientIds: store.getRoutineRecipients(row.id) }));
    const usage: UsageSummary[] = []; const unavailableBots: string[] = [];
    for (let index = 0; index < bots.length; index += 4) await Promise.all(bots.slice(index,index+4).map(async bot => {
      try { usage.push(await experience()({ operation: 'usage', profile: bot.id, days }) as UsageSummary); } catch { unavailableBots.push(bot.id); }
    }));
    return { routines, usage, unavailableBots } satisfies AutomationOverview;
  });
  app.get('/api/bots/:id/starters', async req => {
    const botId = z.object({ id }).parse(req.params).id; await bot(signedIn(req).id, botId);
    const tools = await runtime.tools(botId);
    const enabled = new Set(tools.filter(tool => tool.enabled).map(tool => tool.id));
    const starters: Starter[] = [{ id: 'meals', title: 'Plan dinners', prompt: 'Help me plan five easy dinners. Ask about our preferences, budget and what we already have before making the plan.' }];
    if ((await runtime.capabilities()).uploads.supported) starters.push({ id: 'document', title: 'Explain a document', prompt: 'Help me understand the document I attach. Summarize its key points and highlight questions I should ask.' });
    if (enabled.has('terminal')) starters.push({ id: 'server', title: 'Check a server', prompt: 'Help me review my server health. First confirm which server and connection to use. Inspect only, then show findings and ask before making changes.' });
    if (enabled.has('web') || enabled.has('browser')) starters.push({ id: 'research', title: 'Research a question', prompt: 'Research this question using current primary sources, link them and explain any uncertainty: ' });
    return starters;
  });
}
