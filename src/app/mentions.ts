import type { GroupMember } from "../shared/collaboration";

/** The `@handle` being typed just before the caret, if any. An @ inside a word, like an email, is not one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|[\s([{])@([\w.-]{0,63})$/u.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]! };
}

/** Members whose handle or name starts with the query, handles first. */
export function matchMembers(members: readonly GroupMember[], query: string) {
  const q = query.toLowerCase();
  const name = (member: GroupMember) => (member.display_name || member.profile).toLowerCase();
  const byHandle = members.filter(member => member.handle.toLowerCase().startsWith(q));
  const byName = members.filter(member => !byHandle.includes(member)
    && name(member).split(/\s+/).some(word => word.startsWith(q)));
  return [...byHandle, ...byName];
}

/** Replaces the typed `@partial` with the full handle and a space, and says where the caret goes. */
export function insertMention(text: string, mention: { start: number; query: string }, handle: string) {
  const end = mention.start + 1 + mention.query.length;
  const after = text.slice(end);
  const insert = `@${handle}${after.startsWith(" ") ? "" : " "}`;
  const next = text.slice(0, mention.start) + insert + after;
  return { text: next, caret: mention.start + insert.length + (after.startsWith(" ") ? 1 : 0) };
}
