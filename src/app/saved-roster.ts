import type { GroupMember, GroupRoom } from "../shared/collaboration";
import { defaultPreferences, type Avatar, type Bootstrap, type Bot, type Preferences } from "../shared/types";
import { hintedUser } from "./account-epoch";
import { localRead, localRemove, localSave, savedRosterKey } from "./storage";

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

const text = (value: unknown): value is string => typeof value === "string";
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const avatarModes = new Set(["geometric", "mascot", "portrait"]);
// Avatar renders whatever shape a release stored; an unknown mode or a portrait not from the app's
// own files would make it draw something the server never said.
const savedAvatar = (value: unknown) => value === undefined
  || record(value) && avatarModes.has(value.mode as string) && (value.mode !== "portrait" || text(value.src) && value.src.startsWith("/api/files/"));
const savedBot = (value: unknown): value is SavedBot =>
  record(value) && text(value.id) && text(value.name) && typeof value.shared === "boolean" && savedAvatar(value.avatar);
const savedMember = (value: unknown): value is SavedMember =>
  record(value) && text(value.member_id) && text(value.profile) && text(value.handle) && (value.display_name === undefined || text(value.display_name));
const savedRoom = (value: unknown): value is SavedRoom =>
  record(value) && text(value.room_id) && text(value.name) && Array.isArray(value.members) && value.members.every(savedMember);
const savedSection = (value: unknown) => record(value) && text(value.id) && text(value.name) && texts(value.botIds);
const savedOrder = (value: unknown): value is Order => record(value) && texts(value.favorites)
  && Array.isArray(value.sections) && value.sections.every(savedSection)
  && (value.mainBotId === undefined || text(value.mainBotId))
  && (value.mainSuggestionDismissed === undefined || typeof value.mainSuggestionDismissed === "boolean");

/** The saved copy as stored, if it is one this release understands. Its account is not checked here. */
export function parseSavedRoster(value: unknown): SavedRoster | null {
  if (!record(value) || value.v !== SAVED_ROSTER_VERSION || !text(value.user)) return null;
  const me = value.me;
  if (!record(me) || !text(me.name) || me.picture !== undefined && !text(me.picture)) return null;
  if (!Array.isArray(value.bots) || !value.bots.length || !value.bots.every(savedBot)) return null;
  if (!savedOrder(value.order) || !Array.isArray(value.rooms) || !value.rooms.every(savedRoom)) return null;
  return value as SavedRoster;
}

/** The saved home of the account this browser's sign-in names, or nothing. */
export function readSavedRoster(): SavedRoster | null {
  const user = hintedUser();
  if (!user) return null;
  const saved = parseSavedRoster(localRead(savedRosterKey));
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

/** Group chats from the saved copy, field by field, with no latest message. */
export const savedRooms = (saved: SavedRoster): GroupRoom[] => saved.rooms.map(({ room_id, name, members }) => ({
  room_id, name, members: members.map(({ member_id, profile, handle, display_name }) => ({ member_id, profile, handle, ...display_name ? { display_name } : {} })),
}));

/**
 * Keeps what home shows now, from a bootstrap that reached Hermes. `rooms` is home's group chats in
 * order, or null before the group catalog has loaded, which keeps the rooms already saved for this
 * account. Saved only for the account the sign-in hint names, and only when something changed.
 */
export function rememberRoster(boot: HomeSource, rooms: GroupRoom[] | null) {
  if (hintedUser() !== boot.user.id || !boot.bots.length) return localRemove(savedRosterKey);
  const previous = parseSavedRoster(localRead(savedRosterKey));
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
    })) })) ?? (previous?.user === boot.user.id ? previous.rooms : []),
  };
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
  localSave(savedRosterKey, next);
}
