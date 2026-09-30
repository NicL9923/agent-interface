import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { allowedIdentity, loopback, type Config } from "./config.js";
import type { Store } from "./store.js";
import type { User } from "../shared/types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const callback = "agentinterface://auth/callback";
const state = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const verifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const startInput = z.object({ state, code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal("S256") }).strict();
type GoogleIdentity = { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string; nonce?: string };

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
    const local = config.localDevAuth && loopback(req.ip)
      ? '<button id="one">Sign in as local member one</button><button id="two">Sign in as local member two</button>' : "";
    return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Agent Interface</title>
<style nonce="${scriptNonce}">
body{font:17px system-ui;max-width:480px;margin:10vh auto;padding:24px;color:#18332a;background:#f6f8f4}
button{display:block;margin:20px 0;padding:12px}#error{color:#a12626}
</style></head><body>
<h1>Connect Agent Interface</h1><p>Choose the household account to use in the iOS app.</p>
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
    if (!flow) return reply.code(401).send({ error: "Sign-in expired. Start again in the app." });
    const body = z.union([z.object({ credential: z.string().min(1).max(20000) }).strict(), z.object({ member: z.enum(["one", "two"]) }).strict()]).parse(req.body);
    let user: User;
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
    }
    if (!allowedIdentity(config, user)) return reply.code(403).send({ error: "This account is not in the household allowlist" });
    store.user(user);
    const code = random();
    if (!store.finishNativeFlow(flowHash, hash(code), user.id)) return reply.code(401).send({ error: "Sign-in expired. Start again in the app." });
    reply.clearCookie("native_flow", { path: "/" });
    const url = new URL(callback); url.searchParams.set("code", code); url.searchParams.set("state", flow.state);
    return { callback: url.toString() };
  });
  app.post("/api/auth/native/exchange", async (req, reply) => {
    const body = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), state, codeVerifier: verifier }).strict().parse(req.body);
    const challenge = createHash("sha256").update(body.codeVerifier).digest("base64url");
    const userId = store.consumeNativeCode(hash(body.code), body.state, challenge);
    const user = userId ? store.getUser(userId) : undefined;
    if (!user || !allowedIdentity(config, user)) return reply.code(401).send({ error: "Connection code is invalid or expired" });
    const token = random(), expires = Date.now() + 7 * 86400000;
    store.nativeSession(hash(token), user.id, expires);
    return { token, expiresAt: new Date(expires).toISOString(), user };
  });
}
