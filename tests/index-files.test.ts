import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { FileSigner } from "../src/server/hermes-files.js";
import type { Store } from "../src/server/store.js";

const started = vi.hoisted(() => ({
  database: "",
  runtime: undefined as { files: FileSigner } | undefined,
  store: undefined as Store | undefined,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: () => false }));
vi.mock("../src/server/config.js", () => ({ loadConfig: () => ({ database: started.database, hermesToken: "hermes-token" }) }));
vi.mock("../src/server/hermes.js", () => ({ createHermesRuntime: (options: { files: FileSigner }) => (started.runtime = options) }));
vi.mock("../src/server/app.js", () => ({
  createApp: async (_config: unknown, _runtime: unknown, options: { store: Store }) => {
    started.store = options.store;
    return { app: { listen: async () => {}, log: started.log } };
  },
}));

let directory = "";
afterEach(() => {
  started.store?.close();
  rmSync(directory, { recursive: true, force: true });
});

it("signs with the database's key and upgrades stored identifiers before the app opens", async () => {
  vi.spyOn(process, "on").mockImplementation(() => process);
  directory = mkdtempSync(join(tmpdir(), "index-files-"));
  started.database = join(directory, "app.sqlite");
  const { Store } = await import("../src/server/store.js");
  const seed = new Store(started.database);
  seed.user({ id: "one", email: "one@example.test", name: "One" });
  const body = Buffer.from(JSON.stringify({ path: "/workspace/staged/a.png", name: "a.png", mime: "image/png", botId: "ranch", kind: "upload", version: 1 })).toString("base64url");
  const id = `${body}.${createHmac("sha256", "hermes-token").update(body).digest("base64url")}`;
  seed.saveDraft("one", "ranch", { text: "", attachments: [{ id, name: "a.png", mime: "image/png" }] });
  const key = seed.fileKeys().current;
  seed.close();

  await import("../src/server/index.js");

  // The same database goes to the app, and the runtime signs with its key.
  expect(started.store!.fileKeys().current).toEqual(key);
  expect(started.runtime!.files.signFile({ path: "/b", name: "b", mime: "text/plain", botId: "ranch", kind: "artifact", version: 1 }).id).toMatch(new RegExp(`^v2\\.${key.id}\\.`));
  expect(started.store!.draft("one", "ranch")!.attachments[0].id).toMatch(new RegExp(`^v2\\.${key.id}\\.`));
  expect(started.log.info).toHaveBeenCalledWith({ upgraded: 1, unreadable: 0 }, expect.stringContaining("Re-signed"));
  expect(started.log.warn).not.toHaveBeenCalled();
});
