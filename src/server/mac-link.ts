import { timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { signedIn } from "./auth.js";
import { allowedIdentity, type Config } from "./config.js";
import { httpError } from "./http-error.js";
import type { Store } from "./store.js";
import type { MacDevice } from "./store-macs.js";
import type { LinkedMacs } from "../shared/mac.js";
import { MAX_MACS } from "./store-macs.js";

/**
 * WildBots for Mac: linked Macs that personal assistants can ask to act, unattended when the
 * Mac allows it. The Mac decides what each assistant may do; this server routes requests from
 * the Hermes add-on to the right Mac, refuses early what the Mac's last reported grants would
 * refuse, and never allows more than they do. See docs/MacLink.md for the protocol.
 */
export const PROTOCOL = 1;
export const MAX_IN_FLIGHT = 4;
export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 60_000;
/** How long past an action's own timeout the server waits for the Mac to report, including a reconnect. */
export const GRACE_MS = 15_000;
const CONFIRMATION_WINDOW = 2 * 3600_000;
/** The largest link frame: a 1 MiB file read or a screenshot, base64 encoded, with room to spare. */
export const MAX_FRAME = 8 * 1024 * 1024;
const SEEN_EVERY = 60_000;
const QUICK_ACTION_MS = 60_000;

export const abilities = ["files_read", "files_write", "run", "screenshot"] as const;
export type Ability = (typeof abilities)[number];
export const actionAbility = { run: "run", read_file: "files_read", write_file: "files_write", list_dir: "files_read", screenshot: "screenshot" } as const;
type Action = keyof typeof actionAbility;

const text = (max: number) => z.string().min(1).max(max);
const stateSchema = z.object({
  paused: z.boolean(),
  screenLocked: z.boolean(),
  screenPermission: z.enum(["granted", "denied", "unknown"]),
  folders: z.array(z.object({ name: text(200), path: text(4096) }).strict()).max(64),
  grants: z.array(z.object({
    assistantId: text(200),
    abilities: z.array(z.enum(abilities)).max(abilities.length),
    unattended: z.boolean(),
  }).strict()).max(200),
}).strict();
export type MacState = z.infer<typeof stateSchema>;
// A long message, such as one quoting a long path, is shortened rather than refused.
const MAX_MESSAGE = 4000;
const errorSchema = z.object({ code: z.string().regex(/^[a-z_]{1,64}$/),
  message: z.string().transform(message => message.length > MAX_MESSAGE ? message.slice(0, MAX_MESSAGE - 1) + "…" : message) }).passthrough();
const resultSchema = z.union([
  z.object({ type: z.literal("result"), id: z.string().min(1).max(100), ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ type: z.literal("result"), id: z.string().min(1).max(100), ok: z.literal(false), error: errorSchema }).strict(),
]);
const incoming = z.union([
  z.object({ type: z.literal("hello"), protocol: z.number().int(), appVersion: z.string().max(64).optional(), state: stateSchema }).strict(),
  z.object({ type: z.literal("state"), state: stateSchema }).strict(),
  resultSchema,
]);

export type LinkError = { code: string; message: string; [detail: string]: unknown };
export type LinkOutcome = { ok: true; value: unknown } | { ok: false; error: LinkError };
const failure = (code: string, message: string, details: Record<string, unknown> = {}): LinkOutcome =>
  ({ ok: false, error: { code, message, ...details } });

interface Link { device: MacDevice; socket: WebSocket; generation: number; state?: MacState; heard: number; seenAt: number }
interface Pending { deviceId: string; resolve(outcome: LinkOutcome): void; timer: NodeJS.Timeout }

const enrollment = z.object({
  name: text(64),
  model: z.string().max(64).optional(),
  osVersion: z.string().max(64).optional(),
  appVersion: z.string().max(64).optional(),
}).strict();
const invocation = z.object({
  invocationId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  assistantId: text(200),
  assistantName: z.string().max(200).optional(),
  scheduled: z.boolean(),
  device: z.string().min(1).max(200).optional(),
  action: z.enum(["list", ...Object.keys(actionAbility) as [Action, ...Action[]]]),
  args: z.record(z.string(), z.unknown()).default({}),
}).strict();
type Invocation = z.infer<typeof invocation>;

/** How long the Mac may take, from the action's own arguments; the Mac validates them again. */
export function actionTimeout(action: Action, args: Record<string, unknown>) {
  if (action !== "run") return QUICK_ACTION_MS;
  const seconds = args.timeoutSeconds ?? 120;
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 1 && seconds <= 600 ? seconds * 1000 : undefined;
}

/** Whether this request came straight from a process on this host, not through Caddy or another proxy. */
export const directLoopback = (req: FastifyRequest) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
  && !Object.keys(req.headers).some(name => name === "forwarded" || name.startsWith("x-forwarded-") || name === "x-real-ip");

const sameKey = (supplied: string, expected: string) => {
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The live links and the invocations waiting on them. One instance per app. */
export class MacBroker {
  private readonly links = new Map<string, Link>();
  private readonly pending = new Map<string, Pending>();
  private generation = 0;
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly store: Store, private readonly config: Config, private readonly log: FastifyBaseLogger,
    private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  online(deviceId: string) { return this.links.get(deviceId)?.state !== undefined; }
  state(deviceId: string) { return this.links.get(deviceId)?.state; }

  /** Attaches an authenticated Mac. A newer socket replaces the older one, whose late events are ignored. */
  attach(device: MacDevice, socket: WebSocket) {
    const previous = this.links.get(device.id);
    const link: Link = { device, socket, generation: ++this.generation, heard: this.now(), seenAt: 0 };
    this.links.set(device.id, link);
    if (previous) previous.socket.close(4409, "Replaced by a newer connection");
    const current = () => this.links.get(device.id) === link;
    // The app pings on its own schedule too; either direction proves the link is alive.
    socket.on("pong", () => { if (current()) link.heard = this.now(); });
    socket.on("ping", () => { if (current()) link.heard = this.now(); });
    socket.on("message", (data: RawData, binary: boolean) => {
      if (!current()) return;
      link.heard = this.now();
      this.receive(link, data, binary);
    });
    socket.on("close", () => {
      if (!current()) return;
      this.links.delete(device.id);
      this.store.macs.seen(device.id, this.now());
      // Pending invocations keep waiting: the Mac resends results it finished after it reconnects.
    });
    socket.on("error", () => socket.terminate());
  }

  private send(link: Link, message: Record<string, unknown>) {
    if (link.socket.readyState !== WebSocket.OPEN) return false;
    link.socket.send(JSON.stringify(message));
    return true;
  }

  private receive(link: Link, data: RawData, binary: boolean) {
    let message: z.infer<typeof incoming>;
    let raw: unknown;
    try {
      if (binary) throw new Error("binary");
      raw = JSON.parse(data.toString());
      message = incoming.parse(raw);
    } catch {
      // A result this server cannot read is acknowledged and fails its call. Closing instead would
      // make the Mac resend it after every reconnect, and the link would never stay up.
      const id = link.state && typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "result"
        ? (raw as { id?: unknown }).id : undefined;
      if (typeof id === "string" && id.length >= 1 && id.length <= 100) {
        this.send(link, { type: "ack", id });
        if (this.pending.get(id)?.deviceId === link.device.id)
          this.settle(id, failure("failed", "The Mac sent a result this server could not read. Whether the action finished is unknown."));
        return;
      }
      link.socket.close(1007, "Invalid message");
      return;
    }
    if (message.type === "hello") {
      if (message.protocol !== PROTOCOL) { link.socket.close(4400, "Unsupported protocol version"); return; }
      link.state = message.state;
      this.send(link, { type: "welcome", protocol: PROTOCOL });
      this.touch(link, true);
      return;
    }
    if (!link.state) { link.socket.close(1008, "Send hello first"); return; }
    if (message.type === "state") { link.state = message.state; this.touch(link); return; }
    // Acknowledge every result, even one nobody waits for any more, so the Mac stops resending it.
    this.send(link, { type: "ack", id: message.id });
    const pending = this.pending.get(message.id);
    if (!pending || pending.deviceId !== link.device.id) return;
    this.settle(message.id, message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error });
  }

  private touch(link: Link, force = false) {
    const now = this.now();
    if (force || now - link.seenAt >= SEEN_EVERY) { link.seenAt = now; this.store.macs.seen(link.device.id, now); }
  }

  private settle(id: string, outcome: LinkOutcome) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  }

  /** Drops links that went quiet, links whose person left the household, and pings the rest. */
  heartbeat() {
    for (const link of [...this.links.values()]) {
      const user = this.store.getUser(link.device.userId);
      if (!user || !allowedIdentity(this.config, user) || !this.store.macs.linked(link.device.userId).some(mac => mac.id === link.device.id)) {
        this.disconnect(link, 4403, "This Mac is no longer linked to a household member");
        continue;
      }
      if (this.now() - link.heard > STALE_MS) { link.socket.terminate(); continue; }
      if (link.socket.readyState === WebSocket.OPEN) link.socket.ping();
    }
  }

  private disconnect(link: Link, code: number, reason: string) {
    if (this.links.get(link.device.id) === link) {
      this.links.delete(link.device.id);
      this.store.macs.seen(link.device.id, this.now());
    }
    link.socket.close(code, reason);
  }

  /** Tells a revoked Mac to delete its credential, disconnects it and closes what waited on it. */
  revoked(deviceId: string) {
    const link = this.links.get(deviceId);
    if (link) {
      this.send(link, { type: "revoked" });
      this.disconnect(link, 4401, "This Mac was unlinked");
    }
    for (const [id, pending] of this.pending)
      if (pending.deviceId === deviceId)
        this.settle(id, failure("uncertain", "The Mac was unlinked while this action was running. It may or may not have finished; the Mac stopped what was still running."));
  }

  private inFlight(deviceId: string) {
    let count = 0;
    for (const pending of this.pending.values()) if (pending.deviceId === deviceId) count++;
    return count;
  }

  /** Answers one request from the Hermes add-on. Never throws for a refusal; refusals are outcomes. */
  async invoke(request: Invocation): Promise<LinkOutcome> {
    const presentation = this.store.presentation(request.assistantId);
    const owner = presentation.shared === false && presentation.ownerId ? this.store.getUser(presentation.ownerId) : undefined;
    if (!owner || !allowedIdentity(this.config, owner))
      return failure("assistant_not_personal", "Only a household member's own personal assistant can use their Mac. "
        + "This assistant is shared or has no recorded owner. Tell the user; they can make it personal in its settings.");
    const macs = this.store.macs.linked(owner.id);
    if (request.action === "list") return { ok: true, value: { macs: macs.map(mac => this.describe(mac, request.assistantId)) } };
    if (!macs.length)
      return failure("no_mac", "No Mac is linked. The user can link one with WildBots for Mac.");
    let mac: MacDevice | undefined;
    if (request.device) {
      const wanted = request.device.toLowerCase();
      mac = macs.find(candidate => candidate.id === request.device) ?? macs.find(candidate => candidate.name.toLowerCase() === wanted);
      if (!mac) return failure("choose_mac", `No linked Mac is called "${request.device}". Choose one of these.`, { macs: macs.map(m => m.name) });
    } else if (macs.length === 1) mac = macs[0];
    else return failure("choose_mac", "More than one Mac is linked. Pass device with one of these names.", { macs: macs.map(m => m.name) });
    const link = this.links.get(mac.id);
    if (!link?.state)
      return failure("mac_offline", `${mac.name} is offline: asleep, shut down, logged out or without a network. Try again later or tell the user.`,
        { lastSeenAt: mac.lastSeenAt ? new Date(mac.lastSeenAt).toISOString() : null });
    const action = request.action as Action;
    const ability = actionAbility[action];
    const grant = link.state.grants.find(candidate => candidate.assistantId === request.assistantId);
    if (link.state.paused) return failure("paused", `The user paused assistants on ${mac.name}. Try again later or ask them to resume.`);
    if (!grant?.abilities.includes(ability))
      return failure("not_allowed", `${mac.name} does not allow this assistant to ${describeAbility(ability)}. The user can allow it in WildBots for Mac under Assistants.`);
    if (request.scheduled && !grant.unattended)
      return failure("unattended_not_allowed", `${mac.name} allows this only while someone is in a WildBots chat with this assistant, not in scheduled or messaging runs. The user can turn on Also when unattended in WildBots for Mac.`);
    const timeout = actionTimeout(action, request.args);
    if (timeout === undefined) return failure("invalid_arguments", "timeoutSeconds must be a whole number from 1 to 600.");
    if (this.inFlight(mac.id) >= MAX_IN_FLIGHT)
      return failure("mac_busy", `${mac.name} is already running ${MAX_IN_FLIGHT} actions. Wait for one to finish.`);
    if (this.pending.has(request.invocationId))
      return failure("invalid_arguments", "This invocation ID is already in use.");
    const outcome = new Promise<LinkOutcome>(resolve => {
      const timer = setTimeout(() => this.settle(request.invocationId, failure("uncertain",
        `${mac!.name} did not report back in time. The action may or may not have run; check before repeating anything that changes files.`)),
        timeout + GRACE_MS);
      timer.unref();
      this.pending.set(request.invocationId, { deviceId: mac!.id, resolve, timer });
    });
    const sent = this.send(link, { type: "invoke", id: request.invocationId, assistantId: request.assistantId,
      assistantName: request.assistantName ?? request.assistantId, scheduled: request.scheduled, action, args: request.args, timeoutMs: timeout });
    if (!sent) this.settle(request.invocationId, failure("mac_offline", `${mac.name} disconnected before the action was sent. Nothing ran.`,
      { lastSeenAt: new Date(this.now()).toISOString() }));
    const result = await outcome;
    this.log.info({ deviceId: mac.id, assistantId: request.assistantId, action, scheduled: request.scheduled,
      outcome: result.ok ? "ok" : result.error.code }, "Mac action");
    return result;
  }

  /** What one Mac offers this assistant, for the list action. */
  describe(mac: MacDevice, assistantId: string) {
    const state = this.links.get(mac.id)?.state;
    const grant = state?.grants.find(candidate => candidate.assistantId === assistantId);
    return {
      name: mac.name, online: Boolean(state), lastSeenAt: mac.lastSeenAt ? new Date(mac.lastSeenAt).toISOString() : null,
      // Folder paths only for an assistant the Mac lets do something there.
      ...(state ? { paused: state.paused, screenLocked: state.screenLocked, folders: grant?.abilities.length ? state.folders : [],
        allowed: grant?.abilities ?? [], unattended: grant?.unattended ?? false } : {}),
    };
  }

  close() {
    clearInterval(this.timer);
    for (const link of this.links.values()) link.socket.close(1001, "Server is shutting down");
    this.links.clear();
    for (const id of [...this.pending.keys()])
      this.settle(id, failure("uncertain", "The app server restarted while this action was running. It may or may not have finished."));
  }
}

const describeAbility = (ability: Ability) => ({
  files_read: "read its files", files_write: "write files", run: "run commands", screenshot: "take screenshots",
})[ability];

/** The routes for linking Macs, the Macs' own socket and the Hermes add-on's requests. */
export function installMacLink(app: FastifyInstance, config: Config, store: Store) {
  const broker = new MacBroker(store, config, app.log);
  const available = () => config.macLinkKey !== undefined;
  const unavailable = "This household's server has not turned on Mac links. The installer adds MAC_LINK_KEY to enable them.";

  app.post("/api/mac/devices", async (req, reply) => {
    const user = signedIn(req);
    if (!req.nativeSessionHash)
      throw httpError(403, "Link a Mac from WildBots for Mac.", { code: "native_required" });
    if (!available()) throw httpError(409, unavailable, { code: "link_unavailable" });
    const confirmed = store.nativeSessionConfirmedAt(req.nativeSessionHash);
    if (!confirmed || Date.now() - confirmed > CONFIRMATION_WINDOW)
      throw httpError(403, "Sign in again to link this Mac.", { code: "confirmation_required" });
    const body = enrollment.parse(req.body);
    const enrolled = store.macs.enroll(user.id, body);
    if (!enrolled) throw httpError(409, `You already have ${MAX_MACS} linked Macs. Unlink one first.`, { code: "mac_limit" });
    app.log.info({ deviceId: enrolled.device.id, userId: user.id }, "Mac linked");
    return reply.code(201).send({ deviceId: enrolled.device.id, credential: enrolled.credential, name: enrolled.device.name });
  });

  app.get("/api/mac/devices", async (req): Promise<LinkedMacs> => {
    const user = signedIn(req);
    if (!available()) return { available: false, reason: unavailable, devices: [] };
    return {
      available: true,
      devices: store.macs.linked(user.id).map(mac => {
        const state = broker.state(mac.id);
        return {
          id: mac.id, name: mac.name, model: mac.model ?? null, osVersion: mac.osVersion ?? null, appVersion: mac.appVersion ?? null,
          createdAt: new Date(mac.createdAt).toISOString(), lastSeenAt: mac.lastSeenAt ? new Date(mac.lastSeenAt).toISOString() : null,
          online: Boolean(state), state: state ? { paused: state.paused, screenLocked: state.screenLocked } : null,
        };
      }),
    };
  });

  app.delete<{ Params: { id: string } }>("/api/mac/devices/:id", async req => {
    const user = signedIn(req);
    if (!store.macs.revoke(req.params.id, user.id)) throw httpError(404, "Mac not found", { code: "mac_not_found" });
    broker.revoked(req.params.id);
    app.log.info({ deviceId: req.params.id, userId: user.id }, "Mac unlinked");
    return { ok: true };
  });

  const deviceCredential = /^Device (mac_[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
  // A request without a well-formed device credential, or from a browser, never upgrades. A well-formed
  // one is checked after the upgrade, so each refusal is a close code the app can act on.
  const linkRequest = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!deviceCredential.test(req.headers.authorization ?? "") || req.headers.origin !== undefined || req.headers.cookie !== undefined)
      return reply.code(401).send({ error: "Mac link authentication required", code: "link_auth_required" });
  };
  app.get("/api/mac/link", { websocket: true, preValidation: linkRequest }, (socket, req) => {
    if (!available()) { socket.close(4404, "Mac links are not turned on"); return; }
    const match = deviceCredential.exec(req.headers.authorization ?? "")!;
    const device = store.macs.authenticate(match[1], match[2]);
    if (!device) { socket.close(4401, "This Mac is not linked"); return; }
    const user = store.getUser(device.userId);
    if (!user || !allowedIdentity(config, user)) { socket.close(4403, "This Mac's owner is not a household member"); return; }
    broker.attach(device, socket);
  });

  // The Mac's own Unlink: its device credential revokes itself, so it leaves the owner's list at once.
  app.delete("/api/mac/link", async (req, reply) => {
    const match = deviceCredential.exec(req.headers.authorization ?? "");
    const device = match && req.headers.origin === undefined && req.headers.cookie === undefined
      ? store.macs.authenticate(match[1], match[2]) : undefined;
    if (!device) return reply.code(401).send({ error: "Mac link authentication required", code: "link_auth_required" });
    store.macs.revoke(device.id, device.userId);
    broker.revoked(device.id);
    app.log.info({ deviceId: device.id, userId: device.userId }, "Mac unlinked itself");
    return { ok: true };
  });

  app.post("/api/agent-link/mac", { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const key = config.macLinkKey;
    const supplied = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1];
    if (!key || !supplied || !directLoopback(req) || req.headers.origin !== undefined || req.headers.cookie !== undefined || !sameKey(supplied, key))
      return reply.code(401).send({ error: "Mac link authentication required", code: "link_auth_required" });
    const parsed = invocation.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "Invalid Mac link request", code: "invalid_request", issues: parsed.error.issues.map(issue => issue.path.join(".")) });
    return broker.invoke(parsed.data);
  });

  app.addHook("onClose", async () => broker.close());
  return broker;
}
