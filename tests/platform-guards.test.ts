import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { installAuth } from "../src/server/auth.js";
import { installComputerRoutes } from "../src/server/computer.js";
import { loadConfig } from "../src/server/config.js";
import { etagMatches, installEtags } from "../src/server/etag.js";
import { MAX_STREAMS_PER_USER } from "../src/server/event-stream.js";
import { errorHandler } from "../src/server/http-error.js";
import { Store } from "../src/server/store.js";
import { SystemTerminal } from "../src/server/terminal.js";
import { timingSafeEqualText } from "../src/server/timing-safe.js";
import type { Runtime } from "../src/shared/types.js";
import { botFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, signIn } from "./helpers/server.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("RFC 9110 ETag matching", () => {
  it("matches exact, weak/strong normalized, multi-tag, array, and wildcard headers", () => {
    const etag = 'W/"abc123"';
    expect(etagMatches('W/"abc123"', etag)).toBe(true);
    expect(etagMatches('"abc123"', etag)).toBe(true);
    expect(etagMatches('"other", "abc123", W/"third"', etag)).toBe(true);
    expect(etagMatches(['"other"', 'W/"abc123"'], etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
    expect(etagMatches(' , "abc123" , ', etag)).toBe(true);
    expect(etagMatches('"different"', etag)).toBe(false);
    expect(etagMatches("", etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
  });

  it("returns 304 through Fastify when a proxy strips W/ or sends a tag list", async () => {
    const app = Fastify();
    installEtags(app);
    app.get("/api/ping", async () => ({ ok: true }));
    cleanups.push(() => app.close());

    const first = await app.inject({ method: "GET", url: "/api/ping" });
    expect(first.statusCode).toBe(200);
    const etag = String(first.headers.etag);
    expect(etag.startsWith('W/"')).toBe(true);

    const strong = etag.replace(/^W\//, "");
    const proxyStrong = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { "if-none-match": strong },
    });
    expect(proxyStrong.statusCode).toBe(304);

    const multi = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { "if-none-match": `"old", ${strong}` },
    });
    expect(multi.statusCode).toBe(304);

    const miss = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { "if-none-match": '"stale"' },
    });
    expect(miss.statusCode).toBe(200);
  });
});

describe("timingSafeEqualText and CSRF boundary", () => {
  it("handles equal, unequal, multibyte UTF-8 length mismatches, and non-strings safely", () => {
    expect(timingSafeEqualText("secret-token", "secret-token")).toBe(true);
    expect(timingSafeEqualText("secret-token", "secret-tokeN")).toBe(false);
    // Equal UTF-16 code-unit length (1) but unequal UTF-8 byte length (2 vs 1): must return false without throwing.
    expect(timingSafeEqualText("é", "a")).toBe(false);
    expect(timingSafeEqualText("é", "é")).toBe(true);
    expect(timingSafeEqualText(undefined, "token")).toBe(false);
    expect(timingSafeEqualText(["token"], "token")).toBe(false);
    expect(timingSafeEqualText("token", null)).toBe(false);
    expect(timingSafeEqualText("token", undefined)).toBe(false);
  });

  it("rejects missing and mismatched CSRF tokens and accepts exact matches", async () => {
    const origin = "https://app.example.invalid";
    const app = Fastify();
    const store = new Store(":memory:");
    app.setErrorHandler(errorHandler({ production: true }));
    const config = loadConfig({
      NODE_ENV: "production",
      APP_ORIGIN: origin,
      GOOGLE_CLIENT_ID: "fixture",
      HOUSEHOLD_EMAILS: "one@example.invalid",
    });
    await app.register(cookie);
    await installAuth(app, store, config);
    app.post("/api/protected", async () => ({ ok: true }));
    cleanups.push(async () => {
      await app.close();
      store.close();
    });

    const headers = signIn(store, origin, "one", { csrf: "expected-csrf", confirmed: true });

    const missing = await app.inject({
      method: "POST",
      url: "/api/protected",
      headers: { cookie: headers.cookie, origin },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: "Invalid CSRF token" });

    const wrong = await app.inject({
      method: "POST",
      url: "/api/protected",
      headers: { ...headers, "x-csrf-token": "wrong-csrf" },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: "Invalid CSRF token" });

    const valid = await app.inject({
      method: "POST",
      url: "/api/protected",
      headers,
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ ok: true });
  });
});

describe("SQLite retention, read-path non-mutation, and batched queries", () => {
  it("prunes 90-day settled history while keeping recent rows, uncertain submissions, and live participants", () => {
    const store = new Store(":memory:");
    cleanups.push(async () => store.close());
    store.user({ id: "one", name: "One", email: "one@example.invalid" });
    const db = (
      store as unknown as {
        db: {
          prepare: (sql: string) => {
            run: (...args: unknown[]) => unknown;
            get: (...args: unknown[]) => unknown;
          };
        };
      }
    ).db;
    const now = Date.UTC(2026, 10, 19);
    const oldTs = now - 95 * 86_400_000;
    const recentTs = now - 10 * 86_400_000;

    // Settled old submission + recent submission + uncertain old submission
    db.prepare(
      "INSERT INTO submissions(request_id,bot_id,sender_id,payload,receipt,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      "old-settled",
      "ranch",
      "one",
      "{}",
      JSON.stringify({ requestId: "old-settled", status: "accepted", runId: "run-old" }),
      oldTs,
    );
    db.prepare(
      "INSERT INTO submissions(request_id,bot_id,sender_id,payload,receipt,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      "old-uncertain",
      "ranch",
      "one",
      "{}",
      JSON.stringify({ requestId: "old-uncertain", status: "uncertain", runId: "run-uncertain" }),
      oldTs,
    );
    db.prepare(
      "INSERT INTO submissions(request_id,bot_id,sender_id,payload,receipt,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      "recent-settled",
      "ranch",
      "one",
      "{}",
      JSON.stringify({ requestId: "recent-settled", status: "accepted", runId: "run-recent" }),
      recentTs,
    );
    // Approval attribution, retry claims, group senders
    db.prepare(
      "INSERT INTO approval_attribution(approval_id,bot_id,user_id,decision,created_at) VALUES(?,?,?,?,?)",
    ).run("a-old", "ranch", "one", "approve", oldTs);
    db.prepare(
      "INSERT INTO approval_attribution(approval_id,bot_id,user_id,decision,created_at) VALUES(?,?,?,?,?)",
    ).run("a-new", "ranch", "one", "approve", recentTs);
    db.prepare(
      "INSERT INTO retry_claims(bot_id,retry_of,run_id,request_id,created_at) VALUES(?,?,?,?,?)",
    ).run("ranch", "m-old", "run-old", "old-settled", oldTs);
    db.prepare(
      "INSERT INTO retry_claims(bot_id,retry_of,run_id,request_id,created_at) VALUES(?,?,?,?,?)",
    ).run("ranch", "m-new", "run-recent", "recent-settled", recentTs);
    db.prepare(
      "INSERT INTO group_senders(room_id,event_id,user_id,created_at) VALUES(?,?,?,?)",
    ).run("g1", "gm-old", "one", oldTs);
    db.prepare(
      "INSERT INTO group_senders(room_id,event_id,user_id,created_at) VALUES(?,?,?,?)",
    ).run("g1", "gm-new", "one", recentTs);
    // Participants: orphaned vs referenced by uncertain submission vs referenced by notification_events
    db.prepare("INSERT INTO participants(run_id,user_id) VALUES(?,?)").run("run-old", "one");
    db.prepare("INSERT INTO participants(run_id,user_id) VALUES(?,?)").run("run-uncertain", "one");
    db.prepare("INSERT INTO participants(run_id,user_id) VALUES(?,?)").run("run-event", "one");
    db.prepare("INSERT INTO notification_events(id,value,created_at) VALUES(?,?,?)").run(
      "ev-1",
      JSON.stringify({ id: "ev-1", runId: "run-event", botId: "ranch" }),
      recentTs,
    );

    store.pruneRetention(now);

    expect(store.submission("old-settled")).toBeUndefined();
    expect(store.submission("old-uncertain")?.receipt.status).toBe("uncertain");
    expect(store.submission("recent-settled")?.receipt.status).toBe("accepted");
    expect(store.groupSenders("g1", ["gm-old", "gm-new"])).toEqual(new Map([["gm-new", "one"]]));
    expect(store.groupSenders("g1", [])).toEqual(new Map());
    expect(store.participants("run-old")).toEqual([]);
    expect(store.participants("run-uncertain")).toEqual(["one"]);
    expect(store.participants("run-event")).toEqual(["one"]);
    const remainingApprovals = db
      .prepare("SELECT COUNT(*) AS n FROM approval_attribution")
      .get() as { n: number };
    const remainingRetries = db.prepare("SELECT COUNT(*) AS n FROM retry_claims").get() as {
      n: number;
    };
    expect(remainingApprovals.n).toBe(1);
    expect(remainingRetries.n).toBe(1);
  });

  it("filters expired native sessions on read without mutating native_sessions until pruneRetention", () => {
    const store = new Store(":memory:");
    cleanups.push(async () => store.close());
    store.user({ id: "one", name: "One", email: "one@example.invalid" });
    const now = Date.now();
    store.nativeSession("live-hash", "one", now + 60_000);
    store.nativeSession("expired-hash", "one", now + 60_000);
    store.registerNativeDevice("one", "live-hash", "dev-live", "a".repeat(64), "production");
    store.registerNativeDevice("one", "expired-hash", "dev-old", "b".repeat(64), "production");

    const db = (
      store as unknown as {
        db: {
          prepare: (sql: string) => {
            run: (...args: unknown[]) => unknown;
            get: (...args: unknown[]) => unknown;
          };
        };
      }
    ).db;
    db.prepare("UPDATE native_sessions SET expires=? WHERE hash=?").run(
      now - 1_000,
      "expired-hash",
    );

    // Read-path queries must exclude expired devices without deleting the session row.
    expect(store.nativeDevices("one", "production").map((d) => d.deviceId)).toEqual(["dev-live"]);
    expect(store.allNativeDevices("production").map((d) => d.deviceId)).toEqual(["dev-live"]);
    const beforePrune = db
      .prepare("SELECT COUNT(*) AS n FROM native_sessions WHERE hash=?")
      .get("expired-hash") as { n: number };
    expect(beforePrune.n).toBe(1);

    // Retention sweep actually removes the expired native session and device.
    store.pruneRetention(now);
    const afterPrune = db
      .prepare("SELECT COUNT(*) AS n FROM native_sessions WHERE hash=?")
      .get("expired-hash") as { n: number };
    expect(afterPrune.n).toBe(0);
  });
});

describe("per-user SSE stream cap and bounded computer viewers", () => {
  it("enforces MAX_STREAMS_PER_USER with 429 and frees capacity on disconnect", async () => {
    const origin = "http://127.0.0.1:3000";
    const runtime: Runtime = fakeRuntime({
      status: async () => ({ connected: true }),
      close: async () => {},
      capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }) as never,
      listBots: async () => [botFixture({ id: "ranch" })],
    });
    const { app } = await createApp(
      loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }),
      runtime,
      { background: false },
    );
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => app.close());

    const signInRes = await fetch(`${base}/api/auth/local`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ member: "one" }),
    });
    const sessionCookie = signInRes.headers.getSetCookie()[0].split(";")[0];

    const responses: Response[] = [];
    cleanups.push(async () => {
      await Promise.all(
        responses.map((res) => (res.body ? res.body.cancel().catch(() => {}) : Promise.resolve())),
      );
    });
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
      const res = await fetch(`${base}/api/events`, {
        headers: { cookie: sessionCookie },
      });
      expect(res.status).toBe(200);
      responses.push(res);
    }

    const overflow = await fetch(`${base}/api/events`, { headers: { cookie: sessionCookie } });
    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toMatchObject({ error: "Too many open live update streams." });

    // Closing one stream frees a slot once the server sees the socket close.
    await responses[0].body?.cancel().catch(() => {});
    let reopened = 429;
    for (let attempt = 0; attempt < 25; attempt++) {
      const res = await fetch(`${base}/api/events`, {
        headers: { cookie: sessionCookie },
      });
      reopened = res.status;
      if (reopened === 200) {
        responses.push(res);
        break;
      }
      await res.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(reopened).toBe(200);
  });

  it("evicts the oldest non-connected computer viewer past the per-user cap", async () => {
    const origin = "https://app.example.invalid";
    const app = Fastify();
    const store = new Store(":memory:");
    app.setErrorHandler(errorHandler({ production: true }));
    const config = loadConfig({
      NODE_ENV: "production",
      APP_ORIGIN: origin,
      GOOGLE_CLIENT_ID: "fixture",
      HOUSEHOLD_EMAILS: "one@example.invalid",
    });
    let seq = 0;
    const viewerId = (n: number) => `fixture-viewer-${String(n).padStart(4, "0")}`;
    const computerRequest = vi.fn<NonNullable<Runtime["computerRequest"]>>(async (input) =>
      input.action === "observe"
        ? {
            ticket: `ticket-${++seq}`,
            path: "/api/display/ws",
            viewerId: viewerId(seq),
          }
        : {
            available: true,
            running: true,
            browserReady: true,
            label: "Household computer",
            control: { kind: "idle" },
            terminal: { available: false, target: "" },
          },
    );
    const runtime = fakeRuntime({
      computerRequest,
      connectComputerDisplay: () => {
        throw new Error("unused in REST test");
      },
    });
    await app.register(cookie);
    await app.register(websocket);
    await installAuth(app, store, config);
    await installComputerRoutes(app, config, store, runtime, () => false);
    cleanups.push(async () => {
      await app.close();
      store.close();
    });

    const headers = signIn(store, origin, "one", { csrf: "csrf-1", confirmed: true });
    for (let i = 0; i < 65; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/computer/desktop",
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    }

    // viewer-1 was evicted when viewer-65 was recorded; viewer-65 is still retained.
    const evicted = await app.inject({
      method: "POST",
      url: "/api/computer/control",
      headers,
      payload: { action: "take", viewerId: viewerId(1) },
    });
    expect(evicted.statusCode).toBe(403);

    const retained = await app.inject({
      method: "POST",
      url: "/api/computer/control",
      headers,
      payload: { action: "take", viewerId: viewerId(65) },
    });
    expect(retained.statusCode).toBe(200);
  });
});

describe("SystemTerminal async availability", () => {
  it("resolves unavailable asynchronously when disabled", async () => {
    const terminal = new SystemTerminal(undefined);
    expect(await terminal.isAvailable()).toBe(false);
    expect(await terminal.getReason()).toContain("not enabled");
    expect(await terminal.sessions()).toEqual([]);
  });
});
