// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError, write } from "../src/client-api";
import { SecureRequestCard } from "../src/components/SecureRequestCard";
import { VaultPanel } from "../src/components/VaultPanel";
import type { ProfileVault, SecureRequest } from "../src/shared/vault";

vi.mock("../src/client-api", async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }));
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.mocked(api).mockReset(); vi.mocked(write).mockReset(); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });
async function render(element: ReactElement) { await act(async () => root.render(element)); }
async function click(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent?.trim() === text);
  expect(button).toBeDefined(); await act(async () => button!.click());
}
async function type(label: string, value: string) {
  const field = Array.from(container.querySelectorAll("label")).find(item => item.textContent?.trim() === label)?.querySelector("input");
  expect(field).toBeDefined(); await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
const request: SecureRequest = { method: "vault.save_login", epoch: "epoch", sessionId: "session", origin: "https://example.invalid", site: "example.invalid" };
const card = (secure: SecureRequest = request, ownerId = "one") => createElement(SecureRequestCard, { request: secure, requestId: "native-request", botId: "ranch", ownerId, title: "Save login", detail: "Native secure request" });
const vault: ProfileVault = { botId: "ranch", profile: "ranch", scope: "profile", owner: "Hermes", notice: "Native profile scope",
  items: [{ id: "local-login", kind: "login", label: "Local", origin: "https://example.invalid", identifier: "someone", identifierType: "username", createdAt: "2026-10-01T12:00:00Z", backend: "local", hasOtp: false, canRemove: true },
    { id: "external-login", kind: "login", label: "External", origin: "https://other.invalid", identifier: "another", identifierType: "username", createdAt: "2026-10-01T12:00:00Z", backend: "onepassword", hasOtp: false, canRemove: false }],
  sources: [{ name: "local", displayName: "Hermes", enabled: true, needsUnlock: false, unlocked: true, installed: true, canToggle: false, canUnlock: false, canLock: false }] };
it("sends a scoped login answer outside chat and clears fields before confirmation", async () => {
  let done!: (value: unknown) => void; vi.mocked(write).mockReturnValue(new Promise(resolve => { done = resolve; }));
  await render(card()); await type("Username, email or phone", "someone"); await type("Password", "  exact password  "); await submit();
  expect(write).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledWith("/bots/ranch/secure-requests/native-request", {
    epoch: "epoch", sessionId: "session", method: "vault.save_login", identifier: "someone", password: "  exact password  ",
  });
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(""); expect(localStorage.length).toBe(0);
  await act(async () => done({ status: "ok" })); expect(container.textContent).toContain("Sent directly to Hermes"); expect(container.querySelector("form")).toBeNull();
});
it("cancels only the bound native request without submitting entered secrets", async () => {
  vi.mocked(write).mockResolvedValue({ status: "ok" }); await render(card()); await type("Password", "must-not-send"); await click("Cancel request");
  expect(write).toHaveBeenCalledWith("/bots/ranch/secure-requests/native-request", { epoch: "epoch", sessionId: "session", method: "vault.save_login", cancel: true });
});
it("blocks a reopened binding while its first answer is still in flight", async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(write).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  vi.mocked(api).mockResolvedValue({ attention: [{ id: "native-request", secure: request }] });
  await render(card()); await type("Username, email or phone", "someone"); await type("Password", "pending-secret"); await submit();
  await render(createElement("div")); await render(card());
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.disabled).toBe(true);
  await submit(); await click("Refresh request"); expect(write).toHaveBeenCalledOnce();
  await act(async () => reject(new ApiError("definitive rejection", 400)));
  await click("Refresh request");
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.disabled).toBe(false);
});
it("never echoes secret-bearing errors or repeats an uncertain answer", async () => {
  vi.mocked(write).mockRejectedValue(new ApiError("upstream exposed must-not-display", 502));
  vi.mocked(api).mockResolvedValue({ attention: [{ id: "native-request", secure: request }] });
  await render(card()); await type("Username, email or phone", "someone"); await type("Password", "must-not-display"); await submit();
  expect(container.textContent).not.toContain("must-not-display"); expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  await submit(); await click("Refresh request"); await submit(); expect(write).toHaveBeenCalledOnce(); expect(api).toHaveBeenCalledWith("/bots/ranch/conversation");
  expect(container.textContent).toContain("will not be submitted again");
  await render(createElement("div")); await render(card()); await submit(); expect(write).toHaveBeenCalledOnce();
  vi.mocked(api).mockResolvedValue({ attention: [] }); await click("Refresh request");
  expect(container.textContent).toContain("no longer waiting");
});
it("fences old completions and clears fields when household identity changes", async () => {
  let done!: (value: unknown) => void; vi.mocked(write).mockReturnValue(new Promise(resolve => { done = resolve; }));
  await render(card()); await type("Username, email or phone", "first"); await type("Password", "first-secret"); await submit();
  await render(card(request, "two")); await type("Password", "second-secret"); await act(async () => done({ status: "ok" }));
  expect(container.textContent).not.toContain("Sent directly"); expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("second-secret");
  await render(card({ ...request, sessionId: "new-session" }, "two")); expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
});
it("clears secure fields when the page is hidden without submitting anything", async () => {
  await render(card()); await type("Password", "hidden-secret"); await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(""); expect(write).not.toHaveBeenCalled();
});
it("preserves exact native environment values and labels their distinct storage", async () => {
  vi.mocked(write).mockResolvedValue({ status: "ok" });
  await render(card({ method: "secret", epoch: "epoch", sessionId: "session", envVar: "EXAMPLE_API_KEY", prompt: "Enter key" }));
  expect(container.textContent).toContain("profile environment"); await type("Secret value", " exact key "); await submit();
  expect(write).toHaveBeenCalledWith("/bots/ranch/secure-requests/native-request", { epoch: "epoch", sessionId: "session", method: "secret", value: " exact key " });
});
it("adds a login through the dedicated vault route and requires review after uncertainty", async () => {
  vi.mocked(api).mockResolvedValue(vault); vi.mocked(write).mockRejectedValue(new ApiError("password leaked upstream", 502));
  await render(createElement(VaultPanel, { botId: "ranch" })); await click("Add login");
  await type("Label", "Ranch account"); await type("Website origin", "https://example.invalid"); await type("Username, email or phone", "ranch@example.invalid"); await type("Password", "private-password"); await submit();
  expect(write).toHaveBeenCalledWith("/bots/ranch/vault/logins", { label: "Ranch account", origin: "https://example.invalid", identifierType: "email", identifier: "ranch@example.invalid", password: "private-password" });
  expect(container.textContent).not.toContain("leaked upstream"); expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  await submit(); expect(write).toHaveBeenCalledOnce(); await click("Reload logins"); expect(api).toHaveBeenCalledTimes(2); expect(localStorage.length).toBe(0);
});
it("requires local deletion confirmation and leaves external entries to their owner", async () => {
  vi.mocked(api).mockResolvedValue(vault); vi.mocked(write).mockResolvedValue({ removed: true }); await render(createElement(VaultPanel, { botId: "ranch" }));
  expect(container.querySelectorAll(".vault-entry button")).toHaveLength(1); await click("Remove..."); expect(write).not.toHaveBeenCalled();
  await click("Remove login"); expect(write).toHaveBeenCalledWith("/bots/ranch/vault/logins/local-login", {}, "DELETE");
});
it("keeps the password when a website page was entered instead of an origin", async () => {
  vi.mocked(api).mockResolvedValue(vault); await render(createElement(VaultPanel, { botId: "ranch" })); await click("Add login");
  await type("Website origin", "https://example.invalid/login?next=account"); await type("Password", "preserved-password"); await submit();
  expect(write).not.toHaveBeenCalled(); expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("preserved-password");
  expect(container.textContent).toContain("through the hostname");
});
