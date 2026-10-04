// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerPanel } from "../src/components/ComputerPanel";
import { api, ApiError, write } from "../src/client-api";
import type { ComputerStatus } from "../src/shared/computer";

const mocks = vi.hoisted(() => ({
  desktops: [] as Array<EventTarget & { viewOnly: boolean; disconnect: ReturnType<typeof vi.fn>; sendKey: ReturnType<typeof vi.fn> }>,
  terminals: [] as Array<{ write: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; paste: ReturnType<typeof vi.fn>; type: (data: string) => void }>,
}));
vi.mock("../src/client-api", async original => ({ ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn() }));
vi.mock("@novnc/novnc", () => ({ default: class extends EventTarget {
  viewOnly = false;
  scaleViewport = false;
  resizeSession = true;
  disconnect = vi.fn();
  focus = vi.fn(); sendKey = vi.fn();
  constructor() { super(); mocks.desktops.push(this); }
} }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  write = vi.fn(); focus = vi.fn(); dispose = vi.fn();
  callback = (_data: string) => {};
  paste = vi.fn((data: string) => this.callback(data));
  type = (data: string) => this.callback(data);
  constructor() { mocks.terminals.push(this); }
  loadAddon() {}
  open() {}
  onData(callback: (data: string) => void) { this.callback = callback; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  constructor(public url: string) { super(); Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
}
let status: ComputerStatus;
let container: HTMLDivElement;
let root: Root;
let ticket = 0;
const onClose = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.desktops.splice(0); mocks.terminals.splice(0); Socket.instances = []; ticket = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", Socket);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  status = { available: true, running: true, browserReady: true, label: "Family VPS", control: { kind: "idle" }, terminal: { available: true, target: "nicolas@hermes" } };
  vi.mocked(api).mockImplementation(async path => {
    if (path === "/computer") return status as never;
    if (path === "/computer/desktop") return { path: `/api/computer/desktop/ws?ticket=desktop-${++ticket}`, viewerId: "viewer-1", expiresAt: "future" } as never;
    if (path === "/computer/terminal") return { path: `/api/computer/terminal/ws?ticket=terminal-${++ticket}`, sessionId: "private-shell", target: "nicolas@hermes", expiresAt: "future" } as never;
    throw new Error("Unexpected request " + path);
  });
  vi.mocked(write).mockImplementation(async (path, body) => {
    if (path === "/computer/control") status = { ...status, control: (body as { action: string }).action === "take" ? { kind: "human", mine: true, name: "Nicolas" } : { kind: "idle" } };
    return status as never;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function render(open = true, key = "same-user") {
  await act(async () => { root.render(createElement(ComputerPanel, { open, onClose, key })); });
}
function button(text: string) { return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function connectedDesktop() {
  await render();
  await act(async () => mocks.desktops.at(-1)!.dispatchEvent(new Event("connect")));
  return mocks.desktops.at(-1)!;
}
async function connectedTerminal() {
  await render(); await click("Terminal");
  const client = Socket.instances.at(-1)!;
  await act(async () => client.open());
  return client;
}

describe("shared computer", () => {
  it("provides Unicode desktop text and navigation keys only after takeover and clears text on lost control", async () => {
    const desktop = await connectedDesktop();
    expect(button("Type text").disabled).toBe(true);
    await click("Take over"); await click("Type text");
    const field = container.querySelector<HTMLTextAreaElement>("#desktop-text-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "a🌵");
      field.dispatchEvent(new Event("input", {bubbles: true}));
    });
    await act(async () => container.querySelector("#desktop-text")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
    expect(desktop.sendKey.mock.calls.map(call => call[0])).toEqual([97, 0x0101f335]);
    await click("Enter"); await click("Tab"); await click("Backspace");
    expect(desktop.sendKey.mock.calls.slice(-3).map(call => call[0])).toEqual([0xff0d, 0xff09, 0xff08]);
    await click("Type text"); await click("Hand back");
    expect(container.querySelector("#desktop-text-input")).toBeNull();
    expect(button("Enter").disabled).toBe(true);
  });
  it("explains a browser recovery fence while keeping the desktop available to watch", async () => {
    status.reason = "An interrupted browser action needs recovery before anyone can control the computer.";
    await connectedDesktop();
    expect(container.textContent).toContain(status.reason);
    expect(button("Take over").disabled).toBe(false);
  });
  it("starts watching and only enables desktop input after an explicit successful takeover", async () => {
    const desktop = await connectedDesktop();
    expect(desktop.viewOnly).toBe(true);
    expect(write).not.toHaveBeenCalled();
    await click("Take over");
    expect(write).toHaveBeenCalledWith("/computer/control", { action: "take", viewerId: "viewer-1" });
    expect(desktop.viewOnly).toBe(false);
    expect(container.textContent).toContain("Assistants are paused");
    await click("Hand back");
    expect(desktop.viewOnly).toBe(true);
  });

  it("reconnects with a fresh ticket in watch mode without replaying a takeover", async () => {
    const desktop = await connectedDesktop(); await click("Take over");
    await act(async () => desktop.dispatchEvent(new Event("disconnect")));
    expect(desktop.viewOnly).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    const replacement = mocks.desktops.at(-1)!;
    expect(replacement).not.toBe(desktop);
    expect(replacement.viewOnly).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/computer/desktop").at(-1)?.[1]).toEqual(expect.objectContaining({ body: JSON.stringify({ viewerId: "viewer-1" }) }));
    await act(async () => replacement.dispatchEvent(new Event("connect")));
    expect(button("Take over").disabled).toBe(false);
    expect(button("Hand back").disabled).toBe(false);
  });

  it("does not enable an old desktop if takeover finishes after its socket disconnects", async () => {
    const desktop = await connectedDesktop();
    let finish!: (value: ComputerStatus) => void;
    vi.mocked(write).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await click("Take over");
    await act(async () => desktop.dispatchEvent(new Event("disconnect")));
    await act(async () => finish({ ...status, control: { kind: "human", mine: true } }));
    expect(desktop.viewOnly).toBe(true);
    expect(container.textContent).not.toContain("You have control");
  });

  it("removes input on lost ownership and prevents taking another household member's lease", async () => {
    const desktop = await connectedDesktop(); await click("Take over");
    status = { ...status, control: { kind: "human", mine: false, name: "Jordan" } };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(desktop.viewOnly).toBe(true);
    expect(container.textContent).toContain("Jordan has control");
    expect(button("Take over").disabled).toBe(true);
  });

  it("retains the viewer on reopen but resets it after the signed-in identity changes", async () => {
    const desktop = await connectedDesktop();
    await render(false);
    expect(desktop.disconnect).toHaveBeenCalledOnce();
    await render();
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/computer/desktop").at(-1)?.[1]).toEqual(expect.objectContaining({ body: JSON.stringify({ viewerId: "viewer-1" }) }));
    await render(true, "different-user");
    expect(api).toHaveBeenLastCalledWith("/computer/desktop", expect.objectContaining({ body: "{}" }));
  });

  it("shows independent terminal availability and supports keyboard-operated tabs", async () => {
    status = { ...status, available: false, reason: "The desktop packages need installing." };
    await render();
    expect(container.textContent).toContain(status.reason);
    expect(api).not.toHaveBeenCalledWith("/computer/desktop", expect.anything());
    const tab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    await act(async () => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(button("Terminal"));
    expect(button("Terminal").getAttribute("aria-selected")).toBe("true");
    expect(Socket.instances).toHaveLength(1);
  });

  it("restores focus to its opener and closes through Escape", async () => {
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    await render();
    await act(async () => container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(onClose).toHaveBeenCalledOnce();
    await render(false);
    expect(document.activeElement).toBe(opener); opener.remove();
  });

  it("stops automatic retries for expired authentication and offers reconnect", async () => {
    vi.mocked(api).mockImplementation(async path => {
      if (path === "/computer") return status as never;
      throw new ApiError("Sign in again to use the computer.", 401);
    });
    await render();
    const calls = vi.mocked(api).mock.calls.filter(([path]) => path === "/computer/desktop").length;
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/computer/desktop")).toHaveLength(calls);
    expect(button("Reconnect")).toBeDefined();
  });
});

describe("system terminal", () => {
  it("pastes text through the terminal emulator without adding Enter", async () => {
    const client = await connectedTerminal();
    await click("Paste text");
    const input = container.querySelector<HTMLTextAreaElement>("#terminal-paste-text")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "echo test");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Send text");
    expect(mocks.terminals.at(-1)!.paste).toHaveBeenCalledWith("echo test");
    expect(client.sent).toContainEqual({ type: "input", data: "echo test" });
    expect(client.sent).not.toContainEqual({ type: "input", data: "echo test\r" });
    expect(container.querySelector("#terminal-paste-text")).toBeNull();
  });

  it("sends typed input and Ctrl+C once, and preserves the server shell on panel close", async () => {
    const client = await connectedTerminal();
    mocks.terminals.at(-1)!.type("pwd\r");
    await click("Ctrl+C");
    expect(client.sent).toContainEqual({ type: "input", data: "pwd\r" });
    expect(client.sent).toContainEqual({ type: "input", data: "\u0003" });
    await act(async () => client.receive({ type: "output", data: "/home/nicolas\r\n" }));
    expect(mocks.terminals.at(-1)!.write).toHaveBeenCalledWith("/home/nicolas\r\n");
    await render(false);
    expect(write).not.toHaveBeenCalledWith("/computer/terminal/end", expect.anything());
    expect(mocks.terminals.at(-1)!.dispose).toHaveBeenCalledOnce();
    expect(client.readyState).toBe(3);
  });

  it("sends a large Unicode paste in bounded messages without losing or splitting characters", async () => {
    const client = await connectedTerminal();
    const text = "a".repeat(16383) + "🌵".repeat(5000);
    mocks.terminals.at(-1)!.type(text);
    const input = client.sent.filter(item => (item as {type: string}).type === "input") as {data: string}[];
    expect(input.length).toBeGreaterThan(1);
    expect(input.map(item => item.data).join("")).toBe(text);
    for (const message of input) {
      expect(new TextEncoder().encode(message.data).length).toBeLessThanOrEqual(16384);
      expect(message.data).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });

  it("reattaches with a fresh ticket and discards input typed during disconnection", async () => {
    const client = await connectedTerminal();
    mocks.terminals.at(-1)!.type("first-command\r");
    await act(async () => client.close());
    mocks.terminals.at(-1)!.type("disconnected-command\r");
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    const replacement = Socket.instances.at(-1)!;
    expect(replacement.url).not.toBe(client.url);
    await act(async () => replacement.open());
    expect(replacement.sent).not.toContainEqual(expect.objectContaining({ type: "input" }));
    expect(client.sent).not.toContainEqual({ type: "input", data: "disconnected-command\r" });
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps both attachments across tabs and never allocates a second shell just to switch tabs", async () => {
    const client = await connectedTerminal(); const desktop = mocks.desktops.at(-1)!;
    await click("Desktop"); await click("Terminal");
    expect(Socket.instances).toHaveLength(1);
    expect(client.readyState).toBe(1);
    expect(desktop.disconnect).not.toHaveBeenCalled();
  });

  it("shows an ended shell without automatically restarting it", async () => {
    const client = await connectedTerminal();
    await act(async () => client.receive({ type: "exit" }));
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(Socket.instances).toHaveLength(1);
    expect(container.textContent).toContain("Your shell has ended");
    await click("Start terminal");
    expect(Socket.instances).toHaveLength(2);
  });

  it("requires an explicit shell-ending action and passes its session identity", async () => {
    const client = await connectedTerminal();
    await click("End shell");
    expect(write).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Running commands will stop");
    await click("End this shell");
    expect(write).toHaveBeenCalledExactlyOnceWith("/computer/terminal/end", { sessionId: "private-shell" });
    expect(client.readyState).toBe(3);
    expect(container.textContent).toContain("Your shell has ended");
  });
});

describe("terminal confirmation", () => {
  function withAuth(config: { localDevAuth: boolean; googleClientId?: string }, userId = "google-one") {
    const fallback = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/auth/config") return config as never;
      if (path === "/bootstrap") return { user: { id: userId } } as never;
      return fallback(path, init);
    });
  }
  const ticketRequests = () => vi.mocked(api).mock.calls.filter(([path]) => path === "/computer/terminal").length;

  it("asks for a fresh Google sign-in before the first shell and opens it after confirming", async () => {
    status.terminal = { ...status.terminal, confirmationRequired: true };
    withAuth({ localDevAuth: false, googleClientId: "household-client" });
    let respond!: (result: { credential: string }) => void;
    const initialize = vi.fn((options: { callback: typeof respond }) => { respond = options.callback; });
    const renderButton = vi.fn((element: HTMLElement) => { element.textContent = "Sign in with Google"; });
    vi.stubGlobal("google", { accounts: { id: { initialize, renderButton } } });
    await render(); await click("Terminal");
    expect(container.textContent).toContain("Confirm it's you");
    expect(ticketRequests()).toBe(0);
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ client_id: "household-client" }));
    expect(container.querySelector("dialog")!.contains(renderButton.mock.calls[0][0])).toBe(true);
    await act(async () => respond({ credential: "fresh-token" }));
    expect(write).toHaveBeenCalledWith("/auth/confirm", { credential: "fresh-token" });
    expect(container.textContent).not.toContain("Confirm it's you");
    expect(ticketRequests()).toBe(1);
    expect(Socket.instances).toHaveLength(1);
  });

  it("keeps an open shell past the confirmation window and asks again only for a new attachment", async () => {
    withAuth({ localDevAuth: true }, "local-one");
    const client = await connectedTerminal();
    status = { ...status, terminal: { ...status.terminal, confirmationRequired: true } };
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(client.readyState).toBe(1);
    expect(container.textContent).not.toContain("Confirm it's you");
    const fallback = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, init) => path === "/computer/terminal"
      ? Promise.reject(new ApiError("Confirm it's you to open the terminal.", 401, "reauthentication_required")) : fallback(path, init));
    await act(async () => client.close());
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(container.textContent).toContain("Confirm it's you");
    vi.mocked(api).mockImplementation(fallback);
    await click("Confirm local member one");
    expect(write).toHaveBeenCalledWith("/auth/confirm", { member: "one" });
    expect(Socket.instances).toHaveLength(2);
  });

  it("finishes confirming under development Strict Mode effect replays", async () => {
    status.terminal = { ...status.terminal, confirmationRequired: true };
    withAuth({ localDevAuth: true }, "local-one");
    await act(async () => { root.render(createElement(StrictMode, null, createElement(ComputerPanel, { open: true, onClose, key: "same-user" }))); });
    await click("Terminal");
    expect(container.textContent).toContain("Confirm it's you");
    await click("Confirm local member one");
    expect(write).toHaveBeenCalledWith("/auth/confirm", { member: "one" });
    expect(container.textContent).not.toContain("Confirm it's you");
    // Strict Mode replays the terminal's attach effect, so only its outcome is stable here.
    expect(ticketRequests()).toBeGreaterThan(0);
  });

  it("explains that the shell is limited to administrators without requesting a ticket", async () => {
    status.terminal = { available: false, target: "", reason: "The system terminal is limited to household administrators." };
    await render(); await click("Terminal");
    expect(container.querySelector("#computer-terminal")!.textContent).toContain("Terminal unavailable");
    expect(container.textContent).toContain("limited to household administrators");
    expect(ticketRequests()).toBe(0);
    expect(mocks.desktops).toHaveLength(1);
  });
});
