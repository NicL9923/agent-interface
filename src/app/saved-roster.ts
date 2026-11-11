import type { GroupMember, GroupRoom } from "../shared/collaboration";
import { avatarAccessories, avatarEyes, avatarShapes, defaultPreferences, mascotFamilies, type Avatar, type Bootstrap, type Bot, type Preferences } from "../shared/types";
import { hintedUser } from "./account-epoch";
import { localRemove, localSave, savedRosterKey } from "./storage";

/**
 * The last home this device showed a signed-in person, kept so the next visit can draw it at once
 * instead of waiting for bootstrap. It holds what home draws and nothing that is said in a chat:
 *
 * - `me`: the person's name, for their initials, and their picture's address, for the account button.
 * - `bots`: each assistant's ID, name, avatar and whether it is shared, in bootstrap's order. That is
 *   the roster bootstrap already gives this person, so another member's personal assistant is here
 *   only if bootstrap lists it for them.
 * - `order`: pinned assistants, sections and their names, the main assistant, and whether the person
 *   put off choosing one, which together set where each row sits.
 * - `rooms`: each group chat's ID, name and members, for its faces, in home's order.
 *
 * It leaves out the latest messages and their times, unread marks, activity, the connection, the
 * person's email and every other preference. What the copy cannot know is never drawn from it.
 * It belongs to one account and is shown only while the sign-in hint names that account; it goes
 * with the hint (see accountKeys). A value of another version is not read.
 */
export const SAVED_ROSTER_VERSION = 1;
type SavedBot = Pick<Bot, "id" | "name" | "shared"> & { avatar?: Avatar };
type SavedMember = Pick<GroupMember, "member_id" | "profile" | "handle" | "display_name">;
type SavedRoom = { room_id: string; name: string; members: SavedMember[] };
type Order = Pick<Preferences, "favorites" | "sections" | "mainBotId" | "mainSuggestionDismissed">;
export type SavedRoster = {
  v: typeof SAVED_ROSTER_VERSION;
  user: string;
  me: { name: string; picture?: string };
  bots: SavedBot[];
  order: Order;
  rooms: SavedRoom[];
};
/** What home draws, from bootstrap or from the saved copy. */
export type HomeSource = Pick<Bootstrap, "user" | "bots" | "preferences">;

// Every bound is the server's own for the same field where it has one, so a copy bootstrap could have
// produced passes and anything else is not this release's: an assistant's name as botInput takes it, a
// section's as preferences do (src/server/schemas.ts), and a group's as the group route does
// (src/server/collaboration.ts). The server sets none for the account's name, from the sign-in
// provider, nor for a group member's, from Hermes, so those keep a generous one.
/** The stored text, at most; a larger value is not read at all. */
export const MAX_SAVED_CHARS = 200_000;
export const LIMITS = { id: 200, botName: 100, sectionName: 100, roomName: 100, name: 255, url: 2048, bots: 300, rooms: 100, members: 50, sections: 30, sectionBots: 100, favorites: 100 } as const;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const id = (value: unknown): value is string => text(value, LIMITS.id) && value.length > 0;
const ids = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(id);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown, max: number, item: (value: unknown) => boolean) => Array.isArray(value) && value.length <= max && value.every(item);
const oneOf = (values: readonly string[]) => (value: unknown) => typeof value === "string" && values.includes(value);
// What Avatar reads of each kind, each field as the server accepts it, so a stored avatar can never
// make it draw something the server never said, nor throw.
const scale = (value: unknown) => value === undefined || typeof value === "number" && value >= 0.6 && value <= 1.5;
const face = (value: Record<string, unknown>) => typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color)
  && oneOf(avatarEyes)(value.eyes) && oneOf(avatarAccessories)(value.accessory)
  && scale(value.eyeWidth) && scale(value.eyeHeight) && scale(value.eyeSpacing);
const savedAvatar = (value: unknown) => value === undefined || record(value) && (
  value.mode === "geometric" ? oneOf(avatarShapes)(value.shape) && face(value)
  : value.mode === "mascot" ? oneOf(mascotFamilies)(value.family) && face(value)
  : value.mode === "portrait" && text(value.src, LIMITS.url) && value.src.startsWith("/api/files/") && oneOf(["uploaded", "generated"])(value.origin));
const savedBot = (value: unknown): value is SavedBot =>
  record(value) && id(value.id) && text(value.name, LIMITS.botName) && value.name.length > 0 && typeof value.shared === "boolean" && savedAvatar(value.avatar);
const savedMember = (value: unknown): value is SavedMember => record(value) && id(value.member_id) && id(value.profile) && id(value.handle)
  && (value.display_name === undefined || text(value.display_name, LIMITS.name));
const savedRoom = (value: unknown): value is SavedRoom =>
  record(value) && id(value.room_id) && text(value.name, LIMITS.roomName) && value.name.trim().length > 0 && list(value.members, LIMITS.members, savedMember);
const savedSection = (value: unknown) => record(value) && id(value.id) && text(value.name, LIMITS.sectionName) && ids(value.botIds, LIMITS.sectionBots);
const savedOrder = (value: unknown): value is Order => record(value) && ids(value.favorites, LIMITS.favorites)
  && list(value.sections, LIMITS.sections, savedSection)
  && (value.mainBotId === undefined || id(value.mainBotId))
  && (value.mainSuggestionDismissed === undefined || typeof value.mainSuggestionDismissed === "boolean");
// The account button shows the picture bootstrap gave, an https address.
const picture = (value: unknown) => value === undefined || text(value, LIMITS.url) && value.startsWith("https://");

/** The saved copy as stored, if it is one this release understands. Its account is not checked here. */
export function parseSavedRoster(value: unknown): SavedRoster | null {
  if (!record(value) || value.v !== SAVED_ROSTER_VERSION || !id(value.user)) return null;
  const me = value.me;
  if (!record(me) || !text(me.name, LIMITS.name) || !picture(me.picture)) return null;
  if (!Array.isArray(value.bots) || !value.bots.length || !list(value.bots, LIMITS.bots, savedBot)) return null;
  if (!savedOrder(value.order) || !list(value.rooms, LIMITS.rooms, savedRoom)) return null;
  return value as SavedRoster;
}
/** The stored copy, unread when larger than any this release writes. */
function storedRoster() {
  let raw: string | null = null;
  try { raw = localStorage.getItem(savedRosterKey); } catch { return null; }
  if (raw === null || raw.length > MAX_SAVED_CHARS) return null;
  try { return parseSavedRoster(JSON.parse(raw)); } catch { return null; }
}

/** The saved home of the account this browser's sign-in names, or nothing. */
export function readSavedRoster(): SavedRoster | null {
  const user = hintedUser();
  if (!user) return null;
  const saved = storedRoster();
  return saved?.user === user ? saved : null;
}

/**
 * Home's input from the saved copy, field by field: nothing about activity, messages or unread is
 * known, so none is given, even from a copy that holds more than this release writes.
 */
export function savedHome(saved: SavedRoster): HomeSource {
  const { favorites, sections, mainBotId, mainSuggestionDismissed } = saved.order;
  return {
    user: { id: saved.user, name: saved.me.name, email: "", ...saved.me.picture ? { picture: saved.me.picture } : {} },
    bots: saved.bots.map(({ id, name, shared, avatar }) => ({ id, name, shared, ...avatar ? { avatar } : {}, model: "", activity: "idle" })),
    preferences: { ...defaultPreferences, favorites, sections, mainBotId, mainSuggestionDismissed },
  };
}

/**
 * The saved rooms whose every member is an assistant in `bots`, the roster bootstrap just gave, when
 * there is one: a room with an assistant this person can no longer use is not theirs to see.
 */
const usable = (rooms: SavedRoom[], bots?: { id: string }[]) =>
  bots ? rooms.filter(room => room.members.every(member => bots.some(bot => bot.id === member.member_id))) : rooms;
/** Group chats from the saved copy, field by field, with no latest message, kept to `bots` when given. */
export const savedRooms = (saved: SavedRoster, bots?: { id: string }[]): GroupRoom[] => usable(saved.rooms, bots).map(({ room_id, name, members }) => ({
  room_id, name, members: members.map(({ member_id, profile, handle, display_name }) => ({ member_id, profile, handle, ...display_name ? { display_name } : {} })),
}));

/**
 * Keeps what home shows now, from a bootstrap that reached Hermes. `rooms` is home's group chats in
 * order, or null before the group catalog has loaded, which keeps the rooms already saved for this
 * account. Saved only for the account the sign-in hint names, and only when something changed.
 */
export function rememberRoster(boot: HomeSource, rooms: GroupRoom[] | null) {
  if (hintedUser() !== boot.user.id || !boot.bots.length) return localRemove(savedRosterKey);
  const previous = storedRoster();
  const next: SavedRoster = {
    v: SAVED_ROSTER_VERSION,
    user: boot.user.id,
    me: { name: boot.user.name, ...boot.user.picture ? { picture: boot.user.picture } : {} },
    bots: boot.bots.map(bot => ({ id: bot.id, name: bot.name, shared: bot.shared, ...bot.avatar ? { avatar: bot.avatar } : {} })),
    order: {
      favorites: boot.preferences.favorites,
      sections: boot.preferences.sections.map(section => ({ id: section.id, name: section.name, botIds: section.botIds })),
      ...boot.preferences.mainBotId ? { mainBotId: boot.preferences.mainBotId } : {},
      ...boot.preferences.mainSuggestionDismissed ? { mainSuggestionDismissed: true } : {},
    },
    rooms: rooms?.map(room => ({ room_id: room.room_id, name: room.name, members: room.members.map(member => ({
      member_id: member.member_id, profile: member.profile, handle: member.handle,
      ...member.display_name ? { display_name: member.display_name } : {},
    })) })) ?? (previous?.user === boot.user.id ? usable(previous.rooms, boot.bots) : []),
  };
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
  // A home past any bound would not be read back, so nothing is kept rather than a copy that never draws.
  if (!parseSavedRoster(next) || JSON.stringify(next).length > MAX_SAVED_CHARS) return localRemove(savedRosterKey);
  localSave(savedRosterKey, next);
}
