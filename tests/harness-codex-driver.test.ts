// @vitest-environment node
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexDriver } from "../src/server/harness/codex-driver.js";
import type {
  HarnessDriver,
  HarnessEvent,
  HarnessSession,
  HarnessSessionSpec,
} from "../src/server/harness/driver.js";
import { openJsonRpcStdio } from "../src/server/harness/json-rpc-stdio.js";

const fixture = fileURLToPath(new URL("./fixtures/harness/codex-mock-server.mjs", import.meta.url));
const cwd = resolve(fileURLToPath(new URL("..", import.meta.url)));
const launches = {
  command: process.execPath,
  args: [fixture, "app-server"],
  versionArgs: [fixture, "--version"],
  requestTimeoutMs: 2_000,
};

const spec: HarnessSessionSpec = {
  botId: "mock-bot",
  sessionKey: "logical-session",
  cwd,
  osUser: userInfo().username,
  model: "gpt-6-sol",
  provider: "codex",
  reasoning: "high",
  speed: "normal",
  systemPrompt: "Follow instructions",
  env: { CODEX_MOCK_SESSION_ENV: "session override" },
  fullPermissions: false,
};

function driver(scenario: string) {
  return createCodexDriver({
    ...launches,
    env: { CODEX_MOCK_SCENARIO: scenario, CODEX_MOCK_SESSION_ENV: "driver setting" },
  });
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function open(harness: HarnessDriver, overrides: Partial<HarnessSessionSpec> = {}) {
  const session = await harness.openSession({ ...spec, ...overrides });
  cleanup.push(() => session.close());
  return session;
}

function observe(session: HarnessSession) {
  const events: HarnessEvent[] = [];
  session.events((event) => events.push(event));
  return {
    events,
    wait: async <T extends HarnessEvent["type"]>(type: T) => {
      const find = () =>
        events.find((event): event is Extract<HarnessEvent, { type: T }> => event.type === type);
      await expect.poll(find).toBeDefined();
      return find()!;
    },
  };
}

describe("Codex app-server HarnessDriver", () => {
  it("probes the executable and bounds a hung version check", async () => {
    await expect(driver("turn").probe()).resolves.toEqual({
      available: true,
      version: "0.171.0-alpha.1",
    });
    await expect(createCodexDriver({ command: "/nonexistent/codex-cli" }).probe()).resolves.toEqual(
      {
        available: false,
        reason: "Codex executable was not found",
      },
    );
    const hung = createCodexDriver({
      ...launches,
      probeTimeoutMs: 100,
      env: { CODEX_MOCK_SCENARIO: "hanging-version" },
    });
    await expect(hung.probe()).resolves.toEqual({
      available: false,
      reason: "Codex version probe did not finish",
    });
  });

  it("lists visible models across pages with reasoning, speed and login metadata", async () => {
    const [catalog] = await driver("catalog").listModels();
    expect(catalog).toMatchObject({
      id: "codex",
      name: "Codex",
      authenticated: true,
      models: [
        {
          id: "gpt-6-sol",
          name: "GPT-6 Sol",
          available: true,
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
          defaultServiceTier: "priority",
          serviceTiers: [
            { id: "default", name: "Standard" },
            { id: "priority", name: "Fast", description: "Higher priority" },
          ],
        },
        {
          id: "old-catalog-model",
          defaultServiceTier: "default",
          serviceTiers: [{ id: "default" }, { id: "fast" }],
        },
      ],
    });
    const [signedOut] = await driver("signed-out").listModels();
    expect(signedOut.authenticated).toBe(false);
    expect(signedOut.models.every((model) => !model.available)).toBe(true);
    await expect(driver("bad-cursor").listModels()).rejects.toThrow("repeated a model list cursor");
  });

  it("caches authenticated model lists for modelCacheTtlMs and dedupes concurrent calls", async () => {
    let clock = 1_000;
    const cached = createCodexDriver({
      ...launches,
      env: { CODEX_MOCK_SCENARIO: "catalog", CODEX_MOCK_SESSION_ENV: "driver setting" },
      modelCacheTtlMs: 300_000,
      now: () => clock,
    });
    const [first, concurrent] = await Promise.all([cached.listModels(), cached.listModels()]);
    expect(concurrent).toBe(first);
    clock += 299_999;
    expect(await cached.listModels()).toBe(first);
    clock += 1;
    const refreshed = await cached.listModels();
    expect(refreshed).not.toBe(first);
    expect(refreshed).toEqual(first);

    // Unauthenticated catalogs are not cached.
    const signedOut = createCodexDriver({
      ...launches,
      env: { CODEX_MOCK_SCENARIO: "signed-out" },
      modelCacheTtlMs: 300_000,
      now: () => clock,
    });
    const firstSignedOut = await signedOut.listModels();
    const secondSignedOut = await signedOut.listModels();
    expect(secondSignedOut).not.toBe(firstSignedOut);
  });

  it("resumes the specified thread and closes once on explicit teardown", async () => {
    const session = await open(driver("resume"), { resumeSessionId: "codex-thread" });
    const { events } = observe(session);
    expect(session.id).toBe("logical-session");
    expect(session.providerSessionId).toBe("codex-thread");
    expect(events).toEqual([{ type: "session.ready", providerSessionId: "codex-thread" }]);
    await Promise.all([session.close(), session.close()]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "session.closed", unexpected: false });
    await expect(open(driver("wrong-resume"), { resumeSessionId: "codex-thread" })).rejects.toThrow(
      "did not return the requested thread",
    );
  });

  it("rejects a mismatched Unix owner and invalid MCP config", async () => {
    await expect(open(driver("turn"), { osUser: "another-user" })).rejects.toThrow(
      "session's Unix account",
    );
    await expect(
      open(driver("turn"), { mcpServers: [{ name: "missing-command", transport: "stdio" }] }),
    ).rejects.toThrow("requires a name and a command or URL");
  });

  it("streams a turn, accepts scoped approvals, steers and answers the provider's question", async () => {
    const session = await open(driver("turn"), {
      fullPermissions: true,
      speed: "priority",
      mcpServers: [
        {
          name: "local",
          transport: "stdio",
          command: "mcp-tool",
          args: ["--demo"],
          env: { NAME: "value" },
        },
        {
          name: "remote",
          transport: "http",
          url: "https://example.invalid/mcp",
          headers: { Authorization: "example" },
        },
      ],
    });
    const { events, wait } = observe(session);
    await session.startTurn({
      turnId: "local-turn",
      text: "Ask a question",
      attachments: [
        { id: "image", name: "picture.png", mime: "image/png", path: "/safe/picture.png" },
        { id: "file", name: "notes.txt", mime: "text/plain", path: "/safe/notes.txt" },
      ],
    });
    expect(events.slice(0, 5)).toEqual([
      { type: "session.ready", providerSessionId: "codex-thread" },
      { type: "turn.started", turnId: "local-turn" },
      { type: "reasoning.delta", turnId: "local-turn", delta: "Checking " },
      { type: "reasoning.delta", turnId: "local-turn", delta: "the details" },
      { type: "text.delta", turnId: "local-turn", delta: "Hello 🐈" },
    ]);
    expect(events.filter((event) => event.type.startsWith("tool."))).toMatchObject([
      { type: "tool.started", callId: "cmd", name: "commandExecution", arguments: "echo hello" },
      { type: "tool.completed", callId: "cmd", output: "hello\n" },
      { type: "tool.started", callId: "file", name: "fileChange" },
      { type: "tool.completed", callId: "file", error: "Codex tool failed" },
      { type: "tool.started", callId: "mcp", name: "local/lookup", arguments: '{"value":10}' },
      {
        type: "tool.completed",
        callId: "mcp",
        output: '{"content":[{"type":"text","text":"found"}]}',
      },
    ]);
    expect(await wait("usage.reported")).toEqual({
      type: "usage.reported",
      turnId: "local-turn",
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 18,
      contextWindow: 100_000,
    });
    await expect(session.startTurn({ turnId: "other", text: "Too soon" })).rejects.toThrow(
      "already active",
    );
    await session.steer?.({ turnId: "queued-message", text: "Steer now" });
    const question = await wait("question.asked");
    expect(question).toMatchObject({
      turnId: "local-turn",
      title: "Color",
      prompt: "Which color?\nWhat note?",
      questions: [
        { id: "color", header: "Color", question: "Which color?", options: ["Blue", "Red"] },
        { id: "note", header: "Note", question: "What note?" },
      ],
    });
    await session.answerQuestion(question.requestId, { color: "Blue", note: "Keep going" });
    await expect(session.answerQuestion(question.requestId, {})).rejects.toThrow(
      "No pending Codex question",
    );
    expect(await wait("turn.completed")).toEqual({
      type: "turn.completed",
      turnId: "local-turn",
      text: "Hello 🐈!",
      stopReason: "end_turn",
    });
  });

  it("interrupts only the active turn, cancels its question and reports a later failure once", async () => {
    const session = await open(driver("interrupt"));
    const { events, wait } = observe(session);
    await session.startTurn({ turnId: "first", text: "Run" });
    const question = await wait("question.asked");
    await session.interrupt("stale-turn");
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    await session.interrupt();
    expect(await wait("turn.completed")).toMatchObject({
      turnId: "first",
      stopReason: "interrupted",
    });
    await expect(session.answerQuestion(question.requestId, { color: "Blue" })).rejects.toThrow(
      "No pending Codex question",
    );
    await expect(session.steer?.({ turnId: "queued-message", text: "Too late" })).rejects.toThrow(
      "No active Codex turn",
    );
    await session.startTurn({ turnId: "second", text: "Fail" });
    expect(await wait("turn.failed")).toEqual({
      type: "turn.failed",
      turnId: "second",
      message: "model failed",
    });
    expect(
      events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
    ).toEqual(["first", "second"]);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
  });

  it("rejects an in-flight RPC on process exit and reports a sanitized unexpected close", async () => {
    const session = await open(driver("crash"));
    const { events, wait } = observe(session);
    await session.startTurn({ turnId: "first", text: "Run" });
    await expect(session.steer?.({ turnId: "queued-message", text: "Crash" })).rejects.toThrow(
      "exited with code 1 (captured 8192 stderr bytes)",
    );
    const closed = await wait("session.closed");
    expect(closed).toMatchObject({ unexpected: true });
    expect(closed.reason).not.toContain("private prompt");
    await session.close();
    expect(events.filter((event) => event.type === "session.closed")).toEqual([closed]);
  });

  it.each([
    ["unconfirmed-start", "turn/start timed out"],
    ["unannounced-start", "did not report that the turn started"],
  ])("closes a session with an incomplete turn start (%s)", async (scenario, error) => {
    const session = await open(
      createCodexDriver({
        ...launches,
        requestTimeoutMs: 500,
        env: { CODEX_MOCK_SCENARIO: scenario },
      }),
    );
    const { wait } = observe(session);
    await expect(session.startTurn({ turnId: "unconfirmed", text: "Run" })).rejects.toThrow(error);
    expect(await wait("session.closed")).toEqual({
      type: "session.closed",
      unexpected: true,
      reason: "Could not confirm Codex turn start",
    });
  });
});

describe("JSON-RPC stdio transport", () => {
  function connect() {
    const rpc = openJsonRpcStdio({
      ...launches,
      env: { ...process.env, CODEX_MOCK_SCENARIO: "transport" },
    });
    cleanup.push(() => rpc.close());
    return rpc;
  }

  it("correlates out-of-order replies and supports timed out and canceled requests", async () => {
    const rpc = connect();
    const later = rpc.request("later");
    await expect(rpc.request("now", { value: "second request" })).resolves.toEqual({
      value: "second request",
    });
    await expect(later).resolves.toBe("first request");

    const abort = new AbortController();
    const canceled = rpc.request("must-not-send", undefined, { signal: abort.signal });
    abort.abort();
    await expect(canceled).rejects.toThrow("must-not-send canceled");
    await expect(rpc.request("later", undefined, { timeoutMs: 10 })).rejects.toThrow(
      "later timed out",
    );
    await expect(rpc.request("after-late")).resolves.toBe("still alive");
    await expect(rpc.request("rpc-error")).rejects.toMatchObject({
      code: -32001,
      message: expect.not.stringContaining("private prompt"),
    });
  });

  it("closes a corrupt stream and rejects concurrent requests without exposing the frame", async () => {
    const rpc = connect();
    const pending = Promise.allSettled([rpc.request("ignore"), rpc.request("bad-frame")]);
    expect(await pending).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "Invalid JSON-RPC message from process" }),
      },
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "Invalid JSON-RPC message from process" }),
      },
    ]);
  });
});
