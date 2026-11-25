import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import WebSocket, { type RawData } from "ws";
import type { Runtime, User } from "../shared/types.js";
import type {
  ComputerAttachment,
  ComputerHandoffResult,
  ComputerStatus,
} from "../shared/computer.js";
import { apiRoute } from "./api-route.js";
import { hash, signedIn } from "./auth.js";
import { allowedIdentity, type Config } from "./config.js";
import type { Store } from "./store.js";
import { SystemTerminal } from "./terminal.js";
import { safeError } from "./logging.js";
import { visibleTo } from "./bot-access.js";
import { httpError } from "./http-error.js";
import { rawDataText } from "./raw-data-text.js";

type Session = { kind: "web" | "native"; hash: string; userId: string };
type Attachment = {
  session: Session;
  expires: number;
  type: "desktop" | "terminal";
  native?: ComputerAttachment;
};
declare module "fastify" {
  interface FastifyRequest {
    computerAttachment?: Attachment;
  }
}
const viewer = z.string().regex(/^[A-Za-z0-9_-]{16,200}$/);
const ticketQuery = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const empty = z.object({}).strict();
const maxBuffered = 4 * 1024 * 1024;
const frameSize = (data: RawData) =>
  Array.isArray(data) ? data.reduce((size, item) => size + item.length, 0) : data.byteLength;
// The WebSocket plugin admits frames up to a linked Mac's 8 MiB; these sockets keep their own 256 KiB limit.
export const socketFrameLimit = 256 * 1024;
const confirmationWindow = 2 * 3600000;
// Cap retained desktop viewer IDs per member so long-running watch previews never grow unboundedly.
const MAX_VIEWERS_PER_USER = 64;
const VIEWER_TTL_MS = 24 * 3600_000;
type Terminals = Pick<
  SystemTerminal,
  | "isAvailable"
  | "target"
  | "getReason"
  | "sessionId"
  | "sessions"
  | "attach"
  | "end"
  | "endSession"
  | "close"
>;
const closeCode = (code: number) =>
  (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
  (code >= 3000 && code <= 4999)
    ? code
    : 1011;

export async function installComputerRoutes(
  app: FastifyInstance,
  config: Config,
  store: Store,
  runtime: Runtime,
  maintenance: () => boolean,
  terminals: Terminals = new SystemTerminal(config.computerTerminal),
) {
  const tickets = new Map<string, Attachment>();
  const viewers = new Map<string, Map<string, number>>();
  const sockets = new Set<WebSocket>();
  const desktopViewers = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();
  let closing = false;
  function rememberViewer(userId: string, viewerId: string) {
    const now = Date.now();
    const owned = viewers.get(userId) ?? new Map<string, number>();
    for (const [id, seenAt] of owned) {
      if (now - seenAt > VIEWER_TTL_MS && !desktopViewers.has(id)) owned.delete(id);
    }
    owned.delete(viewerId);
    owned.set(viewerId, now);
    while (owned.size > MAX_VIEWERS_PER_USER) {
      const oldest = [...owned.keys()].find((id) => !desktopViewers.has(id));
      if (!oldest) break;
      owned.delete(oldest);
    }
    viewers.set(userId, owned);
  }
  function hasViewer(userId: string, viewerId: string) {
    const owned = viewers.get(userId);
    const seenAt = owned?.get(viewerId);
    if (seenAt === undefined) return false;
    const now = Date.now();
    if (now - seenAt > VIEWER_TTL_MS && !desktopViewers.has(viewerId)) {
      owned!.delete(viewerId);
      return false;
    }
    owned!.delete(viewerId);
    owned!.set(viewerId, now);
    return true;
  }
  function source(req: FastifyRequest): Session {
    const userId = signedIn(req).id;
    if (req.nativeSessionHash) return { kind: "native", hash: req.nativeSessionHash, userId };
    if (!req.cookies.session) throw httpError(401, "Sign in required");
    return { kind: "web", hash: hash(req.cookies.session), userId };
  }
  function valid(session: Session) {
    if (closing) return false;
    const record =
      session.kind === "web"
        ? store.getSession(session.hash)
        : store.getNativeSession(session.hash);
    const user = record && store.getUser(record.userId);
    return Boolean(user && user.id === session.userId && allowedIdentity(config, user));
  }
  const actor = (req: FastifyRequest) => ({
    actorId: signedIn(req).id,
    actorName: signedIn(req).name,
  });
  const admins = () => config.computerTerminalAdmins ?? [];
  const terminalAdmin = (user: User) => admins().includes(user.email.toLowerCase());
  // The desktop is for every household member; the shell is for terminal administrators, in a
  // browser or in the iOS app.
  function shellDenial(req: FastifyRequest) {
    if (!admins().length) return "The system terminal is turned off for this household.";
    if (!terminalAdmin(signedIn(req)))
      return "The system terminal is limited to household administrators.";
  }
  // When the person behind this session last proved who they are: the web's confirmation for a
  // browser, the iOS app's own for a native session.
  const confirmedAt = (session: Session) =>
    session.kind === "web"
      ? store.sessionConfirmedAt(session.hash)
      : store.nativeSessionConfirmedAt(session.hash);
  function confirmed(req: FastifyRequest) {
    const at = confirmedAt(source(req));
    return at !== undefined && Date.now() - at <= confirmationWindow;
  }
  async function requireShell(req: FastifyRequest, fresh: boolean) {
    const denied = shellDenial(req);
    if (denied) throw httpError(403, denied);
    if (!(await terminals.isAvailable()))
      throw httpError(
        409,
        (await terminals.getReason()) ?? "The system terminal service is not running on this host.",
      );
    // Open shells continue past the window; only new attachments need a recent sign-in.
    if (fresh && !confirmed(req))
      throw httpError(401, "Confirm it's you to open the terminal.", {
        code: "reauthentication_required",
      });
  }
  // The iOS terminal page has no signed-in request of its own, so the user comes from the ticket's session.
  function audit(req: FastifyRequest, action: string, session: Session, user = signedIn(req)) {
    req.log.info(
      {
        audit: "terminal",
        action,
        userId: user.id,
        email: user.email,
        session: session.hash.slice(0, 16),
        forwardedFor: req.headers["x-forwarded-for"],
        userAgent: req.headers["user-agent"],
      },
      `System terminal ${action}`,
    );
  }
  function alertAdmins(user: User, session: Session) {
    // One alert per confirmed sign-in, however often that session reconnects.
    const eventId = `terminal-open:${session.hash.slice(0, 16)}:${confirmedAt(session) ?? 0}`;
    for (const admin of store.users())
      if (terminalAdmin(admin) && allowedIdentity(config, admin))
        store.queueNotification(eventId, admin.id, {
          title: "System terminal opened",
          body: `${user.name} opened the system terminal.`,
          url: "/?computer=1",
          tag: eventId,
          kind: "security",
          queuedAt: Date.now(),
        });
  }
  async function status(req: FastifyRequest): Promise<ComputerStatus> {
    let native: ComputerStatus = {
      available: false,
      running: false,
      browserReady: false,
      label: "Household computer",
      reason: "The shared desktop is not configured yet.",
      control: { kind: "idle" },
      terminal: { available: false, target: "" },
    };
    if (runtime.computerRequest) {
      try {
        native = (await runtime.computerRequest({
          action: "status",
          ...actor(req),
        })) as ComputerStatus;
      } catch {
        native.reason =
          "Hermes is disconnected. The system terminal is independent of that connection.";
      }
    }
    // Hermes names the acting assistant by its profile, the assistant's ID. The desktop itself
    // is one household screen, so a private assistant at work can still be watched there.
    if (native.control?.kind === "bot" && !visibleTo(store, native.control.name, signedIn(req).id))
      native = { ...native, control: { kind: "bot" } };
    const denied = shellDenial(req);
    if (denied) return { ...native, terminal: { available: false, target: "", reason: denied } };
    const available = await terminals.isAvailable();
    const reason = available ? undefined : await terminals.getReason();
    return {
      ...native,
      terminal: {
        available,
        target: terminals.target,
        reason,
        ...(available && !confirmed(req) ? { confirmationRequired: true } : {}),
      },
    };
  }
  function issue(req: FastifyRequest, type: Attachment["type"], native?: ComputerAttachment) {
    for (const [key, value] of tickets) if (value.expires <= Date.now()) tickets.delete(key);
    if (tickets.size >= 1000)
      throw httpError(429, "Too many computer attachment requests. Try again shortly.");
    const token = randomBytes(32).toString("base64url"),
      expires = Date.now() + 30_000;
    tickets.set(hash(token), { session: source(req), type, native, expires });
    return {
      path: `/api/computer/${type}/ws?ticket=${token}`,
      expiresAt: new Date(expires).toISOString(),
      ...(native
        ? { viewerId: native.viewerId }
        : { sessionId: terminals.sessionId(signedIn(req).id), target: terminals.target }),
    };
  }
  function fence() {
    if (maintenance())
      throw httpError(
        409,
        "Hermes is being maintained. Try computer input after maintenance finishes.",
      );
  }
  function requireDesktop() {
    if (!runtime.computerRequest || !runtime.connectComputerDisplay)
      throw httpError(409, "The Hermes desktop integration is unavailable.");
  }
  apiRoute(app, "GET /computer", {}, async (req) => status(req));
  apiRoute(
    app,
    "POST /computer/desktop",
    { body: z.object({ viewerId: viewer.optional() }).strict() },
    async (req, input) => {
      requireDesktop();
      const native = (await runtime.computerRequest!({
        action: "observe",
        ...actor(req),
        ...input,
      })) as ComputerAttachment;
      if (native.path !== "/api/display/ws" || !viewer.safeParse(native.viewerId).success)
        throw httpError(502, "Hermes returned an invalid desktop attachment");
      rememberViewer(signedIn(req).id, native.viewerId);
      return issue(req, "desktop", native);
    },
  );
  apiRoute(
    app,
    "POST /computer/control",
    { body: z.object({ action: z.enum(["take", "release"]), viewerId: viewer }).strict() },
    async (req, input) => {
      requireDesktop();
      if (!hasViewer(signedIn(req).id, input.viewerId))
        throw httpError(403, "Open the desktop before changing its control.");
      if (input.action === "take") fence();
      await runtime.computerRequest!({ ...input, ...actor(req) });
      return status(req);
    },
  );
  // Not now on an assistant's request to take over. Take over itself is the ordinary control route.
  const handoffParams = z
    .object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
      requestId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    })
    .strict();
  const handoffBody = z
    .object({
      decision: z.literal("decline"),
      epoch: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
      sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    })
    .strict();
  apiRoute(
    app,
    "POST /bots/:id/computer-handoffs/:requestId",
    { body: handoffBody },
    async (req, body): Promise<ComputerHandoffResult> => {
      const params = handoffParams.parse(req.params);
      if (!visibleTo(store, params.id, signedIn(req).id))
        throw httpError(404, "Assistant not found");
      requireDesktop();
      const result = (await runtime.computerRequest!({
        action: "handoff",
        decision: body.decision,
        profile: params.id,
        requestId: params.requestId,
        epoch: body.epoch,
        sessionId: body.sessionId,
        ...actor(req),
      })) as unknown as Partial<ComputerHandoffResult>;
      if (result?.status !== "ok" && result?.status !== "expired")
        throw httpError(502, "Hermes returned an invalid answer for this computer request");
      return { status: result.status };
    },
  );
  apiRoute(app, "POST /computer/terminal", { body: empty }, async (req) => {
    fence();
    await requireShell(req, true);
    const ticket = issue(req, "terminal");
    audit(req, "ticket", source(req));
    return ticket;
  });
  apiRoute(
    app,
    "POST /computer/terminal/end",
    { body: z.object({ sessionId: z.string() }).strict() },
    async (req, input) => {
      fence();
      await requireShell(req, false);
      if (input.sessionId !== terminals.sessionId(signedIn(req).id))
        throw httpError(403, "This terminal belongs to another household member.");
      await terminals.end(signedIn(req).id);
      audit(req, "end", source(req));
      return { ok: true };
    },
  );

  function guard(type: Attachment["type"]) {
    return async (req: FastifyRequest) => {
      if (!req.nativeSessionHash && req.headers.origin !== config.origin)
        throw httpError(403, "The computer connection must come from this application.");
      const query = ticketQuery.parse(req.query),
        key = hash(query.ticket),
        ticket = tickets.get(key);
      // The iOS app's desktop and terminal pages cannot put the app's bearer token on a WebSocket. A
      // ticket of this type issued to that native session moments ago stands in for it, still once
      // and from this Origin.
      const nativePage = ticket?.session.kind === "native" && !req.nativeSessionHash;
      if (!nativePage && !req.user) throw httpError(401, "Sign in required");
      const current = nativePage ? ticket.session : source(req);
      if (
        !ticket ||
        ticket.expires <= Date.now() ||
        ticket.type !== type ||
        ticket.session.kind !== current.kind ||
        ticket.session.hash !== current.hash ||
        !valid(ticket.session)
      )
        throw httpError(
          401,
          "This computer attachment expired. Reconnect to get a fresh connection.",
        );
      tickets.delete(key);
      req.computerAttachment = ticket;
    };
  }
  function monitor(socket: WebSocket, session: Session) {
    sockets.add(socket);
    const check = () => {
      if (!valid(session)) {
        socket.close(4401, "Sign in again");
        return false;
      }
      return true;
    };
    const timer = setInterval(check, 1000);
    timer.unref();
    timers.add(timer);
    socket.once("close", () => {
      clearInterval(timer);
      timers.delete(timer);
      sockets.delete(socket);
    });
    return check;
  }
  app.get(
    "/api/computer/desktop/ws",
    { websocket: true, preValidation: guard("desktop") },
    (socket, req) => {
      const ticket = req.computerAttachment!,
        check = monitor(socket, ticket.session);
      let upstream: WebSocket;
      try {
        upstream = runtime.connectComputerDisplay!(ticket.native!);
      } catch {
        socket.close(1011, "Desktop disconnected");
        return;
      }
      const viewerKey = ticket.native!.viewerId;
      desktopViewers.set(viewerKey, (desktopViewers.get(viewerKey) ?? 0) + 1);
      let pending: { data: RawData; binary: boolean }[] = [],
        bytes = 0;
      function stop(code = 1011, reason = "Desktop disconnected") {
        if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
        if (upstream.readyState === WebSocket.OPEN)
          upstream.close(code === 1000 || code === 1001 ? code : 1011);
        else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
        pending = [];
        bytes = 0;
      }
      // Install synchronously so noVNC's first handshake frame cannot be dropped.
      socket.on("message", (data, binary) => {
        if (frameSize(data) > socketFrameLimit) {
          stop(1009, "Message too large");
          return;
        }
        if (!check()) return;
        if (maintenance()) {
          stop(4003, "Computer input is paused for maintenance");
          return;
        }
        if (!binary) {
          stop(1003, "Desktop requires binary frames");
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > maxBuffered) {
            stop(1013, "Desktop connection is too slow");
            return;
          }
          upstream.send(data, { binary });
        } else if (upstream.readyState === WebSocket.CONNECTING) {
          bytes += frameSize(data);
          if (bytes > 256 * 1024) {
            stop(1013, "Desktop connection is too slow");
            return;
          }
          pending.push({ data, binary });
        }
      });
      upstream.on("open", () => {
        for (const frame of pending) upstream.send(frame.data, { binary: frame.binary });
        pending = [];
        bytes = 0;
      });
      upstream.on("message", (data, binary) => {
        if (!check() || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > maxBuffered) {
          stop(1013, "Desktop connection is too slow");
          return;
        }
        socket.send(data, { binary });
      });
      upstream.on("error", () => stop());
      upstream.on("close", (code, reason) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.close(closeCode(code), reason.toString().slice(0, 80));
      });
      socket.on("error", () => stop());
      socket.on("close", (code) => {
        const remaining = (desktopViewers.get(viewerKey) ?? 1) - 1;
        if (remaining) desktopViewers.set(viewerKey, remaining);
        else desktopViewers.delete(viewerKey);
        // A watch-only tab shares the member's reconnect identity. Closing it must
        // not surrender control while another desktop attachment is still open.
        stop(
          remaining ? 1011 : code === 1005 ? 1000 : code === 1000 || code === 1001 ? code : 1011,
        );
      });
    },
  );
  app.get(
    "/api/computer/terminal/ws",
    { websocket: true, preValidation: guard("terminal") },
    (socket, req) => {
      const ticket = req.computerAttachment!,
        check = monitor(socket, ticket.session);
      // The guard just checked that this session's user exists. A native page's request has no user.
      const user = store.getUser(ticket.session.userId)!;
      const child = terminals.attach(ticket.session.userId);
      audit(req, "attach", ticket.session, user);
      alertAdmins(user, ticket.session);
      let buffer = "",
        inputPaused = false;
      const send = (data: Record<string, unknown>) => {
        if (!check() || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > maxBuffered) {
          socket.close(1013, "Terminal connection is too slow");
          return;
        }
        socket.send(JSON.stringify(data));
      };
      socket.on("message", (data, binary) => {
        if (frameSize(data) > socketFrameLimit) {
          socket.close(1009, "Message too large");
          return;
        }
        if (!check()) return;
        if (maintenance()) {
          send({ type: "error", message: "Terminal input is paused for maintenance." });
          return;
        }
        try {
          if (binary) throw new Error();
          const message = z
            .discriminatedUnion("type", [
              z
                .object({
                  type: z.literal("input"),
                  data: z
                    .string()
                    .max(16384)
                    .refine((value) => Buffer.byteLength(value) <= 16384),
                })
                .strict(),
              z
                .object({
                  type: z.literal("resize"),
                  columns: z.number().int().min(2).max(500),
                  rows: z.number().int().min(2).max(300),
                })
                .strict(),
            ])
            .parse(JSON.parse(rawDataText(data)));
          if (child.stdin.writableLength > 128 * 1024) {
            socket.close(1013, "Terminal input is too fast");
            return;
          }
          if (!child.stdin.write(JSON.stringify(message) + "\n") && !inputPaused) {
            inputPaused = true;
            socket.pause();
            child.stdin.once("drain", () => {
              inputPaused = false;
              if (socket.readyState === WebSocket.OPEN) socket.resume();
            });
          }
        } catch {
          socket.close(1008, "Invalid terminal input");
        }
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => {
        buffer += data;
        if (buffer.length > 256 * 1024) {
          socket.close(1011, "Invalid terminal output");
          return;
        }
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.type !== "ready") send(value);
          } catch {
            socket.close(1011, "Invalid terminal output");
          }
        }
      });
      child.stderr.resume();
      child.stdin.on("error", () => socket.close(1011, "Terminal disconnected"));
      child.on("error", () => {
        send({ type: "error", message: "The terminal could not be opened." });
        socket.close(1011);
      });
      child.on("exit", () => {
        send({ type: "exit" });
        socket.close(1000, "Terminal ended");
      });
      socket.on("close", () => {
        child.stdin.end();
        audit(req, "detach", ticket.session, user);
      });
      socket.on("error", () => child.stdin.end());
    },
  );
  // Removed members and non-administrators keep no shell across restarts. Without a known
  // administrator (fresh database or mistyped list), pruning could end the owner's shell.
  if (admins().length && (await terminals.isAvailable())) {
    const keep = new Set(
      store
        .users()
        .filter(terminalAdmin)
        .map((user) => terminals.sessionId(user.id)),
    );
    if (!keep.size)
      app.log.warn("Skipped terminal pruning: no terminal administrator has signed in yet");
    else
      for (const sessionId of await terminals.sessions()) {
        if (keep.has(sessionId)) continue;
        try {
          await terminals.endSession(sessionId);
          app.log.info(
            { audit: "terminal", action: "prune", session: sessionId },
            "Ended a shell that no longer belongs to a terminal administrator",
          );
        } catch (error) {
          app.log.warn(
            { error: safeError(error), session: sessionId },
            "Could not end a non-administrator shell",
          );
        }
      }
  }
  app.addHook("onClose", async () => {
    closing = true;
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    tickets.clear();
    viewers.clear();
    for (const socket of sockets) socket.close(1001, "Application restarting");
    terminals.close();
  });
}
