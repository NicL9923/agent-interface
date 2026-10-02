import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { installAuth, hash } from "../src/server/auth.js";
import { installComputerRoutes } from "../src/server/computer.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import type { Runtime } from "../src/shared/types.js";
import { z } from "zod";

const origin = "https://app.example.invalid";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const app = Fastify(), store = new Store(":memory:");
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof z.ZodError ? 400 : (error as {statusCode?: number}).statusCode ?? 500).send({error: (error as Error).message}));
  let maintenance = false;
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, GOOGLE_CLIENT_ID: "fixture",
    HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid" });
  const computerRequest = vi.fn(async (input: {action: string}) => input.action === "observe"
    ? {ticket: "native-ticket-does-not-leave-the-server", path: "/api/display/ws", viewerId: "fixture-viewer-123456"}
    : {available: true, running: true, browserReady: true, label: "Household computer", control: {kind: "idle"}});
  const upstream = new WebSocketServer({port: 0, host: "127.0.0.1"});
  await once(upstream, "listening");
  upstream.on("connection", socket => socket.on("message", (data, binary) => socket.send(data, {binary})));
  const runtime = {computerRequest, connectComputerDisplay: () => new WebSocket(`ws://127.0.0.1:${(upstream.address() as {port: number}).port}`)} as unknown as Runtime;
  await app.register(cookie); await app.register(websocket); await installAuth(app, store, config);
  await installComputerRoutes(app, config, store, runtime, () => maintenance);
  const login = (id: string) => {
    store.user({id, name: id, email: `${id}@example.invalid`});
    const token = randomBytes(32).toString("hex"), csrf = "fixture-csrf";
    store.session(hash(token), id, csrf, Date.now() + 60000);
    return {origin, cookie: `session=${token}`, "x-csrf-token": csrf};
  };
  cleanups.push(async () => {for (const ws of upstream.clients) ws.terminate(); await new Promise<void>(resolve => upstream.close(() => resolve())); store.close();});
  cleanups.push(() => app.close());
  return {app, store, runtime, upstream, computerRequest, one: login("one"), two: login("two"), setMaintenance: (value: boolean) => {maintenance = value;}};
}
const attachment = (s: Awaited<ReturnType<typeof setup>>, headers = s.one) => s.app.inject({method: "POST", url: "/api/computer/desktop", headers, payload: {}});

it("requires explicit terminal opt-in and absolute private configuration", () => {
  expect(loadConfig({}).computerTerminal).toBeUndefined();
  for (const env of [{COMPUTER_TERMINAL_ENABLED: "yes"}, {COMPUTER_TERMINAL_ENABLED: "true"},
    {COMPUTER_TERMINAL_ENABLED: "true", COMPUTER_STATE_DIR: "relative", COMPUTER_TERMINAL_CWD: "/workspace", COMPUTER_PYTHON: "/usr/bin/python3"}])
    expect(() => loadConfig(env)).toThrow();
  expect(loadConfig({COMPUTER_TERMINAL_ENABLED: "true", COMPUTER_STATE_DIR: "/private/terminal", COMPUTER_TERMINAL_CWD: "/workspace", COMPUTER_PYTHON: "/usr/bin/python3"}).computerTerminal)
    .toEqual({stateDirectory: "/private/terminal", cwd: "/workspace", python: "/usr/bin/python3"});
});

it("authenticates computer APIs, derives actors from the session and keeps native credentials private", async () => {
  const s = await setup();
  expect((await s.app.inject("/api/computer")).statusCode).toBe(401);
  expect((await s.app.inject({method: "POST", url: "/api/computer/desktop", headers: {cookie: s.one.cookie, origin}, payload: {}})).statusCode).toBe(403);
  expect((await s.app.inject({method: "POST", url: "/api/computer/desktop", headers: s.one, payload: {actorId: "two"}})).statusCode).toBe(400);
  const response = await attachment(s);
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain("native-ticket");
  expect(s.computerRequest).toHaveBeenCalledWith({action: "observe", actorId: "one", actorName: "one"});
  expect((await s.app.inject({url: "/api/computer", headers: s.one})).json().terminal.available).toBe(false);
});

it("binds one-use desktop tickets to the issuing session and exact Origin", async () => {
  const s = await setup(), {path} = (await attachment(s)).json();
  await expect(s.app.injectWS(path, {headers: {...s.one, origin: "https://other.invalid"}})).rejects.toThrow("403");
  await expect(s.app.injectWS(path, {headers: s.two})).rejects.toThrow("401");
  const ws = await s.app.injectWS(path, {headers: s.one});
  const output = once(ws, "message"); ws.send(Buffer.from("RFB handshake"));
  expect((await output)[0].toString()).toBe("RFB handshake");
  await expect(s.app.injectWS(path, {headers: s.one})).rejects.toThrow("401");
  ws.close(); await once(ws, "close");
});

it("revokes an attached stream when its session expires and fences control during maintenance", async () => {
  const s = await setup(), {path, viewerId} = (await attachment(s)).json();
  const control = (headers: typeof s.one, action: string) => s.app.inject({method: "POST", url: "/api/computer/control", headers, payload: {action, viewerId}});
  expect((await control(s.two, "take")).statusCode).toBe(403);
  s.setMaintenance(true);
  expect((await control(s.one, "take")).statusCode).toBe(409);
  expect((await control(s.one, "release")).statusCode).toBe(200);
  s.setMaintenance(false);
  const ws = await s.app.injectWS(path, {headers: s.one}), closed = once(ws, "close");
  s.store.deleteSession(hash(s.one.cookie.slice("session=".length)));
  ws.send(Buffer.from("revoked input"));
  expect((await closed)[0]).toBe(4401);
});

it("keeps a second same-member watch tab from surrendering another attached tab's control", async () => {
  const s = await setup();
  const base = (await s.app.listen({port: 0, host: "127.0.0.1"})).replace("http:", "ws:");
  const nativeA = once(s.upstream, "connection");
  const first = new WebSocket(base + (await attachment(s)).json().path, {headers: s.one});
  await once(first, "open");
  const [a] = await nativeA;
  let output = once(first, "message"); first.send(Buffer.from("A ready")); await output;
  const nativeB = once(s.upstream, "connection");
  const second = new WebSocket(base + (await attachment(s)).json().path, {headers: s.one});
  await once(second, "open");
  const [b] = await nativeB;
  output = once(second, "message"); second.send(Buffer.from("B ready")); await output;
  const bClosed = once(b, "close"); second.close(1000);
  expect((await bClosed)[0]).toBe(1011);
  const aClosed = once(a, "close"); first.close(1000);
  expect((await aClosed)[0]).toBe(1000);
});
