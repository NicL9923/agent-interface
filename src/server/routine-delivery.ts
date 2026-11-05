import type { GroupCatalog, GroupRoom } from "../shared/collaboration.js";
import type { Routine, Runtime } from "../shared/types.js";
import { visible } from "./bot-access.js";
import { httpError } from "./http-error.js";
import { routineTargets } from "./delivery-targets.js";
import type { Store } from "./store.js";

// Where routines post their results in group chats must never reach someone who cannot see the
// routine's assistant. The rule is checked when a routine's rooms are chosen and again whenever an
// assistant's sharing changes, since that changes who can open a room.

export type Presentation = { shared?: boolean; ownerId?: string };

/**
 * Who can see each current assistant, as every group route decides it: the app's record over what Hermes
 * reports. Undefined for an ID that is no assistant now, such as a deleted one.
 */
export async function presentations(runtime: Pick<Runtime, "listBots">, store: Store) {
  const bots = new Map((await runtime.listBots()).map(bot => [bot.id, bot]));
  return (botId: string): Presentation | undefined => {
    const bot = bots.get(botId);
    return bot && { shared: bot.shared, ownerId: bot.ownerId, ...store.presentation(botId) };
  };
}

/**
 * Whether a routine of an assistant with this sharing would show its results to someone who cannot see
 * that assistant, by posting in this room. A room opens, as every group route decides, for whoever sees all
 * its members, and for nobody while a member is not a current local assistant (`presentation` answers
 * undefined, as for a deleted one) or lives on another Hermes. Only a personal assistant with an owner is
 * hidden from anyone, and the people who might open the room are someone with no assistants of their own
 * in it, who sees the shared and older personal ones, and each owner of a personal member.
 */
export function roomLeaks(bot: Presentation | undefined, room: GroupRoom, presentation: (botId: string) => Presentation | undefined): boolean {
  if (!bot || bot.shared !== false || !bot.ownerId) return false;
  if (room.members.some(member => member.target && member.target.kind !== "local")) return false;
  const members = room.members.map(member => presentation(member.profile));
  if (members.some(member => !member)) return false;
  const seen = members as Presentation[];
  const viewers = new Set<string | undefined>([undefined, ...seen.map(member => member.shared === false ? member.ownerId : undefined)]);
  viewers.delete(bot.ownerId);
  return [...viewers].some(viewer => seen.every(member => visible(member, viewer)));
}

const chains = new WeakMap<object, Promise<unknown>>();
/**
 * Runs the changes that decide who can read a routine's group chat posts one at a time: routine room
 * saves, sharing changes, and creating and deleting assistants. None then checks against a state another
 * is about to change. One app server owns the store, so an in-process queue is enough.
 */
export function serialDelivery<T>(store: Store, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(store) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(store, next.catch(() => undefined));
  return next;
}

/**
 * Refuses a change to an assistant that would let a routine post where people who cannot see its
 * assistant read it: a sharing change, or creating an assistant whose ID a room still lists from an
 * earlier one, which opens that room again. Refusing, rather than quietly dropping or pausing deliveries,
 * keeps every routine as its owner set it and changes nothing in Hermes; the message says which routine
 * to change first. Routines and rooms the person cannot see are not named.
 *
 * Deleting an assistant needs no check: a room that lists a deleted assistant opens for nobody, so a
 * deletion only closes rooms. Room rosters never change after creation (Hermes has no member edit), and
 * leaving or disbanding a room only stops its posts.
 */
export async function assertRoutinesStayPrivate(runtime: Runtime, store: Store, userId: string, botId: string, next: Presentation) {
  if (!runtime.groupRequest) return;
  const unreadable = () => httpError(409, "WildBots couldn't check which group chats this household's routines post in, so nothing changed. Try again in a moment.", { code: "routine_rooms_unknown" });
  let current: (botId: string) => Presentation | undefined;
  try { current = await presentations(runtime, store); }
  catch { throw unreadable(); }
  const before = current(botId);
  // A sharing change that keeps who can see the assistant changes no room.
  if (before && (before.shared !== false) === (next.shared !== false) && before.ownerId === next.ownerId) return;
  let routines: Routine[];
  let targets: Map<Routine, string[]>;
  try {
    // Every room each routine posts in, from every delivery field Hermes honors (src/server/delivery-targets.ts).
    targets = new Map((await runtime.routines()).map(routine => {
      const found = routineTargets(routine);
      if (found.unknown) throw unreadable();
      return [routine, found.rooms] as const;
    }).filter(([, rooms]) => rooms.length));
    routines = [...targets.keys()];
  }
  catch { throw unreadable(); }
  if (!routines.length) return;
  let catalog: GroupCatalog;
  try { catalog = await runtime.groupRequest({ operation: "list" }) as GroupCatalog; }
  catch { throw unreadable(); }
  const rooms = new Map((catalog.supported ? catalog.rooms : []).map(room => [room.room_id, room]));
  const after = (id: string) => id === botId ? next : current(id);
  const conflicts = routines.flatMap(routine => targets.get(routine)!.flatMap(roomId => {
    const room = rooms.get(roomId);
    return room && roomLeaks(after(routine.botId), room, after) ? [{ routine, room }] : [];
  }));
  if (!conflicts.length) return;
  const sees = (id: string) => { const bot = current(id); return !!bot && visible(bot, userId); };
  const named = conflicts.map(({ routine, room }) => {
    const routineName = sees(routine.botId) ? `"${routine.name}"` : "another member's routine";
    const roomName = room.members.every(member => sees(member.profile)) ? `"${room.name}"` : "a group chat";
    return `${routineName} posts in ${roomName}`;
  });
  throw httpError(409, `This would let people who can't see an assistant read its routine results: ${[...new Set(named)].join("; ")}. Remove those group chats from the routines, then try again.`,
    { code: "routine_rooms" });
}

const roomToken = /room:([A-Za-z0-9][A-Za-z0-9._:-]*)(@[A-Za-z0-9_-]+)?/gi;
export const hiddenRoomError = "Couldn't post in a group chat you can't open.";
/**
 * A routine or run error as someone sees it. Hermes names a group chat target as `room:<id>[@<profile>]`
 * and can repeat the profile elsewhere in the text, as in "@diary does not host it."
 * (cron/scheduler_delivery_room.py), so an error that names any room this person cannot open is replaced
 * whole. With no list of rooms, every room is one they cannot open.
 */
export function redactRooms(text: string, open: ReadonlySet<string> | undefined): string {
  const hidden = [...text.matchAll(roomToken)].some(([, id]) => !open?.has(id.replace(/:+$/, "")));
  return hidden ? hiddenRoomError : text;
}
export const mentionsRoom = (text: unknown) => typeof text === "string" && /room:/i.test(text);
