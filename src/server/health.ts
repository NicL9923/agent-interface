import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { allowedIdentity, type Config } from "./config.js";
import type { Store } from "./store.js";
import type { BackgroundWorker } from "./notifications.js";
import type { Runtime } from "../shared/types.js";
import { quietLog, type Log } from "./logging.js";

export type CheckStatus = "ok" | "warn" | "fail" | "unconfigured";
export interface Check { status: CheckStatus; detail: string }
type Name = "database" | "hermes" | "worker" | "push" | "backup";
export type Readiness = { ok: boolean; checks: Record<Name, Check> };
// Completed copies written by .agents/tools/backup-app.mjs; never its .partial files.
export const backupName = /^agent-interface-\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-f0-9-]{36}\.sqlite$/;
const minute = 60_000, hour = 60 * minute;
// Only these make the app unready. Push and backup problems alert but never fail readiness.
const required: Name[] = ["database", "hermes", "worker"];
const labels: Record<Name, string> = {
  database: "The app database", hermes: "The Hermes connection", worker: "The background worker",
  push: "Push delivery", backup: "App backups",
};
const ago = (ms: number) => ms < 2 * minute ? `${Math.round(ms / 1000)} s` : ms < 2 * hour ? `${Math.round(ms / minute)} min` : `${Math.round(ms / hour)} h`;
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export class HealthMonitor {
  private hermesDownSince?: number;
  private incidents = new Map<Name, { since: number; alerted: boolean }>();
  private pending?: Promise<Readiness>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private deps: {
    store: Store; runtime: Runtime; worker: BackgroundWorker; config: Config;
    maintenance: () => boolean; log?: Log;
  }) {}
  start() {
    this.timer = setInterval(() => void this.evaluate(), minute);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  /** Concurrent callers share one evaluation, so public probes cannot multiply Hermes checks. */
  evaluate(now = Date.now()): Promise<Readiness> {
    this.pending ??= this.run(now).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async run(now: number): Promise<Readiness> {
    const settle = (check: () => Check | Promise<Check>) =>
      Promise.resolve().then(check).catch((error): Check => ({ status: "fail", detail: reason(error) }));
    const [database, hermes, worker, push, backup] = await Promise.all([
      settle(() => this.database()), settle(() => this.hermes(now)), settle(() => this.worker(now)),
      settle(() => this.push(now)), settle(() => this.backup(now)),
    ]);
    const checks = { database, hermes, worker, push, backup };
    this.track(checks, now);
    return { ok: required.every(name => checks[name].status !== "fail"), checks };
  }
  private database(): Check {
    this.deps.store.db.prepare("SELECT 1").get();
    return { status: "ok", detail: "Responding" };
  }
  private async hermes(now: number): Promise<Check> {
    if (this.deps.maintenance()) {
      this.hermesDownSince = undefined;
      return { status: "ok", detail: "A Hermes update is in progress" };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([
      this.deps.runtime.status(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The status check timed out")), 5000); }),
    ]).catch(error => ({ connected: false, detail: reason(error) })).finally(() => clearTimeout(timer));
    if (status.connected) {
      this.hermesDownSince = undefined;
      return { status: "ok", detail: "Connected" };
    }
    const down = now - (this.hermesDownSince ??= now);
    // Gateway restarts and deploy drains reconnect within a few minutes.
    return { status: down < 5 * minute ? "warn" : "fail", detail: `Disconnected for ${ago(down)}: ${status.detail ?? "no detail"}` };
  }
  private worker(now: number): Check {
    const { loop, createdAt } = this.deps.worker;
    const last = loop.lastSuccessAt;
    if (last !== undefined && now - last < 2 * minute) return { status: "ok", detail: `Last successful pass ${ago(now - last)} ago` };
    if (last === undefined && now - createdAt < 2 * minute) return { status: "ok", detail: "Starting" };
    const error = loop.lastError ? `: ${loop.lastError}` : "";
    return { status: "fail", detail: `No successful pass ${last === undefined ? "since start" : `for ${ago(now - last)}`}${error}` };
  }
  private push(now: number): Check {
    if (!this.deps.config.vapidPublicKey && !this.deps.config.apns) return { status: "unconfigured", detail: "Neither Web Push nor APNs is configured" };
    const { lastSuccessAt, lastFailureAt, lastError } = this.deps.worker.push;
    if (lastFailureAt !== undefined && lastFailureAt > (lastSuccessAt ?? 0) && now - lastFailureAt < 24 * hour)
      return { status: "warn", detail: `Last delivery failed ${ago(now - lastFailureAt)} ago: ${lastError}` };
    return { status: "ok", detail: lastSuccessAt === undefined ? "No deliveries since start" : `Last delivery ${ago(now - lastSuccessAt)} ago` };
  }
  private async backup(now: number): Promise<Check> {
    const directory = this.deps.config.backupDirectory;
    if (!directory) return { status: "unconfigured", detail: "APP_BACKUP_DIR is not set" };
    let newest = 0;
    try {
      for (const file of (await readdir(directory)).filter(name => backupName.test(name)))
        newest = Math.max(newest, (await stat(join(directory, file))).mtimeMs);
    } catch (error) {
      return { status: "warn", detail: `Cannot read the backup directory: ${(error as NodeJS.ErrnoException).code ?? reason(error)}` };
    }
    if (!newest) return { status: "warn", detail: "No completed backups" };
    return { status: now - newest < 36 * hour ? "ok" : "warn", detail: `Newest backup is ${ago(now - newest)} old` };
  }
  // Problems that last 10 minutes notify administrators once, and again when they clear.
  private track(checks: Record<Name, Check>, now: number) {
    const log = this.deps.log ?? quietLog;
    for (const name of Object.keys(checks) as Name[]) {
      const { status, detail } = checks[name];
      const incident = this.incidents.get(name);
      if (status !== "warn" && status !== "fail") {
        if (!incident) continue;
        this.incidents.delete(name);
        log.info({ check: name, since: incident.since }, "Readiness check recovered");
        if (incident.alerted) this.notify(`health:${name}:${incident.since}:recovered`, "WildBots recovered", `${labels[name]} is working again.`);
      } else if (!incident) {
        this.incidents.set(name, { since: now, alerted: false });
        log.warn({ check: name, status, detail }, "Readiness check degraded");
      } else if (!incident.alerted && now - incident.since >= 10 * minute) {
        incident.alerted = true;
        log.error({ check: name, status, detail, since: incident.since }, "Readiness check degraded for 10 minutes; alerting administrators");
        this.notify(`health:${name}:${incident.since}`, "WildBots needs attention", `${labels[name]} needs attention. ${detail}`);
      }
    }
  }
  private notify(eventId: string, title: string, body: string) {
    const { store, config, log = quietLog } = this.deps;
    const admins = new Set([...config.hermesUpgrade?.adminEmails ?? [], ...config.integrationAdmins ?? []]);
    try {
      const recipients = store.users().filter(user => admins.has(user.email.toLowerCase()) && allowedIdentity(config, user));
      if (!recipients.length) log.warn({ eventId }, "No signed-in administrator can receive health alerts");
      // kind "failed" skips digest batching.
      for (const user of recipients)
        store.queueNotification(eventId, user.id, { title, body: body.slice(0, 300), url: "/", tag: eventId, kind: "failed" });
    } catch (error) {
      log.error({ eventId, error: reason(error) }, "Could not queue a health alert");
    }
  }
}

// Proxied callers (Caddy adds X-Forwarded-For) see only the verdict; operators on the host see why.
const directLoopback = (req: FastifyRequest) =>
  !["x-forwarded-for", "forwarded", "x-real-ip"].some(header => req.headers[header] !== undefined) &&
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

export function installHealthRoutes(app: FastifyInstance, monitor: HealthMonitor) {
  app.get("/api/health/ready", async (req, reply) => {
    const { ok, checks } = await monitor.evaluate();
    reply.code(ok ? 200 : 503);
    return directLoopback(req) ? { ok, checks } : { ok };
  });
}
