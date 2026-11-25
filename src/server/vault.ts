import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import type { Runtime } from "../shared/types.js";
import type {
  ProfileVault,
  SecureRequest,
  SecureRequestAnswer,
  VaultRequest,
} from "../shared/vault.js";
import { httpError } from "./http-error.js";
const source = z.enum(["onepassword", "bitwarden"]);
const method = z.enum(["vault.save_login", "vault.code", "vault.unlock_prompt", "secret"]);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const text = z.string().min(1).max(20000);
const owner = { epoch: id, sessionId: id };
const answer = z.union([
  z.object({ ...owner, method, cancel: z.literal(true) }).strict(),
  z
    .object({
      ...owner,
      method: z.literal("vault.save_login"),
      identifier: z.string().trim().min(1).max(1000),
      password: text,
      origin: z.string().min(1).max(2048).optional(),
    })
    .strict(),
  z
    .object({
      ...owner,
      method: z.enum(["vault.code", "vault.unlock_prompt", "secret"]),
      value: text,
    })
    .strict(),
]);
const login = z
  .object({
    label: z.string().trim().min(1).max(200),
    origin: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.pathname === "/" || !url.pathname)
        );
      }),
    identifierType: z.enum(["email", "phone", "username"]),
    identifier: z.string().trim().min(1).max(1000),
    password: text,
    otpSecret: z.string().max(4000).optional(),
  })
  .strict();
export async function installVaultRoutes(app: FastifyInstance, runtime: Runtime) {
  const busy = new Set<string>();
  async function request(userId: string, input: VaultRequest) {
    if (!(await runtime.listBots()).some((bot) => bot.id === input.profile))
      throw httpError(404, "Assistant not found");
    if (!runtime.vaultRequest)
      throw httpError(409, "The installed Hermes integration does not support secure credentials.");
    const key = userId + ":" + input.profile;
    if (input.operation !== "overview" && busy.has(key))
      throw httpError(429, "A credential operation is already running. Wait for it to finish.");
    if (input.operation !== "overview") busy.add(key);
    try {
      return await runtime.vaultRequest(input);
    } catch (error) {
      // Secret-bearing operations never forward exception text, even in development.
      const { statusCode: status, code } = error as { statusCode?: number; code?: string };
      // This fixed explanation carries no secret; Hermes's own 401 and 403 never reach clients.
      if (code === "hermes_unauthorized") throw error;
      throw httpError(
        status && [400, 404, 409, 429].includes(status) ? status : 502,
        status === 409
          ? "This credential request changed or is unavailable. Refresh and review it before continuing."
          : "Hermes could not confirm this credential operation. Refresh its status before trying again.",
      );
    } finally {
      if (input.operation !== "overview") busy.delete(key);
    }
  }
  const botId = (req: { params: unknown }) => z.object({ id }).passthrough().parse(req.params).id;
  apiRoute(
    app,
    "GET /bots/:id/vault",
    {},
    (req) =>
      request(signedIn(req).id, {
        operation: "overview",
        profile: botId(req),
      }) as Promise<ProfileVault>,
  );
  apiRoute(app, "POST /bots/:id/vault/logins", { body: login }, (req, body) =>
    request(signedIn(req).id, {
      operation: "add_login",
      profile: botId(req),
      login: body,
      actor: signedIn(req).id,
    }),
  );
  apiRoute(app, "DELETE /bots/:id/vault/logins/:itemId", {}, (req) => {
    const params = z.object({ id, itemId: id }).strict().parse(req.params);
    return request(signedIn(req).id, {
      operation: "remove_login",
      profile: params.id,
      itemId: params.itemId,
    });
  });
  apiRoute(
    app,
    "PUT /bots/:id/vault/sources/:source",
    { body: z.object({ enabled: z.boolean() }).strict() },
    (req, { enabled }) => {
      const params = z.object({ id, source }).strict().parse(req.params);
      return request(signedIn(req).id, {
        operation: "source",
        profile: params.id,
        source: params.source,
        enabled,
      });
    },
  );
  apiRoute(
    app,
    "POST /bots/:id/vault/sources/:source/unlock",
    { body: z.object({ password: text }).strict() },
    (req, { password }) => {
      const params = z.object({ id, source }).strict().parse(req.params);
      return request(signedIn(req).id, {
        operation: "unlock",
        profile: params.id,
        source: params.source,
        password,
      });
    },
  );
  apiRoute(
    app,
    "POST /bots/:id/vault/sources/:source/lock",
    { body: z.object({}).strict() },
    (req) => {
      const params = z.object({ id, source }).strict().parse(req.params);
      return request(signedIn(req).id, {
        operation: "lock",
        profile: params.id,
        source: params.source,
      });
    },
  );
  apiRoute(app, "POST /bots/:id/secure-requests/:requestId", { body: answer }, (req, body) => {
    const params = z.object({ id, requestId: id }).strict().parse(req.params);
    const payload = body as SecureRequestAnswer;
    // Hermes binds a login the assistant asked for by address to the member whose task asked.
    return request(signedIn(req).id, {
      operation: "answer",
      profile: params.id,
      requestId: params.requestId,
      answer: payload,
      actor: signedIn(req).id,
    }) as Promise<{ status: "ok" | "expired" }>;
  });
}
/** Names the member who owns each login requested by address, for its card. An unknown member stays unnamed. */
export function nameRequesters<T extends { secure?: SecureRequest }>(
  attention: T[] | undefined,
  name: (id: string) => string | undefined,
) {
  return attention?.map((item) => {
    const secure = item.secure;
    if (secure?.method !== "vault.save_login" || !secure.explicit?.requestedBy) return item;
    const id = secure.explicit.requestedBy.id,
      known = name(id);
    return {
      ...item,
      secure: {
        ...secure,
        explicit: { ...secure.explicit, requestedBy: { id, ...(known ? { name: known } : {}) } },
      },
    };
  });
}
