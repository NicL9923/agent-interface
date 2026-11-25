import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fileKeys,
  fileSigner,
  safeStagedPath,
  type FileKey,
  type RegisteredFile,
} from "../src/server/file-signer.js";

const token = "hermes-token";
const key: FileKey = { id: "k1", secret: "file-key-secret" };
const older: FileKey = { id: "k0", secret: "older-file-key-secret" };
const unsafe = [
  "relative/file.txt",
  "/workspace/../etc/passwd",
  "/workspace/..",
  "/workspace/a\0b",
  "",
  42,
  undefined,
];
const file: RegisteredFile = {
  path: "/out/chart.png",
  name: "chart.png",
  mime: "image/png",
  botId: "ranch",
  kind: "artifact",
  version: 1,
};
const encode = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const mac = (secret: string, text: string) =>
  createHmac("sha256", secret).update(text).digest("base64url");
// Signs any body, as only a holder of the key could.
const v2 = (value: unknown, signing: FileKey = key) => {
  const signed = `v2.${signing.id}.${encode(value)}`;
  return `${signed}.${mac(signing.secret, signed)}`;
};
const v1 = (value: unknown, secret = token) => `${encode(value)}.${mac(secret, encode(value))}`;
const refusal = (id: string, signer = fileSigner(fileKeys(key), token)) => {
  try {
    signer.fileValue(id);
  } catch (error) {
    return error as Error & { statusCode?: number; reason?: string };
  }
  throw new Error(`${id} was accepted`);
};

describe("staged file paths", () => {
  it("accepts only absolute paths without NUL bytes or parent segments", () => {
    expect(safeStagedPath("/workspace/output/result.png")).toBe(true);
    expect(safeStagedPath("/workspace/..hidden/notes..txt")).toBe(true);
    for (const path of unsafe) expect(safeStagedPath(path)).toBe(false);
  });
});

describe("file identifiers", () => {
  it("signs with the database key, so the same file keeps its identifier when the Hermes token changes", () => {
    const before = fileSigner(fileKeys(key), token).signFile(file);
    const rotated = fileSigner(fileKeys(key), "rotated-hermes-token");
    expect(before.id).toMatch(/^v2\.k1\./);
    expect(before.url).toBe(`/api/files/${encodeURIComponent(before.id)}`);
    expect(rotated.signFile(file).id).toBe(before.id);
    expect(rotated.fileValue(before.id)).toEqual(file);
    // Signing never needs the Hermes token at all.
    expect(fileSigner(fileKeys(key), undefined).fileValue(before.id)).toEqual(file);
  });

  it("verifies an earlier key's identifiers and re-signs them with the current one", () => {
    const signer = fileSigner(fileKeys(key, [older]), undefined);
    const old = v2(file, older);
    expect(signer.fileValue(old)).toEqual(file);
    expect(signer.isCurrent(old)).toBe(false);
    const next = signer.resign(old);
    expect(next.id).toMatch(/^v2\.k1\./);
    expect(signer.isCurrent(next.id)).toBe(true);
  });

  it("verifies identifiers signed with the Hermes token only while that token is configured", () => {
    const legacy = v1(file);
    expect(fileSigner(fileKeys(key), token).fileValue(legacy)).toEqual(file);
    expect(fileSigner(fileKeys(key), token).resign(legacy).id).toBe(
      fileSigner(fileKeys(key), undefined).signFile(file).id,
    );
    for (const missing of [undefined, ""])
      expect(refusal(legacy, fileSigner(fileKeys(key), missing))).toMatchObject({
        statusCode: 404,
        reason: "key",
      });
  });

  it.each([
    ["three parts", "a.b.c", "format"],
    ["an unknown format prefix", `v3.${v2(file).slice(3)}`, "format"],
    ["an empty body", `v2.k1..${mac(key.secret, "v2.k1.")}`, "format"],
    ["an empty signature", `v2.k1.${encode(file)}.`, "format"],
    ["an empty legacy signature", `${encode(file)}.`, "format"],
    ["an unknown key id", v2(file, { id: "gone", secret: key.secret }), "key"],
    [
      "another body's signature",
      `v2.k1.${encode({ ...file, path: "/etc/passwd" })}.${v2(file).split(".")[3]}`,
      "signature",
    ],
    [
      "a signature from another key",
      `v2.k1.${encode(file)}.${mac(older.secret, `v2.k1.${encode(file)}`)}`,
      "signature",
    ],
    // The prefix is signed, so a key's signature over the bare body is not a current identifier.
    [
      "a signature over the body alone",
      `v2.k1.${encode(file)}.${mac(key.secret, encode(file))}`,
      "signature",
    ],
    ["a truncated signature", v2(file).slice(0, -4), "signature"],
    ["a non-canonical signature encoding", `${v2(file)}=`, "signature"],
    ["a legacy identifier signed with another token", v1(file, "old-hermes-token"), "signature"],
    ["a body that is not JSON", v2("not json"), "body"],
    ["a null body", v2(null), "body"],
    ["an unversioned body", v2({ ...file, version: undefined }), "body"],
    ["an unknown kind", v2({ ...file, kind: "download" }), "body"],
    ["a numeric bot", v2({ ...file, botId: 7 }), "body"],
    ["a missing name", v2({ ...file, name: undefined }), "body"],
    ["a missing MIME type", v2({ ...file, mime: undefined }), "body"],
    [
      "an unscoped legacy body",
      v1({ path: "/etc/passwd", name: "passwd", mime: "text/plain", botId: "ranch" }),
      "body",
    ],
  ])("refuses %s as not found", (_, id, reason) => {
    expect(refusal(id)).toMatchObject({
      statusCode: 404,
      message: "That file is no longer available.",
      code: "file_not_found",
      reason,
    });
  });

  it("refuses a correctly signed identifier with an unsafe path", () => {
    for (const path of unsafe)
      expect(refusal(v2({ ...file, path }))).toMatchObject({ statusCode: 404, reason: "path" });
  });
});
