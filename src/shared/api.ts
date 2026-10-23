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
export type ConversationPage = Omit<Conversation, "window"> & {
  /** With a history window: visible messages before it, and files only those messages carry. */
  earlier?: number;
  earlierFiles?: number;
  draft: SavedDraft | null;
  readPosition: ReadPosition | null;
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
export interface ApiRoutes {
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
  // The native app's routes. docs/native-api.md is the contract the iOS app decodes.
  "GET /native/push/config": { response: { available: boolean; environment?: "sandbox" | "production" } };
  "PUT /native/push/device": { body: { deviceId: string; token: string }; response: Ok };
  "DELETE /native/push/device": { body: { deviceId: string }; response: Ok };
  "GET /native/live-activity": { query: { deviceId?: string }; response: { available: boolean; state: LiveState } };
  "PUT /native/live-activity": { body: { deviceId: string; token: string; botIds?: string[] }; response: Ok };
  "DELETE /native/live-activity": { body: { deviceId: string; token: string }; response: Ok };
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
