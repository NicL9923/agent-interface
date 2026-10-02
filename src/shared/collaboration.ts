import type { Message } from './types.js';

export interface RoutineResult {
  id: string;
  title: string;
  startedAt?: string;
  preview?: string;
  previewOnly: boolean;
}
export interface RoutineOutput { messages: Message[]; previewOnly: boolean }
export interface GroupMember { member_id: string; profile: string; handle: string; display_name?: string; target?: { kind: string; profile: string } }
export interface GroupRoom { room_id: string; name: string; members: GroupMember[]; latest_seq?: number }
export interface GroupEvent {
  event_id: string; seq: number; kind: string; created_at: number;
  actor: { kind: string; id: string };
  payload: Record<string, unknown>;
}
export interface GroupAction {
  kind: string; task_id: string; member_id?: string; execution_generation?: number;
  request_id?: string; description?: string; command?: string;
  approval?: { request_id?: string; description?: string; command?: string };
}
export interface GroupState {
  room: GroupRoom;
  driver_status?: { running: boolean; working: boolean; blocked: boolean; pending_actions: GroupAction[] };
}
export interface GroupPage { events: GroupEvent[]; cursor: number; latest_seq: number; has_more: boolean }
export interface GroupCatalog { supported: boolean; canSend: boolean; reason?: string; rooms: GroupRoom[] }
export type GroupRequest =
  | { operation: 'list' }
  | { operation: 'create'; roomId: string; name: string; members: GroupMember[] }
  | { operation: 'state'; roomId: string }
  | { operation: 'log'; roomId: string; since: number }
  | { operation: 'send'; roomId: string; requestId: string; text: string; threadId: string }
  | { operation: 'stop'; roomId: string; requestId: string }
  | { operation: 'approve'; roomId: string; taskId: string; memberId: string; generation: number; choice: 'once' | 'deny'; requestId: string };
export type GroupResponse = GroupCatalog | GroupState | GroupPage | { room: GroupRoom } | { accepted?: boolean; cancelled?: number; approved?: boolean };

// Hermes's own Bot Mode envelopes. Display hints only, never authority.
// App-attributed human messages deliberately bypass this fallback.
export function agentEnvelope(message: Pick<Message, 'role' | 'text' | 'sender'>): { name: string; handle: string; text: string } | null {
  if (message.role !== 'user' || message.sender) return null;
  const match = /^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})(?:@[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u.exec(message.text);
  return match ? { name: (match[1] || match[3]).trim(), handle: match[2] || '', text: match[4] } : null;
}
