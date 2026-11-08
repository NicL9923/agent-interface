import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { Approval, Runtime } from "../src/shared/types.js";
import { capabilitiesFixture, conversationFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

const scoped: Approval = { id: "scoped", title: "Action approval", detail: "recursive delete", status: "pending", choices: ["once", "session", "always", "deny"], patterns: ["recursive delete"] };
async function installation(approvals: Approval[]) {
  const approve = vi.fn<Runtime["approve"]>(async () => {});
  const runtime = fakeRuntime({
    listBots: async () => [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
    capabilities: async () => capabilitiesFixture({ approvals: { supported: true } }),
    status: async () => ({ connected: true, code: "ready" }),
    conversation: async () => conversationFixture({ botId: "shared", approvals: approvals.map(approval => ({ ...approval })) }),
    approve, close: async () => {},
  });
  const { app, store } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  apps.push(app);
  const headers = await localLogin(app, origin);
  const decide = (id: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/bots/shared/approvals/${id}`, headers, payload });
  return { approve, store, decide };
}

describe("approval scopes", () => {
  it("sends each scope Hermes offered and records the decision", async () => {
    for (const scope of ["session", "always"] as const) {
      const { approve, store, decide } = await installation([scoped]);
      expect((await decide("scoped", { decision: "approved", scope })).statusCode).toBe(200);
      expect(approve).toHaveBeenCalledWith("shared", "scoped", "approved", "local-one", scope);
      expect(store.approval("scoped")).toMatchObject({ userId: "local-one", decision: "approved" });
    }
  });
  it("sends once without a scope, as before, from old clients and an explicit once alike", async () => {
    for (const payload of [{ decision: "approved" }, { decision: "approved", scope: "once" }, { decision: "denied" }]) {
      const { approve, decide } = await installation([scoped]);
      expect((await decide("scoped", payload)).statusCode).toBe(200);
      expect(approve.mock.calls[0]).toEqual(["shared", "scoped", payload.decision, "local-one"]);
    }
  });
  it.each([
    // Hermes's guardian denied it, so only one operation was offered.
    [{ ...scoped, choices: ["once", "deny"] } as Approval, { decision: "approved", scope: "always" }, "Hermes didn't offer Always allow for this request."],
    [{ ...scoped, choices: ["once", "deny"] } as Approval, { decision: "approved", scope: "session" }, "Hermes didn't offer Allow for this conversation for this request."],
    // An older Hermes lists no choices: approve once or decline, as before.
    [{ ...scoped, choices: undefined }, { decision: "approved", scope: "always" }, "Hermes didn't offer Always allow for this request."],
    [{ ...scoped, choices: ["session", "always", "deny"] } as Approval, { decision: "approved" }, "Hermes didn't offer that choice for this request."],
    [{ ...scoped, choices: ["once", "session"] } as Approval, { decision: "denied" }, "Hermes didn't offer that choice for this request."],
    [scoped, { decision: "denied", scope: "always" }, "Decline has no scope."],
  ])("refuses a choice Hermes did not offer and says which (%#)", async (approval, payload, reason) => {
    const { approve, store, decide } = await installation([approval]);
    const refused = await decide("scoped", payload);
    expect([refused.statusCode, refused.json().code, refused.json().error]).toEqual([409, "approval_choice_unavailable", reason]);
    expect(approve).not.toHaveBeenCalled();
    expect(store.approval("scoped")).toBeUndefined();
  });
  it("rejects an unknown scope before reading the approval", async () => {
    const { approve, decide } = await installation([scoped]);
    for (const scope of ["deny", "forever", ""]) {
      const refused = await decide("scoped", { decision: "approved", scope });
      expect([refused.statusCode, refused.json().details.map((detail: { path: string[] }) => detail.path)]).toEqual([400, [["scope"]]]);
    }
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("multi-select answers", () => {
  const questions = [
    { id: "chores", prompt: "Chores?", options: ["Feed (Recommended)", "Water", "Fence"], multiple: true },
    { id: "pasture", prompt: "Pasture?", options: ["North (Recommended)", "South"] },
    { id: "loads", prompt: "Loads?", options: ["Hay, square bales", "Straw"], multiple: true },
  ];
  async function asking() {
    const answerRequest = vi.fn<Runtime["answerRequest"]>(async () => {});
    const runtime = fakeRuntime({
      listBots: async () => [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
      capabilities: async () => capabilitiesFixture({ approvals: { supported: true } }),
      status: async () => ({ connected: true, code: "ready" }),
      conversation: async () => conversationFixture({ botId: "shared", activity: { state: "blocked" },
        attention: [{ id: "ask", kind: "clarify", title: "Questions", detail: "", questions }] }),
      answerRequest, close: async () => {},
    });
    const { app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
    apps.push(app);
    const headers = await localLogin(app, origin);
    return { answerRequest, answer: (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/bots/shared/requests/ask", headers, payload }) };
  }
  it("turns an older client's comma-joined picks into the JSON array Hermes reads, written text last", async () => {
    const { answerRequest, answer } = await asking();
    expect((await answer({ answers: { chores: "Feed (Recommended), Water", pasture: "North (Recommended)", loads: "Straw" } })).statusCode).toBe(200);
    expect(answerRequest.mock.calls[0][2]).toEqual({ chores: JSON.stringify(["Feed (Recommended)", "Water"]), pasture: "North (Recommended)",
      // An option with ", " in it could be split wrongly, so that answer stays as the person's text.
      loads: "Straw" });
    await answer({ answers: { chores: "Water, Salt block, loose" } });
    expect(answerRequest.mock.calls[1][2]).toEqual({ chores: JSON.stringify(["Water", "Salt block, loose"]) });
  });
  it("passes a client's JSON array unchanged and refuses anything else from a client that said JSON", async () => {
    const { answerRequest, answer } = await asking();
    const picks = JSON.stringify(["Feed (Recommended)", "Water, extra"]);
    expect((await answer({ answers: { chores: picks, pasture: "South" }, answerFormat: "json" })).statusCode).toBe(200);
    expect(answerRequest.mock.calls[0][2]).toEqual({ chores: picks, pasture: "South" });
    for (const chores of ["Feed (Recommended), Water", "[]", JSON.stringify(["Feed", 3]), JSON.stringify(["  "]), "{\"a\":1}"]) {
      const refused = await answer({ answers: { chores }, answerFormat: "json" });
      expect([refused.statusCode, refused.json().error], chores).toEqual([400, 'Send the answer to "chores" as a JSON array of strings.']);
    }
    expect((await answer({ answers: { chores: picks }, answerFormat: "xml" })).statusCode).toBe(400);
    expect(answerRequest).toHaveBeenCalledTimes(1);
  });
});
