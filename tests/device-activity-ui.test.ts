// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { write } from "../src/client-api";
import { deviceId } from "../src/app/device-id";
import { useDeviceActivity } from "../src/app/use-device-activity";
import { deviceIdleMs, deviceIdPattern } from "../src/shared/device-activity";
import { advance, mountRoot } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async original => ({ ...await original<typeof import("../src/client-api")>(), write: vi.fn() }))(original)));
let root: Root, visibility: DocumentVisibilityState, focused: boolean;
function Shell({ userId }: { userId?: string }) {
  useDeviceActivity(userId);
  return null;
}
const reports = () => vi.mocked(write).mock.calls.map(([path, body, method]) => {
  const { deviceId: id, state, idleMs } = body as { deviceId: string; state: string; idleMs?: number };
  expect([path, method, id]).toEqual(["/devices/activity", "PUT", deviceId()]);
  return idleMs === undefined ? state : `${state} ${idleMs}`;
});
async function render(userId?: string) { await act(async () => root.render(createElement(Shell, { userId }))); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(write).mockReset().mockResolvedValue({ ok: true });
  visibility = "visible"; focused = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  ({ root } = mountRoot());
});
afterEach(() => { Reflect.deleteProperty(document, "visibilityState"); localStorage.clear(); });

it("beats from any screen while focused and used, and stops at five minutes without input", async () => {
  await render("one");
  expect(reports()).toEqual(["active 0"]);
  await advance(15_000);
  expect(reports()).toEqual(["active 0", "active 15000"]);
  // The last beat before idle still counts; the one at five minutes ends it.
  await advance(deviceIdleMs - 30_000);
  expect(reports().at(-1)).toBe(`active ${deviceIdleMs - 15_000}`);
  await advance(15_000);
  expect(reports().at(-1)).toBe("inactive");
  const count = reports().length;
  await advance(60_000);
  expect(reports()).toHaveLength(count);
  // Any input brings it back at once.
  await act(async () => window.dispatchEvent(new Event("pointerdown")));
  expect(reports().at(-1)).toBe("active 0");
});

it("stops when the window loses focus or hides, and when the account signs out or switches", async () => {
  await render("one");
  focused = false;
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(reports()).toEqual(["active 0", "inactive"]);
  // An unattended window reports nothing more.
  await advance(45_000);
  expect(reports()).toHaveLength(2);
  focused = true;
  await act(async () => window.dispatchEvent(new Event("focus")));
  visibility = "hidden";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  // Focus alone is not input: the time since the last touch carries over.
  expect(reports().slice(2)).toEqual(["active 45000", "inactive"]);
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await render("two");
  expect(reports().slice(4)).toEqual(["active 45000", "inactive", "active 0"]);
  await render(undefined);
  expect(reports().at(-1)).toBe("inactive");
});

it("keeps one device ID per browser profile and replaces one that storage corrupted or blocked", () => {
  const first = deviceId();
  expect(first).toMatch(deviceIdPattern);
  expect(first).toBe(first.toLowerCase());
  expect(deviceId()).toBe(first);
  localStorage.setItem("wildbots.device-id", "not-a-device");
  const replaced = deviceId();
  expect(replaced).toMatch(deviceIdPattern);
  expect(replaced).not.toBe(first);
  expect(localStorage.getItem("wildbots.device-id")).toBe(replaced);
  // Blocked storage still gives one stable ID for this page.
  const blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
  try {
    const page = deviceId();
    expect(page).toMatch(deviceIdPattern);
    expect(deviceId()).toBe(page);
  } finally { blocked.mockRestore(); }
});
