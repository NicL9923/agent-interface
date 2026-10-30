// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationList } from "../src/components/IntegrationsPanel";
import { ApiError, api, write } from "../src/client-api";
import type { IntegrationCatalog, IntegrationConnection, IntegrationFlow } from "../src/shared/integrations";
import { advance, button, click, mountRoot, typeInto } from "./ui-harness";
vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }))(original)));
let root: Root;
let container: HTMLDivElement;
let catalog: IntegrationCatalog;
const connection = (overrides: Partial<IntegrationConnection> = {}): IntegrationConnection => ({ id: "workspace", name: "Google Workspace", category: "productivity", owner: "Hermes", profile: "bot", account: "one@example.test", status: "configured", detail: "Saved credentials have not been checked.", permissions: [{ id: "drive", name: "Drive", granted: null }], actions: { connect: true, check: true, disconnect: true }, setup: [], capabilities: ["search"], botIds: ["bot"], ...overrides });
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  catalog = { profile: "bot", canManage: true, connections: [connection()] };
  vi.mocked(api).mockImplementation(async path => path.includes("flows") ? { kind: "redirect", status: "pending", flowId: "oauth", message: "Approve access." } as never : catalog as never);
  vi.mocked(write).mockResolvedValue({ kind: "connected", status: "approved", message: "Connected." });
  vi.spyOn(window, "open").mockReturnValue(null);
  ({ container, root } = mountRoot());
});
async function render() { await act(async () => root.render(createElement(IntegrationList, { profile: "bot", bots: [{ id: "bot", name: "Ranch hand", shared: true, model: "test", activity: "idle" }] }))); }
describe("integration connections", () => {
  it("retires the refresh-first warning once a refresh someone asked for succeeds", async () => {
    vi.mocked(write).mockRejectedValueOnce(new ApiError("upstream detail", 502));
    await render();
    await click("Check connection");
    expect(container.textContent).toContain("Refresh status or try the check again");
    await click("Refresh status");
    expect(container.textContent).not.toContain("Refresh status or try the check again");
  });
  it("distinguishes configured credentials from checked access and checks the selected profile", async () => {
    await render();
    expect(container.textContent).toContain("Configured · not checked");
    expect(container.textContent).toContain("0 connected");
    expect(container.textContent).toContain("Ranch hand");
    expect(container.textContent).toContain("Not checked yet");
    await click("Check connection");
    expect(write).toHaveBeenCalledExactlyOnceWith("/integrations/workspace/check", { profile: "bot" });
  });
  it("retains pending sign-in after reopening, polls approval, and never replays connection", async () => {
    sessionStorage.setItem("integration-flow:bot", "oauth");
    await render();
    expect(container.textContent).toContain("Approve access.");
    expect(button("Reconnect").disabled).toBe(true);
    vi.mocked(api).mockImplementation(async path => path.includes("flows") ? { kind: "connected", status: "approved", flowId: "oauth", message: "Account approved." } as never : catalog as never);
    await advance(2500);
    expect(container.textContent).toContain("Account approved.");
    expect(sessionStorage.getItem("integration-flow:bot")).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
  it("opens only supported authorization addresses and keeps sign-in controls visible", async () => {
    vi.mocked(write).mockResolvedValue({ kind: "redirect", status: "pending", flowId: "oauth", url: "javascript:alert(1)", message: "Continue sign-in." });
    await render(); await click("Reconnect");
    expect(window.open).not.toHaveBeenCalled();
    expect(container.querySelector("a")).toBeNull();
    expect(button("Cancel sign-in")).toBeTruthy();
    expect(sessionStorage.getItem("integration-flow:bot")).toBe("oauth");
  });
  it("requires confirmation before disconnecting a shared account", async () => {
    vi.mocked(write).mockImplementation(async () => {
      catalog.connections = [connection({ status: "not_connected", actions: { connect: true, check: true, disconnect: false } })];
      return { kind: "connected", status: "approved", message: "Connection removed." };
    });
    await render(); await click("Disconnect");
    expect(write).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Assistants using it will lose access");
    expect(document.activeElement).toBe(button("Keep connected"));
    expect(document.getElementById(button("Keep connected").getAttribute("aria-describedby")!)?.textContent).toContain("Google Workspace");
    await click("Keep connected"); expect(document.activeElement).toBe(button("Disconnect"));
    await click("Disconnect");
    await click("Disconnect");
    expect(write).toHaveBeenCalledExactlyOnceWith("/integrations/workspace/disconnect", { profile: "bot" });
    expect(document.activeElement).toBe(button("Refresh status"));
  });
  it("does not offer connection mutations to a member without management access", async () => {
    catalog.canManage = false;
    await render();
    expect(button("Reconnect").disabled).toBe(true);
    expect(button("Disconnect").disabled).toBe(true);
    expect(button("Check connection").disabled).toBe(false);
    expect(container.textContent).not.toContain("Add custom MCP connection");
  });
  it("preserves setup input on failure and clears secret fields after a successful connection", async () => {
    catalog.connections = [connection({ setup: [{ key: "token", label: "Access token", kind: "secret", required: true }] })];
    await render(); await click("Reconnect");
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await typeInto(input, "private-token");
    vi.mocked(write).mockRejectedValueOnce(new Error("Connection not accepted."));
    await click("Connect");
    expect(input.value).toBe("private-token");
    expect(container.textContent).toContain("Connection not accepted.");
    await click("Connect");
    expect(write).toHaveBeenLastCalledWith("/integrations/workspace/connect", { profile: "bot", fields: { token: "private-token" } });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
  it("keeps the sign-in answer when a check that started before it lands later", async () => {
    sessionStorage.setItem("integration-flow:bot", "oauth");
    const asking = { kind: "instructions", status: "pending", flowId: "oauth", callbackInput: true, message: "Paste the returned address." };
    let held: ((value: unknown) => void) | undefined;
    vi.mocked(api).mockImplementation(path => path.includes("flows")
      ? held === undefined && vi.mocked(api).mock.calls.filter(([called]) => called.includes("flows")).length > 1 ? new Promise(done => { held = done; }) as never : Promise.resolve(asking as never)
      : Promise.resolve(catalog as never));
    await render();
    await advance(2500);
    expect(held).toBeDefined();
    vi.mocked(write).mockResolvedValueOnce({ ...asking, callbackInput: false, message: "Waiting for Google to confirm." });
    await typeInto(container.querySelector<HTMLInputElement>('input[type="url"]')!, "https://localhost/callback?code=private");
    await click("Finish connection");
    expect(container.textContent).toContain("Waiting for Google to confirm.");
    await act(async () => held!(asking));
    expect(container.textContent).toContain("Waiting for Google to confirm.");
    expect(container.textContent).not.toContain("Paste the returned address.");
  });
  it("clears a failed sign-in check once a later check succeeds", async () => {
    sessionStorage.setItem("integration-flow:bot", "oauth");
    vi.mocked(api).mockImplementation(async path => {
      if (!path.includes("flows")) return catalog as never;
      if (vi.mocked(api).mock.calls.filter(([called]) => called.includes("flows")).length === 1) throw new Error("Hermes is restarting.");
      return { kind: "redirect", status: "pending", flowId: "oauth", message: "Approve access." } as never;
    });
    await render();
    expect(container.textContent).toContain("Hermes is restarting.");
    await advance(2500);
    expect(container.textContent).toContain("Approve access.");
    expect(container.textContent).not.toContain("Hermes is restarting.");
  });
});


it("names a new device-code flow and copies only its displayed code with honest failure feedback", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.mocked(write).mockResolvedValue({ kind: "device_code", status: "pending", flowId: "oauth", userCode: "RANCH-42", message: "Approve access." });
  vi.mocked(api).mockImplementation(async path => path.includes("flows") ? { kind: "device_code", status: "pending", flowId: "oauth", userCode: "RANCH-42", message: "Approve access." } as never : catalog as never);
  await render(); await click("Reconnect");
  expect(container.textContent).toContain("Finish connecting Google Workspace");
  await click("Copy code"); expect(writeText).toHaveBeenCalledWith("RANCH-42");
  expect(container.querySelector('[role="status"].form-notice')?.textContent).toBe("Sign-in code copied.");
  writeText.mockRejectedValueOnce(new Error("Permission denied"));
  await click("Copy code");
  expect(container.textContent).toContain("Select and copy it instead.");
  expect(container.textContent).not.toContain("Sign-in code copied.");
  expect(write).toHaveBeenCalledOnce();
});


it.each([
  ["configured", "Check connection", "check"],
  ["unavailable", "Check connection", "check"],
  ["expired", "Reconnect", "connect"],
  ["not_connected", "Connect", "connect"],
] as const)("puts the recommended %s action first in reading and keyboard order", async (status, label, operation) => {
  catalog.connections = [connection({ status })]; await render();
  const first = container.querySelector<HTMLButtonElement>(".integration-card .actions button")!;
  expect(first.textContent).toBe(label);
  await act(async () => first.click());
  expect(write).toHaveBeenCalledExactlyOnceWith(`/integrations/workspace/${operation}`, { profile: "bot" });
});

it("presents Apple as a local iPhone handoff rather than an unchecked server account", async () => {
  catalog.connections = [connection({ id: "apple", name: "Apple device calendars and reminders", category: "devices", owner: "This iPhone", status: "unsupported", detail: "The server has no Apple account grant.", actions: { connect: false, check: false, disconnect: false }, permissions: [], setup: [] })];
  await render();
  const card = container.querySelector(".integration-card")!;
  expect(card.textContent).toContain("Apple Calendar & Reminders");
  expect(card.textContent).toContain("On iPhone");
  expect(card.textContent).toContain("assistant's draft");
  expect(card.textContent).not.toContain("Last checked");
  expect(card.textContent).not.toContain("Setup needed");
  expect(card.querySelector(".actions")).toBeNull();
});
