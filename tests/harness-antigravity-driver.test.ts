// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAntigravityDriver } from "../src/server/harness/antigravity-driver.js";
import type { HarnessEvent } from "../src/server/harness/driver.js";

const fixture = fileURLToPath(
  new URL("./fixtures/harness/antigravity-mock-acp.mjs", import.meta.url),
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "wildbots-agy-test-"));
  dirs.push(dir);
  return dir;
}

describe("antigravity ACP driver", () => {
  it("probes CLI version and rejects versions below 1.5.0", async () => {
    const dir = makeTempDir();
    const okDriver = createAntigravityDriver({
      command: process.execPath,
      args: [fixture],
      geminiDir: join(dir, "gemini"),
      env: { AGY_FIXTURE_LOG: join(dir, "ok.ndjson") },
    });
    expect(await okDriver.probe()).toEqual({ available: true, version: "1.5.16" });

    const oldDriver = createAntigravityDriver({
      command: process.execPath,
      args: [fixture],
      geminiDir: join(dir, "gemini-old"),
      env: { AGY_FIXTURE_SCENARIO: "version-old" },
    });
    expect(await oldDriver.probe()).toEqual({
      available: false,
      version: "1.4.2",
      reason: "Antigravity CLI 1.4.2 is too old; upgrade to 1.5.0 or newer.",
    });
  });

  it("discovers Gemini 4 Neon via ACP listModels and caches results", async () => {
    const dir = makeTempDir();
    const logPath = join(dir, "models.ndjson");
    const driver = createAntigravityDriver({
      command: process.execPath,
      args: [fixture],
      geminiDir: join(dir, "gemini"),
      env: { AGY_FIXTURE_LOG: logPath },
      modelCacheTtlMs: 60_000,
    });
    const first = await driver.listModels();
    expect(first).toEqual([
      {
        id: "google",
        name: "Antigravity (Google)",
        aliases: ["antigravity"],
        authenticated: true,
        models: [
          { id: "gemini-4-neon", name: "Gemini 4 Neon", available: true },
          { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", available: true },
        ],
      },
    ]);
    const launchesAfterFirst = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes('"argv"')).length;
    expect(launchesAfterFirst).toBe(1);

    const second = await driver.listModels();
    expect(second).toEqual(first);
    const launchesAfterSecond = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes('"argv"')).length;
    expect(launchesAfterSecond).toBe(1);
  });

  it("passes systemPrompt via _meta, configures gemini-4-neon and thought_level, and streams replies", async () => {
    const dir = makeTempDir();
    const logPath = join(dir, "session.ndjson");
    const driver = createAntigravityDriver({
      command: process.execPath,
      args: [fixture],
      geminiDir: join(dir, "gemini"),
      env: { AGY_FIXTURE_LOG: logPath, DISPLAY: ":0" },
    });
    const session = await driver.openSession({
      botId: "tars",
      sessionKey: "s1",
      cwd: dir,
      model: "gemini-4-neon",
      reasoning: "high",
      systemPrompt: "You are Chief TARS.",
      mcpServers: [{ name: "wildbots", transport: "http", url: "http://127.0.0.1:9999/mcp" }],
      fullPermissions: true,
    });
    const events: HarnessEvent[] = [];
    const done = new Promise<void>((resolve) => {
      session.events((event) => {
        events.push(event);
        if (event.type === "turn.completed" || event.type === "turn.failed") resolve();
      });
    });
    await session.startTurn({ turnId: "t1", text: "Hello Neon" });
    await done;
    await session.close();

    expect(events).toContainEqual({
      type: "reasoning.delta",
      turnId: "t1",
      delta: "Neon reasoning",
    });
    expect(events).toContainEqual({
      type: "turn.completed",
      turnId: "t1",
      text: "Model=gemini-4-neon Effort=high",
      stopReason: "end_turn",
    });
    expect(events).toContainEqual({
      type: "usage.reported",
      turnId: "t1",
      inputTokens: undefined,
      outputTokens: undefined,
      contextTokens: 1200,
      contextWindow: 1_000_000,
    });

    const wire = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(wire[0]).toMatchObject({
      hasDisplay: false,
      forceFileStorage: "1",
      updaterDisabled: "1",
    });
    expect(wire[0].argv).toContain("--dangerously-skip-permissions");
    const newSession = wire.find((entry) => entry.method === "session/new");
    expect(newSession.params._meta).toEqual({
      antigravity: { systemPrompt: { append: "You are Chief TARS." } },
    });
    const promptMsg = wire.find((entry) => entry.method === "session/prompt");
    expect(promptMsg.params.prompt).toEqual([{ type: "text", text: "Hello Neon" }]);
  });
});
