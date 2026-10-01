// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationList } from "../src/components/IntegrationsPanel";
import { api, write } from "../src/client-api";
import type { IntegrationCatalog, IntegrationConnection, IntegrationFlow } from "../src/shared/integrations";
vi.mock("../src/client-api", async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
let catalog: IntegrationCatalog;
const connection = (overrides: Partial<IntegrationConnection> = {}): IntegrationConnection => ({ id: "workspace", name: "Google Workspace", category: "productivity", owner: "Hermes", profile: "bot", account: "one@example.test", status: "configured", detail: "Saved credentials have not been checked.", permissions: [{ id: "drive", name: "Drive", granted: null }], actions: { connect: true, check: true, disconnect: true }, setup: [], capabilities: ["search"], botIds: ["bot"], ...overrides });
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  catalog = { profile: "bot", canManage: true, connections: [connection()] };
  vi.mocked(api).mockImplementation(async path => path.includes("flows") ? { kind: "redirect", status: "pending", flowId: "oauth", message: "Approve access." } as never : catalog as never);
  vi.mocked(write).mockResolvedValue({ kind: "connected", status: "approved", message: "Connected." });
  vi.spyOn(window, "open").mockReturnValue(null);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(IntegrationList, { profile: "bot", bots: [{ id: "bot", name: "Ranch hand", shared: true, model: "test", activity: "idle" }] }))); }
function button(text: string) { return Array.from(container.querySelectorAll("button")).find(item => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function enter(input: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
describe("integration connections", () => {
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
    await act(async () => vi.advanceTimersByTimeAsync(2500));
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
    await render(); await click("Disconnect");
    expect(write).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Assistants using it will lose access");
    await click("Disconnect");
    expect(write).toHaveBeenCalledExactlyOnceWith("/integrations/workspace/disconnect", { profile: "bot" });
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
    await enter(input, "private-token");
    vi.mocked(write).mockRejectedValueOnce(new Error("Connection not accepted."));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(input.value).toBe("private-token");
    expect(container.textContent).toContain("Connection not accepted.");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(write).toHaveBeenLastCalledWith("/integrations/workspace/connect", { profile: "bot", fields: { token: "private-token" } });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});
