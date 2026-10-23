import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ErrorCode } from "../shared/errors.js";
import { RepeatFilter, safeError } from "./logging.js";

export interface HttpErrorOptions {
  code?: ErrorCode;
  /** A 5xx whose fixed message tells the person what to do next. */
  expose?: boolean;
  confirmRequired?: boolean;
}
export type HttpError = Error & HttpErrorOptions & { statusCode: number };

/** An error whose status and message the error handler sends as the response. */
export function httpError(statusCode: number, message: string, options: HttpErrorOptions = {}): HttpError {
  return Object.assign(new Error(message), { statusCode, ...options });
}

/** The app's error responses. Tests install this same handler, so they see production's status and body. */
export function errorHandler(options: { production?: boolean } = {}) {
  const serverErrors = new RepeatFilter();
  return (error: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "Invalid request",
        details: error.issues.map((x) => ({
          path: x.path,
          message: x.message,
        })),
      });
    const err = error as Error & Partial<HttpError> & { code?: string };
    const status = err.statusCode ?? 502;
    if (status >= 500) {
      const route = `${req.method} ${req.routeOptions.url ?? "unmatched"}`;
      const repeats = serverErrors.hit(`${route} ${status} ${err.message}`);
      if (repeats === 0) req.log.error({ error: safeError(err), route, status }, "Request failed");
      else if (repeats !== undefined) req.log.error({ route, status, error: err.message, repeats }, "Request failure repeated");
    }
    // A stream can fail after a route set file headers; the error is always JSON.
    reply.removeHeader("Content-Disposition");
    reply.removeHeader("Content-Length");
    reply.type("application/json; charset=utf-8");
    return reply.code(status).send({
      error:
        err.statusCode && (err.statusCode < 500 || err.expose)
          ? err.message
          : "The Hermes operation could not be completed",
      detail: options.production ? undefined : err.message,
      code: err.code,
      confirmRequired: err.confirmRequired,
    });
  };
}
