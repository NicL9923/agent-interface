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
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ModelProvider } from "../../shared/types.js";
import { AcpRpcError, AcpStdio, acpRecord, deferred } from "./acp-stdio.js";
import type {
  HarnessAttachment,
  HarnessDriver,
  HarnessEvent,
  HarnessMcpServerSpec,
  HarnessQuestion,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTurnInput,
} from "./driver.js";

const exec = promisify(execFile);
const DEFAULT_MODEL = "grok-build";
const CANCELLED = { outcome: "cancelled" };
const PROMPT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60_000;
const XAI_SESSION_UPDATES = new Set([
  "x.ai/session_notification",
  "_x.ai/session_notification",
  "_x.ai/session/update",
]);
const XAI_PROMPT_COMPLETE = new Set([
  "x.ai/session/prompt_complete",
  "_x.ai/session/prompt_complete",
]);
const XAI_QUESTIONS = new Set(["x.ai/ask_user_question", "_x.ai/ask_user_question"]);
type AcpObject = Record<string, unknown>;

export interface GrokDriverOptions {
  command?: string;
  /** Prefix arguments for a launcher. The Grok arguments follow this prefix. */
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  /** How long a discovered model catalog stays cached. Default 5 minutes. */
  modelCacheTtlMs?: number;
  /** Clock for model cache expiry. Defaults to `Date.now`. */
  now?: () => number;
}

function records(value: unknown): AcpObject[] {
  return Array.isArray(value) ? value.map(acpRecord).filter((item) => item !== undefined) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  return asString(value) ?? JSON.stringify(value);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function mcpServer(server: HarnessMcpServerSpec): AcpObject {
  const pairs = (values?: Record<string, string>) =>
    Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));

  if (server.transport === "http") {
    if (!server.url) throw new Error(`Grok MCP server "${server.name}" requires a URL`);
    return { type: "http", name: server.name, url: server.url, headers: pairs(server.headers) };
  }
  if (!server.command) throw new Error(`Grok MCP server "${server.name}" requires a command`);
  return {
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    env: pairs(server.env),
  };
}

async function initialize(client: AcpStdio) {
  // Grok supports the v1 session/load contract and final session/prompt response.
  const response = acpRecord(
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "WildBots", version: "0.1.0" },
      _meta: { clientType: "extension" },
    }),
  );
  if (response?.protocolVersion !== 1) {
    throw new Error(
      `Grok returned an unsupported ACP protocol version: ${String(response?.protocolVersion)}`,
    );
  }
  return response;
}

async function setupSession(
  client: AcpStdio,
  initialized: AcpObject,
  spec: HarnessSessionSpec,
  mcpServers: AcpObject[],
  env: NodeJS.ProcessEnv,
) {
  const params = { cwd: spec.cwd, mcpServers };
  const setup = () =>
    spec.resumeSessionId
      ? client.request("session/load", { ...params, sessionId: spec.resumeSessionId })
      : client.request("session/new", params);
  try {
    return acpRecord(await setup()) ?? {};
  } catch (error) {
    if (!(error instanceof AcpRpcError) || error.code !== -32000) throw error;
    const methodId = env.XAI_API_KEY?.trim() ? "xai.api_key" : "cached_token";
    const advertised = records(initialized.authMethods).find((method) => method.id === methodId);
    // An unconfigured login can require a browser. Only retry headless methods.
    if (!advertised || (advertised.type != null && advertised.type !== "agent")) throw error;
    await client.request("authenticate", { methodId });
    return acpRecord(await setup()) ?? {};
  }
}

function advertisedValues(values: unknown): AcpObject[] {
  return records(values).flatMap((option) =>
    Array.isArray(option.options) ? records(option.options) : [option],
  );
}

function findConfig(options: AcpObject[], category: string, ids: string[]) {
  return options.find(
    (option) =>
      typeof option.id === "string" &&
      (option.type === undefined || option.type === "select") &&
      (option.category === category || ids.includes(option.id)),
  );
}

function unsupportedOption(error: unknown) {
  return error instanceof AcpRpcError && (error.code === -32601 || error.code === -32602);
}

async function configureSession(
  client: AcpStdio,
  sessionId: string,
  setup: AcpObject,
  initialized: AcpObject,
  spec: HarnessSessionSpec,
) {
  let options = records(setup.configOptions);
  const modelOption = findConfig(options, "model", ["model"]);
  const effortIds = ["thought_level", "reasoning_effort", "reasoningEffort"];
  const models = acpRecord(setup.models) ?? acpRecord(acpRecord(initialized._meta)?.modelState);
  const selected = spec.model.trim();
  const currentModel = asString(modelOption?.currentValue ?? models?.currentModelId);
  const model = selected && selected !== DEFAULT_MODEL ? selected : currentModel;
  const effort = spec.reasoning?.trim();

  if (modelOption && model && model !== currentModel) {
    const response = acpRecord(
      await client.request("session/set_config_option", {
        sessionId,
        configId: modelOption.id,
        value: model,
      }),
    );
    if (Array.isArray(response?.configOptions)) options = records(response.configOptions);
  }

  const effortOption = findConfig(options, "thought_level", effortIds);
  if (
    effortOption &&
    effort &&
    effort !== effortOption.currentValue &&
    advertisedValues(effortOption.options).some((option) => option.value === effort)
  ) {
    try {
      await client.request("session/set_config_option", {
        sessionId,
        configId: effortOption.id,
        value: effort,
      });
    } catch (error) {
      if (!unsupportedOption(error)) throw error;
    }
  }

  if (modelOption || !model) return;
  const modelData = records(models?.availableModels).find((entry) => entry.modelId === model);
  const meta = acpRecord(modelData?._meta);
  const allowed = records(meta?.reasoningEfforts);
  const legacyEffort =
    !effortOption &&
    effort &&
    meta?.supportsReasoningEffort !== false &&
    /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(effort) &&
    (allowed.length === 0 || allowed.some((option) => (option.value ?? option.id) === effort))
      ? effort
      : undefined;
  if (currentModel === model && (!legacyEffort || legacyEffort === meta?.reasoningEffort)) return;
  const params = { sessionId, modelId: model };
  if (legacyEffort) {
    try {
      await client.request("session/set_model", {
        ...params,
        _meta: { reasoningEffort: legacyEffort },
      });
      return;
    } catch (error) {
      if (!unsupportedOption(error)) throw error;
    }
  }
  if (currentModel !== model) await client.request("session/set_model", params);
}

async function attachmentBlock(attachment: HarnessAttachment): Promise<AcpObject> {
  if (attachment.mime.startsWith("image/")) {
    const data = await readFile(attachment.path, "base64");
    return { type: "image", mimeType: attachment.mime, data };
  }
  return {
    type: "resource_link",
    uri: pathToFileURL(attachment.path).href,
    name: attachment.name,
    mimeType: attachment.mime,
  };
}

interface ActiveTurn {
  id: string;
  promptId: string;
  abort: AbortController;
  complete: ReturnType<typeof deferred<unknown>>;
  tools: Map<string, AcpObject>;
  text: string[];
  sent: boolean;
  cancelling: boolean;
}

type ReplyToQuestion = (answers?: Record<string, string>) => void;

function questionsFrom(params: AcpObject): HarnessQuestion[] {
  const items = Array.isArray(params.questions) ? records(params.questions) : [params];
  return items.flatMap((item) => {
    const question = asString(item.question ?? item.prompt);
    if (!question?.trim()) return [];
    const options = Array.isArray(item.options)
      ? item.options.flatMap(
          (option: unknown) => asString(option) ?? asString(acpRecord(option)?.label) ?? [],
        )
      : [];
    return [
      {
        id: asString(item.id) ?? question,
        header: asString(item.header),
        question,
        options: options.length > 0 ? options : undefined,
        multiple: item.multiSelect === true || item.multiple === true,
      },
    ];
  });
}

function xaiAnswer(questions: HarnessQuestion[], answers: Record<string, string>): AcpObject {
  const chosen: [string, string[]][] = [];
  const annotations: [string, { notes: string }][] = [];
  for (const question of questions) {
    const answer = Object.hasOwn(answers, question.id)
      ? asString(answers[question.id])?.trim()
      : undefined;
    if (!answer) continue;
    const isOption = question.options?.includes(answer);
    chosen.push([question.question, [isOption ? answer : "Other"]]);
    if (!isOption) annotations.push([question.question, { notes: answer }]);
  }
  return {
    outcome: "accepted",
    answers: Object.fromEntries(chosen),
    ...(annotations.length ? { annotations: Object.fromEntries(annotations) } : {}),
  };
}

class GrokSession implements HarnessSession {
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly questions = new Map<string, ReplyToQuestion>();
  private turn?: ActiveTurn;
  private closedEvent?: Extract<HarnessEvent, { type: "session.closed" }>;
  private closing = false;
  private nextQuestion = 0;
  private nextPrompt = 0;
  private systemPrompt?: string;

  constructor(
    private readonly client: AcpStdio,
    readonly id: string,
    readonly providerSessionId: string,
    private readonly fullPermissions: boolean,
    systemPrompt: string | undefined,
    private readonly promptTimeoutMs: number,
  ) {
    this.systemPrompt = systemPrompt?.trim() ? systemPrompt : undefined;
    void client.closed.then(({ reason, unexpected }) => {
      this.closedEvent = { type: "session.closed", reason: reason.message, unexpected };
      this.cancelQuestions();
      if (unexpected && this.turn) this.failTurn(this.turn, reason, false);
      this.emit(this.closedEvent);
      this.listeners.clear();
    });
  }

  events(listener: (event: HarnessEvent) => void): () => void {
    // A closed session is silent: its one session.closed already went to the listeners it had.
    if (this.closedEvent) return () => undefined;
    this.listeners.add(listener);
    listener({ type: "session.ready", providerSessionId: this.providerSessionId });
    return () => this.listeners.delete(listener);
  }

  async startTurn(input: HarnessTurnInput): Promise<void> {
    if (this.closing || this.closedEvent) throw new Error("Grok session is closed");
    if (this.turn) throw new Error("Grok already has an active turn");

    const turn: ActiveTurn = {
      id: input.turnId,
      promptId: `wildbots-${++this.nextPrompt}`,
      abort: new AbortController(),
      complete: deferred(),
      tools: new Map(),
      text: [],
      sent: false,
      cancelling: false,
    };
    this.turn = turn;
    this.emit({ type: "turn.started", turnId: turn.id });
    let attachments: AcpObject[];
    try {
      attachments = await Promise.all((input.attachments ?? []).map(attachmentBlock));
    } catch (error) {
      this.failTurn(turn, error, true);
      return;
    }
    if (this.turn !== turn || this.closing || this.closedEvent) return;

    const prompt = [{ type: "text", text: input.text }, ...attachments];
    if (this.systemPrompt) prompt.unshift({ type: "text", text: this.systemPrompt });
    this.systemPrompt = undefined;
    turn.sent = true;
    const request = this.client.request(
      "session/prompt",
      {
        sessionId: this.providerSessionId,
        prompt,
        _meta: { promptId: turn.promptId, requestId: turn.promptId },
      },
      { timeoutMs: this.promptTimeoutMs, signal: turn.abort.signal },
    );
    void Promise.race([request, turn.complete.promise])
      .then((response) => this.completeTurn(turn, acpRecord(response)))
      .catch((error: unknown) => this.failTurn(turn, error, error instanceof AcpRpcError));
  }

  async answerQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    const reply = this.questions.get(requestId);
    if (!reply) throw new Error(`Unknown Grok question request: ${requestId}`);
    this.questions.delete(requestId);
    reply(answers);
  }

  async interrupt(turnId?: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.cancelling || (turnId !== undefined && turnId !== turn.id)) return;
    turn.cancelling = true;
    if (!turn.sent) {
      this.completeTurn(turn, { stopReason: "cancelled" });
      return;
    }
    const cancel = this.client.notify("session/cancel", {
      sessionId: this.providerSessionId,
      _meta: { cancelTrigger: "ctrl_c" },
    });
    this.cancelQuestions();
    await cancel;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.turn) this.clearTurn(this.turn);
    await this.client.close();
  }

  onRequest(method: string, value: unknown): unknown {
    const outer = acpRecord(value);
    const params = acpRecord(outer?.params) ?? outer;
    const turn = this.turn;
    const current = turn?.sent && !turn.cancelling && params?.sessionId === this.providerSessionId;
    if (method === "session/request_permission") {
      if (!current) return { outcome: CANCELLED };
      const options = records(params?.options);
      const kinds = this.fullPermissions ? ["allow_once", "allow_always"] : ["reject_once"];
      const selected = kinds
        .map((kind) =>
          options.find((option) => option.kind === kind && typeof option.optionId === "string"),
        )
        .find(Boolean);
      return {
        outcome: selected ? { outcome: "selected", optionId: selected.optionId } : CANCELLED,
      };
    }
    const xai = XAI_QUESTIONS.has(method);
    if (!xai && method !== "session/request_user_input") return undefined;
    if (!current || !turn || !params) return CANCELLED;
    const questions = questionsFrom(params);
    if (questions.length === 0)
      throw new AcpRpcError(-32602, "Grok question request has no questions");
    const requestId = `question-${++this.nextQuestion}`;
    const pending = deferred<unknown>();
    this.questions.set(requestId, (answers) => {
      pending.resolve(
        answers === undefined ? CANCELLED : xai ? xaiAnswer(questions, answers) : { answers },
      );
    });
    this.emit({
      type: "question.asked",
      turnId: turn.id,
      requestId,
      title: asString(params.title),
      prompt: asString(params.prompt) ?? questions.map((question) => question.question).join("\n"),
      questions,
    });
    return pending.promise;
  }

  onNotification(method: string, value: unknown) {
    const params = acpRecord(value);
    const turn = this.turn;
    if (!turn?.sent || params?.sessionId !== this.providerSessionId) return;
    const update = acpRecord(params.update);
    const promptId = asString(
      params.promptId ?? acpRecord(params._meta)?.promptId ?? update?.prompt_id ?? update?.promptId,
    );
    if (promptId && promptId !== turn.promptId) return;
    const extensionCompletion = XAI_PROMPT_COMPLETE.has(method);
    const matchedTurnUpdate =
      promptId === turn.promptId &&
      XAI_SESSION_UPDATES.has(method) &&
      update?.sessionUpdate === "turn_completed";
    if (extensionCompletion || matchedTurnUpdate) {
      turn.complete.resolve({
        stopReason: params.stopReason ?? update?.stop_reason ?? update?.stopReason,
        message: params.agentResult ?? update?.agent_result,
        usage: params.usage ?? update?.usage,
      });
      return;
    }
    if (method !== "session/update" || !update) return;
    const content = acpRecord(update.content);
    const delta = content?.type === "text" ? asString(content.text) : undefined;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (!delta) return;
        turn.text.push(delta);
        this.emit({ type: "text.delta", turnId: turn.id, delta });
        break;
      case "agent_thought_chunk":
        if (delta) this.emit({ type: "reasoning.delta", turnId: turn.id, delta });
        break;
      case "tool_call":
      case "tool_call_update":
        this.toolUpdate(turn, update);
        break;
      case "usage_update":
        this.emitUsage(turn.id, update);
        break;
    }
  }

  private toolUpdate(turn: ActiveTurn, update: AcpObject) {
    const callId = asString(update.toolCallId);
    if (!callId) return;
    const previous = turn.tools.get(callId);
    if (previous?.status === "completed" || previous?.status === "failed") return;
    const state = { ...previous, ...update };
    turn.tools.set(callId, state);
    const name = asString(state.title ?? state.kind) ?? "Tool";
    if (!previous) {
      this.emit({
        type: "tool.started",
        turnId: turn.id,
        callId,
        name,
        arguments: formatValue(state.rawInput),
      });
    }
    if (state.status !== "completed" && state.status !== "failed") return;
    const raw = acpRecord(state.rawOutput);
    const result = acpRecord(raw?.Result ?? raw?.result);
    const content = records(state.content).flatMap(
      (entry) => asString(acpRecord(entry.content)?.text) ?? [],
    );
    this.emit({
      type: "tool.completed",
      turnId: turn.id,
      callId,
      name,
      output:
        asString(raw?.text ?? raw?.output_for_prompt ?? raw?.output ?? result?.output) ??
        (content.length ? content.join("\n") : formatValue(state.rawOutput)),
      error:
        state.status === "failed"
          ? (asString(state.error ?? raw?.error) ?? "Grok tool failed")
          : undefined,
    });
  }

  private emitUsage(turnId: string, value: unknown) {
    const usage = acpRecord(value);
    if (!usage) return;
    const counts = {
      inputTokens: tokenCount(usage.inputTokens),
      outputTokens: tokenCount(usage.outputTokens),
      contextTokens: tokenCount(usage.used ?? usage.contextTokens),
      contextWindow: tokenCount(usage.size ?? usage.contextWindow),
    };
    if (Object.values(counts).some((value) => value !== undefined)) {
      this.emit({ type: "usage.reported", turnId, ...counts });
    }
  }

  private completeTurn(turn: ActiveTurn, result?: AcpObject) {
    if (this.turn !== turn) return;
    const reason = asString(result?.stopReason);
    this.emitUsage(turn.id, result?.usage ?? acpRecord(result?._meta)?.usage);
    switch (reason) {
      case "cancelled":
      case "end_turn":
      case "max_tokens":
      case "max_turn_requests":
        this.clearTurn(turn);
        this.emit({
          type: "turn.completed",
          turnId: turn.id,
          text: turn.text.join(""),
          stopReason: reason === "cancelled" ? "interrupted" : "end_turn",
        });
        break;
      default:
        this.failTurn(
          turn,
          asString(result?.message) ?? `Grok stopped the turn: ${reason ?? "missing stop reason"}`,
          true,
        );
    }
  }

  private failTurn(turn: ActiveTurn, error: unknown, recoverable: boolean) {
    if (this.turn !== turn) return;
    this.clearTurn(turn);
    this.emit({ type: "turn.failed", turnId: turn.id, message: errorMessage(error), recoverable });
  }

  private clearTurn(turn: ActiveTurn) {
    this.turn = undefined;
    turn.abort.abort();
    this.cancelQuestions();
  }

  private cancelQuestions() {
    for (const reply of this.questions.values()) reply();
    this.questions.clear();
  }

  private emit(event: HarnessEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        process.emitWarning(errorMessage(error));
      }
    }
  }
}

export function createGrokDriver(options: GrokDriverOptions = {}): HarnessDriver {
  const command = options.command ?? "grok";
  const modelCacheTtlMs = options.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  const clock = options.now ?? Date.now;
  let cachedModels: { at: number; providers: ModelProvider[] } | undefined;
  let pendingModels: Promise<ModelProvider[]> | undefined;
  const args = (tail: string[]) => [...(options.args ?? []), "--no-auto-update", ...tail];
  const environment = (sessionEnv?: Record<string, string>): NodeJS.ProcessEnv => ({
    ...process.env,
    ...options.env,
    ...sessionEnv,
    GROK_DISABLE_AUTOUPDATER: "1",
  });
  const sessionArgs = (fullPermissions: boolean) =>
    args(fullPermissions ? ["agent", "stdio"] : ["--permission-mode", "default", "agent", "stdio"]);

  return {
    id: "grok",
    displayName: "Grok",
    capabilities: {
      nativeSteering: false,
      resumable: true,
      supportsMcp: true,
      supportsImages: true,
      supportsReasoning: true,
      supportsSpeed: false,
    },
    async probe() {
      try {
        const { stdout, stderr } = await exec(command, args(["--version"]), {
          env: environment(),
          timeout: options.probeTimeoutMs ?? 10_000,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
          windowsHide: true,
        });
        const version = /\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/.exec(`${stdout}\n${stderr}`)?.[0];
        return version
          ? { available: true, version }
          : { available: false, reason: "Grok returned no version" };
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        const reason =
          failure.code === "ENOENT"
            ? "Grok CLI is missing or not on PATH"
            : failure.killed
              ? "Grok version probe timed out"
              : errorMessage(error);
        return { available: false, reason };
      }
    },
    listModels(): Promise<ModelProvider[]> {
      if (modelCacheTtlMs > 0 && cachedModels && clock() - cachedModels.at < modelCacheTtlMs) {
        return Promise.resolve(cachedModels.providers);
      }
      pendingModels ??= (async (): Promise<ModelProvider[]> => {
        const client = new AcpStdio({
          command,
          args: sessionArgs(false),
          env: environment(),
          requestTimeoutMs: options.requestTimeoutMs,
        });
        let authenticated = false;
        let warning: string | undefined;
        const models: ModelProvider["models"] = [];
        try {
          const response = await initialize(client);
          const meta = acpRecord(response._meta);
          authenticated = Boolean(asString(meta?.defaultAuthMethodId));
          const modelState = acpRecord(response.models ?? meta?.modelState);
          for (const model of records(modelState?.availableModels)) {
            const id = asString(model.modelId);
            if (id) models.push({ id, name: asString(model.name) ?? id, available: true });
          }
        } catch (error) {
          warning = errorMessage(error);
        } finally {
          await client.close();
        }
        if (models.length === 0)
          models.push({ id: DEFAULT_MODEL, name: "Grok Build", available: !warning });
        const providers: ModelProvider[] = [
          { id: "grok", name: "Grok", authenticated, models, warning },
        ];
        if (authenticated && !warning && modelCacheTtlMs > 0) {
          cachedModels = { at: clock(), providers };
        }
        return providers;
      })().finally(() => {
        pendingModels = undefined;
      });
      return pendingModels;
    },
    async openSession(spec) {
      if (spec.osUser !== undefined && spec.osUser !== userInfo().username) {
        throw new Error(`Grok must be launched by the session's OS user: ${spec.osUser}`);
      }
      const mcpServers = (spec.mcpServers ?? []).map(mcpServer);
      const env = environment(spec.env);
      let session: GrokSession | undefined;
      const client = new AcpStdio({
        command,
        args: sessionArgs(spec.fullPermissions),
        cwd: spec.cwd,
        env,
        requestTimeoutMs: options.requestTimeoutMs,
        onNotification: (method, params) => session?.onNotification(method, params),
        onRequest: (method, params) =>
          session
            ? session.onRequest(method, params)
            : method === "session/request_permission"
              ? { outcome: CANCELLED }
              : undefined,
      });
      try {
        const initialized = await initialize(client);
        const setup = await setupSession(client, initialized, spec, mcpServers, env);
        const providerSessionId = spec.resumeSessionId ?? asString(setup.sessionId);
        if (!providerSessionId) throw new Error("Grok did not return an ACP session ID");
        await configureSession(client, providerSessionId, setup, initialized, spec);
        session = new GrokSession(
          client,
          spec.sessionKey,
          providerSessionId,
          spec.fullPermissions,
          spec.systemPrompt,
          options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS,
        );
        return session;
      } catch (error) {
        await client.close();
        throw error;
      }
    },
  };
}
