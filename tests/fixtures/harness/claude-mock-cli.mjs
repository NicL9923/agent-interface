#!/usr/bin/env node
// A fake `claude` CLI that speaks the real `stream-json` stdio protocol for driver tests.
//
// Environment:
//   CLAUDE_MOCK_RECORD       JSONL file that receives {argv, env, mcpConfig} at launch and every stdin frame.
//   CLAUDE_MOCK_VERSION      `--version` output (default "2.1.330 (Claude Code)").
//   CLAUDE_MOCK_VERSION_EXIT `--version` exit code (default 0).
//   CLAUDE_MOCK_LOGGED_IN    "0" makes `auth status` report signed out.
//   CLAUDE_MOCK_IGNORE_SIGTERM "1" ignores SIGTERM so the caller must escalate to SIGKILL.
//
// A user message picks its scenario from its text: "ask", "tool", "wait", "fail", "crash",
// "sigkill", otherwise a plain streamed reply.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const record = (entry) => {
  if (process.env.CLAUDE_MOCK_RECORD) {
    appendFileSync(process.env.CLAUDE_MOCK_RECORD, `${JSON.stringify(entry)}\n`);
  }
};

if (argv.includes("--version")) {
  process.stdout.write(`${process.env.CLAUDE_MOCK_VERSION ?? "2.1.330 (Claude Code)"}\n`);
  process.exit(Number(process.env.CLAUDE_MOCK_VERSION_EXIT ?? 0));
}

if (argv[0] === "auth" && argv[1] === "status") {
  const loggedIn = process.env.CLAUDE_MOCK_LOGGED_IN !== "0";
  process.stdout.write(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" })}\n`);
  process.exit(loggedIn ? 0 : 1);
}

const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

// The real CLI rejects stream-json output without --verbose and stream-json input without --print.
if (!argv.includes("--print") || flag("--input-format") !== "stream-json") {
  process.stderr.write("Error: --input-format=stream-json requires --print\n");
  process.exit(1);
}
if (flag("--output-format") !== "stream-json" || !argv.includes("--verbose")) {
  process.stderr.write("Error: --output-format=stream-json requires --verbose\n");
  process.exit(1);
}
if (flag("--permission-mode") === "bypassPermissions" && !argv.includes("--allow-dangerously-skip-permissions")) {
  process.stderr.write("Error: bypassPermissions needs --allow-dangerously-skip-permissions\n");
  process.exit(1);
}

const mcpPath = flag("--mcp-config");
record({
  argv,
  cwd: process.cwd(),
  env: {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    WILDBOTS_TEST_VAR: process.env.WILDBOTS_TEST_VAR,
  },
  mcpPath,
  mcpConfig: mcpPath ? JSON.parse(readFileSync(mcpPath, "utf8")) : undefined,
});

if (process.env.CLAUDE_MOCK_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});

const sessionId = flag("--resume") ?? flag("--session-id") ?? "00000000-0000-4000-8000-000000000000";
const model = flag("--model") ?? "claude-opus-5-5";
const permissionMode = flag("--permission-mode") ?? "default";
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

let busy = false;
let interrupted = false;
let wakeInterrupt;
const awaitingControl = new Map();
let nextRequest = 1;

function askHost(request) {
  const requestId = `cli-${nextRequest++}`;
  send({ type: "control_request", request_id: requestId, request });
  return new Promise((resolve) => awaitingControl.set(requestId, resolve));
}

const delta = (index, inner) =>
  send({
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: inner },
    parent_tool_use_id: null,
    session_id: sessionId,
  });

const assistant = (content, usage) =>
  send({
    type: "assistant",
    message: { role: "assistant", model, content, usage },
    parent_tool_use_id: null,
    session_id: sessionId,
  });

const toolResult = (id, content, isError) =>
  send({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });

const result = (fields) =>
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    num_turns: 1,
    usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 },
    modelUsage: {
      [model]: { inputTokens: 10, outputTokens: 7, cacheReadInputTokens: 90, contextWindow: 1_000_000 },
    },
    ...fields,
  });

async function runTurn(text) {
  busy = true;
  send({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), permissionMode });
  if (text.includes("sigkill")) process.kill(process.pid, "SIGKILL");
  if (text.includes("crash")) {
    delta(0, { type: "text_delta", text: "about to" });
    await tick();
    process.stderr.write("fatal: mock crash\n");
    process.exit(3);
  }
  if (text.includes("wait")) {
    delta(0, { type: "text_delta", text: "working" });
    // An interrupt can arrive before this turn starts; the real CLI still honors it.
    if (!interrupted) {
      // A pending promise alone does not keep Node alive; a busy CLI must not exit on stdin close.
      const keepAlive = setInterval(() => {}, 1_000);
      await new Promise((resolve) => {
        wakeInterrupt = resolve;
      });
      clearInterval(keepAlive);
    }
    interrupted = false;
    result({ subtype: "error_during_execution", is_error: true, result: undefined, errors: ["Request was aborted."] });
    busy = false;
    return;
  }
  if (text.includes("fail")) {
    result({ subtype: "error_during_execution", is_error: true, errors: ["mock failure"] });
    busy = false;
    return;
  }
  if (text.includes("ask")) {
    const input = {
      questions: [
        {
          question: "Which color?",
          header: "Color",
          multiSelect: false,
          options: [
            { label: "Red", description: "Warm" },
            { label: "Blue", description: "Cool" },
          ],
        },
      ],
    };
    assistant([{ type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input }]);
    const decision = await askHost({
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input,
      tool_use_id: "toolu_ask",
    });
    const answer = decision?.updatedInput?.answers?.["Which color?"];
    toolResult("toolu_ask", `User answered: ${answer}`);
    delta(0, { type: "text_delta", text: `You chose ${answer}` });
    result({ result: `You chose ${answer}` });
    busy = false;
    return;
  }
  if (text.includes("tool")) {
    const input = { command: "ls" };
    assistant([{ type: "tool_use", id: "toolu_bash", name: "Bash", input }]);
    const decision = await askHost({ subtype: "can_use_tool", tool_name: "Bash", input, tool_use_id: "toolu_bash" });
    if (decision?.behavior === "allow") toolResult("toolu_bash", [{ type: "text", text: "file.txt" }]);
    else toolResult("toolu_bash", decision?.message ?? "denied", true);
    result({ result: "tool done" });
    busy = false;
    return;
  }
  delta(0, { type: "thinking_delta", thinking: "Let me think." });
  await tick();
  delta(1, { type: "text_delta", text: "Hello" });
  delta(1, { type: "text_delta", text: " world" });
  assistant([{ type: "text", text: "Hello world" }], {
    input_tokens: 10,
    cache_read_input_tokens: 90,
    cache_creation_input_tokens: 5,
    output_tokens: 7,
  });
  result({ result: "Hello world" });
  busy = false;
}

let pendingTurn = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  record({ stdin: frame });
  if (frame.type === "control_request") {
    const subtype = frame.request?.subtype;
    if (subtype === "initialize") {
      send({
        type: "control_response",
        response: { subtype: "success", request_id: frame.request_id, response: { commands: [], models: [] } },
      });
    } else if (subtype === "interrupt") {
      interrupted = true;
      send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: {} } });
      if (busy && wakeInterrupt) wakeInterrupt();
    } else {
      send({
        type: "control_response",
        response: { subtype: "error", request_id: frame.request_id, error: `unknown ${subtype}` },
      });
    }
    return;
  }
  if (frame.type === "control_response") {
    const resolve = awaitingControl.get(frame.response?.request_id);
    awaitingControl.delete(frame.response?.request_id);
    resolve?.(frame.response?.subtype === "success" ? frame.response.response : undefined);
    return;
  }
  if (frame.type === "user") {
    const content = frame.message?.content ?? [];
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    pendingTurn = pendingTurn.then(() => runTurn(text));
  }
});
lines.on("close", () => {
  void pendingTurn.then(() => process.exit(0));
});
