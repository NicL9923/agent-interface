import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import WebSocket, { type RawData } from "ws";
import type { Runtime } from "../shared/types.js";
import type { ComputerAttachment, ComputerStatus } from "../shared/computer.js";
import { hash, signedIn } from "./auth.js";
import { allowedIdentity, type Config } from "./config.js";
import type { Store } from "./store.js";
import { SystemTerminal } from "./terminal.js";

type Session = { kind: "web" | "native"; hash: string; userId: string };
type Attachment = { session: Session; expires: number; type: "desktop" | "terminal"; native?: ComputerAttachment };
declare module "fastify" { interface FastifyRequest { computerAttachment?: Attachment } }
const viewer = z.string().regex(/^[A-Za-z0-9_-]{16,200}$/);
const ticketQuery = z.object({ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
const empty = z.object({}).strict();
const unavailable = (message: string, statusCode = 409) => Object.assign(new Error(message), {statusCode});
const maxBuffered = 4 * 1024 * 1024;
const frameSize = (data: RawData) => Array.isArray(data) ? data.reduce((size, item) => size + item.length, 0) : data.byteLength;
const closeCode = (code: number) => (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
  || (code >= 3000 && code <= 4999) ? code : 1011;

export async function installComputerRoutes(app: FastifyInstance, config: Config, store: Store,
  runtime: Runtime, maintenance: () => boolean) {
  const terminals = new SystemTerminal(config.computerTerminal);
  const tickets = new Map<string, Attachment>();
  const viewers = new Map<string, Set<string>>();
  const sockets = new Set<WebSocket>();
  const desktopViewers = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();
  let closing = false;
  function source(req: FastifyRequest): Session {
    const userId = signedIn(req).id;
    if (req.nativeSessionHash) return {kind: "native", hash: req.nativeSessionHash, userId};
    if (!req.cookies.session) throw unavailable("Sign in required", 401);
    return {kind: "web", hash: hash(req.cookies.session), userId};
  }
  function valid(session: Session) {
    if (closing) return false;
    const record = session.kind === "web" ? store.getSession(session.hash) : store.getNativeSession(session.hash);
    const user = record && store.getUser(record.userId);
    return Boolean(user && user.id === session.userId && allowedIdentity(config, user));
  }
  const actor = (req: FastifyRequest) => ({actorId: signedIn(req).id, actorName: signedIn(req).name});
  async function status(req: FastifyRequest): Promise<ComputerStatus> {
    let native: ComputerStatus = {available: false, running: false, browserReady: false, label: "Household computer",
      reason: "The shared desktop is not available from the connected Hermes installation.", control: {kind: "idle"},
      terminal: {available: false, target: ""}};
    if (runtime.computerRequest) {
      try { native = await runtime.computerRequest({action: "status", ...actor(req)}) as ComputerStatus; }
      catch { native.reason = "Hermes is disconnected. The system terminal is independent of that connection."; }
    }
    return {...native, terminal: {available: terminals.available, target: terminals.target, reason: terminals.reason}};
  }
  function issue(req: FastifyRequest, type: Attachment["type"], native?: ComputerAttachment) {
    for (const [key, value] of tickets) if (value.expires <= Date.now()) tickets.delete(key);
    if (tickets.size >= 1000) throw unavailable("Too many computer attachment requests. Try again shortly.", 429);
    const token = randomBytes(32).toString("base64url"), expires = Date.now() + 30_000;
    tickets.set(hash(token), {session: source(req), type, native, expires});
    return {path: `/api/computer/${type}/ws?ticket=${token}`, expiresAt: new Date(expires).toISOString(),
      ...(native ? {viewerId: native.viewerId} : {sessionId: terminals.sessionId(signedIn(req).id), target: terminals.target})};
  }
  function fence() { if (maintenance()) throw unavailable("Hermes is being maintained. Try computer input after maintenance finishes."); }
  function requireDesktop() {
    if (!runtime.computerRequest || !runtime.connectComputerDisplay) throw unavailable("The Hermes desktop integration is unavailable.");
  }
  app.get("/api/computer", async req => status(req));
  app.post("/api/computer/desktop", async req => {
    const input = z.object({viewerId: viewer.optional()}).strict().parse(req.body);
    requireDesktop();
    const native = await runtime.computerRequest!({action: "observe", ...actor(req), ...input}) as ComputerAttachment;
    if (native.path !== "/api/display/ws" || !viewer.safeParse(native.viewerId).success)
      throw unavailable("Hermes returned an invalid desktop attachment", 502);
    const owned = viewers.get(signedIn(req).id) ?? new Set<string>();
    owned.add(native.viewerId); viewers.set(signedIn(req).id, owned);
    return issue(req, "desktop", native);
  });
  app.post("/api/computer/control", async req => {
    const input = z.object({action: z.enum(["take", "release"]), viewerId: viewer}).strict().parse(req.body);
    requireDesktop();
    if (!viewers.get(signedIn(req).id)?.has(input.viewerId)) throw unavailable("Open the desktop before changing its control.", 403);
    if (input.action === "take") fence();
    await runtime.computerRequest!({...input, ...actor(req)});
    return status(req);
  });
  app.post("/api/computer/terminal", async req => {
    empty.parse(req.body); fence();
    if (!terminals.available) throw unavailable(terminals.reason!);
    return issue(req, "terminal");
  });
  app.post("/api/computer/terminal/end", async req => {
    const input = z.object({sessionId: z.string()}).strict().parse(req.body); fence();
    if (input.sessionId !== terminals.sessionId(signedIn(req).id)) throw unavailable("This terminal belongs to another household member.", 403);
    await terminals.end(signedIn(req).id);
    return {ok: true};
  });

  function guard(type: Attachment["type"]) {
    return async (req: FastifyRequest) => {
      if (!req.nativeSessionHash && req.headers.origin !== config.origin)
        throw unavailable("The computer connection must come from this application.", 403);
      const query = ticketQuery.parse(req.query), key = hash(query.ticket), ticket = tickets.get(key);
      const current = source(req);
      if (!ticket || ticket.expires <= Date.now() || ticket.type !== type || ticket.session.kind !== current.kind
        || ticket.session.hash !== current.hash || !valid(ticket.session))
        throw unavailable("This computer attachment expired. Reconnect to get a fresh connection.", 401);
      tickets.delete(key);
      req.computerAttachment = ticket;
    };
  }
  function monitor(socket: WebSocket, session: Session) {
    sockets.add(socket);
    const check = () => {
      if (!valid(session)) { socket.close(4401, "Sign in again"); return false; }
      return true;
    };
    const timer = setInterval(check, 1000); timer.unref(); timers.add(timer);
    socket.once("close", () => {clearInterval(timer); timers.delete(timer); sockets.delete(socket);});
    return check;
  }
  app.get("/api/computer/desktop/ws", {websocket: true, preValidation: guard("desktop")}, (socket, req) => {
    const ticket = req.computerAttachment!, check = monitor(socket, ticket.session);
    let upstream: WebSocket;
    try { upstream = runtime.connectComputerDisplay!(ticket.native!); }
    catch { socket.close(1011, "Desktop disconnected"); return; }
    const viewerKey = ticket.native!.viewerId;
    desktopViewers.set(viewerKey, (desktopViewers.get(viewerKey) ?? 0) + 1);
    let pending: {data: RawData; binary: boolean}[] = [], bytes = 0;
    function stop(code = 1011, reason = "Desktop disconnected") {
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      if (upstream.readyState === WebSocket.OPEN) upstream.close(code === 1000 || code === 1001 ? code : 1011);
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      pending = []; bytes = 0;
    }
    // Install synchronously so noVNC's first handshake frame cannot be dropped.
    socket.on("message", (data, binary) => {
      if (!check()) return;
      if (maintenance()) {stop(4003, "Computer input is paused for maintenance"); return;}
      if (!binary) {stop(1003, "Desktop requires binary frames"); return;}
      if (upstream.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount > maxBuffered) {stop(1013, "Desktop connection is too slow"); return;}
        upstream.send(data, {binary});
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        bytes += frameSize(data);
        if (bytes > 256 * 1024) {stop(1013, "Desktop connection is too slow"); return;}
        pending.push({data, binary});
      }
    });
    upstream.on("open", () => {for (const frame of pending) upstream.send(frame.data, {binary: frame.binary}); pending = []; bytes = 0;});
    upstream.on("message", (data, binary) => {
      if (!check() || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > maxBuffered) {stop(1013, "Desktop connection is too slow"); return;}
      socket.send(data, {binary});
    });
    upstream.on("error", () => stop());
    upstream.on("close", (code, reason) => {
      if (socket.readyState === WebSocket.OPEN) socket.close(closeCode(code), reason.toString().slice(0, 80));
    });
    socket.on("error", () => stop());
    socket.on("close", code => {
      const remaining = (desktopViewers.get(viewerKey) ?? 1) - 1;
      if (remaining) desktopViewers.set(viewerKey, remaining); else desktopViewers.delete(viewerKey);
      // A watch-only tab shares the member's reconnect identity. Closing it must
      // not surrender control while another desktop attachment is still open.
      stop(remaining ? 1011 : code === 1005 ? 1000 : code === 1000 || code === 1001 ? code : 1011);
    });
  });
  app.get("/api/computer/terminal/ws", {websocket: true, preValidation: guard("terminal")}, (socket, req) => {
    const ticket = req.computerAttachment!, check = monitor(socket, ticket.session);
    const child = terminals.attach(ticket.session.userId);
    let buffer = "", inputPaused = false;
    const send = (data: Record<string, unknown>) => {
      if (!check() || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > maxBuffered) {socket.close(1013, "Terminal connection is too slow"); return;}
      socket.send(JSON.stringify(data));
    };
    socket.on("message", (data, binary) => {
      if (!check()) return;
      if (maintenance()) {send({type: "error", message: "Terminal input is paused for maintenance."}); return;}
      try {
        if (binary) throw new Error();
        const message = z.discriminatedUnion("type", [
          z.object({type: z.literal("input"), data: z.string().max(16384).refine(value => Buffer.byteLength(value) <= 16384)}).strict(),
          z.object({type: z.literal("resize"), columns: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300)}).strict(),
        ]).parse(JSON.parse(data.toString()));
        if (child.stdin.writableLength > 128 * 1024) {socket.close(1013, "Terminal input is too fast"); return;}
        if (!child.stdin.write(JSON.stringify(message) + "\n") && !inputPaused) {
          inputPaused = true;
          socket.pause();
          child.stdin.once("drain", () => {inputPaused = false; if (socket.readyState === WebSocket.OPEN) socket.resume();});
        }
      } catch {socket.close(1008, "Invalid terminal input");}
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", data => {
      buffer += data;
      if (buffer.length > 256 * 1024) {socket.close(1011, "Invalid terminal output"); return;}
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {const value = JSON.parse(line); if (value.type !== "ready") send(value);}
        catch {socket.close(1011, "Invalid terminal output");}
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => socket.close(1011, "Terminal disconnected"));
    child.on("error", () => {send({type: "error", message: "The terminal could not be opened."}); socket.close(1011);});
    child.on("exit", () => {send({type: "exit"}); socket.close(1000, "Terminal ended");});
    socket.on("close", () => child.stdin.end());
    socket.on("error", () => child.stdin.end());
  });
  app.addHook("onClose", async () => {
    closing = true;
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    tickets.clear(); viewers.clear();
    for (const socket of sockets) socket.close(1001, "Application restarting");
    terminals.close();
  });
}
