/**
 * Pi (`pi --mode rpc`) harness driver.
 *
 * Adapted from pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.
 * Sources: packages/provider-pi/src/server/{rpc,adapter,driver,mcpInjection,mcpExtensionSource,
 * modelCapabilities,status}.ts. The Effect runtime is replaced with plain Node streams, and the
 * single T3 HTTP MCP bridge is generalized to the session's stdio and HTTP MCP servers.
 *
 * Protocol reference: Pi's docs/rpc.md (strict LF-delimited JSONL; responses carry the request
 * `id`, events never do; extension dialogs block until an `extension_ui_response`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { ModelProvider } from "../../shared/types.js";
import type {
  HarnessDriver,
  HarnessDriverCapabilities,
  HarnessEvent,
  HarnessProbeResult,
  HarnessQuestion,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTurnInput,
} from "./driver.js";

export interface PiDriverOptions {
  /** Executable to run. Defaults to `pi` on PATH. */
  command?: string;
  /** Arguments placed before the driver's own (`--version`, `--mode rpc ...`). */
  args?: string[];
  /** Environment overrides applied on top of `process.env` for every Pi process. */
  env?: Record<string, string>;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Time between SIGTERM and SIGKILL when closing a session. */
  terminationGraceMs?: number;
  /** Directory for per-session temp files. Defaults to `os.tmpdir()`. */
  tempDir?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
/** Pi tool output can carry base64 images; bound one record so a runaway line cannot exhaust memory. */
const MAX_RECORD_CHARS = 64 * 1024 * 1024;
const STDOUT_DRAIN_AFTER_EXIT_MS = 250;

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/**
 * Maps WildBots reasoning levels (`none`..`ultra`) onto Pi's `--thinking` levels.
 * Pi 0.79 tops out at `xhigh`, so `max` and `ultra` clamp to it. Unknown values send no flag
 * so Pi keeps the model's own default.
 */
export function piThinkingLevel(reasoning: string | undefined): PiThinkingLevel | undefined {
  if (reasoning === undefined) return undefined;
  const value = reasoning.trim().toLowerCase();
  if (value === "none" || value === "off" || value === "disabled") return "off";
  if (value === "max" || value === "ultra") return "xhigh";
  return PI_THINKING_LEVELS.find((level) => level === value);
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google Gemini",
  "google-vertex": "Google Vertex",
  ollama: "Ollama",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  openrouter: "OpenRouter",
  xai: "xAI",
};

function providerName(id: string): string {
  return (
    PROVIDER_NAMES[id] ??
    id
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ")
  );
}

/** Shown when Pi cannot report its configured models (not installed, crashed, or timed out). */
export const PI_FALLBACK_CATALOG: ReadonlyArray<{
  provider: string;
  models: ReadonlyArray<{ id: string; name: string }>;
}> = [
  {
    provider: "openrouter",
    models: [
      { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5 (OpenRouter)" },
      { id: "openai/gpt-5", name: "GPT-5 (OpenRouter)" },
      { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro (OpenRouter)" },
    ],
  },
  {
    provider: "google",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
  },
  {
    provider: "anthropic",
    models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
    ],
  },
  {
    provider: "openai",
    models: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "gpt-5-mini", name: "GPT-5 mini" },
    ],
  },
  { provider: "ollama", models: [{ id: "llama3.1", name: "Llama 3.1 (Ollama)" }] },
];

function fallbackModelProviders(warning: string): ModelProvider[] {
  return PI_FALLBACK_CATALOG.map((entry) => ({
    id: entry.provider,
    name: providerName(entry.provider),
    authenticated: false,
    warning,
    models: entry.models.map((model) => ({ ...model, available: false })),
  }));
}

/** Groups Pi `get_available_models` entries (already filtered to configured auth) by provider. */
export function piModelProviders(models: unknown): ModelProvider[] {
  const byProvider = new Map<string, ModelProvider>();
  if (!Array.isArray(models)) return [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    if (!provider || !id) continue;
    let entry = byProvider.get(provider);
    if (entry === undefined) {
      entry = { id: provider, name: providerName(provider), authenticated: true, models: [] };
      byProvider.set(provider, entry);
    }
    if (entry.models.some((existing) => existing.id === id)) continue;
    entry.models.push({ id, name: recordString(model, "name") || id, available: true });
  }
  return [...byProvider.values()];
}

// ---------------------------------------------------------------------------------------------
// Record helpers

type PiRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PiRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(input: unknown, key: string): unknown {
  return isRecord(input) ? input[key] : undefined;
}

function recordString(input: unknown, key: string): string | undefined {
  const value = recordField(input, key);
  return typeof value === "string" ? value : undefined;
}

function recordNumber(input: unknown, key: string): number | undefined {
  const value = recordField(input, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (recordField(part, "type") === "text" ? (recordString(part, "text") ?? "") : ""))
    .join("");
}

function stringifyArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

const ERROR_DETAIL_MAX_CHARS = 500;

function summarizeError(error: unknown): string {
  const text = typeof error === "string" ? error : JSON.stringify(error);
  if (text === undefined) return "unknown error";
  return text.length > ERROR_DETAIL_MAX_CHARS ? `${text.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : text;
}

export class PiRpcError extends Error {
  constructor(
    readonly operation: string,
    detail?: string,
  ) {
    super(`Pi RPC ${operation} failed${detail === undefined ? "" : `: ${detail}`}.`);
    this.name = "PiRpcError";
  }
}

// ---------------------------------------------------------------------------------------------
// JSONL framing. Pi splits records on LF only; U+2028/U+2029 are valid inside JSON strings, so
// node:readline must not be used. StringDecoder keeps multi-byte UTF-8 sequences split across
// chunks intact.

export function createJsonlFramer(maxRecordChars = MAX_RECORD_CHARS) {
  let buffer = "";
  let dropping = false;
  return (chunk: string): string[] => {
    const lines: string[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (!dropping) {
        if (buffer.length + end - start > maxRecordChars) {
          buffer = "";
          dropping = true;
        } else {
          buffer += chunk.slice(start, end);
        }
      }
      if (newline < 0) break;
      if (!dropping && buffer.length > 0) {
        lines.push(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      }
      buffer = "";
      dropping = false;
      start = newline + 1;
    }
    return lines;
  };
}

// ---------------------------------------------------------------------------------------------
// Process plumbing

interface PendingRequest {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PiRpcProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
  onRecord: (record: PiRecord) => void;
  onExit: (detail: string) => void;
}

/** One `pi --mode rpc` child with request/response correlation and process-group teardown. */
class PiRpcProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private exited = false;
  private down: PiRpcError | undefined;
  private readonly exitPromise: Promise<void>;

  constructor(private readonly options: PiRpcProcessOptions) {
    // Detached so close() can signal the whole group, including extension-spawned MCP servers.
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdoutDone = new Promise<void>((resolve) => {
      this.child.stdout!.once("end", resolve);
      this.child.stdout!.once("error", () => resolve());
    });
    const decoder = new StringDecoder("utf8");
    const frame = createJsonlFramer();
    const handleText = (text: string) => {
      for (const line of frame(text)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // Pi can print non-protocol startup noise; ignore it.
        }
        if (isRecord(parsed)) this.route(parsed);
      }
    };
    this.child.stdout!.on("data", (chunk: Buffer) => handleText(decoder.write(chunk)));
    this.child.stdout!.once("end", () => handleText(`${decoder.end()}\n`));
    // Drain stderr so a chatty child never blocks on a full pipe. Its text can contain prompts or
    // credentials, so it is not logged.
    this.child.stderr!.resume();
    // EPIPE after a crash surfaces through the exit path below.
    this.child.stdin!.on("error", () => undefined);

    this.exitPromise = new Promise<void>((resolve) => {
      const finish = (detail: string) => {
        if (this.exited) return;
        this.exited = true;
        // Give buffered stdout a moment to flush so a final agent_end is not lost.
        const drained = Promise.race([
          stdoutDone,
          new Promise<void>((r) => setTimeout(r, STDOUT_DRAIN_AFTER_EXIT_MS).unref()),
        ]);
        void drained.then(() => {
          this.failAll(new PiRpcError("read", detail));
          options.onExit(detail);
          resolve();
        });
      };
      this.child.once("error", (error: NodeJS.ErrnoException) =>
        finish(
          error.code === "ENOENT"
            ? `could not start ${options.command}: not found`
            : `could not start ${options.command}: ${error.message}`,
        ),
      );
      this.child.once("exit", (code, signal) => {
        finish(
          signal !== null
            ? `pi process killed by ${signal}`
            : `pi process exited with code ${code}`,
        );
      });
    });
  }

  private route(record: PiRecord): void {
    if (record["type"] === "response" && typeof record["id"] === "string") {
      const pending = this.pending.get(record["id"]);
      if (pending !== undefined) {
        this.pending.delete(record["id"]);
        clearTimeout(pending.timer);
        if (record["success"] === true) pending.resolve(record["data"]);
        else
          pending.reject(
            new PiRpcError(
              recordString(record, "command") ?? pending.command,
              summarizeError(record["error"]),
            ),
          );
        return;
      }
    }
    this.options.onRecord(record);
  }

  private failAll(error: PiRpcError): void {
    this.down ??= error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  send(record: PiRecord): void {
    if (this.down !== undefined) throw this.down;
    this.child.stdin!.write(`${JSON.stringify(record)}\n`);
  }

  request(record: PiRecord, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    const command = recordString(record, "type") ?? "request";
    if (this.down !== undefined) return Promise.reject(this.down);
    const id = `wb-${this.nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError(command, `timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { command, resolve, reject, timer });
      try {
        this.send({ ...record, id });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new PiRpcError(command, String(error)));
      }
    });
  }

  private signal(signal: NodeJS.Signals): boolean {
    const pid = this.child.pid;
    if (pid === undefined || this.exited) return false;
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * SIGTERM with stdin left open (Pi skips its SIGTERM cleanup on stdin EOF), then SIGKILL after
   * the grace period. `exited` is checked first so a recycled pid group is never signalled.
   */
  async terminate(graceMs: number): Promise<void> {
    this.failAll(new PiRpcError("terminate", "pi process was stopped"));
    if (this.exited || this.child.pid === undefined) return this.exitPromise;
    if (this.signal("SIGTERM")) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        this.exitPromise.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), graceMs);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) this.signal("SIGKILL");
    }
    await this.exitPromise;
  }
}

// ---------------------------------------------------------------------------------------------
// Bridge extension: approval gate + MCP servers.
//
// Pi leaves permission policy to extensions, so a session without `fullPermissions` loads this
// extension to ask before every non-read-only tool, through Pi's own `ctx.ui.confirm` dialog
// (surfaced to WildBots as `question.asked`). It also bridges the session's MCP servers into Pi
// tools named `mcp__<server>__<tool>`. Server configuration, which can hold credentials, is read
// from a 0600 file named by an env var so it never appears in argv.

export const PI_BRIDGE_EXTENSION_FILENAME = "wildbots-pi-bridge.ts";
export const PI_MCP_CONFIG_ENV = "WILDBOTS_PI_MCP_CONFIG";
export const PI_APPROVAL_ENV = "WILDBOTS_PI_APPROVAL";

export const PI_BRIDGE_EXTENSION_SOURCE = `\
// Generated by WildBots. Adapted from pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Type } from "typebox";

const CONFIG_ENV = ${JSON.stringify(PI_MCP_CONFIG_ENV)};
const APPROVAL_ENV = ${JSON.stringify(PI_APPROVAL_ENV)};
const PROTOCOL = "2025-06-18";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

type ServerSpec = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type Rpc = { id?: number; result?: unknown; error?: { message?: string } };
type Client = {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
};

function toolInputSummary(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    text = String(input);
  }
  return text.length <= 4_000 ? text : text.slice(0, 4_000) + "\\n... " + (text.length - 4_000) + " more characters";
}

function parseSseOrJson(body: string, contentType: string): Rpc {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\\n")) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (data.length === 0) continue;
      const parsed = JSON.parse(data) as Rpc;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) return parsed;
    }
    throw new Error("MCP SSE response had no JSON-RPC payload.");
  }
  return JSON.parse(body) as Rpc;
}

function httpClient(spec: ServerSpec): Client {
  let nextId = 1;
  let sessionId: string | undefined;
  const headers = () => ({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL,
    ...(spec.headers ?? {}),
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  });
  const post = async (payload: unknown, signal?: AbortSignal) => {
    const response = await fetch(spec.url!, { method: "POST", headers: headers(), body: JSON.stringify(payload), signal });
    const next = response.headers.get("mcp-session-id");
    if (next) sessionId = next;
    return response;
  };
  return {
    async request(method, params, signal) {
      const response = await post({ jsonrpc: "2.0", id: nextId++, method, params }, signal);
      const body = await response.text();
      if (!response.ok) throw new Error("MCP " + method + " failed (" + response.status + "): " + body.slice(0, 400));
      if (body.length === 0) return undefined;
      const parsed = parseSseOrJson(body, response.headers.get("content-type") ?? "");
      if (parsed.error) throw new Error(parsed.error.message ?? "MCP " + method + " returned an error");
      return parsed.result;
    },
    async notify(method, params) {
      await post({ jsonrpc: "2.0", method, params }).catch(() => undefined);
    },
    close() {},
  };
}

function stdioClient(spec: ServerSpec): Client {
  const child = spawn(spec.command!, spec.args ?? [], {
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.on("error", (error) => failAll(error));
  child.on("exit", () => failAll(new Error("MCP server " + spec.name + " exited")));
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let message: Rpc;
      try {
        message = JSON.parse(line) as Rpc;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const entry = pending.get(message.id);
      if (entry === undefined) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? "MCP request failed"));
      else entry.resolve(message.result);
    }
  });
  return {
    request(method, params, signal) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        signal?.addEventListener("abort", () => {
          pending.delete(id);
          reject(new Error("MCP " + method + " aborted"));
        }, { once: true });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
      });
    },
    async notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
    },
    close() {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

function jsonSchema(schema: Record<string, unknown> | undefined) {
  const unsafe = (Type as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  if (typeof unsafe === "function" && schema !== undefined) {
    return unsafe({ ...schema, type: schema.type ?? "object", ...(schema.properties === undefined ? { properties: {} } : {}) });
  }
  return Type.Object({}, { additionalProperties: true });
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function modelContent(result: unknown): Content[] {
  const record = (result ?? {}) as { content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>; structuredContent?: unknown };
  const content: Content[] = [];
  for (const part of Array.isArray(record.content) ? record.content : []) {
    if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
    else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
  }
  if (content.length === 0) content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? result ?? null) });
  return content;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

export default async function wildbotsBridge(pi: ExtensionAPI) {
  if (process.env[APPROVAL_ENV] === "required") {
    pi.on("tool_call", async (event, ctx) => {
      if (READ_ONLY_TOOLS.has(event.toolName)) return;
      const approved = await ctx.ui.confirm("Allow " + event.toolName + "?", toolInputSummary(event.input));
      if (!approved) return { block: true, reason: event.toolName + " was declined in WildBots." };
    });
  }

  const configPath = process.env[CONFIG_ENV];
  if (!configPath) return;
  let servers: ServerSpec[] = [];
  try {
    servers = JSON.parse(readFileSync(configPath, "utf8")).servers ?? [];
  } catch (error) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("WildBots MCP config unreadable: " + String(error), "warning");
    });
    return;
  }

  const clients: Client[] = [];
  pi.on("session_shutdown", async () => {
    for (const client of clients) client.close();
  });

  const failures: string[] = [];
  await Promise.all(servers.map(async (spec) => {
    try {
      const client = spec.transport === "http" ? httpClient(spec) : stdioClient(spec);
      clients.push(client);
      const signal = AbortSignal.timeout(15_000);
      await client.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "wildbots-pi", version: "1.0.0" } }, signal);
      await client.notify("notifications/initialized", {});
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = (await client.request("tools/list", cursor === undefined ? {} : { cursor }, signal)) as { tools?: McpTool[]; nextCursor?: string } | undefined;
        tools.push(...(page?.tools ?? []));
        cursor = page?.nextCursor;
      } while (cursor);
      for (const tool of tools) {
        pi.registerTool({
          name: "mcp__" + safeName(spec.name) + "__" + safeName(tool.name),
          label: spec.name + "/" + tool.name,
          description: tool.description ?? tool.name,
          parameters: jsonSchema(tool.inputSchema),
          async execute(_toolCallId, params, signal) {
            const result = await client.request("tools/call", { name: tool.name, arguments: params ?? {} }, signal);
            const content = modelContent(result);
            if ((result as { isError?: boolean } | undefined)?.isError === true) {
              throw new Error(content.map((part) => (part.type === "text" ? part.text : "")).join("\\n") || "MCP tool " + spec.name + "/" + tool.name + " returned an error");
            }
            return { content, details: { server: spec.name, tool: tool.name } };
          },
        });
      }
    } catch (error) {
      failures.push(spec.name + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }));
  if (failures.length > 0) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("WildBots MCP unavailable: " + failures.join("; "), "warning");
    });
  }
}
`;

// ---------------------------------------------------------------------------------------------
// Session

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const CONFIRM_YES = new Set(["allow", "yes", "y", "true", "approve", "accept", "confirm", "ok"]);

interface PendingQuestion {
  method: string;
  turnId: string;
}

interface ActiveTurn {
  turnId: string;
  started: boolean;
  interruptRequested: boolean;
  /** Text of the latest assistant message that produced any. */
  text: string;
  /** Deltas of the assistant message currently streaming. */
  streaming: string;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number | undefined;
  sawUsage: boolean;
  failure: string | undefined;
  aborted: boolean;
}

interface PiSessionInit {
  spec: HarnessSessionSpec;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  tempDir: string | undefined;
  requestTimeoutMs: number;
  terminationGraceMs: number;
  onFinalized: (session: PiHarnessSession) => void;
}

class PiHarnessSession implements HarnessSession {
  readonly id: string;
  providerSessionId: string | undefined;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  /** Events emitted before anyone subscribed, replayed to the first listener. */
  private backlog: HarnessEvent[] | undefined = [];
  private readonly rpc: PiRpcProcess;
  private turn: ActiveTurn | undefined;
  private readonly questions = new Map<string, PendingQuestion>();
  private closing = false;
  private closed = false;
  private contextWindow: number | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly init: PiSessionInit) {
    this.id = init.spec.sessionKey;
    this.rpc = new PiRpcProcess({
      command: init.command,
      args: init.args,
      cwd: init.spec.cwd,
      env: init.env,
      requestTimeoutMs: init.requestTimeoutMs,
      onRecord: (record) => this.handleRecord(record),
      onExit: (detail) => void this.handleExit(detail),
    });
  }

  async initialize(): Promise<void> {
    const { spec } = this.init;
    const state = await this.rpc.request({ type: "get_state" });
    // A resumed session restores its saved model; re-apply the requested one when they differ.
    const model = recordField(state, "model");
    if (spec.provider !== undefined && spec.model.length > 0) {
      const current = `${recordString(model, "provider")}/${recordString(model, "id")}`;
      if (current !== `${spec.provider}/${spec.model}`) {
        const applied = await this.rpc.request({
          type: "set_model",
          provider: spec.provider,
          modelId: spec.model,
        });
        this.contextWindow = recordNumber(applied, "contextWindow");
      }
    }
    this.contextWindow ??= recordNumber(model, "contextWindow") || undefined;
    const thinking = piThinkingLevel(spec.reasoning);
    if (thinking !== undefined && recordString(state, "thinkingLevel") !== thinking) {
      await this.rpc.request({ type: "set_thinking_level", level: thinking });
    }
    const providerSessionId =
      recordString(state, "sessionFile") ?? recordString(state, "sessionId");
    if (providerSessionId === undefined) {
      throw new PiRpcError("get_state", "returned neither sessionFile nor sessionId");
    }
    this.providerSessionId = providerSessionId;
    this.emit({ type: "session.ready", providerSessionId });
  }

  events(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    const backlog = this.backlog;
    this.backlog = undefined;
    for (const event of backlog ?? []) this.deliver(listener, event);
    return () => this.listeners.delete(listener);
  }

  private deliver(listener: (event: HarnessEvent) => void, event: HarnessEvent): void {
    try {
      listener(event);
    } catch {
      // A failing listener must not break the protocol pump or other listeners.
    }
  }

  private emit(event: HarnessEvent): void {
    if (this.backlog !== undefined) {
      this.backlog.push(event);
      return;
    }
    for (const listener of this.listeners) this.deliver(listener, event);
  }

  async startTurn(input: HarnessTurnInput): Promise<void> {
    if (this.closed || this.closing) throw new Error("Pi session is closed.");
    if (this.turn !== undefined) {
      throw new Error(
        `Pi turn ${this.turn.turnId} is still running; Pi does not support steering.`,
      );
    }
    const { message, images } = await buildPromptPayload(input);
    const turn: ActiveTurn = {
      turnId: input.turnId,
      started: false,
      interruptRequested: false,
      text: "",
      streaming: "",
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: undefined,
      sawUsage: false,
      failure: undefined,
      aborted: false,
    };
    this.turn = turn;
    try {
      await this.rpc.request({
        type: "prompt",
        message,
        ...(images.length === 0 ? {} : { images }),
      });
    } catch (error) {
      if (this.turn === turn) this.turn = undefined;
      throw error;
    }
  }

  async answerQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    const pending = this.questions.get(requestId);
    if (pending === undefined) throw new Error(`No pending Pi question ${requestId}.`);
    this.questions.delete(requestId);
    const answer = answers[requestId] ?? Object.values(answers)[0];
    this.rpc.send({ type: "extension_ui_response", id: requestId, ...uiResponse(pending, answer) });
  }

  async interrupt(turnId?: string): Promise<void> {
    const turn = this.turn;
    if (turn === undefined || (turnId !== undefined && turnId !== turn.turnId)) return;
    turn.interruptRequested = true;
    await this.rpc.request({ type: "abort" });
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true;
      await this.rpc.terminate(this.init.terminationGraceMs);
      // handleExit performs cleanup and the closed event once the process is gone.
      await this.handleExit("closed");
    })();
    return this.closePromise;
  }

  private exitHandled: Promise<void> | undefined;

  private handleExit(detail: string): Promise<void> {
    this.exitHandled ??= (async () => {
      this.closed = true;
      this.init.onFinalized(this);
      const turn = this.turn;
      this.turn = undefined;
      this.questions.clear();
      if (this.init.tempDir !== undefined) {
        await rm(this.init.tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (this.closing) {
        if (turn !== undefined) {
          this.emit({
            type: "turn.completed",
            turnId: turn.turnId,
            text: turn.streaming || turn.text,
            stopReason: "interrupted",
          });
        }
        this.emit({ type: "session.closed", reason: "closed", unexpected: false });
        return;
      }
      if (turn !== undefined) {
        this.emit({
          type: "turn.failed",
          turnId: turn.turnId,
          message: `Pi stopped unexpectedly: ${detail}.`,
          recoverable: true,
        });
      }
      this.emit({ type: "session.closed", reason: detail, unexpected: true });
    })();
    return this.exitHandled;
  }

  private handleRecord(record: PiRecord): void {
    const type = recordString(record, "type");
    if (type === "extension_ui_request") {
      this.handleUiRequest(record);
      return;
    }
    const turn = this.turn;
    if (turn === undefined) return; // Activity outside a WildBots turn (for example compaction).
    switch (type) {
      case "agent_start":
      case "turn_start":
        if (!turn.started) {
          turn.started = true;
          this.emit({ type: "turn.started", turnId: turn.turnId });
        }
        return;
      case "message_start":
        if (recordString(recordField(record, "message"), "role") === "assistant")
          turn.streaming = "";
        return;
      case "message_update": {
        const delta = recordField(record, "assistantMessageEvent");
        const deltaType = recordString(delta, "type");
        const text = recordString(delta, "delta") ?? "";
        if (text.length === 0) return;
        if (deltaType === "text_delta") {
          turn.streaming += text;
          this.emit({ type: "text.delta", turnId: turn.turnId, delta: text });
        } else if (deltaType === "thinking_delta") {
          this.emit({ type: "reasoning.delta", turnId: turn.turnId, delta: text });
        }
        return;
      }
      case "message_end":
        this.handleMessageEnd(turn, recordField(record, "message"));
        return;
      case "tool_execution_start":
        this.emit({
          type: "tool.started",
          turnId: turn.turnId,
          callId: recordString(record, "toolCallId") ?? "",
          name: recordString(record, "toolName") ?? "tool",
          ...optional("arguments", stringifyArgs(record["args"])),
        });
        return;
      case "tool_execution_end": {
        const output = contentText(recordField(recordField(record, "result"), "content"));
        const isError = record["isError"] === true;
        this.emit({
          type: "tool.completed",
          turnId: turn.turnId,
          callId: recordString(record, "toolCallId") ?? "",
          name: recordString(record, "toolName") ?? "tool",
          ...(isError
            ? { error: output || "Tool failed." }
            : optional("output", output.length > 0 ? output : undefined)),
        });
        return;
      }
      case "agent_end":
        this.finishTurn(turn);
        return;
      default:
        return;
    }
  }

  private handleMessageEnd(turn: ActiveTurn, message: unknown): void {
    if (recordString(message, "role") !== "assistant") return;
    const text = contentText(recordField(message, "content")) || turn.streaming;
    if (text.length > 0) turn.text = text;
    turn.streaming = "";
    const usage = recordField(message, "usage");
    if (isRecord(usage)) {
      const input = recordNumber(usage, "input") ?? 0;
      const cacheRead = recordNumber(usage, "cacheRead") ?? 0;
      const cacheWrite = recordNumber(usage, "cacheWrite") ?? 0;
      const output = recordNumber(usage, "output") ?? 0;
      // Pi's input and cache counters are disjoint, so the prompt size is their sum.
      turn.inputTokens += input + cacheRead + cacheWrite;
      turn.outputTokens += output;
      turn.contextTokens =
        recordNumber(usage, "totalTokens") ?? input + cacheRead + cacheWrite + output;
      turn.sawUsage = true;
    }
    const stopReason = recordString(message, "stopReason");
    if (stopReason === "error") {
      turn.failure = recordString(message, "errorMessage") ?? "Pi reported a model error.";
    } else if (stopReason === "aborted") {
      turn.aborted = true;
    } else {
      turn.failure = undefined; // A later successful retry supersedes an earlier error.
    }
  }

  private finishTurn(turn: ActiveTurn): void {
    this.turn = undefined;
    if (turn.streaming.length > 0) turn.text = turn.streaming;
    for (const [id, question] of this.questions) {
      if (question.turnId === turn.turnId) this.questions.delete(id);
    }
    if (!turn.started) this.emit({ type: "turn.started", turnId: turn.turnId });
    if (turn.sawUsage) {
      this.emit({
        type: "usage.reported",
        turnId: turn.turnId,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        ...optional("contextTokens", turn.contextTokens),
        ...optional("contextWindow", this.contextWindow),
      });
    }
    if (turn.aborted || turn.interruptRequested) {
      this.emit({
        type: "turn.completed",
        turnId: turn.turnId,
        text: turn.text,
        stopReason: "interrupted",
      });
      return;
    }
    if (turn.failure !== undefined) {
      this.emit({ type: "turn.failed", turnId: turn.turnId, message: turn.failure });
      return;
    }
    this.emit({
      type: "turn.completed",
      turnId: turn.turnId,
      text: turn.text,
      stopReason: "end_turn",
    });
  }

  private handleUiRequest(record: PiRecord): void {
    const method = recordString(record, "method");
    const id = recordString(record, "id");
    // notify, setStatus, setWidget, setTitle and set_editor_text are fire-and-forget TUI hints.
    if (method === undefined || id === undefined || !DIALOG_METHODS.has(method)) return;
    if (method === "confirm" && this.init.spec.fullPermissions) {
      this.rpc.send({ type: "extension_ui_response", id, confirmed: true });
      return;
    }
    const turn = this.turn;
    if (turn === undefined) {
      // Nobody can answer outside a turn; dismiss so the extension does not block forever.
      this.rpc.send({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    const title = recordString(record, "title")?.trim() || undefined;
    const detail = [recordString(record, "message"), recordString(record, "placeholder")].find(
      (text) => text !== undefined && text.trim().length > 0,
    );
    const prompt = detail ?? title ?? "Pi needs input.";
    const options =
      method === "confirm"
        ? ["Allow", "Deny"]
        : method === "select" && Array.isArray(record["options"])
          ? record["options"].filter((option): option is string => typeof option === "string")
          : undefined;
    const question: HarnessQuestion = {
      id,
      ...optional("header", title),
      question: prompt,
      ...optional("options", options),
    };
    this.questions.set(id, { method, turnId: turn.turnId });
    this.emit({
      type: "question.asked",
      turnId: turn.turnId,
      requestId: id,
      ...optional("title", title),
      prompt,
      questions: [question],
    });
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function uiResponse(pending: PendingQuestion, answer: string | undefined): PiRecord {
  // Pi distinguishes an empty value from a dismissed dialog.
  if (answer === undefined) return { cancelled: true };
  if (pending.method === "confirm") {
    return { confirmed: CONFIRM_YES.has(answer.trim().toLowerCase()) };
  }
  return { value: answer };
}

async function buildPromptPayload(input: HarnessTurnInput): Promise<{
  message: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}> {
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const files: string[] = [];
  for (const attachment of input.attachments ?? []) {
    files.push(`- ${attachment.name} (${attachment.mime}): ${attachment.path}`);
    if (attachment.mime.startsWith("image/")) {
      const bytes = await readFile(attachment.path);
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: attachment.mime });
    }
  }
  const message =
    files.length === 0 ? input.text : `${input.text}\n\nAttached files:\n${files.join("\n")}`;
  return { message, images };
}

// ---------------------------------------------------------------------------------------------
// Driver

const CAPABILITIES: HarnessDriverCapabilities = {
  nativeSteering: false,
  resumable: true,
  supportsMcp: true,
  supportsImages: true,
  supportsReasoning: true,
  supportsSpeed: false,
};

function runOnce(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<
  | { kind: "exit"; code: number | null; stdout: string; stderr: string }
  | { kind: "error"; error: NodeJS.ErrnoException }
  | { kind: "timeout" }
> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ kind: "timeout" });
    }, timeoutMs);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ kind: "error", error });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ kind: "exit", code, stdout, stderr });
    });
  });
}

export function createPiDriver(options: PiDriverOptions = {}): HarnessDriver {
  const command = options.command ?? "pi";
  const prefixArgs = options.args ?? [];
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const baseEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...options.env });
  const sessions = new Set<PiHarnessSession>();

  async function probe(): Promise<HarnessProbeResult> {
    const result = await runOnce(command, [...prefixArgs, "--version"], baseEnv(), probeTimeoutMs);
    if (result.kind === "error") {
      return {
        available: false,
        reason:
          result.error.code === "ENOENT"
            ? `Pi CLI (${command}) was not found. Install it with npm install -g @earendil-works/pi-coding-agent.`
            : `Pi CLI could not start: ${result.error.message}`,
      };
    }
    if (result.kind === "timeout") {
      return {
        available: false,
        reason: `Pi CLI timed out running --version after ${probeTimeoutMs}ms.`,
      };
    }
    const version = /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(result.stdout)?.[0];
    if (result.code !== 0) {
      return {
        available: false,
        ...optional("version", version),
        reason: `Pi CLI exited with code ${result.code} running --version.`,
      };
    }
    if (version === undefined) {
      return { available: false, reason: "Could not read the Pi version from `pi --version`." };
    }
    return { available: true, version };
  }

  async function listModels(): Promise<ModelProvider[]> {
    // A short-lived, side-effect-free process: no session file, no extensions, no network refresh.
    const rpc = new PiRpcProcess({
      command,
      args: [...prefixArgs, "--mode", "rpc", "--no-session", "--no-extensions", "--offline"],
      cwd: os.homedir(),
      env: baseEnv(),
      requestTimeoutMs,
      onRecord: () => undefined,
      onExit: () => undefined,
    });
    try {
      const data = await rpc.request({ type: "get_available_models" });
      return piModelProviders(recordField(data, "models"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fallbackModelProviders(`Pi did not report its configured models: ${detail}`);
    } finally {
      await rpc.terminate(terminationGraceMs);
    }
  }

  async function openSession(spec: HarnessSessionSpec): Promise<HarnessSession> {
    if (spec.osUser !== undefined && spec.osUser !== os.userInfo().username) {
      throw new Error(
        `The Pi driver cannot run as OS user ${spec.osUser}; it runs as ${os.userInfo().username}.`,
      );
    }
    const mcpServers = spec.mcpServers ?? [];
    const needsBridge = mcpServers.length > 0 || !spec.fullPermissions;
    const needsTemp = needsBridge || (spec.systemPrompt?.length ?? 0) > 0;
    const tempDir = needsTemp
      ? await mkdtemp(path.join(options.tempDir ?? os.tmpdir(), "wildbots-pi-"))
      : undefined;
    const args = [...prefixArgs, "--mode", "rpc"];
    if (spec.resumeSessionId !== undefined) args.push("--session", spec.resumeSessionId);
    if (spec.provider !== undefined) args.push("--provider", spec.provider);
    if (spec.model.length > 0) args.push("--model", spec.model);
    const thinking = piThinkingLevel(spec.reasoning);
    if (thinking !== undefined) args.push("--thinking", thinking);
    const env: NodeJS.ProcessEnv = { ...baseEnv(), ...spec.env };
    // Inherited bridge settings belong to some other session.
    delete env[PI_MCP_CONFIG_ENV];
    delete env[PI_APPROVAL_ENV];
    try {
      if (tempDir !== undefined && spec.systemPrompt) {
        // Pi reads --append-system-prompt from a file when the value is an existing path, which
        // keeps a large or private prompt out of argv and `ps`.
        const promptPath = path.join(tempDir, "system-prompt.md");
        await writeFile(promptPath, spec.systemPrompt, { mode: 0o600 });
        args.push("--append-system-prompt", promptPath);
      }
      if (tempDir !== undefined && needsBridge) {
        const extensionPath = path.join(tempDir, PI_BRIDGE_EXTENSION_FILENAME);
        await writeFile(extensionPath, PI_BRIDGE_EXTENSION_SOURCE, { mode: 0o600 });
        args.push("--extension", extensionPath);
        if (!spec.fullPermissions) env[PI_APPROVAL_ENV] = "required";
        if (mcpServers.length > 0) {
          const configPath = path.join(tempDir, "mcp-servers.json");
          await writeFile(configPath, JSON.stringify({ servers: mcpServers }), { mode: 0o600 });
          env[PI_MCP_CONFIG_ENV] = configPath;
        }
      }
    } catch (error) {
      if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
    const session = new PiHarnessSession({
      spec,
      command,
      args,
      env,
      tempDir,
      requestTimeoutMs,
      terminationGraceMs,
      onFinalized: (finished) => sessions.delete(finished),
    });
    try {
      await session.initialize();
    } catch (error) {
      await session.close();
      throw error;
    }
    sessions.add(session);
    return session;
  }

  return {
    id: "pi",
    displayName: "Pi",
    capabilities: CAPABILITIES,
    probe,
    listModels,
    openSession,
    async close() {
      await Promise.all([...sessions].map((session) => session.close()));
    },
  };
}
