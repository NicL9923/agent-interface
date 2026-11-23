import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { rawDataText } from "../src/server/raw-data-text.js";
import { Store, schemaVersion } from "../src/server/store.js";
import { fakeRuntime } from "../tests/helpers/fake-runtime.js";
import { botFixture, capabilitiesFixture } from "../tests/helpers/runtime-fixtures.js";

const bunVersion = process.versions.bun;
assert(bunVersion, "Run this smoke check with Bun");
const deadline = setTimeout(() => {
  console.error("Bun smoke check timed out");
  process.exit(1);
}, 15_000);
deadline.unref();

const directory = await mkdtemp(join(tmpdir(), "wildbots-bun-"));
try {
  const origin = "http://127.0.0.1";
  const config = loadConfig({
    APP_DATABASE: join(directory, "app.sqlite"),
    APP_ORIGIN: origin,
    LOCAL_DEV_AUTH: "true",
    MAC_LINK_KEY: randomBytes(32).toString("base64url"),
  });
  const store = new Store(config.database);
  const bot = botFixture({ id: "smoke" });
  let runtimeClosed = false;
  let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
  let socket: WebSocket | undefined;
  try {
    ({ app } = await createApp(
      config,
      fakeRuntime({
        status: async () => ({ connected: true }),
        listBots: async () => [bot],
        capabilities: async () => capabilitiesFixture({ uploads: { supported: true } }),
        upload: async (botId, { name, mime, data }) => {
          assert.equal(botId, bot.id);
          assert.equal(data.toString(), "smoke upload");
          return { id: "smoke-file", name, mime, size: data.byteLength };
        },
        close: async () => {
          runtimeClosed = true;
        },
      }),
      { store, background: false, clientRoot: join(directory, "client") },
    ));
    const address = await app.listen({ host: config.host, port: 0 });
    const request = async (path: string, init?: RequestInit, status = 200) => {
      const response = await fetch(address + path, { ...init, signal: AbortSignal.timeout(5_000) });
      if (response.status !== status)
        throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
      return response;
    };
    assert.deepEqual(await (await request("/api/health")).json(), { ok: true });
    const ready = await (await request("/api/health/ready")).json();
    assert.equal(ready.ok, true);
    assert.equal(ready.checks?.database?.status, "ok");
    assert.equal(ready.checks?.hermes?.status, "ok");

    const { db } = store;
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, schemaVersion);
    db.exec("CREATE VIRTUAL TABLE temp.smoke_search USING fts5(body)");
    db.prepare("INSERT INTO smoke_search(body) VALUES (?)").run("wildbots smoke");
    assert.equal(
      db.prepare("SELECT body FROM smoke_search WHERE smoke_search MATCH ?").get("wildbots")?.body,
      "wildbots smoke",
    );

    const login = await request("/api/auth/local", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ member: "one" }),
    });
    const { user, csrfToken } = await login.json();
    assert.equal(user?.id, "local-one");
    assert.equal(typeof csrfToken, "string");
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert(cookie, "Local sign-in did not set a session cookie");
    assert.match(cookie, /^session=[a-f0-9]{64}$/);
    const macsPath = "/api/mac/devices";
    const guest = await request(macsPath, undefined, 401);
    assert.equal((await guest.json()).code, "session_expired");
    const mac = store.macs.enroll(user.id, { name: "Smoke Mac" });
    assert(mac, "Could not enroll a smoke-test Mac");
    const signedIn = await request(macsPath, { headers: { cookie } });
    const { devices } = await signedIn.json();
    assert.equal(devices[0]?.id, mac.device.id);

    const form = new FormData();
    form.append("file", new Blob(["smoke upload"], { type: "text/plain" }), "smoke.txt");
    const upload = await request(`/api/bots/${bot.id}/uploads`, {
      method: "POST",
      headers: { cookie, origin, "x-csrf-token": csrfToken },
      body: form,
    });
    assert.deepEqual(await upload.json(), {
      id: "smoke-file",
      name: "smoke.txt",
      mime: "text/plain",
      size: 12,
    });

    socket = new WebSocket(address.replace(/^http:/, "ws:") + "/api/mac/link", {
      headers: { authorization: `Device ${mac.device.id}.${mac.credential}` },
      handshakeTimeout: 5_000,
    });
    await once(socket, "open");
    const welcome = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: 1,
        appVersion: "smoke",
        state: {
          paused: false,
          screenLocked: false,
          screenPermission: "denied",
          folders: [],
          grants: [],
        },
      }),
    );
    const [data] = await welcome;
    assert.deepEqual(JSON.parse(rawDataText(data)), { type: "welcome", protocol: 1 });

    const closed = once(socket, "close");
    await app.close();
    app = undefined;
    await closed;
    assert.equal(runtimeClosed, true);
    assert.throws(() => db.prepare("SELECT 1"), /closed|not open/i);
  } finally {
    if (app) {
      socket?.terminate();
      await app.close();
    } else if (!runtimeClosed) store.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
  clearTimeout(deadline);
}
console.log(
  `Bun ${bunVersion} smoke passed (health, SQLite WAL/migrations/FTS5, sign-in, multipart, WebSocket, shutdown)`,
);
