import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  checkSetup,
  effectiveEnv,
  readPrivateEnv,
  savePrivateEnv,
  resolveSetupOrigin,
  updateEnv,
  verifyAndSave,
} from "../scripts/setup.js";

const directories: string[] = [];
async function file() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-interface-setup-"));
  directories.push(directory);
  return path.join(directory, ".env");
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});
const configured = {
  LOCAL_DEV_AUTH: "true",
};
const original =
  '# Existing private settings\nLOCAL_DEV_AUTH=true\nAPP_ORIGIN="http://127.0.0.1:3000"\nOTHER=keep\n';

describe("host-local connection setup", () => {
  it("preserves comments, unrelated multiline assignments and quoted values, replacing duplicate settings", () => {
    const text =
      '# Keep this\r\nexport OTHER="first\r\nsecond"\r\nAPP_SECRET="old\r\ntoken"\r\nAPP_SECRET=duplicate\r\nEXTRA=\'hash#value\'\r\n';
    const result = updateEnv(text, { APP_SECRET: 'new#token"quoted', LOCAL_DEV_AUTH: "false" });
    expect(result).toContain('# Keep this\r\nexport OTHER="first\r\nsecond"\r\n');
    expect(result).toContain("EXTRA='hash#value'\r\n");
    expect(result.match(/APP_SECRET=/g)).toHaveLength(1);
    expect(parseEnv(result)).toMatchObject({
      OTHER: "first\nsecond",
      APP_SECRET: 'new#token"quoted',
      LOCAL_DEV_AUTH: "false",
      EXTRA: "hash#value",
    });
  });

  it("refuses settings that could inject another environment entry or change a secret during parsing", () => {
    expect(() => updateEnv("", { APP_SECRET: "secret\nLOCAL_DEV_AUTH=true" })).toThrow("one line");
    expect(parseEnv(updateEnv("", { APP_SECRET: "secret\\nvalue" })).APP_SECRET).toBe(
      "secret\\nvalue",
    );
    expect(() => updateEnv("", { APP_SECRET: "all\"three'quotes`" })).toThrow("quote");
  });

  it("uses exported settings just like server startup without changing process environment", () => {
    const exported = {
      GOOGLE_CLIENT_ID: "exported-client",
      HOST: "127.0.0.1",
      UNRELATED: undefined,
    };
    const result = effectiveEnv('GOOGLE_CLIENT_ID="file#client"\nLOCAL_DEV_AUTH=true\n', exported);
    expect(result.values).toMatchObject({
      GOOGLE_CLIENT_ID: "exported-client",
      LOCAL_DEV_AUTH: "true",
      HOST: "127.0.0.1",
    });
    expect(result.values).not.toHaveProperty("UNRELATED");
    expect(result.shadowed).toEqual(["GOOGLE_CLIENT_ID"]);
    expect(exported).toEqual({
      GOOGLE_CLIENT_ID: "exported-client",
      HOST: "127.0.0.1",
      UNRELATED: undefined,
    });
  });

  it("requires an explicit corrected application origin when the saved value is malformed", async () => {
    const values = { ...configured, APP_ORIGIN: "127.0.0.1:3000" };
    const prompt = vi.fn(async () => "http://127.0.0.1:3000");
    const resolved = await resolveSetupOrigin(values, prompt);
    expect(prompt).toHaveBeenCalledOnce();
    expect(resolved.origin.origin).toBe("http://127.0.0.1:3000");
    expect(resolved.correction).toBe("http://127.0.0.1:3000");
    expect(values.APP_ORIGIN).toBe("127.0.0.1:3000");
    await expect(resolveSetupOrigin(values, async () => "")).rejects.toThrow("APP_ORIGIN");
    await expect(checkSetup(values)).rejects.toThrow("APP_ORIGIN");
  });

  it("keeps public and production authentication constraints after an explicit origin correction", async () => {
    const prompt = vi.fn(async () => "https://household.example.com");
    const resolved = await resolveSetupOrigin({ APP_ORIGIN: "household.example.com" }, prompt);
    expect(resolved.origin.origin).toBe("https://household.example.com");
    await expect(checkSetup({ ...configured, APP_ORIGIN: resolved.correction })).rejects.toThrow(
      "Local development auth",
    );
    await expect(
      checkSetup({ ...configured, NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3000" }),
    ).rejects.toThrow("Local development auth");
    await expect(
      resolveSetupOrigin({ APP_ORIGIN: "ftp://localhost" }, async () => "ftp://localhost"),
    ).rejects.toThrow("APP_ORIGIN");
  });

  it("writes atomically with owner-only permissions and refuses a concurrent edit", async () => {
    const filename = await file();
    await fs.writeFile(filename, original, { mode: 0o644 });
    const next = updateEnv(original, { OTHER: "new#value" });
    await savePrivateEnv(filename, original, next);
    expect(await fs.readFile(filename, "utf8")).toBe(next);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    await expect(savePrivateEnv(filename, original, "wrong")).rejects.toThrow(
      "changed during setup",
    );
    expect(await fs.readFile(filename, "utf8")).toBe(next);
    expect(await fs.readdir(path.dirname(filename))).toEqual([".env"]);
  });

  it("creates a new private file and refuses symbolic links", async () => {
    const filename = await file();
    expect(await readPrivateEnv(filename)).toBeUndefined();
    await savePrivateEnv(filename, undefined, original);
    const link = path.join(path.dirname(filename), "linked.env");
    await fs.symlink(filename, link);
    await expect(readPrivateEnv(link)).rejects.toThrow("symbolic link");
    await expect(savePrivateEnv(link, original, "wrong")).rejects.toThrow("symbolic link");
    expect(await fs.readFile(filename, "utf8")).toBe(original);
  });

  it("validates configuration and returns ready for a valid setup", async () => {
    expect(await checkSetup(configured)).toEqual({
      connected: true,
      code: "ready",
      detail: "Configuration is valid.",
    });
  });

  it("requires explicit usable authentication and never downgrades production to local test auth", async () => {
    await expect(checkSetup({ ...configured, LOCAL_DEV_AUTH: "false" })).rejects.toThrow(
      "Configure Google sign-in",
    );
    await expect(checkSetup({ ...configured, NODE_ENV: "production" })).rejects.toThrow(
      "Local development auth",
    );
    await expect(checkSetup({ ...configured, HOST: "0.0.0.0" })).rejects.toThrow(
      "Local development auth",
    );
  });

  it("keeps the previous file when the candidate configuration is invalid", async () => {
    const filename = await file();
    await fs.writeFile(filename, original);
    const next = updateEnv(original, { LOCAL_DEV_AUTH: "false" });
    await expect(verifyAndSave(filename, original, next, {})).rejects.toThrow(
      "Configure Google sign-in",
    );
    expect(await fs.readFile(filename, "utf8")).toBe(original);
  });

  it("persists a verified ready candidate", async () => {
    const filename = await file();
    const next = updateEnv("", configured);
    await verifyAndSave(filename, undefined, next, {});
    expect(await fs.readFile(filename, "utf8")).toBe(next);
  });
});
