import { apiRoute } from "./api-route.js";
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signedIn } from './auth.js';
import type { Runtime } from '../shared/types.js';
import type { GroupCatalog, GroupEvent, GroupPage, GroupRequest, GroupRoom, GroupState } from '../shared/collaboration.js';
import type { Store } from './store.js';
import { notFound, redactAgents, Roster, visibleBots } from './bot-access.js';
import { httpError } from './http-error.js';
import { id } from './schemas.js';
const uuid = z.string().uuid();

export async function installCollaborationRoutes(app: FastifyInstance, runtime: Runtime, store: Store, roster = new Roster(runtime)) {
  // A group with someone else's private assistant does not exist for this person: its
  // other assistants' replies would quote and answer the private one.
  const bots = (userId: string) => visibleBots(runtime, store, userId);
  async function profile(userId: string, botId: string) {
    if (!(await bots(userId)).some(bot => bot.id === botId)) throw httpError(404, notFound.error, { code: notFound.code });
  }
  apiRoute(app, "GET /bots/:botId/routines/:routineId/results", {}, async req => {
    const p = z.object({ botId: id, routineId: id }).parse(req.params);
    await profile(signedIn(req).id, p.botId);
    if (!runtime.routineResults) throw httpError(409, 'Routine history is unavailable on this Hermes integration.');
    return runtime.routineResults(p.botId, p.routineId);
  });
  apiRoute(app, "GET /bots/:botId/routines/:routineId/results/:resultId", {}, async req => {
    const p = z.object({ botId: id, routineId: id, resultId: id }).parse(req.params);
    await profile(signedIn(req).id, p.botId);
    if (!runtime.routineOutput) throw httpError(409, 'Routine output is unavailable on this Hermes integration.');
    const output = await runtime.routineOutput(p.botId, p.routineId, p.resultId);
    const redact = await redactAgents(store, roster, signedIn(req).id);
    return { ...output, messages: output.messages.map(redact.message) };
  });
  async function request(input: GroupRequest) {
    if (!runtime.groupRequest) throw httpError(409, 'Hosted group chats are unavailable on this Hermes integration.');
    return runtime.groupRequest(input);
  }
  function accessible(room: GroupRoom, allowed: Set<string>) {
    return room.members?.length >= 2 && room.members.every(member => allowed.has(member.profile) && (!member.target || member.target.kind === 'local'));
  }
  async function room(userId: string, roomId: string) {
    const allowed = new Set((await bots(userId)).map(bot => bot.id));
    const state = await request({ operation: 'state', roomId }) as GroupState;
    if (!accessible(state.room, allowed)) throw httpError(404, 'Group chat not found');
    return state;
  }
  // Labels each human message with the household member who sent it here, when one is on record.
  function attributed(roomId: string, page: GroupPage): GroupPage {
    if (!Array.isArray(page.events)) return page;
    const senders = store.groupSenders(roomId, page.events.filter(event => event.kind === 'message.user').map(event => event.event_id));
    return { ...page, events: page.events.map(event => {
      const user = event.kind === 'message.user' ? store.getUser(senders.get(event.event_id) ?? '') : undefined;
      return user ? { ...event, sender: { id: user.id, name: user.name } } : event;
    }) };
  }
  app.get('/api/groups', async req => {
    if (!runtime.groupRequest) return { supported: false, canSend: false, rooms: [], reason: 'Hosted group chats are unavailable on this Hermes integration.' } satisfies GroupCatalog;
    const allowed = new Set((await bots(signedIn(req).id)).map(bot => bot.id));
    const value = await request({ operation: 'list' }) as GroupCatalog;
    return { ...value, rooms: value.rooms.filter(room => accessible(room, allowed)) };
  });
  app.post('/api/groups', async req => {
    const body = z.object({ requestId: uuid, name: z.string().trim().min(1).max(100), botIds: z.array(id).min(2).max(6).refine(ids => new Set(ids).size === ids.length) }).strict().parse(req.body);
    const allowed = await bots(signedIn(req).id);
    const members = body.botIds.map(botId => {
      const bot = allowed.find(bot => bot.id === botId);
      if (!bot || ['all', 'everyone'].includes(bot.id.toLowerCase())) throw httpError(400, 'Choose local assistants with unique, non-reserved handles.');
      return { member_id: bot.id, profile: bot.id, handle: bot.id, display_name: bot.name };
    });
    return request({ operation: 'create', roomId: body.requestId, name: body.name, members });
  });
  app.get('/api/groups/:roomId', async req => room(signedIn(req).id, z.object({ roomId: id }).parse(req.params).roomId));
  app.get('/api/groups/:roomId/log', async req => {
    const { roomId } = z.object({ roomId: id }).parse(req.params);
    const { since, state } = z.object({ since: z.coerce.number().int().min(0).default(0), state: z.literal('1').optional() }).strict().parse(req.query);
    // The access check already reads the room, so `state=1` returns it too: one poll, one Hermes state call.
    const current = await room(signedIn(req).id, roomId);
    const log = attributed(roomId, await request({ operation: 'log', roomId, since }) as GroupPage);
    return state ? { ...log, state: current } : log;
  });
  app.post('/api/groups/:roomId/messages', async req => {
    const { roomId } = z.object({ roomId: id }).parse(req.params);
    const body = z.object({ requestId: uuid, text: z.string().trim().min(1).max(16000), threadId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict().parse(req.body);
    const userId = signedIn(req).id;
    await room(userId, roomId);
    // Separate household send keys without inventing a native actor or changing model text.
    const requestId = createHash('sha256').update(JSON.stringify([userId, body.requestId])).digest('hex');
    const sent = await request({ operation: 'send', roomId, ...body, requestId }) as { event?: GroupEvent };
    // Hermes names the event it appended; a lost or older response leaves the message unattributed.
    if (typeof sent.event?.event_id === 'string' && sent.event.kind === 'message.user') store.attributeGroupMessage(roomId, sent.event.event_id, userId);
    return sent;
  });
  app.post('/api/groups/:roomId/stop', async req => {
    const { roomId } = z.object({ roomId: id }).parse(req.params);
    const { requestId } = z.object({ requestId: uuid }).strict().parse(req.body);
    await room(signedIn(req).id, roomId);
    return request({ operation: 'stop', roomId, requestId });
  });
  app.post('/api/groups/:roomId/approve', async req => {
    const { roomId } = z.object({ roomId: id }).parse(req.params);
    const body = z.object({ taskId: id, memberId: id, generation: z.number().int().min(1), choice: z.enum(['once', 'deny']), requestId: id }).strict().parse(req.body);
    await room(signedIn(req).id, roomId);
    return request({ operation: 'approve', roomId, ...body });
  });
}
