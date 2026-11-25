import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FileRef } from "../shared/types.js";
import { fileNotFoundMessage, NotFound } from "../shared/errors.js";

/**
 * A file this server vouched for. Its signed form is the only way a client names it.
 * `version` is this body's shape; the identifier's own format is its `v2.` prefix.
 */
export type RegisteredFile = {
  path: string;
  name: string;
  mime: string;
  botId: string;
  kind: "upload" | "artifact";
  version: 1;
};

/**
 * A key this server signs file identifiers with, kept in the app database. Its id travels in each
 * identifier, so a later key can sign new ones while this one still verifies the old.
 */
export type FileKey = { id: string; secret: string };
export type FileKeys = { current: FileKey; find(id: string): FileKey | undefined };

export function generateFileKey(): FileKey {
  return {
    id: randomBytes(6).toString("base64url"),
    secret: randomBytes(32).toString("base64url"),
  };
}
/** Signs with `current` and verifies with it or any of `others`. */
export function fileKeys(current: FileKey, others: FileKey[] = []): FileKeys {
  const byId = new Map([...others, current].map((key) => [key.id, key]));
  return { current, find: (id) => byId.get(id) };
}

/** Why an identifier was refused. Every refusal answers 404 alike, so the reason is for logs and tests only. */
export type FileRefusalReason = "format" | "key" | "signature" | "body" | "path";
export type FileRefusal = NotFound & { reason: FileRefusalReason };
const refuse = (reason: FileRefusalReason): FileRefusal =>
  Object.assign(new NotFound(fileNotFoundMessage, "file_not_found"), { reason });

/** An absolute path with no NUL byte and no parent segment. */
export function safeStagedPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").includes("..")
  );
}

const hmac = (secret: string, text: string) => createHmac("sha256", secret).update(text).digest();

/**
 * The file an identifier names, for comparing two references: the same file signed with another key or
 * format compares equal. It does not verify anything; only use it to compare references that were
 * verified, or whose mismatch costs nothing worse than keeping a person's own draft.
 */
export function fileIdentity(id: string): string {
  const parts = id.split(".");
  const body =
    parts.length === 4 && parts[0] === "v2" ? parts[2] : parts.length === 2 ? parts[0] : undefined;
  if (!body) return id;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString());
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.path !== "string" ||
      typeof value.botId !== "string"
    )
      return id;
    return JSON.stringify([value.path, value.botId, value.kind]);
  } catch {
    return id;
  }
}

/**
 * Signs file identifiers with this server's own key, so only this server can mint them.
 * An identifier is `v2.<key id>.<body>.<signature>`, signed over everything before the last dot.
 */
export function fileSigner(keys: FileKeys, legacyToken?: string) {
  function signFile(value: RegisteredFile): FileRef {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    const signed = `v2.${keys.current.id}.${body}`;
    const id = `${signed}.${hmac(keys.current.secret, signed).toString("base64url")}`;
    return { id, name: value.name, mime: value.mime, url: `/api/files/${encodeURIComponent(id)}` };
  }
  /** The file an identifier names. Throws a 404 FileRefusal for anything this server did not sign. */
  function fileValue(id: string): RegisteredFile {
    const parts = id.split(".");
    let secret: string | undefined, signed: string, body: string, signature: string;
    if (parts.length === 4 && parts[0] === "v2") {
      [, , body, signature] = parts;
      signed = parts.slice(0, 3).join(".");
      secret = keys.find(parts[1])?.secret;
    } else if (parts.length === 2) {
      [body, signature] = parts;
      signed = body;
      secret = legacyToken;
    } else throw refuse("format");
    if (!body || !signature) throw refuse("format");
    if (!secret) throw refuse("key");
    const expected = hmac(secret, signed);
    const actual = Buffer.from(signature, "base64url");
    // Only the canonical encoding counts, so one file never has two identifiers.
    if (
      actual.toString("base64url") !== signature ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    )
      throw refuse("signature");
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
    } catch {
      throw refuse("body");
    }
    if (
      !value ||
      typeof value !== "object" ||
      value.version !== 1 ||
      (value.kind !== "upload" && value.kind !== "artifact") ||
      typeof value.botId !== "string" ||
      typeof value.name !== "string" ||
      typeof value.mime !== "string"
    )
      throw refuse("body");
    if (!safeStagedPath(value.path)) throw refuse("path");
    return {
      path: value.path,
      name: value.name,
      mime: value.mime,
      botId: value.botId,
      kind: value.kind,
      version: 1,
    };
  }
  /** Whether an identifier is already signed with the current key, so an upgrade leaves it alone. */
  function isCurrent(id: string): boolean {
    return id.startsWith(`v2.${keys.current.id}.`);
  }
  /** The same file signed with the current key. Throws the FileRefusal for an identifier that does not verify. */
  function resign(id: string): FileRef {
    return signFile(fileValue(id));
  }
  return { signFile, fileValue, isCurrent, resign };
}
export type FileSigner = ReturnType<typeof fileSigner>;
