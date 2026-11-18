import Fastify from "fastify";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { eventStreamConnection } from "../src/server/event-stream.js";
import { loggerOptions } from "../src/server/logging.js";
import { EventLoopMonitor, installRequestLog, slowRequestMs } from "../src/server/request-log.js";
import type { Runtime } from "../src/shared/types.js";
import { capabilitiesFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";
const apps: { close(): unknown }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
});

type Line = Record<string, unknown>;
async function setup(runtime: Partial<Runtime> = {}) {
  const raw: string[] = [];
  const config = {
    ...loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }),
    logLevel: "warn" as const,
  };
  const created = await createApp(
    config,
    fakeRuntime({
      close: async () => {},
      status: async () => ({ connected: true }),
      capabilities: async () => capabilitiesFixture({ routines: { supported: true } }),
      ...runtime,
    }),
    {
      background: false,
      logStream: {
        write: (line) => {
          raw.push(line);
        },
      },
    },
  );
  apps.push(created.app);
  const lines = () => raw.map((line) => JSON.parse(line) as Line);
  return {
    ...created,
    raw,
    lines,
    requests: () => lines().filter((line) => line.route !== undefined),
  };
}
const failed = "Request answered with an error status";

describe("request log", () => {
  it("logs a refused request with its method, route pattern, status, duration and request id, never the URL or query", async () => {
    const s = await setup();
    const ticket = "SENTINEL-TICKET-0123456789abcdefghijklmnopqrstu";
    const response = await s.app.inject({
      url: `/api/bots/some-assistant/conversation?ticket=${ticket}&q=SENTINEL-QUERY`,
    });
    expect(response.statusCode).toBe(401);
    expect(s.requests()).toEqual([
      expect.objectContaining({
        level: 40,
        msg: failed,
        method: "GET",
        route: "/api/bots/:id/conversation",
        status: 401,
        durationMs: expect.any(Number),
        reqId: expect.any(String),
      }),
    ]);
    expect(s.raw.join("\n")).not.toMatch(/SENTINEL|some-assistant/);
  });

  it("logs a reply sent directly with a 503, which the error handler never sees", async () => {
    // A read that finishes after its assistant turned private to the reader is answered 503 by an onSend hook.
    const s = await setup({
      routines: async () => {
        s.store.savePresentation("family", { shared: false, ownerId: "local-one" });
        return [];
      },
    });
    const reader = await localLogin(s.app, origin, "two");
    const response = await s.app.inject({ url: "/api/routines", headers: reader });
    expect([response.statusCode, response.json().code]).toEqual([503, "assistants_changed"]);
    expect(s.requests()).toEqual([
      expect.objectContaining({ msg: failed, method: "GET", route: "/api/routines", status: 503 }),
    ]);
  });

  it("logs a validation failure the error handler answers 400 without logging", async () => {
    const s = await setup();
    const headers = await localLogin(s.app, origin);
    const response = await s.app.inject({
      method: "POST",
      url: "/api/client-errors",
      headers,
      payload: { kind: "nonsense" },
    });
    expect(response.statusCode).toBe(400);
    expect(s.requests()).toEqual([
      expect.objectContaining({
        msg: failed,
        method: "POST",
        route: "/api/client-errors",
        status: 400,
      }),
    ]);
  });

  it("logs a thrown 5xx once, through the error handler, and not again here", async () => {
    const s = await setup({
      listBots: async () => {
        throw new Error("Hermes offline");
      },
    });
    const headers = await localLogin(s.app, origin);
    expect((await s.app.inject({ url: "/api/bots", headers })).statusCode).toBe(502);
    expect(s.lines().filter((line) => line.status === 502)).toEqual([
      expect.objectContaining({ msg: "Request failed", route: "GET /api/bots" }),
    ]);
    expect(s.lines().filter((line) => line.msg === failed)).toEqual([]);
  });

  it("logs nothing for a successful, quick request", async () => {
    const s = await setup({ listBots: async () => [] });
    const headers = await localLogin(s.app, origin);
    expect((await s.app.inject({ url: "/api/bots", headers })).statusCode).toBe(200);
    expect(s.raw).toEqual([]);
  });

  it("logs a repeating failure once with its count at the reminder, so a polling client cannot flood journald", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = await setup();
    for (let i = 0; i < 5; i++) expect((await s.app.inject("/api/bots")).statusCode).toBe(401);
    const lines = s.requests();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveProperty("repeats");
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await s.app.inject("/api/bots");
    expect(s.requests().map((line) => line.repeats)).toEqual([undefined, 5]);
    // A different status on the same route is a new failure.
    await s.app.inject({ method: "POST", url: "/api/bots" });
    expect(s.requests().map((line) => [line.method, line.status])).toEqual([
      ["GET", 401],
      ["GET", 401],
      ["POST", 401],
    ]);
  });

  it("logs a slow request with its duration even when it succeeds", async () => {
    const s = await setup({
      listBots: async () => {
        await delay(slowRequestMs + 150);
        return [];
      },
    });
    const headers = await localLogin(s.app, origin);
    expect((await s.app.inject({ url: "/api/bots", headers })).statusCode).toBe(200);
    const [line] = s.requests();
    expect(line).toMatchObject({
      level: 40,
      msg: "Slow request",
      method: "GET",
      route: "/api/bots",
      status: 200,
    });
    expect(line.durationMs as number).toBeGreaterThan(slowRequestMs);
  });

  it("keeps an open event stream out of the slow log but still logs a slow ordinary request", async () => {
    const raw: string[] = [];
    const app = Fastify({
      ...loggerOptions("warn", {
        write: (line) => {
          raw.push(line);
        },
      }),
    });
    apps.push(app);
    installRequestLog(app, { slowMs: 40 });
    app.get("/stream", async (req, reply) => {
      const connection = eventStreamConnection(reply);
      const stream = connection.open(new Set(), { allowed: () => true, teardown: () => {} });
      setTimeout(() => stream.end(), 120);
    });
    app.get("/slow", async () => {
      await delay(120);
      return { ok: true };
    });
    expect((await app.inject("/stream")).statusCode).toBe(200);
    expect((await app.inject("/slow")).statusCode).toBe(200);
    const lines = raw.map((line) => JSON.parse(line) as Line);
    expect(lines).toEqual([expect.objectContaining({ msg: "Slow request", route: "/slow" })]);
  });
});

describe("event loop monitor", () => {
  const block = (ms: number) => {
    for (const end = performance.now() + ms; performance.now() < end;);
  };
  async function stalled(monitor: EventLoopMonitor, ms: number) {
    await delay(30);
    block(ms);
    await delay(30);
    monitor.sample(0);
  }
  const monitorWith = (options: ConstructorParameters<typeof EventLoopMonitor>[1] = {}) => {
    const warnings: [Line, string][] = [];
    const monitor = new EventLoopMonitor(
      {
        warn: ((fields: Line, message: string) => {
          warnings.push([fields, message]);
        }) as never,
      },
      options,
    );
    monitor.start();
    return { monitor, warnings };
  };

  it("warns with the p99 and max when the loop stalls, and remembers the p99", async () => {
    const { monitor, warnings } = monitorWith();
    try {
      await stalled(monitor, 250);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toBe("The event loop is stalling");
      expect(warnings[0][0]).toMatchObject({ thresholdMs: 50 });
      expect(warnings[0][0].p99Ms as number).toBeGreaterThan(50);
      expect(warnings[0][0].maxMs as number).toBeGreaterThanOrEqual(warnings[0][0].p99Ms as number);
      expect(monitor.lastP99Ms).toBe(warnings[0][0].p99Ms);
    } finally {
      monitor.stop();
    }
  });

  it("stays quiet on a healthy loop but still reports its p99", async () => {
    const { monitor, warnings } = monitorWith({ thresholdMs: 1000 });
    try {
      await stalled(monitor, 100);
      expect(warnings).toEqual([]);
      expect(monitor.lastP99Ms).toBeGreaterThan(50);
    } finally {
      monitor.stop();
    }
  });

  it("warns at most once a minute", async () => {
    const { monitor, warnings } = monitorWith();
    try {
      await stalled(monitor, 120);
      await delay(30);
      block(120);
      await delay(30);
      monitor.sample(59_999);
      expect(warnings).toHaveLength(1);
      await delay(30);
      block(120);
      await delay(30);
      monitor.sample(60_000);
      expect(warnings).toHaveLength(2);
    } finally {
      monitor.stop();
    }
  });

  it("keeps the last p99 when a window has no samples", async () => {
    const { monitor } = monitorWith();
    expect(monitor.lastP99Ms).toBeUndefined();
    monitor.sample(0);
    expect(monitor.lastP99Ms).toBeUndefined();
    monitor.stop();
  });
});
