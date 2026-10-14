import type { FastifyRequest } from "fastify";

// Gate requests by what Fastify routes, never by the raw URL. The router decodes
// percent-escapes, so "/%61pi/bots/x" reaches "/api/bots/:id" while its raw URL
// does not start with "/api/".
export function requestPath(req: FastifyRequest) {
  const raw = req.url.split("?")[0];
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// The matched route pattern, such as "/api/bots/:id", or the decoded path when no route matched.
export const routePattern = (req: FastifyRequest) => req.routeOptions.url ?? requestPath(req);

// A static wildcard can match an unknown API path, so either form marks the request as API.
export const isApiRequest = (req: FastifyRequest) =>
  routePattern(req).startsWith("/api/") || requestPath(req).startsWith("/api/");
