import { randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
import { Conflict, InvalidInput } from "../../shared/errors.js";
import type { ManagedBotRecord } from "../../shared/harness.js";
import type { AttentionRequest } from "../../shared/types.js";
import type {
  ProfileVault,
  SecureRequest,
  SecureRequestMethod,
  VaultLogin,
  VaultRequest,
  VaultResponse,
  VaultSecret,
  VaultSource,
} from "../../shared/vault.js";
import type { SecretInputOutcome } from "../mcp/wildbots-mcp.js";
import { isReservedSecretName } from "../store-secrets.js";
import type { Store } from "../store.js";

const LOGIN_PREFIX = "login:";
const IDENTIFIER_TYPES = new Set(["email", "phone", "username"]);
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

export type LoginInputOutcome =
  | { status: "cancelled" }
  | { status: "saved"; loginId: string; origin: string; identifier: string; label: string };

export type CodeInputOutcome = { status: "cancelled" } | { status: "submitted"; code: string };

type PendingSecureEntry = {
  id: string;
  botId: string;
  epoch: string;
  sessionId: string;
  method: SecureRequestMethod;
  attention: AttentionRequest;
  requestedBy?: string;
  expectedOrigin?: string;
  loginLabel?: string;
  settle: (outcome: unknown) => void;
  cleanup: () => void;
};

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

export function normalizeVaultOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
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

function inferIdentifierType(identifier: string): VaultLogin["identifierType"] {
  if (identifier.includes("@")) return "email";
  if (/^[+\d][\d\s().-]{5,}$/.test(identifier)) return "phone";
  return "username";
}

function validateSecretName(raw: string): string {
  const name = raw.trim();
  if (!name || !SECRET_NAME.test(name) || isReservedSecretName(name))
    throw new InvalidInput(
      "Secret names use letters, numbers, dots, dashes, and underscores, up to 128 characters.",
    );
  return name;
}

function sanitizeToken(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
  return cleaned || fallback;
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

export interface NativeVaultService {
  handle(input: VaultRequest): Promise<VaultResponse>;
  requestSecret(
    input: { botId: string; name: string; prompt: string; epoch: string; sessionId: string },
    signal: AbortSignal,
  ): Promise<SecretInputOutcome>;
  requestLogin(
    input: {
      botId: string;
      origin: string;
      label: string;
      purpose: string;
      requestedBy?: string;
      epoch: string;
      sessionId: string;
    },
    signal: AbortSignal,
  ): Promise<LoginInputOutcome>;
  requestCode(
    input: { botId: string; site?: string; hint?: string; epoch: string; sessionId: string },
    signal: AbortSignal,
  ): Promise<CodeInputOutcome>;
  listPending(botId: string): AttentionRequest[];
  hasPending(botId: string): boolean;
  cancelPending(botId: string, options?: { sessionId?: string; actor?: string }): void;
  close(): void;
}

/**
 * Serves bot-scoped encrypted logins, named secrets, and live in-chat secure requests
 * backed by `store.secrets` (`bot_secrets`). Passwords, OTP seeds, and secret values are
 * encrypted at rest with AES-256-GCM and never returned by `overview`.
 */
export function createNativeVaultService({
  store,
  requireBot,
  onChanged,
}: {
  store: Store;
  requireBot: (id: string) => ManagedBotRecord;
  onChanged?: (botId: string) => void;
}): NativeVaultService {
  const pending = new Map<string, PendingSecureEntry>();

  function saveLoginRecord(
    botId: string,
    input: {
      label: string;
      origin: string;
      identifierType: VaultLogin["identifierType"];
      identifier: string;
      password: string;
      otpSecret?: string;
      actor?: string;
    },
  ): { id: string; origin: string; identifier: string; label: string } {
    const label = input.label.trim();
    const identifier = input.identifier.trim();
    if (!label || !identifier || !input.password)
      throw new InvalidInput("Enter a label, sign-in identifier, and password.");
    if (!IDENTIFIER_TYPES.has(input.identifierType))
      throw new InvalidInput("Choose email, phone, or username.");
    const origin = normalizeVaultOrigin(input.origin);
    const id = `vault_${randomBytes(6).toString("hex")}`;
    const otpSecret = input.otpSecret?.trim() || undefined;
    const payload: StoredLogin = {
      id,
      kind: "login",
      label,
      origin,
      identifierType: input.identifierType,
      identifier,
      password: input.password,
      ...(otpSecret ? { otpSecret } : {}),
      createdAt: new Date().toISOString(),
      allowedOrigins: [origin],
    };
    store.secrets.setSecret(
      { kind: "bot", id: botId },
      `${LOGIN_PREFIX}${id}`,
      JSON.stringify(payload),
      input.actor?.trim() || "vault",
    );
    return { id, origin, identifier, label };
  }

  function registerPending<T>(
    entry: Omit<PendingSecureEntry, "id" | "settle" | "cleanup" | "attention"> & {
      title: string;
      detail: string;
      secure: SecureRequest;
    },
    signal: AbortSignal,
    cancelledValue: T,
  ): Promise<T> {
    if (signal.aborted) return Promise.resolve(cancelledValue);
    const id = `sr_${randomBytes(8).toString("hex")}`;
    return new Promise<T>((resolve) => {
      let done = false;
      const finish = (outcome: T) => {
        if (done) return;
        done = true;
        pending.delete(id);
        cleanup();
        onChanged?.(entry.botId);
        resolve(outcome);
      };
      const listener = addAbortListener(signal, () => finish(cancelledValue));
      const cleanup = () => listener[Symbol.dispose]();
      pending.set(id, {
        id,
        botId: entry.botId,
        epoch: entry.epoch,
        sessionId: entry.sessionId,
        method: entry.method,
        requestedBy: entry.requestedBy,
        expectedOrigin: entry.expectedOrigin,
        loginLabel: entry.loginLabel,
        attention: {
          id,
          kind: "secure",
          title: entry.title,
          detail: entry.detail,
          secure: entry.secure,
        },
        settle: (outcome) => finish(outcome as T),
        cleanup,
      });
      onChanged?.(entry.botId);
    });
  }

  async function handle(input: VaultRequest): Promise<VaultResponse> {
    const bot = requireBot(input.profile);
    const scope = { kind: "bot" as const, id: bot.id };
    switch (input.operation) {
      case "overview": {
        const allRows = store.secrets.listScopeSecrets(scope);
        const items: VaultLogin[] = [];
        const secrets: VaultSecret[] = [];
        for (const row of allRows) {
          if (row.name.startsWith(LOGIN_PREFIX)) {
            const item = toVaultLogin(row.name, row.value, row.createdAt);
            if (item) items.push(item);
          } else if (!isReservedSecretName(row.name)) {
            secrets.push({
              name: row.name,
              createdAt: new Date(row.createdAt).toISOString(),
              updatedAt: new Date(row.updatedAt).toISOString(),
              canRemove: true,
            });
          }
        }
        return {
          botId: bot.id,
          profile: bot.id,
          scope: "profile",
          owner: "WildBots",
          notice:
            "Logins and secrets are encrypted in this assistant's WildBots vault and never printed in chat.",
          items,
          secrets,
          sources: [{ ...LOCAL_SOURCE }],
        } satisfies ProfileVault;
      }
      case "add_login": {
        const saved = saveLoginRecord(bot.id, { ...input.login, actor: input.actor });
        return { id: saved.id };
      }
      case "remove_login": {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.itemId))
          throw new InvalidInput("Invalid login identifier.");
        const removed = store.secrets.deleteSecret(scope, `${LOGIN_PREFIX}${input.itemId}`);
        return { removed };
      }
      case "add_secret": {
        const name = validateSecretName(input.secret.name);
        if (!input.secret.value || input.secret.value.length > 20_000)
          throw new InvalidInput("Enter a secret value.");
        store.secrets.setSecret(scope, name, input.secret.value, input.actor?.trim() || "vault");
        return { name };
      }
      case "remove_secret": {
        const name = validateSecretName(input.name);
        const removed = store.secrets.deleteSecret(scope, name);
        return { removed };
      }
      case "answer": {
        const entry = pending.get(input.requestId);
        if (
          !entry ||
          entry.botId !== bot.id ||
          entry.epoch !== input.answer.epoch ||
          entry.sessionId !== input.answer.sessionId ||
          entry.method !== input.answer.method
        )
          return { status: "expired" };
        if (entry.requestedBy && entry.requestedBy !== input.actor)
          throw new Conflict("Only the member whose request this is can answer or cancel it.");
        if ("cancel" in input.answer) {
          entry.settle({ status: "cancelled" });
          return { status: "ok" };
        }
        if (entry.method === "secret" && "value" in input.answer) {
          entry.settle({
            status: "submitted",
            save: { value: input.answer.value, createdBy: input.actor },
          } satisfies SecretInputOutcome);
          return { status: "ok" };
        }
        if (entry.method === "vault.save_login" && "identifier" in input.answer) {
          if (entry.expectedOrigin && input.answer.origin !== entry.expectedOrigin)
            throw new Conflict("The website address did not match this login request.");
          const origin = entry.expectedOrigin ?? input.answer.origin;
          if (!origin) throw new InvalidInput("A website address is required.");
          const identifier = input.answer.identifier.trim();
          const saved = saveLoginRecord(bot.id, {
            label: entry.loginLabel || new URL(origin).host,
            origin,
            identifierType: inferIdentifierType(identifier),
            identifier,
            password: input.answer.password,
            actor: input.actor,
          });
          entry.settle({
            status: "saved",
            loginId: saved.id,
            origin: saved.origin,
            identifier: saved.identifier,
            label: saved.label,
          } satisfies LoginInputOutcome);
          return { status: "ok" };
        }
        if (entry.method === "vault.code" && "value" in input.answer) {
          entry.settle({
            status: "submitted",
            code: input.answer.value,
          } satisfies CodeInputOutcome);
          return { status: "ok" };
        }
        return { status: "expired" };
      }
      case "source":
      case "unlock":
      case "lock":
        throw new Conflict("External password managers are not configured on this server.");
    }
  }

  return {
    handle,
    requestSecret(input, signal) {
      requireBot(input.botId);
      const name = validateSecretName(input.name);
      const prompt = input.prompt.trim();
      if (!prompt) throw new InvalidInput("Enter a prompt describing the requested secret.");
      const epoch = sanitizeToken(input.epoch, "epoch");
      const sessionId = sanitizeToken(input.sessionId, "session");
      return registerPending<SecretInputOutcome>(
        {
          botId: input.botId,
          epoch,
          sessionId,
          method: "secret",
          title: `Enter ${name}`,
          detail: prompt,
          secure: { epoch, sessionId, method: "secret", envVar: name, prompt },
        },
        signal,
        { status: "cancelled" },
      );
    },
    requestLogin(input, signal) {
      requireBot(input.botId);
      const origin = normalizeVaultOrigin(input.origin);
      const site = new URL(origin).host;
      const label = input.label.trim() || site;
      const purpose = input.purpose.trim() || `Sign in to ${site}.`;
      const epoch = sanitizeToken(input.epoch, "epoch");
      const sessionId = sanitizeToken(input.sessionId, "session");
      const requestedBy = input.requestedBy?.trim() || undefined;
      return registerPending<LoginInputOutcome>(
        {
          botId: input.botId,
          epoch,
          sessionId,
          method: "vault.save_login",
          requestedBy,
          expectedOrigin: origin,
          loginLabel: label,
          title: `Save login for ${label}`,
          detail: purpose,
          secure: {
            epoch,
            sessionId,
            method: "vault.save_login",
            origin,
            site,
            explicit: {
              label,
              purpose,
              profile: input.botId,
              ...(requestedBy ? { requestedBy: { id: requestedBy } } : {}),
            },
          },
        },
        signal,
        { status: "cancelled" },
      );
    },
    requestCode(input, signal) {
      requireBot(input.botId);
      const site = input.site?.trim() || undefined;
      const hint = input.hint?.trim() || undefined;
      const epoch = sanitizeToken(input.epoch, "epoch");
      const sessionId = sanitizeToken(input.sessionId, "session");
      return registerPending<CodeInputOutcome>(
        {
          botId: input.botId,
          epoch,
          sessionId,
          method: "vault.code",
          title: site ? `Verification code for ${site}` : "Enter verification code",
          detail: hint || "Enter the one-time verification code to continue.",
          secure: {
            epoch,
            sessionId,
            method: "vault.code",
            ...(site ? { site } : {}),
            ...(hint ? { hint } : {}),
          },
        },
        signal,
        { status: "cancelled" },
      );
    },
    listPending(botId) {
      return [...pending.values()]
        .filter((entry) => entry.botId === botId)
        .map((entry) => entry.attention);
    },
    hasPending(botId) {
      for (const entry of pending.values()) if (entry.botId === botId) return true;
      return false;
    },
    cancelPending(botId, options = {}) {
      for (const entry of [...pending.values()]) {
        if (entry.botId !== botId) continue;
        if (options.sessionId && entry.sessionId !== options.sessionId) continue;
        // Explicit login requests stay open when a different household member sends a chat message.
        if (options.actor && entry.requestedBy && entry.requestedBy !== options.actor) continue;
        entry.settle({ status: "cancelled" });
      }
    },
    close() {
      for (const entry of [...pending.values()]) entry.settle({ status: "cancelled" });
    },
  };
}

/**
 * Serves bot-scoped encrypted logins and named secrets from `store.secrets` (`bot_secrets`).
 * Passwords, OTP secrets, and secret values are encrypted at rest with AES-256-GCM and never
 * returned by `overview`.
 */
export function createNativeVaultHandler(
  store: Store,
  requireBot: (id: string) => ManagedBotRecord,
): (input: VaultRequest) => Promise<VaultResponse> {
  const service = createNativeVaultService({ store, requireBot });
  return (input) => service.handle(input);
}
