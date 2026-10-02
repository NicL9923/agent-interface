import type { Activity, Approval, AttentionRequest, FileRef, Message, RuntimeEvent } from './types.js';
export interface TodayItem {
  botId: string;
  botName: string;
  activity: Activity;
  approvals: Approval[];
  attention: AttentionRequest[];
  latestMessage?: Pick<Message, 'id' | 'text' | 'createdAt' | 'files'>;
  files: FileRef[];
  error?: string;
}
export interface TodayOverview {
  generatedAt: string;
  frontier: string;
  hasMore: boolean;
  since: string;
  items: TodayItem[];
  events: RuntimeEvent[];
  unavailableBots: string[];
}
export interface MemoryEntry { id: string; text: string }
export interface MemoryDocument {
  target: 'memory' | 'user';
  label: string;
  revision: string;
  enabled: boolean;
  entries: MemoryEntry[];
  charLimit: number;
  charCount: number;
}
export interface ProfileMemory {
  botId: string;
  profile: string;
  scope: 'profile';
  owner: 'Hermes';
  documents: MemoryDocument[];
  notice: string;
}
export interface RoutinePreview {
  botId: string;
  schedule: string;
  timezone: string;
  nextRuns: string[];
  kind: 'once' | 'interval' | 'cron';
}
export interface RoutineRunReceipt {
  requestId: string;
  routineId: string;
  botId: string;
  status: 'accepted' | 'completed' | 'failed' | 'uncertain';
  message?: string;
  startedAt: string;
  finishedAt?: string;
  executionId?: string;
  ownerStatus?: string;
}
export type ExperienceRequest =
  | { operation: 'memory'; profile: string }
  | { operation: 'save_memory'; profile: string; target: 'memory' | 'user'; revision: string; entries: { id?: string; text: string }[] }
  | { operation: 'delete_memory'; profile: string; target: 'memory' | 'user'; revision: string; entryId: string }
  | { operation: 'preview'; profile: string; schedule: string }
  | { operation: 'run'; profile: string; routineId: string; requestId: string; senderId: string }
  | { operation: 'run_receipt'; profile: string; routineId: string; requestId: string; senderId: string };
export type ExperienceResponse = ProfileMemory | RoutinePreview | RoutineRunReceipt;
