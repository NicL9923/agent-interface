import type { AutomationRequest, AutomationResponse } from './automation.js';
import type { ExperienceRequest, ExperienceResponse } from "./experience.js";
import type { IntegrationRequest, IntegrationCatalog, IntegrationConnection, IntegrationFlow } from "./integrations.js";
import type { ComputerRequest, ComputerStatus, ComputerAttachment } from "./computer.js";
import type { SecureRequest, VaultRequest, VaultResponse } from "./vault.js";
import type { GroupRequest, GroupResponse, RoutineOutput, RoutineResult } from './collaboration.js';
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
/** Geometric silhouettes in picker order. ios/AgentInterface/Models.swift mirrors this list. */
export const avatarShapes = [
  "blob",
  "pebble",
  "squircle",
  "capsule",
  "triangle",
  "hex",
  "cloud",
  "drop",
  "circle",
  "diamond",
  "sparkle",
  "clover",
  "heart",
  "cookie",
  "pentagon",
  "burst",
  "alien",
  "ghost",
  "flower",
  "sun",
] as const;
export type AvatarShape = (typeof avatarShapes)[number];
/** Mascot characters in picker order. ios/AgentInterface/Models.swift mirrors both lists. */
export const everydayFamilies = ["bear", "fox", "sprout", "panda", "raccoon", "owl", "cactus", "dinosaur"] as const;
/** Listed under their own "Seasonal" heading, in calendar order from spring. */
export const seasonalFamilies = [
  "leprechaun",
  "bunny",
  "eagle",
  "pumpkin",
  "bat",
  "ghost",
  "turkey",
  "santa",
  "rudolph",
  "snowman",
] as const;
export const mascotFamilies = [...everydayFamilies, ...seasonalFamilies] as const;
export type MascotFamily = (typeof mascotFamilies)[number];
export type SeasonalFamily = (typeof seasonalFamilies)[number];
export const avatarEyes = ["round", "oval", "visor", "spark"] as const;
export type Eyes = (typeof avatarEyes)[number];
export const avatarAccessories = ["none", "hat", "glasses"] as const;
export type Accessory = (typeof avatarAccessories)[number];
export type Avatar =
  | {
      mode: "geometric";
      shape: AvatarShape;
      color: string;
      eyes: Eyes;
      accessory: Accessory;
      eyeWidth?: number;
      eyeHeight?: number;
      eyeSpacing?: number;
    }
  | {
      mode: "mascot";
      family: MascotFamily;
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
  startPage?: "today" | "assistant";
  notifications?: { timezone: string; quietStart?: string; quietEnd?: string; batchMinutes: number };
}
export const reasoningLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const serviceTiers = ["normal", "fast", "ultrafast"] as const;
export interface InferenceSettings {
  reasoning: typeof reasoningLevels[number];
  speed: typeof serviceTiers[number];
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
  /** Latest canonical message preview from Hermes's roster, for the home list. */
  lastMessage?: { text: string; at?: string };
}
/** The Hermes profile ID a new assistant gets from its name. */
export const botIdFor = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
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
/**
 * A person's saved draft for one assistant. `revision` grows with every change, `reason` says
 * whether the latest change was an edit or the clear after a send, and `sentRevision` is the
 * revision of the latest such clear, or 0.
 */
export interface SavedDraft {
  text: string;
  attachments: FileRef[];
  revision: number;
  reason: "edit" | "sent";
  sentRevision: number;
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
  /** Display provenance, independent of the model-facing role. Never grants access. */
  origin?: MessageOrigin;
}
export interface MessageOrigin {
  kind: "human" | "agent" | "scheduled" | "subagent" | "process" | "diagnostic";
  visibility: "conversation" | "activity";
  title?: string;
  name?: string;
  handle?: string;
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
  kind: "clarify" | "official" | "secure";
  title: string;
  detail: string;
  questions?: { id: string; prompt: string; options?: string[] }[];
  secure?: SecureRequest;
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
  /** Set when the runtime already cut history to the requested window. */
  window?: {
    /** Visible messages before the window. */
    earlier: number;
    /** The earlier messages the app still needs: those with files, and the prompts their replies answer. */
    context: Message[];
  };
}
export interface Inflight {
  botId: string;
  message: Message;
  activity: Activity;
  toolCalls: ToolCall[];
}
export interface ConversationOptions {
  /** The app's history window, cut by the runtime when it can. */
  window?: { start?: string; turns?: number };
  /** false reads current state, approvals and requests without history, as write checks need. */
  history?: false;
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
  skills?: string[];
  model?: string | null;
  provider?: string | null;
  /** null inherits profile tools; [] is a native zero-tool allowlist. */
  enabledToolsets?: string[] | null;
  script?: string | null;
  noAgent?: boolean;
  /** Native job IDs in this profile, plus "self" for continuity. */
  contextFrom?: string[] | null;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastError?: string;
  lastDeliveryError?: string;
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
  /** The newest distributed iOS build, when the host advertises one. */
  nativeApp?: { latestBuild: number; updateUrl: string };
}
export interface Submission {
  reviewedInterruption?: boolean;
  requestId: string;
  botId: string;
  text: string;
  attachments: FileRef[];
  senderId: string;
  /** The draft revision this message was written on. Older clients omit it. */
  draftBaseRevision?: number;
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
  /** The pending approval an approval event asked about, from add-ons that report it. */
  approvalId?: string;
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
  /** ISO 8601 commit time of `version`, when the Hermes updater has recorded it. */
  revisionDate?: string;
  detail?: string;
  address?: string;
  retryAt?: string;
  lastConnectedAt?: string;
}
export interface Runtime {
  setRoutineEnabled?(botId: string, routineId: string, enabled: boolean): Promise<void>;
  routineResults?(botId: string, routineId: string): Promise<RoutineResult[]>;
  routineOutput?(botId: string, routineId: string, resultId: string): Promise<RoutineOutput>;
  groupRequest?(input: GroupRequest): Promise<GroupResponse>;
  transcribeVoice?(botId: string, input: { mime: string; data: Buffer }): Promise<{ text: string; provider?: string }>;
  synthesizeVoice?(botId: string, text: string): Promise<{ data: Buffer; mime: string; provider?: string }>;
  automationRequest?(input: AutomationRequest): Promise<AutomationResponse>;
  experienceRequest?(input: ExperienceRequest): Promise<ExperienceResponse>;
  vaultRequest?(input: VaultRequest): Promise<VaultResponse>;
  computerRequest?(input: ComputerRequest): Promise<ComputerStatus | ComputerAttachment>;
  connectComputerDisplay?(attachment: ComputerAttachment): import("ws").WebSocket;
  inferenceSettings?(botId: string, update?: Partial<InferenceSettings>): Promise<InferenceSettings>;
  modelOptions?(profile?: string): Promise<ModelCatalog>;
  integrationRequest?(input: IntegrationRequest): Promise<IntegrationCatalog | IntegrationConnection | IntegrationFlow | {ok: true}>;
  status(): Promise<RuntimeStatus>;
  reconnect?(): Promise<RuntimeStatus>;
  capabilities(): Promise<Capabilities>;
  canonicalSubmit?(): Promise<boolean>;
  listBots(): Promise<Bot[]>;
  botDetail?(botId: string): Promise<Bot>;
  watchRoster?(changed: () => void): () => void;
  saveBot(input: BotInput, id?: string): Promise<Bot>;
  deleteBot(id: string): Promise<void>;
  stop(botId: string): Promise<void>;
  generatePortrait(botId: string, prompt: string): Promise<FileRef>;
  setAvatar?(botId: string, avatar: Avatar): Promise<void>;
  conversation(botId: string, options?: ConversationOptions): Promise<Conversation>;
  /** An inflight notice patches live state; an omitted kind means refetch. Unsubscribe with the returned function. */
  watch?(botId: string, changed: (kind?: "inflight") => void): () => void;
  inflight?(botId: string): Inflight | undefined;
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
  /** The body never yields more than maxBytes; a larger file is refused with file_too_large. */
  download(id: string, maxBytes: number): Promise<DownloadedFile>;
  /** The assistant a file ID belongs to, only when its signature is genuine. */
  fileBotId?(id: string): string | undefined;
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
export type DownloadedFile = {
  name: string;
  mime: string;
  size?: number;
  // A web stream, so cancelling it reaches the source instead of waiting on a pending read.
  body: ReadableStream<Uint8Array>;
};
export const defaultPreferences: Preferences = {
  presentation: "simple",
  theme: "system",
  favorites: [],
  sections: [],
  followBots: [],
};
