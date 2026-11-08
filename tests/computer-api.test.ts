import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { installAuth, hash } from "../src/server/auth.js";
import { installComputerRoutes, socketFrameLimit } from "../src/server/computer.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import type { Runtime } from "../src/shared/types.js";
import { fakeRuntime, signIn } from "./helpers/server.js";
import { errorHandler } from "../src/server/http-error.js";

const origin = "https://app.example.invalid";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const shellId = (userId: string) => "member-" + createHash("sha256").update(userId).digest("hex").slice(0, 32);
// A host double: attachments are a real child process that echoes nothing, never a shell.
function terminalDouble(live: string[] = []) {
  const ended: string[] = [];
  return {ended, available: true, target: "hermes@vps · /workspace", reason: undefined, sessionId: shellId, sessions: () => [...live],
    attach: () => spawn(process.execPath, ["-e", "process.stdin.resume()"]),
    end: async (userId: string) => {ended.push(shellId(userId));}, endSession: async (id: string) => {ended.push(id);}, close: () => {}};
}
async function setup(options: {admins?: string; terminals?: ReturnType<typeof terminalDouble>} = {}) {
  const logs: Record<string, unknown>[] = [];
  const app = Fastify({logger: {level: "info", stream: {write: (line: string) => {logs.push(JSON.parse(line));}}}}), store = new Store(":memory:");
  app.setErrorHandler(errorHandler({ production: true }));
  let maintenance = false;
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, GOOGLE_CLIENT_ID: "fixture",
    HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid",
    ...(options.admins === undefined ? {} : {COMPUTER_TERMINAL_ADMINS: options.admins}) });
  const computerRequest = vi.fn<NonNullable<Runtime["computerRequest"]>>(async (input) => input.action === "observe"
    ? {ticket: "native-ticket-does-not-leave-the-server", path: "/api/display/ws", viewerId: "fixture-viewer-123456"}
    : {available: true, running: true, browserReady: true, label: "Household computer", control: {kind: "idle"}, terminal: {available: false, target: ""}});
  const upstream = new WebSocketServer({port: 0, host: "127.0.0.1"});
  await once(upstream, "listening");
  upstream.on("connection", socket => socket.on("message", (data, binary) => socket.send(data, {binary})));
  const runtime = fakeRuntime({computerRequest, connectComputerDisplay: () => new WebSocket(`ws://127.0.0.1:${(upstream.address() as {port: number}).port}`)});
  await app.register(cookie); await app.register(websocket); await installAuth(app, store, config);
  await installComputerRoutes(app, config, store, runtime, () => maintenance, options.terminals);
  const login = (id: string) => ({...signIn(store, origin, id, {csrf: "fixture-csrf", confirmed: true}), "user-agent": "fixture-browser"});
  cleanups.push(async () => {for (const ws of upstream.clients) ws.terminate(); await new Promise<void>(resolve => upstream.close(() => resolve())); store.close();});
  cleanups.push(() => app.close());
  return {app, store, runtime, upstream, computerRequest, logs, one: login("one"), two: login("two"), setMaintenance: (value: boolean) => {maintenance = value;}};
}
const sessionHash = (headers: {cookie: string}) => hash(headers.cookie.slice("session=".length));
/** Bearer headers for an iOS app session, confirmed now unless told otherwise. */
function nativeLogin(store: Store, id: string, options: {confirmed?: boolean} = {}) {
  const token = randomBytes(32).toString("base64url");
  store.nativeSession(hash(token), id, Date.now() + 600_000);
  if (options.confirmed) store.confirmNativeSession(hash(token), Date.now());
  return {headers: {authorization: `Bearer ${token}`, "user-agent": "fixture-app"}, hash: hash(token)};
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

it("defaults terminal administrators to integration administrators and keeps them inside the household", () => {
  const household = {NODE_ENV: "production", APP_ORIGIN: origin, GOOGLE_CLIENT_ID: "fixture", HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid"};
  expect(loadConfig({...household, HERMES_INTEGRATION_ADMINS: "One@example.invalid"}).computerTerminalAdmins).toEqual(["one@example.invalid"]);
  expect(loadConfig({...household, HERMES_INTEGRATION_ADMINS: "one@example.invalid", COMPUTER_TERMINAL_ADMINS: ""}).computerTerminalAdmins).toEqual([]);
  expect(() => loadConfig({...household, COMPUTER_TERMINAL_ADMINS: "stranger@example.invalid"})).toThrow("Terminal administrators must belong");
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

it("keeps its own 256 KiB frame limit although the socket plugin admits a linked Mac's larger frames", async () => {
  const s = await setup();
  await s.app.close();
  // The app registers the plugin with the Mac link's 8 MiB limit; this socket must still refuse more than its own.
  const app = Fastify(), store = new Store(":memory:");
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, GOOGLE_CLIENT_ID: "fixture", HOUSEHOLD_EMAILS: "one@example.invalid" });
  await app.register(cookie); await app.register(websocket, {options: {maxPayload: 8 * 1024 * 1024}}); await installAuth(app, store, config);
  await installComputerRoutes(app, config, store, s.runtime, () => false);
  cleanups.push(async () => { await app.close(); store.close(); });
  const one = {...signIn(store, origin, "one", {csrf: "fixture-csrf", confirmed: true}), "user-agent": "fixture-browser"};
  const {path} = (await app.inject({method: "POST", url: "/api/computer/desktop", headers: one, payload: {}})).json();
  const ws = await app.injectWS(path, {headers: one});
  const closed = once(ws, "close");
  ws.send(Buffer.alloc(socketFrameLimit + 1));
  expect((await closed)[0]).toBe(1009);
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

it("lets every household member use the desktop but only terminal administrators open the shell", async () => {
  const s = await setup({admins: "one@example.invalid", terminals: terminalDouble()});
  const terminal = async (headers: Record<string, string>) => (await s.app.inject({url: "/api/computer", headers})).json().terminal;
  const open = (headers: Record<string, string>) => s.app.inject({method: "POST", url: "/api/computer/terminal", headers, payload: {}});
  expect((await attachment(s, s.two)).statusCode).toBe(200);
  expect(await terminal(s.two)).toEqual({available: false, target: "", reason: "The system terminal is limited to household administrators."});
  expect((await open(s.two)).statusCode).toBe(403);
  expect((await s.app.inject({method: "POST", url: "/api/computer/terminal/end", headers: s.two, payload: {sessionId: shellId("two")}})).statusCode).toBe(403);
  // The iOS app follows the same rule with its bearer token.
  const native = nativeLogin(s.store, "two", {confirmed: true}).headers;
  expect(await terminal(native)).toEqual({available: false, target: "", reason: "The system terminal is limited to household administrators."});
  expect((await open(native)).json()).toEqual({error: "The system terminal is limited to household administrators."});
  expect(await terminal(s.one)).toEqual({available: true, target: "hermes@vps · /workspace"});
  const ticket = await open(s.one);
  expect(ticket.statusCode).toBe(200);
  expect(ticket.json()).toEqual(expect.objectContaining({sessionId: shellId("one"), target: "hermes@vps · /workspace"}));
});

it("turns the shell off for everyone when the administrator list is empty", async () => {
  const s = await setup({admins: "", terminals: terminalDouble()});
  expect((await s.app.inject({url: "/api/computer", headers: s.one})).json().terminal)
    .toEqual({available: false, target: "", reason: "The system terminal is turned off for this household."});
  expect((await s.app.inject({method: "POST", url: "/api/computer/terminal", headers: s.one, payload: {}})).statusCode).toBe(403);
});

it("requires a sign-in confirmed within two hours before issuing a terminal ticket", async () => {
  const s = await setup({admins: "one@example.invalid", terminals: terminalDouble()});
  s.store.db.prepare("DELETE FROM session_confirmations").run();
  const open = () => s.app.inject({method: "POST", url: "/api/computer/terminal", headers: s.one, payload: {}});
  expect((await s.app.inject({url: "/api/computer", headers: s.one})).json().terminal.confirmationRequired).toBe(true);
  expect((await open()).json()).toEqual({error: "Confirm it's you to open the terminal.", code: "reauthentication_required"});
  s.store.confirmSession(sessionHash(s.one), Date.now() - 2 * 3600000 - 1000);
  expect((await open()).statusCode).toBe(401);
  s.store.confirmSession(sessionHash(s.one), Date.now() - 2 * 3600000 + 60000);
  expect((await open()).statusCode).toBe(200);
  expect((await s.app.inject({url: "/api/computer", headers: s.one})).json().terminal.confirmationRequired).toBeUndefined();
});

it("audits terminal use without the ticket and alerts every administrator once per confirmed sign-in", async () => {
  const s = await setup({admins: "one@example.invalid,two@example.invalid", terminals: terminalDouble()});
  const base = (await s.app.listen({port: 0, host: "127.0.0.1"})).replace("http:", "ws:");
  const attach = async () => {
    const {path} = (await s.app.inject({method: "POST", url: "/api/computer/terminal", headers: s.one, payload: {}})).json();
    const ws = new WebSocket(base + path, {headers: s.one});
    await once(ws, "open");
    const closed = once(ws, "close"); ws.close(1000); await closed;
    return path as string;
  };
  const alerts = () => s.store.db.prepare("SELECT event_id,user_id,payload FROM outbox ORDER BY user_id").all() as {event_id: string; user_id: string; payload: string}[];
  const path = await attach();
  await attach();
  expect(alerts().map(row => row.user_id)).toEqual(["one", "two"]);
  const confirmedAt = s.store.sessionConfirmedAt(sessionHash(s.one));
  expect(alerts()[0].event_id).toBe(`terminal-open:${sessionHash(s.one).slice(0, 16)}:${confirmedAt}`);
  expect(JSON.parse(alerts()[1].payload)).toEqual(expect.objectContaining({title: "System terminal opened", kind: "security", url: "/?computer=1"}));
  s.store.confirmSession(sessionHash(s.one), confirmedAt! + 1000);
  await attach();
  expect(alerts()).toHaveLength(4);
  await vi.waitFor(() => expect(s.logs.filter(line => line.audit === "terminal").map(line => line.action)).toContain("detach"));
  const audit = s.logs.filter(line => line.audit === "terminal");
  expect(new Set(audit.map(line => line.action))).toEqual(new Set(["ticket", "attach", "detach"]));
  expect(audit[0]).toEqual(expect.objectContaining({userId: "one", email: "one@example.invalid", userAgent: "fixture-browser"}));
  const ticket = new URL(path, origin).searchParams.get("ticket")!;
  expect(JSON.stringify(audit)).not.toContain(ticket);
});

it("prunes non-administrator shells at startup only once an administrator is known", async () => {
  const config = loadConfig({COMPUTER_TERMINAL_ADMINS: "one@example.invalid"});
  const start = async (users: string[]) => {
    const app = Fastify(), store = new Store(":memory:"), terminals = terminalDouble([shellId("one"), shellId("two"), shellId("removed")]);
    for (const id of users) store.user({id, name: id, email: `${id}@example.invalid`});
    await app.register(cookie); await app.register(websocket); await installAuth(app, store, config);
    await installComputerRoutes(app, config, store, {} as Runtime, () => false, terminals);
    await app.close(); store.close();
    return terminals.ended;
  };
  expect(await start(["two"])).toEqual([]);
  expect(await start(["one", "two"])).toEqual([shellId("two"), shellId("removed")]);
});

it("lets the iOS app attach with its bearer token and its desktop page connect with the ticket alone", async () => {
  const s = await setup();
  const token = randomBytes(32).toString("base64url");
  s.store.nativeSession(hash(token), "one", Date.now() + 600_000);
  const bearer = {authorization: `Bearer ${token}`};
  const issued = await s.app.inject({method: "POST", url: "/api/computer/desktop", headers: bearer, payload: {}});
  expect(issued.statusCode).toBe(200);
  const {path, viewerId} = issued.json();
  expect((await s.app.inject({method: "POST", url: "/api/computer/control", headers: bearer, payload: {action: "take", viewerId}})).statusCode).toBe(200);
  expect(s.computerRequest).toHaveBeenCalledWith({action: "take", viewerId, actorId: "one", actorName: "one"});
  // The page's socket carries no bearer and no cookie, only the app's Origin.
  await expect(s.app.injectWS(path, {headers: {origin: "https://other.invalid"}})).rejects.toThrow("403");
  await expect(s.app.injectWS(path, {headers: {}})).rejects.toThrow("403");
  const ws = await s.app.injectWS(path, {headers: {origin}});
  const output = once(ws, "message"); ws.send(Buffer.from("RFB handshake"));
  expect((await output)[0].toString()).toBe("RFB handshake");
  await expect(s.app.injectWS(path, {headers: {origin}})).rejects.toThrow("401");
  // Signing the app out ends the page's stream like any other.
  const closed = once(ws, "close");
  s.store.deleteNativeSession(hash(token));
  ws.send(Buffer.from("revoked input"));
  expect((await closed)[0]).toBe(4401);
  // A browser's ticket still needs its session cookie.
  const web = (await attachment(s)).json().path;
  await expect(s.app.injectWS(web, {headers: {origin}})).rejects.toThrow("401");
  ws.close();
});

it("opens the shell for an administrator in the iOS app only after confirming there within two hours", async () => {
  const s = await setup({admins: "one@example.invalid", terminals: terminalDouble()});
  const native = nativeLogin(s.store, "one");
  const terminal = async () => (await s.app.inject({url: "/api/computer", headers: native.headers})).json().terminal;
  const open = () => s.app.inject({method: "POST", url: "/api/computer/terminal", headers: native.headers, payload: {}});
  // Never confirmed, then confirmed too long ago: the app is asked to confirm, not refused.
  expect(await terminal()).toEqual({available: true, target: "hermes@vps · /workspace", confirmationRequired: true});
  expect((await open()).json()).toEqual({error: "Confirm it's you to open the terminal.", code: "reauthentication_required"});
  s.store.confirmNativeSession(native.hash, Date.now() - 2 * 3600000 - 1000);
  expect((await open()).json().code).toBe("reauthentication_required");
  // A browser confirmation for the same person does not stand in for the app's own.
  s.store.confirmSession(sessionHash(s.one), Date.now());
  expect((await open()).statusCode).toBe(401);
  s.store.confirmNativeSession(native.hash, Date.now() - 2 * 3600000 + 60000);
  expect(await terminal()).toEqual({available: true, target: "hermes@vps · /workspace"});
  const ticket = await open();
  expect(ticket.statusCode).toBe(200);
  expect(ticket.json()).toEqual(expect.objectContaining({sessionId: shellId("one"), target: "hermes@vps · /workspace"}));
  // Ending works with the bearer too, and only for the member's own shell.
  const end = (sessionId: string) => s.app.inject({method: "POST", url: "/api/computer/terminal/end", headers: native.headers, payload: {sessionId}});
  expect((await end(shellId("two"))).json()).toEqual({error: "This terminal belongs to another household member."});
  expect((await end(shellId("one"))).json()).toEqual({ok: true});
});

it("lets the iOS terminal page attach with its ticket alone, once, from this Origin, for that session and type", async () => {
  const s = await setup({admins: "one@example.invalid,two@example.invalid", terminals: terminalDouble()});
  const native = nativeLogin(s.store, "one", {confirmed: true}), other = nativeLogin(s.store, "two", {confirmed: true});
  const ticket = async (headers: Record<string, string> = native.headers) =>
    (await s.app.inject({method: "POST", url: "/api/computer/terminal", headers, payload: {}})).json().path as string;
  const path = await ticket();
  // The page's socket carries no bearer and no cookie, only the app's Origin.
  await expect(s.app.injectWS(path, {headers: {origin: "https://other.invalid"}})).rejects.toThrow("403");
  await expect(s.app.injectWS(path, {headers: {}})).rejects.toThrow("403");
  // The app itself presenting another session's bearer cannot use this ticket.
  await expect(s.app.injectWS(path, {headers: other.headers})).rejects.toThrow("401");
  // A terminal ticket never opens the desktop, and a desktop ticket never opens the shell.
  await expect(s.app.injectWS(path.replace("/terminal/", "/desktop/"), {headers: {origin}})).rejects.toThrow("401");
  const desktop = (await s.app.inject({method: "POST", url: "/api/computer/desktop", headers: native.headers, payload: {}})).json().path as string;
  await expect(s.app.injectWS(desktop.replace("/desktop/", "/terminal/"), {headers: {origin}})).rejects.toThrow("401");
  // A browser's terminal ticket still needs its session cookie.
  const web = (await s.app.inject({method: "POST", url: "/api/computer/terminal", headers: s.one, payload: {}})).json().path as string;
  await expect(s.app.injectWS(web, {headers: {origin}})).rejects.toThrow("401");
  const ws = await s.app.injectWS(path, {headers: {origin}});
  await expect(s.app.injectWS(path, {headers: {origin}})).rejects.toThrow("401");
  // An expired ticket is refused like a used one.
  const late = await ticket();
  vi.useFakeTimers({now: Date.now() + 31_000, toFake: ["Date"]});
  try { await expect(s.app.injectWS(late, {headers: {origin}})).rejects.toThrow("401"); } finally { vi.useRealTimers(); }
  // Signing the app out ends the page's shell connection like any other.
  const closed = once(ws, "close");
  s.store.deleteNativeSession(native.hash);
  ws.send(JSON.stringify({type: "resize", columns: 80, rows: 24}));
  expect((await closed)[0]).toBe(4401);
});

it("audits and alerts administrators when the iOS page attaches, once per confirmation", async () => {
  const s = await setup({admins: "one@example.invalid,two@example.invalid", terminals: terminalDouble()});
  const native = nativeLogin(s.store, "one", {confirmed: true});
  const base = (await s.app.listen({port: 0, host: "127.0.0.1"})).replace("http:", "ws:");
  const attach = async () => {
    const {path} = (await s.app.inject({method: "POST", url: "/api/computer/terminal", headers: native.headers, payload: {}})).json();
    const ws = new WebSocket(base + path, {headers: {origin, "user-agent": "fixture-page"}});
    await once(ws, "open");
    const closed = once(ws, "close"); ws.close(1000); await closed;
  };
  const alerts = () => s.store.db.prepare("SELECT event_id,user_id,payload FROM outbox ORDER BY user_id").all() as {event_id: string; user_id: string; payload: string}[];
  await attach(); await attach();
  const confirmedAt = s.store.nativeSessionConfirmedAt(native.hash)!;
  expect(alerts().map(row => [row.event_id, row.user_id])).toEqual([
    [`terminal-open:${native.hash.slice(0, 16)}:${confirmedAt}`, "one"], [`terminal-open:${native.hash.slice(0, 16)}:${confirmedAt}`, "two"]]);
  expect(JSON.parse(alerts()[1].payload)).toEqual(expect.objectContaining({title: "System terminal opened", body: "one opened the system terminal."}));
  s.store.confirmNativeSession(native.hash, confirmedAt + 1000);
  await attach();
  expect(alerts()).toHaveLength(4);
  await vi.waitFor(() => expect(s.logs.filter(line => line.audit === "terminal" && line.action === "detach")).toHaveLength(3));
  const page = s.logs.filter(line => line.audit === "terminal" && line.action !== "ticket");
  expect(page[0]).toEqual(expect.objectContaining({action: "attach", userId: "one", email: "one@example.invalid", userAgent: "fixture-page",
    session: native.hash.slice(0, 16)}));
});

it("declines a handoff only for an assistant the member can see, with a validated binding", async () => {
  const s = await setup();
  s.computerRequest.mockImplementation(async input => (input.action === "handoff" ? {status: "ok"} : {}) as never);
  const decline = (headers: Record<string, string>, payload: unknown, bot = "patch", request = "srq-0123456789ab") =>
    s.app.inject({method: "POST", url: `/api/bots/${bot}/computer-handoffs/${request}`, headers, payload: payload as object});
  const body = {decision: "decline", epoch: "epoch-one", sessionId: "live-one"};
  expect((await s.app.inject({method: "POST", url: "/api/bots/patch/computer-handoffs/srq-1", payload: body})).statusCode).toBe(401);
  for (const bad of [{...body, decision: "take"}, {...body, extra: true}, {...body, epoch: "../x"}, {decision: "decline"}])
    expect((await decline(s.one, bad)).statusCode).toBe(400);
  expect((await decline(s.one, body, "patch", "bad id")).statusCode).toBe(400);
  expect(s.computerRequest).not.toHaveBeenCalled();
  s.store.savePresentation("private", {shared: false, ownerId: "two"});
  expect((await decline(s.one, body, "private")).statusCode).toBe(404);
  const ok = await decline(s.one, body);
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual({status: "ok"});
  // The member comes from the session, never the body.
  expect(s.computerRequest).toHaveBeenCalledWith({action: "handoff", decision: "decline", profile: "patch", requestId: "srq-0123456789ab",
    epoch: "epoch-one", sessionId: "live-one", actorId: "one", actorName: "one"});
  s.computerRequest.mockImplementation(async () => ({status: "maybe"}) as never);
  expect((await decline(s.one, body)).statusCode).toBe(502);
});

it("names the same handoff method as the Hermes add-on", async () => {
  const { readFile } = await import("node:fs/promises");
  const { computerHandoffMethod } = await import("../src/shared/computer.js");
  const source = await readFile(new URL("../src/hermes/computer.py", import.meta.url), "utf8");
  expect(source).toContain(`HANDOFF = "${computerHandoffMethod}"`);
  expect(await readFile(new URL("../src/hermes/vault.py", import.meta.url), "utf8")).toContain(`HANDOFF = "${computerHandoffMethod}"`);
});

it("names the same terminal request method as the Hermes add-on", async () => {
  const { readFile } = await import("node:fs/promises");
  const { terminalRequestMethod, terminalCommandPattern } = await import("../src/shared/computer.js");
  expect(await readFile(new URL("../src/hermes/computer.py", import.meta.url), "utf8")).toContain(`TERMINAL_REQUEST = "${terminalRequestMethod}"`);
  expect(await readFile(new URL("../src/hermes/vault.py", import.meta.url), "utf8")).toContain(`TERMINAL_REQUEST = "${terminalRequestMethod}"`);
  // The add-on refuses a command with a line break; so must the app, because a pasted newline runs the command.
  expect(terminalCommandPattern.test("ls -la")).toBe(true);
  for (const bad of ["", "ls\nrm -rf ~", "ls\r", "ls\u202e", "x".repeat(501)]) expect(terminalCommandPattern.test(bad), JSON.stringify(bad)).toBe(false);
});

it("keeps a terminal request open instead of refusing it as an unknown bridge", async () => {
  const { applyFrame, emptyLiveState } = await import("../src/server/hermes-mapping.js");
  const { terminalRequestMethod } = await import("../src/shared/computer.js");
  const state = emptyLiveState();
  expect(applyFrame(state, {jsonrpc: "2.0", id: "srq-term", method: terminalRequestMethod, params: {session_id: "s", reason: "r", what_to_do: "w"}}, 1)).toBe(true);
  expect(state.state).toBe("blocked");
});

it("keeps a handoff request open instead of refusing it as an unknown bridge", async () => {
  const { applyFrame, emptyLiveState } = await import("../src/server/hermes-mapping.js");
  const { computerHandoffMethod } = await import("../src/shared/computer.js");
  const state = emptyLiveState();
  expect(applyFrame(state, {jsonrpc: "2.0", id: "srq-hand", method: computerHandoffMethod, params: {session_id: "s", reason: "r", what_to_do: "w"}}, 1)).toBe(true);
  expect(state.state).toBe("blocked");
  expect(applyFrame(state, {jsonrpc: "2.0", id: "event", method: "event", params: {type: "request.cancel", payload: {id: "srq-hand"}}}, 2)).toBe(true);
  expect(state.requests).toEqual([]);
  // Window bridges this client cannot answer are still refused.
  expect(applyFrame(emptyLiveState(), {jsonrpc: "2.0", id: "srq-x", method: "preview.read", params: {}}, 3)).toBe(false);
});
