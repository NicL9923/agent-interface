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
import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
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
const DEFAULT_MODEL = "gemini-4-neon";
const DEFAULT_MODEL_NAME = "Gemini 4 Neon";
const CANCELLED = { outcome: "cancelled" };
const PROMPT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60_000;
const MINIMUM_VERSION = [1, 5, 0] as const;
const OPEN_MODEL_ACCESS_VERSION = [1, 5, 1] as const;
const REMOVED_ENV_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "DISPLAY",
  "WAYLAND_DISPLAY",
]);

type AcpObject = Record<string, unknown>;

export interface AntigravityDriverOptions {
  command?: string;
  /** Prefix arguments for a launcher (such as `node mock-acp.mjs`). Antigravity args follow. */
  args?: readonly string[];
  /** Directory storing Antigravity ACP profile and OAuth state (`--gemini-dir`). Defaults to `~/.gemini`. */
  geminiDir?: string;
  env?: NodeJS.ProcessEnv;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  /** How long a discovered model catalog stays cached. Default 5 minutes. */
  modelCacheTtlMs?: number;
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

function parseVersion(version: string | undefined): [number, number, number] | undefined {
  const match = /\b(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index++) {
    const diff = left[index]! - right[index]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

function mcpServer(server: HarnessMcpServerSpec): AcpObject {
  const pairs = (values?: Record<string, string>) =>
    Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));

  if (server.transport === "http") {
    if (!server.url) throw new Error(`Antigravity MCP server "${server.name}" requires a URL`);
    return { type: "http", name: server.name, url: server.url, headers: pairs(server.headers) };
  }
  if (!server.command)
    throw new Error(`Antigravity MCP server "${server.name}" requires a command`);
  return {
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    env: pairs(server.env),
  };
}

function supportsSystemPromptAppend(initialized: AcpObject): boolean {
  const capabilities = acpRecord(initialized.agentCapabilities);
  const meta = acpRecord(capabilities?._meta);
  const antigravity = acpRecord(meta?.antigravity);
  const systemPrompt = acpRecord(antigravity?.systemPrompt);
  return systemPrompt?.append === true;
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

async function initialize(client: AcpStdio, version?: string) {
  const parsed = parseVersion(version);
  const clientInfo =
    parsed === undefined || compareVersions(parsed, OPEN_MODEL_ACCESS_VERSION) >= 0
      ? { name: "wildbots", title: "WildBots", version: "0.1.0" }
      : { name: "zed", version: "0.0.0" };
  const response = acpRecord(
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo,
    }),
  );
  if (response?.protocolVersion !== 1 && response?.protocolVersion !== 2) {
    throw new Error(
      `Antigravity returned an unsupported ACP protocol version: ${String(response?.protocolVersion)}`,
    );
  }
  return response;
}

async function authenticate(
  client: AcpStdio,
  initialized: AcpObject,
  apiKey: string | undefined,
): Promise<void> {
  const methodId = apiKey ? "gemini-api-key" : "oauth-personal";
  const methods = records(initialized.authMethods);
  if (methods.length > 0 && !methods.some((entry) => entry.id === methodId)) return;
  await client.request("authenticate", { methodId });
}

async function setupSession(
  client: AcpStdio,
  initialized: AcpObject,
  spec: HarnessSessionSpec,
  mcpServers: AcpObject[],
  apiKey: string | undefined,
): Promise<{ setup: AcpObject; systemPromptApplied: boolean }> {
  await authenticate(client, initialized, apiKey);
  const appendPrompt =
    Boolean(spec.systemPrompt?.trim()) && supportsSystemPromptAppend(initialized);
  const meta = appendPrompt
    ? { _meta: { antigravity: { systemPrompt: { append: spec.systemPrompt!.trim() } } } }
    : {};
  const baseParams: AcpObject = { cwd: spec.cwd, mcpServers, ...meta };
  const result = spec.resumeSessionId
    ? await client.request("session/load", { ...baseParams, sessionId: spec.resumeSessionId })
    : await client.request("session/new", baseParams);
  return { setup: acpRecord(result) ?? {}, systemPromptApplied: appendPrompt };
}

async function configureSession(
  client: AcpStdio,
  sessionId: string,
  setup: AcpObject,
  spec: HarnessSessionSpec,
) {
  let options = records(setup.configOptions);
  const modelOption = findConfig(options, "model", ["model"]);
  const models = acpRecord(setup.models);
  const selected = spec.model.trim();
  const currentModel = asString(modelOption?.currentValue ?? models?.currentModelId);
  const model = selected || currentModel;
  const effort = spec.reasoning?.trim();

  if (model && model !== currentModel) {
    try {
      await client.request("session/set_model", { sessionId, modelId: model });
    } catch (error) {
      if (!modelOption || !unsupportedOption(error)) throw error;
      const response = acpRecord(
        await client.request("session/set_config_option", {
          sessionId,
          configId: modelOption.id,
          value: model,
        }),
      );
      if (Array.isArray(response?.configOptions)) options = records(response.configOptions);
    }
  }

  const effortOption = findConfig(options, "thought_level", ["thought_level", "reasoning_effort"]);
  if (
    effortOption &&
    effort &&
    effort !== "none" &&
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
  abort: AbortController;
  tools: Map<string, AcpObject>;
  text: string[];
  sent: boolean;
  cancelling: boolean;
}

type ReplyToQuestion = (answers?: Record<string, string>) => void;

function isInteractionRequest(params: AcpObject | undefined): boolean {
  const toolCall = acpRecord(params?.toolCall);
  const id = asString(toolCall?.toolCallId);
  return id !== undefined && id.startsWith("interaction_");
}

function questionFromPermission(params: AcpObject): {
  question: HarnessQuestion;
  options: AcpObject[];
} | null {
  const toolCall = acpRecord(params.toolCall);
  const id = asString(toolCall?.toolCallId);
  const options = records(params.options).filter(
    (option) => typeof option.optionId === "string" && option.optionId.trim().length > 0,
  );
  if (!id || options.length === 0) return null;
  const prompt = asString(toolCall?.title)?.trim() || "Choose an option.";
  return {
    question: {
      id,
      header: "Question",
      question: prompt,
      options: options.map((option) => asString(option.name)?.trim() || String(option.optionId)),
      multiple: false,
    },
    options,
  };
}

function matchPermissionOption(
  options: AcpObject[],
  questionId: string,
  answers: Record<string, string>,
): AcpObject {
  const raw = Object.hasOwn(answers, questionId)
    ? asString(answers[questionId])?.trim()
    : Object.values(answers)
        .map((value) => asString(value)?.trim())
        .find(Boolean);
  if (!raw) return { outcome: CANCELLED };
  const exactId = options.find((option) => option.optionId === raw);
  if (exactId) return { outcome: { outcome: "selected", optionId: exactId.optionId } };
  const byLabel = options.find(
    (option) => (asString(option.name)?.trim() || String(option.optionId)) === raw,
  );
  if (byLabel) return { outcome: { outcome: "selected", optionId: byLabel.optionId } };
  return { outcome: CANCELLED };
}

function modelsFromSetup(setup: AcpObject): ModelProvider["models"] {
  const seen = new Set<string>();
  const models: ModelProvider["models"] = [];
  const options = records(setup.configOptions);
  const modelOption = findConfig(options, "model", ["model"]);
  for (const option of advertisedValues(modelOption?.options)) {
    const id = asString(option.value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: asString(option.name) ?? id, available: true });
  }
  const modelState = acpRecord(setup.models);
  for (const entry of records(modelState?.availableModels)) {
    const id = asString(entry.modelId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: asString(entry.name) ?? id, available: true });
  }
  return models;
}

class AntigravitySession implements HarnessSession {
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly questions = new Map<string, ReplyToQuestion>();
  private turn?: ActiveTurn;
  private closedEvent?: Extract<HarnessEvent, { type: "session.closed" }>;
  private closing = false;
  private nextQuestion = 0;
  private systemPrompt?: string;

  constructor(
    private readonly client: AcpStdio,
    readonly id: string,
    readonly providerSessionId: string,
    private readonly fullPermissions: boolean,
    systemPrompt: string | undefined,
    private readonly promptTimeoutMs: number,
  ) {
    this.systemPrompt = systemPrompt?.trim() ? systemPrompt.trim() : undefined;
    void client.closed.then(({ reason, unexpected }) => {
      this.closedEvent = { type: "session.closed", reason: reason.message, unexpected };
      this.cancelQuestions();
      if (unexpected && this.turn) this.failTurn(this.turn, reason, false);
      this.emit(this.closedEvent);
      this.listeners.clear();
    });
  }

  events(listener: (event: HarnessEvent) => void): () => void {
    if (this.closedEvent) return () => undefined;
    this.listeners.add(listener);
    listener({ type: "session.ready", providerSessionId: this.providerSessionId });
    return () => this.listeners.delete(listener);
  }

  async startTurn(input: HarnessTurnInput): Promise<void> {
    if (this.closing || this.closedEvent) throw new Error("Antigravity session is closed");
    if (this.turn) throw new Error("Antigravity already has an active turn");

    const turn: ActiveTurn = {
      id: input.turnId,
      abort: new AbortController(),
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
      { sessionId: this.providerSessionId, prompt },
      { timeoutMs: this.promptTimeoutMs, signal: turn.abort.signal },
    );
    void request
      .then((response) => this.completeTurn(turn, acpRecord(response)))
      .catch((error: unknown) => this.failTurn(turn, error, error instanceof AcpRpcError));
  }

  async answerQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    const reply = this.questions.get(requestId);
    if (!reply) throw new Error(`Unknown Antigravity question request: ${requestId}`);
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
    const cancel = this.client.notify("session/cancel", { sessionId: this.providerSessionId });
    this.cancelQuestions();
    await cancel;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.turn) this.clearTurn(this.turn);
    await this.client.close();
  }

  onRequest(method: string, value: unknown): unknown {
    const params = acpRecord(value);
    const turn = this.turn;
    const current = turn?.sent && !turn.cancelling && params?.sessionId === this.providerSessionId;
    if (method !== "session/request_permission") return undefined;
    if (!current || !turn || !params) return { outcome: CANCELLED };
    if (isInteractionRequest(params)) {
      const parsed = questionFromPermission(params);
      if (!parsed) return { outcome: CANCELLED };
      const requestId = `question-${++this.nextQuestion}`;
      const pending = deferred<unknown>();
      this.questions.set(requestId, (answers) => {
        pending.resolve(
          answers === undefined
            ? { outcome: CANCELLED }
            : matchPermissionOption(parsed.options, parsed.question.id, answers),
        );
      });
      this.emit({
        type: "question.asked",
        turnId: turn.id,
        requestId,
        title: "Question",
        prompt: parsed.question.question,
        questions: [parsed.question],
      });
      return pending.promise;
    }
    const options = records(params.options);
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

  onNotification(method: string, value: unknown) {
    if (method !== "session/update") return;
    const params = acpRecord(value);
    const turn = this.turn;
    if (!turn?.sent || params?.sessionId !== this.providerSessionId) return;
    const update = acpRecord(params.update);
    if (!update) return;
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
    const content = records(state.content).flatMap(
      (entry) => asString(acpRecord(entry.content)?.text) ?? [],
    );
    this.emit({
      type: "tool.completed",
      turnId: turn.id,
      callId,
      name,
      output:
        asString(
          raw?.combinedOutput ??
            raw?.combined_output ??
            raw?.text ??
            raw?.output ??
            state.rawOutput,
        ) ?? (content.length ? content.join("\n") : formatValue(state.rawOutput)),
      error:
        state.status === "failed"
          ? (asString(state.error ?? raw?.error) ?? "Antigravity tool failed")
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
    if (Object.values(counts).some((count) => count !== undefined)) {
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
          asString(result?.message) ??
            `Antigravity stopped the turn: ${reason ?? "missing stop reason"}`,
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

export function createAntigravityDriver(options: AntigravityDriverOptions = {}): HarnessDriver {
  const command = options.command ?? "agy";
  const prefixArgs = [...(options.args ?? [])];
  const geminiDir =
    options.geminiDir ?? process.env.WILDBOTS_ANTIGRAVITY_GEMINI_DIR ?? join(homedir(), ".gemini");
  const modelCacheTtlMs = options.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  let cachedModels: { at: number; providers: ModelProvider[] } | undefined;
  let discoveredVersion: string | undefined;

  const buildEnv = (
    sessionEnv?: Record<string, string>,
  ): { env: NodeJS.ProcessEnv; apiKey?: string } => {
    const merged: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    const clean: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(merged)) {
      if (!REMOVED_ENV_KEYS.has(key.toUpperCase())) clean[key] = value;
    }
    const apiKey = sessionEnv?.GEMINI_API_KEY?.trim() || undefined;
    return {
      apiKey,
      env: {
        ...clean,
        ...sessionEnv,
        ...(apiKey ? { GEMINI_API_KEY: apiKey } : {}),
        GEMINI_HOME: geminiDir,
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        AGY_CLI_DISABLE_AUTO_UPDATE: "1",
        PYTHONUNBUFFERED: "1",
        // agy 1.5+ keeps file-stored OAuth tokens when it sees SSH_CONNECTION, avoiding OS keyring issues on headless Linux.
        ...(apiKey ? {} : { SSH_CONNECTION: clean.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0" }),
      },
    };
  };

  const acpArgs = (fullPermissions: boolean) => [
    ...prefixArgs,
    "acp",
    "--gemini-dir",
    geminiDir,
    "--app-data-dir",
    "antigravity-acp",
    ...(fullPermissions ? ["--dangerously-skip-permissions"] : []),
  ];

  const ensureProfileDir = () => {
    mkdirSync(join(geminiDir, "antigravity-acp"), { recursive: true, mode: 0o700 });
  };

  return {
    id: "antigravity",
    displayName: "Antigravity",
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
        const { stdout, stderr } = await exec(command, [...prefixArgs, "--version"], {
          env: buildEnv().env,
          timeout: options.probeTimeoutMs ?? 10_000,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
          windowsHide: true,
        });
        const version = /\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/.exec(`${stdout}\n${stderr}`)?.[0];
        if (!version) return { available: false, reason: "Antigravity CLI returned no version" };
        const parsed = parseVersion(version);
        if (parsed && compareVersions(parsed, MINIMUM_VERSION) < 0) {
          return {
            available: false,
            version,
            reason: `Antigravity CLI ${version} is too old; upgrade to 1.5.0 or newer.`,
          };
        }
        discoveredVersion = version;
        return { available: true, version };
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        const reason =
          failure.code === "ENOENT"
            ? "Antigravity CLI (agy) is missing or not on PATH"
            : failure.killed
              ? "Antigravity version probe timed out"
              : errorMessage(error);
        return { available: false, reason };
      }
    },
    async listModels(): Promise<ModelProvider[]> {
      if (modelCacheTtlMs > 0 && cachedModels && Date.now() - cachedModels.at < modelCacheTtlMs) {
        return cachedModels.providers;
      }
      ensureProfileDir();
      const scratch = await mkdtemp(join(tmpdir(), "wildbots-agy-models-"));
      const { env, apiKey } = buildEnv();
      const client = new AcpStdio({
        command,
        args: acpArgs(false),
        cwd: scratch,
        env,
        requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      });
      let authenticated = false;
      let warning: string | undefined;
      let models: ModelProvider["models"] = [];
      try {
        const initialized = await initialize(client, discoveredVersion);
        const { setup } = await setupSession(
          client,
          initialized,
          {
            botId: "probe",
            sessionKey: "probe",
            cwd: scratch,
            model: DEFAULT_MODEL,
            fullPermissions: false,
          },
          [],
          apiKey,
        );
        authenticated = true;
        models = modelsFromSetup(setup);
      } catch (error) {
        warning = errorMessage(error);
      } finally {
        await client.close().catch(() => undefined);
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
      if (models.length === 0) {
        models = [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL_NAME, available: authenticated }];
      }
      const providers: ModelProvider[] = [
        {
          id: "google",
          name: "Antigravity (Google)",
          aliases: ["antigravity"],
          authenticated,
          models,
          ...(warning ? { warning } : {}),
        },
      ];
      if (authenticated && modelCacheTtlMs > 0) {
        cachedModels = { at: Date.now(), providers };
      }
      return providers;
    },
    async openSession(spec) {
      if (spec.osUser !== undefined && spec.osUser !== userInfo().username) {
        throw new Error(`Antigravity must be launched by the session's OS user: ${spec.osUser}`);
      }
      ensureProfileDir();
      const mcpServers = (spec.mcpServers ?? []).map(mcpServer);
      const { env, apiKey } = buildEnv(spec.env);
      let session: AntigravitySession | undefined;
      const client = new AcpStdio({
        command,
        args: acpArgs(spec.fullPermissions),
        cwd: spec.cwd,
        env,
        requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
        onNotification: (method, params) => session?.onNotification(method, params),
        onRequest: (method, params) =>
          session
            ? session.onRequest(method, params)
            : method === "session/request_permission"
              ? { outcome: CANCELLED }
              : undefined,
      });
      try {
        const initialized = await initialize(client, discoveredVersion);
        const { setup, systemPromptApplied } = await setupSession(
          client,
          initialized,
          spec,
          mcpServers,
          apiKey,
        );
        const providerSessionId = spec.resumeSessionId ?? asString(setup.sessionId);
        if (!providerSessionId) throw new Error("Antigravity did not return an ACP session ID");
        await configureSession(client, providerSessionId, setup, spec);
        session = new AntigravitySession(
          client,
          spec.sessionKey,
          providerSessionId,
          spec.fullPermissions,
          systemPromptApplied ? undefined : spec.systemPrompt,
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
