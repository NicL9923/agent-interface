// Adapted from pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.
// The upstream license notice is in src/server/harness/grok-driver.ts.

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.env.GROK_FIXTURE_SCENARIO;
const log = (message) =>
  appendFileSync(process.env.GROK_FIXTURE_LOG, `${JSON.stringify(message)}\n`);
const argv = process.argv.slice(2);
log({
  argv,
  pid: process.pid,
  cwd: process.cwd(),
  updaterDisabled: process.env.GROK_DISABLE_AUTOUPDATER,
});

if (argv.includes("--version")) {
  assert.deepEqual(argv, ["--no-auto-update", "--version"]);
  if (scenario === "version-timeout") await delay(30_000);
  if (scenario === "version-error") {
    process.stderr.write("Grok version unavailable\n");
    process.exitCode = 2;
  } else {
    console.log("grok 1.0.92 (abcdef) [stable]");
  }
} else {
  assert.deepEqual(
    argv,
    argv.includes("--permission-mode")
      ? ["--no-auto-update", "--permission-mode", "default", "agent", "stdio"]
      : ["--no-auto-update", "agent", "stdio"],
  );
  await serve();
}

async function serve() {
  const models = [
    { modelId: "grok-4.6", name: "Grok 4.6" },
    {
      modelId: "grok-4.5",
      name: "Grok 4.5",
      _meta: { reasoningEffort: "high", reasoningEfforts: [{ value: "low" }, { value: "high" }] },
    },
  ];
  const sessionId = "grok-mock-session";
  let initialized = false;
  let activeSession;
  let currentModelId = models[0].modelId;
  let prompt;
  let pendingClientRequest;
  let authenticated = scenario !== "headless-auth";
  const modelState = () => ({ currentModelId, availableModels: models });
  const modelConfig = () => ({
    id: "model",
    type: "select",
    category: "model",
    currentValue: currentModelId,
    options: models.map(({ modelId, name }) => ({ value: modelId, name })),
  });
  const effortConfig = () => ({
    id: "effort",
    type: "select",
    category: "thought_level",
    currentValue: "medium",
    options:
      currentModelId === "grok-4.5"
        ? [{ group: "Effort", options: [{ value: "low" }, { value: "high" }] }]
        : [{ value: "medium" }],
  });
  const frame = (message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
  const send = (message) => process.stdout.write(frame(message));
  const update = (sessionUpdate, fields = {}, sessionId = activeSession) => ({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate, ...fields } },
  });
  const text = (text) => ({ content: { type: "text", text } });
  const complete = (stopReason = "end_turn", usage) => {
    assert.ok(prompt);
    send({ id: prompt.id, result: { stopReason, usage } });
    prompt = undefined;
  };

  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, "2.0");
    log(message);
    const { id, method, params } = message;
    if (method === undefined) {
      assert.equal(id, pendingClientRequest);
      pendingClientRequest = undefined;
      if (prompt) complete();
      continue;
    }
    if (method !== "initialize") assert.ok(initialized);
    if (!["initialize", "authenticate", "session/new", "session/load"].includes(method)) {
      assert.equal(params.sessionId, activeSession);
    }
    let result;
    switch (method) {
      case "initialize":
        assert.equal(params.protocolVersion, 1);
        assert.deepEqual(params.clientCapabilities, {});
        if (scenario === "startup-timeout") continue;
        if (scenario === "malformed") {
          process.stdout.write("malformed frame\n");
          continue;
        }
        initialized = true;
        result = {
          protocolVersion: scenario === "bad-version" ? 99 : 1,
          agentInfo: { name: "grok", version: "1.0.92" },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          authMethods: scenario === "headless-auth" ? [{ id: "cached_token", type: "agent" }] : [],
          _meta:
            scenario === "catalog-fallback"
              ? {}
              : { modelState: modelState(), defaultAuthMethodId: "cached_token" },
        };
        break;
      case "authenticate":
        assert.equal(scenario, "headless-auth");
        assert.equal(params.methodId, "cached_token");
        authenticated = true;
        result = {};
        break;
      case "session/new":
      case "session/load":
        assert.equal(params.cwd, process.cwd());
        assert.ok(Array.isArray(params.mcpServers));
        if (!authenticated) {
          send({ id, error: { code: -32000, message: "Authentication required" } });
          continue;
        }
        activeSession = method === "session/load" ? params.sessionId : sessionId;
        if (method === "session/load") send(update("agent_message_chunk", text("Previous turn")));
        result = { models: modelState() };
        if (method === "session/new" && scenario !== "missing-session")
          result.sessionId = sessionId;
        if (scenario === "config") result.configOptions = [modelConfig(), effortConfig()];
        break;
      case "session/set_config_option":
        assert.equal(scenario, "config");
        if (params.configId === "model") {
          assert.ok(models.some((model) => model.modelId === params.value));
          currentModelId = params.value;
        } else {
          assert.equal(params.configId, "effort");
          assert.ok(effortConfig().options[0].options.some(({ value }) => params.value === value));
        }
        result = { configOptions: [modelConfig(), effortConfig()] };
        break;
      case "session/set_model":
        assert.notEqual(scenario, "config");
        assert.ok(models.some((model) => model.modelId === params.modelId));
        currentModelId = params.modelId;
        result = {};
        break;
      case "session/prompt": {
        assert.equal(prompt, undefined);
        prompt = { id, promptId: params._meta.promptId };
        const input = params.prompt.filter((block) => block.type === "text").at(-1).text;
        if (input === "Hold") {
          send(update("agent_message_chunk", text("Waiting")));
        } else if (input === "Crash") {
          process.stderr.write(`${"!".repeat(5000)}\nGrok fixture crashed\n`, () => {
            process.kill(process.pid, "SIGKILL");
          });
        } else if (input === "Fail") {
          send({ id, error: { code: -32603, message: "Grok prompt failed" } });
          prompt = undefined;
        } else if (input === "Extension") {
          send({
            method: "_x.ai/session_notification",
            params: {
              sessionId: activeSession,
              update: {
                sessionUpdate: "turn_completed",
                prompt_id: "task-completed-background",
                stop_reason: "error",
              },
            },
          });
          send(update("agent_message_chunk", text("Extension response")));
          send({
            method: "_x.ai/session/prompt_complete",
            params: { sessionId: activeSession, promptId: prompt.promptId, stopReason: "end_turn" },
          });
          prompt = undefined;
        } else if (input === "Permission") {
          pendingClientRequest = 901;
          const options = [
            { kind: "allow_always", optionId: "allow-always", name: "Always" },
            { kind: "reject_once", optionId: "reject-once", name: "Deny" },
          ];
          if (scenario !== "permission-always") {
            options.push({ kind: "allow_once", optionId: "allow-once", name: "Allow" });
          }
          send({
            id: pendingClientRequest,
            method: "session/request_permission",
            params: {
              sessionId: activeSession,
              toolCall: { toolCallId: "lookup", title: "Lookup" },
              options,
            },
          });
        } else if (input === "Question") {
          pendingClientRequest = "question-request";
          send({
            id: pendingClientRequest,
            method: "_x.ai/ask_user_question",
            params: {
              params: {
                sessionId: activeSession,
                toolCallId: "ask-1",
                questions: [
                  {
                    id: "color",
                    question: "Which color?",
                    options: [{ label: "Blue" }, { label: "Red" }],
                  },
                  { id: "note", question: "Any notes?", options: [] },
                ],
              },
            },
          });
        } else {
          const output = Buffer.from(
            [
              update("agent_thought_chunk", text("Thinking")),
              update("agent_message_chunk", text("Hello 🌵")),
              update("agent_message_chunk", text("Wrong session"), "some-other-session"),
              update("agent_message_chunk", text(" there")),
              update("tool_call", {
                toolCallId: "lookup",
                title: "Lookup",
                status: "pending",
                rawInput: { key: "color" },
              }),
              update("tool_call_update", { toolCallId: "lookup", status: "in_progress" }),
              update("tool_call_update", {
                toolCallId: "lookup",
                status: "completed",
                rawOutput: "Done",
              }),
              update("tool_call_update", { toolCallId: "lookup", status: "completed" }),
              update("usage_update", { used: 0, size: 500_000 }),
            ]
              .map(frame)
              .join(""),
          );
          const split = output.indexOf(Buffer.from("🌵")) + 2;
          process.stdout.write(output.subarray(0, split));
          await delay(15);
          process.stdout.write(output.subarray(split));
          complete("end_turn", { inputTokens: 31, outputTokens: 8 });
        }
        continue;
      }
      case "session/cancel":
        assert.equal(id, undefined);
        assert.equal(params._meta.cancelTrigger, "ctrl_c");
        complete("cancelled");
        continue;
      default:
        throw new Error(`Unexpected ACP method: ${method}`);
    }
    send({ id, result });
  }
}
