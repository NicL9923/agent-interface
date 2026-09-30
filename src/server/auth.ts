import { randomBytes, createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { allowedIdentity, loopback } from "./config.js";
import type { Store } from "./store.js";
import type { User } from "../shared/types.js";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    csrfToken: string | null;
  }
}
export async function installAuth(
  app: FastifyInstance,
  store: Store,
  config: Config,
  verify?: (credential: string) => Promise<{
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  }>,
) {
  const google = new OAuth2Client(config.googleClientId);
  app.decorateRequest("user", null);
  app.decorateRequest("csrfToken", null);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const cookie = req.cookies.session;
    if (cookie) {
      const session = store.getSession(hash(cookie));
      if (session) {
        const user = store.getUser(session.userId);
        const allowed = user && allowedIdentity(config, user);
        if (allowed) {
          req.user = user!;
          req.csrfToken = session.csrf;
        } else store.deleteSession(hash(cookie));
      }
    }
    const publicRoute = [
      "/api/auth/google",
      "/api/auth/local",
      "/api/auth/config",
      "/api/health",
    ].includes(req.url.split("?")[0]);
    if (!publicRoute && !req.user)
      return reply.code(401).send({ error: "Sign in required" });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.headers.origin !== config.origin)
        return reply
          .code(403)
          .send({ error: "Request origin must match this application" });
      if (!publicRoute && req.headers["x-csrf-token"] !== req.csrfToken)
        return reply.code(403).send({ error: "Invalid CSRF token" });
    }
  });
  const signIn = (user: User, reply: FastifyReply) => {
    store.user(user);
    const value = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    store.session(hash(value), user.id, csrf, Date.now() + 7 * 86400000);
    reply.setCookie("session", value, {
      httpOnly: true,
      secure: config.production || new URL(config.origin).protocol === "https:",
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 86400,
    });
    return { user, csrfToken: csrf };
  };
  app.get("/api/auth/config", async () => ({
    googleClientId: config.googleClientId,
    localDevAuth: config.localDevAuth,
  }));
  app.post("/api/auth/google", async (req, reply) => {
    if (!config.googleClientId)
      return reply
        .code(503)
        .send({ error: "Google sign-in is not configured" });
    const credential = (req.body as { credential?: unknown })?.credential;
    if (typeof credential !== "string")
      return reply.code(400).send({ error: "Missing Google credential" });
    try {
      const payload = verify
        ? await verify(credential)
        : (
            await google.verifyIdToken({
              idToken: credential,
              audience: config.googleClientId,
            })
          ).getPayload();
      if (
        !payload?.sub ||
        !payload.email ||
        payload.email_verified !== true ||
        !config.householdEmails.includes(payload.email.toLowerCase())
      )
        return reply
          .code(403)
          .send({ error: "This account is not in the household allowlist" });
      return signIn(
        {
          id: payload.sub,
          email: payload.email.toLowerCase(),
          name: payload.name ?? "Household member",
          picture: payload.picture,
        },
        reply,
      );
    } catch {
      return reply
        .code(401)
        .send({ error: "Google sign-in could not be verified" });
    }
  });
  app.post("/api/auth/local", async (req, reply) => {
    if (!config.localDevAuth || !loopback(req.ip))
      return reply
        .code(403)
        .send({ error: "Local development sign-in is disabled" });
    const member =
      (req.body as { member?: unknown })?.member === "two" ? "two" : "one";
    return signIn(
      {
        id: `local-${member}`,
        email: `${member}@localhost.invalid`,
        name: member === "one" ? "Local member one" : "Local member two",
      },
      reply,
    );
  });
  app.post("/api/auth/logout", async (req, reply) => {
    if (req.cookies.session) store.deleteSession(hash(req.cookies.session));
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
}
export function signedIn(req: FastifyRequest): User {
  if (!req.user) throw new Error("Authentication hook was not installed");
  return req.user;
}
