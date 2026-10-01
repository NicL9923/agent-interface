export type IntegrationStatus = "connected" | "configured" | "not_connected" | "expired" | "missing_permission" | "unavailable" | "unsupported";
export type IntegrationCategory = "productivity" | "development" | "files" | "home" | "devices" | "providers" | "messaging" | "custom";
export interface IntegrationField { key: string; label: string; kind: "text" | "secret" | "url"; required: boolean; defaultValue?: string; options?: {value: string; label: string}[] }
export interface IntegrationConnection {
  id: string; name: string; category: IntegrationCategory; owner: string; profile: string;
  account?: string; status: IntegrationStatus; detail: string; checkedAt?: string;
  permissions: { id: string; name: string; granted: boolean | null }[];
  actions: { connect: boolean; check: boolean; disconnect: boolean };
  setup: IntegrationField[]; capabilities: string[]; botIds: string[];
}
export interface IntegrationCatalog { profile: string; canManage: boolean; connections: IntegrationConnection[] }
export interface IntegrationFlow {
  kind: "redirect" | "device_code" | "instructions" | "connected";
  status: "pending" | "approved" | "error" | "cancelled" | "expired";
  flowId?: string; url?: string; userCode?: string; message: string; expiresAt?: string;
  /** Manual callback is used only for an existing installed Google OAuth client. */
  callbackInput?: boolean;
}
export interface CustomMcpInput { name: string; url: string; auth: "none" | "bearer" | "oauth"; token?: string }
export type IntegrationOperation = "list" | "check" | "connect" | "disconnect" | "flow" | "cancel" | "callback" | "add_mcp";
export interface IntegrationRequest { operation: IntegrationOperation; profile: string; id?: string; flowId?: string; fields?: Record<string, string>; mcp?: CustomMcpInput; callbackUrl?: string; redirectUri?: string }
