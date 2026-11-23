#!/usr/bin/env node
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.env.CODEX_MOCK_SCENARIO ?? "turn";
if (process.argv.includes("--version")) {
  if (scenario === "hanging-version") await delay(60_000);
  console.log("codex-cli 0.171.0-alpha.1");
  process.exit(0);
}

assert.equal(process.argv.at(-1), "app-server");
// The HarnessDriver contract kit counts and kills live harness processes through this directory.
if (process.env.HARNESS_CONTRACT_DIR)
  writeFileSync(join(process.env.HARNESS_CONTRACT_DIR, `${process.pid}.pid`), "");
const threadId = "codex-thread";
const replies = new Map();
let handshake = "new";
let turnNumber = 0;
let turnId;
let completeAnswers = false;

function send(message) {
  return process.stdout.write(`${JSON.stringify(message)}\n`);
}
function reply(id, result) {
  send({ id, result });
}
function notify(method, params) {
  send({ method, params: { threadId, ...params } });
}
function request(id, method, params, expectedResponse) {
  assert(!replies.has(id));
  replies.set(id, expectedResponse);
  send({ id, method, params: { threadId, turnId, ...params } });
}
function turnEvent(method, params = {}) {
  notify(method, { turnId, ...params });
}
function complete(status) {
  notify("turn/completed", { turn: { id: turnId, status } });
  turnId = undefined;
}
function question(id) {
  request(
    id,
    "item/tool/requestUserInput",
    {
      itemId: "input-item",
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Which color?",
          options: [{ label: "Blue" }, { label: "Red" }],
        },
        { id: "note", header: "Note", question: "What note?", options: null },
      ],
    },
    { answers: { color: { answers: ["Blue"] }, note: { answers: ["Keep going"] } } },
  );
}

async function streamTurn() {
  turnEvent("item/agentMessage/delta", { threadId: "some-other-thread", delta: "ignore this" });
  turnEvent("item/reasoning/summaryTextDelta", { delta: "Checking " });
  turnEvent("item/reasoning/textDelta", { delta: "the details" });
  const line = Buffer.from(
    JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, delta: "Hello 🐈" },
    }) + "\r\n",
  );
  const split = line.indexOf(Buffer.from("🐈")) + 2;
  process.stdout.write(line.subarray(0, split));
  await delay(20);
  process.stdout.write(line.subarray(split));

  for (const [started, completed] of [
    [
      { type: "commandExecution", id: "cmd", command: "echo hello" },
      {
        aggregatedOutput: "hello\n",
        exitCode: 0,
        status: "completed",
      },
    ],
    [
      { type: "fileChange", id: "file", changes: [{ path: "src/a.ts", diff: "+hi" }] },
      {
        status: "failed",
      },
    ],
    [
      { type: "mcpToolCall", id: "mcp", server: "local", tool: "lookup", arguments: { value: 10 } },
      {
        result: { content: [{ type: "text", text: "found" }] },
        status: "completed",
      },
    ],
  ]) {
    turnEvent("item/started", { item: started });
    turnEvent("item/completed", { item: { ...started, ...completed } });
  }
  turnEvent("thread/tokenUsage/updated", {
    tokenUsage: {
      last: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      total: { inputTokens: 22, outputTokens: 14, totalTokens: 36 },
      modelContextWindow: 100_000,
    },
  });
  request(1, "item/commandExecution/requestApproval", { kind: "command" }, { decision: "accept" });
  request("file", "item/fileChange/requestApproval", {}, { decision: "accept" });
  const permissions = { network: { enabled: true } };
  request(3, "item/permissions/requestApproval", { permissions }, { permissions, scope: "turn" });
  request(
    "human",
    "item/commandExecution/requestApproval",
    { kind: "humanCommand" },
    { decision: "decline" },
  );
  request(
    "foreign",
    "item/fileChange/requestApproval",
    { threadId: "some-other-thread" },
    { decision: "decline" },
  );
  request("unknown", "unsupported/method", {}, -32601);
  request(
    "invalid-question",
    "item/tool/requestUserInput",
    { questions: [{ question: "Missing id" }] },
    -32602,
  );
}

// Contract scenario: the turn text names a HarnessScript from tests/helpers/harness-driver-contract.ts.
const contractAnswers = new Map();
function contractTurn(text) {
  const script = /^contract (text|tool|question|hang)$/.exec(text ?? "")?.[1];
  assert(script, `Unscripted contract turn ${JSON.stringify(text)}`);
  const reply = (prefix) => {
    turnEvent("item/agentMessage/delta", { delta: `${prefix}contract` });
    turnEvent("item/agentMessage/delta", { delta: " reply" });
    turnEvent("item/completed", {
      item: { type: "agentMessage", id: "reply", phase: "final_answer", text: `${prefix}contract reply` },
    });
    complete("completed");
  };
  if (script === "text") return reply("");
  if (script === "tool") {
    const item = { type: "mcpToolCall", id: "contract-call", tool: "contract_tool", arguments: {} };
    turnEvent("item/started", { item });
    turnEvent("item/completed", { item: { ...item, status: "completed", result: "done" } });
    return reply("");
  }
  if (script === "question") {
    const id = `contract-question-${turnNumber}`;
    contractAnswers.set(id, (result) => reply(`${result.answers["contract-choice"].answers[0]} `));
    send({
      id,
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId,
        itemId: "contract-input",
        questions: [
          {
            id: "contract-choice",
            question: "Proceed with the contract check?",
            options: [{ label: "yes" }, { label: "no" }],
          },
        ],
      },
    });
    return;
  }
  turnEvent("item/agentMessage/delta", { delta: "working" });
}

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  if (!message.method && contractAnswers.has(message.id)) {
    const answered = contractAnswers.get(message.id);
    contractAnswers.delete(message.id);
    answered(message.result);
    continue;
  }
  if (!message.method) {
    assert(replies.has(message.id), `Unexpected client response ID ${message.id}`);
    const expected = replies.get(message.id);
    if (typeof expected === "number") assert.equal(message.error?.code, expected);
    else assert.deepEqual(message.result, expected);
    replies.delete(message.id);
    if (message.id === 42) completeAnswers = true;
    if (completeAnswers && !replies.size) {
      turnEvent("item/agentMessage/delta", { delta: "!" });
      turnEvent("item/completed", {
        item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "Hello 🐈!" },
      });
      complete("completed");
      completeAnswers = false;
    }
    continue;
  }
  const { id, method, params } = message;
  if (scenario === "transport") {
    assert.equal(message.jsonrpc, "2.0");
    switch (method) {
      case "later": {
        setTimeout(() => reply(id, "first request"), 70);
        break;
      }
      case "after-late":
        setTimeout(() => reply(id, "still alive"), 100);
        break;
      case "now":
        reply(id, params);
        break;
      case "ignore":
        break;
      case "rpc-error":
        send({ id, error: { code: -32001, message: "private prompt" } });
        break;
      case "bad-frame":
        process.stdout.write("invalid JSON with private prompt\n");
        break;
      default:
        assert.fail(`Unexpected transport request ${method}`);
    }
    continue;
  }
  if (method === "initialize") {
    assert.equal(handshake, "new");
    assert.equal(params.capabilities.experimentalApi, true);
    assert.equal(params.clientInfo.name, "wildbots");
    handshake = "initializing";
    reply(id, { userAgent: "codex/0.171.0", codexHome: "/mock" });
    continue;
  }
  if (method === "initialized") {
    assert.equal(handshake, "initializing");
    assert.equal(id, undefined);
    handshake = "ready";
    continue;
  }
  assert.equal(handshake, "ready");
  switch (method) {
    case "account/read":
      assert.deepEqual(params, { refreshToken: false });
      reply(id, {
        requiresOpenaiAuth: true,
        account: scenario === "signed-out" ? null : { type: "chatgpt" },
      });
      break;
    case "model/list":
      assert.equal(params.includeHidden, false);
      if (params.cursor === undefined) {
        reply(id, {
          data: [
            {
              id: "internal-sol",
              model: "gpt-6-sol",
              displayName: "GPT-6 Sol",
              supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
              defaultReasoningEffort: "low",
              serviceTiers: [{ id: "priority", name: "Fast", description: "Higher priority" }],
              defaultServiceTier: "priority",
            },
            { model: "hidden", hidden: true },
          ],
          nextCursor: "page-2",
        });
      } else {
        assert.equal(params.cursor, "page-2");
        reply(id, {
          data: [
            { id: "old-catalog-model", displayName: "Older model", additionalSpeedTiers: ["fast"] },
          ],
          nextCursor: scenario === "bad-cursor" ? "page-2" : null,
        });
      }
      break;
    case "thread/start":
    case "thread/resume": {
      assert.equal(params.cwd, process.cwd());
      if (scenario === "contract") {
        notify("thread/started", { thread: { id: threadId } });
        reply(id, { thread: { id: threadId } });
        break;
      }
      assert.equal(params.model, "gpt-6-sol");
      assert.equal(params.modelProvider, undefined);
      assert.equal(params.developerInstructions, "Follow instructions");
      assert.equal(process.env.CODEX_MOCK_SESSION_ENV, "session override");
      if (scenario === "turn") {
        assert.equal(params.sandbox, "danger-full-access");
        assert.equal(params.approvalPolicy, "never");
        assert.equal(params.serviceTier, "priority");
        assert.deepEqual(params.config, {
          model_reasoning_effort: "high",
          mcp_servers: {
            local: { command: "mcp-tool", args: ["--demo"], env: { NAME: "value" } },
            remote: {
              url: "https://example.invalid/mcp",
              http_headers: { Authorization: "example" },
            },
          },
        });
      } else {
        assert.equal(params.sandbox, "workspace-write");
        assert.equal(params.approvalPolicy, "on-request");
        assert.equal(params.serviceTier, "default");
      }
      if (method === "thread/resume") {
        assert.equal(params.threadId, threadId);
        assert.equal(params.excludeTurns, true);
      } else {
        assert.equal(params.threadId, undefined);
      }
      notify("thread/started", { thread: { id: threadId } });
      reply(id, { thread: { id: scenario === "wrong-resume" ? "different-thread" : threadId } });
      break;
    }
    case "turn/start":
      assert.equal(params.threadId, threadId);
      assert.equal(turnId, undefined);
      if (scenario === "contract") {
        turnId = `provider-turn-${++turnNumber}`;
        reply(id, { turn: { id: turnId, status: "inProgress" } });
        notify("turn/started", { turn: { id: turnId, status: "inProgress" } });
        contractTurn(params.input[0]?.text);
        break;
      }
      assert.equal(params.effort, "high");
      const clientId = params.clientUserMessageId;
      turnId = `provider-turn-${++turnNumber}`;
      if (scenario === "unconfirmed-start") {
        notify("turn/started", { turn: { id: turnId, status: "inProgress" } });
        break;
      }
      if (scenario === "unannounced-start") {
        reply(id, { turn: { id: turnId, status: "inProgress" } });
        break;
      }
      if (scenario === "turn") {
        assert.equal(clientId, "local-turn");
        assert.deepEqual(params.input, [
          {
            type: "text",
            text: 'Ask a question\nAttached file "notes.txt": "/safe/notes.txt"',
            text_elements: [],
          },
          { type: "localImage", path: "/safe/picture.png" },
        ]);
        notify("turn/started", { turn: { id: turnId, status: "inProgress" } });
        await streamTurn();
        reply(id, { turn: { id: turnId, status: "inProgress" } });
      } else {
        reply(id, { turn: { id: turnId, status: "inProgress" } });
        await delay(10);
        notify("turn/started", { turn: { id: turnId, status: "inProgress" } });
        if (scenario === "interrupt" && turnNumber === 1) {
          request(
            "restricted",
            "item/commandExecution/requestApproval",
            { kind: "command" },
            { decision: "decline" },
          );
          question("canceled-question");
        }
        if (scenario === "interrupt" && turnNumber === 2) {
          turnEvent("error", { willRetry: true, error: { message: "temporary" } });
          turnEvent("error", { willRetry: false, error: { message: "model failed" } });
          complete("failed");
        }
      }
      break;
    case "turn/steer":
      assert.equal(params.threadId, threadId);
      assert.equal(params.expectedTurnId, turnId);
      if (scenario === "crash") {
        process.stderr.write("private prompt ".repeat(1000));
        if (process.stderr.writableNeedDrain) await once(process.stderr, "drain");
        process.exit(1);
      }
      assert.equal(scenario, "turn");
      assert.equal(params.clientUserMessageId, "queued-message");
      assert.deepEqual(params.input, [{ type: "text", text: "Steer now", text_elements: [] }]);
      question(42);
      reply(id, { turnId });
      break;
    case "turn/interrupt":
      if (scenario === "contract") {
        assert.deepEqual(params, { threadId, turnId });
        complete("interrupted");
        reply(id, {});
        break;
      }
      assert.equal(scenario, "interrupt");
      assert.deepEqual(params, { threadId, turnId });
      assert(!replies.has("restricted"));
      assert(replies.delete("canceled-question"));
      notify("serverRequest/resolved", { requestId: "canceled-question" });
      complete("interrupted");
      reply(id, {});
      break;
    default:
      assert.fail(`Unexpected method ${method}`);
  }
}
assert.equal(replies.size, 0);
