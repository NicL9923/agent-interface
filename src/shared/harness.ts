export const NATIVE_HARNESS_KINDS = ["codex", "claude", "grok", "pi"] as const;
export type NativeHarnessKind = (typeof NATIVE_HARNESS_KINDS)[number];

export const HARNESS_KINDS = ["hermes", ...NATIVE_HARNESS_KINDS] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export const CREDENTIAL_KINDS = ["subscription", "api_key"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface ManagedBotRecord {
  id: string;
  name: string;
  description: string;
  instructions: string;
  harness: HarnessKind;
  model: string;
  provider: string;
  reasoning: string;
  speed: string;
  ownerId: string;
  ownerOsUser: string;
  shared: boolean;
  /** Hermes has no registry credential. An archived bot can also have its credential removed. */
  credentialId: string | null;
  enabledTools: string[];
  enabledSkills: string[];
  enabledMcpServers: string[];
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

/** References to host configuration. WildBots never reads or stores vendor CLI tokens. */
export interface CredentialRecord {
  id: string;
  label: string;
  vendor: "anthropic" | "openai" | "xai" | "openrouter" | "google" | "custom";
  kind: CredentialKind;
  /** Required for a subscription. */
  ownerId?: string;
  allowedHarnesses: NativeHarnessKind[];
  /** Environment variable name for an API key. */
  envVar?: string;
  /** Unix account that holds the vendor CLI login. */
  osUser?: string;
  createdAt: number;
  updatedAt: number;
}
