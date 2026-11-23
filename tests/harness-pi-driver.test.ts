import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  HarnessEvent,
  HarnessSession,
  HarnessSessionSpec,
} from "../src/server/harness/driver.js";
import {
  createPiDriver,
  piThinkingLevel,
  type PiDriverOptions,
} from "../src/server/harness/pi-driver.js";

const MOCK = fileURLToPath(new URL("./fixtures/harness/pi-mock-rpc.mjs", import.meta.url));

let dir: string;
let logPath: string;
const open: HarnessSession[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pi-driver-test-"));
  logPath = path.join(dir, "mock.log");
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.close()));
  await rm(dir, { recursive: true, force: true });
});

function driver(env: Record<string, string> = {}, extra: PiDriverOptions = {}) {
  return createPiDriver({
    command: process.execPath,
    args: [MOCK],
    env: { PI_MOCK_LOG: logPath, PI_MOCK_SESSION_DIR: dir, ...env },
    tempDir: dir,
    probeTimeoutMs: 2_000,
    terminationGraceMs: 500,
    ...extra,
  });
}

function spec(overrides: Partial<HarnessSessionSpec> = {}): HarnessSessionSpec {
  return {
    botId: "bot-1",
    sessionKey: "session-1",
    cwd: dir,
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    fullPermissions: true,
    ...overrides,
  };
}

type LogEntry = {
  kind: string;
  pid?: number;
  argv?: string[];
  approval?: string | null;
  extensionExists?: boolean | null;
  appendSystemPrompt?: string | null;
  mcpConfig?: { servers: unknown[] } | null;
  command?: Record<string, unknown>;
};

async function readLog(): Promise<LogEntry[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

async function commands(type: string) {
  return (await readLog())
    .filter((entry) => entry.command?.["type"] === type)
    .map((e) => e.command!);
}

async function bridgeDirs() {
  return (await readdir(dir)).filter((name) => name.startsWith("wildbots-pi-"));
}

/** Opens a session and records every event, with a waiter for a specific one. */
async function openRecorded(d: ReturnType<typeof driver>, s = spec()) {
  const session = await d.openSession(s);
  open.push(session);
  const events: HarnessEvent[] = [];
  const waiters: Array<() => void> = [];
  session.events((event) => {
    events.push(event);
    for (const wake of waiters.splice(0)) wake();
  });
  async function waitFor<T extends HarnessEvent["type"]>(
    type: T,
    match: (event: Extract<HarnessEvent, { type: T }>) => boolean = () => true,
  ): Promise<Extract<HarnessEvent, { type: T }>> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = events.find(
        (event): event is Extract<HarnessEvent, { type: T }> =>
          event.type === type && match(event as Extract<HarnessEvent, { type: T }>),
      );
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(events)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }
  return { session, events, waitFor };
}

describe("probe", () => {
  it("reports the version printed by --version", async () => {
    await expect(driver().probe()).resolves.toEqual({ available: true, version: "0.79.10" });
  });

  it("reports a missing binary, a hang and a failing exit with distinct reasons", async () => {
    const missing = await createPiDriver({ command: path.join(dir, "no-such-pi") }).probe();
    expect(missing).toMatchObject({
      available: false,
      reason: expect.stringContaining("was not found"),
    });

    const hang = await driver({ PI_MOCK_VERSION_MODE: "hang" }, { probeTimeoutMs: 300 }).probe();
    expect(hang).toMatchObject({ available: false, reason: expect.stringContaining("timed out") });

    const failed = await driver({ PI_MOCK_VERSION_MODE: "fail" }).probe();
    expect(failed).toMatchObject({ available: false, reason: expect.stringContaining("code 2") });
  });
});

describe("listModels", () => {
  it("groups Pi's configured models by provider", async () => {
    const providers = await driver().listModels();
    expect(providers.map((p) => [p.id, p.name, p.authenticated])).toEqual([
      ["openrouter", "OpenRouter", true],
      ["google", "Google Gemini", true],
      ["anthropic", "Anthropic", true],
      ["ollama", "Ollama", true],
    ]);
    expect(providers[0]!.models).toEqual([
      { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", available: true },
      { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", available: true },
    ]);
    // A model without a name falls back to its id.
    expect(providers[3]!.models).toEqual([{ id: "llama3.1", name: "llama3.1", available: true }]);
    const start = (await readLog()).find((entry) => entry.kind === "start");
    expect(start?.argv).toEqual(
      expect.arrayContaining(["--no-session", "--no-extensions", "--offline"]),
    );
  });

  it("falls back to an unauthenticated catalog with the reason when Pi rejects the request", async () => {
    const providers = await driver({ PI_MOCK_MODELS: "fail" }).listModels();
    expect(providers.map((p) => p.id)).toEqual([
      "openrouter",
      "google",
      "anthropic",
      "openai",
      "ollama",
    ]);
    expect(providers.every((p) => !p.authenticated && p.models.every((m) => !m.available))).toBe(
      true,
    );
    expect(providers[0]!.warning).toContain("models unavailable");
  });

  it("falls back when the Pi binary is missing", async () => {
    const providers = await createPiDriver({ command: path.join(dir, "no-such-pi") }).listModels();
    expect(providers[0]).toMatchObject({ id: "openrouter", authenticated: false });
    expect(providers[0]!.warning).toContain("not found");
  });
});

describe("piThinkingLevel", () => {
  it.each([
    ["none", "off"],
    ["high", "high"],
    ["max", "xhigh"],
    ["ultra", "xhigh"],
    ["turbo", undefined],
    [undefined, undefined],
  ])("maps %s to %s", (input, expected) => {
    expect(piThinkingLevel(input)).toBe(expected);
  });
});

describe("openSession", () => {
  it("launches pi --mode rpc with model flags, a file-backed system prompt and replays session.ready", async () => {
    const prompt = "You are Clem.\nRemember the ranch.";
    const { session, waitFor } = await openRecorded(
      driver(),
      spec({
        provider: "openrouter",
        model: "google/gemini-2.5-pro",
        reasoning: "max",
        systemPrompt: prompt,
      }),
    );
    // session.ready fired during openSession, before the listener existed.
    const ready = await waitFor("session.ready");
    expect(ready.providerSessionId).toMatch(/session-\d+\.jsonl$/);
    expect(session.providerSessionId).toBe(ready.providerSessionId);

    const start = (await readLog()).find((entry) => entry.kind === "start")!;
    expect(start.argv).toEqual(
      expect.arrayContaining([
        "--mode",
        "rpc",
        "--provider",
        "openrouter",
        "--model",
        "google/gemini-2.5-pro",
      ]),
    );
    expect(start.argv![start.argv!.indexOf("--thinking") + 1]).toBe("xhigh");
    expect(start.appendSystemPrompt).toBe(prompt);
    expect(start.argv!.join(" ")).not.toContain("Remember the ranch");
    // No MCP and full permissions: no bridge extension.
    expect(start.argv).not.toContain("--extension");
  });

  it("resumes a session file and re-applies the requested model over the saved one", async () => {
    const first = await openRecorded(driver(), spec());
    const sessionFile = (await first.waitFor("session.ready")).providerSessionId;
    await first.session.close();

    const second = await openRecorded(
      driver(),
      spec({ resumeSessionId: sessionFile, provider: "google", model: "gemini-2.5-flash" }),
    );
    expect((await second.waitFor("session.ready")).providerSessionId).toBe(sessionFile);
    const starts = (await readLog()).filter((entry) => entry.kind === "start");
    expect(starts[1]!.argv).toEqual(expect.arrayContaining(["--session", sessionFile]));
    expect(await commands("set_model")).toEqual([
      expect.objectContaining({ provider: "google", modelId: "gemini-2.5-flash" }),
    ]);
  });

  it("does not send set_model when the running model already matches", async () => {
    await openRecorded(driver(), spec());
    expect(await commands("set_model")).toEqual([]);
  });

  it("refuses to run as a different OS user", async () => {
    await expect(driver().openSession(spec({ osUser: "someone-else-entirely" }))).rejects.toThrow(
      "cannot run as OS user someone-else-entirely",
    );
    expect(await bridgeDirs()).toEqual([]);
  });
});

describe("turns", () => {
  it("streams UTF-8 text and thinking split across chunk boundaries and reports usage", async () => {
    const { session, events, waitFor } = await openRecorded(driver());
    await session.startTurn({ turnId: "t1", text: "hello" });
    const done = await waitFor("turn.completed");
    expect(done).toEqual({
      type: "turn.completed",
      turnId: "t1",
      text: "Héllo 🤠 wörld !",
      stopReason: "end_turn",
    });
    const text = events.flatMap((e) => (e.type === "text.delta" ? [e.delta] : [])).join("");
    const thinking = events
      .flatMap((e) => (e.type === "reasoning.delta" ? [e.delta] : []))
      .join("");
    expect(text).toBe("Héllo 🤠 wörld !");
    expect(thinking).toBe("Let me think… done.");
    expect(events.filter((e) => e.type === "turn.started")).toEqual([
      { type: "turn.started", turnId: "t1" },
    ]);
    expect(await waitFor("usage.reported")).toEqual({
      type: "usage.reported",
      turnId: "t1",
      inputTokens: 135,
      outputTokens: 20,
      contextTokens: 155,
      contextWindow: 200_000,
    });
    // Usage arrives before the turn closes so consumers can attach it.
    expect(events.findIndex((e) => e.type === "usage.reported")).toBeLessThan(
      events.findIndex((e) => e.type === "turn.completed"),
    );
  });

  it("sends images inline and lists every attachment path in the message", async () => {
    const imagePath = path.join(dir, "photo.png");
    const pdfPath = path.join(dir, "notes.pdf");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(pdfPath, "pdf");
    const { session, waitFor } = await openRecorded(driver());
    await session.startTurn({
      turnId: "t1",
      text: "look",
      attachments: [
        { id: "a1", name: "photo.png", mime: "image/png", path: imagePath },
        { id: "a2", name: "notes.pdf", mime: "application/pdf", path: pdfPath },
      ],
    });
    await waitFor("turn.completed");
    const [prompt] = await commands("prompt");
    expect(prompt!["images"]).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png" }]);
    expect(prompt!["message"]).toBe(
      `look\n\nAttached files:\n- photo.png (image/png): ${imagePath}\n- notes.pdf (application/pdf): ${pdfPath}`,
    );
  });

  it("maps tool execution start and end, including failed tools", async () => {
    const { session, events, waitFor } = await openRecorded(driver());
    await session.startTurn({ turnId: "t1", text: "use a tool" });
    expect((await waitFor("turn.completed")).text).toBe("Listed.");
    expect(events.filter((e) => e.type.startsWith("tool."))).toEqual([
      {
        type: "tool.started",
        turnId: "t1",
        callId: "call_1",
        name: "bash",
        arguments: '{"command":"ls"}',
      },
      {
        type: "tool.completed",
        turnId: "t1",
        callId: "call_1",
        name: "bash",
        output: "README.md\n",
      },
      {
        type: "tool.started",
        turnId: "t1",
        callId: "call_2",
        name: "read",
        arguments: '{"path":"missing"}',
      },
      {
        type: "tool.completed",
        turnId: "t1",
        callId: "call_2",
        name: "read",
        error: "ENOENT: missing",
      },
    ]);
  });

  it("reports a model error as turn.failed with Pi's message", async () => {
    const { session, waitFor } = await openRecorded(driver());
    await session.startTurn({ turnId: "t1", text: "fail please" });
    expect(await waitFor("turn.failed")).toEqual({
      type: "turn.failed",
      turnId: "t1",
      message: "429 rate limited",
    });
  });

  it("rejects a second turn while one runs, since Pi has no native steering here", async () => {
    const { session, waitFor } = await openRecorded(driver());
    await session.startTurn({ turnId: "t1", text: "slow" });
    await expect(session.startTurn({ turnId: "t2", text: "again" })).rejects.toThrow(
      "t1 is still running",
    );
    await session.interrupt();
    await waitFor("turn.completed");
    // The session accepts a new turn once the first ends.
    await session.startTurn({ turnId: "t3", text: "hello" });
    await waitFor("turn.completed", (e) => e.turnId === "t3");
  });

  it("interrupts with abort and completes the turn as interrupted", async () => {
    const { session, waitFor } = await openRecorded(driver());
    await session.startTurn({ turnId: "t1", text: "slow" });
    await waitFor("text.delta");
    await session.interrupt("other-turn");
    expect(await commands("abort")).toEqual([]);
    await session.interrupt("t1");
    expect(await waitFor("turn.completed")).toMatchObject({
      turnId: "t1",
      stopReason: "interrupted",
      text: "working",
    });
    expect(await commands("abort")).toHaveLength(1);
  });
});

describe("extension dialogs", () => {
  it("surfaces a select as question.asked and answers it with extension_ui_response", async () => {
    const { session, events, waitFor } = await openRecorded(driver());
    await session.startTurn({ turnId: "t1", text: "ask me" });
    const asked = await waitFor("question.asked");
    expect(asked).toEqual({
      type: "question.asked",
      turnId: "t1",
      requestId: "ui-select-1",
      title: "Pick a color",
      prompt: "Pick a color",
      questions: [
        {
          id: "ui-select-1",
          header: "Pick a color",
          question: "Pick a color",
          options: ["red", "blue"],
        },
      ],
    });
    // Fire-and-forget setStatus never becomes a question.
    expect(events.filter((e) => e.type === "question.asked")).toHaveLength(1);
    await expect(session.answerQuestion("nope", { nope: "x" })).rejects.toThrow(
      "No pending Pi question nope",
    );
    await session.answerQuestion("ui-select-1", { "ui-select-1": "blue" });
    expect((await waitFor("turn.completed")).text).toBe('{"value":"blue"}');
  });

  it("asks before a confirm without full permissions and sends the decision", async () => {
    const { session, waitFor } = await openRecorded(driver(), spec({ fullPermissions: false }));
    await session.startTurn({ turnId: "t1", text: "confirm it" });
    const asked = await waitFor("question.asked");
    expect(asked.prompt).toBe("rm -rf build");
    expect(asked.questions[0]!.options).toEqual(["Allow", "Deny"]);
    await session.answerQuestion(asked.requestId, { [asked.requestId]: "Deny" });
    expect((await waitFor("turn.completed")).text).toBe('{"confirmed":false}');
  });

  it("cancels the dialog when the answer map is empty", async () => {
    const { session, waitFor } = await openRecorded(driver(), spec({ fullPermissions: false }));
    await session.startTurn({ turnId: "t1", text: "confirm it" });
    const asked = await waitFor("question.asked");
    await session.answerQuestion(asked.requestId, {});
    expect((await waitFor("turn.completed")).text).toBe('{"cancelled":true}');
  });

  it("auto-confirms with full permissions without asking", async () => {
    const { session, events, waitFor } = await openRecorded(
      driver(),
      spec({ fullPermissions: true }),
    );
    await session.startTurn({ turnId: "t1", text: "confirm it" });
    expect((await waitFor("turn.completed")).text).toBe('{"confirmed":true}');
    expect(events.some((e) => e.type === "question.asked")).toBe(false);
  });
});

describe("bridge extension and cleanup", () => {
  it("writes the MCP config and approval gate for the session and removes them on close", async () => {
    const mcpServers = [
      {
        name: "wildbots",
        transport: "http" as const,
        url: "http://127.0.0.1:9/mcp",
        headers: { authorization: "Bearer s3cret" },
      },
      { name: "files", transport: "stdio" as const, command: "node", args: ["server.js"] },
    ];
    const { session, events } = await openRecorded(
      driver(),
      spec({ fullPermissions: false, mcpServers }),
    );
    const start = (await readLog()).find((entry) => entry.kind === "start")!;
    const extension = start.argv![start.argv!.indexOf("--extension") + 1]!;
    expect(start.extensionExists).toBe(true);
    expect(start.approval).toBe("required");
    expect(start.mcpConfig).toEqual({ servers: mcpServers });
    // Credentials travel in the config file, never in argv.
    expect(start.argv!.join(" ")).not.toContain("s3cret");
    expect(existsSync(extension)).toBe(true);

    await session.close();
    expect(existsSync(extension)).toBe(false);
    expect(await bridgeDirs()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "session.closed", reason: "closed", unexpected: false });
  });

  it("does not leak inherited bridge settings into a session that needs none", async () => {
    await openRecorded(
      driver({ WILDBOTS_PI_APPROVAL: "required", WILDBOTS_PI_MCP_CONFIG: "/etc/passwd" }),
    );
    const start = (await readLog()).find((entry) => entry.kind === "start")!;
    expect(start.approval).toBeNull();
    expect(start.mcpConfig).toBeNull();
    expect(await bridgeDirs()).toEqual([]);
  });

  it("removes temp files when initialization fails", async () => {
    // Write a corrupt session file the mock cannot parse, so it crashes before get_state answers.
    await writeFile(path.join(dir, "corrupt.jsonl"), "{not json");
    await expect(
      driver().openSession(
        spec({ systemPrompt: "x", resumeSessionId: path.join(dir, "corrupt.jsonl") }),
      ),
    ).rejects.toThrow("exited with code 1");
    expect(await bridgeDirs()).toEqual([]);
  });
});

describe("unexpected exit", () => {
  it("fails the running turn and closes the session as unexpected when Pi exits 1", async () => {
    const { session, events, waitFor } = await openRecorded(driver(), spec({ systemPrompt: "p" }));
    await session.startTurn({ turnId: "t1", text: "crash now" });
    const closed = await waitFor("session.closed");
    expect(closed).toEqual({
      type: "session.closed",
      reason: "pi process exited with code 1",
      unexpected: true,
    });
    expect(events.find((e) => e.type === "turn.failed")).toMatchObject({
      turnId: "t1",
      recoverable: true,
    });
    expect(await bridgeDirs()).toEqual([]);
    await expect(session.startTurn({ turnId: "t2", text: "hi" })).rejects.toThrow("closed");
  });

  it("closes as unexpected when Pi is killed with SIGKILL", async () => {
    const { waitFor } = await openRecorded(driver());
    const pid = (await readLog()).find((entry) => entry.kind === "start")!.pid!;
    process.kill(pid, "SIGKILL");
    expect(await waitFor("session.closed")).toEqual({
      type: "session.closed",
      reason: "pi process killed by SIGKILL",
      unexpected: true,
    });
  });

  it("rejects a pending RPC when Pi dies before answering it", async () => {
    const { session, waitFor } = await openRecorded(driver());
    await session.startTurn({ turnId: "t1", text: "abort-crash" });
    await expect(session.interrupt()).rejects.toThrow(
      "Pi RPC read failed: pi process exited with code 1",
    );
    expect((await waitFor("session.closed")).unexpected).toBe(true);
  });
});

describe("close", () => {
  it("terminates Pi with SIGTERM and ends a running turn as interrupted", async () => {
    const { session, events, waitFor } = await openRecorded(driver());
    await session.startTurn({ turnId: "t1", text: "slow" });
    await waitFor("text.delta");
    await session.close();
    expect((await readLog()).some((entry) => entry.kind === "sigterm")).toBe(true);
    expect(events.slice(-2)).toEqual([
      { type: "turn.completed", turnId: "t1", text: "working", stopReason: "interrupted" },
      { type: "session.closed", reason: "closed", unexpected: false },
    ]);
    // A second close is a no-op.
    await session.close();
    expect(events.filter((e) => e.type === "session.closed")).toHaveLength(1);
  });

  it("driver.close closes every open session", async () => {
    const d = driver();
    const a = await openRecorded(d, spec({ sessionKey: "a", systemPrompt: "a" }));
    const b = await openRecorded(d, spec({ sessionKey: "b", systemPrompt: "b" }));
    await d.close!();
    expect(a.events.at(-1)).toMatchObject({ type: "session.closed", unexpected: false });
    expect(b.events.at(-1)).toMatchObject({ type: "session.closed", unexpected: false });
    expect(await bridgeDirs()).toEqual([]);
  });
});
