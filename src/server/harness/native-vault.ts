import { randomBytes } from "node:crypto";
import { Conflict, InvalidInput } from "../../shared/errors.js";
import type { ManagedBotRecord } from "../../shared/harness.js";
import type {
  ProfileVault,
  VaultLogin,
  VaultRequest,
  VaultResponse,
  VaultSource,
} from "../../shared/vault.js";
import type { Store } from "../store.js";

const LOGIN_PREFIX = "login:";
const IDENTIFIER_TYPES = new Set(["email", "phone", "username"]);

interface StoredLogin {
  id: string;
  kind?: string;
  label: string;
  origin: string;
  identifierType: "email" | "phone" | "username";
  identifier: string;
  password?: string;
  otpSecret?: string;
  createdAt?: string;
  allowedOrigins?: string[];
}

const LOCAL_SOURCE: VaultSource = {
  name: "local",
  displayName: "WildBots vault",
  enabled: true,
  needsUnlock: false,
  unlocked: true,
  installed: true,
  canToggle: false,
  canUnlock: false,
  canLock: false,
};

function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidInput("Enter a valid http:// or https:// site address.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  )
    throw new InvalidInput("Enter only the site origin, such as https://example.com.");
  return url.origin;
}

function toVaultLogin(
  secretName: string,
  rawJson: string,
  createdAtMs: number,
): VaultLogin | undefined {
  let parsed: Partial<StoredLogin>;
  try {
    parsed = JSON.parse(rawJson) as Partial<StoredLogin>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const id =
    typeof parsed.id === "string" && parsed.id.trim()
      ? parsed.id.trim()
      : secretName.slice(LOGIN_PREFIX.length);
  const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
  const origin = typeof parsed.origin === "string" ? parsed.origin.trim() : "";
  const identifier = typeof parsed.identifier === "string" ? parsed.identifier.trim() : "";
  const identifierType = IDENTIFIER_TYPES.has(parsed.identifierType ?? "")
    ? (parsed.identifierType as VaultLogin["identifierType"])
    : "username";
  if (!id || !label || !origin || !identifier) return undefined;
  const createdAt =
    typeof parsed.createdAt === "string" && parsed.createdAt.trim()
      ? parsed.createdAt
      : new Date(createdAtMs).toISOString();
  return {
    id,
    kind: "login",
    label,
    origin,
    createdAt,
    identifier,
    identifierType,
    hasOtp: typeof parsed.otpSecret === "string" && parsed.otpSecret.trim().length > 0,
    backend: "local",
    canRemove: true,
  };
}

/**
 * Serves bot-scoped encrypted logins from `store.secrets` (`bot_secrets` under `login:<id>`).
 * Passwords and OTP secrets are encrypted at rest with AES-256-GCM and never returned by `overview`.
 */
export function createNativeVaultHandler(
  store: Store,
  requireBot: (id: string) => ManagedBotRecord,
): (input: VaultRequest) => Promise<VaultResponse> {
  return async (input: VaultRequest): Promise<VaultResponse> => {
    const bot = requireBot(input.profile);
    const scope = { kind: "bot" as const, id: bot.id };
    switch (input.operation) {
      case "overview": {
        const rows = store.secrets.listScopeSecrets(scope, LOGIN_PREFIX);
        const items: VaultLogin[] = [];
        for (const row of rows) {
          const item = toVaultLogin(row.name, row.value, row.createdAt);
          if (item) items.push(item);
        }
        return {
          botId: bot.id,
          profile: bot.id,
          scope: "profile",
          owner: "WildBots",
          notice:
            "Logins are encrypted in this assistant's WildBots vault and never printed in chat.",
          items,
          sources: [{ ...LOCAL_SOURCE }],
        } satisfies ProfileVault;
      }
      case "add_login": {
        const { login } = input;
        const label = login.label.trim();
        const identifier = login.identifier.trim();
        if (!label || !identifier || !login.password)
          throw new InvalidInput("Enter a label, sign-in identifier, and password.");
        if (!IDENTIFIER_TYPES.has(login.identifierType))
          throw new InvalidInput("Choose email, phone, or username.");
        const origin = normalizeOrigin(login.origin);
        const id = `vault_${randomBytes(6).toString("hex")}`;
        const otpSecret = login.otpSecret?.trim() || undefined;
        const payload: StoredLogin = {
          id,
          kind: "login",
          label,
          origin,
          identifierType: login.identifierType,
          identifier,
          password: login.password,
          ...(otpSecret ? { otpSecret } : {}),
          createdAt: new Date().toISOString(),
          allowedOrigins: [origin],
        };
        store.secrets.setSecret(
          scope,
          `${LOGIN_PREFIX}${id}`,
          JSON.stringify(payload),
          input.actor?.trim() || "vault",
        );
        return { id };
      }
      case "remove_login": {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.itemId))
          throw new InvalidInput("Invalid login identifier.");
        const removed = store.secrets.deleteSecret(scope, `${LOGIN_PREFIX}${input.itemId}`);
        return { removed };
      }
      case "answer":
        return { status: "expired" };
      case "source":
      case "unlock":
      case "lock":
        throw new Conflict("External password managers are not configured on this server.");
    }
  };
}
