import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Runtime } from "../shared/types.js";
import type { IntegrationRequest } from "../shared/integrations.js";
const profile = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const fields = z.record(z.string().max(100), z.string().max(20000));
const body = z.object({ profile, fields: fields.optional() }).strict();
const failure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
export async function installIntegrationsRoutes(app: FastifyInstance, runtime: Runtime, options: { origin: string; canManage: (req: FastifyRequest) => boolean }) {
  const request = async (input: IntegrationRequest) => {
    if (!runtime.integrationRequest) throw failure(409, "The installed Hermes add-on needs integration support. Ask the installer to update and qualify it.");
    return runtime.integrationRequest(input);
  };
  const manage = (req: FastifyRequest) => { if (!options.canManage(req)) throw failure(403, "Only a household integration administrator can change shared Hermes connections."); };
  app.get("/api/integrations", async req => ({ ...await request({ operation: "list", profile: z.object({ profile }).parse(req.query).profile }), canManage: options.canManage(req) }));
  for (const operation of ["check", "connect", "disconnect"] as const) {
    app.post(`/api/integrations/:id/${operation}`, async req => {
      if (operation !== "check") manage(req);
      const input = body.parse(req.body);
      const id = z.object({ id: z.string().regex(/^[A-Za-z0-9_:.-]{1,200}$/) }).parse(req.params).id;
      return request({ operation, id, ...input, redirectUri: `${options.origin}/integrations/google/callback` });
    });
  }
  app.post("/api/integrations/mcp", async req => {
    manage(req);
    const { profile: selected, ...mcp } = z.object({ profile, name: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), url: z.string().url().max(2048), auth: z.enum(["none", "bearer", "oauth"]), token: z.string().min(1).max(20000).optional() }).strict().parse(req.body);
    return request({ operation: "add_mcp", profile: selected, mcp });
  });
  app.get("/api/integrations/flows/:flowId", async req => {
    manage(req);
    return request({ operation: "flow", profile: z.object({ profile }).parse(req.query).profile, flowId: z.object({ flowId: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) }).parse(req.params).flowId });
  });
  app.delete("/api/integrations/flows/:flowId", async req => {
    manage(req);
    return request({ operation: "cancel", profile: z.object({ profile }).parse(req.query).profile, flowId: z.object({ flowId: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) }).parse(req.params).flowId });
  });
  app.post("/api/integrations/flows/:flowId/callback", async req => {
    manage(req);
    const input = z.object({ profile, callbackUrl: z.string().url().max(20000) }).strict().parse(req.body);
    return request({ operation: "callback", ...input, flowId: z.object({ flowId: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) }).parse(req.params).flowId });
  });
  // Google returns here without app authentication. Native state is single-use,
  // bound to profile and PKCE, and no user-supplied redirect is followed.
  app.get("/integrations/google/callback", async (req, reply) => {
    const query = z.object({ state: z.string().min(20).max(200), code: z.string().max(10000).optional(), error: z.string().max(200).optional(), scope: z.string().max(10000).optional() }).parse(req.query);
    await request({ operation: "callback", profile: "default", callbackUrl: `${options.origin}/integrations/google/callback?${new URLSearchParams(query as Record<string,string>)}` });
    return reply.header("Cache-Control", "no-store").header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'").type("text/html").send("<!doctype html><title>Google connection</title><h1>Authorization received</h1><p>Return to WildBots to check your Google Workspace connection.</p>");
  });
}
