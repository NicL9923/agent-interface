export type IntegrationStatus = "connected" | "configured" | "not_connected" | "expired" | "missing_permission" | "unavailable" | "unsupported";
export type IntegrationCategory = "productivity" | "development" | "files" | "home" | "devices" | "providers" | "messaging" | "custom";
export interface IntegrationField { key: string; label: string; kind: "text" | "secret" | "url"; required: boolean; defaultValue?: string; options?: {value: string; label: string}[] }
export interface IntegrationConnection {
  id: string; name: string; category: IntegrationCategory; owner: string; profile: string;
  account?: string; status: IntegrationStatus; detail: string; checkedAt?: string;
  /** How the assistant actually reaches this service, from add-ons that report it. */
  uses?: string;
  permissions: { id: string; name: string; granted: boolean | null }[];
  actions: { connect: boolean; check: boolean; disconnect: boolean };
  setup: IntegrationField[]; capabilities: string[]; botIds: string[];
}
export interface IntegrationCatalog { profile: string; canManage: boolean; connections: IntegrationConnection[] }
export interface IntegrationFlow {
  kind: "redirect" | "device_code" | "instructions" | "connected";
  status: "pending" | "approved" | "error" | "cancelled" | "expired";
  flowId?: string; url?: string; userCode?: string; message: string; expiresAt?: string;
  /** The catalog ID this sign-in connects, from add-ons that report it. */
  connectionId?: string;
  /** Manual callback is used only for an existing installed Google OAuth client. */
  callbackInput?: boolean;
}
export interface CustomMcpInput { name: string; url: string; auth: "none" | "bearer" | "oauth"; token?: string }
export type IntegrationOperation = "list" | "check" | "connect" | "disconnect" | "flow" | "cancel" | "callback" | "add_mcp";
export interface IntegrationRequest { operation: IntegrationOperation; profile: string; id?: string; flowId?: string; fields?: Record<string, string>; mcp?: CustomMcpInput; callbackUrl?: string; redirectUri?: string }

/** The add-on's native ask method. src/hermes/integrations.py CONNECTION_REQUEST must match; tests check. */
export const connectionRequestMethod = "agent_interface.connection_request";
/**
 * An assistant asking a person to set up one of its connections inline in the chat. `connectionId`
 * is a catalog ID such as `google_workspace`, `github` or `key:brave`; `reason` is the assistant's
 * own words. Hermes settles it as connected or declined; a chat message closes it.
 */
export interface ConnectionRequest {
  epoch: string;
  sessionId: string;
  connectionId: string;
  reason: string;
}
export type ConnectionRequestDecision = "connected" | "decline";
export type ConnectionRequestResult = { status: "ok" | "expired" };
export interface ConnectionRequestSettle { decision: ConnectionRequestDecision; profile: string; requestId: string; epoch: string; sessionId: string; connection: string }
/** Catalog statuses that count as set up, so Continue can tell the assistant it may go ahead. */
export const readyConnectionStatuses: readonly IntegrationStatus[] = ["connected", "configured"];
/**
 * Set up, as the server checks before an assistant hears "connected". An OAuth MCP server whose
 * sign-in never finished reads as not connected, from Hermes's own token store.
 */
export const connectionReady = (item?: Pick<IntegrationConnection, "status">) =>
  !!item && readyConnectionStatuses.includes(item.status);
/** Catalog IDs an assistant may ask for. Apple data is chosen on the iPhone, never asked for in chat. */
export const requestableConnectionId = /^(google_workspace|github|synology|supabase|cloudflare|vps|home_assistant|selected_files|discord|key:[a-z0-9_]{1,40}|provider:[A-Za-z0-9_-]{1,80}|mcp:[A-Za-z0-9_-]{1,80})$/;
