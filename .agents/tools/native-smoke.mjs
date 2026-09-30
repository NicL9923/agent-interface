#!/usr/bin/env node
// Validate the native auth contract against a running, explicitly local instance.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:3004");
assert(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Use a loopback validation server");
assert(origin.href === `${origin.origin}/`, "Supply only the application origin");
let token;
async function request(path, { body, headers, method = body ? "POST" : "GET" } = {}) {
  const response = await fetch(new URL(path, origin), {
    method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error", signal: AbortSignal.timeout(20000),
  });
  return response;
}
async function json(path, options) {
  const response = await request(path, options);
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response.json();
}

try {
  const config = await json("/api/auth/config");
  assert.equal(config.nativeAuthVersion, 1);
  assert.equal(config.localDevAuth, true, "This probe needs explicit local test accounts");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const page = await request(`/native/sign-in?${query}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const cookie = page.headers.getSetCookie().find(value => value.startsWith("native_flow="))?.split(";")[0];
  assert(cookie, "Native handoff cookie missing");
  const completion = await json("/api/auth/native/complete", {
    body: { member: "one" }, headers: { Origin: origin.origin, Cookie: cookie },
  });
  const callback = new URL(completion.callback);
  assert.equal(callback.protocol, "agentinterface:");
  assert.equal(callback.host, "auth");
  assert.equal(callback.pathname, "/callback");
  assert.equal(callback.searchParams.get("state"), state);
  const exchange = { code: callback.searchParams.get("code"), state, codeVerifier: verifier };
  const session = await json("/api/auth/native/exchange", { body: exchange });
  token = session.token;
  assert.equal(session.user.id, "local-one");
  assert(Date.parse(session.expiresAt) > Date.now());
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await request("/api/auth/native/exchange", { body: exchange })).status, 401, "A used code must not exchange twice");
  const bootstrap = await json("/api/bootstrap", { headers });
  assert.equal(bootstrap.user.id, "local-one");
  assert.equal(bootstrap.csrfToken, null);
  assert.equal(bootstrap.connection.connected, true, "Connect the isolated Hermes runtime first");
  assert(bootstrap.bots.length > 0, "Need one canonical test bot");
  const conversation = await json(`/api/bots/${encodeURIComponent(bootstrap.bots[0].id)}/conversation`, { headers });
  assert.equal(conversation.botId, bootstrap.bots[0].id);
  assert(Array.isArray(conversation.messages));
  assert.equal((await request("/api/bootstrap", { headers: { ...headers, Origin: origin.origin } })).status, 403);
  await json("/api/auth/logout", { method: "POST", headers, body: {} });
  assert.equal((await request("/api/bootstrap", { headers })).status, 401);
  token = undefined;
  console.log(JSON.stringify({ nativeAuthVersion: 1, oneTimeHandoff: true, canonicalConversation: true,
    browserOriginRejected: true, logoutRevoked: true, hermesVersion: bootstrap.connection.version }));
} finally {
  if (token) await request("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: {} }).catch(() => {});
}
