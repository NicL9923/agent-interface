/*
 * Adapted from pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import type { ModelProvider } from "../../shared/types.js";
import type {
  HarnessDriver,
  HarnessEvent,
  HarnessMcpServerSpec,
  HarnessQuestion,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTurnInput,
} from "./driver.js";
import {
  JsonRpcError,
  openJsonRpcStdio,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcRespond,
} from "./json-rpc-stdio.js";

const execFileAsync = promisify(execFile);
type Rpc = ReturnType<typeof openJsonRpcStdio>;
type WireObject = Record<string, unknown>;

export interface CodexDriverOptions {
  command?: string;
  args?: readonly string[];
  versionArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
}

export interface CodexModelProvider extends ModelProvider {
  models: (ModelProvider["models"][number] & {
    supportedReasoningEfforts: string[];
    defaultReasoningEffort?: string;
    serviceTiers: { id: string; name: string; description?: string }[];
    defaultServiceTier: string;
  })[];
}

interface ActiveTurn {
  id: string;
  providerId?: string;
  ready: Promise<boolean>;
  resolveReady(ready: boolean): void;
  started: boolean;
  streamedText: string;
  finalText?: string;
  failure?: string;
}

interface PendingQuestion {
  id: JsonRpcId;
  turn: ActiveTurn;
  respond: JsonRpcRespond;
}

function object(value: unknown): WireObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as WireObject) : {};
}

function objects(value: unknown): WireObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function render(value: unknown): string | undefined {
  return value == null ? undefined : typeof value === "string" ? value : JSON.stringify(value);
}

function mcpConfig(servers: HarnessMcpServerSpec[]) {
  return Object.fromEntries(
    servers.map((server) => {
      if (!server.name || !(server.transport === "stdio" ? server.command : server.url))
        throw new Error("Codex MCP configuration requires a name and a command or URL");
      return [
        server.name,
        server.transport === "stdio"
          ? { command: server.command, args: server.args, env: server.env }
          : { url: server.url, http_headers: server.headers },
      ];
    }),
  );
}

function turnInput(input: HarnessTurnInput) {
  const text = [input.text];
  const images = [];
  for (const attachment of input.attachments ?? []) {
    if (attachment.mime.startsWith("image/")) {
      images.push({ type: "localImage", path: attachment.path });
    } else {
      // The app-server has no generic file input. Give Codex the local path as user text.
      text.push(
        `Attached file ${JSON.stringify(attachment.name)}: ${JSON.stringify(attachment.path)}`,
      );
    }
  }
  const prompt = text.filter(Boolean).join("\n");
  return [...(prompt ? [{ type: "text", text: prompt, text_elements: [] }] : []), ...images];
}

function mapModel(model: WireObject, authenticated: boolean): CodexModelProvider["models"] {
  const id = string(model.model) ?? string(model.id);
  if (!id || model.hidden === true) return [];
  const tiers = objects(model.serviceTiers).flatMap((tier) => {
    const id = string(tier.id);
    return id ? [{ id, name: string(tier.name) ?? id, description: string(tier.description) }] : [];
  });
  if (!tiers.length && Array.isArray(model.additionalSpeedTiers)) {
    for (const id of model.additionalSpeedTiers) {
      if (typeof id === "string" && id !== "default")
        tiers.push({ id, name: id === "fast" ? "Fast" : id, description: undefined });
    }
  }
  if (!tiers.some((tier) => tier.id === "default"))
    tiers.unshift({ id: "default", name: "Standard", description: undefined });
  return [
    {
      id,
      name: string(model.displayName) ?? id,
      available: authenticated,
      supportedReasoningEfforts: objects(model.supportedReasoningEfforts).flatMap(
        ({ reasoningEffort }) => (typeof reasoningEffort === "string" ? [reasoningEffort] : []),
      ),
      defaultReasoningEffort: string(model.defaultReasoningEffort),
      serviceTiers: tiers,
      defaultServiceTier:
        tiers.find((tier) => tier.id === model.defaultServiceTier)?.id ?? "default",
    },
  ];
}

async function initialize(rpc: Rpc) {
  await rpc.request("initialize", {
    clientInfo: { name: "wildbots", title: "WildBots", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  await rpc.notify("initialized");
}

export function createCodexDriver(options: CodexDriverOptions = {}): HarnessDriver & {
  listModels(): Promise<CodexModelProvider[]>;
} {
  const command = options.command ?? "codex";
  const args = options.args ?? ["app-server"];
  const environment = () => ({ ...process.env, ...options.env });
  const transport = { command, args, requestTimeoutMs: options.requestTimeoutMs ?? 15_000 };

  return {
    id: "codex",
    displayName: "Codex",
    capabilities: {
      nativeSteering: true,
      resumable: true,
      supportsMcp: true,
      supportsImages: true,
      supportsReasoning: true,
      supportsSpeed: true,
    },
    async probe() {
      try {
        const { stdout } = await execFileAsync(command, options.versionArgs ?? ["--version"], {
          env: environment(),
          timeout: options.probeTimeoutMs ?? 3_000,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
          windowsHide: true,
        });
        const version = /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/u.exec(stdout)?.[1];
        return version
          ? { available: true, version }
          : { available: false, reason: "Codex did not report a version" };
      } catch (error) {
        const { code, killed } = error as NodeJS.ErrnoException & { killed?: boolean };
        const reason =
          code === "ENOENT"
            ? "Codex executable was not found"
            : killed
              ? "Codex version probe did not finish"
              : "Codex version probe failed";
        return { available: false, reason };
      }
    },
    async listModels() {
      const rpc = openJsonRpcStdio({ ...transport, env: environment() });
      try {
        await initialize(rpc);
        const account = object(await rpc.request("account/read", { refreshToken: false }));
        const authenticated = account.requiresOpenaiAuth === false || account.account != null;
        const models = new Map<string, CodexModelProvider["models"][number]>();
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = object(await rpc.request("model/list", { cursor, includeHidden: false }));
          if (!Array.isArray(page.data)) throw new Error("Codex returned an invalid model list");
          for (const model of objects(page.data).flatMap((model) =>
            mapModel(model, authenticated),
          )) {
            models.set(model.id, model);
          }
          cursor = string(page.nextCursor);
          if (cursor && seenCursors.has(cursor))
            throw new Error("Codex repeated a model list cursor");
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
        return [{ id: "codex", name: "Codex", authenticated, models: [...models.values()] }];
      } finally {
        await rpc.close();
      }
    },
    async openSession(spec) {
      // This process launcher has no privilege broker. Never fall back to the host login.
      if (spec.osUser !== undefined && spec.osUser !== userInfo().username)
        throw new Error("Codex must be launched by the session's Unix account");
      const session = new CodexSession(spec, {
        ...transport,
        env: { ...environment(), ...spec.env },
      });
      await session.open();
      return session;
    },
  };
}

class CodexSession implements HarnessSession {
  readonly id: string;
  #providerSessionId?: string;
  #rpc: Rpc;
  #requestTimeoutMs: number;
  #turn?: ActiveTurn;
  #starting = false;
  #questions = new Map<string, PendingQuestion>();
  #listeners = new Set<(event: HarnessEvent) => void>();
  #closedEvent?: Extract<HarnessEvent, { type: "session.closed" }>;

  constructor(
    private readonly spec: HarnessSessionSpec,
    transport: Pick<Parameters<typeof openJsonRpcStdio>[0], "command" | "args" | "env"> & {
      requestTimeoutMs: number;
    },
  ) {
    this.id = spec.sessionKey;
    this.#requestTimeoutMs = transport.requestTimeoutMs;
    this.#rpc = openJsonRpcStdio({
      ...transport,
      cwd: spec.cwd,
      onNotification: (notification) => this.#onNotification(notification),
      onRequest: (request, respond, signal) => this.#onRequest(request, respond, signal),
      onClose: (error, unexpected) => {
        this.#turn?.resolveReady(false);
        this.#turn = undefined;
        this.#closedEvent = { type: "session.closed", reason: error.message, unexpected };
        this.#emit(this.#closedEvent);
        this.#listeners.clear();
      },
    });
  }

  get providerSessionId() {
    return this.#providerSessionId;
  }

  async open() {
    const { spec } = this;
    try {
      const config = {
        model_reasoning_effort: spec.reasoning || undefined,
        mcp_servers: spec.mcpServers && mcpConfig(spec.mcpServers),
      };
      await initialize(this.#rpc);
      const resuming = Boolean(spec.resumeSessionId);
      const response = object(
        await this.#rpc.request(resuming ? "thread/resume" : "thread/start", {
          ...(resuming ? { threadId: spec.resumeSessionId, excludeTurns: true } : {}),
          cwd: spec.cwd,
          model: spec.model || undefined,
          modelProvider: spec.provider === "codex" ? undefined : spec.provider,
          developerInstructions: spec.systemPrompt,
          serviceTier:
            spec.speed === "normal" ? "default" : spec.speed === "auto" ? undefined : spec.speed,
          sandbox: spec.fullPermissions ? "danger-full-access" : "workspace-write",
          approvalPolicy: spec.fullPermissions ? "never" : "on-request",
          config,
        }),
      );
      const id = string(object(response.thread).id);
      if (!id || (resuming && id !== spec.resumeSessionId))
        throw new Error("Codex did not return the requested thread");
      this.#providerSessionId = id;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  events(listener: (event: HarnessEvent) => void): () => void {
    if (this.#providerSessionId)
      listener({ type: "session.ready", providerSessionId: this.#providerSessionId });
    if (this.#closedEvent) listener(this.#closedEvent);
    else this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async startTurn(input: HarnessTurnInput): Promise<void> {
    if (this.#turn || this.#starting) throw new Error("A Codex turn is already active");
    let resolveReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const turn: ActiveTurn = {
      id: input.turnId,
      ready,
      resolveReady,
      started: false,
      streamedText: "",
    };
    this.#turn = turn;
    this.#starting = true;
    let readyTimer: NodeJS.Timeout | undefined;
    try {
      const response = await this.#rpc.request("turn/start", {
        threadId: this.#providerSessionId,
        clientUserMessageId: input.turnId,
        input: turnInput(input),
        effort: this.spec.reasoning || undefined,
        summary: "auto",
      });
      const providerId = string(object(object(response).turn).id);
      if (!providerId || !this.#bindTurn(turn, providerId))
        throw new Error("Codex did not return the active turn");
      // The reply can precede the moment a steer or interrupt can reach the turn.
      readyTimer = setTimeout(() => turn.resolveReady(false), this.#requestTimeoutMs);
      if (!(await turn.ready)) throw new Error("Codex did not report that the turn started");
    } catch (error) {
      if (this.#turn === turn) this.#clearTurn(turn);
      if (!(error instanceof JsonRpcError)) {
        // A missing or invalid acknowledgement can leave a turn running on the peer.
        await this.#rpc.terminate(new Error("Could not confirm Codex turn start"));
      }
      throw error;
    } finally {
      clearTimeout(readyTimer);
      this.#starting = false;
    }
  }

  async steer(input: HarnessTurnInput): Promise<void> {
    const turn = this.#turn;
    if (!turn || !(await turn.ready) || !turn.providerId || this.#turn !== turn)
      throw new Error("No active Codex turn to steer");
    await this.#rpc.request("turn/steer", {
      threadId: this.#providerSessionId,
      expectedTurnId: turn.providerId,
      clientUserMessageId: input.turnId,
      input: turnInput(input),
    });
  }

  async interrupt(turnId?: string): Promise<void> {
    const turn = this.#turn;
    if (!turn || (turnId !== undefined && turn.id !== turnId)) return;
    if (!(await turn.ready) || this.#turn !== turn) return;
    await this.#rpc.request("turn/interrupt", {
      threadId: this.#providerSessionId,
      turnId: turn.providerId,
    });
  }

  async answerQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    const pending = this.#questions.get(requestId);
    if (!pending) throw new Error("No pending Codex question with that request ID");
    this.#questions.delete(requestId);
    await pending.respond({
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, answer]) => [id, { answers: [answer] }]),
      ),
    });
  }

  close(): Promise<void> {
    return this.#rpc.close();
  }

  #emit(event: HarnessEvent) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber must not stop the stdio reader or other subscribers.
      }
    }
  }

  #bindTurn(turn: ActiveTurn, providerId: string): boolean {
    if (turn.providerId !== undefined) return turn.providerId === providerId;
    if (this.#turn !== turn) return false;
    turn.providerId = providerId;
    return true;
  }

  #markTurnStarted(turn: ActiveTurn) {
    if (turn.started) return;
    turn.started = true;
    turn.resolveReady(true);
    this.#emit({ type: "turn.started", turnId: turn.id });
  }

  #clearTurn(turn: ActiveTurn) {
    this.#turn = undefined;
    turn.resolveReady(false);
    for (const question of this.#questions.values()) {
      if (question.turn === turn) this.#rpc.cancelServerRequest(question.id);
    }
  }

  #onNotification({ method, params: raw }: JsonRpcNotification) {
    const params = object(raw);
    if (this.#providerSessionId === undefined || params.threadId !== this.#providerSessionId)
      return;
    if (method === "thread/closed") {
      void this.close();
      return;
    }
    if (method === "serverRequest/resolved") {
      const id = params.requestId;
      if (typeof id === "number" || typeof id === "string") this.#rpc.cancelServerRequest(id);
      return;
    }
    const turn = this.#turn;
    if (!turn) return;
    const reportedTurn = object(params.turn);
    const providerTurnId = string(params.turnId ?? reportedTurn.id);
    if (!providerTurnId) return;
    if (method === "turn/started") {
      if (this.#bindTurn(turn, providerTurnId)) this.#markTurnStarted(turn);
      return;
    }
    if (turn.providerId !== providerTurnId) return;

    const turnId = turn.id;
    switch (method) {
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const delta = string(params.delta);
        if (delta === undefined) break;
        if (method === "item/agentMessage/delta") {
          turn.streamedText += delta;
          this.#emit({ type: "text.delta", turnId, delta });
        } else {
          this.#emit({ type: "reasoning.delta", turnId, delta });
        }
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = object(params.item);
        const completed = method === "item/completed";
        if (completed && item.type === "agentMessage" && item.phase !== "commentary")
          turn.finalText = string(item.text);
        const event = toolEvent(item, turnId, completed);
        if (event) this.#emit(event);
        break;
      }
      case "thread/tokenUsage/updated": {
        const usage = object(params.tokenUsage);
        const last = object(usage.last);
        this.#emit({
          type: "usage.reported",
          turnId,
          inputTokens: count(last.inputTokens),
          outputTokens: count(last.outputTokens),
          contextTokens: count(last.totalTokens),
          contextWindow: count(usage.modelContextWindow),
        });
        break;
      }
      case "error":
        if (params.willRetry !== true) turn.failure = string(object(params.error).message);
        break;
      case "turn/completed": {
        const { status } = reportedTurn;
        if (status !== "completed" && status !== "interrupted" && status !== "failed") break;
        this.#markTurnStarted(turn);
        this.#clearTurn(turn);
        if (status === "failed") {
          const message =
            string(object(reportedTurn.error).message) ?? turn.failure ?? "Codex turn failed";
          this.#emit({ type: "turn.failed", turnId, message });
        } else {
          const finalItem = objects(reportedTurn.items).findLast(
            (item) => item.type === "agentMessage" && item.phase !== "commentary",
          );
          this.#emit({
            type: "turn.completed",
            turnId,
            text: turn.finalText ?? string(finalItem?.text) ?? (turn.streamedText || undefined),
            stopReason: status === "interrupted" ? "interrupted" : "end_turn",
          });
        }
        break;
      }
    }
  }

  #onRequest(
    { id, method, params: raw }: JsonRpcRequest,
    respond: JsonRpcRespond,
    signal: AbortSignal,
  ) {
    const params = object(raw);
    const turn = this.#turn;
    const matchesTurn =
      turn?.providerId !== undefined &&
      params.turnId === turn.providerId &&
      params.threadId === this.#providerSessionId;
    const allowed = this.spec.fullPermissions && matchesTurn;
    switch (method) {
      case "item/commandExecution/requestApproval":
        // Codex reserves these decisions for a person, even on a full-access thread.
        return respond({
          decision: allowed && params.kind !== "humanCommand" ? "accept" : "decline",
        });
      case "item/fileChange/requestApproval":
        return respond({ decision: allowed ? "accept" : "decline" });
      case "item/permissions/requestApproval":
        return respond({ permissions: allowed ? object(params.permissions) : {}, scope: "turn" });
      case "item/tool/requestUserInput": {
        if (!matchesTurn) throw new JsonRpcError(-32602, "No matching Codex turn for question");
        const questions: HarnessQuestion[] = objects(params.questions).flatMap((entry) => {
          const id = string(entry.id);
          const question = string(entry.question);
          if (!id || !question) return [];
          const options = objects(entry.options).flatMap(({ label }) =>
            typeof label === "string" ? [label] : [],
          );
          return [
            {
              id,
              question,
              header: string(entry.header),
              options: options.length ? options : undefined,
            },
          ];
        });
        if (!questions.length) throw new JsonRpcError(-32602, "No valid Codex questions");
        // Include the ID type so numeric and string JSON-RPC IDs cannot collide.
        const requestId = JSON.stringify(id);
        this.#questions.set(requestId, { id, turn, respond });
        signal.addEventListener("abort", () => this.#questions.delete(requestId), { once: true });
        this.#emit({
          type: "question.asked",
          turnId: turn.id,
          requestId,
          title: questions[0].header,
          prompt: questions.map(({ question }) => question).join("\n"),
          questions,
        });
        return;
      }
      default:
        throw new JsonRpcError(-32601, "Method not found");
    }
  }
}

function toolEvent(item: WireObject, turnId: string, completed: boolean): HarnessEvent | undefined {
  const callId = string(item.id);
  if (!callId) return;
  let name: string;
  let args: string | undefined;
  let output: string | undefined;
  let error: string | undefined;
  switch (item.type) {
    case "commandExecution":
      name = "commandExecution";
      args = string(item.command);
      output = string(item.aggregatedOutput);
      if (typeof item.exitCode === "number" && item.exitCode !== 0)
        error = `Command exited with code ${item.exitCode}`;
      break;
    case "fileChange":
      name = "fileChange";
      args = render(item.changes);
      output = args;
      break;
    case "mcpToolCall":
      name = [string(item.server), string(item.tool)].filter(Boolean).join("/") || "mcpToolCall";
      args = render(item.arguments);
      output = render(item.result);
      error = string(object(item.error).message);
      break;
    default:
      return;
  }
  if (!completed) return { type: "tool.started", turnId, callId, name, arguments: args };
  if (!error && (item.status === "failed" || item.status === "declined"))
    error = `Codex tool ${item.status}`;
  return { type: "tool.completed", turnId, callId, name, output, error };
}
