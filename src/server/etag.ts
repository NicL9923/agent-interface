import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { isApiRequest, routePattern } from "./route-path.js";

// Polling clients revalidate JSON reads with If-None-Match, sent only for a body they hold
// for that exact path. Cache-Control stays no-store, so transcripts never enter HTTP caches.
// A route whose body carries a fresh timestamp sets its own ETag over the rest, via `contentEtag`.
export const contentEtag = (value: unknown) =>
  `W/"${createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 22)}"`;

const stripWeak = (tag: string) => tag.replace(/^W\//, "");

/**
 * RFC 9110 weak comparison over an If-None-Match header, handling comma-separated entity tags,
 * `*`, and weak/strong normalization by reverse proxies.
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const expected = stripWeak(etag.trim());
  for (const part of raw.split(",")) {
    const candidate = part.trim();
    if (!candidate) continue;
    if (candidate === "*" || stripWeak(candidate) === expected) return true;
  }
  return false;
}

export function installEtags(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET" || reply.statusCode !== 200 || typeof payload !== "string")
      return payload;
    if (
      !isApiRequest(req) ||
      routePattern(req).startsWith("/api/files/") ||
      req.headers.upgrade !== undefined
    )
      return payload;
    if (!String(reply.getHeader("content-type") ?? "").startsWith("application/json"))
      return payload;
    const etag = String(
      reply.getHeader("etag") ??
        `W/"${createHash("sha256").update(payload).digest("base64url").slice(0, 22)}"`,
    );
    reply.header("ETag", etag);
    if (!etagMatches(req.headers["if-none-match"], etag)) return payload;
    reply.code(304);
    return "";
  });
}
