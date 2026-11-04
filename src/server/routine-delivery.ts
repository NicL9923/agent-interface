import type { GroupCatalog, GroupRoom } from "../shared/collaboration.js";
import type { Routine, Runtime } from "../shared/types.js";
import { visible } from "./bot-access.js";
import { httpError } from "./http-error.js";
import type { Store } from "./store.js";

// Where routines post their results in group chats must never reach someone who cannot see the
// routine's assistant. The rule is checked when a routine's rooms are chosen and again whenever an
// assistant's sharing changes, since that changes who can open a room.

type Presentation = { shared?: boolean; ownerId?: string };

/**
 * Whether a routine of an assistant with this sharing would show its results to someone who cannot see
 * that assistant, by posting in this room. A room opens for whoever sees all its members. Only a personal
 * assistant with an owner is hidden from anyone, and the people who might open the room are someone with
 * no assistants of their own in it, who sees the shared and older personal ones, and each owner of a
 * personal member.
 */
export function roomLeaks(bot: Presentation, room: GroupRoom, presentation: (botId: string) => Presentation): boolean {
  if (bot.shared !== false || !bot.ownerId) return false;
  const members = room.members.map(member => presentation(member.profile));
  const viewers = new Set<string | undefined>([undefined, ...members.map(member => member.shared === false ? member.ownerId : undefined)]);
  viewers.delete(bot.ownerId);
  return [...viewers].some(viewer => members.every(member => visible(member, viewer)));
}

const chains = new WeakMap<object, Promise<unknown>>();
/**
 * Runs routine room saves and sharing changes one at a time, so neither checks against a state the other
 * is about to change. One app server owns the store, so an in-process queue is enough.
 */
export function serialDelivery<T>(store: Store, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(store) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(store, next.catch(() => undefined));
  return next;
}

/**
 * Refuses a sharing change that would let a routine post where people who cannot see its assistant read
 * it. Refusing, rather than quietly dropping or pausing deliveries, keeps every routine as its owner set
 * it and changes nothing in Hermes; the message says which routine to change first. Routines and rooms
 * the person cannot see are not named.
 */
export async function assertSharingKeepsRoutinesPrivate(runtime: Runtime, store: Store, userId: string, botId: string, next: Presentation) {
  const before = store.presentation(botId);
  if (!runtime.groupRequest || (before.shared !== false) === (next.shared !== false) && before.ownerId === next.ownerId) return;
  const unreadable = () => httpError(409, "WildBots couldn't check which group chats this household's routines post in, so the sharing stayed as it was. Try again in a moment.", { code: "routine_rooms_unknown" });
  let routines: Routine[];
  try { routines = (await runtime.routines()).filter(routine => routine.roomIds?.length); }
  catch { throw unreadable(); }
  if (!routines.length) return;
  let catalog: GroupCatalog;
  try { catalog = await runtime.groupRequest({ operation: "list" }) as GroupCatalog; }
  catch { throw unreadable(); }
  const rooms = new Map((catalog.supported ? catalog.rooms : []).map(room => [room.room_id, room]));
  const after = (id: string) => id === botId ? next : store.presentation(id);
  const conflicts = routines.flatMap(routine => routine.roomIds!.flatMap(roomId => {
    const room = rooms.get(roomId);
    return room && roomLeaks(after(routine.botId), room, after) ? [{ routine, room }] : [];
  }));
  if (!conflicts.length) return;
  const now = (id: string) => store.presentation(id);
  const named = conflicts.map(({ routine, room }) => {
    const routineName = visible(now(routine.botId), userId) ? `"${routine.name}"` : "another member's routine";
    const roomName = room.members.every(member => visible(now(member.profile), userId)) ? `"${room.name}"` : "a group chat";
    return `${routineName} posts in ${roomName}`;
  });
  throw httpError(409, `This would let people who can't see an assistant read its routine results: ${[...new Set(named)].join("; ")}. Remove those group chats from the routines, then try again.`,
    { code: "routine_rooms" });
}

const roomToken = /room:([A-Za-z0-9][A-Za-z0-9._:-]*)(@[A-Za-z0-9_-]+)?/gi;
/**
 * Hides the group chats someone cannot open from Hermes text such as a routine's delivery error, which
 * names its target as `room:<id>[@<profile>]`. With no list of rooms, every room is hidden.
 */
export function redactRooms(text: string, open: ReadonlySet<string> | undefined): string {
  return text.replace(roomToken, (token, id: string) => {
    const bare = id.replace(/:+$/, "");
    return open?.has(bare) ? token : `a group chat${id.slice(bare.length)}`;
  });
}
export const mentionsRoom = (text: unknown) => typeof text === "string" && /room:/i.test(text);
