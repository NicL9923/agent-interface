import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import type { IntegrationRequest } from "../src/shared/integrations.js";
import { fakeRuntime, signIn } from "./helpers/server.js";

const origin = "https://app.example.invalid";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup() {
  const config = loadConfig({
    NODE_ENV: "production",
    APP_ORIGIN: origin,
    APP_DATABASE: ":memory:",
    GOOGLE_CLIENT_ID: "fixture-client",
    HOUSEHOLD_EMAILS: "admin@example.invalid,member@example.invalid",
    HERMES_INTEGRATION_ADMINS: "admin@example.invalid",
  });
  // Only the app's authenticated boundary is under test. Native behavior has its own probe.
  const integrationRequest = vi.fn(async (request: IntegrationRequest) =>
    request.operation === "list"
      ? { profile: request.profile, connections: [], canManage: true }
      : {
          kind: "connected" as const,
          status: "approved" as const,
          message: "Fixture operation completed",
        },
  );
  const runtime = fakeRuntime({ integrationRequest, close: async () => {} });
  const result = await createApp(config, runtime, { background: false });
  apps.push(result.app);
  return {
    ...result,
    runtime,
    integrationRequest,
    admin: signIn(result.store, origin, "admin"),
    member: signIn(result.store, origin, "member"),
  };
}

it("lets members inspect and check their profile, but reserves connection changes for administrators", async () => {
  const s = await setup();
  expect(
    (await s.app.inject({ url: "/api/integrations?profile=ranch", headers: s.member })).json(),
  ).toEqual({ profile: "ranch", connections: [], canManage: false });
  expect(
    (
      await s.app.inject({
        method: "POST",
        url: "/api/integrations/google_workspace/check",
        headers: s.member,
        payload: { profile: "ranch" },
      })
    ).statusCode,
  ).toBe(200);
  expect(s.integrationRequest).toHaveBeenLastCalledWith(
    expect.objectContaining({ operation: "check", id: "google_workspace", profile: "ranch" }),
  );
  for (const operation of ["connect", "disconnect"])
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: `/api/integrations/google_workspace/${operation}`,
          headers: s.member,
          payload: { profile: "ranch" },
        })
      ).statusCode,
    ).toBe(403);
  expect(
    (
      await s.app.inject({
        url: `/api/integrations/flows/${"a".repeat(24)}?profile=ranch`,
        headers: s.member,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await s.app.inject({
        method: "POST",
        url: "/api/integrations/mcp",
        headers: s.member,
        payload: {
          profile: "ranch",
          name: "custom",
          url: "https://mcp.example.invalid",
          auth: "none",
        },
      })
    ).statusCode,
  ).toBe(403);
  expect(s.integrationRequest).toHaveBeenCalledTimes(2);
});

it("keeps integration writes behind browser Origin/CSRF and accepts a native administrator session", async () => {
  const s = await setup(),
    request = {
      method: "POST" as const,
      url: "/api/integrations/google_workspace/connect",
      payload: { profile: "ranch" },
    };
  expect((await s.app.inject(request)).statusCode).toBe(401);
  for (const headers of [
    { cookie: s.admin.cookie, origin },
    { ...s.admin, origin: "https://other.invalid" },
    { cookie: s.admin.cookie, "x-csrf-token": s.admin["x-csrf-token"] },
  ])
    expect((await s.app.inject({ ...request, headers })).statusCode).toBe(403);
  const token = randomBytes(32).toString("base64url");
  s.store.nativeSession(hash(token), "admin", Date.now() + 60000);
  expect(
    (await s.app.inject({ ...request, headers: { authorization: `Bearer ${token}`, origin } }))
      .statusCode,
  ).toBe(403);
  expect(
    (await s.app.inject({ ...request, headers: { authorization: `Bearer ${token}` } })).statusCode,
  ).toBe(200);
  expect(s.integrationRequest).toHaveBeenCalledTimes(1);
});

it("rejects traversal, extra commands and client-controlled callback origins before native dispatch", async () => {
  const s = await setup();
  for (const payload of [
    { profile: "../other" },
    { profile: "ranch", command: "arbitrary" },
    { profile: "ranch", redirectUri: "https://other.invalid" },
  ])
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: "/api/integrations/google_workspace/connect",
          headers: s.admin,
          payload,
        })
      ).statusCode,
    ).toBe(400);
  expect(s.integrationRequest).not.toHaveBeenCalled();
  expect(
    (
      await s.app.inject({
        method: "POST",
        url: "/api/integrations/google_workspace/connect",
        headers: { ...s.admin, "x-forwarded-host": "other.invalid" },
        payload: { profile: "ranch" },
      })
    ).statusCode,
  ).toBe(200);
  expect(s.integrationRequest).toHaveBeenLastCalledWith({
    operation: "connect",
    profile: "ranch",
    id: "google_workspace",
    redirectUri: `${origin}/integrations/google/callback`,
  });
});

it("accepts the public Google return only as a fixed-origin callback and never echoes its authorization code", async () => {
  const s = await setup(),
    state = "s".repeat(24);
  const response = await s.app.inject({
    url: `/integrations/google/callback?state=${state}&code=fixture-private-code&redirect=https%3A%2F%2Fother.invalid`,
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  expect(response.body).not.toContain("fixture-private-code");
  expect(s.integrationRequest).toHaveBeenLastCalledWith({
    operation: "callback",
    profile: "default",
    callbackUrl: `${origin}/integrations/google/callback?state=${state}&code=fixture-private-code`,
  });
  s.integrationRequest.mockRejectedValueOnce(
    Object.assign(new Error("Expired state"), { statusCode: 400 }),
  );
  expect(
    (
      await s.app.inject({
        url: `/integrations/google/callback?state=${state}&code=fixture-private-code`,
      })
    ).statusCode,
  ).toBe(400);
});

it("explains a missing integration add-on without attempting a connection change", async () => {
  const s = await setup();
  delete s.runtime.integrationRequest;
  const response = await s.app.inject({ url: "/api/integrations?profile=ranch", headers: s.admin });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain("Integrations are unavailable");
  expect(s.integrationRequest).not.toHaveBeenCalled();
});

describe("assistant connection requests", () => {
  async function setupRequests(status: "not_connected" | "configured" = "not_connected") {
    const config = loadConfig({
      NODE_ENV: "production",
      APP_ORIGIN: origin,
      APP_DATABASE: ":memory:",
      GOOGLE_CLIENT_ID: "fixture-client",
      HOUSEHOLD_EMAILS: "admin@example.invalid,member@example.invalid",
      HERMES_INTEGRATION_ADMINS: "admin@example.invalid",
    });
    const integrationRequest = vi.fn(
      async (request: IntegrationRequest) =>
        ({
          profile: request.profile,
          canManage: true,
          connections: [{ id: "key:brave", name: "Brave Search", status }],
        }) as never,
    );
    const connectionRequest = vi.fn(async () => ({ status: "ok" as const }));
    const runtime = fakeRuntime({
      integrationRequest,
      connectionRequest,
      close: async () => {},
      listBots: async () => [
        { id: "ranch", name: "Ranch hand", shared: true, model: "test", activity: "idle" },
      ],
    });
    const result = await createApp(config, runtime, { background: false });
    apps.push(result.app);
    return {
      ...result,
      integrationRequest,
      connectionRequest,
      member: signIn(result.store, origin, "member"),
    };
  }
  const body = (decision: string, extra: Record<string, unknown> = {}) => ({
    decision,
    epoch: "epoch",
    sessionId: "session",
    connection: "key:brave",
    ...extra,
  });
  const url = "/api/bots/ranch/connection-requests/srq-conn";

  it("lets any member decline, and forwards the binding Hermes checks", async () => {
    const s = await setupRequests();
    const response = await s.app.inject({
      method: "POST",
      url,
      headers: s.member,
      payload: body("decline"),
    });
    expect([response.statusCode, response.json()]).toEqual([200, { status: "ok" }]);
    expect(s.connectionRequest).toHaveBeenCalledExactlyOnceWith({
      ...body("decline"),
      profile: "ranch",
      requestId: "srq-conn",
    });
    expect(s.integrationRequest).not.toHaveBeenCalled();
  });

  it("continues only once the catalog reads the connection as set up", async () => {
    const waiting = await setupRequests("not_connected");
    const refused = await waiting.app.inject({
      method: "POST",
      url,
      headers: waiting.member,
      payload: body("connected"),
    });
    expect([refused.statusCode, refused.json().error]).toEqual([
      409,
      "Brave Search isn't set up yet. Finish connecting it, then press Continue.",
    ]);
    expect(waiting.connectionRequest).not.toHaveBeenCalled();
    const unknown = await waiting.app.inject({
      method: "POST",
      url,
      headers: waiting.member,
      payload: body("connected", { connection: "github" }),
    });
    expect(unknown.statusCode).toBe(409);
    const ready = await setupRequests("configured");
    expect(
      (
        await ready.app.inject({
          method: "POST",
          url,
          headers: ready.member,
          payload: body("connected"),
        })
      ).statusCode,
    ).toBe(200);
    expect(ready.integrationRequest).toHaveBeenCalledWith({ operation: "list", profile: "ranch" });
    expect(ready.connectionRequest).toHaveBeenCalledOnce();
  });

  it("refuses connections an assistant may not ask for and unknown assistants before Hermes", async () => {
    const s = await setupRequests("configured");
    for (const payload of [
      body("connected", { connection: "apple" }),
      body("take"),
      { ...body("decline"), extra: true },
    ])
      expect(
        (await s.app.inject({ method: "POST", url, headers: s.member, payload })).statusCode,
      ).toBe(400);
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: "/api/bots/elsewhere/connection-requests/srq-conn",
          headers: s.member,
          payload: body("decline"),
        })
      ).statusCode,
    ).toBe(404);
    expect(s.connectionRequest).not.toHaveBeenCalled();
  });
});
