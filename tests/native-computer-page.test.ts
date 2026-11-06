// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clients: [] as Array<EventTarget & { target: HTMLElement; url: string; viewOnly: boolean; scaleViewport: boolean; disconnect: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; sendKey: ReturnType<typeof vi.fn>; clipboardPasteFrom: ReturnType<typeof vi.fn>; _handleMouseMove: ReturnType<typeof vi.fn> }>,
  reports: [] as unknown[],
}));
vi.mock("@novnc/novnc", () => ({ default: class extends EventTarget {
  viewOnly = false; scaleViewport = false; resizeSession = true;
  disconnect = vi.fn(); focus = vi.fn(); sendKey = vi.fn(); clipboardPasteFrom = vi.fn();
  _handleMouseButton = vi.fn(); _handleMouseMove = vi.fn();
  constructor(readonly target: HTMLElement, readonly url: string) { super(); mocks.clients.push(this as never); }
} }));

const ticket = (n: string) => `/api/computer/desktop/ws?ticket=${n.repeat(43)}`;
const go = async (hash: string) => {
  location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await new Promise(resolve => setTimeout(resolve, 0));
};
beforeAll(async () => {
  const page = readFileSync("native-computer.html", "utf8");
  document.body.innerHTML = page.slice(page.indexOf("<body>") + 6, page.indexOf("<script"));
  (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { computer: { postMessage: (value: unknown) => mocks.reports.push(value) } } };
  location.hash = `path=${encodeURIComponent(ticket("a"))}&control=0`;
  await import("../src/native-computer");
  await vi.waitFor(() => expect(mocks.clients).toHaveLength(1));
});

it("connects with the ticket in the hash, watch-only and scaled to fit, and reports to the app", async () => {
  const [client] = mocks.clients;
  expect(client.url).toBe(`ws://${location.host}${ticket("a")}`);
  expect([client.viewOnly, client.scaleViewport]).toEqual([true, true]);
  client.dispatchEvent(new Event("connect"));
  expect(mocks.reports.at(-1)).toEqual({ type: "connected" });
  expect(document.getElementById("status")!.textContent).toBe("Connected to the desktop.");
});

it("switches input with control without reconnecting, and reconnects for a new ticket", async () => {
  const [first] = mocks.clients;
  await go(`path=${encodeURIComponent(ticket("a"))}&control=1`);
  expect(mocks.clients).toHaveLength(1);
  expect(first.viewOnly).toBe(false);
  expect(first.focus).toHaveBeenCalled();
  await go(`path=${encodeURIComponent(ticket("a"))}&control=0`);
  expect(first.viewOnly).toBe(true);
  await go(`path=${encodeURIComponent(ticket("b"))}&control=0`);
  await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));
  expect(first.disconnect).toHaveBeenCalled();
  // The replaced viewer's own disconnect is not reported as the desktop going away.
  const before = mocks.reports.length;
  first.dispatchEvent(Object.assign(new Event("disconnect"), { detail: { clean: true } }));
  expect(mocks.reports).toHaveLength(before);
  mocks.clients[1].dispatchEvent(Object.assign(new Event("disconnect"), { detail: { clean: false } }));
  expect(mocks.reports.at(-1)).toEqual({ type: "disconnected", reason: "lost" });
});

it("refuses any address but a desktop ticket", async () => {
  for (const path of ["/api/computer/terminal/ws?ticket=" + "c".repeat(43), "https://evil.example/api/computer/desktop/ws?ticket=" + "c".repeat(43), ""]) {
    const count = mocks.clients.length;
    await go(`path=${encodeURIComponent(path)}&control=1`);
    expect(mocks.clients).toHaveLength(count);
    expect(mocks.reports.at(-1)).toEqual({ type: "failed", reason: "invalid_ticket" });
    // Same refused path twice is not reconnected; change it for the next case.
    await go("path=x");
  }
});

it("types for the app only while connected with control", async () => {
  await go(`path=${encodeURIComponent(ticket("d"))}&control=0`);
  await vi.waitFor(() => expect(mocks.clients.at(-1)!.url).toContain(ticket("d")));
  const client = mocks.clients.at(-1)!;
  const type = window.desktopInput!;
  // Not connected yet, then connected but watching: nothing reaches the desktop.
  expect(type({ text: "hi" })).toBe(false);
  client.dispatchEvent(new Event("connect"));
  expect(type({ text: "hi" })).toBe(false);
  await go(`path=${encodeURIComponent(ticket("d"))}&control=1`);
  expect(type({ text: "Hé\r\n" })).toBe(true);
  expect(client.sendKey.mock.calls).toEqual([[0x48], [0xe9], [0xff0d]]);
  client.sendKey.mockClear();
  expect(type({ key: "escape" })).toBe(true);
  expect(type({ text: "l", control: true })).toBe(true);
  expect(client.sendKey.mock.calls).toEqual([[0xff1b], [0xffe3, "ControlLeft", true], [0x6c], [0xffe3, "ControlLeft", false]]);
  client.sendKey.mockClear();
  // Unknown keys and empty text send nothing, as does a dropped connection.
  expect([type({ key: "toString" }), type({ key: "launchMissiles" }), type({ text: "" }), type({})]).toEqual([false, false, false, false]);
  client.dispatchEvent(Object.assign(new Event("disconnect"), { detail: { clean: false } }));
  expect(type({ text: "hi" })).toBe(false);
  expect(client.sendKey).not.toHaveBeenCalled();
});

it("pastes, shares the desktop's clipboard and switches touch modes for the app, only with control", async () => {
  // Each test empties the body; the trackpad pointer goes beside the page's own screen element.
  document.body.append(mocks.clients[0].target);
  await go(`path=${encodeURIComponent(ticket("e"))}&control=0`);
  await vi.waitFor(() => expect(mocks.clients.at(-1)!.url).toContain(ticket("e")));
  const client = mocks.clients.at(-1)!;
  client.dispatchEvent(new Event("connect"));
  expect(window.desktopPaste!("hi")).toBe(false);
  expect(window.desktopCopied!()).toBeNull();
  await go(`path=${encodeURIComponent(ticket("e"))}&control=1&trackpad=1`);
  // The trackpad pointer appears in the middle of the screen.
  const marker = document.querySelector<HTMLElement>(".desktop-touch-pointer");
  expect(marker).not.toBeNull();
  expect(window.desktopCopied!()).toBeNull();
  client.dispatchEvent(new CustomEvent("clipboard", { detail: { text: "copied there" } }));
  expect(window.desktopCopied!()).toBe("copied there");
  client.sendKey.mockClear();
  expect(window.desktopPaste!("ok")).toBe(true);
  expect(client.clipboardPasteFrom).toHaveBeenCalledWith("ok");
  expect(client.sendKey.mock.calls).toEqual([[0x6f], [0x6b]]);
  expect([window.desktopPaste!(""), window.desktopPaste!(42)]).toEqual([false, false]);
  expect([window.desktopView!("recenter"), window.desktopView!("resetZoom"), window.desktopView!("explode")]).toEqual([true, true, false]);
  await go(`path=${encodeURIComponent(ticket("e"))}&control=1&trackpad=0`);
  expect(marker!.hidden).toBe(true);
  // A dropped connection forgets the clipboard and stops the touch layer.
  client.dispatchEvent(Object.assign(new Event("disconnect"), { detail: { clean: false } }));
  expect(window.desktopCopied!()).toBeNull();
  expect(window.desktopView!("recenter")).toBe(false);
  expect(document.querySelector(".desktop-touch-pointer")).toBeNull();
});
