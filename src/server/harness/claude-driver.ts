/**
 * Claude Code harness driver over the CLI's bidirectional `stream-json` stdio protocol.
 *
 * Adapted from pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.
 * Sources: apps/server/src/provider/ClaudeProvider.ts, Drivers/ClaudeDriver.ts,
 * ClaudeModelCatalog.ts and ClaudeTurnTokenUsage.ts.
 *
 * The driver speaks the same newline-delimited JSON protocol that `@anthropic-ai/claude-agent-sdk`
 * wraps: the host writes `user` and `control_request` frames to stdin, and the CLI streams
 * `system`, `stream_event`, `assistant`, `user`, `control_request`, `control_response` and `result`
 * frames on stdout. Driving the CLI directly keeps the SDK out of the lockfile and behaves the same
 * under Node and Bun.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chown, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { ModelProvider } from "../../shared/types.js";
import type {
  HarnessAttachment,
  HarnessDriver,
  HarnessDriverCapabilities,
  HarnessEvent,
  HarnessMcpServerSpec,
  HarnessProbeResult,
  HarnessQuestion,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTurnInput,
} from "./driver.js";

/** One entry of the bundled Claude catalog. `minVersion` is the oldest CLI that serves it. */
export interface ClaudeCatalogModel {
  id: string;
  name: string;
  minVersion?: string;
}

/**
 * Current models from t3code's bundled manifest (`currentModels.claudeAgent`), with the minimum
 * Claude Code version each one needs. Fable stays last so a picker never defaults to it.
 */
export const CLAUDE_MODEL_CATALOG: readonly ClaudeCatalogModel[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", minVersion: "2.1.280" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", minVersion: "2.1.284" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", minVersion: "2.1.293" },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", minVersion: "2.1.321" },
];

export interface ClaudeDriverOptions {
  /** Executable to launch. Defaults to `claude` on PATH. */
  command?: string;
  /** Arguments placed before every driver argument, such as a script path for a test double. */
  args?: string[];
  /** Environment overrides applied on top of `process.env` for every launch. */
  env?: Record<string, string>;
  /** Replaces the bundled catalog. */
  models?: readonly ClaudeCatalogModel[];
  /** Effective user id lookup. Defaults to `process.getuid`. */
  getuid?: () => number | undefined;
  probeTimeoutMs?: number;
  startupTimeoutMs?: number;
  interruptTimeoutMs?: number;
  /** Time to wait for a clean exit after stdin closes before sending SIGTERM. */
  closeGraceMs?: number;
  /** Time to wait after SIGTERM before sending SIGKILL. */
  killGraceMs?: number;
}

const CAPABILITIES: HarnessDriverCapabilities = {
  nativeSteering: false,
  resumable: true,
  supportsMcp: true,
  supportsImages: true,
  supportsReasoning: true,
  supportsSpeed: true,
};

const STREAM_ARGS = [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
] as const;

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Linux caps one argv string at 128 KiB; longer prompts go through a file. */
const INLINE_SYSTEM_PROMPT_LIMIT = 64 * 1024;
const STDERR_TAIL_LIMIT = 4096;

/** WildBots reasoning levels mapped onto `claude --effort` (low, medium, high, xhigh, max). */
const EFFORT_BY_REASONING: Record<string, string> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "max",
};

export function createClaudeDriver(options: ClaudeDriverOptions = {}): HarnessDriver {
  const command = options.command ?? "claude";
  const prefixArgs = options.args ?? [];
  const catalog = options.models ?? CLAUDE_MODEL_CATALOG;
  const getuid = options.getuid ?? (() => process.getuid?.());
  let probed: Promise<HarnessProbeResult> | undefined;

  const baseEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...options.env });

  const probe = async (): Promise<HarnessProbeResult> => {
    const result = await runCommand(
      command,
      [...prefixArgs, "--version"],
      baseEnv(),
      options.probeTimeoutMs ?? 10_000,
    );
    if (result.error) return { available: false, reason: result.error };
    if (result.code !== 0) {
      const detail = lastLine(result.stderr) || lastLine(result.stdout);
      return {
        available: false,
        reason: `\`${command} --version\` exited with ${result.code}${detail ? `: ${detail}` : ""}`,
      };
    }
    const version = parseCliVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      return { available: false, reason: `\`${command} --version\` printed no version` };
    }
    return { available: true, version };
  };

  return {
    id: "claude-code",
    displayName: "Claude Code",
    capabilities: CAPABILITIES,
    probe: () => {
      probed = probe();
      return probed;
    },
    async listModels(): Promise<ModelProvider[]> {
      const [status, auth] = await Promise.all([
        (probed ??= probe()),
        runCommand(
          command,
          [...prefixArgs, "auth", "status", "--json"],
          baseEnv(),
          options.probeTimeoutMs ?? 10_000,
        ),
      ]);
      const authenticated = parseLoggedIn(auth.stdout);
      const warnings: string[] = [];
      if (!status.available) warnings.push(status.reason ?? "Claude Code is unavailable.");
      else if (!authenticated)
        warnings.push("Claude Code is not signed in. Run `claude auth login`.");
      const models = catalog.map((model) => {
        const supported =
          status.version !== undefined &&
          (!model.minVersion || compareVersions(status.version, model.minVersion) >= 0);
        return { id: model.id, name: model.name, available: status.available && supported };
      });
      const outdated = catalog.filter(
        (model) =>
          status.version !== undefined &&
          model.minVersion &&
          compareVersions(status.version, model.minVersion) < 0,
      );
      if (outdated.length > 0) {
        warnings.push(
          `Update Claude Code to use ${outdated.map((model) => model.name).join(", ")}.`,
        );
      }
      return [
        {
          id: "anthropic",
          name: "Anthropic",
          aliases: ["claude", "claude-code"],
          authenticated,
          ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          models,
        },
      ];
    },
    openSession: (spec) =>
      openClaudeSession(spec, {
        command,
        prefixArgs,
        env: baseEnv(),
        getuid,
        startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
        interruptTimeoutMs: options.interruptTimeoutMs ?? 5_000,
        closeGraceMs: options.closeGraceMs ?? 3_000,
        killGraceMs: options.killGraceMs ?? 2_000,
      }),
  };
}

interface LaunchContext {
  command: string;
  prefixArgs: string[];
  env: NodeJS.ProcessEnv;
  getuid: () => number | undefined;
  startupTimeoutMs: number;
  interruptTimeoutMs: number;
  closeGraceMs: number;
  killGraceMs: number;
}

interface LaunchUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

interface PendingQuestion {
  input: Record<string, unknown>;
  /** HarnessQuestion id → the question text Claude keys its answers by. */
  textById: Map<string, string>;
}

interface PendingControl {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
}

interface ActiveTurn {
  id: string;
  interrupted: boolean;
  text: string;
  contextTokens?: number;
}

type Frame = Record<string, unknown>;

async function openClaudeSession(
  spec: HarnessSessionSpec,
  ctx: LaunchContext,
): Promise<HarnessSession> {
  const uid = ctx.getuid();
  const osUser = spec.osUser?.trim() || undefined;
  // Claude Code refuses bypassPermissions as root, so fail before spawning with a clear reason.
  if (spec.fullPermissions && uid === 0 && (!osUser || osUser === "root")) {
    throw new Error(
      "Claude Code refuses full permissions (bypassPermissions) when running as root. Set a non-root osUser for this bot.",
    );
  }
  const launchUser = await resolveLaunchUser(osUser, uid);
  if (spec.fullPermissions && uid === 0 && launchUser?.uid === 0) {
    throw new Error(
      `Claude Code refuses full permissions (bypassPermissions) when running as root, and osUser "${osUser}" is uid 0.`,
    );
  }

  let tempDir: string | undefined;
  const ensureTempDir = async () => {
    tempDir ??= await mkdtemp(join(tmpdir(), "wildbots-claude-"));
    return tempDir;
  };
  const cleanupTemp = async () => {
    const dir = tempDir;
    tempDir = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  };

  const providerSessionIdAtLaunch = spec.resumeSessionId ?? randomUUID();
  const args = [...ctx.prefixArgs, ...STREAM_ARGS, "--permission-prompt-tool", "stdio"];
  if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
  else args.push("--session-id", providerSessionIdAtLaunch);
  if (spec.model.trim()) args.push("--model", spec.model.trim());
  const effort = spec.reasoning ? EFFORT_BY_REASONING[spec.reasoning] : undefined;
  if (effort) args.push("--effort", effort);
  if (spec.speed === "fast" || spec.speed === "ultrafast") {
    args.push("--settings", JSON.stringify({ fastMode: true }));
  }
  if (spec.fullPermissions) {
    args.push("--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions");
  }

  const env: NodeJS.ProcessEnv = { ...ctx.env, ...spec.env };
  if (launchUser) {
    env.HOME = launchUser.home;
    env.USER = launchUser.name;
    env.LOGNAME = launchUser.name;
  }

  try {
    const privateFiles: string[] = [];
    if (spec.systemPrompt) {
      if (Buffer.byteLength(spec.systemPrompt) <= INLINE_SYSTEM_PROMPT_LIMIT) {
        args.push("--append-system-prompt", spec.systemPrompt);
      } else {
        const file = join(await ensureTempDir(), "system-prompt.md");
        await writeFile(file, spec.systemPrompt, { mode: 0o600 });
        privateFiles.push(file);
        args.push("--append-system-prompt-file", file);
      }
    }
    if (spec.mcpServers && spec.mcpServers.length > 0) {
      const file = join(await ensureTempDir(), "mcp.json");
      // Headers and env can carry tokens, so the file is private to the session user.
      await writeFile(file, JSON.stringify(claudeMcpConfig(spec.mcpServers)), { mode: 0o600 });
      privateFiles.push(file);
      args.push("--mcp-config", file, "--strict-mcp-config");
      // WildBots supplies memory through its own MCP server.
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    }
    if (launchUser && tempDir) {
      await chown(tempDir, launchUser.uid, launchUser.gid);
      for (const file of privateFiles) await chown(file, launchUser.uid, launchUser.gid);
    }
  } catch (error) {
    await cleanupTemp();
    throw error;
  }

  let child: ChildProcess;
  try {
    child = spawn(ctx.command, args, {
      cwd: spec.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // A process group lets close() reach tool subprocesses when it has to force-kill.
      detached: process.platform !== "win32",
      ...(launchUser ? { uid: launchUser.uid, gid: launchUser.gid } : {}),
    });
  } catch (error) {
    await cleanupTemp();
    throw error;
  }

  return new ClaudeSession(spec, ctx, child, providerSessionIdAtLaunch, cleanupTemp).start();
}

class ClaudeSession implements HarnessSession {
  readonly id: string;
  providerSessionId: string | undefined;

  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private buffered: HarnessEvent[] | undefined = [];
  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly toolNames = new Map<string, string>();
  private turn: ActiveTurn | undefined;
  private announcedSessionId: string | undefined;
  private stderrTail = "";
  private model: string | undefined;
  private readonly fullPermissions: boolean;
  private closing = false;
  private exited = false;
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(
    spec: HarnessSessionSpec,
    private readonly ctx: LaunchContext,
    private readonly child: ChildProcess,
    providerSessionId: string,
    private readonly cleanupTemp: () => Promise<void>,
  ) {
    this.id = spec.sessionKey;
    this.providerSessionId = providerSessionId;
    this.model = spec.model.trim() || undefined;
    this.fullPermissions = spec.fullPermissions;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  async start(): Promise<this> {
    const { child } = this;
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
      this.onExit(null, null, error);
    });
    child.once("exit", (code, signal) => this.onExit(code, signal));
    child.stdin?.on("error", () => {
      // EPIPE after the CLI exits; the exit handler reports it.
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => this.onLine(line));
    }

    // The SDK's initialize handshake proves the CLI is alive and speaking stream-json.
    try {
      await withTimeout(
        this.request({ subtype: "initialize" }),
        this.ctx.startupTimeoutMs,
        "Claude Code did not answer the initialize request",
      );
    } catch (error) {
      await this.terminate();
      const reason = spawnError
        ? describeSpawnError(this.ctx.command, spawnError)
        : `${errorMessage(error)}${this.stderrSuffix()}`;
      throw new Error(`Claude Code failed to start: ${reason}`);
    }
    // The CLI sends its system/init frame only once the first user message arrives, but the session
    // ID is fixed at launch by --session-id or --resume. Announce it now so callers can wait for it.
    if (this.providerSessionId) {
      this.announcedSessionId = this.providerSessionId;
      this.emit({ type: "session.ready", providerSessionId: this.providerSessionId });
    }
    return this;
  }

  events(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    const buffered = this.buffered;
    if (buffered) {
      this.buffered = undefined;
      for (const event of buffered) safeCall(listener, event);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  async startTurn(input: HarnessTurnInput): Promise<void> {
    if (this.exited || this.closing) throw new Error("Claude Code session is closed.");
    const content = await userContent(input);
    // Checked after reading attachments so two overlapping calls cannot both start a turn.
    if (this.turn) {
      throw new Error(
        `Claude Code turn ${this.turn.id} is still running; it has no native steering.`,
      );
    }
    // Write first: a failed write must not leave a phantom active turn behind.
    this.write({
      type: "user",
      session_id: "",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    this.turn = { id: input.turnId, interrupted: false, text: "" };
    this.emit({ type: "turn.started", turnId: input.turnId });
  }

  async answerQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) throw new Error(`No pending Claude Code question ${requestId}.`);
    this.pendingQuestions.delete(requestId);
    const byText: Record<string, string> = {};
    for (const [id, text] of pending.textById) {
      const answer = answers[id];
      if (answer !== undefined) byText[text] = answer;
    }
    this.respond(requestId, {
      behavior: "allow",
      updatedInput: { ...pending.input, answers: byText },
    });
  }

  async interrupt(turnId?: string): Promise<void> {
    const turn = this.turn;
    if (!turn || (turnId && turnId !== turn.id) || this.exited) return;
    turn.interrupted = true;
    try {
      await withTimeout(
        this.request({ subtype: "interrupt" }),
        this.ctx.interruptTimeoutMs,
        "Claude Code did not acknowledge the interrupt",
      );
    } catch {
      if (!this.exited) this.child.kill("SIGINT");
    }
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.child.stdin?.end();
    }
    await this.terminate();
  }

  /** Waits for exit after stdin closes, then escalates SIGTERM → SIGKILL. */
  private async terminate(): Promise<void> {
    this.closing = true;
    if (!this.exited) {
      this.child.stdin?.end();
      if (!(await this.waitForExit(this.ctx.closeGraceMs))) {
        this.signal("SIGTERM");
        if (!(await this.waitForExit(this.ctx.killGraceMs))) {
          this.signal("SIGKILL");
          await this.exitPromise;
        }
      }
    }
    await this.exitPromise;
    await this.cleanupTemp();
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // The group is gone or was never created; fall back to the child itself.
      }
    }
    this.child.kill(signal);
  }

  private async waitForExit(ms: number): Promise<boolean> {
    if (this.exited) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([this.exitPromise.then(() => true as const), timedOut]);
    clearTimeout(timer);
    return result;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    const unexpected = !this.closing;
    const reason = error
      ? describeSpawnError(this.ctx.command, error)
      : signal
        ? `Claude Code exited on ${signal}`
        : `Claude Code exited with code ${code ?? "unknown"}`;
    for (const pending of this.pendingControls.values()) pending.reject(new Error(reason));
    this.pendingControls.clear();
    this.pendingQuestions.clear();
    const turn = this.turn;
    this.turn = undefined;
    if (turn) {
      if (unexpected) {
        this.emit({
          type: "turn.failed",
          turnId: turn.id,
          message: `${reason}${this.stderrSuffix()}`,
          recoverable: false,
        });
      } else {
        this.emit({ type: "turn.completed", turnId: turn.id, stopReason: "interrupted" });
      }
    }
    this.emit({
      type: "session.closed",
      reason: unexpected ? `${reason}${this.stderrSuffix()}` : "closed",
      unexpected,
    });
    // Temp files go even when nobody calls close() after a crash.
    void this.cleanupTemp().finally(() => this.resolveExit());
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: Frame;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) return;
      frame = parsed;
    } catch {
      return;
    }
    switch (frame.type) {
      case "system":
        return this.onSystem(frame);
      case "stream_event":
        return this.onStreamEvent(frame);
      case "assistant":
        return this.onAssistant(frame);
      case "user":
        return this.onUser(frame);
      case "control_request":
        return this.onControlRequest(frame);
      case "control_response":
        return this.onControlResponse(frame);
      case "control_cancel_request":
        if (typeof frame.request_id === "string") this.pendingQuestions.delete(frame.request_id);
        return;
      case "result":
        return this.onResult(frame);
    }
  }

  private onSystem(frame: Frame): void {
    if (frame.subtype !== "init") return;
    if (typeof frame.model === "string") this.model = frame.model;
    const sessionId = frame.session_id;
    if (typeof sessionId !== "string" || !sessionId) return;
    // session.ready is announced once at startup. A later ID only updates the property.
    this.providerSessionId = sessionId;
    if (this.announcedSessionId) return;
    this.announcedSessionId = sessionId;
    this.emit({ type: "session.ready", providerSessionId: sessionId });
  }

  private onStreamEvent(frame: Frame): void {
    const turn = this.turn;
    if (!turn || frame.parent_tool_use_id) return;
    const event = frame.event;
    if (!isRecord(event) || event.type !== "content_block_delta" || !isRecord(event.delta)) return;
    const delta = event.delta;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      turn.text += delta.text;
      this.emit({ type: "text.delta", turnId: turn.id, delta: delta.text });
    } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      this.emit({ type: "reasoning.delta", turnId: turn.id, delta: delta.thinking });
    }
  }

  private onAssistant(frame: Frame): void {
    const turn = this.turn;
    const message = frame.message;
    if (!turn || !isRecord(message)) return;
    if (!frame.parent_tool_use_id && isRecord(message.usage)) {
      const usage = message.usage;
      turn.contextTokens = sumKnown([
        usage.input_tokens,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
        usage.output_tokens,
      ]);
    }
    for (const block of arrayOf(message.content)) {
      if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") continue;
      const name = typeof block.name === "string" ? block.name : "tool";
      this.toolNames.set(block.id, name);
      this.emit({
        type: "tool.started",
        turnId: turn.id,
        callId: block.id,
        name,
        ...(block.input === undefined ? {} : { arguments: JSON.stringify(block.input) }),
      });
    }
  }

  private onUser(frame: Frame): void {
    const turn = this.turn;
    const message = frame.message;
    if (!turn || !isRecord(message)) return;
    for (const block of arrayOf(message.content)) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      if (!callId) continue;
      const name = this.toolNames.get(callId) ?? "tool";
      this.toolNames.delete(callId);
      const output = toolResultText(block.content);
      this.emit({
        type: "tool.completed",
        turnId: turn.id,
        callId,
        name,
        ...(block.is_error === true
          ? { error: output || "Tool failed" }
          : output
            ? { output }
            : {}),
      });
    }
  }

  private onControlRequest(frame: Frame): void {
    const requestId = frame.request_id;
    const request = frame.request;
    if (typeof requestId !== "string" || !isRecord(request)) return;
    if (request.subtype !== "can_use_tool") {
      this.respondError(
        requestId,
        `Unsupported control request: ${JSON.stringify(request.subtype)}`,
      );
      return;
    }
    const toolName = typeof request.tool_name === "string" ? request.tool_name : "";
    const input = isRecord(request.input) ? request.input : {};
    if (toolName === "AskUserQuestion") {
      this.askQuestion(requestId, input);
      return;
    }
    if (this.fullPermissions) {
      this.respond(requestId, { behavior: "allow", updatedInput: input });
    } else {
      // The harness contract has no approval event, so tools that need a prompt are denied.
      this.respond(requestId, {
        behavior: "deny",
        message: `${toolName || "This tool"} needs approval, and this bot does not have full permissions.`,
      });
    }
  }

  private askQuestion(requestId: string, input: Record<string, unknown>): void {
    const turn = this.turn;
    if (!turn) {
      this.respond(requestId, { behavior: "deny", message: "No turn is active." });
      return;
    }
    const textById = new Map<string, string>();
    const questions: HarnessQuestion[] = [];
    arrayOf(input.questions).forEach((raw, index) => {
      if (!isRecord(raw) || typeof raw.question !== "string") return;
      const id = `q${index + 1}`;
      textById.set(id, raw.question);
      const options = arrayOf(raw.options)
        .map((option) => (isRecord(option) ? option.label : undefined))
        .filter((label): label is string => typeof label === "string");
      questions.push({
        id,
        question: raw.question,
        ...(typeof raw.header === "string" ? { header: raw.header } : {}),
        ...(options.length > 0 ? { options } : {}),
        ...(raw.multiSelect === true ? { multiple: true } : {}),
      });
    });
    this.pendingQuestions.set(requestId, { input, textById });
    const title = questions.length === 1 ? questions[0]?.header : undefined;
    this.emit({
      type: "question.asked",
      turnId: turn.id,
      requestId,
      ...(title ? { title } : {}),
      prompt: questions.map((question) => question.question).join("\n"),
      questions,
    });
  }

  private onControlResponse(frame: Frame): void {
    const response = frame.response;
    if (!isRecord(response) || typeof response.request_id !== "string") return;
    const pending = this.pendingControls.get(response.request_id);
    if (!pending) return;
    this.pendingControls.delete(response.request_id);
    if (response.subtype === "error") {
      pending.reject(new Error(typeof response.error === "string" ? response.error : "error"));
    } else {
      pending.resolve(response.response);
    }
  }

  private onResult(frame: Frame): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    this.pendingQuestions.clear();
    this.toolNames.clear();
    const usage = isRecord(frame.usage) ? frame.usage : {};
    const inputTokens = sumKnown([
      usage.input_tokens,
      usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens,
    ]);
    const outputTokens = finiteNonNegativeInteger(usage.output_tokens);
    const contextWindow = this.contextWindow(frame.modelUsage);
    if (inputTokens !== undefined || outputTokens !== undefined) {
      this.emit({
        type: "usage.reported",
        turnId: turn.id,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(turn.contextTokens !== undefined ? { contextTokens: turn.contextTokens } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      });
    }
    const text = typeof frame.result === "string" ? frame.result : turn.text;
    if (turn.interrupted) {
      this.emit({
        type: "turn.completed",
        turnId: turn.id,
        ...(text ? { text } : {}),
        stopReason: "interrupted",
      });
    } else if (frame.subtype === "success" && frame.is_error !== true) {
      this.emit({ type: "turn.completed", turnId: turn.id, text, stopReason: "end_turn" });
    } else {
      const errors = arrayOf(frame.errors).filter((item) => typeof item === "string");
      this.emit({
        type: "turn.failed",
        turnId: turn.id,
        message:
          errors.join("\n") ||
          (typeof frame.result === "string" && frame.result) ||
          `Claude Code turn ended with ${typeof frame.subtype === "string" ? frame.subtype : "an error"}`,
        recoverable: true,
      });
    }
  }

  /** The window Claude Code resolved for the session model, adapted from ClaudeTurnTokenUsage. */
  private contextWindow(modelUsage: unknown): number | undefined {
    if (!isRecord(modelUsage)) return undefined;
    const windows = new Map<string, number>();
    for (const [model, entry] of Object.entries(modelUsage)) {
      const window = isRecord(entry) ? finiteNonNegativeInteger(entry.contextWindow) : undefined;
      if (window) windows.set(model, window);
    }
    if (this.model && windows.has(this.model)) return windows.get(this.model);
    return windows.size > 0 ? Math.max(...windows.values()) : undefined;
  }

  private request(request: Record<string, unknown>): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("Claude Code session is closed."));
    const requestId = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      this.pendingControls.set(requestId, { resolve, reject });
    });
    this.write({ type: "control_request", request_id: requestId, request });
    return response;
  }

  private respond(requestId: string, response: Record<string, unknown>): void {
    this.write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  private respondError(requestId: string, error: string): void {
    this.write({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error },
    });
  }

  private write(frame: Frame): void {
    const stdin = this.child.stdin;
    if (this.exited || !stdin || stdin.destroyed || stdin.writableEnded) {
      throw new Error("Claude Code session is closed.");
    }
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private emit(event: HarnessEvent): void {
    if (this.buffered) {
      this.buffered.push(event);
      return;
    }
    for (const listener of this.listeners) safeCall(listener, event);
  }

  private stderrSuffix(): string {
    const tail = lastLine(this.stderrTail);
    return tail ? `: ${tail}` : "";
  }
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (failure && typeof failure.code === "string") {
          resolve({ code: null, stdout, stderr, error: describeSpawnError(command, failure) });
        } else if (failure?.killed) {
          resolve({
            code: null,
            stdout,
            stderr,
            error: `\`${command}\` timed out after ${timeoutMs} ms`,
          });
        } else {
          resolve({
            code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
            stdout,
            stderr,
          });
        }
      },
    );
  });
}

/** Same pattern as t3code's `parseGenericCliVersion`: `2.1.330 (Claude Code)` → `2.1.330`. */
export function parseCliVersion(output: string): string | undefined {
  return output.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1];
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseLoggedIn(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) && parsed.loggedIn === true;
  } catch {
    return false;
  }
}

const OS_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]{0,31}\$?$/;

/** Resolves the account to drop to. Only root can switch users; anyone else runs as themselves. */
async function resolveLaunchUser(
  osUser: string | undefined,
  uid: number | undefined,
): Promise<LaunchUser | undefined> {
  if (!osUser) return undefined;
  let current: string | undefined;
  try {
    current = userInfo().username;
  } catch {
    current = undefined;
  }
  if (osUser === current) return undefined;
  if (!OS_USER_PATTERN.test(osUser)) throw new Error(`Invalid osUser "${osUser}".`);
  if (uid !== 0) {
    throw new Error(
      `Claude Code cannot run as osUser "${osUser}": switching users needs the server to run as root, and it runs as "${current ?? uid}".`,
    );
  }
  const env = process.env;
  const [userId, groupId] = await Promise.all([
    runCommand("id", ["-u", osUser], env, 5_000),
    runCommand("id", ["-g", osUser], env, 5_000),
  ]);
  const parsedUid = Number.parseInt(userId.stdout.trim(), 10);
  const parsedGid = Number.parseInt(groupId.stdout.trim(), 10);
  if (userId.code !== 0 || !Number.isInteger(parsedUid) || !Number.isInteger(parsedGid)) {
    throw new Error(`Unknown osUser "${osUser}".`);
  }
  const home =
    process.platform === "darwin"
      ? (
          await runCommand(
            "dscl",
            [".", "-read", `/Users/${osUser}`, "NFSHomeDirectory"],
            env,
            5_000,
          )
        ).stdout
          .split(":")
          .slice(1)
          .join(":")
          .trim()
      : ((await runCommand("getent", ["passwd", osUser], env, 5_000)).stdout.trim().split(":")[5] ??
        "");
  if (!home) throw new Error(`Could not find the home directory of osUser "${osUser}".`);
  return { name: osUser, uid: parsedUid, gid: parsedGid, home };
}

/** `--mcp-config` file shape: `{ mcpServers: { name: { type, command | url, ... } } }`. */
export function claudeMcpConfig(servers: readonly HarnessMcpServerSpec[]): {
  mcpServers: Record<string, Record<string, unknown>>;
} {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    if (server.transport === "http") {
      if (!server.url) throw new Error(`MCP server "${server.name}" needs a url.`);
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    } else {
      if (!server.command) throw new Error(`MCP server "${server.name}" needs a command.`);
      mcpServers[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
      };
    }
  }
  return { mcpServers };
}

async function userContent(input: HarnessTurnInput): Promise<Record<string, unknown>[]> {
  const text = input.senderName ? `${input.senderName}: ${input.text}` : input.text;
  const content: Record<string, unknown>[] = [];
  const references: string[] = [];
  for (const attachment of input.attachments ?? []) {
    if (IMAGE_MIME_TYPES.has(attachment.mime.toLowerCase())) {
      content.push(await imageBlock(attachment));
    } else {
      references.push(`- ${attachment.name} (${attachment.mime}): ${attachment.path}`);
    }
  }
  const body =
    references.length > 0
      ? `${text}\n\nAttached files (read them from disk):\n${references.join("\n")}`
      : text;
  content.push({ type: "text", text: body });
  return content;
}

async function imageBlock(attachment: HarnessAttachment): Promise<Record<string, unknown>> {
  const data = await readFile(attachment.path);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: attachment.mime.toLowerCase(),
      data: data.toString("base64"),
    },
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return arrayOf(content)
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message} within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeSpawnError(command: string, error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `\`${command}\` was not found on PATH`;
  if (code === "EACCES") return `\`${command}\` is not executable`;
  return error.message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

function safeCall(listener: (event: HarnessEvent) => void, event: HarnessEvent): void {
  try {
    listener(event);
  } catch {
    // One listener must not break the protocol reader.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Sum of the known counts, or undefined when none is known. */
function sumKnown(values: unknown[]): number | undefined {
  const known = values.map(finiteNonNegativeInteger).filter((value) => value !== undefined);
  return known.length === 0 ? undefined : known.reduce((sum, value) => sum + value, 0);
}
