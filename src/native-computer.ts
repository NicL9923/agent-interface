import type RFB from "@novnc/novnc";
import "./native-computer.css";
import { controlKey, desktopKeys, isDesktopKey, keysymsFor, limitPaste } from "./lib/desktop-keys";
import { attachDesktopTouch, type DesktopTouch } from "./lib/desktop-touch";

/**
 * The shared desktop viewer the iOS app loads in a WKWebView, with no session of its own.
 * The app puts `path=<desktop ticket path>&control=0|1&trackpad=0|1` in the location hash. A new
 * path reconnects with that ticket; `control` only switches input on or off, and `trackpad` the touch
 * mode. The page reports `{type: "connected" | "disconnected" | "failed", reason?}` and
 * `{type: "zoom", zoomed}` to the app's `computer` handler.
 * The app types with `desktopInput({text} | {key}, control?)`, which sends nothing unless this
 * viewer is connected with control, and says whether it sent. `desktopPaste(text)` also puts the
 * text on the desktop's clipboard. `desktopCopied()` is the desktop's clipboard, which the desktop
 * only shares with a viewer that has control, or null. `desktopView("recenter" | "resetZoom")`
 * moves the trackpad pointer back on screen or zooms out.
 */
type Report = { type: "connected" | "disconnected" | "failed"; reason?: string } | { type: "zoom"; zoomed: boolean };
type Input = { text?: unknown; key?: unknown; control?: unknown };
declare global {
  interface Window {
    webkit?: { messageHandlers?: { computer?: { postMessage(value: Report): void } } };
    desktopInput?: (input: Input) => boolean;
    desktopPaste?: (text: unknown) => boolean;
    desktopCopied?: () => string | null;
    desktopView?: (command: unknown) => boolean;
  }
}
const ticketPath = /^\/api\/computer\/desktop\/ws\?ticket=[A-Za-z0-9_-]{43}$/;
const screen = document.getElementById("screen")!, status = document.getElementById("status")!;
let client: RFB | undefined, path = "", controlling = false, connected = false, trackpad = false;
let touch: DesktopTouch | null = null, copied: string | null = null, zoomed = false;

function report(value: Report, text: string) {
  document.documentElement.dataset.state = value.type;
  status.textContent = text;
  window.webkit?.messageHandlers?.computer?.postMessage(value);
}
function zoom(next: boolean) {
  if (next === zoomed) return;
  zoomed = next;
  window.webkit?.messageHandlers?.computer?.postMessage({ type: "zoom", zoomed });
}
function read() {
  const hash = new URLSearchParams(location.hash.slice(1));
  return { path: hash.get("path") ?? "", control: hash.get("control") === "1", trackpad: hash.get("trackpad") === "1" };
}
function setControl(next: boolean) {
  controlling = next;
  if (!client) return;
  client.viewOnly = !next;
  if (next) client.focus();
}
async function connect(next: string) {
  path = next;
  const previous = client;
  client = undefined;
  connected = false;
  copied = null;
  touch?.detach();
  touch = null;
  zoom(false);
  previous?.disconnect();
  if (!ticketPath.test(next)) { report({ type: "failed", reason: "invalid_ticket" }, "The desktop address is not valid."); return; }
  let RemoteFrameBuffer: typeof RFB;
  try { ({ default: RemoteFrameBuffer } = await import("@novnc/novnc")); }
  catch { report({ type: "failed", reason: "viewer_unavailable" }, "The desktop viewer could not load."); return; }
  // Another hash change replaced this ticket while the viewer loaded.
  if (path !== next) return;
  const url = new URL(next, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const rfb = new RemoteFrameBuffer(screen, url.href);
  client = rfb;
  rfb.viewOnly = !controlling;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  touch = attachDesktopTouch(rfb, screen, { onZoom: zoom });
  touch?.setTrackpad(trackpad);
  rfb.addEventListener("clipboard", event => {
    const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
    if (client === rfb && typeof text === "string") copied = text;
  });
  rfb.addEventListener("connect", () => {
    if (client !== rfb) return;
    connected = true;
    report({ type: "connected" }, "Connected to the desktop.");
  });
  rfb.addEventListener("disconnect", event => {
    if (client !== rfb) return;
    client = undefined;
    connected = false;
    copied = null;
    touch?.detach();
    touch = null;
    zoom(false);
    const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean === true;
    report({ type: "disconnected", reason: clean ? "closed" : "lost" }, "The desktop disconnected.");
  });
  rfb.addEventListener("securityfailure", () => {
    if (client === rfb) report({ type: "failed", reason: "rejected" }, "The desktop refused the connection.");
  });
}
function input({ text, key, control }: Input) {
  if (!client || !connected || !controlling) return false;
  const keys = typeof text === "string" ? keysymsFor(text.slice(0, 8192)) : isDesktopKey(key) ? [desktopKeys[key]] : [];
  if (!keys.length) return false;
  const rfb = client;
  if (control === true) rfb.sendKey(controlKey, "ControlLeft", true);
  for (const keysym of keys) rfb.sendKey(keysym);
  if (control === true) rfb.sendKey(controlKey, "ControlLeft", false);
  return true;
}
window.desktopInput = input;
window.desktopPaste = text => {
  if (typeof text !== "string" || !text || !client || !connected || !controlling) return false;
  const limited = limitPaste(text).text;
  client.clipboardPasteFrom(limited);
  return input({ text: limited });
};
window.desktopCopied = () => client && connected && controlling ? copied : null;
window.desktopView = command => {
  if (!touch) return false;
  if (command === "recenter") touch.recenter();
  else if (command === "resetZoom") touch.resetZoom();
  else return false;
  return true;
};
function apply() {
  const next = read();
  setControl(next.control);
  trackpad = next.trackpad;
  touch?.setTrackpad(trackpad);
  if (next.path !== path) void connect(next.path);
}
window.addEventListener("hashchange", apply);
apply();
