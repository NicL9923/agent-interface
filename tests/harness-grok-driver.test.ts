import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type {
  HarnessEvent,
  HarnessSession,
  HarnessSessionSpec,
} from "../src/server/harness/driver.js";
import { createGrokDriver, type GrokDriverOptions } from "../src/server/harness/grok-driver.js";

const executable = fileURLToPath(new URL("./fixtures/harness/grok-mock-acp.mjs", import.meta.url));
const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function fixture(scenario?: string, options: GrokDriverOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "wildbots-grok-test-"));
  disposers.push(() => rm(cwd, { recursive: true, force: true }));
  const log = join(cwd, "wire.ndjson");
  const driver = createGrokDriver({
    command: process.execPath,
    args: [executable],
    env: { GROK_FIXTURE_LOG: log, GROK_FIXTURE_SCENARIO: scenario, GROK_DISABLE_AUTOUPDATER: "0" },
    ...options,
  });
  const messages = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return {
    cwd,
    driver,
    messages,
    open: async (input: Partial<HarnessSessionSpec> = {}) => {
      const session = await driver.openSession({
        botId: "bot",
        sessionKey: "logical",
        cwd,
        model: "grok-build",
        fullPermissions: true,
        ...input,
      });
      disposers.push(() => session.close());
      return session;
    },
  };
}

function watch(session: HarnessSession) {
  const events: HarnessEvent[] = [];
  session.events((event) => events.push(event));
  const wait = <T extends HarnessEvent["type"]>(type: T, turnId?: string) =>
    vi.waitFor(() => {
      const event = events.find(
        (item) =>
          item.type === type &&
          (turnId === undefined || ("turnId" in item && item.turnId === turnId)),
      );
      expect(event).toBeDefined();
      return event as Extract<HarnessEvent, { type: T }>;
    });
  return { events, wait };
}

it("probes the version without allowing auto-updates and reports clean failures", async () => {
  const { driver, messages } = await fixture();
  await expect(driver.probe()).resolves.toEqual({ available: true, version: "1.0.92" });
  expect(await messages()).toEqual([
    expect.objectContaining({ argv: ["--no-auto-update", "--version"], updaterDisabled: "1" }),
  ]);

  const missing = createGrokDriver({ command: join(tmpdir(), "wildbots-missing-grok-fixture") });
  await expect(missing.probe()).resolves.toMatchObject({
    available: false,
    reason: expect.stringContaining("PATH"),
  });
  const failed = await fixture("version-error");
  await expect(failed.driver.probe()).resolves.toMatchObject({
    available: false,
    reason: expect.stringContaining("Grok version unavailable"),
  });
  const timedOut = await fixture("version-timeout", { probeTimeoutMs: 500 });
  await expect(timedOut.driver.probe()).resolves.toEqual({
    available: false,
    reason: "Grok version probe timed out",
  });
});

it("discovers models without creating or authenticating a session and falls back to Grok Build", async () => {
  const { driver, messages } = await fixture();
  await expect(driver.listModels()).resolves.toEqual([
    {
      id: "grok",
      name: "Grok",
      authenticated: true,
      models: [
        { id: "grok-4.6", name: "Grok 4.6", available: true },
        { id: "grok-4.5", name: "Grok 4.5", available: true },
      ],
    },
  ]);
  expect((await messages()).slice(1).map(({ method }) => method)).toEqual(["initialize"]);
  const fallback = await fixture("catalog-fallback");
  await expect(fallback.driver.listModels()).resolves.toMatchObject([
    {
      id: "grok",
      authenticated: false,
      models: [{ id: "grok-build", available: true }],
    },
  ]);
});

it("starts and resumes sessions with scoped MCP servers and chooses the advertised model and effort", async () => {
  const { open, messages, cwd } = await fixture("config");
  const mcpServers: HarnessSessionSpec["mcpServers"] = [
    {
      name: "internal",
      transport: "stdio",
      command: "/fixture/server",
      args: ["--local"],
      env: { ROLE: "bot" },
    },
    {
      name: "remote",
      transport: "http",
      url: "https://mcp.example.test",
      headers: { "X-Test": "mock" },
    },
  ];
  const session = await open({
    model: "grok-4.5",
    reasoning: "low",
    mcpServers,
    osUser: userInfo().username,
    env: { GROK_DISABLE_AUTOUPDATER: "0" },
  });
  const fresh = watch(session);
  expect(session.id).toBe("logical");
  expect(fresh.events).toEqual([{ type: "session.ready", providerSessionId: "grok-mock-session" }]);
  await session.close();
  await expect(fresh.wait("session.closed")).resolves.toMatchObject({ unexpected: false });

  const resumed = await open({
    resumeSessionId: "previous-session",
    mcpServers,
    reasoning: "unavailable",
  });
  const reloaded = watch(resumed);
  expect(resumed.providerSessionId).toBe("previous-session");
  expect(reloaded.events).toEqual([
    { type: "session.ready", providerSessionId: "previous-session" },
  ]);
  const acpServers = [
    {
      name: "internal",
      command: "/fixture/server",
      args: ["--local"],
      env: [{ name: "ROLE", value: "bot" }],
    },
    {
      type: "http",
      name: "remote",
      url: "https://mcp.example.test",
      headers: [{ name: "X-Test", value: "mock" }],
    },
  ];
  expect(await messages()).toEqual([
    expect.objectContaining({
      argv: ["--no-auto-update", "agent", "stdio"],
      updaterDisabled: "1",
      cwd,
    }),
    expect.objectContaining({
      method: "initialize",
      params: expect.objectContaining({ protocolVersion: 1 }),
    }),
    expect.objectContaining({ method: "session/new", params: { cwd, mcpServers: acpServers } }),
    expect.objectContaining({
      method: "session/set_config_option",
      params: { sessionId: "grok-mock-session", configId: "model", value: "grok-4.5" },
    }),
    expect.objectContaining({
      method: "session/set_config_option",
      params: { sessionId: "grok-mock-session", configId: "effort", value: "low" },
    }),
    expect.objectContaining({ argv: ["--no-auto-update", "agent", "stdio"] }),
    expect.objectContaining({ method: "initialize" }),
    expect.objectContaining({
      method: "session/load",
      params: { sessionId: "previous-session", cwd, mcpServers: acpServers },
    }),
  ]);
});

it("uses v1 model metadata and retries only an advertised headless authentication flow", async () => {
  const { open, messages } = await fixture("headless-auth");
  await expect(
    open({ model: "grok-4.5", reasoning: "low", env: { XAI_API_KEY: "" } }),
  ).resolves.toMatchObject({
    providerSessionId: "grok-mock-session",
  });
  expect((await messages()).slice(1).map(({ method }) => method)).toEqual([
    "initialize",
    "session/new",
    "authenticate",
    "session/new",
    "session/set_model",
  ]);
  expect((await messages()).at(-1).params).toEqual({
    sessionId: "grok-mock-session",
    modelId: "grok-4.5",
    _meta: { reasoningEffort: "low" },
  });
});

it("streams split UTF-8 text, thought, tools and usage while sending system context only once", async () => {
  const { open, cwd, messages } = await fixture();
  const path = join(cwd, "picture.png");
  await writeFile(path, Buffer.from([137, 80, 78, 71]));
  const session = await open({ systemPrompt: "Use the bot's configured persona." });
  const { events, wait } = watch(session);

  await session.startTurn({
    turnId: "one",
    text: "Stream",
    attachments: [{ id: "picture", name: "picture.png", mime: "image/png", path }],
  });
  await wait("turn.completed", "one");
  expect(events.slice(1)).toEqual([
    { type: "turn.started", turnId: "one" },
    { type: "reasoning.delta", turnId: "one", delta: "Thinking" },
    { type: "text.delta", turnId: "one", delta: "Hello 🌵" },
    { type: "text.delta", turnId: "one", delta: " there" },
    {
      type: "tool.started",
      turnId: "one",
      callId: "lookup",
      name: "Lookup",
      arguments: '{"key":"color"}',
    },
    { type: "tool.completed", turnId: "one", callId: "lookup", name: "Lookup", output: "Done" },
    { type: "usage.reported", turnId: "one", contextTokens: 0, contextWindow: 500_000 },
    { type: "usage.reported", turnId: "one", inputTokens: 31, outputTokens: 8 },
    { type: "turn.completed", turnId: "one", text: "Hello 🌵 there", stopReason: "end_turn" },
  ]);
  await session.startTurn({ turnId: "two", text: "Extension" });
  await expect(wait("turn.completed", "two")).resolves.toMatchObject({
    text: "Extension response",
    stopReason: "end_turn",
  });
  const prompts = (await messages()).filter(({ method }) => method === "session/prompt");
  expect(prompts.map(({ params }) => params.prompt)).toEqual([
    [
      { type: "text", text: "Use the bot's configured persona." },
      { type: "text", text: "Stream" },
      { type: "image", mimeType: "image/png", data: "iVBORw==" },
    ],
    [{ type: "text", text: "Extension" }],
  ]);
});

it.each([
  { fullPermissions: true, optionId: "allow-once" },
  { fullPermissions: true, scenario: "permission-always", optionId: "allow-always" },
  { fullPermissions: false, optionId: "reject-once" },
])(
  "answers a permission request with $optionId",
  async ({ fullPermissions, scenario, optionId }) => {
    const { open, messages } = await fixture(scenario);
    const session = await open({ fullPermissions });
    const { wait } = watch(session);
    await session.startTurn({ turnId: "permission", text: "Permission" });
    await wait("turn.completed");
    const [launch, ...wire] = await messages();
    if (!fullPermissions) {
      expect(launch.argv).toEqual([
        "--no-auto-update",
        "--permission-mode",
        "default",
        "agent",
        "stdio",
      ]);
    }
    expect(wire.find(({ id }) => id === 901)).toEqual({
      jsonrpc: "2.0",
      id: 901,
      result: { outcome: { outcome: "selected", optionId } },
    });
  },
);

it("answers Grok questions using labels and free-form annotations, and cancels unanswered questions", async () => {
  const { open, messages } = await fixture();
  const session = await open();
  const { wait } = watch(session);
  await session.startTurn({ turnId: "ask", text: "Question" });
  const initial = await wait("question.asked", "ask");
  expect(initial.questions).toMatchObject([
    { id: "color", question: "Which color?", options: ["Blue", "Red"] },
    { id: "note", question: "Any notes?" },
  ]);
  await session.answerQuestion(initial.requestId, { color: "Blue", note: "Plain text response" });
  await wait("turn.completed", "ask");
  await expect(session.answerQuestion(initial.requestId, { color: "Red" })).rejects.toThrow(
    "Unknown Grok question",
  );

  await session.startTurn({ turnId: "cancel-ask", text: "Question" });
  const second = await wait("question.asked", "cancel-ask");
  await session.interrupt("cancel-ask");
  await expect(wait("turn.completed", "cancel-ask")).resolves.toMatchObject({
    stopReason: "interrupted",
  });
  await expect(session.answerQuestion(second.requestId, {})).rejects.toThrow(
    "Unknown Grok question",
  );
  await vi.waitFor(async () => {
    const replies = (await messages()).filter(({ id }) => id === "question-request");
    expect(replies.map(({ result }) => result)).toEqual([
      {
        outcome: "accepted",
        answers: { "Which color?": ["Blue"], "Any notes?": ["Other"] },
        annotations: { "Any notes?": { notes: "Plain text response" } },
      },
      { outcome: "cancelled" },
    ]);
  });
});

it("sends cancel only for the active turn and can start another after cancellation or an RPC error", async () => {
  const { open, messages } = await fixture();
  const session = await open();
  const { wait } = watch(session);
  await session.startTurn({ turnId: "held", text: "Hold" });
  await wait("text.delta", "held");
  await expect(session.startTurn({ turnId: "duplicate", text: "Hold" })).rejects.toThrow(
    "active turn",
  );
  await session.interrupt("stale");
  await session.interrupt("held");
  await expect(wait("turn.completed", "held")).resolves.toMatchObject({
    stopReason: "interrupted",
  });
  await session.startTurn({ turnId: "failed", text: "Fail" });
  await expect(wait("turn.failed", "failed")).resolves.toMatchObject({
    recoverable: true,
    message: "Grok prompt failed",
  });
  await session.startTurn({ turnId: "retry", text: "Stream" });
  await wait("turn.completed", "retry");
  expect((await messages()).filter(({ method }) => method === "session/cancel")).toEqual([
    {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "grok-mock-session", _meta: { cancelTrigger: "ctrl_c" } },
    },
  ]);
});

it("fails the active turn and reports a bounded diagnostic when the child dies unexpectedly", async () => {
  const { open } = await fixture();
  const session = await open();
  const { wait } = watch(session);
  await session.startTurn({ turnId: "crash", text: "Crash" });
  const closed = await wait("session.closed");
  expect(closed.unexpected).toBe(true);
  expect(closed.reason).toContain("SIGKILL");
  expect(closed.reason).toContain("Grok fixture crashed");
  expect(closed.reason?.length).toBeLessThan(4200);
  await expect(wait("turn.failed", "crash")).resolves.toMatchObject({ recoverable: false });
  await expect(session.startTurn({ turnId: "stale", text: "Hello" })).rejects.toThrow("closed");
});

it.each([
  { scenario: "malformed", reason: /malformed JSON/ },
  { scenario: "bad-version", reason: /unsupported ACP protocol version: 99/ },
  { scenario: "missing-session", reason: /did not return an ACP session ID/ },
  { scenario: "startup-timeout", reason: /timed out after 500 ms: initialize/ },
])("reaps the child on $scenario during startup", async ({ scenario, reason }) => {
  const { open, messages } = await fixture(scenario, { requestTimeoutMs: 500 });
  await expect(open()).rejects.toThrow(reason);
  const [{ pid }] = await messages();
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
});

it("rejects mismatched OS users and incomplete MCP settings before spawning", async () => {
  const { open, messages } = await fixture();
  await expect(open({ osUser: `${userInfo().username}-other` })).rejects.toThrow("OS user");
  await expect(open({ mcpServers: [{ name: "stdio", transport: "stdio" }] })).rejects.toThrow(
    "requires a command",
  );
  await expect(open({ mcpServers: [{ name: "http", transport: "http" }] })).rejects.toThrow(
    "requires a URL",
  );
  await expect(messages()).rejects.toMatchObject({ code: "ENOENT" });
});
