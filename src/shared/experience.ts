import type { Activity, Approval, AttentionRequest, FileRef, Message, RuntimeEvent } from './types.js';
import type { HistoryPage, SearchHit, UsageSummary } from './discovery.js';
import type { RoutineOutput, RoutineResult } from './collaboration.js';
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
  upcoming?: import("./types.js").Routine[];
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
  refresh?: { revision: string; state: 'next_turn' | 'pending' | 'applied'; busy: boolean; message: string };
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
type ExperienceRequestUnion =
  | { operation: 'search'; profile: string; query: string }
  | { operation: 'history'; profile: string; sessionId: string; offset: number; messageId?: string }
  | { operation: 'usage'; profile: string; days: number }
  | { operation: 'routine_results'; profile: string; routineId: string }
  | { operation: 'routine_output'; profile: string; routineId: string; resultId: string }
  | { operation: 'memory'; profile: string }
  | { operation: 'save_memory'; profile: string; target: 'memory' | 'user'; revision: string; entries: { id?: string; text: string }[] }
  | { operation: 'delete_memory'; profile: string; target: 'memory' | 'user'; revision: string; entryId: string }
  | { operation: 'preview'; profile: string; schedule: string }
  | { operation: 'run'; profile: string; routineId: string; requestId: string; senderId: string }
  | { operation: 'run_receipt'; profile: string; routineId: string; requestId: string; senderId: string };
/** The result belongs to the requested operation. Missing receipts are HTTP 404 errors. */
export interface ExperienceResults {
  search: SearchHit[];
  history: HistoryPage;
  usage: UsageSummary;
  routine_results: RoutineResult[];
  routine_output: RoutineOutput;
  memory: ProfileMemory;
  save_memory: ProfileMemory;
  delete_memory: ProfileMemory;
  preview: RoutinePreview;
  run: RoutineRunReceipt;
  run_receipt: RoutineRunReceipt;
}
export type ExperienceOperation = ExperienceRequestUnion['operation'];
export type ExperienceRequests = { [O in ExperienceOperation]: Extract<ExperienceRequestUnion, { operation: O }> };
export type ExperienceRequest<K extends ExperienceOperation = ExperienceOperation> = { [O in K]: ExperienceRequests[O] }[K];
export type ExperienceResponse<K extends ExperienceOperation = ExperienceOperation> = ExperienceResults[K];
export type ExperienceRequester = <R extends ExperienceRequest>(input: R) => Promise<ExperienceResult<R['operation']>>;
export type ExperienceResult<O extends ExperienceOperation> = ExperienceResults[O];
