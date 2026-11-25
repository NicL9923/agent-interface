import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fileSigner, type FileSigner } from "../src/server/file-signer.js";
import type { Store } from "../src/server/store.js";

const started = vi.hoisted(() => ({
  database: "",
  runtime: undefined as { files: FileSigner } | undefined,
  store: undefined as Store | undefined,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  existsSync: () => false,
}));
vi.mock("../src/server/config.js", () => ({
  loadConfig: () => ({ database: started.database }),
}));
vi.mock("../src/server/native-harness.js", () => ({
  composeServerRuntime: async (options: { files: FileSigner }) => {
    started.runtime = options;
    return {
      runtime: {},
      probeHarnesses: async () => [],
      sweptQueueItems: 0,
      attachMacs: () => {},
      close: async () => {},
    };
  },
}));
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
  const oldKey = seed.fileKeys().current;
  const oldSigner = fileSigner(seed.fileKeys());
  const { id } = oldSigner.signFile({
    path: "/workspace/staged/a.png",
    name: "a.png",
    mime: "image/png",
    botId: "ranch",
    kind: "upload",
    version: 1,
  });
  // Rotate the active file key so startup re-signs stored identifiers onto the newer key.
  seed.db
    .prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
    .run("file_key:newer001", "newer-secret-value-for-testing-key-rotation");
  seed.db.prepare("UPDATE metadata SET value = ? WHERE key = 'file_key_current'").run("newer001");
  const key = seed.fileKeys().current;
  expect(key.id).not.toBe(oldKey.id);
  seed.saveDraft("one", "ranch", {
    text: "",
    attachments: [{ id, name: "a.png", mime: "image/png" }],
  });
  seed.close();

  await import("../src/server/index.js");

  // The same database goes to the app, and the runtime signs with its key.
  expect(started.store!.fileKeys().current).toEqual(key);
  expect(
    started.runtime!.files.signFile({
      path: "/b",
      name: "b",
      mime: "text/plain",
      botId: "ranch",
      kind: "artifact",
      version: 1,
    }).id,
  ).toMatch(new RegExp(`^v2\\.${key.id}\\.`));
  expect(started.store!.draft("one", "ranch")!.attachments[0].id).toMatch(
    new RegExp(`^v2\\.${key.id}\\.`),
  );
  expect(started.log.info).toHaveBeenCalledWith(
    { upgraded: 1, unreadable: 0 },
    expect.stringContaining("Re-signed"),
  );
  expect(started.log.warn).not.toHaveBeenCalled();
});
