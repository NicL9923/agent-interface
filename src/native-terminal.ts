import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./native-terminal.css";
import { isDesktopKey, limitPaste } from "./lib/desktop-keys";
import { chunkInput, controlCharacter, keySequence, terminalOptions } from "./lib/terminal-input";

/**
 * The system terminal the iOS app loads in a WKWebView, with no session of its own.
 * The app puts `path=<terminal ticket path>` in the location hash. A new path reconnects with that
 * ticket. The page reports to the app's `terminal` handler: `{type: "connected"}`,
 * `{type: "disconnected", reason: "closed" | "lost"}`, `{type: "failed", reason: "invalid_ticket" |
 * "viewer_unavailable"}`, `{type: "ended"}` when the shell exits, `{type: "error", message}` with the
 * server's words, and `{type: "focus"}` when the person taps the terminal.
 * The page never raises the web keyboard, so iOS smart quotes and autocorrect never reach the shell.
 * The app types with its own keyboard through `terminalInput({text} | {key}, control?)` and
 * `terminalPaste(text)`, which send nothing unless the shell is connected and say whether they sent.
 * A finger drag scrolls the shell's output, or reaches a full-screen program as a mouse wheel does.
 */
type Report = { type: "connected" | "ended" | "focus" } | { type: "disconnected"; reason: "closed" | "lost" }
  | { type: "failed"; reason: "invalid_ticket" | "viewer_unavailable" } | { type: "error"; message: string };
type Input = { text?: unknown; key?: unknown; control?: unknown };
declare global {
  interface Window {
    terminalInput?: (input: Input) => boolean;
    terminalPaste?: (text: unknown) => boolean;
  }
}
const ticketPath = /^\/api\/computer\/terminal\/ws\?ticket=[A-Za-z0-9_-]{43}$/;
const screen = document.getElementById("screen")!, status = document.getElementById("status")!;
let emulator: Terminal | undefined, fitting: FitAddon | undefined, loading: Promise<boolean> | undefined;
let socket: WebSocket | undefined, path = "", connected = false, ended = false;

function report(value: Report, text?: string) {
  if (value.type !== "focus" && value.type !== "error") document.documentElement.dataset.state = value.type;
  if (text) status.textContent = text;
  (window as unknown as { webkit?: { messageHandlers?: { terminal?: { postMessage(value: Report): void } } } })
    .webkit?.messageHandlers?.terminal?.postMessage(value);
}
function send(message: Record<string, unknown>) {
  // Never queue input. Replaying shell commands after reconnection can run them twice.
  if (!connected || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}
function resize() {
  if (!emulator || !fitting || !screen.clientWidth || !screen.clientHeight) return;
  fitting.fit();
  // The server closes the connection for a size outside 2-500 columns and 2-300 rows.
  const { cols, rows } = emulator;
  if (cols >= 2 && cols <= 500 && rows >= 2 && rows <= 300) send({ type: "resize", columns: cols, rows });
}
/** Loads the emulator once; it stays across reconnections. */
function load() {
  loading ??= (async () => {
    const [{ Terminal: Emulator }, { FitAddon: Fit }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
    // Unfocused is the normal state here, so the cursor keeps its focused look.
    const terminal = new Emulator({ ...terminalOptions, cursorInactiveStyle: "block" });
    fitting = new Fit();
    terminal.loadAddon(fitting);
    terminal.open(screen);
    // xterm focuses its text area on a tap. Focusing it would raise the web keyboard and take the
    // app's own keyboard away, so it can never take focus.
    const area = terminal.textarea;
    if (area) {
      area.disabled = true; area.readOnly = true; area.tabIndex = -1;
      area.setAttribute("inputmode", "none"); area.setAttribute("aria-hidden", "true");
      area.addEventListener("focus", () => area.blur());
    }
    terminal.onData(data => { for (const chunk of chunkInput(data)) if (!send({ type: "input", data: chunk })) return; });
    emulator = terminal;
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(screen);
    window.addEventListener("resize", resize);
    return true;
  })().catch(() => {
    // The next ticket tries again.
    loading = undefined;
    return false;
  });
  return loading;
}
async function connect(next: string) {
  path = next;
  const previous = socket;
  socket = undefined;
  connected = false;
  ended = false;
  previous?.close(1000);
  if (!ticketPath.test(next)) { report({ type: "failed", reason: "invalid_ticket" }, "The terminal address is not valid."); return; }
  if (!await load()) { report({ type: "failed", reason: "viewer_unavailable" }, "The terminal could not load."); return; }
  // Another hash change replaced this ticket while the emulator loaded.
  if (path !== next) return;
  // A fresh attachment redraws the shell. Modes a previous program left on, such as application
  // cursor keys, must not change what the next keys send.
  emulator!.reset();
  const url = new URL(next, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const client = new WebSocket(url.href);
  socket = client;
  client.addEventListener("open", () => {
    if (socket !== client) return;
    connected = true;
    report({ type: "connected" }, "Connected to the terminal.");
    resize();
  });
  client.addEventListener("message", event => {
    if (socket !== client) return;
    let message: { type?: unknown; data?: unknown; message?: unknown };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type === "output" && typeof message.data === "string") emulator!.write(message.data);
    else if (message.type === "error")
      report({ type: "error", message: typeof message.message === "string" ? message.message.slice(0, 500) : "The shell reported an error." });
    else if (message.type === "exit") {
      ended = true;
      connected = false;
      report({ type: "ended" }, "The shell ended.");
    }
  });
  client.addEventListener("close", event => {
    if (socket !== client) return;
    socket = undefined;
    connected = false;
    if (!ended) report({ type: "disconnected", reason: event.wasClean ? "closed" : "lost" }, "The terminal disconnected.");
  });
}
window.terminalInput = ({ text, key, control }: Input) => {
  if (!connected || !emulator) return false;
  let data = "";
  if (typeof text === "string") {
    // Return is a carriage return to a terminal.
    data = limitPaste(text).text.replace(/\r\n?|\n/g, "\r");
    if (control === true) data = controlCharacter(data) ?? data;
  } else if (isDesktopKey(key)) data = keySequence(key, emulator.modes.applicationCursorKeysMode);
  if (!data) return false;
  emulator.input(data, true);
  return true;
};
// xterm brackets a paste when the shell asked for it, so a pasted command waits for Return.
window.terminalPaste = text => {
  if (typeof text !== "string" || !text || !connected || !emulator) return false;
  emulator.paste(limitPaste(text).text);
  return true;
};

// A tap asks the app for its keyboard. A drag scrolls back through the shell's output, or, for a
// full-screen program or one that reads the mouse, becomes the wheel events xterm turns into arrow
// keys or mouse reports. xterm's own scrollback ignores a constructed wheel event, so the page
// scrolls that itself.
let touch: { x: number; y: number; lastY: number; moved: boolean; carry: number } | undefined;
function scroll(deltaY: number, x: number, y: number) {
  if (!emulator || !touch) return;
  if (emulator.buffer.active.type === "normal" && emulator.modes.mouseTrackingMode === "none") {
    const row = (emulator.element?.clientHeight || screen.clientHeight) / emulator.rows;
    touch.carry += deltaY;
    const lines = row > 0 ? Math.trunc(touch.carry / row) : 0;
    if (lines) { touch.carry -= lines * row; emulator.scrollLines(lines); }
    return;
  }
  const target = emulator.element?.querySelector(".xterm-screen") ?? emulator.element;
  target?.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}
screen.addEventListener("touchstart", event => {
  const point = event.touches.length === 1 ? event.touches[0] : undefined;
  touch = point && { x: point.clientX, y: point.clientY, lastY: point.clientY, moved: false, carry: 0 };
}, { passive: true });
screen.addEventListener("touchmove", event => {
  const point = event.touches[0];
  if (!touch || event.touches.length !== 1) return;
  if (!touch.moved && Math.hypot(point.clientX - touch.x, point.clientY - touch.y) < 10) return;
  touch.moved = true;
  event.preventDefault();
  const deltaY = touch.lastY - point.clientY;
  touch.lastY = point.clientY;
  if (deltaY) scroll(deltaY, point.clientX, point.clientY);
}, { passive: false });
screen.addEventListener("touchend", () => {
  if (touch && !touch.moved) report({ type: "focus" });
  touch = undefined;
});
screen.addEventListener("touchcancel", () => { touch = undefined; });

function apply() {
  const next = new URLSearchParams(location.hash.slice(1)).get("path") ?? "";
  if (next !== path) void connect(next);
}
window.addEventListener("hashchange", apply);
apply();
