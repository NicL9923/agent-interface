import { expect, it } from 'vitest';
import { activityAction } from '../src/shared/activity-sentence';
import { assignmentText, groupStatus, memberActivity, scheduledPost } from '../src/shared/group-activity';
import { routineRoomChoices, type GroupDriverStatus, type GroupEvent } from '../src/shared/collaboration';
import { deliverRooms, withDeliverRooms } from '../src/server/hermes-mapping';
import { previewOf } from '../src/server/group-latest';
import { redactRooms, roomLeaks } from '../src/server/routine-delivery';

it("names a routine's post in a room by its routine, never as a household member", () => {
  const post = (actor: Record<string, string>, extra: Partial<GroupEvent> = {}) =>
    ({ event_id: 'p', seq: 1, kind: 'message.user', created_at: 0, actor: { kind: 'user', ...actor } as GroupEvent['actor'], payload: { text: 'Gate is shut' }, ...extra }) as GroupEvent;
  expect(scheduledPost(post({ id: 'cron:job-1', display_name: '[bot:ranch] Morning brief' }))).toEqual({ name: 'Morning brief', failed: false });
  expect(scheduledPost(post({ id: 'cron-notice:job-1', display_name: 'Morning brief' }))).toEqual({ name: 'Morning brief', failed: true });
  expect(scheduledPost(post({ id: 'cron:job-1' }))).toEqual({ name: 'Routine', failed: false });
  // A person's message keeps its sender, whatever its actor says.
  expect(scheduledPost(post({ id: 'cron:job-1' }, { sender: { id: 'one', name: 'Nicolas' } }))).toBeNull();
  expect(scheduledPost(post({ id: 'desktop' }))).toBeNull();
  const room = { room_id: 'r', name: 'R', members: [] };
  expect(previewOf(post({ id: 'cron:job-1', display_name: '[bot:ranch] Morning brief' }), room, 'one', () => undefined).author).toBe('Morning brief');
  expect(previewOf(post({ id: 'desktop' }), room, 'one', () => undefined).author).toBe('Household member');
});

it('finds who could read a routine post that cannot see its assistant', () => {
  const room = (profiles: string[]) => ({ room_id: 'r', name: 'R', members: profiles.map(profile => ({ member_id: profile, profile, handle: profile })) });
  const people: Record<string, { shared?: boolean; ownerId?: string }> = { open: { shared: true }, mine: { shared: false, ownerId: 'one' }, theirs: { shared: false, ownerId: 'two' }, old: { shared: false } };
  const of = (id: string) => people[id] ?? {};
  expect(roomLeaks(of('open'), room(['open', 'theirs']), of)).toBe(false);
  expect(roomLeaks(of('mine'), room(['open', 'old']), of)).toBe(true);
  expect(roomLeaks(of('mine'), room(['open', 'mine']), of)).toBe(false);
  // Someone else's personal assistant in the room lets its owner in, who cannot see "mine".
  expect(roomLeaks(of('mine'), room(['open', 'theirs']), of)).toBe(true);
  expect(redactRooms('room:a: gone; room:b@x failed; room:a:b ok', new Set(['a']))).toBe('room:a: gone; a group chat failed; a group chat ok');
});

const members = [
  { member_id: 'ranch', profile: 'ranch', handle: 'ranch', display_name: 'Ranch hand' },
  { member_id: 'planner', profile: 'planner', handle: 'planner', display_name: 'Planner' },
  { member_id: 'cook', profile: 'cook', handle: 'cook' },
];
const driver = (member_activity: GroupDriverStatus['member_activity'], max_rounds: number | null = 3): GroupDriverStatus =>
  ({ running: true, working: !!member_activity?.length, blocked: false, pending_actions: [], member_activity, max_rounds });

it('says who is working in Simple and adds the tool and round in Advanced', () => {
  const status = driver([
    { member_id: 'planner', status: 'running', round_index: 1, tool: 'web_search', started_at: 1, progress_at: 2 },
    { member_id: 'cook', status: 'queued', round_index: 1 },
  ]);
  expect(memberActivity(status, members, false)).toEqual([
    { memberId: 'planner', sentence: 'Planner is working...' },
    { memberId: 'cook', sentence: 'cook is waiting to start...' },
  ]);
  expect(memberActivity(status, members, true)).toEqual([
    { memberId: 'planner', sentence: 'Planner is using web_search...', round: 'Round 2 of 3' },
    { memberId: 'cook', sentence: 'cook is waiting to start...', round: 'Round 2 of 3' },
  ]);
});

it('gives each assistant one line, from its running turn, and words missing details plainly', () => {
  const status = driver([
    { member_id: 'ranch', status: 'queued', round_index: 2 },
    { member_id: 'ranch', status: 'running', round_index: 1, tool: '  ' },
    { member_id: 'planner', status: 'stopping', round_index: 0, tool: 'terminal' },
    { member_id: 'gone', status: 'running' },
  ], null);
  expect(memberActivity(status, members, true)).toEqual([
    { memberId: 'ranch', sentence: 'Ranch hand is working...', round: 'Round 2' },
    { memberId: 'planner', sentence: 'Planner is stopping...', round: 'Round 1' },
    { memberId: 'gone', sentence: 'gone is working...' },
  ]);
  expect(memberActivity(undefined, members, true)).toEqual([]);
});

it('keeps the single-assistant working sentence for every state', () => {
  expect(activityAction('working', 'Using terminal.')).toBe('using terminal');
  expect(activityAction('working', 'Using terminal', { connectionLost: true })).toBe('reconnecting');
  expect(activityAction('thinking', 'Using terminal')).toBe('thinking');
  expect(activityAction('idle', undefined, { offline: true })).toBe('offline');
});

it('words the composer hint for attention, older Hermes and a lead', () => {
  expect(groupStatus({ ...driver([]), blocked: true }, undefined, members)).toBe('Discussion needs attention.');
  // Older Hermes says only that the room is working.
  expect(groupStatus({ running: true, working: true, blocked: false, pending_actions: [] }, undefined, members)).toBe('Assistants are discussing…');
  expect(groupStatus(driver([{ member_id: 'ranch', status: 'running' }]), undefined, members)).toBe('Type @ to address one assistant.');
  const lead = { purpose: '', notes: '', routing: 'lead' as const, lead_member_id: 'planner' };
  expect(groupStatus(undefined, lead, members)).toBe('Type @ to address one assistant. Otherwise Planner picks who answers.');
  expect(groupStatus(undefined, { ...lead, routing: 'everyone' }, members)).toBe('Type @ to address one assistant.');
});

it("words the lead's hand-offs and ignores other events", () => {
  const event = (payload: Record<string, unknown>, kind = 'room.assignment') =>
    ({ event_id: 'e', seq: 1, kind, created_at: 0, actor: { kind: 'gateway', id: 'g' }, payload }) as GroupEvent;
  expect(assignmentText(event({ lead_member_id: 'planner', member_ids: ['ranch', 'cook'] }), members)).toBe('Planner gave this to Ranch hand and cook.');
  expect(assignmentText(event({ lead_member_id: 'planner', member_ids: ['planner'], fallback: true }), members)).toBe('Planner took this one.');
  expect(assignmentText(event({ lead_member_id: 'planner', member_ids: ['planner', 'ranch'] }), members)).toBe('Planner is answering this with Ranch hand.');
  expect(assignmentText(event({ lead_member_id: 'planner', member_ids: [] }), members)).toBeNull();
  expect(assignmentText(event({ text: 'Hi' }, 'message.user'), members)).toBeNull();
});

it("reads and rewrites only the app's room targets in a routine's delivery", () => {
  expect(deliverRooms('bot-chat:ranch, room:dinner,room:team@other,ROOM:dinner')).toEqual(['dinner']);
  expect(deliverRooms(['bot-chat:ranch', 'room:a'])).toEqual(['a']);
  expect(deliverRooms(undefined)).toEqual([]);
  expect(withDeliverRooms('bot-chat:ranch,room:old,room:team@other,telegram', ['new', 'new'])).toBe('bot-chat:ranch,room:team@other,telegram,room:new');
  expect(withDeliverRooms('local', ['a'])).toBe('room:a');
  expect(withDeliverRooms('room:a', [])).toBe('local');
});

it("offers a personal assistant's routine only rooms its owner alone can open", () => {
  const room = (room_id: string, profiles: string[]) => ({ room_id, name: room_id, members: profiles.map(profile => ({ member_id: profile, profile, handle: profile })) });
  const catalog = { supported: true, canSend: true, routineDelivery: true, rooms: [room('open', ['ranch', 'planner']), room('mine', ['ranch', 'diary'])] };
  const bots = [{ id: 'ranch', shared: true }, { id: 'planner', shared: true }, { id: 'diary', shared: false, ownerId: 'one' }];
  expect(routineRoomChoices(catalog, bots[0], bots).map(row => row.room_id)).toEqual(['open', 'mine']);
  expect(routineRoomChoices(catalog, bots[2], bots).map(row => row.room_id)).toEqual(['mine']);
  expect(routineRoomChoices({ ...catalog, routineDelivery: false }, bots[0], bots)).toEqual([]);
});
