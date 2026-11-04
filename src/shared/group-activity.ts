import { activityAction } from './activity-sentence.js';
import type { GroupContext, GroupDriverStatus, GroupEvent, GroupMember } from './collaboration.js';

// What a group chat says about its assistants' live work, its lead and the lead's hand-offs.
// Pure, so the web and the server's tests read the same rules. ios/AgentInterface/GroupActivity.swift mirrors this file.

export function memberName(members: GroupMember[], id: unknown): string {
  const member = members.find(member => member.member_id === id);
  return member?.display_name || member?.profile || (typeof id === 'string' && id) || 'Assistant';
}

/** Names joined as a sentence says them: "Ada", "Ada and Ben", "Ada, Ben and Cy". */
export function nameList(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
}

export interface MemberActivityLine {
  memberId: string;
  /** The working line, such as "Ada is using web_search...". */
  sentence: string;
  /** Advanced presentation only: "Round 2 of 3". */
  round?: string;
}

/**
 * One line for each assistant with live work in the room, in the order Hermes admitted it. Simple
 * presentation says who is working. Advanced adds the tool each one is in and its round, as a single
 * assistant's chat shows its current tool only in Advanced detail.
 */
export function memberActivity(status: GroupDriverStatus | undefined, members: GroupMember[], advanced: boolean): MemberActivityLine[] {
  const seen = new Set<string>();
  return (status?.member_activity ?? []).flatMap(activity => {
    // One assistant can hold a queued turn behind its running one; the running one says what it is doing.
    if (seen.has(activity.member_id)) return [];
    seen.add(activity.member_id);
    const rows = status!.member_activity!.filter(row => row.member_id === activity.member_id);
    const current = rows.find(row => row.status === 'running') ?? rows.find(row => row.status === 'stopping') ?? activity;
    const tool = advanced && current.status === 'running' && current.tool?.trim() ? current.tool.trim() : undefined;
    const action = current.status === 'queued' ? 'waiting to start'
      : current.status === 'stopping' ? 'stopping'
      : activityAction('working', tool && `Using ${tool}`);
    const index = current.round_index;
    const max = status!.max_rounds;
    const round = advanced && typeof index === 'number' && index >= 0
      ? typeof max === 'number' && max > 0 ? `Round ${index + 1} of ${max}` : `Round ${index + 1}`
      : undefined;
    return [{ memberId: activity.member_id, sentence: `${memberName(members, activity.member_id)} is ${action}...`, ...(round ? { round } : {}) }];
  });
}

/** The lead assistant's name, when the room sends unaddressed messages to its lead first. */
export function leadName(context: GroupContext | undefined, members: GroupMember[]): string | undefined {
  if (context?.routing !== 'lead' || !context.lead_member_id) return undefined;
  return memberName(members, context.lead_member_id);
}

/** The hint under the group composer. Live work has its own lines, so this only says how to address the room. */
export function groupStatus(status: GroupDriverStatus | undefined, context: GroupContext | undefined, members: GroupMember[]): string {
  if (status?.blocked) return 'Discussion needs attention.';
  // Hermes versions without per-member activity only say that the room is working.
  if (status?.working && !status.member_activity?.length) return 'Assistants are discussing…';
  const lead = leadName(context, members);
  return lead ? `Type @ to address one assistant. Otherwise ${lead} picks who answers.` : 'Type @ to address one assistant.';
}

/** The lead's hand-off of a message nobody was named in (`room.assignment`), or null for another event. */
export function assignmentText(event: GroupEvent, members: GroupMember[]): string | null {
  if (event.kind !== 'room.assignment') return null;
  const lead = event.payload.lead_member_id;
  const chosen = Array.isArray(event.payload.member_ids) ? event.payload.member_ids.filter((id): id is string => typeof id === 'string') : [];
  if (typeof lead !== 'string' || !chosen.length) return null;
  const name = memberName(members, lead), others = nameList(chosen.filter(id => id !== lead).map(id => memberName(members, id)));
  if (!others) return `${name} took this one.`;
  return chosen.includes(lead) ? `${name} is answering this with ${others}.` : `${name} gave this to ${others}.`;
}
