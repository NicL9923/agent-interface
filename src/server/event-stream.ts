import { createHash } from "node:crypto";
import type { FastifyReply } from "fastify";

/**
 * A short, stable name for some state a client read, such as one person's roster. A client opens a
 * stream with the name its read carried, and the stream sends a notice at once only if it differs.
 */
export const stateVersion = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 22);

/**
 * The version a client says its last read showed, from a stream's query parameter `name`: undefined
 * when it sent none, as older clients do, and "" for a value that cannot be a version, which then
 * matches nothing, so the stream sends its notice and the client reads.
 */
export function sinceParam(query: unknown, name: string): string | undefined {
  const value = (query as Record<string, unknown> | undefined)?.[name];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= 200 ? value : "";
}

/** An open server-sent event stream. */
/** send reports whether the text was written: false once the stream ended or the viewer lost access. */
export type EventStream = { send: (text: string) => boolean; end: () => void };

/**
 * Follows an event stream request's connection from the start of its handler, so setup that
 * awaits can tell when the client left meanwhile. Call it before the handler's first await, check
 * `closed` after each await, and reserve what teardown undoes only in `open`'s `reserve`.
 */
export function eventStreamConnection(reply: FastifyReply) {
  const response = reply.raw;
  let closed = response.destroyed || response.writableEnded;
  const left = () => { closed = true; };
  response.once("close", left);
  return {
    get closed() { return closed; },
    /** Ends a request whose client left during setup, sending nothing. */
    abandon() {
      response.off("close", left);
      reply.hijack();
      response.destroy();
    },
    /**
     * Runs `reserve`, which registers everything `teardown` undoes, then opens the stream. A client
     * that already left ends it at once. `teardown` runs once however this ends: when the stream
     * ends, or when reserving or opening throws, which rethrows, even if teardown itself threw.
     */
    open(streams: Set<() => void>, options: { allowed: () => boolean; teardown: () => void; reserve?: () => void }): EventStream {
      response.off("close", left);
      let torn = false;
      const teardown = () => {
        if (torn) return;
        torn = true;
        options.teardown();
      };
      try {
        options.reserve?.();
        return openEventStream(reply, streams, { allowed: options.allowed, teardown }, closed);
      } catch (error) {
        teardown();
        throw error;
      }
    },
  };
}

/**
 * Opens a server-sent event stream on a hijacked reply. Every send first checks `allowed`
 * and ends the stream instead once it fails. Ending runs `teardown` once, and `streams`
 * holds each open stream's end so shutdown can close them.
 */
function openEventStream(reply: FastifyReply, streams: Set<() => void>,
  options: { allowed: () => boolean; teardown: () => void }, closed: boolean): EventStream {
  reply.hijack();
  const response = reply.raw;
  let ended = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const send = (text: string) => {
    if (!options.allowed()) { end(); return false; }
    if (ended) return false;
    response.write(text);
    return true;
  };
  function end() {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    streams.delete(end);
    try { options.teardown(); } finally { response.end(); }
  }
  // The close event already fired for a client that left during setup.
  if (closed || response.destroyed) {
    end();
    return { send, end };
  }
  // A hijacked reply writes its own headers, so the hooks' security headers are copied over.
  response.writeHead(200, {
    ...reply.getHeaders() as Record<string, string | number | string[]>,
    "Content-Type": "text/event-stream; charset=utf-8",
    // Caddy's encode handler would hold notices in its compressor; it skips an encoded body.
    "Content-Encoding": "identity",
    "X-Accel-Buffering": "no",
    // An ended stream's connection is never reused, so shutdown need not wait for it.
    "Connection": "close",
  });
  // Pings keep proxies from closing a quiet stream and let the client notice a dead one.
  heartbeat = setInterval(() => send("event: ping\ndata: ping\n\n"), 25_000);
  streams.add(end);
  response.on("close", end);
  // Clients read on open, or name the version they read so the route sends a notice only if it changed.
  response.write("retry: 3000\n\n");
  return { send, end };
}
