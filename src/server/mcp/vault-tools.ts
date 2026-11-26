import { createHmac } from "node:crypto";
import { z } from "zod";
import type { BrowserPageBridge } from "../harness/native-computer.js";
import type { SecretRepository } from "../store-secrets.js";
import { toolDefinition, toolFailure, toolResult, type McpToolProvider } from "./mac-tools.js";

const LOGIN_PREFIX = "login:";

interface StoredLogin {
  id: string;
  label: string;
  origin: string;
  identifierType: "email" | "phone" | "username";
  identifier: string;
  password?: string;
  otpSecret?: string;
  allowedOrigins?: string[];
}

const emptySchema = z.strictObject({});
const fillLoginSchema = z.strictObject({
  login_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/, "Provide a valid login_id."),
  submit: z.boolean().optional(),
});
const fillTotpSchema = z.strictObject({
  login_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/, "Provide a valid login_id."),
  submit: z.boolean().optional(),
});

const listDef = toolDefinition(
  "vault_list_logins",
  "List saved website logins in this assistant's encrypted WildBots vault (metadata only — passwords are never returned).",
  emptySchema,
);
const fillLoginDef = toolDefinition(
  "vault_login_fill",
  "Sign in on the shared browser using a saved login from this assistant's encrypted WildBots vault. Only fills when the browser's current origin matches the saved login's origin; passwords are never exposed.",
  fillLoginSchema,
);
const fillTotpDef = toolDefinition(
  "vault_totp_fill",
  "Fill a current 6-digit TOTP authenticator code from a saved login directly into the shared browser when the current origin matches.",
  fillTotpSchema,
);

/** RFC 4648 base32 decode for TOTP secrets (ignores spaces, hyphens, and case). */
function decodeBase32(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.toUpperCase().replace(/[\s=-]+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("Invalid OTP secret encoding.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 6-digit SHA-1 TOTP code. */
export function generateTotpCode(secret: string, nowMs = Date.now()): string {
  const key = decodeBase32(secret);
  const counter = Math.floor(nowMs / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(counterBuf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    (((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff)) %
    1_000_000;
  return String(code).padStart(6, "0");
}

function parseStoredLogin(name: string, raw: string): StoredLogin | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLogin>;
    if (!parsed || typeof parsed !== "object") return undefined;
    const id =
      typeof parsed.id === "string" && parsed.id.trim()
        ? parsed.id.trim()
        : name.slice(LOGIN_PREFIX.length);
    if (
      !id ||
      typeof parsed.label !== "string" ||
      typeof parsed.origin !== "string" ||
      typeof parsed.identifier !== "string"
    )
      return undefined;
    return {
      id,
      label: parsed.label.trim(),
      origin: parsed.origin.trim(),
      identifierType:
        parsed.identifierType === "email" ||
        parsed.identifierType === "phone" ||
        parsed.identifierType === "username"
          ? parsed.identifierType
          : "username",
      identifier: parsed.identifier.trim(),
      ...(typeof parsed.password === "string" ? { password: parsed.password } : {}),
      ...(typeof parsed.otpSecret === "string" ? { otpSecret: parsed.otpSecret } : {}),
      allowedOrigins: Array.isArray(parsed.allowedOrigins)
        ? parsed.allowedOrigins.filter((item): item is string => typeof item === "string")
        : [parsed.origin.trim()],
    };
  } catch {
    return undefined;
  }
}

/**
 * WildBots MCP tools for vault-safe browser sign-in.
 * Passwords and TOTP seeds are decrypted inside the server process, verified against the active
 * page's exact origin, and injected directly via CDP — never returned to the LLM.
 */
export function createVaultMcpTools({
  secrets,
  browserBridge,
  now = Date.now,
}: {
  secrets: SecretRepository;
  browserBridge?: BrowserPageBridge;
  now?: () => number;
}): McpToolProvider {
  const definitions = browserBridge ? [listDef, fillLoginDef, fillTotpDef] : [listDef];

  function loadLogins(botId: string): StoredLogin[] {
    const rows = secrets.listScopeSecrets({ kind: "bot", id: botId }, LOGIN_PREFIX);
    const items: StoredLogin[] = [];
    for (const row of rows) {
      const parsed = parseStoredLogin(row.name, row.value);
      if (parsed) items.push(parsed);
    }
    return items;
  }

  return {
    listTools: () => definitions,
    async callTool(ctx, name, args, signal) {
      try {
        if (name === "vault_list_logins") {
          const parsed = emptySchema.safeParse(args ?? {});
          if (!parsed.success)
            return toolFailure("invalid_arguments", parsed.error.issues[0].message);
          const logins = loadLogins(ctx.botId).map((item) => ({
            id: item.id,
            label: item.label,
            origin: item.origin,
            identifier: item.identifier,
            identifierType: item.identifierType,
            hasOtp: Boolean(item.otpSecret?.trim()),
          }));
          return toolResult({ ok: true, value: { logins } });
        }

        if (name === "vault_login_fill") {
          if (!browserBridge)
            return toolFailure("browser_unavailable", "The shared browser is not configured.");
          const parsed = fillLoginSchema.safeParse(args ?? {});
          if (!parsed.success)
            return toolFailure("invalid_arguments", parsed.error.issues[0].message);
          const login = loadLogins(ctx.botId).find((item) => item.id === parsed.data.login_id);
          if (!login || !login.password)
            return toolFailure(
              "login_not_found",
              "Saved login not found in this assistant's vault.",
            );
          const expectedOrigins = [...new Set([login.origin, ...(login.allowedOrigins ?? [])])];
          const filled = await browserBridge.fillLoginFields(
            {
              expectedOrigins,
              identifier: login.identifier,
              password: login.password,
              submit: parsed.data.submit ?? false,
            },
            signal,
          );
          return toolResult({
            ok: true,
            value: {
              loginId: login.id,
              label: login.label,
              origin: filled.origin,
              filledUsername: filled.filledUsername,
              filledPassword: filled.filledPassword,
              submitted: filled.submitted,
            },
          });
        }

        if (name === "vault_totp_fill") {
          if (!browserBridge)
            return toolFailure("browser_unavailable", "The shared browser is not configured.");
          const parsed = fillTotpSchema.safeParse(args ?? {});
          if (!parsed.success)
            return toolFailure("invalid_arguments", parsed.error.issues[0].message);
          const login = loadLogins(ctx.botId).find((item) => item.id === parsed.data.login_id);
          if (!login)
            return toolFailure(
              "login_not_found",
              "Saved login not found in this assistant's vault.",
            );
          if (!login.otpSecret?.trim())
            return toolFailure("no_otp", "This saved login does not have an authenticator secret.");
          const expectedOrigins = [...new Set([login.origin, ...(login.allowedOrigins ?? [])])];
          const code = generateTotpCode(login.otpSecret, now());
          const filled = await browserBridge.fillTotpField(
            {
              expectedOrigins,
              code,
              submit: parsed.data.submit ?? false,
            },
            signal,
          );
          return toolResult({
            ok: true,
            value: {
              loginId: login.id,
              label: login.label,
              origin: filled.origin,
              filledCode: filled.filledCode,
              submitted: filled.submitted,
            },
          });
        }

        return toolFailure("unknown_tool", "Unknown vault tool.");
      } catch (error) {
        if (signal?.aborted) return toolFailure("cancelled", "The vault action was cancelled.");
        const message =
          error instanceof Error ? error.message : "The vault sign-in action could not complete.";
        return toolFailure("failed", secrets.redactForBot(ctx.botId, message));
      }
    },
  };
}
