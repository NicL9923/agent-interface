import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CLIENT_ERROR_LIMITS, withoutUrlQueries } from "../shared/api.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { httpError } from "./http-error.js";

/** Reports one person may send in `CLIENT_ERROR_WINDOW_MS`, across tabs and devices. */
export const CLIENT_ERRORS_PER_WINDOW = 20;
export const CLIENT_ERROR_WINDOW_MS = 10 * 60_000;

const report = z.object({
  kind: z.enum(["render", "error", "rejection"]),
  // The client strips URL queries too; doing it again here keeps an older or altered client's from the log.
  message: z.string().min(1).max(CLIENT_ERROR_LIMITS.message).transform(withoutUrlQueries),
  stack: z.string().max(CLIENT_ERROR_LIMITS.stack).transform(withoutUrlQueries).optional(),
  // A path only: a query string or hash can carry a search, a room or a sign-in code.
  route: z.string().max(CLIENT_ERROR_LIMITS.route).regex(/^\/[^?#]*$/),
  release: z.string().max(CLIENT_ERROR_LIMITS.release).regex(/^[\w.-]+$/).optional(),
}).strict();

/**
 * Logs web client crashes, so a render failure on a phone reaches the operator instead of being a
 * white screen nobody hears about. Nothing is stored. Each person may send a bounded number per
 * window, counted in memory; a restart forgets the counts.
 */
export function installClientErrorRoutes(app: FastifyInstance, now = () => Date.now()) {
  const sent = new Map<string, number[]>();
  apiRoute(app, "POST /client-errors", { body: report, bodyLimit: 16 * 1024 }, async (req, value) => {
    const userId = signedIn(req).id, at = now();
    const recent = (sent.get(userId) ?? []).filter(time => at - time < CLIENT_ERROR_WINDOW_MS);
    if (recent.length >= CLIENT_ERRORS_PER_WINDOW) {
      sent.set(userId, recent);
      throw httpError(429, "Too many error reports. Try again later.");
    }
    recent.push(at);
    sent.set(userId, recent);
    req.log.warn({ clientError: value, userId }, "Client error");
    return { ok: true };
  });
}
