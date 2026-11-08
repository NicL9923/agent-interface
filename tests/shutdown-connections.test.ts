import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { Agent, get } from "node:http";
import { PassThrough } from "node:stream";
import { setTimeout as realDelay } from "node:timers/promises";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { fakeRuntime } from "./helpers/server.js";

const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
const sockets: Socket[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.useRealTimers();
});

// Poll real I/O without moving the virtual shutdown clock.
async function until(check: () => boolean, reason: string) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(reason);
    await realDelay(5);
  }
}
async function setup() {
  const closed = vi.fn(async () => {});
  const logs: Record<string, unknown>[] = [];
  const { app } = await createApp({ ...loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), logLevel: "warn" },
    fakeRuntime({ close: closed }), { background: false, logStream: { write: line => { logs.push(JSON.parse(line)); } } });
  apps.push(app);
  return { app, closed, logs };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function connect(app: typeof apps[number], base: string) {
  const accepted = once(app.server, "connection");
  const peer = createConnection({ host: "127.0.0.1", port: Number(new URL(base).port) });
  sockets.push(peer);
  await once(peer, "connect");
  return { peer, serverPeer: (await accepted)[0] as Socket };
}
async function listen(app: typeof apps[number]) {
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return base;
}
async function stop(app: typeof apps[number]) {
  let finished = false;
  const closing = app.close().then(() => { finished = true; });
  await until(() => !app.server.listening, "shutdown did not stop accepting connections");
  return { closing, finished: () => finished };
}

it("finishes shutdown after the grace period when a peer never sends a request", async () => {
  const { app, closed, logs } = await setup();
  const base = await listen(app);
  const previous = await connect(app, base);
  const previousClosed = once(previous.serverPeer, "close");
  previous.peer.destroy();
  await previousClosed;
  const { peer } = await connect(app, base);
  const shutdown = await stop(app);
  await vi.advanceTimersByTimeAsync(24999);
  expect(shutdown.finished()).toBe(false);
  expect(peer.destroyed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await until(shutdown.finished, "shutdown still waits for a TCP peer that sent no request after the grace period");
  await shutdown.closing;
  await until(() => peer.destroyed, "shutdown did not close the silent peer");
  expect(closed).toHaveBeenCalledWith();
  expect(logs).toContainEqual(expect.objectContaining({ level: 40, connections: 1,
    msg: "Closing connections after the shutdown grace period" }));
  expect(vi.getTimerCount()).toBe(0);
});

it("lets an active response finish before the grace period ends and cancels its deadline", async () => {
  const { app, closed } = await setup();
  const entered = deferred<void>(), finish = deferred<string>();
  app.get("/test-drain", async () => { entered.resolve(); return await finish.promise; });
  const base = await listen(app);
  const agent = new Agent({ keepAlive: true }); agents.push(agent);
  const response = new Promise<{ status: number; body: string; connection: string | undefined }>((resolve, reject) => {
    const request = get(`${base}/test-drain`, { agent }, reply => {
      let body = "";
      reply.setEncoding("utf8").on("data", chunk => { body += chunk; });
      reply.on("end", () => resolve({ status: reply.statusCode!, body, connection: reply.headers.connection }));
    });
    request.on("socket", socket => sockets.push(socket));
    request.on("error", reject);
  });
  await entered.promise;
  const shutdown = await stop(app);
  await vi.advanceTimersByTimeAsync(24999);
  expect(shutdown.finished()).toBe(false);
  expect(closed).not.toHaveBeenCalled();
  finish.resolve("The active response finished.");
  const received = await response;
  await until(shutdown.finished, "shutdown still waits after the active keep-alive response finished");
  await shutdown.closing;
  expect(received).toEqual({ status: 200, body: "The active response finished.", connection: "close" });
  expect(closed).toHaveBeenCalledWith();
  expect(vi.getTimerCount()).toBe(0);
});

it("cuts off a response that cannot finish by the deadline", async () => {
  const { app } = await setup();
  const entered = deferred<void>(), finish = deferred<string>();
  app.get("/test-drain", async () => { entered.resolve(); return await finish.promise; });
  const base = await listen(app);
  const failed = new Promise<NodeJS.ErrnoException>(resolve => {
    const request = get(`${base}/test-drain`, { agent: false });
    request.on("socket", socket => sockets.push(socket));
    request.on("error", resolve);
  });
  await entered.promise;
  const shutdown = await stop(app);
  await vi.advanceTimersByTimeAsync(24999);
  expect(shutdown.finished()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  try {
    await until(shutdown.finished, "shutdown still waits for an unfinished response after the grace period");
    expect((await failed).code).toBe("ECONNRESET");
    await shutdown.closing;
  } finally { finish.resolve("Too late"); }
});

it("closes an upgraded peer that never answers the WebSocket close frame", async () => {
  const { app } = await setup();
  app.get("/test-ws", { websocket: true }, () => {});
  const base = await listen(app);
  const peer = createConnection({ host: "127.0.0.1", port: Number(new URL(base).port) });
  sockets.push(peer);
  await once(peer, "connect");
  const upgraded = once(peer, "data");
  peer.write("GET /test-ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
  expect(String((await upgraded)[0])).toContain("101 Switching Protocols");
  // A raw TCP peer reads the frame but never sends a WebSocket close response.
  peer.on("data", () => {});
  const shutdown = await stop(app);
  await vi.advanceTimersByTimeAsync(24999);
  expect(shutdown.finished()).toBe(false);
  expect(peer.destroyed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await until(shutdown.finished, "shutdown still waits for an upgraded peer after the grace period");
  await shutdown.closing;
  await until(() => peer.destroyed, "shutdown did not close the upgraded peer");
  expect(vi.getTimerCount()).toBe(0);
});

it("closes a never-listened app once across repeated calls without leaving a shutdown timer", async () => {
  const { app, closed } = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await Promise.all([app.close(), app.close()]);
  expect(closed).toHaveBeenCalledWith();
  expect(closed).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("drains a response whose keep-alive headers were already sent before shutdown", async () => {
  const { app } = await setup();
  const stream = new PassThrough();
  app.get("/test-stream", (_request, reply) => reply.type("text/plain").send(stream));
  const base = await listen(app);
  const agent = new Agent({ keepAlive: true }); agents.push(agent);
  const headers = deferred<string | undefined>();
  const response = new Promise<string>((resolve, reject) => {
    const request = get(`${base}/test-stream`, { agent }, reply => {
      headers.resolve(reply.headers.connection);
      let body = "";
      reply.setEncoding("utf8").on("data", chunk => { body += chunk; });
      reply.on("end", () => resolve(body));
    });
    request.on("socket", socket => sockets.push(socket));
    request.on("error", reject);
  });
  stream.write("Before shutdown. ");
  expect(await headers.promise).toBe("keep-alive");
  const shutdown = await stop(app);
  await vi.advanceTimersByTimeAsync(24999);
  expect(shutdown.finished()).toBe(false);
  stream.end("After shutdown.");
  expect(await response).toBe("Before shutdown. After shutdown.");
  await until(shutdown.finished, "shutdown still waits after the already-streaming response finished");
  await shutdown.closing;
  expect(vi.getTimerCount()).toBe(0);
});
