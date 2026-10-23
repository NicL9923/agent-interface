import type { FastifyReply } from "fastify";

/**
 * Opens a server-sent event stream on a hijacked reply. Every send first checks `allowed`
 * and ends the stream instead once it fails. Ending runs `teardown` once, and `streams`
 * holds each open stream's end so shutdown can close them.
 */
export function openEventStream(reply: FastifyReply, streams: Set<() => void>,
  options: { allowed: () => boolean; teardown: () => void }) {
  reply.hijack();
  const response = reply.raw;
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
  let ended = false;
  const send = (text: string) => {
    if (!options.allowed()) end();
    else if (!ended) response.write(text);
  };
  // Pings keep proxies from closing a quiet stream and let the client notice a dead one.
  const heartbeat = setInterval(() => send("event: ping\ndata: ping\n\n"), 25_000);
  function end() {
    if (ended) return;
    ended = true;
    options.teardown();
    clearInterval(heartbeat);
    streams.delete(end);
    response.end();
  }
  streams.add(end);
  response.on("close", end);
  // Clients refetch on open; an initial notice would duplicate that read.
  response.write("retry: 3000\n\n");
  return { send, end };
}
