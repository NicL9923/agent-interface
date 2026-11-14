import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { RepeatFilter, type Log } from "./logging.js";

/** A request slower than this is logged, unless it is a stream, whose duration is its purpose. */
export const slowRequestMs = 1000;

// Requests the error handler already logged as a 5xx, so this hook never logs them a second time.
const loggedByErrorHandler = new WeakSet<FastifyRequest>();
// Requests that open an event stream: they stay open for as long as the viewer watches.
const streams = new WeakSet<FastifyRequest>();
export const errorHandlerLogged = (req: FastifyRequest) => { loggedByErrorHandler.add(req); };
/** Exempts a request from the slow log. WebSocket upgrades never reach onResponse, so only event streams need it. */
export const markStream = (req: FastifyRequest) => { streams.add(req); };

/**
 * Logs each response that failed (status 400 or above) or ran slow, with the route pattern and never
 * the URL, since a query string can carry a one-time ticket. Clients poll every 1.5 s, so a failure
 * that repeats, such as a signed-out tab, logs once and then reports its count every 10 minutes.
 */
export function installRequestLog(app: FastifyInstance, { slowMs = slowRequestMs }: { slowMs?: number } = {}) {
  const repeated = new RepeatFilter();
  app.addHook("onResponse", async (req, reply) => {
    const status = reply.statusCode;
    if (status >= 500 && loggedByErrorHandler.has(req)) return;
    const durationMs = Math.round(reply.elapsedTime);
    const slow = durationMs > slowMs && !streams.has(req);
    if (status < 400 && !slow) return;
    const route = req.routeOptions.url ?? "unmatched";
    const repeats = repeated.hit(`${req.method} ${route} ${status} ${slow ? "slow" : "fast"}`);
    if (repeats === undefined) return;
    req.log.warn({ method: req.method, route, status, durationMs, ...(repeats > 0 ? { repeats } : {}) },
      slow ? "Slow request" : "Request answered with an error status");
  });
}

/** What the monitor needs of a Node histogram, so a test can supply the one at the clock's edge. */
type Histogram = {
  enable(): unknown; disable(): unknown; reset(): void; percentile(percentile: number): number;
  readonly max: number; readonly count: number;
};

/**
 * Samples event-loop delay and warns, at most once a minute, when the last window's p99 passes 50 ms.
 * A stalled loop makes every request slow at once, so this names the cause the request log cannot.
 */
export class EventLoopMonitor {
  /** The p99 of the last window, in ms, once a window had samples. */
  lastP99Ms?: number;
  private warnedAt?: number;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private log: Pick<Log, "warn">, private options: { thresholdMs?: number; windowMs?: number; warnEveryMs?: number; histogram?: Histogram } = {}) {
    this.histogram = options.histogram ?? monitorEventLoopDelay({ resolution: 10 });
  }
  private histogram: Histogram;
  start() {
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), this.options.windowMs ?? 10_000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.histogram.disable();
  }
  /** Reads and resets the window. The timer calls it; tests call it with a chosen time. */
  sample(now = Date.now()) {
    if (this.histogram.count === 0) return;
    const p99Ms = Math.round(this.histogram.percentile(99) / 1e6), maxMs = Math.round(this.histogram.max / 1e6);
    this.histogram.reset();
    this.lastP99Ms = p99Ms;
    const thresholdMs = this.options.thresholdMs ?? 50;
    if (p99Ms <= thresholdMs) return;
    if (this.warnedAt !== undefined && now - this.warnedAt < (this.options.warnEveryMs ?? 60_000)) return;
    this.warnedAt = now;
    this.log.warn({ p99Ms, maxMs, thresholdMs }, "The event loop is stalling");
  }
}
