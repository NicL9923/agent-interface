import { apiRoute } from "./api-route.js";
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signedIn } from './auth.js';
import type { Routine, Runtime } from '../shared/types.js';
import { GROUP_NOTES_MAX_BYTES, GROUP_PURPOSE_MAX, type GroupCatalog, type GroupEvent, type GroupPage, type GroupRequest, type GroupRoom, type GroupState } from '../shared/collaboration.js';
import type { Store } from './store.js';
import { notFound, redactAgents, Roster, visibleBots } from './bot-access.js';
import { httpError } from './http-error.js';
import { id } from './schemas.js';
import { routineRun, runTime, type RoutineRun, type RoutineRunPage } from '../shared/routine-runs.js';
/** How long one read of an assistant's runs serves every viewer. */
export const RUNS_CACHE_MS = 5_000;
import { GroupLatestCache, previewOf } from './group-latest.js';
import { mentionsRoom, redactRooms, roomLeaks } from './routine-delivery.js';
const uuid = z.string().uuid();

/** Whether a room has only local assistants this person may see, as every group route requires. */
export function roomAccessible(room: GroupRoom, visible: (profile: string) => boolean) {
  return room.members?.length >= 2 && room.members.every(member => visible(member.profile) && (!member.target || member.target.kind === 'local'));
}

/** The group chats one person can open, by ID, and whether routines can post in them on this Hermes. */
export async function openableRooms(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, userId: string) {
  const catalog = runtime.groupRequest ? await runtime.groupRequest({ operation: 'list' }) as GroupCatalog : undefined;
  if (!catalog?.supported) return { rooms: new Map<string, GroupRoom>(), routineDelivery: false };
  const allowed = new Set((await visibleBots(runtime, store, userId)).map(bot => bot.id));
  return { rooms: new Map(catalog.rooms.filter(room => roomAccessible(room, profile => allowed.has(profile))).map(room => [room.room_id, room])),
    routineDelivery: catalog.routineDelivery === true };
}

/**
 * A routine as one person sees it: only the group chats it posts in that they can open, and errors that
 * name only those. Hermes is asked only when a routine posts in a room or an error names one. If it cannot
 * answer, those routines leave `roomIds` out, which clients read as unknown: they neither show nor send
 * rooms for it, so a save cannot drop one. Their errors then name no room at all.
 */
export async function routinesFor<T extends Routine>(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, userId: string, routines: T[]): Promise<T[]> {
  const touches = (routine: Routine) => !!routine.roomIds?.length || mentionsRoom(routine.lastError) || mentionsRoom(routine.lastDeliveryError);
  if (!routines.some(touches)) return routines;
  const rooms = await openableRooms(runtime, store, userId).then(open => new Set(open.rooms.keys()), () => undefined);
  return routines.map(routine => {
    if (!touches(routine)) return routine;
    const { roomIds, ...rest } = routine;
    const errors = {
      ...(routine.lastError !== undefined ? { lastError: redactRooms(routine.lastError, rooms) } : {}),
      ...(routine.lastDeliveryError !== undefined ? { lastDeliveryError: redactRooms(routine.lastDeliveryError, rooms) } : {}),
    };
    if (!roomIds) return { ...routine, ...errors };
    return (rooms ? { ...rest, ...errors, roomIds: roomIds.filter(id => rooms.has(id)) } : { ...rest, ...errors }) as T;
  });
}

/** Hides from one person the rooms they cannot open in routine run errors. Hermes is asked only when an error names a room. */
async function runErrorsFor<T extends { error?: string }>(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, userId: string, rows: T[]): Promise<T[]> {
  if (!rows.some(row => mentionsRoom(row.error))) return rows;
  const rooms = await openableRooms(runtime, store, userId).then(open => new Set(open.rooms.keys()), () => undefined);
  return rows.map(row => mentionsRoom(row.error) ? { ...row, error: redactRooms(row.error!, rooms) } : row);
}

/**
 * The group chats a saved routine will post in: those this person chose, which they must be able to open,
 * plus any it already posts in that they cannot see. A personal assistant's results go only to rooms that
 * nobody else can open, in practice rooms with one of its owner's personal assistants. Undefined when
 * nothing changes. Call it inside `serialDelivery`, so a sharing change cannot pass between check and save.
 */
export async function routineRooms(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, userId: string,
  input: { botId: string; roomIds?: string[] }, previous?: string[]): Promise<string[] | undefined> {
  if (input.roomIds === undefined) return undefined;
  const chosen = [...new Set(input.roomIds)];
  const open = await openableRooms(runtime, store, userId).catch(error => {
    if (chosen.length) throw error;
    return { rooms: new Map<string, GroupRoom>(), routineDelivery: false };
  });
  if (chosen.length && !open.routineDelivery) throw httpError(409, 'This Hermes version cannot post routine results in group chats.');
  if (chosen.some(roomId => !open.rooms.has(roomId))) throw httpError(400, 'Choose group chats you can open.');
  // The same rule a sharing change checks again: nobody who cannot see the assistant may open the room.
  const presentation = (botId: string) => store.presentation(botId);
  if (chosen.some(roomId => roomLeaks(presentation(input.botId), open.rooms.get(roomId)!, presentation))) throw httpError(400, 'Choose a group chat with one of your personal assistants, so only you see these results.', { code: 'private_recipients' });
  // Rooms it already posts in keep their place; newly chosen ones follow.
  const before = previous ?? [];
  const rooms = [...before.filter(roomId => !open.rooms.has(roomId) || chosen.includes(roomId)), ...chosen.filter(roomId => !before.includes(roomId))];
  return previous && JSON.stringify(rooms) === JSON.stringify(previous) ? undefined : rooms;
}

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
    return runErrorsFor(runtime, store, signedIn(req).id, await runtime.routineResults(p.botId, p.routineId));
  });
  // Every run of one assistant's routines, for its conversation. Hermes reads one routine at a
  // time, so a read is shared for a few seconds across viewers and polls; access and redaction
  // stay per request.
  const runReads = new Map<string, { at: number; value: Promise<RoutineRunPage> }>();
  function assistantRuns(botId: string) {
    const cached = runReads.get(botId);
    if (cached && Date.now() - cached.at < RUNS_CACHE_MS) return cached.value;
    const value = (async () => {
      const routines = (await runtime.routines()).filter(routine => routine.botId === botId);
      const runs: RoutineRun[] = [], unavailable: string[] = [];
      for (let index = 0; index < routines.length; index += 4) await Promise.all(routines.slice(index, index + 4).map(async routine => {
        try { runs.push(...(await runtime.routineResults!(botId, routine.id)).map(result => routineRun(routine, result))); }
        catch { unavailable.push(routine.id); }
      }));
      return { runs: runs.filter(run => !Number.isNaN(runTime(run))).sort((a, b) => runTime(a) - runTime(b)), unavailable };
    })();
    runReads.set(botId, { at: Date.now(), value });
    value.catch(() => { if (runReads.get(botId)?.value === value) runReads.delete(botId); });
    return value;
  }
  apiRoute(app, "GET /bots/:botId/routine-runs", {}, async req => {
    const { botId } = z.object({ botId: id }).parse(req.params);
    const { since } = z.object({ since: z.string().datetime({ offset: true }).optional() }).strict().parse(req.query);
    await profile(signedIn(req).id, botId);
    if (!runtime.routineResults) throw httpError(409, 'Routine history is unavailable on this Hermes integration.');
    const page = await assistantRuns(botId);
    const from = since ? Date.parse(since) : -Infinity;
    const redact = await redactAgents(store, roster, signedIn(req).id);
    return { unavailable: page.unavailable, runs: await runErrorsFor(runtime, store, signedIn(req).id, page.runs.filter(run => runTime(run) >= from).map(run => ({
      ...run, preview: run.preview === undefined ? undefined : redact.text(run.preview), error: run.error === undefined ? undefined : redact.text(run.error) }))) };
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
  const accessible = (room: GroupRoom, allowed: Set<string>) => roomAccessible(room, profile => allowed.has(profile));
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
  // Home previews each room's newest message. One cache serves everyone, since the log is the same; only the author wording is per viewer.
  const latest = new GroupLatestCache((roomId, since) => request({ operation: 'log', roomId, since }) as Promise<GroupPage>);
  app.get('/api/groups', async req => {
    if (!runtime.groupRequest) return { supported: false, canSend: false, rooms: [], reason: 'Hosted group chats are unavailable on this Hermes integration.' } satisfies GroupCatalog;
    const userId = signedIn(req).id;
    const allowed = new Set((await bots(userId)).map(bot => bot.id));
    const value = await request({ operation: 'list' }) as GroupCatalog;
    const rooms = value.rooms.filter(room => accessible(room, allowed));
    await latest.refresh(rooms, value.rooms);
    return { ...value, rooms: rooms.map(room => {
      const event = latest.latest(room.room_id);
      if (!event) return room;
      const senders = event.kind === 'message.user' ? store.groupSenders(room.room_id, [event.event_id]) : new Map<string, string>();
      const sender = senders.get(event.event_id);
      return { ...room, latest: previewOf(sender ? { ...event, sender: { id: sender, name: store.getUser(sender)?.name ?? '' } } : event, room, userId, other => store.getUser(other)?.name) };
    }) };
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
  // Anyone who can open the room may set its purpose, shared notes and lead, as anyone may message it.
  app.post('/api/groups/:roomId/context', async req => {
    const { roomId } = z.object({ roomId: id }).parse(req.params);
    const body = z.object({
      requestId: uuid,
      purpose: z.string().max(GROUP_PURPOSE_MAX),
      // Hermes counts the trimmed notes in UTF-8 bytes.
      notes: z.string().max(GROUP_NOTES_MAX_BYTES * 4).refine(notes => Buffer.byteLength(notes.trim(), 'utf8') <= GROUP_NOTES_MAX_BYTES, "Shared notes are too long. Shorten them and try again."),
      leadMemberId: id.nullable(),
    }).strict().parse(req.body);
    const userId = signedIn(req).id;
    const state = await room(userId, roomId);
    if (body.leadMemberId !== null && !state.room.members.some(member => member.member_id === body.leadMemberId))
      throw httpError(400, "Choose a lead from this group's assistants.");
    // Like a message, one person's retry is the same save, and two people's saves never share a key.
    const requestId = `context:${createHash('sha256').update(JSON.stringify([userId, body.requestId])).digest('hex')}`;
    return request({ operation: 'context', roomId, requestId, purpose: body.purpose, notes: body.notes,
      routing: body.leadMemberId === null ? 'everyone' : 'lead', leadMemberId: body.leadMemberId ?? '' });
  });
  app.post('/api/groups/:roomId/approve', async req => {
    const { roomId } = z.object({ roomId: id }).parse(req.params);
    const body = z.object({ taskId: id, memberId: id, generation: z.number().int().min(1), choice: z.enum(['once', 'deny']), requestId: id }).strict().parse(req.body);
    await room(signedIn(req).id, roomId);
    return request({ operation: 'approve', roomId, ...body });
  });
  return { room };
}
