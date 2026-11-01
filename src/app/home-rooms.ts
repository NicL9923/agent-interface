import type { GroupMember, GroupRoom } from "../shared/collaboration";
import type { Bot } from "../shared/types";
import { groupCreateKey, localRead } from "./storage";

const time = (value: string | undefined) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Group chats in home order. Assistant rows keep the roster's order and never jump while a
 * reply arrives, so rooms do the same within their own run: after the assistants, the room
 * with the newest message first. A room with no message yet keeps the catalog's order after
 * those that have one.
 */
export function orderRooms(rooms: GroupRoom[]): GroupRoom[] {
  return rooms.map((room, index) => ({ room, index, at: time(room.latest?.at) }))
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.index - b.index)
    .map(item => item.room);
}

/** The row's second line: who spoke last and what they said, or a plain note for a room nobody has spoken in. */
export function roomPreview(room: GroupRoom) {
  const latest = room.latest;
  return latest?.text ? `${latest.author}: ${latest.text}` : "No messages yet";
}

/** Up to three members to show as faces, in the room's order, with only the assistants this person can see. */
export function roomFaces(room: GroupRoom, bots: Bot[]): { member: GroupMember; bot?: Bot }[] {
  return room.members.slice(0, 3).map(member => ({ member, bot: bots.find(bot => bot.id === member.member_id) }));
}

/** The members in words, such as "Ranch hand, Planner and Kitchen companion". */
export function memberNames(room: GroupRoom) {
  const names = room.members.map(member => member.display_name || member.profile);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
}

/** A saved request to create a group whose outcome is unknown, which home offers to finish. */
export type PendingGroup = { requestId: string; name: string; botIds: string[] };
export function pendingGroup(userId: string): PendingGroup | null {
  const saved = localRead<PendingGroup>(groupCreateKey(userId));
  return saved && typeof saved.requestId === "string" && typeof saved.name === "string" && Array.isArray(saved.botIds) ? saved : null;
}
