import type RFB from "@novnc/novnc";
import "./native-computer.css";

/**
 * The shared desktop viewer the iOS app loads in a WKWebView, with no session of its own.
 * The app puts `path=<desktop ticket path>&control=0|1` in the location hash. A new path
 * reconnects with that ticket; `control` only switches input on or off. The page reports
 * `{type: "connected" | "disconnected" | "failed", reason?}` to the app's `computer` handler.
 */
type Report = { type: "connected" | "disconnected" | "failed"; reason?: string };
declare global {
  interface Window { webkit?: { messageHandlers?: { computer?: { postMessage(value: Report): void } } } }
}
const ticketPath = /^\/api\/computer\/desktop\/ws\?ticket=[A-Za-z0-9_-]{43}$/;
const screen = document.getElementById("screen")!, status = document.getElementById("status")!;
let client: RFB | undefined, path = "", controlling = false;

function report(value: Report, text: string) {
  document.documentElement.dataset.state = value.type;
  status.textContent = text;
  window.webkit?.messageHandlers?.computer?.postMessage(value);
}
function read() {
  const hash = new URLSearchParams(location.hash.slice(1));
  return { path: hash.get("path") ?? "", control: hash.get("control") === "1" };
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
  rfb.addEventListener("connect", () => { if (client === rfb) report({ type: "connected" }, "Connected to the desktop."); });
  rfb.addEventListener("disconnect", event => {
    if (client !== rfb) return;
    client = undefined;
    const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean === true;
    report({ type: "disconnected", reason: clean ? "closed" : "lost" }, "The desktop disconnected.");
  });
  rfb.addEventListener("securityfailure", () => {
    if (client === rfb) report({ type: "failed", reason: "rejected" }, "The desktop refused the connection.");
  });
}
function apply() {
  const next = read();
  setControl(next.control);
  if (next.path !== path) void connect(next.path);
}
window.addEventListener("hashchange", apply);
apply();
