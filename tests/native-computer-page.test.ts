// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clients: [] as Array<EventTarget & { url: string; viewOnly: boolean; scaleViewport: boolean; disconnect: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }>,
  reports: [] as unknown[],
}));
vi.mock("@novnc/novnc", () => ({ default: class extends EventTarget {
  viewOnly = false; scaleViewport = false; resizeSession = true;
  disconnect = vi.fn(); focus = vi.fn();
  constructor(_target: HTMLElement, readonly url: string) { super(); mocks.clients.push(this as never); }
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
