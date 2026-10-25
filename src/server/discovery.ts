import { apiRoute } from "./api-route.js";
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertRoutineEditable } from "./experience.js";
import { signedIn } from './auth.js';
import type { Runtime } from '../shared/types.js';
import type { HistoryPage, AutomationOverview, SearchHit, SavedItem, Starter, UsageSummary } from '../shared/discovery.js';
import type { Store } from './store.js';
import { notFound, redactAgents, Roster, visibleBots } from './bot-access.js';
import { httpError } from './http-error.js';
import { id } from './schemas.js';
export async function installDiscoveryRoutes(app: FastifyInstance, runtime: Runtime, store: Store, roster = new Roster(runtime)) {
  const visible = (userId: string) => visibleBots(runtime, store, userId);
  async function bot(userId: string, botId: string) {
    if (!(await visible(userId)).some(row => row.id === botId)) throw httpError(404, notFound.error, { code: notFound.code });
  }
  function experience() {
    if (!runtime.experienceRequest) throw httpError(409, 'Search and usage require the current qualified Hermes integration.');
    return runtime.experienceRequest.bind(runtime);
  }
  apiRoute(app, "GET /search", {}, async req => {
    const { q, botId } = z.object({ q: z.string().trim().min(1).max(200), botId: id.optional() }).strict().parse(req.query);
    // With botId, as find in chat asks, only that assistant is searched.
    const bots = (await visible(signedIn(req).id)).filter(bot => botId === undefined || bot.id === botId);
    if (botId !== undefined && !bots.length) throw httpError(404, notFound.error, { code: notFound.code });
    const hits: SearchHit[] = []; const unavailableBots: string[] = [];
    for (let index = 0; index < bots.length; index += 4) await Promise.all(bots.slice(index, index + 4).map(async bot => {
      try { hits.push(...(await experience()({ operation: 'search', profile: bot.id, query: q })).map(hit => ({ ...hit, botName: bot.name }))); }
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
    const redact = await redactAgents(store, roster, signedIn(req).id);
    return { hits: hits.map(hit => ({ ...hit, title: redact.text(hit.title), snippet: redact.text(hit.snippet) })), unavailableBots };
  });
  apiRoute(app, "GET /bots/:botId/history/:sessionId", {}, async req => {
    const p = z.object({ botId: id, sessionId: id }).parse(req.params);
    const { offset, messageId } = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), messageId: id.optional() }).strict().parse(req.query);
    await bot(signedIn(req).id, p.botId);
    const page=await experience()({ operation: 'history', profile: p.botId, sessionId: p.sessionId, offset, ...(messageId ? {messageId} : {}) });
    const redact = await redactAgents(store, roster, signedIn(req).id);
    return {...page,messages:page.messages.map(message=>{const senderId=(message as typeof message & {app_sender_id?:string}).app_sender_id;const user=senderId&&store.getUser(senderId);return user?{...message,origin:undefined,sender:{id:user.id,name:user.name}}:message;}).map(redact.message)};
  });
  apiRoute(app, "GET /saved", {}, async req => {
    const allowed = new Set((await visible(signedIn(req).id)).map(bot => bot.id));
    return store.savedItems(signedIn(req).id).filter(item => allowed.has(item.botId));
  });
  apiRoute(app, "POST /saved", { body: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('session'), botId: id, sessionId: id, messageId: id.optional(), offset: z.number().int().min(0).max(100000).optional(), title: z.string().trim().min(1).max(120) }).strict(),
      z.object({ kind: z.literal('routine'), botId: id, routineId: id, resultId: id, title: z.string().trim().min(1).max(120) }).strict(),
    ]) }, async (req, body) => {
    const userId = signedIn(req).id;
    await bot(userId, body.botId);
    if (body.kind === 'session') {
      const locate = body.messageId && body.offset === undefined;
      const page = await experience()({ operation: 'history', profile: body.botId, sessionId: body.sessionId, offset: body.offset ?? 0, ...(locate ? {messageId: body.messageId} : {}) });
      if (locate) { body.offset = page.offset; body.messageId = page.targetMessageId ?? body.messageId; }
      if (body.messageId && !page.messages.some(message=>message.id===body.messageId)) throw httpError(404,'The saved reply is no longer in this history page.');
    }
    else { if (!runtime.routineOutput) throw httpError(409, 'Routine outputs unavailable'); await runtime.routineOutput(body.botId, body.routineId, body.resultId); }
    return store.saveItem(userId, body);
  });
  apiRoute(app, "DELETE /saved/:id", {}, async req => { store.deleteSavedItem(signedIn(req).id, z.object({ id }).parse(req.params).id); return { ok: true }; });
  apiRoute(app, "PATCH /routines/:id/state", { body: z.object({enabled:z.boolean()}).strict() }, async (req, { enabled }) => {
    const routineId = z.object({id}).parse(req.params).id;
    const row=(await runtime.routines()).find(row=>row.id===routineId);
    if(!row)throw httpError(404,'Routine not found');
    await bot(signedIn(req).id,row.botId);await assertRoutineEditable(runtime,store,routineId);
    if(!runtime.setRoutineEnabled)throw httpError(409,'This integration cannot change routine state independently.');
    await runtime.setRoutineEnabled(row.botId,routineId,enabled);return {ok:true};
  });
  apiRoute(app, "GET /automations", {}, async req => {
    const { days } = z.object({ days: z.coerce.number().refine(days => [7,30,90].includes(days)).default(30) }).strict().parse(req.query);
    const bots = await visible(signedIn(req).id); const allowed = new Set(bots.map(bot => bot.id));
    const routines = (await runtime.routines()).filter(row => allowed.has(row.botId)).map(row => ({ ...row, recipientIds: store.getRoutineRecipients(row.id) }));
    const usage: UsageSummary[] = []; const unavailableBots: string[] = [];
    for (let index = 0; index < bots.length; index += 4) await Promise.all(bots.slice(index,index+4).map(async bot => {
      try { usage.push(await experience()({ operation: 'usage', profile: bot.id, days })); } catch { unavailableBots.push(bot.id); }
    }));
    return { routines, usage, unavailableBots } satisfies AutomationOverview;
  });
  apiRoute(app, "GET /bots/:id/starters", {}, async req => {
    const botId = z.object({ id }).parse(req.params).id;
    if (!(await runtime.listBots()).some(row => row.id === botId)) throw httpError(404, notFound.error, { code: notFound.code });
    const tools = await runtime.tools(botId);
    const enabled = new Set(tools.filter(tool => tool.enabled).map(tool => tool.id));
    const starters: Starter[] = [{ id: 'meals', title: 'Plan dinners', prompt: 'Help me plan five easy dinners. Ask about our preferences, budget and what we already have before making the plan.' }];
    if ((await runtime.capabilities()).uploads.supported) starters.push({ id: 'document', title: 'Explain a document', prompt: 'Help me understand the document I attach. Summarize its key points and highlight questions I should ask.' });
    if (enabled.has('terminal')) starters.push({ id: 'server', title: 'Check a server', prompt: 'Help me review my server health. First confirm which server and connection to use. Inspect only, then show findings and ask before making changes.' });
    if (enabled.has('web') || enabled.has('browser')) starters.push({ id: 'research', title: 'Research a question', prompt: 'Research this question using current primary sources, link them and explain any uncertainty: ' });
    return starters;
  });
}
