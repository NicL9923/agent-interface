// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeAll, expect, it, vi } from "vitest";

// xterm needs a real layout engine, so a small stand-in records what the page asks of it. Its
// input and paste hand their data to onData, as xterm does.
const mocks = vi.hoisted(() => ({
  terminals: [] as Array<{ options: Record<string, unknown>; cols: number; rows: number; modes: { applicationCursorKeysMode: boolean; mouseTrackingMode: string };
    buffer: { active: { type: string } }; element?: HTMLElement; textarea?: HTMLTextAreaElement; written: string[]; pasted: string[]; scrolled: number[];
    resets: number; emit(data: string): void }>,
  sockets: [] as Array<EventTarget & { url: string; readyState: number; sent: string[]; closed?: number; open(): void; receive(value: unknown): void; drop(clean: boolean): void }>,
  reports: [] as unknown[],
  failLoad: true,
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; modes = { applicationCursorKeysMode: false, mouseTrackingMode: "none" }; buffer = { active: { type: "normal" } };
  element?: HTMLElement; textarea?: HTMLTextAreaElement; written: string[] = []; pasted: string[] = []; scrolled: number[] = []; resets = 0;
  private listener?: (data: string) => void;
  constructor(readonly options: Record<string, unknown>) {
    if (mocks.failLoad) throw new Error("chunk failed");
    mocks.terminals.push(this);
  }
  loadAddon() {}
  open(parent: HTMLElement) {
    this.element = document.createElement("div");
    this.element.innerHTML = '<textarea class="xterm-helper-textarea"></textarea><div class="xterm-screen"></div>';
    this.textarea = this.element.querySelector("textarea")!;
    parent.append(this.element);
  }
  onData(listener: (data: string) => void) { this.listener = listener; return { dispose() {} }; }
  emit(data: string) { this.listener?.(data); }
  input(data: string) { this.emit(data); }
  paste(data: string) { this.pasted.push(data); this.emit(data); }
  write(data: string) { this.written.push(data); }
  scrollLines(lines: number) { this.scrolled.push(lines); }
  reset() { this.resets++; this.modes.applicationCursorKeysMode = false; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0; sent: string[] = []; closed?: number;
  constructor(readonly url: string) { super(); mocks.sockets.push(this); }
  send(data: string) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("sent on a socket that is not open");
    this.sent.push(data);
  }
  close(code = 1005) { this.closed = code; this.readyState = 3; }
  open() { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event("open")); }
  receive(value: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(value) })); }
  drop(clean: boolean) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { wasClean: clean })); }
}

const ticket = (n: string) => `/api/computer/terminal/ws?ticket=${n.repeat(43)}`;
const go = async (path: string) => {
  location.hash = `path=${encodeURIComponent(path)}`;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await new Promise(resolve => setTimeout(resolve, 0));
};
const sent = (socket = mocks.sockets.at(-1)!) => socket.sent.map(value => JSON.parse(value));
/** A fresh shell socket, connected. */
async function connected(n: string) {
  await go(ticket(n));
  await vi.waitFor(() => expect(mocks.sockets.at(-1)!.url).toContain(ticket(n)));
  const socket = mocks.sockets.at(-1)!;
  socket.open();
  socket.sent = [];
  return socket;
}
// The page keeps its own screen element; each test's teardown empties the body around it.
let screen: HTMLElement;
beforeAll(async () => {
  const page = readFileSync("native-terminal.html", "utf8");
  document.body.innerHTML = page.slice(page.indexOf("<body>") + 6, page.indexOf("<script"));
  screen = document.getElementById("screen")!;
  // Assigned rather than stubbed: teardown unstubs globals after each test, but the page's sockets
  // must stay fakes for the whole file. Each test file has its own globals.
  Object.assign(globalThis, { WebSocket: FakeSocket });
  (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { terminal: { postMessage: (value: unknown) => mocks.reports.push(value) } } };
  location.hash = `path=${encodeURIComponent(ticket("a"))}`;
  await import("../src/native-terminal");
});

it("reports an emulator that could not load, and loads it again for the next ticket", async () => {
  await vi.waitFor(() => expect(mocks.reports.at(-1)).toEqual({ type: "failed", reason: "viewer_unavailable" }));
  expect(mocks.sockets).toHaveLength(0);
  mocks.failLoad = false;
  await go(ticket("b"));
  await vi.waitFor(() => expect(mocks.sockets).toHaveLength(1));
  expect(mocks.terminals).toHaveLength(1);
});

it("connects with the terminal ticket in the hash and fits the shell to the page", async () => {
  Object.defineProperties(screen, { clientWidth: { value: 390 }, clientHeight: { value: 600 } });
  const [socket] = mocks.sockets;
  expect(socket.url).toBe(`ws://${location.host}${ticket("b")}`);
  socket.open();
  expect(mocks.reports.at(-1)).toEqual({ type: "connected" });
  expect(document.documentElement.dataset.state).toBe("connected");
  expect(sent(socket)).toEqual([{ type: "resize", columns: 80, rows: 24 }]);
  // A size the server would refuse is never sent; it would close the shell's connection.
  const [terminal] = mocks.terminals;
  terminal.rows = 1;
  window.dispatchEvent(new Event("resize"));
  terminal.rows = 30;
  window.dispatchEvent(new Event("resize"));
  expect(sent(socket).slice(1)).toEqual([{ type: "resize", columns: 80, rows: 30 }]);
  socket.receive({ type: "output", data: "$ " });
  expect(terminal.written).toEqual(["$ "]);
});

it("refuses any address but a terminal ticket from this server", async () => {
  for (const path of [`/api/computer/desktop/ws?ticket=${"c".repeat(43)}`, `https://evil.example${ticket("c")}`, `${ticket("c")}&next=1`,
    "/api/computer/terminal/ws?ticket=short"]) {
    const count = mocks.sockets.length;
    await go(path);
    expect(mocks.sockets).toHaveLength(count);
    expect(mocks.reports.at(-1)).toEqual({ type: "failed", reason: "invalid_ticket" });
  }
});

it("types for the app only while connected, in the forms a terminal expects", async () => {
  await go(ticket("d"));
  await vi.waitFor(() => expect(mocks.sockets.at(-1)!.url).toContain(ticket("d")));
  const socket = mocks.sockets.at(-1)!, [terminal] = mocks.terminals;
  const type = window.terminalInput!;
  // Before the shell connects nothing is sent, and nothing is queued for later.
  expect([type({ text: "rm -rf build\n" }), window.terminalPaste!("ls")]).toEqual([false, false]);
  socket.open();
  socket.sent = [];
  expect(type({ text: "ls\n" })).toBe(true);
  expect(type({ key: "up" })).toBe(true);
  terminal.modes.applicationCursorKeysMode = true;
  expect(type({ key: "up" })).toBe(true);
  expect(type({ text: "c", control: true })).toBe(true);
  // Control with a key or with more than one character sends them as they are.
  expect(type({ key: "escape", control: true })).toBe(true);
  expect(type({ text: "ab", control: true })).toBe(true);
  expect(sent(socket).map(message => message.data)).toEqual(["ls\r", "\x1b[A", "\x1bOA", "\x03", "\x1b", "ab"]);
  socket.sent = [];
  expect([type({ key: "toString" }), type({ key: "launchMissiles" }), type({ text: "" }), type({ text: 42 }), type({})])
    .toEqual([false, false, false, false, false]);
  expect(socket.sent).toEqual([]);
  // A dropped connection stops typing until the next ticket connects.
  socket.drop(false);
  expect(mocks.reports.at(-1)).toEqual({ type: "disconnected", reason: "lost" });
  expect(type({ text: "ls" })).toBe(false);
});

it("pastes through xterm at the paste limit, in messages the server accepts", async () => {
  const socket = await connected("e"), [terminal] = mocks.terminals;
  expect([window.terminalPaste!(""), window.terminalPaste!(42)]).toEqual([false, false]);
  expect(window.terminalPaste!("🌵".repeat(9000))).toBe(true);
  // 8192 cacti are 32768 bytes: two full messages, each whole characters.
  expect(terminal.pasted).toEqual(["🌵".repeat(8192)]);
  expect(sent(socket).map(message => message.data)).toEqual(["🌵".repeat(4096), "🌵".repeat(4096)]);
});

it("reports the shell ending once, server errors in its words, and a replaced ticket not at all", async () => {
  let socket = await connected("f");
  const [terminal] = mocks.terminals;
  terminal.modes.applicationCursorKeysMode = true;
  socket.receive({ type: "error", message: "Terminal input is paused for maintenance." });
  expect(mocks.reports.at(-1)).toEqual({ type: "error", message: "Terminal input is paused for maintenance." });
  socket.receive({ type: "exit" });
  expect(mocks.reports.at(-1)).toEqual({ type: "ended" });
  expect(window.terminalInput!({ text: "ls" })).toBe(false);
  const count = mocks.reports.length;
  socket.drop(true);
  expect(mocks.reports).toHaveLength(count);
  // Start terminal: the next attachment starts from a clean emulator, so keys use their normal form.
  const resets = terminal.resets;
  socket = await connected("g");
  expect(terminal.resets).toBe(resets + 1);
  window.terminalInput!({ key: "up" });
  expect(sent(socket).map(message => message.data)).toEqual(["\x1b[A"]);
  // A new ticket closes the old socket; its close is not the shell going away.
  const replaced = socket;
  socket = await connected("h");
  expect(replaced.closed).toBe(1000);
  const before = mocks.reports.length;
  replaced.drop(true);
  expect(mocks.reports).toHaveLength(before);
  socket.drop(true);
  expect(mocks.reports.at(-1)).toEqual({ type: "disconnected", reason: "closed" });
});

it("never lets xterm's text area take focus, and asks the app for its keyboard on a tap", async () => {
  await connected("i");
  const [terminal] = mocks.terminals, area = terminal.textarea!;
  document.body.append(screen);
  area.focus();
  expect(document.activeElement).not.toBe(area);
  expect(area.getAttribute("inputmode")).toBe("none");
  const touch = (type: string, y: number) => screen.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
    touches: type === "touchend" ? [] : [{ clientX: 50, clientY: y, identifier: 1, target: screen } as unknown as Touch] }));
  const count = mocks.reports.length;
  touch("touchstart", 300); touch("touchend", 300);
  expect(mocks.reports.slice(count)).toEqual([{ type: "focus" }]);
  // A drag is not a tap. Over the shell's output it scrolls whole rows: 600 pixels for 24 rows makes
  // a 25 pixel row, so 20 pixels wait, 30 more scroll two rows, and the last 10 wait again.
  const drag = () => { touch("touchstart", 300); touch("touchmove", 280); touch("touchmove", 250); touch("touchmove", 240); touch("touchend", 240); };
  const wheels: number[] = [];
  terminal.element!.addEventListener("wheel", event => wheels.push((event as WheelEvent).deltaY));
  terminal.rows = 24;
  drag();
  expect(terminal.scrolled).toEqual([2]);
  expect(wheels).toEqual([]);
  // A full-screen program, or one reading the mouse, gets wheel events for xterm to turn into keys or reports.
  for (const [buffer, mouse] of [["alternate", "none"], ["normal", "vt200"]]) {
    terminal.buffer.active.type = buffer; terminal.modes.mouseTrackingMode = mouse;
    wheels.length = 0;
    drag();
    expect(wheels).toEqual([20, 30, 10]);
  }
  expect(terminal.scrolled).toEqual([2]);
  expect(mocks.reports.slice(count)).toEqual([{ type: "focus" }]);
});
