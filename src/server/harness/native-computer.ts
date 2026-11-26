import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import WebSocket, { type RawData } from "ws";
import { Conflict, InvalidInput } from "../../shared/errors.js";
import type { ComputerAttachment, ComputerRequest, ComputerStatus } from "../../shared/computer.js";
import type { ComputerDesktopConfig } from "../config.js";
import type { ComputerAction, ComputerBackend } from "../mcp/computer-tools.js";
import type { McpToolContext } from "../mcp/mac-tools.js";
import { rawDataText } from "../raw-data-text.js";

const DEFAULT_CHROME_BINS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const DEFAULT_VNC_BIN = "/usr/bin/Xtigervnc";
const MAX_SNAPSHOT_TEXT = 12_000;
const BLOCKED_EXACT_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200",
]);

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_EXACT_HOSTS.has(lower) || lower.endsWith(".localhost")) return true;
  if (lower.startsWith("127.") || lower.startsWith("10.") || lower.startsWith("169.254."))
    return true;
  if (lower.startsWith("192.168.")) return true;
  const rfc1918 = /^172\.(\d+)\./.exec(lower);
  if (rfc1918 && Number(rfc1918[1]) >= 16 && Number(rfc1918[1]) <= 31) return true;
  if (/^(fc|fd|fe80)/i.test(lower)) return true;
  return false;
}

export function assertSafeBrowserUrl(raw: string, allowPrivateHosts = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidInput("Enter a valid HTTP or HTTPS URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new InvalidInput("The shared browser only opens http:// and https:// pages.");
  if (!allowPrivateHosts && isPrivateOrLoopbackHost(url.hostname))
    throw new InvalidInput(
      "The shared browser cannot navigate to local or private network addresses.",
    );
  return url.href;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/**
 * Lightweight single-command Chrome DevTools Protocol client over a loopback WebSocket.
 */
export class CdpClient {
  constructor(private readonly port: number) {}

  async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async pageTargetUrl(signal?: AbortSignal): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Browser debugging endpoint is unavailable.");
    const targets = (await response.json()) as CdpTarget[];
    const page = targets.find(
      (target) =>
        target.type === "page" &&
        typeof target.webSocketDebuggerUrl === "string" &&
        !target.url.startsWith("devtools://"),
    );
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    const created = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, {
      method: "PUT",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    if (!created.ok) throw new Error("No browser tab is open on the shared desktop.");
    const next = (await created.json()) as CdpTarget;
    if (!next.webSocketDebuggerUrl) throw new Error("No browser debugging socket is available.");
    return next.webSocketDebuggerUrl;
  }

  async withPage<T>(
    fn: (
      send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const wsUrl = await this.pageTargetUrl(signal);
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
    >();

    const cleanup = () => {
      for (const entry of pending.values()) entry.reject(new Error("Browser connection closed."));
      pending.clear();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.terminate();
    };

    const onAbort = () => cleanup();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", (err) => reject(err));
      });
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(rawDataText(raw)) as CdpResponse;
          if (typeof message.id !== "number") return;
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          if (message.error)
            entry.reject(new Error(message.error.message || "CDP command failed."));
          else entry.resolve(message.result ?? {});
        } catch {
          /* Ignore malformed CDP frames. */
        }
      });
      socket.on("close", cleanup);

      const send = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("The browser action was cancelled."));
            return;
          }
          if (socket.readyState !== WebSocket.OPEN) {
            reject(new Error("Browser socket is not open."));
            return;
          }
          const id = nextId++;
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }), (error) => {
            if (error) {
              pending.delete(id);
              reject(error);
            }
          });
        });

      return await fn(send);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      cleanup();
    }
  }
}

/**
 * Bridges raw RFB bytes from a loopback TCP VNC server (`Xtigervnc`) to the `WebSocket` interface
 * expected by `src/server/computer.ts` (`/api/computer/desktop/ws`) — no `websockify` binary needed.
 */
export class TcpRfbBridge extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  private socket: Socket;

  constructor(host: string, port: number) {
    super();
    this.socket = createConnection({ host, port });
    this.socket.setNoDelay(true);
    this.socket.on("connect", () => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.emit("open");
    });
    this.socket.on("data", (chunk: Buffer) => {
      if (this.readyState !== WebSocket.OPEN) return;
      this.emit("message", chunk, true);
    });
    this.socket.on("error", (error: Error) => {
      this.emit("error", error);
    });
    this.socket.on("close", () => {
      const wasClosed = this.readyState === WebSocket.CLOSED;
      this.readyState = WebSocket.CLOSED;
      if (!wasClosed) this.emit("close", 1000, Buffer.alloc(0));
    });
  }

  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  send(data: RawData, _options?: { binary?: boolean }) {
    if (this.readyState !== WebSocket.OPEN) return;
    if (Buffer.isBuffer(data)) this.socket.write(data);
    else if (Array.isArray(data)) this.socket.write(Buffer.concat(data));
    else if (data instanceof ArrayBuffer) this.socket.write(Buffer.from(data));
    else this.socket.write(Buffer.from(data as Uint8Array));
  }

  close(code = 1000) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.socket.end();
    this.socket.once("close", () => {
      this.readyState = WebSocket.CLOSED;
      this.emit("close", code, Buffer.alloc(0));
    });
  }

  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.socket.destroy();
  }
}

function isTcpPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function findChromeBinary(configured?: string): string | undefined {
  if (configured && existsSync(configured)) return configured;
  for (const candidate of DEFAULT_CHROME_BINS) if (existsSync(candidate)) return candidate;
  return undefined;
}

function parseKeySpec(keySpec: string): {
  key: string;
  code: string;
  modifiers: number;
  text?: string;
} {
  const parts = keySpec
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  let modifiers = 0;
  let mainKey = parts.at(-1) ?? keySpec;
  for (const mod of parts.slice(0, -1)) {
    const lower = mod.toLowerCase();
    if (lower === "alt" || lower === "option") modifiers |= 1;
    else if (lower === "ctrl" || lower === "control") modifiers |= 2;
    else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super")
      modifiers |= 4;
    else if (lower === "shift") modifiers |= 8;
  }
  const named: Record<string, { key: string; code: string; text?: string }> = {
    enter: { key: "Enter", code: "Enter", text: "\r" },
    return: { key: "Enter", code: "Enter", text: "\r" },
    tab: { key: "Tab", code: "Tab" },
    escape: { key: "Escape", code: "Escape" },
    esc: { key: "Escape", code: "Escape" },
    backspace: { key: "Backspace", code: "Backspace" },
    delete: { key: "Delete", code: "Delete" },
    space: { key: " ", code: "Space", text: " " },
    arrowup: { key: "ArrowUp", code: "ArrowUp" },
    up: { key: "ArrowUp", code: "ArrowUp" },
    arrowdown: { key: "ArrowDown", code: "ArrowDown" },
    down: { key: "ArrowDown", code: "ArrowDown" },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
    left: { key: "ArrowLeft", code: "ArrowLeft" },
    arrowright: { key: "ArrowRight", code: "ArrowRight" },
    right: { key: "ArrowRight", code: "ArrowRight" },
    home: { key: "Home", code: "Home" },
    end: { key: "End", code: "End" },
    pageup: { key: "PageUp", code: "PageUp" },
    pagedown: { key: "PageDown", code: "PageDown" },
  };
  const mapped = named[mainKey.toLowerCase()];
  if (mapped) return { ...mapped, modifiers };
  if (mainKey.length === 1) {
    const upper = mainKey.toUpperCase();
    const code = /^[A-Z]$/.test(upper)
      ? `Key${upper}`
      : /^[0-9]$/.test(upper)
        ? `Digit${upper}`
        : mainKey;
    return {
      key: mainKey,
      code,
      modifiers,
      ...(modifiers === 0 || modifiers === 8 ? { text: mainKey } : {}),
    };
  }
  return { key: mainKey, code: mainKey, modifiers };
}

export interface BrowserPageBridge {
  currentOrigin(signal?: AbortSignal): Promise<{ origin: string; url: string }>;
  fillLoginFields(
    input: {
      expectedOrigins: readonly string[];
      identifier: string;
      password: string;
      submit?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{
    origin: string;
    filledUsername: boolean;
    filledPassword: boolean;
    submitted: boolean;
  }>;
  fillTotpField(
    input: { expectedOrigins: readonly string[]; code: string; submit?: boolean },
    signal?: AbortSignal,
  ): Promise<{ origin: string; filledCode: boolean; submitted: boolean }>;
}

export interface NativeComputerService {
  readonly enabled: boolean;
  computerRequest(input: ComputerRequest): Promise<ComputerStatus | ComputerAttachment>;
  connectComputerDisplay(attachment: ComputerAttachment): WebSocket;
  backend: ComputerBackend;
  browserBridge: BrowserPageBridge;
  close(): Promise<void>;
}

type ControlState =
  | { kind: "idle" }
  | { kind: "human"; actorId: string; actorName: string; viewerId: string }
  | { kind: "bot"; botId: string };

/**
 * Native Shared Computer service: supervises `Xtigervnc` + Chrome/Chromium CDP on loopback,
 * bridges raw RFB directly into `/api/computer/desktop/ws`, enforces human vs. bot control,
 * and powers the `wildbots` MCP computer & vault browser tools.
 */
export function createNativeComputerService(
  config: ComputerDesktopConfig | undefined,
  options: {
    allowPrivateHosts?: boolean;
    /** Tests can inject an external VNC/CDP pair without spawning Xtigervnc or Chrome. */
    externalProcesses?: boolean;
  } = {},
): NativeComputerService {
  const cdp = config ? new CdpClient(config.cdpPort) : undefined;
  let vncProc: ChildProcess | undefined;
  let chromeProc: ChildProcess | undefined;
  let starting: Promise<void> | undefined;
  let control: ControlState = { kind: "idle" };
  const viewers = new Map<string, { actorId: string; actorName: string }>();
  const allowPrivateHosts = options.allowPrivateHosts ?? false;

  const vncBin = config?.vncBin ?? DEFAULT_VNC_BIN;
  const chromeBin = findChromeBinary(config?.chromeBin);
  const configured = Boolean(
    config && (options.externalProcesses || (existsSync(vncBin) && chromeBin)),
  );

  async function ensureRunning(): Promise<void> {
    if (!config || !configured)
      throw new Conflict("The shared desktop is not configured on this host.");
    if (options.externalProcesses) return;
    if (starting) return starting;
    starting = (async () => {
      mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
      const profileDir = join(config.stateDirectory, "browser-profile");
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });

      if (!(await isTcpPortOpen(config.vncPort))) {
        vncProc = spawn(
          vncBin,
          [
            config.display,
            "-rfbport",
            String(config.vncPort),
            "-localhost",
            "yes",
            "-SecurityTypes",
            "None",
            "-geometry",
            config.geometry,
            "-depth",
            "24",
            "-AlwaysShared",
          ],
          {
            stdio: "ignore",
            env: { ...process.env, HOME: config.stateDirectory },
          },
        );
        vncProc.once("exit", () => {
          vncProc = undefined;
        });
        const ready = await waitFor(() => isTcpPortOpen(config.vncPort), 8_000);
        if (!ready) throw new Conflict("Could not start the shared desktop display server.");
      }

      if (cdp && !(await cdp.isReady()) && chromeBin) {
        const [width, height] = config.geometry.split("x");
        chromeProc = spawn(
          chromeBin,
          [
            `--remote-debugging-address=127.0.0.1`,
            `--remote-debugging-port=${config.cdpPort}`,
            `--user-data-dir=${profileDir}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--window-position=0,0",
            `--window-size=${width},${height}`,
            "about:blank",
          ],
          {
            stdio: "ignore",
            env: {
              ...process.env,
              DISPLAY: config.display,
              HOME: config.stateDirectory,
            },
          },
        );
        chromeProc.once("exit", () => {
          chromeProc = undefined;
        });
        const ready = await waitFor(() => cdp.isReady(), 10_000);
        if (!ready) throw new Conflict("Could not start the shared browser.");
      }
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  }

  function statusFor(actorId?: string): Promise<ComputerStatus> {
    return (async () => {
      if (!config || !configured) {
        return {
          available: false,
          running: false,
          browserReady: false,
          label: "Household computer",
          reason: "The shared desktop is not configured yet.",
          control: { kind: "idle" },
          terminal: { available: false, target: "" },
        };
      }
      const [running, browserReady] = await Promise.all([
        isTcpPortOpen(config.vncPort),
        cdp ? cdp.isReady() : Promise.resolve(false),
      ]);
      const reportedControl: ComputerStatus["control"] =
        control.kind === "human"
          ? { kind: "human", name: control.actorName, mine: control.actorId === actorId }
          : control.kind === "bot"
            ? { kind: "bot", name: control.botId }
            : { kind: "idle" };
      return {
        available: true,
        running,
        browserReady,
        label: "Household computer",
        control: reportedControl,
        terminal: { available: false, target: "" },
      };
    })();
  }

  async function computerRequest(
    input: ComputerRequest,
  ): Promise<ComputerStatus | ComputerAttachment> {
    switch (input.action) {
      case "status":
        return statusFor(input.actorId);
      case "observe": {
        await ensureRunning();
        const viewerId =
          input.viewerId && /^[A-Za-z0-9_-]{16,200}$/.test(input.viewerId)
            ? input.viewerId
            : `viewer_${randomBytes(16).toString("base64url")}`;
        viewers.set(viewerId, { actorId: input.actorId, actorName: input.actorName });
        return {
          ticket: randomBytes(24).toString("base64url"),
          path: "/api/display/ws",
          viewerId,
        } satisfies ComputerAttachment;
      }
      case "take": {
        if (!config || !configured)
          throw new Conflict("The shared desktop is not configured on this host.");
        control = {
          kind: "human",
          actorId: input.actorId,
          actorName: input.actorName,
          viewerId: input.viewerId,
        };
        return statusFor(input.actorId);
      }
      case "release": {
        if (
          control.kind === "human" &&
          (control.viewerId === input.viewerId || control.actorId === input.actorId)
        )
          control = { kind: "idle" };
        return statusFor(input.actorId);
      }
      case "handoff":
      case "terminal_request":
        return { status: "expired" } as unknown as ComputerStatus;
    }
  }

  function connectComputerDisplay(_attachment: ComputerAttachment): WebSocket {
    if (!config || !configured)
      throw new Conflict("The shared desktop is not configured on this host.");
    return new TcpRfbBridge("127.0.0.1", config.vncPort) as unknown as WebSocket;
  }

  function assertBotControlAllowed() {
    if (control.kind === "human")
      throw new Conflict(
        `${control.actorName} currently has control of the household computer. Wait until they hand control back.`,
      );
  }

  const backend: ComputerBackend = {
    async execute(action: ComputerAction, ctx: McpToolContext, signal: AbortSignal) {
      if (!config || !configured || !cdp)
        throw new Error("The household computer is not configured on this host.");
      if (action.name === "computer_status") {
        const current = await statusFor();
        let url: string | undefined;
        let title: string | undefined;
        if (current.browserReady) {
          try {
            const info = await cdp.withPage(async (send) => {
              const res = await send("Runtime.evaluate", {
                expression: "JSON.stringify({ url: location.href, title: document.title })",
                returnByValue: true,
              });
              const value = (res.result as { value?: string } | undefined)?.value;
              return value ? (JSON.parse(value) as { url?: string; title?: string }) : {};
            }, signal);
            url = info.url;
            title = info.title;
          } catch {
            /* Browser may still be initializing. */
          }
        }
        return { ...current, ...(url ? { url } : {}), ...(title ? { title } : {}) };
      }
      assertBotControlAllowed();
      await ensureRunning();
      const previousControl = control;
      control = { kind: "bot", botId: ctx.botId };
      try {
        return await cdp.withPage(async (send) => {
          switch (action.name) {
            case "computer_screenshot": {
              const shot = await send("Page.captureScreenshot", { format: "png" });
              const pngBase64 = typeof shot.data === "string" ? shot.data : "";
              const [width, height] = config.geometry.split("x").map(Number);
              return { pngBase64, width, height };
            }
            case "computer_click": {
              const button = action.args.button ?? "left";
              const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
              await send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: action.args.x,
                y: action.args.y,
              });
              await send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                x: action.args.x,
                y: action.args.y,
                button,
                buttons,
                clickCount: 1,
              });
              await send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x: action.args.x,
                y: action.args.y,
                button,
                buttons: 0,
                clickCount: 1,
              });
              return { clicked: { x: action.args.x, y: action.args.y, button } };
            }
            case "computer_type": {
              await send("Input.insertText", { text: action.args.text });
              return { typed: action.args.text.length };
            }
            case "computer_key": {
              const parsed = parseKeySpec(action.args.key);
              await send("Input.dispatchKeyEvent", {
                type: parsed.text ? "keyDown" : "rawKeyDown",
                key: parsed.key,
                code: parsed.code,
                modifiers: parsed.modifiers,
                ...(parsed.text ? { text: parsed.text, unmodifiedText: parsed.text } : {}),
              });
              await send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: parsed.key,
                code: parsed.code,
                modifiers: parsed.modifiers,
              });
              return { pressed: action.args.key };
            }
            case "computer_scroll": {
              const [w, h] = config.geometry.split("x").map(Number);
              await send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: Math.floor((w || 1280) / 2),
                y: Math.floor((h || 800) / 2),
                deltaX: action.args.deltaX ?? 0,
                deltaY: action.args.deltaY,
              });
              return { scrolled: { deltaX: action.args.deltaX ?? 0, deltaY: action.args.deltaY } };
            }
            case "browser_navigate": {
              const url = assertSafeBrowserUrl(action.args.url, allowPrivateHosts);
              await send("Page.enable");
              const nav = await send("Page.navigate", { url });
              if (typeof nav.errorText === "string" && nav.errorText)
                throw new Error(`Navigation failed: ${nav.errorText}`);
              await new Promise((resolve) => setTimeout(resolve, 600));
              const info = await send("Runtime.evaluate", {
                expression: "JSON.stringify({ url: location.href, title: document.title })",
                returnByValue: true,
              });
              const parsed = JSON.parse(
                String((info.result as { value?: string } | undefined)?.value || "{}"),
              ) as { url?: string; title?: string };
              return { url: parsed.url ?? url, title: parsed.title ?? "" };
            }
            case "browser_snapshot": {
              const evalResult = await send("Runtime.evaluate", {
                expression: `(() => {
                  const text = (document.body?.innerText || "").slice(0, ${MAX_SNAPSHOT_TEXT});
                  const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 40).map((a) => ({
                    text: (a.textContent || "").trim().slice(0, 120),
                    href: a.href,
                  }));
                  const inputs = Array.from(document.querySelectorAll("input,textarea,select")).slice(0, 40).map((el) => {
                    const rect = el.getBoundingClientRect();
                    return {
                      tag: el.tagName.toLowerCase(),
                      type: el.getAttribute("type") || "",
                      name: el.getAttribute("name") || "",
                      placeholder: el.getAttribute("placeholder") || "",
                      ariaLabel: el.getAttribute("aria-label") || "",
                      x: Math.round(rect.x + rect.width / 2),
                      y: Math.round(rect.y + rect.height / 2),
                    };
                  });
                  const buttons = Array.from(document.querySelectorAll("button,[role=button],input[type=submit]")).slice(0, 40).map((el) => {
                    const rect = el.getBoundingClientRect();
                    return {
                      text: (el.textContent || el.getAttribute("value") || el.getAttribute("aria-label") || "").trim().slice(0, 120),
                      x: Math.round(rect.x + rect.width / 2),
                      y: Math.round(rect.y + rect.height / 2),
                    };
                  });
                  return JSON.stringify({ url: location.href, title: document.title, text, links, inputs, buttons });
                })()`,
                returnByValue: true,
              });
              const value = (evalResult.result as { value?: string } | undefined)?.value;
              return value
                ? (JSON.parse(value) as Record<string, unknown>)
                : { url: "", title: "", text: "" };
            }
          }
        }, signal);
      } finally {
        if (control.kind === "bot" && control.botId === ctx.botId)
          control = previousControl.kind === "human" ? previousControl : { kind: "idle" };
      }
    },
  };

  const browserBridge: BrowserPageBridge = {
    async currentOrigin(signal) {
      if (!config || !configured || !cdp)
        throw new Conflict("The shared browser is not configured on this host.");
      assertBotControlAllowed();
      await ensureRunning();
      return cdp.withPage(async (send) => {
        const res = await send("Runtime.evaluate", {
          expression: "JSON.stringify({ url: location.href, origin: location.origin })",
          returnByValue: true,
        });
        const value = (res.result as { value?: string } | undefined)?.value;
        const parsed = value ? (JSON.parse(value) as { url?: string; origin?: string }) : {};
        return { url: parsed.url ?? "", origin: parsed.origin ?? "" };
      }, signal);
    },
    async fillLoginFields({ expectedOrigins, identifier, password, submit = false }, signal) {
      if (!config || !configured || !cdp)
        throw new Conflict("The shared browser is not configured on this host.");
      assertBotControlAllowed();
      await ensureRunning();
      return cdp.withPage(async (send) => {
        // Re-check origin atomically inside the page context before injecting the password so a
        // race/redirect between check and fill can NEVER leak a credential to another origin!
        const res = await send("Runtime.evaluate", {
          expression: `((allowed, idVal, pwVal, doSubmit) => {
            const origin = window.location.origin;
            if (!allowed.includes(origin)) {
              return JSON.stringify({ error: "origin_mismatch", origin });
            }
            const setInput = (el, value) => {
              const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
              if (proto && proto.set) proto.set.call(el, value);
              else el.value = value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            };
            const visible = (el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
            };
            const pwInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
            const pwInput = pwInputs[0] || document.querySelector('input[type="password"]');
            const userSelectors = [
              'input[autocomplete="username"]',
              'input[autocomplete="email"]',
              'input[type="email"]',
              'input[type="tel"]',
              'input[name*="user" i]',
              'input[name*="email" i]',
              'input[name*="login" i]',
              'input[type="text"]',
            ];
            let userInput = null;
            const scope = pwInput?.form || document;
            for (const sel of userSelectors) {
              const candidates = Array.from(scope.querySelectorAll(sel)).filter((el) => el !== pwInput && visible(el));
              if (candidates[0]) { userInput = candidates[0]; break; }
            }
            let filledUsername = false;
            let filledPassword = false;
            if (userInput) { setInput(userInput, idVal); filledUsername = true; }
            if (pwInput) { setInput(pwInput, pwVal); filledPassword = true; }
            let submitted = false;
            if (doSubmit && (pwInput || userInput)) {
              const form = (pwInput || userInput).form;
              if (form) {
                const submitBtn = form.querySelector('button[type="submit"],input[type="submit"]');
                if (submitBtn) submitBtn.click();
                else form.requestSubmit ? form.requestSubmit() : form.submit();
                submitted = true;
              }
            }
            return JSON.stringify({ origin, filledUsername, filledPassword, submitted });
          })(${JSON.stringify(expectedOrigins)}, ${JSON.stringify(identifier)}, ${JSON.stringify(password)}, ${JSON.stringify(submit)})`,
          returnByValue: true,
        });
        const raw = (res.result as { value?: string } | undefined)?.value;
        const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const origin = typeof parsed.origin === "string" ? parsed.origin : "";
        if (parsed.error === "origin_mismatch") {
          throw new Conflict(
            `The browser is on ${origin || "an unknown origin"}, not ${expectedOrigins[0]}. Navigate to the saved login's site first.`,
          );
        }
        return {
          origin,
          filledUsername: Boolean(parsed.filledUsername),
          filledPassword: Boolean(parsed.filledPassword),
          submitted: Boolean(parsed.submitted),
        };
      }, signal);
    },
    async fillTotpField({ expectedOrigins, code, submit = false }, signal) {
      if (!config || !configured || !cdp)
        throw new Conflict("The shared browser is not configured on this host.");
      assertBotControlAllowed();
      await ensureRunning();
      return cdp.withPage(async (send) => {
        const res = await send("Runtime.evaluate", {
          expression: `((allowed, codeVal, doSubmit) => {
            const origin = window.location.origin;
            if (!allowed.includes(origin)) {
              return JSON.stringify({ error: "origin_mismatch", origin });
            }
            const setInput = (el, value) => {
              const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
              if (proto && proto.set) proto.set.call(el, value);
              else el.value = value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            };
            const selectors = [
              'input[autocomplete="one-time-code"]',
              'input[name*="otp" i]',
              'input[name*="totp" i]',
              'input[name*="code" i]',
              'input[name*="token" i]',
              'input[inputmode="numeric"]',
            ];
            let target = null;
            for (const sel of selectors) {
              const candidate = document.querySelector(sel);
              if (candidate) { target = candidate; break; }
            }
            if (!target && document.activeElement && document.activeElement.tagName === "INPUT") {
              target = document.activeElement;
            }
            let filledCode = false;
            if (target) { setInput(target, codeVal); filledCode = true; }
            let submitted = false;
            if (doSubmit && target?.form) {
              const submitBtn = target.form.querySelector('button[type="submit"],input[type="submit"]');
              if (submitBtn) submitBtn.click();
              else target.form.requestSubmit ? target.form.requestSubmit() : target.form.submit();
              submitted = true;
            }
            return JSON.stringify({ origin, filledCode, submitted });
          })(${JSON.stringify(expectedOrigins)}, ${JSON.stringify(code)}, ${JSON.stringify(submit)})`,
          returnByValue: true,
        });
        const raw = (res.result as { value?: string } | undefined)?.value;
        const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const origin = typeof parsed.origin === "string" ? parsed.origin : "";
        if (parsed.error === "origin_mismatch") {
          throw new Conflict(
            `The browser is on ${origin || "an unknown origin"}, not ${expectedOrigins[0]}. Navigate to the saved login's site first.`,
          );
        }
        return {
          origin,
          filledCode: Boolean(parsed.filledCode),
          submitted: Boolean(parsed.submitted),
        };
      }, signal);
    },
  };

  async function close(): Promise<void> {
    if (chromeProc) {
      chromeProc.kill("SIGTERM");
      chromeProc = undefined;
    }
    if (vncProc) {
      vncProc.kill("SIGTERM");
      vncProc = undefined;
    }
    viewers.clear();
    control = { kind: "idle" };
  }

  return {
    enabled: configured,
    computerRequest,
    connectComputerDisplay,
    backend,
    browserBridge,
    close,
  };
}
