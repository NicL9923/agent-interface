import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { z } from "zod";
import { routeParts, type ApiBody, type ApiParams, type ApiResponse, type ApiRoute } from "../shared/api.js";

export type ApiRequest<K extends ApiRoute> = FastifyRequest<{ Params: ApiParams<K> }>;
type Keys<T> = T extends unknown ? keyof T : never;
/** Each type is assignable to the other and they name the same top-level fields. */
type Same<A, B> = [A] extends [B] ? [B] extends [A]
  ? [Exclude<Keys<A>, Keys<B>> | Exclude<Keys<B>, Keys<A>>] extends [never] ? true : false : false : false;
/** A schema whose input is the body the shared route map says clients send. */
type BodySchema<K extends ApiRoute, S extends z.ZodType> = Same<ApiBody<K>, z.input<S>> extends true ? S : never;
type Handler<K extends ApiRoute, Body> =
  // A handler that answers through reply, such as an error with a body, returns the reply.
  (req: ApiRequest<K>, body: Body, reply: FastifyReply) => Promise<ApiResponse<K> | FastifyReply>;
type Spec<K extends ApiRoute, S extends z.ZodType> = RouteShorthandOptions & {
  /** Runs before the body is parsed, so an unavailable capability answers before a malformed body. */
  before?: (req: ApiRequest<K>) => Promise<void>;
} & (ApiBody<K> extends undefined ? { body?: undefined } : { body: S & BodySchema<K, S> });

/**
 * Registers a route from the shared map at /api. The handler's return is checked against the
 * route's response, and a route with a body parses it with a schema that matches the map.
 */
export function apiRoute<K extends ApiRoute, S extends z.ZodType = z.ZodUndefined>(
  app: FastifyInstance, route: K, spec: Spec<K, S>, handler: Handler<K, z.output<S>>,
) {
  const { body: schema, before, ...options } = spec;
  const { method, path } = routeParts(route);
  app.route({
    ...options, method, url: `/api${path}`,
    handler: async (req, reply) => {
      await before?.(req as ApiRequest<K>);
      // Without a schema S stays ZodUndefined, so the handler's body is undefined.
      return handler(req as ApiRequest<K>, (schema ? schema.parse(req.body) : undefined) as z.output<S>, reply);
    },
  });
}
