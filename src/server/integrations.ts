import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Runtime } from "../shared/types.js";
import {
  connectionReady,
  requestableConnectionId,
  type ConnectionRequestResult,
  type IntegrationCatalog,
  type IntegrationConnection,
  type IntegrationFlow,
  type IntegrationRequest,
} from "../shared/integrations.js";
import { apiRoute } from "./api-route.js";
import { httpError } from "./http-error.js";
const profile = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const fields = z.record(z.string().max(100), z.string().max(20000));
const body = z.object({ profile, fields: fields.optional() }).strict();
export async function installIntegrationsRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  options: { origin: string; canManage: (req: FastifyRequest) => boolean },
) {
  const request = async (input: IntegrationRequest) => {
    if (!runtime.integrationRequest)
      throw httpError(409, "Integrations are unavailable on this runtime.");
    return runtime.integrationRequest(input);
  };
  const manage = (req: FastifyRequest) => {
    if (!options.canManage(req))
      throw httpError(
        403,
        "Only a household integration administrator can change shared connections.",
      );
  };
  apiRoute(app, "GET /integrations", {}, async (req) => ({
    ...((await request({
      operation: "list",
      profile: z.object({ profile }).parse(req.query).profile,
    })) as IntegrationCatalog),
    canManage: options.canManage(req),
  }));
  const idParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_:.-]{1,200}$/) });
  const integrationAction = async (
    operation: "check" | "connect" | "disconnect",
    req: FastifyRequest,
    input: z.output<typeof body>,
  ) => {
    if (operation !== "check") manage(req);
    const id = idParam.parse(req.params).id;
    return request({
      operation,
      id,
      ...input,
      redirectUri: `${options.origin}/integrations/google/callback`,
    });
  };
  apiRoute(
    app,
    "POST /integrations/:id/check",
    { body },
    async (req, input) =>
      integrationAction("check", req, input) as Promise<
        IntegrationConnection | IntegrationFlow | IntegrationCatalog | { ok: true }
      >,
  );
  apiRoute(
    app,
    "POST /integrations/:id/connect",
    { body },
    async (req, input) =>
      integrationAction("connect", req, input) as Promise<IntegrationFlow | IntegrationConnection>,
  );
  apiRoute(
    app,
    "POST /integrations/:id/disconnect",
    { body },
    async (req, input) =>
      integrationAction("disconnect", req, input) as Promise<
        IntegrationConnection | IntegrationFlow | { ok: true }
      >,
  );
  apiRoute(
    app,
    "POST /integrations/mcp",
    {
      before: async (req) => manage(req),
      body: z
        .object({
          profile,
          name: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
          url: z.string().url().max(2048),
          auth: z.enum(["none", "bearer", "oauth"]),
          token: z.string().min(1).max(20000).optional(),
        })
        .strict(),
    },
    async (_req, { profile: selected, ...mcp }) =>
      request({ operation: "add_mcp", profile: selected, mcp }) as Promise<
        IntegrationConnection | IntegrationFlow | IntegrationCatalog | { ok: true }
      >,
  );
  apiRoute(app, "GET /integrations/flows/:flowId", {}, async (req) => {
    manage(req);
    return request({
      operation: "flow",
      profile: z.object({ profile }).parse(req.query).profile,
      flowId: z.object({ flowId: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) }).parse(req.params)
        .flowId,
    }) as Promise<IntegrationFlow>;
  });
  apiRoute(app, "DELETE /integrations/flows/:flowId", {}, async (req) => {
    manage(req);
    return request({
      operation: "cancel",
      profile: z.object({ profile }).parse(req.query).profile,
      flowId: z.object({ flowId: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) }).parse(req.params)
        .flowId,
    }) as Promise<IntegrationFlow>;
  });
  apiRoute(
    app,
    "POST /integrations/flows/:flowId/callback",
    {
      before: async (req) => manage(req),
      body: z.object({ profile, callbackUrl: z.string().url().max(20000) }).strict(),
    },
    async (req, input) =>
      request({
        operation: "callback",
        ...input,
        flowId: z.object({ flowId: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) }).parse(req.params)
          .flowId,
      }) as Promise<IntegrationFlow>,
  );
  // Continue or Not now on an assistant's request to set up a connection. Bot access already
  // checked this person sees the assistant. Continue is refused until the catalog reads as set up.
  const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
  const settleBody = z
    .object({
      decision: z.enum(["connected", "decline"]),
      epoch: requestId,
      sessionId: requestId,
      connection: z.string().regex(requestableConnectionId),
    })
    .strict();
  apiRoute(
    app,
    "POST /bots/:id/connection-requests/:requestId",
    { body: settleBody },
    async (req, input): Promise<ConnectionRequestResult> => {
      const params = z.object({ id: profile, requestId }).strict().parse(req.params);
      if (!runtime.connectionRequest)
        throw httpError(409, "Connection requests are unavailable on this runtime.");
      if (input.decision === "connected") {
        const catalog = (await request({
          operation: "list",
          profile: params.id,
        })) as IntegrationCatalog;
        const item = catalog.connections?.find((connection) => connection.id === input.connection);
        if (!item)
          throw httpError(
            409,
            "This assistant doesn't have that connection. Choose Not now or tell the assistant in a message.",
          );
        if (!connectionReady(item))
          throw httpError(
            409,
            `${item.name} isn't set up yet. Finish connecting it, then press Continue.`,
          );
      }
      const result = await runtime.connectionRequest({
        ...input,
        profile: params.id,
        requestId: params.requestId,
      });
      if (result?.status !== "ok" && result?.status !== "expired")
        throw httpError(502, "WildBots returned an invalid answer for this connection request");
      return { status: result.status };
    },
  );
  // Google returns here without app authentication. Native state is single-use,
  // bound to profile and PKCE, and no user-supplied redirect is followed.
  app.get("/integrations/google/callback", async (req, reply) => {
    const query = z
      .object({
        state: z.string().min(20).max(200),
        code: z.string().max(10000).optional(),
        error: z.string().max(200).optional(),
        scope: z.string().max(10000).optional(),
      })
      .parse(req.query);
    await request({
      operation: "callback",
      profile: "default",
      callbackUrl: `${options.origin}/integrations/google/callback?${new URLSearchParams(query as Record<string, string>)}`,
    });
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
      .type("text/html")
      .send(
        "<!doctype html><title>Google connection</title><h1>Authorization received</h1><p>Return to WildBots to check your Google Workspace connection.</p>",
      );
  });
}
