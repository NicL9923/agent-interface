import type { ExperienceRequest, ExperienceResponse } from "./experience.js";
import type { IntegrationRequest, IntegrationCatalog, IntegrationConnection, IntegrationFlow } from "./integrations.js";
import type { ComputerRequest, ComputerStatus, ComputerAttachment } from "./computer.js";
export type ActivityState =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "blocked"
  | "done"
  | "disconnected"
  | "failed"
  | "interrupted";
export type Eyes = "round" | "oval" | "visor" | "spark";
export type Accessory = "none" | "hat" | "glasses";
export type Avatar =
  | {
      mode: "geometric";
      shape:
        | "drop"
        | "triangle"
        | "cloud"
        | "circle"
        | "capsule"
        | "blob"
        | "pebble"
        | "squircle"
        | "hex";
      color: string;
      eyes: Eyes;
      accessory: Accessory;
      eyeWidth?: number;
      eyeHeight?: number;
      eyeSpacing?: number;
    }
  | {
      mode: "mascot";
      family: "sprout" | "fox" | "bear" | "pumpkin" | "santa" | "rudolph" | "turkey" | "bunny";
      color: string;
      eyes: Eyes;
      accessory: Accessory;
      eyeWidth?: number;
      eyeHeight?: number;
      eyeSpacing?: number;
    }
  | { mode: "portrait"; src: string; origin: "uploaded" | "generated" };
export interface User {
  id: string;
  name: string;
  email: string;
  picture?: string;
}
export interface Preferences {
  presentation: "simple" | "advanced";
  theme: "system" | "light" | "dark";
  favorites: string[];
  modelFavorites?: ModelChoice[];
  defaultBotId?: string;
  sections: { id: string; name: string; botIds: string[] }[];
  followBots: string[];
}
export interface ModelChoice {
  provider: string;
  model: string;
}
export interface ModelProvider {
  id: string;
  name: string;
  aliases?: string[];
  authenticated: boolean;
  warning?: string;
  models: { id: string; name: string; available: boolean }[];
}
export interface ModelCatalog {
  providers: ModelProvider[];
  provider: string;
  model: string;
}
export interface Capability {
  supported: boolean;
  reason?: string;
}
export type CapabilityKey =
  | "chat"
  | "steering"
  | "approvals"
  | "uploads"
  | "generatedFiles"
  | "botConfiguration"
  | "tools"
  | "skills"
  | "routines"
  | "durableEvents"
  | "idempotency"
  | "imageGeneration"
  | "stop"
  | "portraitGeneration"
  | "avatarMetadata";
export type Capabilities = Record<CapabilityKey, Capability>;
export interface Bot {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  model: string;
  provider?: string;
  enabledMcpServers?: string[];
  shared: boolean;
  ownerId?: string;
  avatar?: Avatar;
  enabledTools?: string[];
  enabledSkills?: string[];
  sessionId?: string;
  activity: ActivityState;
}
export interface BotInput {
  confirmModel?: boolean;
  name: string;
  description?: string;
  instructions: string;
  model: string;
  provider?: string;
  enabledMcpServers?: string[];
  shared: boolean;
  enabledTools?: string[];
  enabledSkills?: string[];
}
export interface FileRef {
  id: string;
  name: string;
  mime: string;
  size?: number;
  url?: string;
}
export interface Message {
  id: string;
  runId?: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  createdAt?: string;
  sender?: Pick<User, "id" | "name">;
  files?: FileRef[];
  reasoning?: string;
  toolName?: string;
  toolCall?: ToolCall;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments?: string;
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}
export interface Approval {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "approved" | "denied" | "expired";
  expiresAt?: string;
}
export interface Activity {
  state: ActivityState;
  detail?: string;
  runId?: string;
  updatedAt?: string;
}
export interface AttentionRequest {
  id: string;
  kind: "clarify" | "official";
  title: string;
  detail: string;
  questions?: { id: string; prompt: string; options?: string[] }[];
}
export interface Conversation {
  attention?: AttentionRequest[];
  botId: string;
  sessionId?: string;
  messages: Message[];
  activity: Activity;
  approvals: Approval[];
  files: FileRef[];
  toolCalls?: ToolCall[];
}
export interface Tool {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}
export interface Skill {
  required?: boolean;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}
export interface Routine {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  recipientIds?: string[];
}
export interface Bootstrap {
  user: User;
  household: User[];
  preferences: Preferences;
  bots: Bot[];
  capabilities: Capabilities;
  connection: RuntimeStatus;
  csrfToken: string | null;
  vapidPublicKey?: string;
}
export interface Submission {
  reviewedInterruption?: boolean;
  requestId: string;
  botId: string;
  text: string;
  attachments: FileRef[];
  senderId: string;
}
export interface SubmissionReceipt {
  requestId: string;
  status: "accepted" | "uncertain" | "rejected" | "interrupted";
  runId?: string;
  messageId?: string;
  message?: string;
}
export interface RuntimeEvent {
  id: string;
  files?: FileRef[];
  botId: string;
  runId?: string;
  routineId?: string;
  kind: "completed" | "approval" | "failed" | "interrupted" | "activity";
  title: string;
  body?: string;
  occurredAt: string;
}
export interface RuntimeDiscovery {
  cursor: string;
  events: RuntimeEvent[];
}
export interface RuntimeStatus {
  connected: boolean;
  code?: "not_configured" | "invalid_config" | "connecting" | "unreachable" | "unauthorized" | "addon_missing" | "incompatible" | "ready" | "reconnecting" | "closed";
  version?: string;
  detail?: string;
  address?: string;
  retryAt?: string;
  lastConnectedAt?: string;
}
export interface Runtime {
  transcribeVoice?(botId: string, input: { mime: string; data: Buffer }): Promise<{ text: string; provider?: string }>;
  synthesizeVoice?(botId: string, text: string): Promise<{ data: Buffer; mime: string; provider?: string }>;
  experienceRequest?(input: ExperienceRequest): Promise<ExperienceResponse>;
  computerRequest?(input: ComputerRequest): Promise<ComputerStatus | ComputerAttachment>;
  connectComputerDisplay?(attachment: ComputerAttachment): import("ws").WebSocket;
  modelOptions?(profile?: string): Promise<ModelCatalog>;
  integrationRequest?(input: IntegrationRequest): Promise<IntegrationCatalog | IntegrationConnection | IntegrationFlow | {ok: true}>;
  status(): Promise<RuntimeStatus>;
  reconnect?(): Promise<RuntimeStatus>;
  capabilities(): Promise<Capabilities>;
  listBots(): Promise<Bot[]>;
  saveBot(input: BotInput, id?: string): Promise<Bot>;
  deleteBot(id: string): Promise<void>;
  stop(botId: string): Promise<void>;
  generatePortrait(botId: string, prompt: string): Promise<FileRef>;
  setAvatar?(botId: string, avatar: Avatar): Promise<void>;
  conversation(botId: string): Promise<Conversation>;
  submit(input: Submission): Promise<SubmissionReceipt>;
  lookupSubmission(requestId: string): Promise<SubmissionReceipt | null>;
  steer(input: Submission): Promise<SubmissionReceipt>;
  answerRequest(
    botId: string,
    id: string,
    answers: Record<string, string>,
  ): Promise<void>;
  approve(
    botId: string,
    approvalId: string,
    decision: "approved" | "denied",
    senderId: string,
  ): Promise<void>;
  upload(
    botId: string,
    input: { name: string; mime: string; data: Buffer },
  ): Promise<FileRef>;
  download(id: string): Promise<{ data: Buffer; name: string; mime: string }>;
  tools(botId: string): Promise<Tool[]>;
  setTools(botId: string, ids: string[]): Promise<void>;
  skills(botId: string): Promise<Skill[]>;
  setSkills(botId: string, ids: string[]): Promise<void>;
  routines(): Promise<Routine[]>;
  saveRoutine(input: Omit<Routine, "id">, id?: string): Promise<Routine>;
  deleteRoutine(id: string): Promise<void>;
  discoverEvents(cursor: string): Promise<RuntimeDiscovery>;
  close(): Promise<void>;
}
export const defaultPreferences: Preferences = {
  presentation: "simple",
  theme: "system",
  favorites: [],
  sections: [],
  followBots: [],
};
