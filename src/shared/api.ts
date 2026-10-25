import type { AutomationOverview as WorkOverview, AutomationTask, AutomationRequest, TaskInput, TriggerInput, SkillContent, SkillDiff, EventSubscription } from "./automation.js";
import type { AutomationOverview, HistoryPage, SavedItem, SearchHit, Starter } from "./discovery.js";
import type { ProfileMemory, RoutinePreview, RoutineRunReceipt, TodayOverview } from "./experience.js";
import type { RoutineOutput, RoutineResult } from "./collaboration.js";
import type { ReplyCardState } from "./reply-cards.js";
import type { Routine } from "./types.js";
import type { routinePresets } from "./routine-presets.js";
import type { EarlierFiles } from "./history.js";
import type { LiveState } from "./live-activity.js";
import type {
  Avatar,
  Bootstrap,
  Bot,
  BotInput,
  Conversation,
  FileRef,
  InferenceSettings,
  ModelCatalog,
  ModelChoice,
  Preferences,
  RuntimeStatus,
  SavedDraft,
  Skill,
  SubmissionReceipt,
  Tool,
} from "./types.js";

export type Ok = { ok: true };
export type BotSaveRequest = BotInput & {
  /** Making an assistant personal hides it from everyone else, so the person confirms that. */
  confirmPrivate?: boolean;
};
export interface ReadPosition { messageId?: string; scrollTop?: number }
/** A conversation read, with this person's draft and read position. */
export type ConversationPage = Omit<Conversation, "window" | "requestSessionId"> & {
  /** With a history window: visible messages before it, and files only those messages carry. */
  earlier?: number;
  earlierFiles?: number;
  draft: SavedDraft | null;
  readPosition: ReadPosition | null;
  /**
   * After a failed turn: the request that already retried it, from any device or person, with
   * its current receipt. `retryOf` names the retried message.
   */
  retry?: SubmissionReceipt & { retryOf: string };
};
export interface MessageRequest {
  requestId: string;
  text: string;
  attachments?: FileRef[];
  /** The person reviewed the interrupted task and still wants this message sent. */
  reviewedInterruption?: boolean;
  /** The person reviewed an uncertain receipt and asks the app to check Hermes again. */
  reviewedUncertain?: boolean;
  /** The draft revision this message was written on. */
  draftBaseRevision?: number;
  /**
   * The id of the user message in this assistant's canonical conversation that this one resends
   * after a failed turn. Never sent with draftBaseRevision: a retry leaves the draft untouched.
   */
  retryOf?: string;
}
export interface DraftSave { text: string; attachments?: FileRef[]; baseRevision?: number }
export interface WebPushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export type PushTest = { ok: true; detail: string };

/**
 * JSON routes under /api by "METHOD /path", with what clients send and what the server answers.
 * The server registers these through apiRoute, which checks each handler's return against
 * `response` and its body schema against `body`. The web client calls them through request(),
 * which infers the same types. Routes not listed here still use untyped api<T>().
 */
export type SaveItem =
  | { kind: "session"; botId: string; sessionId: string; messageId?: string; offset?: number; title: string }
  | { kind: "routine"; botId: string; routineId: string; resultId: string; title: string };
export type RoutineSave = Pick<Routine, "botId" | "name" | "prompt" | "schedule" | "enabled"> & { recipientIds: string[] }
  & Partial<Pick<Routine, "skills" | "model" | "provider" | "enabledToolsets" | "script" | "noAgent" | "contextFrom">>;
type WorkInput<O extends AutomationRequest["operation"]> = Omit<Extract<AutomationRequest, { operation: O }>, "operation" | "profile" | "visibleProfiles">;
type MemorySave = { revision: string; entries: { id?: string; text: string }[] };

export interface ApiRoutes {
  "GET /today": { query: { since?: string }; response: TodayOverview };
  "PUT /today/seen": { body: { seenAt: string; frontier: string }; response: Ok };
  "GET /search": { query: { q: string; botId?: string }; response: { hits: SearchHit[]; unavailableBots: string[] } };
  "GET /bots/:botId/history/:sessionId": { query: { offset?: number; messageId?: string }; response: HistoryPage };
  "GET /saved": { response: SavedItem[] };
  "POST /saved": { body: SaveItem; response: SavedItem };
  "DELETE /saved/:id": { response: Ok };
  "GET /automations": { query: { days?: number }; response: AutomationOverview };
  "GET /bots/:id/starters": { response: Starter[] };
  "GET /bots/:id/memory": { response: ProfileMemory };
  "PUT /bots/:id/memory/:target": { body: MemorySave; response: ProfileMemory };
  "PATCH /bots/:id/memory/:target": { body: MemorySave; response: ProfileMemory };
  "DELETE /bots/:id/memory/:target": { body: { revision: string; entryId: string }; response: ProfileMemory };
  "GET /routines": { response: Routine[] };
  "POST /routines": { body: RoutineSave; response: Routine };
  "PUT /routines/:id": { body: RoutineSave; response: Routine };
  "DELETE /routines/:id": { response: Ok };
  "PATCH /routines/:id/state": { body: { enabled: boolean }; response: Ok };
  "GET /routines/templates": { response: typeof routinePresets };
  "POST /routines/preview": { body: { botId: string; schedule: string }; response: RoutinePreview };
  "POST /routines/:id/run": { body: { requestId: string }; response: RoutineRunReceipt };
  "GET /routines/:id/runs/:requestId": { response: RoutineRunReceipt };
  "GET /bots/:botId/routines/:routineId/results": { response: RoutineResult[] };
  "GET /bots/:botId/routines/:routineId/results/:resultId": { response: RoutineOutput };
  "GET /bots/:id/messages/:messageId/cards/:cardId/state": { response: ReplyCardState };
  "PUT /bots/:id/messages/:messageId/cards/:cardId/state": { body: ReplyCardState; response: ReplyCardState };
  "GET /bots/:id/automation": { response: WorkOverview };
  "PUT /bots/:id/automation/goal": { body: WorkInput<"goal_set">; response: WorkOverview };
  "POST /bots/:id/automation/goal/pause": { body: Record<string, never> | undefined; response: WorkOverview };
  "POST /bots/:id/automation/goal/clear": { body: Record<string, never> | undefined; response: WorkOverview };
  "POST /bots/:id/automation/goal/resume": { body: Omit<WorkInput<"goal_resume">, "senderId">; response: WorkOverview };
  "POST /bots/:id/automation/tasks": { body: TaskInput; response: AutomationTask };
  "GET /bots/:id/automation/tasks/:taskId": { response: AutomationTask };
  "PATCH /bots/:id/automation/tasks/:taskId": { body: Omit<WorkInput<"task_update">, "taskId">; response: AutomationTask };
  "POST /bots/:id/automation/tasks/:taskId/actions": { body: Omit<WorkInput<"task_action">, "taskId">; response: AutomationTask };
  "PUT /bots/:id/automation/tasks/:taskId/dependencies/:dependencyId": { body: { remove: boolean }; response: AutomationTask };
  "POST /bots/:id/automation/triggers": { body: TriggerInput; response: { subscription: EventSubscription; secret?: string } };
  "PUT /bots/:id/automation/triggers/:triggerId": { body: Omit<TriggerInput, "id"> & { revision: string }; response: { subscription: EventSubscription; secret?: string } };
  "PATCH /bots/:id/automation/triggers/:triggerId": { body: { enabled: boolean; revision: string }; response: { subscription: EventSubscription; secret?: string } };
  "DELETE /bots/:id/automation/triggers/:triggerId": { body: { revision: string }; response: Ok };
  "GET /bots/:id/automation/skills/content": { query: { name: string }; response: SkillContent };
  "GET /bots/:id/automation/skills/pending/:pendingId": { response: SkillDiff };
  "POST /bots/:id/automation/skills/pending/:pendingId": { body: { revision: string; decision: "approve" | "reject" }; response: Ok };
  "PUT /bots/:id/automation/skills/policy": { body: { approvalRequired: boolean }; response: Ok };
  "GET /bootstrap": { query: { roster?: "lean" }; response: Bootstrap };
  "POST /connection/retry": { response: RuntimeStatus };
  "PATCH /preferences": { body: Preferences; response: Preferences };
  "PUT /preferences/models": { body: { modelFavorites: ModelChoice[] }; response: { modelFavorites: ModelChoice[] } };
  "GET /models": { query: { botId?: string }; response: ModelCatalog };

  "GET /bots": { query: { roster?: "lean" }; response: Bot[] };
  "POST /bots": { body: BotSaveRequest; response: Bot };
  "GET /bots/:id": { response: Bot };
  "PATCH /bots/:id": { body: BotSaveRequest; response: Bot };
  "DELETE /bots/:id": { response: Ok };
  "PUT /bots/:id/avatar": { body: Avatar; response: Avatar };
  "POST /bots/:id/portrait": { body: { prompt: string }; response: FileRef };
  "GET /bots/:id/inference": { response: InferenceSettings };
  "PATCH /bots/:id/inference": { body: Partial<InferenceSettings>; response: InferenceSettings };
  "GET /bots/:id/tools": { response: Tool[] };
  "PUT /bots/:id/tools": { body: { ids: string[] }; response: Ok };
  "GET /bots/:id/skills": { response: Skill[] };
  "PUT /bots/:id/skills": { body: { ids: string[] }; response: Ok };

  "GET /bots/:id/conversation": { query: { start?: string; turns?: number }; response: ConversationPage };
  "GET /bots/:id/files": { query: { before?: string }; response: EarlierFiles };
  "POST /bots/:id/messages": { body: MessageRequest; response: SubmissionReceipt };
  "POST /bots/:id/steer": { body: MessageRequest; response: SubmissionReceipt };
  "GET /submissions/:id": { response: SubmissionReceipt };
  "POST /bots/:id/requests/:approvalId": { body: { answers: Record<string, string> }; response: Ok };
  "POST /bots/:id/stop": { response: Ok };
  "POST /bots/:id/approvals/:approvalId": { body: { decision: "approved" | "denied"; account?: string }; response: Ok };
  "GET /bots/:id/draft": { response: SavedDraft | null };
  "PUT /bots/:id/draft": { body: DraftSave; response: SavedDraft };
  "GET /bots/:id/read-position": { response: ReadPosition | null };
  "PUT /bots/:id/read-position": { body: ReadPosition; response: ReadPosition };
  "PUT /bots/:id/presence": { body: { client: string; state: "active" | "left" | "idle" }; response: Ok };
  /** Multipart: the client sends it through uploadFile. */
  "POST /bots/:id/uploads": { response: FileRef };

  "POST /push/subscriptions/status": { body: { endpoint: string }; response: { registered: boolean } };
  "POST /push/subscriptions": { body: WebPushSubscription; response: Ok };
  "DELETE /push/subscriptions": { body: { endpoint: string }; response: Ok };
  "POST /push/test": { body: { botId: string }; response: PushTest };
  /** A service worker's notification action, authorized by the single-use token in its push. */
  "POST /push/actions": { body: { token: string }; response: Ok };
  // The native app's routes. docs/native-api.md is the contract the iOS app decodes.
  "GET /native/push/config": { response: { available: boolean; environment?: "sandbox" | "production" } };
  "PUT /native/push/device": { body: { deviceId: string; token: string }; response: Ok };
  "DELETE /native/push/device": { body: { deviceId: string }; response: Ok };
  "GET /native/live-activity": { query: { deviceId?: string; local?: "1" }; response: { available: boolean; state: LiveState } };
  "PUT /native/live-activity": { body: { deviceId: string; token: string; botIds?: string[]; scope?: string }; response: Ok };
  "DELETE /native/live-activity": { body: { deviceId: string; token: string }; response: Ok };
  "PUT /native/live-activity/start": { body: { deviceId: string; token: string; scope: string }; response: Ok };
  "DELETE /native/live-activity/start": { body: { deviceId: string }; response: Ok };
  "POST /native/push/test": { body: { botId: string }; response: PushTest };
}
export type ApiRoute = keyof ApiRoutes;
export type ApiResponse<K extends ApiRoute> = ApiRoutes[K]["response"];
export type ApiBody<K extends ApiRoute> = ApiRoutes[K] extends { body: infer Body } ? Body : undefined;
export type ApiQuery<K extends ApiRoute> = ApiRoutes[K] extends { query: infer Query } ? Query : undefined;
type ParamNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<Rest>
  : Path extends `${string}:${infer Name}` ? Name : never;
export type ApiPath<K extends ApiRoute> = K extends `${string} ${infer Path}` ? Path : never;
export type ApiMethod<K extends ApiRoute> = K extends `${infer Method} ${string}` ? Method : never;
/** The route's path parameters, such as `{ id: string }` for "/bots/:id". */
export type ApiParams<K extends ApiRoute> = { [Name in ParamNames<ApiPath<K>>]: string };

/** The method and path pattern a route key names. */
export function routeParts<K extends ApiRoute>(route: K) {
  const space = route.indexOf(" ");
  return { method: route.slice(0, space) as ApiMethod<K>, path: route.slice(space + 1) as ApiPath<K> };
}
/** The route's path under /api with each parameter encoded, and its query without unset values. */
export function routeUrl<K extends ApiRoute>(route: K, params: ApiParams<K>, query?: ApiQuery<K>) {
  const path = routeParts(route).path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = (params as Record<string, string | undefined>)[name];
    if (value === undefined) throw new Error(`Missing ${name} for ${route}`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}
