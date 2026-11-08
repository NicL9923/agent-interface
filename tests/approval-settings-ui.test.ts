// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, write } from "../src/client-api";
import { ApprovalSettingsPanel } from "../src/components/ApprovalSettingsPanel";
import type { ApprovalSettings } from "../src/shared/types";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }))(original)));
let container: HTMLDivElement, root: Root, settings: ApprovalSettings;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.mocked(api).mockReset(); vi.mocked(write).mockReset();
  settings = { supported: true, allowlist: ["SQL DROP", "recursive delete"], mode: "manual", canManageAutoReview: true };
  vi.mocked(api).mockImplementation(async path => path === "/bots/ranch/approval-settings" ? settings : Promise.reject(new Error(`unexpected ${path}`)));
  for (const [name, open] of [["showModal", true], ["close", false]] as const)
    Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function(this: HTMLDialogElement) { this.open = open; } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const show = () => act(async () => root.render(createElement(ApprovalSettingsPanel, { botId: "ranch", name: "Ranch Hand" })));
const rows = () => [...container.querySelectorAll(".approval-allowlist li span")].map(node => node.textContent);
const toggle = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

it("removes one always-allowed pattern and says when Hermes asks again", async () => {
  vi.mocked(write).mockResolvedValueOnce({ ...settings, allowlist: ["SQL DROP"] });
  await show();
  expect(rows()).toEqual(["SQL DROP", "recursive delete"]);
  expect(container.textContent).toContain("Removing one takes effect at Ranch Hand's next command in this app");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove recursive delete"]')!.click());
  expect(write).toHaveBeenCalledWith("/bots/ranch/approval-settings/allowlist", { pattern: "recursive delete" }, "DELETE");
  expect(rows()).toEqual(["SQL DROP"]);
  expect(container.textContent).toContain("Removed “recursive delete”. Hermes will ask again next time.");
});

it("asks before turning on auto-review and turns it off at once", async () => {
  vi.mocked(write).mockImplementation(async (_path, body) => ({ ...settings, mode: (body as { autoReview: boolean }).autoReview ? "smart" : "manual" }));
  await show();
  await act(async () => toggle().click());
  expect(write).not.toHaveBeenCalled();
  expect(document.querySelector(".settings-confirmation")?.textContent).toContain("Let Hermes approve routine commands?");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".settings-confirmation button")].find(button => button.textContent === "Turn on auto-review")!.click());
  expect(write).toHaveBeenLastCalledWith("/bots/ranch/approval-settings", { autoReview: true }, "PUT");
  expect(toggle().checked).toBe(true);
  await act(async () => toggle().click());
  expect(write).toHaveBeenLastCalledWith("/bots/ranch/approval-settings", { autoReview: false }, "PUT");
  expect(toggle().checked).toBe(false);
});

it("explains why auto-review can't change for a member or when Hermes never asks", async () => {
  settings = { ...settings, canManageAutoReview: false };
  await show();
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain("Only an integration administrator can change auto-review.");
  settings = { ...settings, canManageAutoReview: true, mode: "off" };
  await act(async () => root.unmount()); root = createRoot(container);
  await show();
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain("Hermes doesn't ask before commands for this assistant.");
});

it("stays hidden for an add-on that can't list always-allowed commands", async () => {
  settings = { supported: false, reason: "Update it.", allowlist: [], mode: "manual", canManageAutoReview: false };
  await show();
  expect(container.textContent).toBe("");
});
