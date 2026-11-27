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
import { fileSigner } from "../src/server/file-signer.js";
import { composeServerRuntime } from "../src/server/native-harness.js";
import { Store } from "../src/server/store.js";
import type { Bootstrap, Bot } from "../src/shared/types.js";
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
  const claude = new ScriptedDriver("claude-code", false);
  const codex = new ScriptedDriver("codex", true);
  const server = await composeServerRuntime({
    config,
    store,
    files: fileSigner(store.fileKeys()),
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
  return { app, store, headers, claude, codex, create, send };
}

describe("native harnesses in the live server", () => {
  it("creates a Claude Code assistant natively, queues a busy send, edits it and drains it after the first turn", async () => {
    const { app, store, headers, claude, create, send } = await boot();
    const scout = await create("Scout", "claude-code");
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
    // Both consecutive turns reused the exact same warm HarnessSession even with wildbots MCP enabled.
    expect(claude.opened).toHaveLength(1);
    expect(claude.opened.flatMap(({ session }) => session.turns).map(({ text }) => text)).toEqual([
      "Count the cattle.",
      "Then check the north fence.",
    ]);
    expect(
      (await app.inject({ url: `/api/bots/${scout.id}/queue`, headers })).json().items,
    ).toEqual([]);
  });

  it("reuses warm sessions across turns with wildbots MCP and rotates + revokes the old MCP token on config changes", async () => {
    const { app, store, headers, claude, create, send } = await boot();
    const scout = await create("Reuse Scout", "claude-code");

    const pingMcp = (server: { url?: string; headers?: Record<string, string> }) =>
      fetch(server.url!, {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });

    // Turn 1 opens a session and mints an MCP token.
    await send(scout.id, "First turn.");
    await until(() => claude.opened.length === 1, "turn 1 to open");
    const firstMcp = claude.opened[0].spec.mcpServers![0];
    expect((await pingMcp(firstMcp)).status).toBe(200);
    claude.session.complete("First answer.");
    await until(
      async () =>
        (
          (await app.inject({ url: `/api/bots/${scout.id}/conversation`, headers })).json() as {
            activity: { state: string };
          }
        ).activity.state === "idle",
      "turn 1 idle",
    );

    // Reading botDetail must not rotate or break session reuse.
    const detail = await app.inject({ url: `/api/bots/${scout.id}`, headers });
    expect(detail.statusCode).toBe(200);

    // Turn 2 with unchanged config reuses the exact same session and MCP token.
    await send(scout.id, "Second turn.");
    await until(() => claude.opened[0].session.turns.length === 2, "turn 2 on same session");
    expect(claude.opened).toHaveLength(1);
    expect((await pingMcp(firstMcp)).status).toBe(200);
    claude.session.complete("Second answer.");
    await until(
      async () =>
        (
          (await app.inject({ url: `/api/bots/${scout.id}/conversation`, headers })).json() as {
            activity: { state: string };
          }
        ).activity.state === "idle",
      "turn 2 idle",
    );

    // Changing instructions rotates the session and revokes the previous MCP token.
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/bots/${scout.id}`,
      headers,
      payload: {
        name: scout.name,
        instructions: "Updated ranch instructions.",
        model: "model-1",
        harness: "claude-code",
        shared: false,
      },
    });
    expect(updated.statusCode).toBe(200);
    await send(scout.id, "Third turn after instruction change.");
    await until(() => claude.opened.length === 2, "session rotation on instruction change");
    expect((await pingMcp(firstMcp)).status).toBe(401);
    const secondMcp = claude.opened[1].spec.mcpServers![0];
    expect((await pingMcp(secondMcp)).status).toBe(200);
    claude.session.complete("Third answer.");
    await until(
      async () =>
        (
          (await app.inject({ url: `/api/bots/${scout.id}/conversation`, headers })).json() as {
            activity: { state: string };
          }
        ).activity.state === "idle",
      "turn 3 idle",
    );

    // Changing active memory also rotates the session and revokes the prior MCP token.
    store.memory.importItems(scout.id, {
      entries: [
        { kind: "memory", key: "pasture", content: "North gate repaired.", reason: "test" },
      ],
      skills: [],
    });
    await send(scout.id, "Fourth turn after memory update.");
    await until(() => claude.opened.length === 3, "session rotation on memory change");
    expect((await pingMcp(secondMcp)).status).toBe(401);
    const thirdMcp = claude.opened[2].spec.mcpServers![0];
    expect((await pingMcp(thirdMcp)).status).toBe(200);
    claude.session.complete("Fourth answer.");
    await until(
      async () =>
        (
          (await app.inject({ url: `/api/bots/${scout.id}/conversation`, headers })).json() as {
            activity: { state: string };
          }
        ).activity.state === "idle",
      "turn 4 idle",
    );

    // Disabling the wildbots MCP server rotates the session and revokes the previous token.
    const disabledMcp = await app.inject({
      method: "PATCH",
      url: `/api/bots/${scout.id}`,
      headers,
      payload: {
        name: scout.name,
        instructions: "Updated ranch instructions.",
        model: "model-2",
        harness: "claude-code",
        shared: false,
        enabledMcpServers: [],
      },
    });
    expect(disabledMcp.statusCode).toBe(200);
    await send(scout.id, "Fifth turn without MCP.");
    await until(() => claude.opened.length === 4, "session rotation on mcp/model change");
    expect((await pingMcp(thirdMcp)).status).toBe(401);
    expect(claude.opened[3].spec.mcpServers).toEqual([]);
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

  it("refuses an unknown harness", async () => {
    const { app, headers } = await boot();
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
  });

  it("preserves a native bot's saved SQLite avatar", async () => {
    const { app, store, headers, create } = await boot();
    const scout = await create("Avatar Scout", "claude-code");
    const savedAvatar = {
      mode: "geometric" as const,
      shape: "flower" as const,
      color: "#32C759",
      eyes: "oval" as const,
      accessory: "none" as const,
    };
    store.saveAvatar(scout.id, savedAvatar, false);
    const bootstrap = (await app.inject({ url: "/api/bootstrap", headers })).json() as Bootstrap;
    expect(bootstrap.bots.find((bot) => bot.id === scout.id)?.avatar).toEqual(savedAvatar);
  });
});

describe("native harness configuration", () => {
  it("keeps workspaces beside the database unless in memory, and configures fallback when OPENROUTER_API_KEY is set", () => {
    expect(loadConfig({ APP_DATABASE: "/srv/wildbots/app.sqlite" }).nativeHarness).toEqual({
      workspaceRoot: "/srv/wildbots/harness",
    });
    expect(
      loadConfig({
        APP_DATABASE: "/srv/wildbots/app.sqlite",
        WILDBOTS_WORKSPACE_ROOT: "/var/lib/wildbots/harness",
      }).nativeHarness,
    ).toEqual({
      workspaceRoot: "/var/lib/wildbots/harness",
    });
    expect(loadConfig({ APP_DATABASE: ":memory:" }).nativeHarness).toBeUndefined();
    expect(
      loadConfig({
        APP_DATABASE: "/srv/wildbots/app.sqlite",
        OPENROUTER_API_KEY: "synthetic-openrouter-key",
      }).nativeHarness,
    ).toEqual({
      workspaceRoot: "/srv/wildbots/harness",
      fallback: {
        harness: "pi",
        model: "deepseek/deepseek-v4.1-flash",
        provider: "openrouter",
      },
    });
    expect(
      loadConfig({
        APP_DATABASE: "/srv/wildbots/app.sqlite",
        OPENROUTER_API_KEY: "synthetic-openrouter-key",
        WILDBOTS_FALLBACK_ENABLED: "false",
      }).nativeHarness,
    ).toEqual({
      workspaceRoot: "/srv/wildbots/harness",
    });
  });

  it("requires WILDBOTS_WORKSPACE_ROOT when running with an in-memory database", async () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    await expect(
      composeServerRuntime({
        config: {},
        store,
        files: fileSigner(store.fileKeys()),
        drivers: { "claude-code": new ScriptedDriver("claude-code", false) },
      }),
    ).rejects.toThrow("WILDBOTS_WORKSPACE_ROOT is required");
  });

  it("coordinates live MCP secret_request and vault_request_login through attention and encrypted storage", async () => {
    const { app, store, headers, claude, create, send } = await boot();
    const scout = await create("Vault Scout", "claude-code");

    const callMcp = async (
      server: { url?: string; headers?: Record<string, string> },
      name: string,
      args: Record<string, unknown>,
    ) => {
      const response = await fetch(server.url!, {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        result?: { content: { type: string; text: string }[]; isError?: boolean };
      };
    };

    await send(scout.id, "Connect my weather account.");
    await until(() => claude.opened.length === 1, "turn to open");
    const mcpServer = claude.opened[0].spec.mcpServers![0];

    const initResp = await fetch(mcpServer.url!, {
      method: "POST",
      headers: { ...mcpServer.headers, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(initResp.status).toBe(200);

    // 1. Assistant invokes secret_request via WildBots MCP.
    const secretCall = callMcp(mcpServer, "secret_request", {
      name: "WEATHER_API_KEY",
      prompt: "Enter your Weather API key.",
    });

    let pendingId = "";
    let pendingSecure: { epoch: string; sessionId: string; method: string } | undefined;
    await until(async () => {
      const conv = (
        await app.inject({ url: `/api/bots/${scout.id}/conversation`, headers })
      ).json() as {
        activity: { state: string };
        attention: {
          id: string;
          secure?: { epoch: string; sessionId: string; method: string; envVar?: string };
        }[];
      };
      const item = conv.attention.find((entry) => entry.secure?.method === "secret");
      if (conv.activity.state === "blocked" && item?.secure) {
        pendingId = item.id;
        pendingSecure = item.secure;
        return true;
      }
      return false;
    }, "blocked secret attention item");

    const secretCanary = "sk-e2e-weather-canary-9876";
    const answerResp = await app.inject({
      method: "POST",
      url: `/api/bots/${scout.id}/secure-requests/${pendingId}`,
      headers,
      payload: {
        epoch: pendingSecure!.epoch,
        sessionId: pendingSecure!.sessionId,
        method: "secret",
        value: secretCanary,
      },
    });
    expect(answerResp.statusCode).toBe(200);
    expect(answerResp.json()).toEqual({ status: "ok" });

    const secretResult = await secretCall;
    expect(secretResult.result?.isError).not.toBe(true);
    expect(JSON.stringify(secretResult)).not.toContain(secretCanary);
    expect(
      await store.secrets.getSecret({ botId: scout.id, shared: false }, "WEATHER_API_KEY"),
    ).toBe(secretCanary);

    // 2. Assistant invokes vault_request_login via WildBots MCP.
    const loginCall = callMcp(mcpServer, "vault_request_login", {
      origin: "https://weather.example.test",
      label: "Weather Portal",
      purpose: "Sign in to fetch hourly forecasts.",
    });

    let loginReqId = "";
    let loginSecure: { epoch: string; sessionId: string; origin?: string } | undefined;
    await until(async () => {
      const conv = (
        await app.inject({ url: `/api/bots/${scout.id}/conversation`, headers })
      ).json() as {
        activity: { state: string };
        attention: {
          id: string;
          secure?: { epoch: string; sessionId: string; method: string; origin?: string };
        }[];
      };
      const item = conv.attention.find((entry) => entry.secure?.method === "vault.save_login");
      if (conv.activity.state === "blocked" && item?.secure) {
        loginReqId = item.id;
        loginSecure = item.secure;
        return true;
      }
      return false;
    }, "blocked login attention item");

    const pwCanary = "weather-login-password-canary";
    const loginAnswer = await app.inject({
      method: "POST",
      url: `/api/bots/${scout.id}/secure-requests/${loginReqId}`,
      headers,
      payload: {
        epoch: loginSecure!.epoch,
        sessionId: loginSecure!.sessionId,
        method: "vault.save_login",
        identifier: "farmer@example.test",
        password: pwCanary,
        origin: loginSecure!.origin,
      },
    });
    expect(loginAnswer.statusCode).toBe(200);
    const loginResult = await loginCall;
    expect(loginResult.result?.isError).not.toBe(true);
    expect(JSON.stringify(loginResult)).not.toContain(pwCanary);

    // Overview lists both the saved login and the named secret without values.
    const vaultResp = await app.inject({ url: `/api/bots/${scout.id}/vault`, headers });
    expect(vaultResp.statusCode).toBe(200);
    const vaultJson = vaultResp.json();
    expect(vaultJson.items).toHaveLength(1);
    expect(vaultJson.items[0]).toMatchObject({
      label: "Weather Portal",
      origin: "https://weather.example.test",
      identifier: "farmer@example.test",
    });
    expect(vaultJson.secrets).toHaveLength(1);
    expect(vaultJson.secrets[0].name).toBe("WEATHER_API_KEY");
    expect(JSON.stringify(vaultJson)).not.toContain(secretCanary);
    expect(JSON.stringify(vaultJson)).not.toContain(pwCanary);

    claude.session.complete("All connected.");
  });
});
