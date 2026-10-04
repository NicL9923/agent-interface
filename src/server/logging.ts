import { LogController, type FastifyBaseLogger } from "fastify";
import type { LogLevel } from "./config.js";

export type Log = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
export const quietLog: Log = { info() {}, warn() {}, error() {} };
const reminderInterval = 10 * 60_000;

// Clients poll every 1.5 s, so per-request logs would flood journald. Query strings can
// carry one-time tickets, so a logged request keeps only its method and path.
export function loggerOptions(level: LogLevel, stream?: { write(line: string): void }) {
  return {
    logger: {
      level,
      ...(stream ? { stream } : {}),
      redact: ["ticket", "*.ticket", "headers.authorization", "headers.cookie", 'headers["x-csrf-token"]',
        "req.headers.authorization", "req.headers.cookie", 'req.headers["x-csrf-token"]'],
      serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split("?")[0] }) },
    },
    logController: new LogController({ disableRequestLogging: true }),
  };
}

/** Logs only fields this app sets. Upstream errors can carry raw Hermes text in other properties or causes. */
export function safeError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error).slice(0, 300) };
  const { statusCode, code } = error as Error & { statusCode?: unknown; code?: unknown };
  return {
    type: error.name,
    message: error.message.slice(0, 300),
    ...(typeof statusCode === "number" ? { statusCode } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    stack: error.stack?.split("\n").slice(1, 9).map(line => line.trim()).join("\n"),
  };
}

/** Lets a repeated failure log once, then report its count at most every 10 minutes. */
export class RepeatFilter {
  private seen = new Map<string, { loggedAt: number; repeats: number }>();
  /** Returns the repeats to report when this occurrence should be logged, otherwise undefined. */
  hit(key: string, now = Date.now()): number | undefined {
    const entry = this.seen.get(key);
    if (!entry) {
      if (this.seen.size >= 500) this.seen.clear();
      this.seen.set(key, { loggedAt: now, repeats: 0 });
      return 0;
    }
    entry.repeats++;
    if (now - entry.loggedAt < reminderInterval) return undefined;
    const repeats = entry.repeats;
    Object.assign(entry, { loggedAt: now, repeats: 0 });
    return repeats;
  }
}

/** One recurring operation: logs its first failure, a reminder every 10 minutes and its recovery. */
export class FailureTracker {
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
  failingSince?: number;
  consecutiveFailures = 0;
  private remindedAt = 0;
  constructor(private log: Log, private name: string) {}
  failure(error: unknown, now = Date.now()) {
    this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    this.lastFailureAt = now;
    this.consecutiveFailures++;
    const context = { operation: this.name, error: this.lastError, failures: this.consecutiveFailures };
    if (this.failingSince === undefined) {
      this.failingSince = this.remindedAt = now;
      this.log.warn(context, `${this.name} failed`);
    } else if (now - this.remindedAt >= reminderInterval) {
      this.remindedAt = now;
      this.log.warn({ ...context, failingForMs: now - this.failingSince }, `${this.name} is still failing`);
    }
  }
  success(now = Date.now()) {
    this.lastSuccessAt = now;
    if (this.failingSince === undefined) return;
    this.log.info({ operation: this.name, failures: this.consecutiveFailures, failedForMs: now - this.failingSince }, `${this.name} recovered`);
    this.failingSince = undefined;
    this.consecutiveFailures = 0;
  }
}
