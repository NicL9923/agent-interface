import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signedIn } from './auth.js';
import type { Runtime } from '../shared/types.js';
import type { GroupCatalog, GroupRequest, GroupRoom, GroupState } from '../shared/collaboration.js';
import type { Store } from './store.js';
const id = z.string().min(1).max(200);
const uuid = z.string().uuid();
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export async function installCollaborationRoutes(app: FastifyInstance, runtime: Runtime, store: Store) {
  async function bots(userId: string) {
    return (await runtime.listBots()).map(bot => ({ ...bot, ...store.presentation(bot.id) }))
      .filter(bot => bot.shared || !bot.ownerId || bot.ownerId === userId);
  }
  async function profile(userId: string, botId: string) {
    if (!(await bots(userId)).some(bot => bot.id === botId)) throw fail(404, 'Assistant not found');
  }
  app.get('/api/bots/:botId/routines/:routineId/results', async req => {
    const p = z.object({ botId: id, routineId: id }).parse(req.params);
    await profile(signedIn(req).id, p.botId);
    if (!runtime.routineResults) throw fail(409, 'Routine history is unavailable on this Hermes integration.');
    return runtime.routineResults(p.botId, p.routineId);
  });
  app.get('/api/bots/:botId/routines/:routineId/results/:resultId', async req => {
    const p = z.object({ botId: id, routineId: id, resultId: id }).parse(req.params);
    await profile(signedIn(req).id, p.botId);
    if (!runtime.routineOutput) throw fail(409, 'Routine output is unavailable on this Hermes integration.');
    return runtime.routineOutput(p.botId, p.routineId, p.resultId);
  });
  async function request(input: GroupRequest) {
    if (!runtime.groupRequest) throw fail(409, 'Hosted group chats are unavailable on this Hermes integration.');
    return runtime.groupRequest(input);
  }
  function accessible(room: GroupRoom, allowed: Set<string>) {
    return room.members?.length >= 2 && room.members.every(member => allowed.has(member.profile) && (!member.target || member.target.kind === 'local'));
  }
  async function room(userId: string, roomId: string) {
    const allowed = new Set((await bots(userId)).map(bot => bot.id));
    const state = await request({ operation: 'state', roomId }) as GroupState;
    if (!accessible(state.room, allowed)) throw fail(404, 'Group chat not found');
    return state;
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
      if (!bot || ['all', 'everyone'].includes(bot.id.toLowerCase())) throw fail(400, 'Choose local assistants with unique, non-reserved handles.');
      return { member_id: bot.id, profile: bot.id, handle: bot.id, display_name: bot.name };
    });
    return request({ operation: 'create', roomId: body.requestId, name: body.name, members });
  });
  app.get('/api/groups/:roomId', async req => room(signedIn(req).id, z.object({ roomId: id }).parse(req.params).roomId));
  app.get('/api/groups/:roomId/log', async req => {
    const { roomId } = z.object({ roomId: id }).parse(req.params);
    const { since } = z.object({ since: z.coerce.number().int().min(0).default(0) }).strict().parse(req.query);
    await room(signedIn(req).id, roomId);
    return request({ operation: 'log', roomId, since });
  });
  app.post('/api/groups/:roomId/messages', async req => {
    const { roomId } = z.object({ roomId: id }).parse(req.params);
    const body = z.object({ requestId: uuid, text: z.string().trim().min(1).max(16000), threadId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict().parse(req.body);
    const userId = signedIn(req).id;
    await room(userId, roomId);
    // Separate household send keys without inventing a native actor or changing model text.
    const requestId = createHash('sha256').update(JSON.stringify([userId, body.requestId])).digest('hex');
    return request({ operation: 'send', roomId, ...body, requestId });
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
