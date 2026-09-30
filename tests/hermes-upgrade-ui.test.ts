// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermesUpgradePanel } from "../src/components/HermesUpgradePanel";
import { api, ApiError, write } from "../src/client-api";
import type { UpgradeStatus } from "../src/shared/upgrades";

vi.mock("../src/client-api", async original => ({
  ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn(),
}));
let container: HTMLDivElement;
let root: Root;
let status: UpgradeStatus;
const onClose = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  status = { available: true, phase: "idle", current: { revision: "original", version: "1.0" },
    message: "Check for an update.", checks: [], canCheck: true, canInstall: false, busyBots: [] };
  vi.mocked(api).mockImplementation(async () => status as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(open = true) {
  await act(async () => root.render(createElement(HermesUpgradePanel, { open, onClose, bots: [
    { id: "shared", name: "Ranch hand", shared: true, model: "test", activity: "working" },
  ] })));
}
function action() { return container.querySelector<HTMLButtonElement>(".upgrade-action .primary")!; }
const qualified = (): UpgradeStatus => ({ ...status, phase: "ready", candidate: { revision: "qualified-revision", version: "1.1" },
  message: "The update passed qualification.", canInstall: true, checks: [{ id: "contract", label: "Connection contract", status: "passed" }] });

describe("Hermes updates", () => {
  it("checks without installing, then installs only the qualified candidate after a second click", async () => {
    vi.mocked(write).mockImplementation(async path => {
      status = path.endsWith("/check") ? qualified() : { ...status, phase: "installing", canCheck: false, canInstall: false };
      return status as never;
    });
    await render();
    expect(container.textContent).toContain("1.0");
    await act(async () => action().click());
    expect(write).toHaveBeenCalledExactlyOnceWith("/hermes/upgrade/check", {});
    expect(action().textContent).toBe("Upgrade Hermes");
    expect(container.querySelector<HTMLDetailsElement>(".upgrade-checks")!.open).toBe(false);
    await act(async () => action().click());
    expect(write).toHaveBeenLastCalledWith("/hermes/upgrade/install", {
      candidateRevision: "qualified-revision", requestId: expect.stringMatching(/^[\da-f-]{36}$/),
    });
    expect(action().disabled).toBe(true);
    expect(container.textContent).not.toContain("Hermes is up to date");
  });

  it("keeps polling during an upgrade after the dialog closes", async () => {
    status = { ...status, phase: "verifying", message: "Verifying the connection.", canCheck: false };
    await render();
    await render(false);
    const calls = vi.mocked(api).mock.calls.length;
    status = { ...status, phase: "succeeded", message: "Verified and connected." };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(api).toHaveBeenCalledTimes(calls + 1);
    expect(container.textContent).toContain("Verified and connected.");
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(api).toHaveBeenCalledTimes(calls + 1);
  });

  it("blocks installation during active work and explains a rollback without showing success", async () => {
    status = { ...qualified(), phase: "blocked", message: "Active work must finish first.", canInstall: false, busyBots: ["shared"] };
    await render();
    vi.mocked(write).mockResolvedValue(status);
    expect(container.textContent).toContain("Ranch hand");
    await act(async () => action().click());
    expect(write).not.toHaveBeenCalledWith("/hermes/upgrade/install", expect.anything());
    status = { ...status, phase: "rolled_back", message: "The old version is running again.", error: "upgrade_rolled_back", busyBots: [] };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("The previous version is restored");
    expect(container.querySelector(".upgrade-checks code")?.textContent).toBe("upgrade_rolled_back");
    expect(container.querySelector<HTMLDetailsElement>(".upgrade-checks")!.open).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("Hermes is up to date");
  });

  it("keeps an offline state actionable and restores focus to its opener", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    await render();
    expect(container.textContent).toContain("You're offline");
    expect(action().disabled).toBe(true);
    expect(api).not.toHaveBeenCalled();
    await render(false);
    expect(document.activeElement).toBe(opener);
    opener.remove();
    vi.restoreAllMocks();
  });

  it("reconciles an uncertain installation without automatically submitting it again", async () => {
    status = qualified();
    vi.mocked(write).mockRejectedValue(new ApiError("Lost connection", 503, "CONNECTION_UNAVAILABLE"));
    await render();
    await act(async () => action().click());
    expect(action().disabled).toBe(true);
    expect(container.textContent).toContain("before we could confirm the request");
    status = { ...status, phase: "verifying", canInstall: false, canCheck: false, message: "Checking the restarted service." };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(write).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Checking the restarted service.");
    expect(container.textContent).not.toContain("before we could confirm the request");
  });
});
