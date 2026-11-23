// Adapted from pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// The upstream license notice is in grok-driver.ts.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type RpcId = number | string;
type RpcObject = Record<string, unknown>;
type RpcHandler = (method: string, params: unknown) => unknown;

const MAX_FRAME_LENGTH = 32 * 1024 * 1024;
const STDERR_TAIL_LENGTH = 4096;
const TERMINATION_GRACE_MS = 250;

export function acpRecord(value: unknown): RpcObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RpcObject)
    : undefined;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface AcpStdioOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onNotification?: RpcHandler;
  onRequest?: RpcHandler;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface AcpExit {
  reason: Error;
  unexpected: boolean;
}

/** One ACP peer. The driver supplies protocol method names and handles agent requests. */
export class AcpStdio {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exit = deferred<AcpExit>();
  readonly closed = this.exit.promise;
  private nextId = 0;
  private frame = "";
  private stderr = "";
  private stopping?: Error;
  private intentional = false;
  private ended = false;
  private terminateTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: AcpStdioOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_LENGTH);
    });
    this.child.on("error", (error) => this.stop(error));
    // The child can close its input before Node reports its exit. The write
    // callback and process close handle pending operations in that case.
    this.child.stdin.on("error", () => undefined);
    this.child.stdout.on("error", (error) => this.stop(error));
    this.child.stderr.on("error", (error) => this.stop(error));
    this.child.once("exit", () => {
      // MCP subprocesses may still have the agent's pipes open.
      if (process.platform !== "win32") this.signal("SIGKILL");
    });
    this.child.once("close", (code, signal) => {
      this.ended = true;
      clearTimeout(this.terminateTimer);
      clearTimeout(this.killTimer);
      const status = signal ?? (code === null ? "an unknown status" : `exit code ${code}`);
      const diagnostics = this.stderr.trim();
      const reason =
        this.stopping ??
        new Error(`ACP agent exited with ${status}${diagnostics ? `: ${diagnostics}` : ""}`);
      for (const request of this.pending.values()) request.reject(reason);
      this.exit.resolve({ reason, unexpected: !this.intentional });
    });
  }

  request(
    method: string,
    params: RpcObject,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const { signal, timeoutMs = this.options.requestTimeoutMs ?? 20_000 } = options;
    if (this.stopping || this.ended) {
      return Promise.reject(this.stopping ?? new Error("ACP agent connection is closed"));
    }
    const aborted = new Error(`ACP request cancelled: ${method}`);
    if (signal?.aborted) return Promise.reject(aborted);

    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(aborted);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        this.stop(new Error(`ACP request timed out after ${timeoutMs} ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.write({ jsonrpc: "2.0", id, method, params }).catch((error: Error) => this.stop(error));
    });
  }

  notify(method: string, params: RpcObject): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (!this.stopping && !this.ended) {
      this.intentional = true;
      this.stop(new Error("ACP agent connection closed"));
    }
    await this.closed;
  }

  private stop(error: Error) {
    if (this.stopping || this.ended) return;
    this.stopping = error;
    for (const request of this.pending.values()) request.reject(error);
    this.child.stdin.end();
    this.terminateTimer = setTimeout(() => this.signal("SIGTERM"), TERMINATION_GRACE_MS);
    this.killTimer = setTimeout(() => {
      this.signal("SIGKILL");
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }, 2 * TERMINATION_GRACE_MS);
  }

  private signal(signal: NodeJS.Signals) {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      this.child.kill(signal);
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      // The process group may already be gone.
    }
  }

  private write(message: RpcObject): Promise<void> {
    if (this.stopping || this.ended) {
      return Promise.reject(this.stopping ?? new Error("ACP agent connection is closed"));
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private read(chunk: string) {
    let start = 0;
    while (!this.stopping && start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline === -1 ? chunk.length : newline;
      if (this.frame.length + end - start > MAX_FRAME_LENGTH) {
        this.stop(new Error("ACP agent exceeded the maximum JSON-RPC frame length"));
        return;
      }
      this.frame += chunk.slice(start, end);
      if (newline === -1) return;
      const frame = this.frame.trim();
      this.frame = "";
      start = newline + 1;
      if (frame) this.receive(frame);
    }
  }

  private receive(frame: string) {
    let message: RpcObject | undefined;
    try {
      message = acpRecord(JSON.parse(frame));
    } catch {
      this.stop(new Error("ACP agent sent malformed JSON on stdout"));
      return;
    }
    if (message?.jsonrpc !== "2.0") {
      this.stop(new Error("ACP agent sent an invalid JSON-RPC envelope"));
      return;
    }
    const { id, method, params, result } = message;
    if (typeof method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        void this.respond(id, method, params);
      } else if (id === undefined) {
        try {
          this.options.onNotification?.(method, params);
        } catch (cause) {
          this.stop(new Error(`ACP client could not handle ${method}`, { cause }));
        }
      }
      return;
    }
    const request = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!request) return;
    const error = acpRecord(message.error);
    if (typeof error?.code === "number" && typeof error.message === "string") {
      request.reject(new AcpRpcError(error.code, error.message));
    } else if (Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) {
      request.resolve(result);
    } else {
      this.stop(new Error("ACP agent sent an invalid JSON-RPC response"));
    }
  }

  private async respond(id: RpcId, method: string, params: unknown) {
    let response: RpcObject;
    try {
      const result = await this.options.onRequest?.(method, params);
      if (result === undefined) throw new AcpRpcError(-32601, "Method not found");
      response = { result };
    } catch (error) {
      response = {
        error:
          error instanceof AcpRpcError
            ? { code: error.code, message: error.message }
            : { code: -32603, message: "Client could not handle the request" },
      };
    }
    try {
      await this.write({ jsonrpc: "2.0", id, ...response });
    } catch (error) {
      this.stop(error as Error);
    }
  }
}
