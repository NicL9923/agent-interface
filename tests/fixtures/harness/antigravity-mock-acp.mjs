// Adapted from pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.

import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.env.AGY_FIXTURE_SCENARIO;
const log = (message) => {
  if (process.env.AGY_FIXTURE_LOG) {
    appendFileSync(process.env.AGY_FIXTURE_LOG, `${JSON.stringify(message)}\n`);
  }
};
const argv = process.argv.slice(2);
log({
  argv,
  pid: process.pid,
  cwd: process.cwd(),
  geminiHome: process.env.GEMINI_HOME,
  forceFileStorage: process.env.AGY_ACP_FORCE_FILE_STORAGE,
  updaterDisabled: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  hasDisplay: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
  hasApiKey: Boolean(process.env.GEMINI_API_KEY),
});

if (argv.includes("--version")) {
  if (scenario === "version-timeout") await delay(30_000);
  if (scenario === "version-error") {
    process.stderr.write("agy version unavailable\n");
    process.exitCode = 2;
  } else if (scenario === "version-old") {
    console.log("antigravity 1.4.2");
  } else {
    console.log("antigravity 1.5.16");
  }
} else {
  assert.equal(argv[0], "acp");
  assert.equal(argv[1], "--gemini-dir");
  assert.equal(argv[3], "--app-data-dir");
  assert.equal(argv[4], "antigravity-acp");
  await serve();
}

async function serve() {
  if (process.env.HARNESS_CONTRACT_DIR) {
    writeFileSync(join(process.env.HARNESS_CONTRACT_DIR, `${process.pid}.pid`), "");
  }
  const models = [
    { value: "gemini-4-neon", name: "Gemini 4 Neon" },
    { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ];
  const sessionId = "agy-mock-session";
  let initialized = false;
  let authenticated = false;
  let activeSession;
  let currentModelId = "gemini-3.8-flash";
  let currentThoughtLevel = "medium";
  let prompt;
  let pendingClientRequest;
  let contractAnswer;

  const configOptions = () => [
    {
      id: "model",
      type: "select",
      category: "model",
      currentValue: currentModelId,
      options: models,
    },
    {
      id: "thought_level",
      type: "select",
      category: "thought_level",
      currentValue: currentThoughtLevel,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];
  const frame = (message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
  const send = (message) => process.stdout.write(frame(message));
  const update = (sessionUpdate, fields = {}, targetSession = activeSession) => ({
    method: "session/update",
    params: { sessionId: targetSession, update: { sessionUpdate, ...fields } },
  });
  const text = (value) => ({ content: { type: "text", text: value } });
  const complete = (stopReason = "end_turn", usage) => {
    assert.ok(prompt);
    send({ id: prompt.id, result: { stopReason, ...(usage ? { usage } : {}) } });
    prompt = undefined;
  };

  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, "2.0");
    log(message);
    const { id, method, params } = message;
    if (method === undefined && contractAnswer) {
      assert.equal(id, pendingClientRequest);
      pendingClientRequest = undefined;
      const answered = contractAnswer;
      contractAnswer = undefined;
      answered(message.result);
      continue;
    }
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
        initialized = true;
        result = {
          protocolVersion: 1,
          agentInfo: { name: "Antigravity ACP Server", version: "1.5.16" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            _meta:
              scenario === "no-system-prompt-append"
                ? {}
                : { antigravity: { tier: true, systemPrompt: { append: true } } },
          },
          authMethods: [
            { id: "oauth-personal", name: "Log in with Google" },
            { id: "gemini-api-key", name: "Gemini API key" },
          ],
        };
        break;
      case "authenticate":
        if (scenario === "auth-required") {
          send({ id, error: { code: -32000, message: "Sign in required" } });
          continue;
        }
        assert.equal(params.methodId, process.env.GEMINI_API_KEY ? "gemini-api-key" : "oauth-personal");
        authenticated = true;
        result = {};
        break;
      case "session/new":
      case "session/load":
        assert.ok(authenticated);
        assert.equal(params.cwd, process.cwd());
        assert.ok(Array.isArray(params.mcpServers));
        activeSession = method === "session/load" ? params.sessionId : sessionId;
        result = {
          sessionId: activeSession,
          configOptions: configOptions(),
          models: {
            currentModelId,
            availableModels: models.map(({ value, name }) => ({ modelId: value, name })),
          },
        };
        break;
      case "session/set_model":
        currentModelId = params.modelId;
        result = {};
        break;
      case "session/set_config_option":
        if (params.configId === "model") currentModelId = params.value;
        if (params.configId === "thought_level") currentThoughtLevel = params.value;
        result = { configOptions: configOptions() };
        break;
      case "session/cancel":
        if (prompt) complete("cancelled");
        continue;
      case "session/prompt": {
        assert.equal(prompt, undefined);
        prompt = { id };
        const input = params.prompt.filter((block) => block.type === "text").at(-1).text;
        const contract = process.env.HARNESS_CONTRACT_DIR
          ? /^contract (text|tool|question|hang)$/.exec(input)?.[1]
          : undefined;
        const reply = (prefix) => {
          send(update("agent_message_chunk", text(`${prefix}contract`)));
          send(update("agent_message_chunk", text(" reply")));
          complete("end_turn");
        };
        if (contract === "text") {
          reply("");
        } else if (contract === "tool") {
          send(update("tool_call", { toolCallId: "contract-call", title: "contract_tool", status: "pending" }));
          send(update("tool_call_update", { toolCallId: "contract-call", status: "completed", rawOutput: "done" }));
          reply("");
        } else if (contract === "question") {
          pendingClientRequest = "contract-question";
          contractAnswer = (answerResult) => {
            const optionId = answerResult?.outcome?.optionId;
            const chosen = optionId === "opt-yes" ? "yes" : "no";
            reply(`${chosen} `);
          };
          send({
            id: pendingClientRequest,
            method: "session/request_permission",
            params: {
              sessionId: activeSession,
              toolCall: { toolCallId: "interaction_contract_1", title: "Proceed with the contract check?" },
              options: [
                { optionId: "opt-yes", name: "yes", kind: "allow_once" },
                { optionId: "opt-no", name: "no", kind: "reject_once" },
              ],
            },
          });
        } else if (contract === "hang") {
          send(update("agent_message_chunk", text("working")));
        } else if (input === "Fail") {
          send({ id, error: { code: -32603, message: "Antigravity quota exceeded" } });
          prompt = undefined;
        } else {
          send(update("agent_thought_chunk", text("Neon reasoning")));
          send(update("agent_message_chunk", text(`Model=${currentModelId}`)));
          send(update("agent_message_chunk", text(` Effort=${currentThoughtLevel}`)));
          send(update("usage_update", { used: 1200, size: 1_000_000 }));
          complete("end_turn");
        }
        continue;
      }
      default:
        send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
        continue;
    }
    send({ id, result });
  }
}
