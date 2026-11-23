import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type {
  HarnessDriver,
  HarnessDriverId,
  HarnessEvent,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTurnInput,
} from "../src/server/harness/driver.js";
import { fileSigner } from "../src/server/hermes-files.js";
import { composeServerRuntime } from "../src/server/native-harness.js";
import { Store } from "../src/server/store.js";
import type { Bootstrap, Bot, Runtime } from "../src/shared/types.js";
import { fakeRuntime } from "./helpers/fake-runtime.js";
import {
  botFixture,
  capabilitiesFixture,
  conversationFixture,
} from "./helpers/runtime-fixtures.js";
import { localLogin } from "./helpers/server.js";

/** One harness session whose turns finish only when the test says so. */
class ScriptedSession implements HarnessSession {
  private listener?: (event: HarnessEvent) => void;
  readonly providerSessionId = `provider-${randomUUID()}`;
  readonly turns: HarnessTurnInput[] = [];
  readonly steers: HarnessTurnInput[] = [];
  steer?: HarnessSession["steer"];

  constructor(
    readonly id: string,
    steering: boolean,
  ) {
    if (steering)
      this.steer = async (input) => {
        this.steers.push(input);
      };
  }
  events(listener: (event: HarnessEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async startTurn(input: HarnessTurnInput) {
    this.turns.push(input);
    this.listener?.({ type: "turn.started", turnId: input.turnId });
  }
  complete(text: string) {
    const turn = this.turns.at(-1);
    if (!turn || !this.listener) throw new Error("No turn is running.");
    this.listener({ type: "text.delta", turnId: turn.turnId, delta: text });
    this.listener({ type: "turn.completed", turnId: turn.turnId, text, stopReason: "end_turn" });
  }
  async answerQuestion(): Promise<never> {
    throw new Error("ScriptedSession was asked to answer a question.");
  }
  async interrupt(): Promise<never> {
    throw new Error("ScriptedSession was asked to interrupt.");
  }
  async close() {}
}

/** A native harness: Claude Code and Pi queue a busy send, Codex steers it into the running turn. */
class ScriptedDriver implements HarnessDriver {
  readonly displayName: string;
  readonly capabilities;
  readonly opened: { spec: HarnessSessionSpec; session: ScriptedSession }[] = [];

  constructor(
    readonly id: HarnessDriverId,
    nativeSteering: boolean,
  ) {
    this.displayName = id;
    this.capabilities = {
      nativeSteering,
      resumable: true,
      supportsMcp: true,
      supportsImages: true,
      supportsReasoning: false,
      supportsSpeed: false,
    };
  }
  async probe() {
    return { available: true, version: "1.0.0" };
  }
  async listModels() {
    return [];
  }
  async openSession(spec: HarnessSessionSpec) {
    // Read the way a driver writes its MCP config, which is when the WildBots session is minted.
    const session = new ScriptedSession(spec.sessionKey, this.capabilities.nativeSteering);
    this.opened.push({ spec: JSON.parse(JSON.stringify(spec)) as HarnessSessionSpec, session });
    return session;
  }
  get session() {
    const session = this.opened.at(-1)?.session;
    if (!session) throw new Error(`${this.id} has no session.`);
    return session;
  }
}

const origin = "http://127.0.0.1:3000";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let tick = 0; tick < 200; tick++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function boot() {
  const directory = await mkdtemp(join(tmpdir(), "native-harness-e2e-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("WILDBOTS_VAULT_KEY", undefined);
  vi.stubEnv("E2E_ANTHROPIC_KEY", "synthetic-anthropic-key");
  vi.stubEnv("E2E_OPENAI_KEY", "synthetic-openai-key");
  const config = loadConfig({
    LOCAL_DEV_AUTH: "true",
    APP_ORIGIN: origin,
    APP_DATABASE: join(directory, "app.sqlite"),
  });
  const store = new Store(config.database);
  // One household key per harness, so a new assistant gets its harness's key without naming it.
  for (const [id, vendor, envVar, harness] of [
    ["anthropic-key", "anthropic", "E2E_ANTHROPIC_KEY", "claude-code"],
    ["openai-key", "openai", "E2E_OPENAI_KEY", "codex"],
  ] as const)
    store.managedBots.upsertCredential({
      id,
      label: id,
      kind: "api_key",
      vendor,
      envVar,
      allowedHarnesses: [harness],
    });
  const hermesSaves: unknown[] = [];
  const hermes: Runtime = fakeRuntime({
    status: async () => ({ connected: true }),
    capabilities: async () => capabilitiesFixture(),
    listBots: async () => [botFixture({ id: "barn", name: "Barn" })],
    conversation: async (botId) => conversationFixture({ botId }),
    saveBot: async (input) => {
      hermesSaves.push(input);
      throw new Error("Hermes was asked to create an assistant.");
    },
    close: async () => {},
  });
  const claude = new ScriptedDriver("claude-code", false);
  const codex = new ScriptedDriver("codex", true);
  const server = await composeServerRuntime({
    config,
    store,
    hermes,
    files: fileSigner(store.fileKeys(), undefined),
    drivers: { "claude-code": claude, codex },
  });
  const { app, macs } = await createApp(config, server.runtime, {
    store,
    background: false,
    probeHarnesses: server.probeHarnesses,
    closeServices: () => server.close(),
  });
  server.attachMacs(macs);
  cleanups.push(() => app.close());
  const headers = await localLogin(app, origin);
  const create = async (name: string, harness: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name, instructions: "Help the ranch.", model: "model-1", harness, shared: false },
    });
    expect(response.json()).toMatchObject({ harness });
    expect(response.statusCode).toBe(200);
    return response.json() as Bot;
  };
  const send = (botId: string, text: string, attachments: unknown[] = []) =>
    app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers,
      payload: { requestId: randomUUID(), text, attachments },
    });
  return { app, store, headers, claude, codex, hermesSaves, create, send };
}

describe("native harnesses in the live server", () => {
  it("creates a Claude Code assistant natively, queues a busy send, edits it and drains it after the first turn", async () => {
    const { app, store, headers, claude, hermesSaves, create, send } = await boot();
    const scout = await create("Scout", "claude-code");
    expect(hermesSaves).toEqual([]);
    expect(store.managedBots.getManagedBot(scout.id)).toMatchObject({
      harness: "claude-code",
      ownerId: "local-one",
      credentialId: "anthropic-key",
      enabledMcpServers: ["wildbots"],
    });

    const bootstrap = (await app.inject({ url: "/api/bootstrap", headers })).json() as Bootstrap;
    expect(bootstrap.harnesses).toEqual([
      { id: "codex", available: true },
      { id: "claude-code", available: true },
    ]);
    expect(bootstrap.bots.map(({ id, harness }) => ({ id, harness }))).toEqual([
      { id: "barn", harness: "hermes" },
      { id: scout.id, harness: "claude-code" },
    ]);
    expect(bootstrap.bots.find((bot) => bot.id === scout.id)?.capabilities).toMatchObject({
      steering: { supported: false },
      queueManagement: { supported: true },
      uploads: { supported: true },
      generatedFiles: { supported: true },
    });

    const first = await send(scout.id, "Count the cattle.");
    expect(first.json()).toMatchObject({ status: "accepted" });
    await until(() => claude.opened.length === 1, "the first turn to start");
    // The turn gets a WildBots MCP session of its own.
    expect(claude.opened[0].spec.mcpServers).toEqual([
      {
        name: "wildbots",
        transport: "http",
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//),
        headers: { Authorization: expect.stringMatching(/^Bearer \S+\.\S+$/) },
      },
    ]);

    // Claude Code cannot steer, so the second message waits in the queue instead of failing.
    const second = await send(scout.id, "Then check the fences.");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: "accepted" });
    const queue = await app.inject({ url: `/api/bots/${scout.id}/queue`, headers });
    const [waiting] = queue.json().items as { id: string; text: string; status: string }[];
    expect(queue.json().items).toHaveLength(1);
    expect(waiting).toMatchObject({ text: "Then check the fences.", status: "queued" });

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/bots/${scout.id}/queue/${waiting.id}`,
      headers,
      payload: { text: "Then check the north fence." },
    });
    expect(edited.statusCode).toBe(200);
    expect(claude.session.turns.map(({ text }) => text)).toEqual(["Count the cattle."]);

    claude.session.complete("Forty head.");
    await until(
      () => claude.opened.flatMap(({ session }) => session.turns).length === 2,
      "the queued message to start",
    );
    expect(claude.opened.flatMap(({ session }) => session.turns).map(({ text }) => text)).toEqual([
      "Count the cattle.",
      "Then check the north fence.",
    ]);
    expect(
      (await app.inject({ url: `/api/bots/${scout.id}/queue`, headers })).json().items,
    ).toEqual([]);
  });

  it("uploads an attachment to a native assistant and downloads it again", async () => {
    const { app, headers, create } = await boot();
    const scout = await create("Scout", "claude-code");
    const boundary = "e2e-boundary";
    const upload = await app.inject({
      method: "POST",
      url: `/api/bots/${scout.id}/uploads`,
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="fence.txt"',
        "Content-Type: text/plain",
        "",
        "North fence is down.",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    });
    expect(upload.statusCode).toBe(200);
    const file = upload.json() as { id: string; name: string };
    expect(file.name).toBe("fence.txt");

    const download = await app.inject({
      url: `/api/files/${encodeURIComponent(file.id)}`,
      headers,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toMatch(/^text\/plain/);
    expect(download.body).toBe("North fence is down.");
  });

  it("lets a native turn propose a memory through the WildBots MCP server and shows it for review", async () => {
    const { app, headers, claude, create, send } = await boot();
    const scout = await create("Scout", "claude-code");
    await send(scout.id, "Remember the herd size.");
    await until(() => claude.opened.length === 1, "the turn to start");
    const [server] = claude.opened[0].spec.mcpServers ?? [];
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const response = await fetch(server.url!, {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { result: { tools?: { name: string }[] } };
    };
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    const tools = (await rpc("tools/list", {})).result.tools!.map(({ name }) => name);
    expect(tools).toEqual(expect.arrayContaining(["memory_propose", "skill_propose"]));
    // A Claude Code assistant is personal, so its owner's Mac tools are offered too.
    expect(tools).toContain("mac_list");
    expect(
      await rpc("tools/call", {
        name: "memory_propose",
        arguments: {
          op: "add",
          key: "ranch.herd",
          kind: "memory",
          content: "The herd is forty head.",
          reason: "Counted today.",
        },
      }),
    ).toMatchObject({ result: { content: [{ text: expect.stringContaining("for review") }] } });

    const learning = await app.inject({ url: `/api/bots/${scout.id}/learning`, headers });
    expect(learning.statusCode).toBe(200);
    expect(learning.json().pending).toEqual([
      expect.objectContaining({ status: "pending", name: "ranch.herd", reason: "Counted today." }),
    ]);
  });

  it("still steers a busy send into a Codex turn", async () => {
    const { codex, create, send } = await boot();
    const planner = await create("Planner", "codex");
    await send(planner.id, "Plan the week.");
    await until(() => codex.opened.length === 1, "the Codex turn to start");

    const steered = await send(planner.id, "Add the hay delivery.");
    expect(steered.statusCode).toBe(200);
    expect(steered.json()).toMatchObject({ status: "accepted", steered: true });
    expect(codex.session.steers.map(({ text }) => text)).toEqual(["Add the hay delivery."]);
  });

  it("deleting a native assistant forgets its memory, routines and own secrets, and keeps its owner's", async () => {
    const { app, store, headers, create } = await boot();
    const scout = await create("Scout", "claude-code");
    store.memory.updateSettings(scout.id, { autoApply: true });
    store.memory.proposeMemoryEdit(
      scout.id,
      { op: "add", kind: "memory", key: "ranch.herd", content: "Forty head." },
      { origin: "bot", reason: "Counted today." },
    );
    store.nativeRoutines.create({
      botId: scout.id,
      name: "Gate check",
      kind: "interval",
      scheduleExpr: "60000",
      prompt: "Check the gate.",
    });
    store.secrets.setSecret({ kind: "bot", id: scout.id }, "gate-code", "1234", "local-one");
    store.secrets.setSecret({ kind: "bot", id: "barn" }, "gate-code", "5678", "local-one");
    store.secrets.setSecret({ kind: "owner", id: "local-one" }, "gate-code", "9012", "local-one");
    expect(store.memory.listEntries(scout.id)).toHaveLength(1);

    const removed = await app.inject({ method: "DELETE", url: `/api/bots/${scout.id}`, headers });
    expect(removed.statusCode).toBe(200);

    expect(store.memory.listEntries(scout.id)).toEqual([]);
    expect(store.memory.listRevisions(scout.id)).toEqual([]);
    expect(store.nativeRoutines.list(scout.id)).toEqual([]);
    expect(
      store.db
        .prepare("SELECT scope_kind AS kind, scope_id AS id FROM bot_secrets ORDER BY 1, 2")
        .all(),
    ).toEqual([
      { kind: "bot", id: "barn" },
      { kind: "owner", id: "local-one" },
    ]);
  });

  it("refuses an unknown harness instead of creating a Hermes profile", async () => {
    const { app, headers, hermesSaves } = await boot();
    const response = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: {
        name: "Ghost",
        instructions: "",
        model: "model-1",
        harness: "nope",
        shared: false,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Choose a registered native harness." });
    expect(hermesSaves).toEqual([]);
  });
});

describe("native harness configuration", () => {
  it("keeps workspaces beside the database unless switched off or in memory, and rejects other values", () => {
    expect(loadConfig({ APP_DATABASE: "/srv/wildbots/app.sqlite" }).nativeHarness).toEqual({
      workspaceRoot: "/srv/wildbots/workspaces",
    });
    expect(
      loadConfig({ APP_DATABASE: "/srv/wildbots/app.sqlite", WILDBOTS_HARNESS_ENABLED: "false" })
        .nativeHarness,
    ).toBeUndefined();
    expect(loadConfig({ APP_DATABASE: ":memory:" }).nativeHarness).toBeUndefined();
    expect(() => loadConfig({ WILDBOTS_HARNESS_ENABLED: "off" })).toThrow(
      "WILDBOTS_HARNESS_ENABLED must be true or false",
    );
  });

  it("refuses a native assistant on a server running only Hermes, before Hermes hears of it", async () => {
    const store = new Store(":memory:");
    const saveBot = vi.fn<Runtime["saveBot"]>(async () => botFixture({ id: "barn" }));
    const server = await composeServerRuntime({
      config: {},
      store,
      hermes: fakeRuntime({ saveBot, close: async () => {} }),
      files: fileSigner(store.fileKeys(), undefined),
      drivers: { "claude-code": new ScriptedDriver("claude-code", false) },
    });
    cleanups.push(async () => {
      await server.runtime.close();
      store.close();
    });
    expect(server.probeHarnesses).toBeUndefined();
    const input = { name: "Scout", instructions: "", model: "model-1", shared: true };
    await expect(server.runtime.saveBot({ ...input, harness: "claude-code" })).rejects.toThrow(
      "This server runs only Hermes assistants.",
    );
    expect(saveBot).not.toHaveBeenCalled();
    await server.runtime.saveBot({ ...input, harness: "hermes" });
    expect(saveBot).toHaveBeenCalledWith({ ...input, harness: "hermes" });
  });
});
