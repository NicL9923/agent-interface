// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerPanel } from "../src/components/ComputerPanel";
import { Loading } from "../src/app/panels";
import { api, write } from "../src/client-api";

// A deploy retired these chunks, as an old tab sees it: loading the module fails with the browser's own wording.
const gone = vi.hoisted(() => () => { throw new TypeError("Failed to fetch dynamically imported module: https://app.example/assets/rfb-OLD12345.js"); });
vi.mock("../src/client-api", async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }));
vi.mock("@novnc/novnc", () => ({ get default() { return gone(); } }));
vi.mock("@xterm/xterm", () => ({ get Terminal() { return gone(); } }));
vi.mock("@xterm/addon-fit", () => ({ get FitAddon() { return gone(); } }));

let container: HTMLDivElement;
let root: Root;
const requests = (path: string) => vi.mocked(api).mock.calls.filter(([called]) => called === path).length;
const computer = (available: boolean) => ({ available, running: available, browserReady: available, label: "Family VPS", reason: "off", control: { kind: "idle" }, terminal: { available: true, target: "nicolas@hermes" } });
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.mocked(write).mockResolvedValue({} as never);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const settle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const open = () => act(async () => root.render(createElement(Loading, null, createElement(ComputerPanel, { open: true, onClose: () => {} }))));

describe("retired terminal and desktop chunks", () => {
  it("end the desktop in the reload notice instead of reconnecting forever", async () => {
    vi.mocked(api).mockImplementation(async path => path === "/computer" ? computer(true) as never
      : { path: "/api/computer/desktop/ws?ticket=d", viewerId: "viewer", expiresAt: "future" } as never);
    await open();
    await settle(100);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("could not load");
    const attempts = requests("/computer/desktop");
    await settle(30_000);
    expect(requests("/computer/desktop")).toBe(attempts);
    expect(container.textContent).not.toContain("We'll keep trying");
  });

  it("end the terminal in the reload notice instead of reconnecting forever", async () => {
    vi.mocked(api).mockImplementation(async path => path === "/computer" ? computer(false) as never
      : { path: "/api/computer/terminal/ws?ticket=t", sessionId: "shell", target: "nicolas@hermes", expiresAt: "future" } as never);
    await open();
    await settle(100);
    await act(async () => container.querySelector<HTMLButtonElement>("#computer-tab-terminal")!.click());
    await settle(100);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("could not load");
    const attempts = requests("/computer/terminal");
    await settle(30_000);
    expect(requests("/computer/terminal")).toBe(attempts);
  });
});
