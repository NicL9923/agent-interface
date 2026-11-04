import type { Message } from './types.js';

export interface RoutineResult {
  id: string;
  title: string;
  startedAt?: string;
  preview?: string;
  previewOnly: boolean;
  /** Older add-ons omit these; read a missing status as "unknown". */
  status?: import('./routine-runs.js').RoutineRunStatus;
  finishedAt?: string;
  /** The run finished but Hermes could not deliver its output. */
  deliveryFailed?: boolean;
  error?: string;
}
export interface RoutineOutput { messages: Message[]; previewOnly: boolean }
export interface GroupMember { member_id: string; profile: string; handle: string; display_name?: string; target?: { kind: string; profile: string } }
/** The newest message in a room, as the catalog previews it on home. `author` is already worded for the viewer, such as "You". */
export interface GroupLatest { text: string; at: string; author: string }
export interface GroupRoom { room_id: string; name: string; members: GroupMember[]; latest_seq?: number; latest?: GroupLatest }
export interface GroupEvent {
  event_id: string; seq: number; kind: string; created_at: number;
  actor: { kind: string; id: string };
  payload: Record<string, unknown>;
  /** The household member who sent a message.user event through this app. Absent when unknown. */
  sender?: { id: string; name: string };
}
export interface GroupAction {
  kind: string; task_id: string; member_id?: string; execution_generation?: number;
  request_id?: string; description?: string; command?: string;
  approval?: { request_id?: string; description?: string; command?: string };
}
/**
 * One assistant's live work in a room, from Hermes `groups.state`. `status` is queued, running or stopping.
 * `round_index` is 0-based. `tool` is the tool it is in now, reported only by the process running the turn.
 * Older Hermes versions send no activity.
 */
export interface GroupMemberActivity {
  member_id: string; status: string; thread_id?: string | null; round_index?: number | null;
  started_at?: number | null; tool?: string | null; progress_at?: number | null;
}
export type GroupRouting = 'everyone' | 'lead';
/**
 * The room's purpose and shared notes, which every member's turn reads from the next message on, and who
 * answers a message that names no one: every member, or the lead, who passes it on.
 */
export interface GroupContext { purpose: string; notes: string; routing: GroupRouting; lead_member_id: string }
/** Hermes's limits for room settings (gateway/hosted_room_context.py). Notes count UTF-8 bytes. */
export const GROUP_PURPOSE_MAX = 500;
export const GROUP_NOTES_MAX_BYTES = 4096;
/** A room ID a routine can name as `room:<id>` (cron/scheduler_delivery_room.py). */
export const routineRoomId = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export interface GroupDriverStatus {
  running: boolean; working: boolean; blocked: boolean; pending_actions: GroupAction[];
  member_activity?: GroupMemberActivity[];
  /** How many rounds a discussion may take. Older Hermes versions omit it. */
  max_rounds?: number | null;
}
export interface GroupState {
  room: GroupRoom;
  driver_status?: GroupDriverStatus;
  /** Absent from Hermes versions without room settings, and for a disbanded room. */
  context?: GroupContext;
}
export interface GroupPage { events: GroupEvent[]; cursor: number; latest_seq: number; has_more: boolean }
export interface GroupCatalog {
  supported: boolean; canSend: boolean; reason?: string; rooms: GroupRoom[];
  /** Hermes saves a room's purpose, shared notes and lead. Older servers omit it. */
  settings?: boolean;
  /** Routines can post their results in a group chat. Older servers omit it. */
  routineDelivery?: boolean;
}
export type GroupRequest =
  | { operation: 'list' }
  | { operation: 'create'; roomId: string; name: string; members: GroupMember[] }
  | { operation: 'state'; roomId: string }
  | { operation: 'log'; roomId: string; since: number }
  | { operation: 'send'; roomId: string; requestId: string; text: string; threadId: string }
  | { operation: 'stop'; roomId: string; requestId: string }
  | { operation: 'approve'; roomId: string; taskId: string; memberId: string; generation: number; choice: 'once' | 'deny'; requestId: string }
  | { operation: 'context'; roomId: string; requestId: string; purpose: string; notes: string; routing: GroupRouting; leadMemberId: string };
export type GroupResponse = GroupCatalog | GroupState | GroupPage | { room: GroupRoom } | { accepted?: boolean; cancelled?: number; approved?: boolean; event?: GroupEvent }
  | { context: GroupContext; event: GroupEvent };

/**
 * The group chats an assistant's routine may post in: any room this person can open, or, for a personal
 * assistant, only rooms with one of its owner's personal assistants, which nobody else can open. The server
 * enforces the same rule.
 */
export function routineRoomChoices(catalog: GroupCatalog | null | undefined, bot: { shared?: boolean; ownerId?: string } | undefined,
  bots: { id: string; shared?: boolean; ownerId?: string }[]): GroupRoom[] {
  if (!catalog?.supported || !catalog.routineDelivery) return [];
  if (!bot || bot.shared !== false || !bot.ownerId) return catalog.rooms;
  return catalog.rooms.filter(room => room.members.some(member =>
    bots.some(other => other.id === member.profile && other.shared === false && other.ownerId === bot.ownerId)));
}

// Hermes's own Bot Mode envelopes. Display hints only, never authority.
// App-attributed human messages deliberately bypass this fallback.
export function agentEnvelope(message: Pick<Message, 'role' | 'text' | 'sender'>): { name: string; handle: string; text: string } | null {
  if (message.role !== 'user' || message.sender) return null;
  const match = /^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})(?:@[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u.exec(message.text);
  return match ? { name: (match[1] || match[3]).trim(), handle: match[2] || '', text: match[4] } : null;
}
