import { apiRoute } from "./api-route.js";
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signedIn } from './auth.js';
import type { Routine, Runtime } from '../shared/types.js';
import { GROUP_NOTES_MAX_BYTES, GROUP_PURPOSE_MAX, type GroupCatalog, type GroupEvent, type GroupPage, type GroupRequest, type GroupRoom, type GroupState } from '../shared/collaboration.js';
import type { Store } from './store.js';
import { notFound, redactAgents, Roster, visible, visibleBots } from './bot-access.js';
import { httpError } from './http-error.js';
import { id } from './schemas.js';
import { routineRun, runTime, type RoutineRun, type RoutineRunPage } from '../shared/routine-runs.js';
/** How long one read of an assistant's runs serves every viewer. */
export const RUNS_CACHE_MS = 5_000;
import { GroupLatestCache, previewOf } from './group-latest.js';
import type { CatalogRead } from './group-catalog-watch.js';
import type { DeliveryRooms } from './delivery-targets.js';
import { mentionsRoom, presentations, redactRooms, roomLeaks, type Presentation } from './routine-delivery.js';
const uuid = z.string().uuid();

/** Whether a room has only local assistants this person may see, as every group route requires. */
export function roomAccessible(room: GroupRoom, visible: (profile: string) => boolean) {
  return room.members?.length >= 2 && room.members.every(member => visible(member.profile) && (!member.target || member.target.kind === 'local'));
}

/**
 * The group chats one person can open, by ID, and whether routines can post in them on this Hermes. `all`
 * is every room Hermes lists and `assistants` every current assistant, for checking rooms they cannot see.
 */
export async function openableRooms(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, userId: string) {
  const catalog = runtime.groupRequest ? await runtime.groupRequest({ operation: 'list' }) as GroupCatalog : undefined;
  if (!catalog?.supported) return { supported: false, rooms: new Map<string, GroupRoom>(), all: new Map<string, GroupRoom>(), presentation: () => undefined, routineDelivery: false };
  const presentation = await presentations(runtime, store);
  const allowed = (profile: string) => { const bot = presentation(profile); return !!bot && visible(bot, userId); };
  return { rooms: new Map(catalog.rooms.filter(room => roomAccessible(room, allowed)).map(room => [room.room_id, room])),
    all: new Map(catalog.rooms.map(room => [room.room_id, room])), presentation, routineDelivery: catalog.routineDelivery === true, supported: true };
}

/** One person's view of routine and run errors: none that name a room they cannot open or an assistant they cannot see. */
async function errorRedactor(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, roster: Roster, userId: string, names: boolean) {
  const rooms = names ? await openableRooms(runtime, store, userId).then(open => new Set(open.rooms.keys()), () => undefined) : undefined;
  const agents = await redactAgents(store, roster, userId);
  return { rooms, text: (text: string) => agents.text(names ? redactRooms(text, rooms) : text) };
}

/**
 * A routine as one person sees it: only the group chats it posts in that they can open, and errors that
 * name no room they cannot open and no assistant they cannot see. Hermes is asked only when a routine posts
 * in a room or an error names one. If it cannot answer, those routines leave `roomIds` out, which clients
 * read as unknown: they neither show nor send rooms for it, so a save cannot drop one. Errors that name a
 * room are then replaced.
 */
export async function routinesFor<T extends Routine>(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, roster: Roster, userId: string, routines: T[]): Promise<T[]> {
  const touches = (routine: Routine) => !!routine.roomIds?.length || mentionsRoom(routine.lastError) || mentionsRoom(routine.lastDeliveryError);
  const errs = (routine: Routine) => routine.lastError !== undefined || routine.lastDeliveryError !== undefined;
  // Every target the delivery names is the server's to check, never anyone's to read.
  const listed = routines.map(({ delivery: _, nativeOverrides: __, ...routine }) => routine as T);
  if (!listed.some(routine => touches(routine) || errs(routine))) return listed;
  const redact = await errorRedactor(runtime, store, roster, userId, listed.some(touches));
  return listed.map(routine => {
    if (!touches(routine) && !errs(routine)) return routine;
    const { roomIds, ...rest } = routine;
    const errors = {
      ...(routine.lastError !== undefined ? { lastError: redact.text(routine.lastError) } : {}),
      ...(routine.lastDeliveryError !== undefined ? { lastDeliveryError: redact.text(routine.lastDeliveryError) } : {}),
    };
    if (!roomIds) return { ...routine, ...errors };
    return (redact.rooms ? { ...rest, ...errors, roomIds: roomIds.filter(id => redact.rooms!.has(id)) } : { ...rest, ...errors }) as T;
  });
}

/**
 * Refuses to let a routine deliver while any group chat it posts in could be opened by someone who cannot
 * see its assistant. A target written outside the app, by Hermes, its CLI, the dashboard or an agent, can
 * name such a room, and its owner may not even see it listed. Call it inside `serialDelivery` before
 * anything that makes the routine deliver: a save that leaves it enabled, resuming it and a trial run.
 * Pausing and deleting never need it.
 */
export async function assertDeliveryPrivate(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, botId: string, targets: DeliveryRooms | undefined) {
  const unknown = () => httpError(409, "WildBots couldn't read or check the group chats this routine posts in, so it stays as it was. Review its delivery in Hermes, or try again in a moment.", { code: 'routine_rooms_unknown' });
  // A routine or setting the app cannot read is refused, never waved through.
  assertMainOwnChat(store, botId, targets);
  if (!targets || targets.unknown) throw unknown();
  const roomIds = targets.rooms;
  if (!roomIds.length) return;
  if (!runtime.groupRequest) throw unknown();
  let open: Awaited<ReturnType<typeof openableRooms>>;
  try { open = await openableRooms(runtime, store, ''); }
  catch { throw unknown(); }
  // Without Hermes's room catalog nobody can say who opens these rooms.
  if (!open.supported) throw unknown();
  const bot = open.presentation(botId);
  if (roomIds.some(roomId => { const room = open.all.get(roomId); return !!room && roomLeaks(bot, room, open.presentation); }))
    throw httpError(409, "This routine posts in a group chat that people who can't see its assistant could open, so it can't run. Pause it, or have someone who can open that group chat remove it from the routine.", { code: 'routine_rooms' });
}

/** Whether a routine's deliveries, as Hermes would make them, reach only its own assistant's chat, or nowhere. */
export function ownChatOnly(botId: string, targets: DeliveryRooms | undefined) {
  return !!targets && !targets.unknown && !targets.outward && !targets.rooms.length && (targets.chats ?? []).every(chat => chat === botId);
}

/**
 * A main assistant's routines deliver only to its own chat: never another assistant's chat, a group chat
 * or anywhere outside WildBots, through every route that saves, resumes or runs one. What it reads, such
 * as its member's calendar and email, then reaches nobody else. Other assistants' routine deliveries are as
 * Hermes has them, a known limit taken up separately (docs/HouseholdExperience.md#privacy-limits).
 */
export const isMainAssistant = (store: Store, botId: string) => store.users().some(user => store.preferences(user.id).mainBotId === botId);
export function assertMainOwnChat(store: Store, botId: string, targets: DeliveryRooms | undefined) {
  if (!isMainAssistant(store, botId)) return;
  if (!ownChatOnly(botId, targets)) throw httpError(409, "A main assistant's routines post only in its own chat. Change where this routine delivers.", { code: 'routine_chats' });
}

/** Routine run errors as one person sees them, by the same rules as `routinesFor`. */
async function runErrorsFor<T extends { error?: string }>(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, roster: Roster, userId: string, rows: T[]): Promise<T[]> {
  if (!rows.some(row => row.error !== undefined)) return rows;
  const redact = await errorRedactor(runtime, store, roster, userId, rows.some(row => mentionsRoom(row.error)));
  return rows.map(row => row.error !== undefined ? { ...row, error: redact.text(row.error) } : row);
}

/**
 * The group chats a saved routine will post in: those this person chose, which they must be able to open,
 * plus any it already posts in that they cannot see. `current` is the routine's rooms as Hermes has them
 * now, read in this turn of `serialDelivery`, so an earlier save or sharing change in the queue is never
 * undone. Every room in the result is checked against the current sharing, including the ones kept
 * unseen, by `assertDeliveryPrivate` before the save. Undefined when nothing changes.
 */
export async function routineRooms(runtime: Pick<Runtime, 'groupRequest' | 'listBots'>, store: Store, userId: string,
  input: { botId: string; roomIds?: string[] }, current?: string[]): Promise<string[] | undefined> {
  if (input.roomIds === undefined) return undefined;
  const chosen = [...new Set(input.roomIds)];
  const open = await openableRooms(runtime, store, userId).catch(error => {
    if (chosen.length) throw error;
    return { supported: false, rooms: new Map<string, GroupRoom>(), all: new Map<string, GroupRoom>(), presentation: (): Presentation | undefined => undefined, routineDelivery: false };
  });
  if (chosen.length && !open.routineDelivery) throw httpError(409, 'This Hermes version cannot post routine results in group chats.');
  if (chosen.some(roomId => !open.rooms.has(roomId))) throw httpError(400, 'Choose group chats you can open.');
  // The same rule a sharing change checks again: nobody who cannot see the assistant may open the room.
  const presentation = open.presentation;
  const bot = presentation(input.botId);
  if (chosen.some(roomId => roomLeaks(bot, open.rooms.get(roomId)!, presentation))) throw httpError(400, 'Choose a group chat with one of your personal assistants, so only you see these results.', { code: 'private_recipients' });
  // Rooms it already posts in keep their place; newly chosen ones follow.
  const before = current ?? [];
  const rooms = [...before.filter(roomId => !open.rooms.has(roomId) || chosen.includes(roomId)), ...chosen.filter(roomId => !before.includes(roomId))];
  return current && JSON.stringify(rooms) === JSON.stringify(current) ? undefined : rooms;
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
    return runErrorsFor(runtime, store, roster, signedIn(req).id, await runtime.routineResults(p.botId, p.routineId));
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
    // A check-in that found something is its own message in the chat, and one that found nothing says
    // nothing, so only a check-in that went wrong shows as a run card.
    const checkIn = (run: RoutineRun) => store.checkIns.isCheckIn(botId, run.routineId) && run.status !== "failed" && !run.deliveryFailed;
    const redact = await redactAgents(store, roster, signedIn(req).id);
    return { unavailable: page.unavailable, runs: await runErrorsFor(runtime, store, roster, signedIn(req).id, page.runs.filter(run => runTime(run) >= from && !checkIn(run)).map(run => ({
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
  // One person's catalog: the rooms they may open, each with its newest message worded for them.
  function present(userId: string, value: GroupCatalog, rooms: GroupRoom[]): GroupCatalog {
    return { ...value, rooms: rooms.map(room => {
      const event = latest.latest(room.room_id);
      if (!event) return room;
      const senders = event.kind === 'message.user' ? store.groupSenders(room.room_id, [event.event_id]) : new Map<string, string>();
      const sender = senders.get(event.event_id);
      return { ...room, latest: previewOf(sender ? { ...event, sender: { id: sender, name: store.getUser(sender)?.name ?? '' } } : event, room, userId, other => store.getUser(other)?.name) };
    }) };
  }
  app.get('/api/groups', async req => {
    if (!runtime.groupRequest) return { supported: false, canSend: false, rooms: [], reason: 'Hosted group chats are unavailable on this Hermes integration.' } satisfies GroupCatalog;
    const userId = signedIn(req).id;
    const allowed = new Set((await bots(userId)).map(bot => bot.id));
    const value = await request({ operation: 'list' }) as GroupCatalog;
    const rooms = value.rooms.filter(room => accessible(room, allowed));
    await latest.refresh(rooms, value.rooms);
    return present(userId, value, rooms);
  });
  /**
   * One read of the roster and the room catalog for everyone watching, for the household stream's
   * `groups` notice. It answers what home shows of each person's `GET /api/groups`: everything but
   * each room's `latest_seq`, which also moves for driver notices that change no row.
   */
  const catalogRead: CatalogRead | undefined = runtime.groupRequest ? async userIds => {
    const [roster, value] = await Promise.all([runtime.listBots(), request({ operation: 'list' }) as Promise<GroupCatalog>]);
    const allowedFor = (userId: string) => new Set(roster.filter(bot => visible({ ...bot, ...store.presentation(bot.id) }, userId)).map(bot => bot.id));
    const roomsFor = (userId: string) => { const allowed = allowedFor(userId); return value.rooms.filter(room => accessible(room, allowed)); };
    await latest.refresh([...new Map(userIds.flatMap(roomsFor).map(room => [room.room_id, room])).values()], value.rooms);
    return userId => {
      const catalog = present(userId, value, roomsFor(userId));
      return JSON.stringify({ ...catalog, rooms: catalog.rooms.map(({ latest_seq: _, ...room }) => room) });
    };
  } : undefined;
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
  return { room, catalogRead };
}
