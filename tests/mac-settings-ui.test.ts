// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, write } from "../src/client-api";
import { MacSettings, macStatus } from "../src/app/MacSettings";
import type { LinkedMac, LinkedMacs } from "../src/shared/mac";
import { button, click, mountRoot } from "./ui-harness";

vi.mock("../src/client-api", async () => (await import("./helpers/request-mock")).withRequest({ api: vi.fn(), write: vi.fn() }));

const now = Date.parse("2026-11-08T18:00:00Z");
const mac = (overrides: Partial<LinkedMac>): LinkedMac => ({ id: "mac_one", name: "Studio", model: null, osVersion: null, appVersion: null,
  createdAt: "2026-11-01T00:00:00Z", lastSeenAt: null, online: false, state: null, ...overrides });
const listed = (devices: LinkedMac[]): LinkedMacs => ({ available: true, devices });

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.mocked(api).mockReset();
  vi.mocked(write).mockReset();
});
async function render() {
  const mount = mountRoot();
  await mount.render(createElement(MacSettings));
  return mount.container;
}

describe("Mac status", () => {
  it("says whether assistants can reach the Mac now, and when it was last there", () => {
    const cases: [Partial<LinkedMac>, string][] = [
      [{ online: true, state: { paused: false, screenLocked: false } }, "Online"],
      [{ online: true, state: { paused: true, screenLocked: true } }, "Online · assistants paused"],
      [{ online: true, state: { paused: false, screenLocked: true } }, "Online · screen locked"],
      [{ lastSeenAt: "2026-11-08T17:50:00Z" }, "Offline · last seen 10 min ago"],
      [{}, "Never connected"],
    ];
    for (const [overrides, status] of cases) expect(macStatus(mac(overrides), now)).toBe(status);
  });
});

describe("Macs in Settings", () => {
  it("stays hidden while the server has Mac links off or the list cannot be read", async () => {
    vi.mocked(api).mockResolvedValueOnce({ available: false, reason: "off", devices: [] });
    expect((await render()).textContent).toBe("");
    vi.mocked(api).mockRejectedValueOnce(new Error("offline"));
    expect((await render()).textContent).toBe("");
    expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(["/mac/devices", "/mac/devices"]);
  });

  it("explains how to link a first Mac", async () => {
    vi.mocked(api).mockResolvedValueOnce(listed([]));
    expect((await render()).textContent).toContain("Link one with WildBots for Mac");
  });

  it("revokes only after confirming, and only the Mac chosen", async () => {
    vi.mocked(api).mockResolvedValueOnce(listed([mac({}), mac({ id: "mac_two", name: "Laptop" })]));
    const container = await render();
    const rows = () => Array.from(container.querySelectorAll(".row-label")).map(label => label.textContent);
    await act(async () => container.querySelector<HTMLButtonElement>("#revoke-mac_two")!.click());
    expect(document.body.textContent).toContain("Revoke Laptop?");
    await click("Keep linked", document.body);
    expect(write).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>("#revoke-mac_two")!.click());
    vi.mocked(write).mockResolvedValueOnce({ ok: true });
    await act(async () => button("Revoke", document.querySelector(".settings-confirmation")!).click());
    expect(write).toHaveBeenCalledWith("/mac/devices/mac_two", {}, "DELETE");
    expect(rows()).toEqual(["Studio"]);
  });

  it("shows why a revoke failed and reads the list again", async () => {
    vi.mocked(api).mockResolvedValue(listed([mac({})]));
    const container = await render();
    await act(async () => container.querySelector<HTMLButtonElement>("#revoke-mac_one")!.click());
    vi.mocked(write).mockRejectedValueOnce(new Error("Mac not found"));
    await act(async () => button("Revoke", document.querySelector(".settings-confirmation")!).click());
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Mac not found");
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
  });
});
