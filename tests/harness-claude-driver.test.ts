import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ClaudeDriverOptions,
  createClaudeDriver,
  createClaudeJsonlFramer,
} from "../src/server/harness/claude-driver.js";
import type {
  HarnessEvent,
  HarnessSession,
  HarnessSessionSpec,
} from "../src/server/harness/driver.js";

const MOCK = fileURLToPath(new URL("./fixtures/harness/claude-mock-cli.mjs", import.meta.url));

let dir: string;
let recordPath: string;
const open: HarnessSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-driver-test-"));
  recordPath = join(dir, "record.jsonl");
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.close()));
  rmSync(dir, { recursive: true, force: true });
});

function driver(env: Record<string, string> = {}, overrides: ClaudeDriverOptions = {}) {
  return createClaudeDriver({
    command: process.execPath,
    args: [MOCK],
    env: { CLAUDE_MOCK_RECORD: recordPath, ...env },
    closeGraceMs: 2_000,
    killGraceMs: 2_000,
    ...overrides,
  });
}

function spec(overrides: Partial<HarnessSessionSpec> = {}): HarnessSessionSpec {
  return {
    botId: "bot-1",
    sessionKey: "session-1",
    cwd: dir,
    model: "claude-sonnet-5-5",
    fullPermissions: false,
    ...overrides,
  };
}

interface Recorded {
  argv?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  mcpPath?: string;
  mcpConfig?: unknown;
  stdin?: Record<string, any>;
  authStatus?: boolean;
}

function records(): Recorded[] {
  if (!existsSync(recordPath)) return [];
  return readFileSync(recordPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded);
}

const launch = () => records().find((entry) => entry.argv)!;
const stdinFrames = () => records().flatMap((entry) => (entry.stdin ? [entry.stdin] : []));

async function start(options: Parameters<typeof driver>[0] = {}, overrides = {}) {
  const session = await driver(options).openSession(spec(overrides));
  open.push(session);
  const events: HarnessEvent[] = [];
  session.events((event) => events.push(event));
  return { session, events };
}

async function until<T extends HarnessEvent["type"]>(
  events: HarnessEvent[],
  type: T,
): Promise<Extract<HarnessEvent, { type: T }>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = events.find((event) => event.type === type);
    if (found) return found as Extract<HarnessEvent, { type: T }>;
    if (Date.now() > deadline) throw new Error(`No ${type} in ${JSON.stringify(events)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("probe", () => {
  it("reports the CLI version", async () => {
    await expect(driver().probe()).resolves.toEqual({ available: true, version: "2.1.330" });
  });

  it("reports a failing --version as unavailable with the exit code", async () => {
    const result = await driver({ CLAUDE_MOCK_VERSION_EXIT: "2" }).probe();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("exited with 2");
  });

  it("reports output without a version as unavailable", async () => {
    const result = await driver({ CLAUDE_MOCK_VERSION: "claude dev build" }).probe();
    expect(result).toEqual({ available: false, reason: expect.stringContaining("no version") });
  });

  it("reports a missing executable", async () => {
    const result = await createClaudeDriver({ command: join(dir, "no-claude") }).probe();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("was not found");
  });
});

describe("listModels", () => {
  it("lists the current catalog and marks models the CLI is too old for", async () => {
    const [provider] = await driver({ CLAUDE_MOCK_VERSION: "2.1.290" }).listModels();
    expect(provider?.authenticated).toBe(true);
    expect(provider?.models).toEqual([
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", available: true },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", available: true },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", available: false },
      { id: "claude-fable-5-2", name: "Claude Fable 5.2", available: false },
    ]);
    expect(provider?.warning).toContain("Claude Haiku 5.5, Claude Fable 5.2");
  });

  it("marks a signed-out CLI and honors a catalog override", async () => {
    const [provider] = await driver(
      { CLAUDE_MOCK_LOGGED_IN: "0" },
      { models: [{ id: "claude-custom", name: "Custom" }] },
    ).listModels();
    expect(provider?.authenticated).toBe(false);
    expect(provider?.warning).toContain("not signed in");
    expect(provider?.models).toEqual([{ id: "claude-custom", name: "Custom", available: true }]);
  });

  it("marks every model unavailable when the CLI is missing", async () => {
    const [provider] = await createClaudeDriver({ command: join(dir, "no-claude") }).listModels();
    expect(provider?.models.every((model) => !model.available)).toBe(true);
    expect(provider?.warning).toContain("was not found");
  });

  it("caches authenticated model lists for modelCacheTtlMs, dedupes concurrent calls, and skips caching signed-out checks", async () => {
    let clock = 10_000;
    const cached = driver({}, { modelCacheTtlMs: 300_000, now: () => clock });
    const [first, concurrent] = await Promise.all([cached.listModels(), cached.listModels()]);
    expect(concurrent).toEqual(first);
    expect(records().filter((entry) => entry.authStatus)).toHaveLength(1);

    clock += 299_999;
    await cached.listModels();
    expect(records().filter((entry) => entry.authStatus)).toHaveLength(1);

    clock += 1;
    await cached.listModels();
    expect(records().filter((entry) => entry.authStatus)).toHaveLength(2);

    const signedOut = driver(
      { CLAUDE_MOCK_LOGGED_IN: "0" },
      { modelCacheTtlMs: 300_000, now: () => clock },
    );
    await signedOut.listModels();
    await signedOut.listModels();
    expect(records().filter((entry) => entry.authStatus)).toHaveLength(4);
  });
});

describe("session launch", () => {
  it("launches stream-json with model, effort, prompt, speed and a fresh session id", async () => {
    const { session, events } = await start(
      { WILDBOTS_TEST_VAR: "driver" },
      {
        reasoning: "ultra",
        speed: "fast",
        systemPrompt: "You are Ranger.",
        env: { WILDBOTS_TEST_VAR: "spec" },
      },
    );
    const { argv, cwd, env } = launch();
    expect(argv).toEqual(
      expect.arrayContaining(["--print", "--verbose", "--include-partial-messages"]),
    );
    const flag = (name: string) => argv![argv!.indexOf(name) + 1];
    expect(flag("--input-format")).toBe("stream-json");
    expect(flag("--output-format")).toBe("stream-json");
    expect(flag("--permission-prompt-tool")).toBe("stdio");
    expect(flag("--model")).toBe("claude-sonnet-5-5");
    expect(flag("--effort")).toBe("max");
    expect(flag("--append-system-prompt")).toBe("You are Ranger.");
    expect(JSON.parse(flag("--settings"))).toEqual({ fastMode: true });
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("--permission-mode");
    expect(flag("--session-id")).toBe(session.providerSessionId);
    expect(cwd).toBe(dir);
    expect(env?.WILDBOTS_TEST_VAR).toBe("spec");
    expect(env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    expect(stdinFrames()[0]?.request).toEqual({ subtype: "initialize" });

    await session.startTurn({ turnId: "t1", text: "hi" });
    expect(await until(events, "session.ready")).toEqual({
      type: "session.ready",
      providerSessionId: session.providerSessionId,
    });
  });

  it("resumes a provider session instead of minting one", async () => {
    const resumeSessionId = "11111111-2222-4333-8444-555555555555";
    const { session, events } = await start({}, { resumeSessionId });
    const { argv } = launch();
    expect(argv![argv!.indexOf("--resume") + 1]).toBe(resumeSessionId);
    expect(argv).not.toContain("--session-id");
    expect(session.providerSessionId).toBe(resumeSessionId);
    await session.startTurn({ turnId: "t1", text: "hi" });
    await until(events, "turn.completed");
    expect(events.filter((event) => event.type === "session.ready")).toEqual([
      { type: "session.ready", providerSessionId: resumeSessionId },
    ]);
  });

  it("passes a long system prompt through a private file", async () => {
    const prompt = "x".repeat(70 * 1024);
    await start({}, { systemPrompt: prompt });
    const { argv } = launch();
    expect(argv).not.toContain("--append-system-prompt");
    const file = argv![argv!.indexOf("--append-system-prompt-file") + 1]!;
    expect(readFileSync(file, "utf8")).toBe(prompt);
  });

  it("fails to open when the CLI exits before the initialize handshake", async () => {
    const script = join(dir, "exit.mjs");
    writeFileSync(script, "console.error('bad flag'); process.exit(2);\n");
    const failing = createClaudeDriver({ command: process.execPath, args: [script] });
    await expect(failing.openSession(spec())).rejects.toThrow(/failed to start.*bad flag/);
  });

  it("fails to open when the executable is missing", async () => {
    const missing = createClaudeDriver({ command: join(dir, "no-claude") });
    await expect(missing.openSession(spec())).rejects.toThrow(/was not found/);
  });
});

describe("full permissions guard", () => {
  const asRoot = (options: ClaudeDriverOptions = {}) => driver({}, { getuid: () => 0, ...options });

  it("refuses bypassPermissions as root without an osUser", async () => {
    await expect(asRoot().openSession(spec({ fullPermissions: true }))).rejects.toThrow(
      /refuses full permissions.*root/,
    );
    expect(records()).toEqual([]);
  });

  it("refuses bypassPermissions when the osUser is root", async () => {
    await expect(
      asRoot().openSession(spec({ fullPermissions: true, osUser: "root" })),
    ).rejects.toThrow(/refuses full permissions/);
  });

  it("lets a root server hand full permissions to a non-root osUser", async () => {
    // The guard passes; the lookup of this made-up account is what stops the launch.
    await expect(
      asRoot().openSession(spec({ fullPermissions: true, osUser: "wildbots-no-such-user" })),
    ).rejects.toThrow(/Unknown osUser "wildbots-no-such-user"/);
  });

  it("allows root without full permissions", async () => {
    const session = await asRoot().openSession(spec());
    open.push(session);
    expect(launch().argv).not.toContain("bypassPermissions");
  });

  it("refuses to switch users when the server is not root", async () => {
    await expect(
      driver({}, { getuid: () => 1000 }).openSession(spec({ osUser: "someone-else" })),
    ).rejects.toThrow(/switching users needs the server to run as root/);
  });

  it("passes bypassPermissions with its acknowledgement flag for a non-root server", async () => {
    await start({}, { fullPermissions: true });
    const { argv } = launch();
    expect(argv![argv!.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(argv).toContain("--allow-dangerously-skip-permissions");
  });
});

describe("turns", () => {
  it("streams reasoning and text, then reports usage and the final text", async () => {
    const { session, events } = await start();
    await session.startTurn({ turnId: "t1", text: "hello", senderName: "Nic" });
    await until(events, "turn.completed");
    const user = stdinFrames().find((frame) => frame.type === "user");
    expect(user?.message.content).toEqual([{ type: "text", text: "Nic: hello" }]);
    expect(events.filter((event) => event.type !== "session.ready")).toEqual([
      { type: "turn.started", turnId: "t1" },
      { type: "reasoning.delta", turnId: "t1", delta: "Let me think." },
      { type: "text.delta", turnId: "t1", delta: "Hello" },
      { type: "text.delta", turnId: "t1", delta: " world" },
      {
        type: "usage.reported",
        turnId: "t1",
        inputTokens: 105,
        outputTokens: 7,
        contextTokens: 112,
        contextWindow: 1_000_000,
      },
      { type: "turn.completed", turnId: "t1", text: "Hello world", stopReason: "end_turn" },
    ]);
  });

  it("sends images as base64 blocks and other files as path references", async () => {
    const image = join(dir, "pic.png");
    writeFileSync(image, Buffer.from([1, 2, 3]));
    const { session, events } = await start();
    await session.startTurn({
      turnId: "t1",
      text: "look",
      attachments: [
        { id: "a1", name: "pic.png", mime: "image/PNG", path: image },
        { id: "a2", name: "notes.pdf", mime: "application/pdf", path: "/data/notes.pdf" },
      ],
    });
    await until(events, "turn.completed");
    const content = stdinFrames().find((frame) => frame.type === "user")?.message.content;
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
    });
    expect(content[1].text).toContain("notes.pdf (application/pdf): /data/notes.pdf");
    expect(content).toHaveLength(2);
  });

  it("rejects a second turn while one is running", async () => {
    const { session, events } = await start();
    await session.startTurn({ turnId: "t1", text: "wait" });
    await expect(session.startTurn({ turnId: "t2", text: "hi" })).rejects.toThrow(
      /t1 is still running/,
    );
    await session.interrupt();
    await until(events, "turn.completed");
  });

  it("reports a failed result with the CLI's errors", async () => {
    const { session, events } = await start();
    await session.startTurn({ turnId: "t1", text: "fail" });
    expect(await until(events, "turn.failed")).toEqual({
      type: "turn.failed",
      turnId: "t1",
      message: "mock failure",
      recoverable: true,
    });
  });

  it("auto-approves a tool permission request with full permissions", async () => {
    const { session, events } = await start({}, { fullPermissions: true });
    await session.startTurn({ turnId: "t1", text: "tool" });
    await until(events, "turn.completed");
    expect(events.find((event) => event.type === "tool.started")).toEqual({
      type: "tool.started",
      turnId: "t1",
      callId: "toolu_bash",
      name: "Bash",
      arguments: '{"command":"ls"}',
    });
    expect(events.find((event) => event.type === "tool.completed")).toEqual({
      type: "tool.completed",
      turnId: "t1",
      callId: "toolu_bash",
      name: "Bash",
      output: "file.txt",
    });
    const answer = stdinFrames().find((frame) => frame.type === "control_response");
    expect(answer?.response).toEqual({
      subtype: "success",
      request_id: "cli-1",
      response: { behavior: "allow", updatedInput: { command: "ls" } },
    });
  });

  it("denies a tool permission request without full permissions", async () => {
    const { session, events } = await start();
    await session.startTurn({ turnId: "t1", text: "tool" });
    await until(events, "turn.completed");
    const completed = events.find((event) => event.type === "tool.completed");
    expect(completed).toMatchObject({
      callId: "toolu_bash",
      error: expect.stringContaining("Bash needs approval"),
    });
    const answer = stdinFrames().find((frame) => frame.type === "control_response");
    expect(answer?.response.response.behavior).toBe("deny");
  });

  it("asks AskUserQuestion questions and returns the answers keyed by question text", async () => {
    const { session, events } = await start({}, { fullPermissions: true });
    await session.startTurn({ turnId: "t1", text: "ask" });
    const asked = await until(events, "question.asked");
    expect(asked).toEqual({
      type: "question.asked",
      turnId: "t1",
      requestId: "cli-1",
      title: "Color",
      prompt: "Which color?",
      questions: [
        { id: "q1", header: "Color", question: "Which color?", options: ["Red", "Blue"] },
      ],
    });
    await expect(session.answerQuestion("nope", { q1: "Red" })).rejects.toThrow(/No pending/);
    await session.answerQuestion(asked.requestId, { q1: "Blue" });
    expect(await until(events, "turn.completed")).toMatchObject({ text: "You chose Blue" });
    const answer = stdinFrames().find((frame) => frame.type === "control_response");
    expect(answer?.response.response.updatedInput.answers).toEqual({ "Which color?": "Blue" });
    expect(answer?.response.response.updatedInput.questions[0].question).toBe("Which color?");
    await expect(session.answerQuestion(asked.requestId, { q1: "Red" })).rejects.toThrow(
      /No pending/,
    );
  });

  it("preserves U+2028 and U+2029 inside streamed JSONL text_delta frames", async () => {
    const { session, events } = await start();
    await session.startTurn({ turnId: "t-unicode", text: "unicode-sep" });
    const completed = await until(events, "turn.completed");
    expect(completed).toEqual({
      type: "turn.completed",
      turnId: "t-unicode",
      text: "before\u2028middle\u2029after",
      stopReason: "end_turn",
    });
    expect(
      events
        .filter(
          (event): event is Extract<HarnessEvent, { type: "text.delta" }> =>
            event.type === "text.delta",
        )
        .map((event) => event.delta)
        .join(""),
    ).toBe("before\u2028middle\u2029after");

    // Oversized records are dropped cleanly without corrupting subsequent frames.
    const framer = createClaudeJsonlFramer(16);
    expect(framer('0123456789abcdefX\n{"ok":true}\n')).toEqual(['{"ok":true}']);
  });

  it("interrupts through a control request and completes as interrupted", async () => {
    const { session, events } = await start();
    await session.startTurn({ turnId: "t1", text: "wait" });
    await until(events, "text.delta");
    await session.interrupt("other-turn");
    expect(stdinFrames().some((frame) => frame.request?.subtype === "interrupt")).toBe(false);
    await session.interrupt("t1");
    expect(await until(events, "turn.completed")).toEqual({
      type: "turn.completed",
      turnId: "t1",
      text: "working",
      stopReason: "interrupted",
    });
    expect(stdinFrames().some((frame) => frame.request?.subtype === "interrupt")).toBe(true);
  });
});

describe("MCP config and shutdown", () => {
  it("writes a private MCP config, disables built-in memory, and deletes it on close", async () => {
    const { session, events } = await start(
      {},
      {
        mcpServers: [
          {
            name: "wildbots",
            transport: "stdio",
            command: "node",
            args: ["mcp.js"],
            env: { A: "1" },
          },
          {
            name: "remote",
            transport: "http",
            url: "https://mcp.example/x",
            headers: { Authorization: "Bearer t" },
          },
        ],
      },
    );
    const { argv, mcpPath, mcpConfig, env } = launch();
    expect(argv).toContain("--strict-mcp-config");
    expect(env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(mcpConfig).toEqual({
      mcpServers: {
        wildbots: { type: "stdio", command: "node", args: ["mcp.js"], env: { A: "1" } },
        remote: {
          type: "http",
          url: "https://mcp.example/x",
          headers: { Authorization: "Bearer t" },
        },
      },
    });
    expect(existsSync(mcpPath!)).toBe(true);
    await session.close();
    expect(existsSync(mcpPath!)).toBe(false);
    expect(events.at(-1)).toEqual({ type: "session.closed", reason: "closed", unexpected: false });
  });

  it("rejects an MCP server without its transport target", async () => {
    await expect(
      driver().openSession(spec({ mcpServers: [{ name: "broken", transport: "http" }] })),
    ).rejects.toThrow(/"broken" needs a url/);
  });

  it("reports a non-zero exit mid-turn as an unexpected close and cleans up", async () => {
    const { session, events } = await start(
      {},
      { mcpServers: [{ name: "m", transport: "stdio", command: "node" }] },
    );
    await session.startTurn({ turnId: "t1", text: "crash" });
    const closed = await until(events, "session.closed");
    expect(closed.unexpected).toBe(true);
    expect(closed.reason).toContain("code 3");
    expect(await until(events, "turn.failed")).toMatchObject({
      turnId: "t1",
      recoverable: false,
      message: expect.stringContaining("fatal: mock crash"),
    });
    // Nobody called close(): the exit handler alone must remove the token-bearing config.
    const mcpPath = launch().mcpPath!;
    const deadline = Date.now() + 5_000;
    while (existsSync(mcpPath) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(mcpPath)).toBe(false);
    await expect(session.startTurn({ turnId: "t2", text: "hi" })).rejects.toThrow(/closed/);
  });

  it("reports SIGKILL as an unexpected close", async () => {
    const { session, events } = await start();
    await session.startTurn({ turnId: "t1", text: "sigkill" });
    expect(await until(events, "session.closed")).toEqual({
      type: "session.closed",
      reason: "Claude Code exited on SIGKILL",
      unexpected: true,
    });
  });

  it("escalates to SIGKILL when the CLI ignores stdin close and SIGTERM", async () => {
    const session = await driver(
      { CLAUDE_MOCK_IGNORE_SIGTERM: "1" },
      { closeGraceMs: 100, killGraceMs: 100 },
    ).openSession(spec());
    const events: HarnessEvent[] = [];
    session.events((event) => events.push(event));
    await session.startTurn({ turnId: "t1", text: "wait" });
    await until(events, "text.delta");
    await session.close();
    expect(events.slice(-2)).toEqual([
      { type: "turn.completed", turnId: "t1", stopReason: "interrupted" },
      { type: "session.closed", reason: "closed", unexpected: false },
    ]);
  });
});
