/*
 * Adapted from pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.
 * See the MIT license notice in codex-driver.ts.
 */
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";

export type JsonRpcId = string | number;

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

export type JsonRpcRespond = (result: unknown) => Promise<void>;

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

interface StdioOptions {
  command: string;
  args: readonly string[];
  cwd?: SpawnOptionsWithoutStdio["cwd"];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onNotification?(notification: JsonRpcNotification): void;
  onRequest?(
    request: JsonRpcRequest,
    respond: JsonRpcRespond,
    signal: AbortSignal,
  ): void | Promise<void>;
  onClose?(reason: Error, unexpected: boolean): void;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(reason: Error): void;
}

const MAX_LINE_BYTES = 128 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const EXIT_GRACE_MS = 250;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

export function openJsonRpcStdio(options: StdioOptions) {
  const ownProcessGroup = process.platform !== "win32";
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: ownProcessGroup,
    stdio: "pipe",
    windowsHide: true,
  });
  const pending = new Map<number, PendingRequest>();
  const incoming = new Map<JsonRpcId, AbortController>();
  const lineParts: Buffer[] = [];
  let lineBytes = 0;
  let stderrTail: Buffer = Buffer.alloc(0);
  let nextId = 0;
  let writeQueue = Promise.resolve();
  let stopping: Error | undefined;
  let intentional = false;
  let exitGrace: NodeJS.Timeout | undefined;
  let terminateTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let finishTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function diagnostics(message: string) {
    // A peer can echo arbitrary inputs on stderr or in RPC errors. Only expose the byte count.
    return new Error(
      stderrTail.length ? `${message} (captured ${stderrTail.length} stderr bytes)` : message,
    );
  }

  function signalProcess(signal: NodeJS.Signals) {
    try {
      if (ownProcessGroup && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The process group may already be gone.
    }
  }

  function shutdown(reason: Error, expected = false) {
    if (stopping) return;
    stopping = reason;
    intentional = expected;
    for (const request of pending.values()) request.reject(reason);
    for (const controller of incoming.values()) controller.abort();
    incoming.clear();

    // EOF lets the peer flush its state. Escalate if it or a descendant keeps the pipes open.
    child.stdin.end();
    terminateTimer = setTimeout(() => signalProcess("SIGTERM"), EXIT_GRACE_MS);
    killTimer = setTimeout(() => signalProcess("SIGKILL"), 2 * EXIT_GRACE_MS);
    finishTimer = setTimeout(finish, 3 * EXIT_GRACE_MS);
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(exitGrace);
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
    clearTimeout(finishTimer);
    const reason = stopping ?? diagnostics("JSON-RPC process closed");
    if (ownProcessGroup) signalProcess("SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    lineParts.length = 0;
    stderrTail = Buffer.alloc(0);
    resolveClosed();
    options.onClose?.(reason, !intentional);
  }

  function send(message: object, shouldSend = () => true): Promise<boolean> {
    // Only one write may be buffered by the stream. A canceled queued RPC never sends its frame.
    const write = writeQueue.then(
      () =>
        new Promise<boolean>((resolve, reject) => {
          if (stopping) return reject(stopping);
          if (!shouldSend()) return resolve(false);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`, (error) => {
            if (error) reject(diagnostics("Could not write to JSON-RPC process"));
            else resolve(true);
          });
        }),
    );
    writeQueue = write.then(
      () => {},
      () => {},
    );
    return write;
  }

  function request(
    method: string,
    params?: unknown,
    {
      signal,
      timeoutMs = options.requestTimeoutMs ?? 15_000,
    }: {
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    if (stopping) return Promise.reject(stopping);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const abort = () => fail(new Error(`JSON-RPC ${method} canceled`));
      const clear = () => {
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const fail = (reason: Error) => {
        clear();
        reject(reason);
      };
      const timer = setTimeout(() => fail(new Error(`JSON-RPC ${method} timed out`)), timeoutMs);
      pending.set(id, {
        method,
        resolve(value) {
          clear();
          resolve(value);
        },
        reject: fail,
      });
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      void send({ id, method, params }, () => pending.has(id)).catch(fail);
    });
  }

  async function handleRequest(request: JsonRpcRequest) {
    if (incoming.has(request.id) || stopping) return;
    const controller = new AbortController();
    incoming.set(request.id, controller);
    let responding = false;
    const respond = async (response: object) => {
      if (responding || controller.signal.aborted) throw new Error("JSON-RPC request is resolved");
      responding = true;
      try {
        const sent = await send({ id: request.id, ...response }, () => !controller.signal.aborted);
        if (!sent) throw new Error("JSON-RPC request was canceled");
      } finally {
        if (incoming.get(request.id) === controller) incoming.delete(request.id);
      }
    };
    try {
      if (!options.onRequest) throw new JsonRpcError(-32601, "Method not found");
      await options.onRequest(
        request,
        (result) => respond({ result: result ?? null }),
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (responding) throw error;
      await respond({
        error:
          error instanceof JsonRpcError
            ? { code: error.code, message: error.message }
            : { code: -32603, message: "Request handler failed" },
      });
    }
  }

  function cancelServerRequest(id: JsonRpcId) {
    const controller = incoming.get(id);
    incoming.delete(id);
    controller?.abort();
  }

  function dispatch(line: string) {
    if (!line.trim()) return;
    try {
      const message: unknown = JSON.parse(line);
      // Codex app-server elides the version field. Accept that framing alongside JSON-RPC 2.0.
      if (!isObject(message) || (message.jsonrpc !== undefined && message.jsonrpc !== "2.0"))
        throw new Error();
      const { id, method, params } = message;
      if (typeof method === "string") {
        if (isId(id)) {
          void handleRequest({ id, method, params }).catch(() => {
            if (!stopping) shutdown(diagnostics("Could not respond to JSON-RPC server request"));
          });
        } else if (id === undefined) {
          options.onNotification?.({ method, params });
        } else {
          throw new Error();
        }
      } else if (typeof id === "number") {
        const request = pending.get(id);
        if (!request) return;
        if (isObject(message.error) && typeof message.error.code === "number")
          request.reject(
            new JsonRpcError(
              message.error.code,
              `JSON-RPC ${request.method} failed (${message.error.code})`,
            ),
          );
        else if ("result" in message) request.resolve(message.result);
        else throw new Error();
      } else {
        throw new Error();
      }
    } catch {
      shutdown(diagnostics("Invalid JSON-RPC message from process"));
    }
  }

  child.stdout.on("data", (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length && !stopping) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      lineBytes += end - start;
      if (lineBytes > MAX_LINE_BYTES) {
        shutdown(diagnostics("JSON-RPC message exceeds the line size limit"));
        return;
      }
      if (end > start) lineParts.push(chunk.subarray(start, end));
      if (newline === -1) return;
      // Decode only after all bytes arrive, including any split UTF-8 code point.
      const line = Buffer.concat(lineParts, lineBytes).toString("utf8");
      lineParts.length = 0;
      lineBytes = 0;
      dispatch(line);
      start = end + 1;
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const head = Math.max(0, stderrTail.length + chunk.length - STDERR_TAIL_BYTES);
    stderrTail = Buffer.concat([
      stderrTail.subarray(head),
      chunk.subarray(Math.max(0, head - stderrTail.length)),
    ]);
  });

  function exitReason() {
    if (child.signalCode) return diagnostics(`JSON-RPC process exited on ${child.signalCode}`);
    if (child.exitCode !== null)
      return diagnostics(`JSON-RPC process exited with code ${child.exitCode}`);
    return diagnostics("JSON-RPC process closed its pipes");
  }

  function scheduleExit() {
    // Drain stdout/stderr before reporting exit. Descendants can inherit the pipes.
    exitGrace ??= setTimeout(() => shutdown(exitReason()), EXIT_GRACE_MS);
  }

  child.once("error", (error: NodeJS.ErrnoException) => {
    const reason =
      error.code === "ENOENT"
        ? "JSON-RPC executable or cwd was not found"
        : "Could not start JSON-RPC process";
    shutdown(diagnostics(reason));
  });
  child.stdout.once("error", scheduleExit);
  child.stderr.once("error", scheduleExit);
  child.stdin.on("error", scheduleExit);
  child.stdout.once("end", scheduleExit);
  child.once("exit", scheduleExit);
  child.once("close", () => {
    shutdown(exitReason());
    finish();
  });

  return {
    request,
    async notify(method: string, params?: unknown): Promise<void> {
      await send({ method, params });
    },
    cancelServerRequest,
    close(): Promise<void> {
      shutdown(new Error("JSON-RPC process closed by client"), true);
      return closed;
    },
    terminate(reason: Error): Promise<void> {
      shutdown(reason);
      return closed;
    },
  };
}
