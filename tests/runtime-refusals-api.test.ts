import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { approvalNotPendingMessage, assistantNameMessage, Conflict } from "../src/shared/errors.js";
import type { Approval, Runtime } from "../src/shared/types.js";
import { capabilitiesFixture, conversationFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function installation(members: Partial<Runtime>) {
  const runtime = fakeRuntime({
    listBots: async () => [
      { id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" },
    ],
    capabilities: async () =>
      capabilitiesFixture({
        approvals: { supported: true },
        botConfiguration: { supported: true },
      }),
    status: async () => ({ connected: true, code: "ready" }),
    close: async () => {},
    ...members,
  });
  const { app, store } = await createApp(
    loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }),
    runtime,
    { background: false },
  );
  apps.push(app);
  return { app, store };
}

describe("refusals a person can act on", () => {
  it("refuses a new assistant whose name makes no ID, before Hermes is asked", async () => {
    // saveBot is not configured, so reaching the runtime fails the test with a 502.
    const { app } = await installation({});
    const headers = await localLogin(app, origin);
    for (const name of ["🌵🐎", "!!! ???"]) {
      const refused = await app.inject({
        method: "POST",
        url: "/api/bots",
        headers,
        payload: { name, instructions: "", model: "test", shared: true },
      });
      expect([refused.statusCode, refused.json().error, refused.json().code], name).toEqual([
        400,
        assistantNameMessage,
        "assistant_name_invalid",
      ]);
    }
  });

  it("answers a runtime's refusal with its status, message and code", async () => {
    const pending: Approval = { id: "gate", title: "Open the gate", detail: "", status: "pending" };
    const { app } = await installation({
      conversation: async () =>
        conversationFixture({ botId: "shared", approvals: [{ ...pending }] }),
      approve: async () => {
        throw new Conflict("That approval expired before it was answered.", "request_not_pending");
      },
    });
    const refused = await app.inject({
      method: "POST",
      url: "/api/bots/shared/approvals/gate",
      headers: await localLogin(app, origin),
      payload: { decision: "approved" },
    });
    expect([refused.statusCode, refused.json().error, refused.json().code]).toEqual([
      409,
      "That approval expired before it was answered.",
      "request_not_pending",
    ]);
  });
});

describe("two members deciding one shared approval at once", () => {
  it("sends only the first decision to Hermes, records it, and refuses the second once the first is recorded", async () => {
    const pending: Approval = { id: "gate", title: "Open the gate", detail: "", status: "pending" };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hermes answers both, as it can when two answers reach it before either resolves the request.
    const approve = vi.fn<Runtime["approve"]>(async () => {
      await held;
    });
    const capabilities = vi.fn(async () =>
      capabilitiesFixture({
        approvals: { supported: true },
        botConfiguration: { supported: true },
      }),
    );
    const { app, store } = await installation({
      conversation: async () =>
        conversationFixture({ botId: "shared", approvals: [{ ...pending }] }),
      approve,
      capabilities,
    });
    const [one, two] = [await localLogin(app, origin, "one"), await localLogin(app, origin, "two")];
    const decide = (headers: Record<string, string>, decision: string) =>
      app.inject({
        method: "POST",
        url: "/api/bots/shared/approvals/gate",
        headers,
        payload: { decision },
      });
    const first = decide(one, "approved");
    await vi.waitFor(() => expect(approve).toHaveBeenCalled());
    const checked = capabilities.mock.calls.length;
    const waiting = decide(two, "denied");
    // The second request passes the route's capability check and reaches the decision while the first is held.
    await vi.waitFor(() => expect(capabilities.mock.calls.length).toBeGreaterThan(checked));
    await new Promise((resolve) => setImmediate(resolve));
    release();
    expect((await first).statusCode).toBe(200);
    const second = await waiting;
    expect([second.statusCode, second.json().error, second.json().code]).toEqual([
      409,
      approvalNotPendingMessage,
      "request_not_pending",
    ]);
    expect(approve.mock.calls).toEqual([["shared", "gate", "approved", "local-one"]]);
    expect(store.approval("gate")).toMatchObject({ userId: "local-one", decision: "approved" });
  });

  it("sends the waiting member's decision when the first one fails, instead of telling them it closed", async () => {
    const pending: Approval = { id: "gate", title: "Open the gate", detail: "", status: "pending" };
    let fail!: (error: Error) => void;
    const held = new Promise<void>((_, reject) => {
      fail = reject;
    });
    const approve = vi
      .fn<Runtime["approve"]>()
      .mockImplementationOnce(async () => {
        await held;
      })
      .mockResolvedValueOnce(undefined);
    const capabilities = vi.fn(async () =>
      capabilitiesFixture({
        approvals: { supported: true },
        botConfiguration: { supported: true },
      }),
    );
    const { app, store } = await installation({
      conversation: async () =>
        conversationFixture({ botId: "shared", approvals: [{ ...pending }] }),
      approve,
      capabilities,
    });
    const [one, two] = [await localLogin(app, origin, "one"), await localLogin(app, origin, "two")];
    const decide = (headers: Record<string, string>, decision: string) =>
      app.inject({
        method: "POST",
        url: "/api/bots/shared/approvals/gate",
        headers,
        payload: { decision },
      });
    const first = decide(one, "approved");
    await vi.waitFor(() => expect(approve).toHaveBeenCalled());
    const checked = capabilities.mock.calls.length;
    const second = decide(two, "denied");
    // The second request passes the route's capability check, then reaches the decision while the first is held.
    await vi.waitFor(() => expect(capabilities.mock.calls.length).toBeGreaterThan(checked));
    await new Promise((resolve) => setImmediate(resolve));
    fail(new Error("Hermes connection lost"));
    expect((await first).statusCode).toBe(502);
    expect((await second).statusCode).toBe(200);
    expect(approve.mock.calls).toEqual([
      ["shared", "gate", "approved", "local-one"],
      ["shared", "gate", "denied", "local-two"],
    ]);
    expect(store.approval("gate")).toMatchObject({ userId: "local-two", decision: "denied" });
  });

  it("lets the approval be decided again after a decision Hermes failed", async () => {
    const pending: Approval = { id: "gate", title: "Open the gate", detail: "", status: "pending" };
    const approve = vi
      .fn<Runtime["approve"]>()
      .mockRejectedValueOnce(new Error("Hermes connection lost"))
      .mockResolvedValueOnce(undefined);
    const { app, store } = await installation({
      conversation: async () =>
        conversationFixture({ botId: "shared", approvals: [{ ...pending }] }),
      approve,
    });
    const headers = await localLogin(app, origin);
    const decide = () =>
      app.inject({
        method: "POST",
        url: "/api/bots/shared/approvals/gate",
        headers,
        payload: { decision: "approved" },
      });
    expect((await decide()).statusCode).toBe(502);
    expect(store.approval("gate")).toBeUndefined();
    expect((await decide()).statusCode).toBe(200);
    expect(store.approval("gate")).toMatchObject({ userId: "local-one", decision: "approved" });
  });
});

describe("approval attribution", () => {
  it("keeps the first decision recorded instead of failing on a second", () => {
    const store = new Store(":memory:");
    for (const id of ["one", "two"]) store.user({ id, name: id, email: `${id}@example.invalid` });
    store.attributeApproval("gate", "shared", "one", "approved");
    expect(() => store.attributeApproval("gate", "shared", "two", "denied")).not.toThrow();
    expect(store.approval("gate")).toMatchObject({ userId: "one", decision: "approved" });
  });
});
