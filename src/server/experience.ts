import { apiRoute } from "./api-route.js";
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signedIn } from './auth.js';
import type { FileRef, Message, Runtime } from '../shared/types.js';
import type { ExperienceRequest, ExperienceResult, TodayItem, TodayOverview } from '../shared/experience.js';
import { replyCardsFromText, validReplyCardState } from '../shared/reply-cards.js';
import { routinePresets } from '../shared/routine-presets.js';
import type { Store } from './store.js';
import { isConversationReply } from '../shared/message-origin.js';
import { notFound, redactAgents, Roster, visibleBots } from './bot-access.js';
import { nameRequesters } from './vault.js';
import { contentEtag } from './etag.js';
import { httpError } from './http-error.js';
import { id } from './schemas.js';
const target = z.enum(['memory', 'user']);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.string().datetime({ offset: true });
export async function assertRoutineEditable(runtime: Runtime, store: Store, routineId: string) {
  if (!runtime.experienceRequest) return;
  for (const trial of store.routineTrials(routineId)) {
    try {
      const response = await runtime.experienceRequest({ operation: 'run_receipt', profile: trial.botId, routineId, requestId: trial.requestId, senderId: trial.userId });
      if ('status' in response) store.recordRoutineTrialStatus(trial.requestId, response.status === 'uncertain' && response.ownerStatus === 'unknown' ? 'settled' : response.status);
      if ('status' in response && response.status === 'accepted') throw httpError(409, 'This routine has a trial running. Wait for its result before changing or deleting it.');
      if ('status' in response && response.status === 'uncertain' && 'executionId' in response && (!('ownerStatus' in response) || response.ownerStatus !== 'unknown')) throw httpError(409, 'The native trial owner is still unconfirmed. Check the trial result before changing this routine.');
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) continue;
      throw error;
    }
  }
}
/** Hermes may change history without a roster preview change, as another client can. A recap is read again after this long. */
const RECAP_MS = 5 * 60_000;
const settled = (activity: { state: string; runId?: string }) => !activity.runId && !['thinking', 'working', 'waiting', 'blocked'].includes(activity.state);
type Recap = { latest?: Pick<Message, 'id' | 'text' | 'createdAt' | 'files'>; files: FileRef[]; eventFiles: [string, FileRef[]][] };
const uniqueFiles = (files: FileRef[]) => [...new Map(files.map(file => [file.id, file])).values()];
/** What Today shows from an assistant's redacted history: its latest reply and the files of unread work. */
function summarize(messages: Message[], events: { id: string; runId?: string }[], unreadRuns: Set<string>, since: string): Recap {
  const latest = messages.findLast(isConversationReply);
  const eventFiles: Recap['eventFiles'] = [];
  for (const event of events) {
    const files = messages.filter(message => message.runId === event.runId && message.role !== 'user').flatMap(message => message.files ?? []);
    if (files.length) eventFiles.push([event.id, uniqueFiles(files)]);
  }
  const files = messages.filter(message => message.createdAt && Date.parse(message.createdAt) > Date.parse(since) || message.runId && unreadRuns.has(message.runId) && message.role !== 'user').flatMap(message => message.files ?? []);
  return { latest: latest && { id: latest.id, text: latest.text, createdAt: latest.createdAt, files: latest.files }, files: uniqueFiles(files), eventFiles };
}
export async function installExperienceRoutes(app: FastifyInstance, runtime: Runtime, store: Store, roster = new Roster(runtime)) {
  // Each person's latest Today recap per assistant, from its last full history read.
  const recaps = new Map<string, { key: string; at: number; recap: Recap }>();
  const bot = async (botId: string) => {
    if (!(await runtime.listBots()).some(row => row.id === botId)) throw httpError(404, notFound.error, { code: notFound.code });
  };
  const request = async <R extends ExperienceRequest>(input: R): Promise<ExperienceResult<R["operation"]>> => {
    await bot(input.profile);
    if (!runtime.experienceRequest) throw httpError(409, 'The installed Hermes add-on needs memory and routine preview support. Update and qualify the integration.');
    return runtime.experienceRequest(input);
  };
  apiRoute(app, "GET /today", {}, async (req, _, reply) => {
    const userId = signedIn(req).id;
    const now = new Date();
    const query = z.object({ since: iso.optional() }).strict().parse(req.query);
    // Before a first catch-up the recap covers a day, starting on a whole minute so polls within it can revalidate.
    const since = new Date(query.since ?? store.todaySeen(userId) ?? Math.floor((now.getTime() - 86400000) / 60_000) * 60_000).toISOString();
    if (Date.parse(since) > now.getTime() + 60_000) throw httpError(400, 'The recap start cannot be in the future');
    // Capture the ingestion page before any awaited native read. A completion
    // discovered during those reads belongs to the next page, even when its
    // native occurredAt precedes the person's last visit.
    const upperFrontier = store.latestEventFrontier();
    const bots = await visibleBots(runtime, store, userId);
    // The redactor reads which assistants are private in this same tick, so this version names
    // exactly the privacy it applies. A recap is reused, or saved, only under that version.
    const privacyVersion = store.privacyVersion;
    const redact = await redactAgents(store, roster, userId);
    const page = store.eventPage(userId, query.since ? 0 : store.todayFrontier(userId), upperFrontier, bots.map(bot => bot.id), query.since || !store.todaySeen(userId) ? since : undefined);
    const eventFiles = new Map<string, typeof page.events[number]['files']>();
    // Redaction also matches every name a hidden assistant has had.
    const hidden = store.privateBots().filter(row => row.ownerId !== userId).map(row => row.botId).sort();
    const names = hidden.length ? await roster.names() : undefined;
    const privacy = JSON.stringify([privacyVersion, hidden.map(botId => [botId, [...names?.get(botId) ?? []].sort()])]);
    const items: TodayItem[] = [];
    for (let index = 0; index < bots.length; index += 4) {
      const batch = await Promise.all(bots.slice(index, index + 4).map(async bot => {
        try {
          const events = page.events.filter(event => event.botId === bot.id && event.kind === 'completed' && event.runId);
          const unreadRuns = [...new Set(events.map(event => event.runId!))].sort();
          // An unchanged roster preview means no new message, so a settled assistant's recap is
          // reused and only its current state is read. History is read again after it changes.
          const key = JSON.stringify([bot.sessionId, bot.lastMessage, since, unreadRuns, events.map(event => event.id), privacy]);
          const cacheKey = `${userId}\0${bot.id}`;
          const cached = recaps.get(cacheKey);
          const reusable = cached?.key === key && Date.now() - cached.at < RECAP_MS ? cached.recap : undefined;
          const state = reusable && await runtime.conversation(bot.id, { history: false });
          let read, recap;
          if (reusable && state && settled(state.activity)) [read, recap] = [state, reusable];
          else {
            read = await runtime.conversation(bot.id);
            recap = summarize(read.messages.map(redact.message), events, new Set(unreadRuns), since);
            if (settled(read.activity) && store.privacyVersion === privacyVersion) recaps.set(cacheKey, { key, at: Date.now(), recap });
            else recaps.delete(cacheKey);
          }
          for (const [eventId, files] of recap.eventFiles) eventFiles.set(eventId, files);
          return { botId: bot.id, botName: bot.name, activity: read.activity,
            approvals: read.approvals.filter(approval => approval.status === 'pending'),
            attention: nameRequesters(read.attention, userId => store.getUser(userId)?.name) ?? [],
            ...(recap.latest ? { latestMessage: { ...recap.latest, text: redact.text(recap.latest.text) } } : {}),
            files: recap.files };
        } catch {
          return { botId: bot.id, botName: bot.name, activity: { state: 'disconnected' as const }, approvals: [], attention: [], files: [], error: 'Could not read this Hermes conversation. Open it to reconnect.' };
        }
      }));
      items.push(...batch);
    }
    for (const key of recaps.keys()) if (key.startsWith(`${userId}\0`) && !bots.some(bot => key === `${userId}\0${bot.id}`)) recaps.delete(key);
    const ids = new Set(bots.map(bot => bot.id));
    let upcoming: import("../shared/types.js").Routine[] = [];
    try { upcoming = (await runtime.routines()).filter(row => ids.has(row.botId) && row.enabled && row.nextRunAt).sort((a,b)=>Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!)).slice(0,10); } catch { /* The rest of Today remains useful during a scheduler outage. */ }
    const content = { since, frontier: page.frontier, hasMore: page.hasMore, items,
      events: page.events.filter(event => ids.has(event.botId)).map(event => ({ ...event, ...(eventFiles.has(event.id) ? { files: eventFiles.get(event.id) } : {}) })).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
      unavailableBots: items.filter(item => item.error).map(item => item.botId) };
    // The check time alone never makes Today new, so an unchanged recap revalidates as 304 and the
    // client keeps the body it holds, with the time that content was generated.
    reply.header('ETag', contentEtag([upcoming, content]));
    return { upcoming, generatedAt: now.toISOString(), ...content } satisfies TodayOverview;
  });
  apiRoute(app, "PUT /today/seen", { body: z.object({ seenAt: iso, frontier: z.string().regex(/^\d{1,16}$/) }).strict() }, async (req, { seenAt, frontier }) => {
    if (Date.parse(seenAt) > Date.now() + 60_000) throw httpError(400, 'Read time cannot be in the future');
    if (!Number.isSafeInteger(Number(frontier)) || Number(frontier) > store.latestEventFrontier()) throw httpError(400, 'The recap frontier is not a known ingestion position');
    store.markTodaySeen(signedIn(req).id, new Date(seenAt).toISOString(), Number(frontier));
    return { ok: true };
  });
  apiRoute(app, "GET /bots/:id/memory", {}, async req => request({ operation: 'memory', profile: z.object({ id }).parse(req.params).id }));
  const memorySave = z.object({ revision, entries: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/).optional(), text: z.string().trim().min(1).max(50000) }).strict()).max(100) }).strict();
  for (const route of ["PUT /bots/:id/memory/:target", "PATCH /bots/:id/memory/:target"] as const) apiRoute(app, route, { body: memorySave }, async (req, body) => {
    const params = z.object({ id, target }).parse(req.params);
    return request({ operation: 'save_memory', profile: params.id, target: params.target, ...body });
  });
  apiRoute(app, "DELETE /bots/:id/memory/:target", { body: z.object({ revision, entryId: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }, async (req, body) => {
    const params = z.object({ id, target }).parse(req.params);
    return request({ operation: 'delete_memory', profile: params.id, target: params.target, ...body });
  });
  apiRoute(app, "GET /routines/templates", {}, async () => routinePresets);
  apiRoute(app, "POST /routines/preview", { body: z.object({ botId: id, schedule: z.string().trim().min(1).max(500) }).strict() }, async (req, body) => {
    return request({ operation: 'preview', profile: body.botId, schedule: body.schedule });
  });
  const routine = async (routineId: string) => {
    const row = (await runtime.routines()).find(routine => routine.id === routineId);
    if (!row) throw httpError(404, 'Routine not found');
    return row;
  };
  apiRoute(app, "POST /routines/:id/run", { body: z.object({ requestId: z.string().uuid() }).strict() }, async (req, { requestId }) => {
    const params = z.object({ id }).parse(req.params);
    const userId = signedIn(req).id;
    const previous = store.routineTrial(requestId);
    if (previous && (previous.userId !== userId || previous.routineId !== params.id)) throw httpError(409, 'This trial request ID belongs to a different routine or person');
    const row = previous ? { botId: previous.botId, id: previous.routineId } : await routine(params.id);
    store.rememberRoutineTrial(requestId, userId, row.id, row.botId);
    const receipt = await request({ operation: 'run', profile: row.botId, routineId: row.id, requestId, senderId: userId });
    if ('status' in receipt) store.recordRoutineTrialStatus(requestId, receipt.status);
    return receipt;
  });
  apiRoute(app, "GET /routines/:id/runs/:requestId", {}, async req => {
    const params = z.object({ id, requestId: z.string().uuid() }).parse(req.params);
    const userId = signedIn(req).id;
    const row = store.routineTrial(params.requestId);
    if (!row || row.userId !== userId || row.routineId !== params.id) throw httpError(404, 'Trial receipt not found');
    const receipt = await request({ operation: 'run_receipt', profile: row.botId, routineId: row.routineId, requestId: params.requestId, senderId: userId });
    if ('status' in receipt) store.recordRoutineTrialStatus(params.requestId, receipt.status === 'uncertain' && receipt.ownerStatus === 'unknown' ? 'settled' : receipt.status);
    return receipt;
  });
  const cardState = async (req: import('fastify').FastifyRequest, state?: import('../shared/reply-cards.js').ReplyCardState) => {
    const params = z.object({ id, messageId: id, cardId: id }).parse(req.params);
    await bot(params.id);
    const redact = await redactAgents(store, roster, signedIn(req).id);
    const message = (await runtime.conversation(params.id)).messages.map(redact.message).find(message => message.id === params.messageId && isConversationReply(message));
    const card = message && replyCardsFromText(message.text).find(card => card.id === params.cardId);
    if (!card) throw httpError(404, 'This interactive reply is no longer in the Hermes conversation');
    const userId = signedIn(req).id;
    if (state) {
      if (!validReplyCardState(card, state)) throw httpError(400, 'The saved choices do not belong to this reply');
      store.saveCardState(userId, params.id, params.messageId, params.cardId, state);
      return state;
    }
    const saved = store.cardState(userId, params.id, params.messageId, params.cardId);
    return validReplyCardState(card, saved) ? saved : { checkedIds: [], notes: {} };
  };
  apiRoute(app, "GET /bots/:id/messages/:messageId/cards/:cardId/state", {}, async req => cardState(req));
  apiRoute(app, "PUT /bots/:id/messages/:messageId/cards/:cardId/state", { body: z.object({ checkedIds: z.array(id).max(60), notes: z.record(id, z.string().max(2000)) }).strict() }, async (req, state) => cardState(req, state));
}
