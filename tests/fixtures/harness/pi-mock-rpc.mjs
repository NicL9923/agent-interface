#!/usr/bin/env node
// Fake `pi` CLI for tests/harness-pi-driver.test.ts. It speaks the documented `pi --mode rpc`
// protocol (Pi docs/rpc.md, v0.79) over real stdio: LF-delimited JSON, responses echo the
// request `id`, events carry none, and extension dialogs block until an `extension_ui_response`.
//
// Environment:
//   PI_MOCK_LOG           JSONL file recording argv, env and every received command.
//   PI_MOCK_SESSION_DIR   Directory for generated session files.
//   PI_MOCK_VERSION_MODE  "hang" or "fail" to break `--version`.
//   PI_MOCK_MODELS        "fail" to reject get_available_models.
//
// Prompt keywords pick a scripted turn: "tool", "ask", "confirm", "slow", "crash",
// "abort-crash", "fail"; anything else streams thinking + text.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const log = (entry) => {
  if (process.env.PI_MOCK_LOG) appendFileSync(process.env.PI_MOCK_LOG, `${JSON.stringify(entry)}\n`);
};

function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (argv.includes("--version")) {
  if (process.env.PI_MOCK_VERSION_MODE === "hang") setInterval(() => undefined, 1_000);
  else if (process.env.PI_MOCK_VERSION_MODE === "fail") {
    process.stderr.write("pi: broken install\n");
    process.exit(2);
  } else {
    process.stdout.write("0.79.10\n");
    process.exit(0);
  }
} else if (flag("--mode") !== "rpc") {
  process.stderr.write("mock only supports --mode rpc\n");
  process.exit(64);
} else {
  runRpc();
}

function runRpc() {
  const extensionPath = flag("--extension");
  const appendPromptArg = flag("--append-system-prompt");
  const mcpConfigPath = process.env.WILDBOTS_PI_MCP_CONFIG;
  log({
    kind: "start",
    pid: process.pid,
    argv,
    approval: process.env.WILDBOTS_PI_APPROVAL ?? null,
    extensionExists: extensionPath ? existsSync(extensionPath) : null,
    appendSystemPrompt:
      appendPromptArg && existsSync(appendPromptArg)
        ? readFileSync(appendPromptArg, "utf8")
        : (appendPromptArg ?? null),
    mcpConfig: mcpConfigPath ? JSON.parse(readFileSync(mcpConfigPath, "utf8")) : null,
    custom: process.env.PI_MOCK_CUSTOM ?? null,
  });

  // A session file restores its saved model and thinking level, ignoring CLI flags, the way a
  // resumed Pi session does.
  let sessionFile = flag("--session");
  let model = { provider: flag("--provider") ?? "anthropic", id: flag("--model") ?? "claude-sonnet-4-5" };
  let thinkingLevel = flag("--thinking") ?? "medium";
  if (argv.includes("--no-session")) {
    sessionFile = undefined;
  } else if (sessionFile && existsSync(sessionFile)) {
    const saved = JSON.parse(readFileSync(sessionFile, "utf8"));
    model = saved.model;
    thinkingLevel = saved.thinkingLevel;
  } else {
    sessionFile ??= path.join(process.env.PI_MOCK_SESSION_DIR ?? process.cwd(), `session-${process.pid}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({ model, thinkingLevel }));
  }
  const fullModel = () => ({ ...model, name: model.id, reasoning: true, contextWindow: 200_000 });

  // Writes split every record into byte chunks, cutting through multi-byte UTF-8 sequences.
  const outQueue = [];
  let flushing = false;
  const emit = (record) => {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    for (let i = 0; i < bytes.length; i += 7) outQueue.push(bytes.subarray(i, i + 7));
    if (!flushing) flush();
  };
  function flush() {
    flushing = true;
    const chunk = outQueue.shift();
    if (chunk === undefined) {
      flushing = false;
      return;
    }
    process.stdout.write(chunk, () => setImmediate(flush));
  }
  const respond = (command, id, data, error) =>
    emit({
      type: "response",
      command,
      ...(id === undefined ? {} : { id }),
      success: error === undefined,
      ...(data === undefined ? {} : { data }),
      ...(error === undefined ? {} : { error }),
    });

  const waiters = new Map();
  const waitForUi = (id) => new Promise((resolve) => waiters.set(id, resolve));
  let abortTurn;
  let abortCrash = false;
  let streaming = false;

  const assistant = (text, stopReason = "stop", extra = {}) => ({
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    provider: model.provider,
    model: model.id,
    usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155 },
    stopReason,
    ...extra,
  });
  const delta = (type, text) =>
    emit({ type: "message_update", message: {}, assistantMessageEvent: { type, contentIndex: 0, delta: text } });

  async function runTurn(message) {
    streaming = true;
    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    let final;
    if (message.includes("abort-crash")) {
      abortCrash = true;
      await new Promise(() => undefined);
    } else if (message.includes("crash")) {
      delta("text_delta", "partial");
      setTimeout(() => process.exit(1), 20);
      return;
    } else if (message.includes("slow")) {
      delta("text_delta", "working");
      await new Promise((resolve) => (abortTurn = resolve));
      final = assistant("working", "aborted");
    } else if (message.includes("fail")) {
      final = assistant("", "error", { errorMessage: "429 rate limited" });
    } else if (message.includes("tool")) {
      emit({ type: "message_end", message: assistant("", "toolUse") });
      emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
      emit({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "README.md\n" }], details: {} },
        isError: false,
      });
      emit({ type: "tool_execution_start", toolCallId: "call_2", toolName: "read", args: { path: "missing" } });
      emit({
        type: "tool_execution_end",
        toolCallId: "call_2",
        toolName: "read",
        result: { content: [{ type: "text", text: "ENOENT: missing" }], details: {} },
        isError: true,
      });
      emit({ type: "turn_start" });
      emit({ type: "message_start", message: { role: "assistant", content: [] } });
      delta("text_delta", "Listed.");
      final = assistant("Listed.");
    } else if (message.includes("ask") || message.includes("confirm")) {
      const id = message.includes("ask") ? "ui-select-1" : "ui-confirm-1";
      emit({ type: "extension_ui_request", id: "ui-status", method: "setStatus", statusKey: "x", statusText: "busy" });
      emit(
        message.includes("ask")
          ? { type: "extension_ui_request", id, method: "select", title: "Pick a color", options: ["red", "blue"] }
          : { type: "extension_ui_request", id, method: "confirm", title: "Allow bash?", message: "rm -rf build" },
      );
      const response = await waitForUi(id);
      const answer = JSON.stringify(response);
      delta("text_delta", answer);
      final = assistant(answer);
    } else {
      delta("thinking_delta", "Let me think… ");
      delta("thinking_delta", "done.");
      // Multi-byte text plus U+2028, which a readline-based client would split.
      delta("text_delta", "Héllo 🤠");
      delta("text_delta", " wörld !");
      final = assistant("Héllo 🤠 wörld !");
    }
    emit({ type: "message_end", message: final });
    emit({ type: "turn_end", message: final, toolResults: [] });
    streaming = false;
    emit({ type: "agent_end", messages: [final] });
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handle(JSON.parse(line));
    }
  });
  // Pi keeps running on SIGTERM only long enough to clean up.
  process.on("SIGTERM", () => {
    log({ kind: "sigterm" });
    process.exit(0);
  });

  // Non-protocol noise Pi can print before RPC starts; clients must skip it.
  process.stdout.write("Loading extensions...\n");

  function handle(command) {
    log({ kind: "command", command });
    const { id, type } = command;
    switch (type) {
      case "get_state":
        respond(type, id, {
          model: fullModel(),
          thinkingLevel,
          isStreaming: streaming,
          ...(sessionFile ? { sessionFile } : {}),
          sessionId: "mock-session-id",
        });
        return;
      case "get_available_models":
        if (process.env.PI_MOCK_MODELS === "fail") return respond(type, id, undefined, "models unavailable");
        respond(type, id, {
          models: [
            { provider: "openrouter", id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
            { provider: "openrouter", id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
            { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
            { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
            { provider: "ollama", id: "llama3.1" },
          ],
        });
        return;
      case "set_model":
        model = { provider: command.provider, id: command.modelId };
        if (sessionFile) writeFileSync(sessionFile, JSON.stringify({ model, thinkingLevel }));
        respond(type, id, fullModel());
        return;
      case "set_thinking_level":
        thinkingLevel = command.level;
        respond(type, id);
        return;
      case "prompt":
        if (streaming) return respond(type, id, undefined, "Agent is already streaming");
        respond(type, id);
        void runTurn(command.message);
        return;
      case "abort":
        if (abortCrash) process.exit(1);
        respond(type, id);
        abortTurn?.();
        return;
      case "extension_ui_response": {
        const waiter = waiters.get(id);
        waiters.delete(id);
        const { type: _type, id: _id, ...rest } = command;
        waiter?.(rest);
        return;
      }
      default:
        respond(type ?? "parse", id, undefined, `Unknown command: ${type}`);
    }
  }
}
