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
    message: "Check for an update.", checks: [], canCheck: true, canInstall: false, canRetry: false, canCancel: false, canRestartService: false, busyBots: [] };
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
    expect(action().textContent).toBe("Install update");
    expect(container.querySelector<HTMLDetailsElement>(".upgrade-checks")!.open).toBe(false);
    await act(async () => action().click());
    expect(write).toHaveBeenLastCalledWith("/hermes/upgrade/install", {
      candidateRevision: "qualified-revision", requestId: expect.stringMatching(/^[\da-f-]{36}$/),
    });
    expect(action().disabled).toBe(true);
    expect(container.textContent).not.toContain("Hermes is up to date");
  });

  it("keeps controls steady while background polls run, and never drops a click made during one", async () => {
    await render();
    let finishPoll!: () => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { finishPoll = () => resolve({ ...status, message: "Stale poll" } as never); }));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(action().disabled).toBe(false);
    vi.mocked(write).mockResolvedValue({ ...status, phase: "checking", canCheck: false, canCancel: true, operation: "check", operationId: "check-one", message: "Looking." } as never);
    await act(async () => action().click());
    expect(write).toHaveBeenCalledExactlyOnceWith("/hermes/upgrade/check", {});
    await act(async () => finishPoll());
    expect(container.textContent).not.toContain("Stale poll");
    expect(container.textContent).toContain("Looking for an update");
  });

  it("explains a blocked check as a check, offers Check again and shows why", async () => {
    status = { ...status, phase: "blocked", operation: "check", operationId: "blocked-check", canCheck: true, canRetry: true, canCancel: false,
      candidate: { revision: "candidate", version: "1.1" }, message: "The approved Hermes repair cannot be applied to this update.", error: "repair_requires_review",
      checks: [{ id: "upstream", label: "Trusted upstream update", status: "passed" },
        { id: "staging", label: "Disposable target and unchanged OAuth repair", status: "failed", detail: "Hermes changed the code the approved repair edits." }] };
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("This update needs a look");
    expect(action().textContent).toBe("Check again");
    const buttons = [...container.querySelectorAll("button")].map(button => button.textContent);
    expect(buttons).not.toContain("Cancel update");
    expect(buttons).not.toContain("Check and try again");
    expect(container.querySelector<HTMLDetailsElement>(".upgrade-checks")!.open).toBe(true);
    expect(container.textContent).toContain("Hermes changed the code the approved repair edits.");
    expect([...container.querySelectorAll(".upgrade-steps li")].map(item => item.getAttribute("data-step"))).toEqual(["done", "failed", "waiting"]);
  });

  it("stops a running check directly, without install recovery wording", async () => {
    status = { ...status, phase: "qualifying", operation: "check", operationId: "running-check", canCheck: false, canCancel: true,
      candidate: { revision: "candidate", version: "1.1" }, message: "Testing the update in a separate Hermes home." };
    vi.mocked(write).mockResolvedValue({ ...status, phase: "cancelled", canCancel: false } as never);
    await render();
    expect(action().textContent).toBe("Testing…");
    expect(container.querySelector(".upgrade-recovery")).toBeNull();
    expect([...container.querySelectorAll(".upgrade-steps li")].map(item => item.getAttribute("data-step"))).toEqual(["done", "active", "waiting"]);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Stop checking")!.click());
    expect(write).toHaveBeenCalledExactlyOnceWith("/hermes/upgrade/control", { action: "cancel", operationId: "running-check", requestId: expect.any(String) });
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

  it("confirms restart, sends a fenced request, and reconciles uncertain recovery without replay", async () => {
    status = { ...status, phase: "failed", operationId: "failed-operation", canCheck: false, canRestartService: true, canRetry: true };
    vi.mocked(write).mockRejectedValue(new ApiError("Lost connection", 503));
    await render();
    const button = (text: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!;
    await act(async () => button("Restart Hermes").click());
    expect(write).not.toHaveBeenCalled();
    expect(container.textContent).toContain("briefly disconnect everyone");
    await act(async () => button("Yes, restart Hermes").click());
    expect(write).toHaveBeenCalledExactlyOnceWith("/hermes/upgrade/control", {
      action: "restart_service", operationId: "failed-operation", requestId: expect.stringMatching(/^[\da-f-]{36}$/),
    });
    expect(button("Restart Hermes").disabled).toBe(true);
    status = { ...status, phase: "recovering", message: "Waiting for a safe stopping point.", canRestartService: false, canRetry: false };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain("Waiting for a safe stopping point");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("restores safe recovery actions after reopening and confirms cancellation", async () => {
    status = { ...status, phase: "installing", operationId: "ongoing", canCheck: false, canCancel: true };
    vi.mocked(write).mockResolvedValue({ ...status, phase: "recovering", canCancel: false });
    await render(false);
    await render();
    const button = (text: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!;
    await act(async () => button("Cancel update").click());
    expect(write).not.toHaveBeenCalled();
    await act(async () => button("Yes, cancel update").click());
    expect(write).toHaveBeenCalledExactlyOnceWith("/hermes/upgrade/control", {
      action: "cancel", operationId: "ongoing", requestId: expect.any(String),
    });
    expect(container.textContent).toContain("Restoring the connection");
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
