import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { allowedIdentity, loopback, type Config } from "./config.js";
import type { Store } from "./store.js";
import type { User } from "../shared/types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const callback = "agentinterface://auth/callback";
/** How long a native sign-in lasts without use. The app renews it while it is in use. */
export const NATIVE_SESSION_MS = 7 * 86400000;
/** Renewal never extends a session past this long after its Google sign-in. */
export const NATIVE_SIGN_IN_LIMIT_MS = 90 * 86400000;
const state = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const verifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
// purpose=confirm only changes the page's words: the app asks a signed-in person to prove it's them.
const startInput = z.object({ state, code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal("S256"),
  purpose: z.literal("confirm").optional() }).strict();
const codeInput = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), state, codeVerifier: verifier }).strict();
/** How recent the identity proof behind a confirmation code must be, as for the web's confirmation. */
const confirmationAge = 10 * 60000;
type GoogleIdentity = { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string; nonce?: string; iat?: number };

export async function installNativeAuth(app: FastifyInstance, store: Store, config: Config, verify: (credential: string) => Promise<GoogleIdentity | undefined>) {
  app.get("/native/sign-in", async (req, reply) => {
    const input = startInput.parse(req.query);
    const flow = random(), nonce = random(), scriptNonce = random();
    store.nativeFlow(hash(flow), input.state, input.code_challenge, nonce, Date.now() + 300000);
    reply.setCookie("native_flow", flow, { httpOnly: true, secure: new URL(config.origin).protocol === "https:", sameSite: "strict", path: "/", maxAge: 300 });
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "strict-origin")
      .header("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${scriptNonce}' https://accounts.google.com/gsi/client; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; style-src 'nonce-${scriptNonce}' https://accounts.google.com/gsi/style; img-src https://*.googleusercontent.com https://accounts.google.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
      .type("text/html; charset=utf-8");
    // Only JSON-encoded configuration enters script; never interpolate household or request text into HTML.
    const settings = JSON.stringify({ clientId: config.googleClientId, nonce }).replace(/</g, "\\u003c");
    const confirming = input.purpose === "confirm";
    const local = config.localDevAuth && loopback(req.ip)
      ? '<button id="one">Sign in as local member one</button><button id="two">Sign in as local member two</button>' : "";
    return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${confirming ? "Confirm it's you" : "Sign in to WildBots"}</title>
<style nonce="${scriptNonce}">
body{font:1.0625rem system-ui;max-width:480px;margin:10vh auto;padding:24px;color:#18332a;background:#f6f8f4}
button{display:block;margin:20px 0;padding:12px}#error{color:#a12626}
</style></head><body>
${confirming ? "<h1>Confirm it's you</h1><p>Choose the same household account to open the terminal.</p>"
  : "<h1>Connect WildBots</h1><p>Choose the household account to use in the iOS app.</p>"}
<div id="google"></div>${local}<p id="error" role="alert"></p>
${config.googleClientId ? `<script nonce="${scriptNonce}" id="google-script" src="https://accounts.google.com/gsi/client" defer></script>` : ""}
<script nonce="${scriptNonce}">
const settings = ${settings};
async function complete(body) {
  try {
    const response = await fetch('/api/auth/native/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign-in failed');
    location.href = result.callback;
  } catch (error) {
    document.getElementById('error').textContent = error.message;
  }
}
for (const member of ['one', 'two']) {
  const button = document.getElementById(member);
  if (button) button.onclick = () => complete({ member });
}
window.googleLoaded = () => {
  google.accounts.id.initialize({
    client_id: settings.clientId, nonce: settings.nonce,
    callback: result => complete({ credential: result.credential }), auto_select: false
  });
  google.accounts.id.renderButton(document.getElementById('google'), { theme: 'outline', size: 'large' });
};
const googleScript = document.getElementById('google-script');
if (googleScript) {
  const failed = () => {
    document.getElementById('error').textContent = 'Google sign-in could not load. Close this window and retry from the app.';
  };
  const timeout = setTimeout(failed, 15000);
  googleScript.addEventListener('load', () => {
    clearTimeout(timeout);
    try { window.googleLoaded(); } catch { failed(); }
  });
  googleScript.addEventListener('error', () => { clearTimeout(timeout); failed(); });
}
if (!settings.clientId && !document.getElementById('one')) {
  document.getElementById('error').textContent = 'Google sign-in is not configured.';
}
</script></body></html>`;
  });
  app.post("/api/auth/native/complete", async (req, reply) => {
    const flowCookie = req.cookies.native_flow;
    const flowHash = typeof flowCookie === "string" ? hash(flowCookie) : "";
    const flow = flowCookie ? store.getNativeFlow(flowHash) : undefined;
    if (!flow) return reply.code(401).send({ error: "Sign-in expired. Start again in the app.", code: "session_expired" });
    const body = z.union([z.object({ credential: z.string().min(1).max(20000) }).strict(), z.object({ member: z.enum(["one", "two"]) }).strict()]).parse(req.body);
    // When the person proved who they are, for the terminal's step-up. Google's issue time, as on the web.
    let user: User, confirmedAt: number | undefined = Date.now();
    if ("member" in body) {
      if (!config.localDevAuth || !loopback(req.ip)) return reply.code(403).send({ error: "Local development sign-in is disabled" });
      user = { id: `local-${body.member}`, email: `${body.member}@localhost.invalid`, name: body.member === "one" ? "Local member one" : "Local member two" };
    } else {
      if (!config.googleClientId) return reply.code(503).send({ error: "Google sign-in is not configured" });
      let payload: GoogleIdentity | undefined;
      try { payload = await verify(body.credential); } catch { return reply.code(401).send({ error: "Google sign-in could not be verified" }); }
      if (!payload?.sub || !payload.email || payload.email_verified !== true || payload.nonce !== flow.nonce)
        return reply.code(401).send({ error: "Google sign-in could not be verified for this connection" });
      user = { id: payload.sub, email: payload.email.toLowerCase(), name: payload.name ?? "Household member", picture: payload.picture };
      confirmedAt = payload.iat ? Math.min(payload.iat * 1000, Date.now()) : undefined;
    }
    if (!allowedIdentity(config, user)) return reply.code(403).send({ error: "This account is not in the household allowlist" });
    store.user(user);
    const code = random();
    if (!store.finishNativeFlow(flowHash, hash(code), user.id, confirmedAt)) return reply.code(401).send({ error: "Sign-in expired. Start again in the app.", code: "session_expired" });
    reply.clearCookie("native_flow", { path: "/" });
    const url = new URL(callback); url.searchParams.set("code", code); url.searchParams.set("state", flow.state);
    return { callback: url.toString() };
  });
  const consume = (body: z.infer<typeof codeInput>) =>
    store.consumeNativeCode(hash(body.code), body.state, createHash("sha256").update(body.codeVerifier).digest("base64url"));
  app.post("/api/auth/native/exchange", async (req, reply) => {
    const code = consume(codeInput.parse(req.body));
    const user = code ? store.getUser(code.userId) : undefined;
    if (!user || !allowedIdentity(config, user)) return reply.code(401).send({ error: "Connection code is invalid or expired", code: "session_expired" });
    const token = random(), expires = Date.now() + NATIVE_SESSION_MS;
    store.nativeSession(hash(token), user.id, expires);
    // Signing in counts as confirming it's you, as it does on the web.
    if (code!.confirmedAt !== undefined) store.confirmNativeSession(hash(token), code!.confirmedAt);
    return { token, expiresAt: new Date(expires).toISOString(), user };
  });
  // A signed-in app proves it's still the same person before opening the terminal, with a code from
  // /native/sign-in?purpose=confirm. Its failures never say session_expired: the session itself is
  // fine, and that code signs the app out.
  app.post("/api/auth/native/confirm", async (req, reply) => {
    if (!req.nativeSessionHash) return reply.code(403).send({ error: "Confirm your identity in the iOS app." });
    const code = consume(codeInput.parse(req.body));
    if (!code) return reply.code(401).send({ error: "That confirmation expired. Try again.", code: "confirmation_expired" });
    if (code.userId !== req.user?.id) return reply.code(403).send({ error: "Use the same Google account you signed in with." });
    if (code.confirmedAt === undefined || Date.now() - code.confirmedAt > confirmationAge)
      return reply.code(401).send({ error: "That confirmation is too old. Try again.", code: "confirmation_expired" });
    store.confirmNativeSession(req.nativeSessionHash, code.confirmedAt);
    return { confirmedAt: new Date(code.confirmedAt).toISOString() };
  });
  // The same token lasts longer, rather than a new one, so a lost response can never sign the app
  // out and the device's push registrations, which belong to the session, stay in place.
  app.post("/api/auth/native/renew", async (req, reply) => {
    const expires = req.nativeSessionHash
      ? store.renewNativeSession(req.nativeSessionHash, NATIVE_SESSION_MS, NATIVE_SIGN_IN_LIMIT_MS) : undefined;
    if (!expires) return reply.code(401).send({ error: "Sign in again to keep using this server.", code: "session_expired" });
    return { expiresAt: new Date(expires).toISOString() };
  });
}
