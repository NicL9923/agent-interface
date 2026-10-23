import { routeParts, routeUrl, type ApiParams, type ApiQuery, type ApiRoute } from "../../src/shared/api";

type Mocked = { api?: unknown; write?: unknown };
type Call = (...args: unknown[]) => unknown;
type Options = { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal };

/**
 * Adds a request() to a mocked client-api module. It calls the module's api and write with the
 * URL, method and body the real request() builds, so mocks keyed by path and assertions on those
 * calls see the mapped routes too. A route without a body is written with `{}`.
 */
export function withRequest<M extends Mocked>(mocked: M) {
  return {
    ...mocked,
    request(route: ApiRoute, options: Options = {}) {
      const { method } = routeParts(route);
      const url = routeUrl(route, (options.params ?? {}) as ApiParams<ApiRoute>, options.query as ApiQuery<ApiRoute>);
      if (method === "GET") return options.signal ? (mocked.api as Call)(url, { signal: options.signal }) : (mocked.api as Call)(url);
      const body = options.body ?? {};
      return method === "POST" ? (mocked.write as Call)(url, body) : (mocked.write as Call)(url, body, method);
    },
  };
}
