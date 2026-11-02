// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, write } from "../src/client-api";
import { AttentionList } from "../src/app/AttentionList";
import type { AttentionRequest, Conversation } from "../src/shared/types";
import type { IntegrationCatalog, IntegrationConnection } from "../src/shared/integrations";
import { button, click, mountRoot, typeInto } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }))(original)));
let root: Root; let container: HTMLDivElement; let catalog: IntegrationCatalog;
const brave = (overrides: Partial<IntegrationConnection> = {}): IntegrationConnection => ({ id: "key:brave", name: "Brave Search", category: "providers", owner: "Hermes",
  profile: "kitchen", status: "not_connected", detail: "Add a provider key to this Hermes profile.", permissions: [], actions: { connect: true, check: false, disconnect: false },
  setup: [{ key: "token", label: "API key", kind: "secret", required: true }], capabilities: ["Search"], botIds: ["kitchen"], ...overrides });
const request = (connectionId = "key:brave"): AttentionRequest => ({ id: "srq-conn", kind: "connection", title: "Set up a connection?", detail: "I need web search.",
  connection: { epoch: "epoch", sessionId: "session", connectionId, reason: "I need web search to compare prices." } });
const settleUrl = "/bots/kitchen/connection-requests/srq-conn";
const settled = (decision: string) => [settleUrl, { decision, epoch: "epoch", sessionId: "session", connection: "key:brave" }];
const settleCalls = () => vi.mocked(write).mock.calls.filter(([path]) => path === settleUrl);
beforeEach(() => {
  vi.clearAllMocks();
  catalog = { profile: "kitchen", canManage: true, connections: [brave(), { ...brave(), id: "github", name: "GitHub" }] };
  vi.mocked(api).mockImplementation(async () => catalog as never);
  vi.mocked(write).mockImplementation(async path => (path === settleUrl ? { status: "ok" } : { kind: "connected", status: "approved", message: "Provider key saved." }) as never);
  ({ container, root } = mountRoot());
});
async function render(attention = [request()]) {
  const conversation: Conversation = { botId: "kitchen", messages: [], approvals: [], files: [], activity: { state: "blocked" }, attention };
  // StrictMode, as in the app's development build: cleanup and setup run twice on mount.
  await act(async () => root.render(createElement(StrictMode, null, createElement(AttentionList, { conversation, botId: "kitchen", userId: "one", assistantName: "Kitchen companion",
    bots: [{ id: "kitchen", name: "Kitchen companion", shared: true, model: "test", activity: "idle" }], disconnected: false, report: () => {} }))));
  // The integrations UI loads on demand.
  for (let i = 0; i < 500 && (container.textContent?.includes("Loading connection") || container.textContent?.includes("Checking connections")); i++)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

describe("connection request card", () => {
  it("shows the assistant's reason with only the asked-for connection, and declines with its binding", async () => {
    await render();
    for (const text of ["Kitchen companion wants to connect Brave Search", "I need web search to compare prices.", "Or send a message instead."])
      expect(container.textContent).toContain(text);
    expect(container.querySelectorAll(".integration-card")).toHaveLength(1);
    expect(container.textContent).not.toContain("GitHub");
    expect(container.textContent).not.toContain("Add custom MCP connection");
    expect(button("Continue").disabled).toBe(true);
    await click("Not now");
    expect(write).toHaveBeenCalledWith(...settled("decline"));
    expect(container.querySelector(".secure-receipt")?.textContent).toBe("You chose Not now. Kitchen companion will continue without it.");
  });

  it("continues on its own once setup in the card finishes", async () => {
    await render();
    await click("Connect");
    await typeInto(container.querySelector<HTMLInputElement>(".integration-setup input")!, "brave-key");
    catalog = { ...catalog, connections: [brave({ status: "configured" })] };
    await act(async () => container.querySelector(".integration-setup")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(write).toHaveBeenCalledWith("/integrations/key%3Abrave/connect", { profile: "kitchen", fields: { token: "brave-key" } });
    expect(settleCalls()).toEqual([settled("connected")]);
    expect(container.querySelector(".secure-receipt")?.textContent).toBe("Connected Brave Search. Kitchen companion will continue.");
  });

  it("waits for Continue when the connection already read as set up, and keeps the card when the server refuses", async () => {
    catalog = { ...catalog, connections: [brave({ status: "configured" })] };
    vi.mocked(write).mockRejectedValueOnce(new ApiError("Brave Search isn't set up yet. Finish connecting it, then press Continue.", 409));
    await render();
    expect(settleCalls()).toEqual([]);
    await click("Continue");
    expect(container.textContent).toContain("isn't set up yet");
    expect(button("Continue").disabled).toBe(false);
    await click("Continue");
    expect(settleCalls()).toEqual([settled("connected"), settled("connected")]);
    expect(container.querySelector(".secure-receipt")).not.toBeNull();
  });

  it("waits while a saved connection's sign-in is unfinished, and ignores another connection's restored sign-in", async () => {
    sessionStorage.setItem("integration-flow:one:kitchen", "github-flow");
    catalog = { ...catalog, connections: [brave({ status: "configured", authorizing: true })] };
    let flow = { kind: "redirect", status: "pending", flowId: "github-flow", connectionId: "github", message: "Waiting for authorization." };
    vi.mocked(api).mockImplementation(async path => (path.includes("flows") ? flow : catalog) as never);
    await render();
    expect(button("Continue").disabled).toBe(true);
    // The GitHub sign-in started in Settings finishes while this card is open.
    flow = { ...flow, status: "approved", message: "Authorization completed." };
    for (let i = 0; i < 400 && !container.textContent?.includes("Authorization completed"); i++)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("Authorization completed");
    expect(settleCalls()).toEqual([]);
    // Brave's own sign-in finishing is what continues.
    catalog = { ...catalog, connections: [brave({ status: "configured" })] };
    await click("Refresh status");
    expect(settleCalls()).toEqual([settled("connected")]);
  });

  it("explains a connection the catalog doesn't have and a person who can't connect it", async () => {
    await render([request("mcp:pantry")]);
    expect(container.textContent).toContain("WildBots doesn't have a connection called mcp:pantry for Kitchen companion.");
    expect(Array.from(container.querySelectorAll("button")).some(item => item.textContent === "Continue")).toBe(false);
    catalog = { ...catalog, canManage: false };
    await act(async () => root.render(createElement("div")));
    await render();
    expect(container.textContent).toContain("Only a household integration administrator can connect Brave Search.");
  });
});
