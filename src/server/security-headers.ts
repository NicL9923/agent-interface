import type { FastifyInstance } from "fastify";

/** The policy for app pages and static files. The preview fixture serves the same one. */
export function contentSecurityPolicy(origin: string) {
  const url = new URL(origin);
  return [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    // xterm injects its own <style> elements at runtime.
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "media-src 'self' blob:",
    // Older Safari does not match WebSockets with 'self'.
    `connect-src 'self' ${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host} https://accounts.google.com/gsi/`,
    "frame-src https://accounts.google.com/gsi/",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "report-uri /api/csp-report",
  ].join("; ");
}
export const apiPolicy = "default-src 'none'; frame-ancestors 'none'";
export const permissionsPolicy = "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)";

const field = (value: unknown) =>
  typeof value === "string" && value ? value.replace(/[?#].*$/s, "").slice(0, 200) : undefined;
/** Reads report-uri (application/csp-report) and Reporting API (application/reports+json) bodies. */
export function cspViolations(body: unknown) {
  const reports: unknown[] = Array.isArray(body)
    ? body.filter(item => item?.type === "csp-violation").map(item => item.body)
    : [(body as { "csp-report"?: unknown } | null)?.["csp-report"]];
  return reports.filter((item): item is Record<string, unknown> => !!item && typeof item === "object").slice(0, 10)
    .map(item => ({
      directive: field(item.effectiveDirective ?? item["effective-directive"] ?? item["violated-directive"]),
      blocked: field(item.blockedURL ?? item["blocked-uri"]),
      document: field(item.documentURL ?? item["document-uri"]),
      source: field(item.sourceFile ?? item["source-file"]),
      line: Number(item.lineNumber ?? item["line-number"]) || undefined,
    }));
}

export function installSecurityHeaders(app: FastifyInstance, origin: string) {
  const documentPolicy = contentSecurityPolicy(origin), https = new URL(origin).protocol === "https:";
  app.addHook("onRequest", async (_req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "strict-origin-when-cross-origin")
      .header("Permissions-Policy", permissionsPolicy);
    if (https) reply.header("Strict-Transport-Security", "max-age=31536000");
  });
  app.addHook("onSend", async (req, reply, payload) => {
    // Native sign-in and the OAuth callback set their own nonce policies.
    if (reply.hasHeader("content-security-policy")) return payload;
    const path = req.url.split("?")[0];
    if (!path.startsWith("/api/")) reply.header("Content-Security-Policy", documentPolicy);
    else if (!path.startsWith("/api/files/") && String(reply.getHeader("content-type") ?? "").startsWith("application/json"))
      reply.header("Content-Security-Policy", apiPolicy);
    return payload;
  });
  app.addContentTypeParser(["application/csp-report", "application/reports+json"], { parseAs: "string" }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)); }
    catch { done(Object.assign(new Error("Invalid violation report"), { statusCode: 400 }), undefined); }
  });
  const seen = new Set<string>();
  let windowStart = 0, reports = 0;
  app.post("/api/csp-report", { bodyLimit: 16 * 1024 }, async (req, reply) => {
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); reports = 0; }
    if (++reports > 30) return reply.code(429).send({ error: "Too many reports" });
    for (const violation of cspViolations(req.body)) {
      const key = `${violation.directive}|${violation.blocked}|${violation.source}`;
      if (seen.has(key)) continue;
      if (seen.size >= 500) seen.clear();
      seen.add(key);
      req.log.warn({ csp: violation }, "Content Security Policy violation");
    }
    return reply.code(204).send();
  });
}
