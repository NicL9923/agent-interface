import { routeParts, routeUrl, type ApiParams, type ApiQuery, type ApiRoute } from "../../src/shared/api";

type Mocked = { api?: unknown; write?: unknown };
type Call = (...args: unknown[]) => unknown;
type Options = { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal };

/** The app's own background reports, which each have a test file of their own. */
const HEARTBEATS: ReadonlySet<ApiRoute> = new Set<ApiRoute>(["PUT /bots/:id/presence", "PUT /devices/activity"]);
const heartbeatLog: { url: string; body: unknown }[] = [];
/** The reports `heartbeats: false` kept away from `write`, oldest first, emptied by this call. */
export function takeHeartbeats() { return heartbeatLog.splice(0); }

/**
 * Adds a request() to a mocked client-api module. It calls the module's api and write with the
 * URL, method and body the real request() builds, so mocks keyed by path and assertions on those
 * calls see the mapped routes too. A route without a body is written with `{}`.
 *
 * `heartbeats: false` answers the chat presence and device activity reports with `{}` without
 * calling `write`, so the real hooks run while the writes a test counts stay its own. A test that
 * wants them reads `takeHeartbeats()`; the tests of the hooks themselves read them through the default.
 */
export function withRequest<M extends Mocked>(mocked: M, { heartbeats = true }: { heartbeats?: boolean } = {}) {
  return {
    ...mocked,
    request(route: ApiRoute, options: Options = {}) {
      const { method } = routeParts(route);
      const url = routeUrl(route, (options.params ?? {}) as ApiParams<ApiRoute>, options.query as ApiQuery<ApiRoute>);
      if (!heartbeats && HEARTBEATS.has(route)) { heartbeatLog.push({ url, body: options.body }); return Promise.resolve({}); }
      if (method === "GET") return options.signal ? (mocked.api as Call)(url, { signal: options.signal }) : (mocked.api as Call)(url);
      const body = options.body ?? {};
      return method === "POST" ? (mocked.write as Call)(url, body) : (mocked.write as Call)(url, body, method);
    },
  };
}
