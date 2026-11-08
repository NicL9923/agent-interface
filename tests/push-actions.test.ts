import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { pushActionTtl, Store } from "../src/server/store.js";
import { approvalFixture, botFixture, capabilitiesFixture, conversationFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.useRealTimers(); });

async function installation() {
  const approve = vi.fn(async () => {});
  const runtime = fakeRuntime({
    listBots: async () => [botFixture(), botFixture({ id: "other" })], close: async () => {},
    capabilities: async () => capabilitiesFixture({ approvals: { supported: true } }),
    conversation: async botId => conversationFixture({ botId, approvals: [approvalFixture({ id: "approval-1" })], activity: { state: "waiting", runId: "run" } }),
    approve,
  });
  const { app, store } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  apps.push(app);
  for (const id of ["local-one", "local-two"]) store.user({ id, name: id, email: `${id}@localhost.invalid` });
  const act = (token: string, headers: Record<string, string> = { origin }) =>
    app.inject({ method: "POST", url: "/api/push/actions", headers, payload: { token } });
  return { app, store, approve, act };
}
const bound = { userId: "local-one", botId: "shared", approvalId: "approval-1", decision: "denied" as const };

describe("web push Decline", () => {
  it("denies the bound approval as the bound person without a session or CSRF token, once", async () => {
    const { store, approve, act } = await installation();
    const token = store.issuePushAction(bound);
    const response = await act(token);
    expect([response.statusCode, response.json()]).toEqual([200, { ok: true }]);
    expect(approve).toHaveBeenCalledWith("shared", "approval-1", "denied", "local-one");
    expect(store.approval("approval-1")).toEqual({ userId: "local-one", decision: "denied" });
    expect(store.participants("run")).toEqual(["local-one"]);
    expect((await act(token)).statusCode).toBe(401);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired, forged or foreign-origin token before any decision", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { store, approve, act } = await installation();
    const expired = store.issuePushAction(bound);
    vi.setSystemTime(Date.now() + pushActionTtl + 1);
    expect((await act(expired)).statusCode).toBe(401);
    expect((await act("x".repeat(43))).statusCode).toBe(401);
    expect((await act("short")).statusCode).toBe(400);
    const token = store.issuePushAction(bound);
    expect((await act(token, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect(approve).not.toHaveBeenCalled();
    // A refused origin never reached the handler, so the token still works from the app.
    expect((await act(token)).statusCode).toBe(200);
  });

  it("refuses a token whose assistant became someone else's private one, and an approval no longer pending", async () => {
    const { store, approve, act } = await installation();
    const hidden = store.issuePushAction(bound);
    store.savePresentation("shared", { shared: false, ownerId: "local-two" });
    expect((await act(hidden)).statusCode).toBe(401);
    const stale = store.issuePushAction({ ...bound, botId: "other", approvalId: "gone" });
    expect((await act(stale)).statusCode).toBe(409);
    expect(approve).not.toHaveBeenCalled();
  });

  it("puts a token only in a lone approval's web push, never in its APNs payload", async () => {
    const store = new Store(":memory:");
    store.user({ id: "one", name: "one", email: "one@example.test" });
    store.subscribe("one", { endpoint: "https://push.test/one", keys: { p256dh: "key", auth: "auth" } });
    store.nativeSession("phone-session", "one", Date.now() + 100000);
    store.registerNativeDevice("one", "phone-session", "phone", "ab".repeat(32), "sandbox");
    const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test" });
    config.apns = { teamId: "TEAM123456", keyId: "KEY1234567", topic: "test.agentinterface", privateKeyFile: "unused", environment: "sandbox" };
    const web: string[] = [], native: string[] = [];
    const worker = new BackgroundWorker(store, fakeRuntime({ listBots: async () => [botFixture()], capabilities: async () => capabilitiesFixture() }), config,
      async (_, payload) => { web.push(payload); }, async (_, payload) => { native.push(payload); });
    try {
      store.queueNotification("approval-event", "one", { title: "Shared", body: "Allow?", url: "/?bot=shared", tag: "approval-event", kind: "approval", botId: "shared", approvalId: "approval-1" });
      store.queueNotification("done-event", "one", { title: "Shared", body: "Done", url: "/?bot=shared", tag: "done-event", kind: "completed", botId: "shared" });
      await worker.tick();
      const [approval, done] = [web.find(payload => payload.includes("approval-event"))!, web.find(payload => payload.includes("done-event"))!].map(payload => JSON.parse(payload));
      expect(store.consumePushAction(approval.declineToken)).toEqual({ userId: "one", botId: "shared", approvalId: "approval-1", decision: "denied" });
      expect(done).not.toHaveProperty("declineToken");
      expect(native).toHaveLength(2);
      for (const payload of native) expect(payload).not.toContain(approval.declineToken);
    } finally { await worker.stop(); store.close(); }
  });
});
