import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Conflict } from "../src/shared/errors.js";
import { agentEnvelope, type GroupPage } from "../src/shared/collaboration.js";
import { scheduledPost } from "../src/shared/group-activity.js";
import type {
  HarnessDriver,
  HarnessEvent,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTurnInput,
} from "../src/server/harness/driver.js";
import { createHarnessRuntime } from "../src/server/harness/runtime.js";
import { fileSigner } from "../src/server/file-signer.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { managedConfig } from "../src/server/main-assistant.js";
import { Store } from "../src/server/store.js";
import { signIn } from "./helpers/server.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class StubSession implements HarnessSession {
  private listener?: (event: HarnessEvent) => void;
  readonly providerSessionId: string;
  constructor(
    readonly id: string,
    private readonly reply: (input: HarnessTurnInput) => string,
  ) {
    this.providerSessionId = `provider-${id}`;
  }
  events(listener: (event: HarnessEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async startTurn(input: HarnessTurnInput) {
    this.listener?.({ type: "turn.started", turnId: input.turnId });
    const text = this.reply(input);
    this.listener?.({ type: "text.delta", turnId: input.turnId, delta: text });
    this.listener?.({ type: "turn.completed", turnId: input.turnId, text });
  }
  async answerQuestion() {}
  async interrupt() {}
  async close() {}
}

class StubDriver implements HarnessDriver {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly capabilities = {
    nativeSteering: false,
    resumable: true,
    supportsMcp: true,
    supportsImages: false,
    supportsReasoning: false,
    supportsSpeed: false,
  };
  readonly specs: HarnessSessionSpec[] = [];
  nextReply: (spec: HarnessSessionSpec, input: HarnessTurnInput) => string = () => "ok";

  async probe() {
    return { available: true };
  }
  async listModels() {
    return [
      {
        id: "openai",
        name: "OpenAI",
        authenticated: true,
        models: [{ id: "gpt-5.4", name: "GPT-5.4", available: true }],
      },
    ];
  }
  async openSession(spec: HarnessSessionSpec) {
    this.specs.push(spec);
    return new StubSession(spec.sessionKey, (input) => this.nextReply(spec, input));
  }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "wildbots-native-delegation-"));
  const store = new Store(join(dir, "app.sqlite"));
  store.user({ id: "local-one", email: "one@localhost.invalid", name: "Alice" });
  store.user({ id: "local-two", email: "two@localhost.invalid", name: "Bob" });
  store.managedBots.upsertCredential({
    id: "cred-1",
    label: "API key",
    kind: "api_key",
    vendor: "openai",
    envVar: "TEST_OPENAI_KEY",
    allowedHarnesses: ["codex"],
  });
  process.env.TEST_OPENAI_KEY = "test-key";
  const driver = new StubDriver();
  const runtime = createHarnessRuntime({
    store,
    drivers: { codex: driver },
    workspaceRoot: join(dir, "harness"),
    files: fileSigner(store.fileKeys()),
  });

  const makeBot = (id: string, name: string, shared: boolean, ownerId: string) =>
    store.managedBots.upsertManagedBot({
      id,
      name,
      description: `${name} helper`,
      instructions: `You are ${name}.`,
      harness: "codex",
      model: "gpt-5.4",
      provider: "openai",
      reasoning: "",
      speed: "",
      ownerId,
      ownerOsUser: "",
      shared,
      credentialId: "cred-1",
      enabledTools: [],
      enabledSkills: [],
      enabledMcpServers: ["wildbots"],
      createdAt: 1,
      updatedAt: 1,
    });

  makeBot("alice-main", "Alice Main", false, "local-one");
  makeBot("alice-side", "Alice Side", false, "local-one");
  makeBot("bob-private", "Bob Private", false, "local-two");
  makeBot("shared-ops", "Shared Ops", true, "local-one");

  cleanups.push(async () => {
    delete process.env.TEST_OPENAI_KEY;
    await runtime.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, runtime, driver, dir };
}

describe("native delegation policy, main assistant check-ins, and routine group delivery", () => {
  it("enforces delegationPolicy v2, injects roster into system prompt, and delivers agent-envelope handoffs", async () => {
    const { runtime, driver } = await setup();

    const enforced = await runtime.delegationPolicy({
      "alice-main": {
        member: "Alice",
        main: true,
        owned: true,
        personal: [{ id: "alice-side", name: "Alice Side", description: "Alice Side helper" }],
        shared: [{ id: "shared-ops", name: "Shared Ops", description: "Shared Ops helper" }],
      },
      "bob-private": {
        member: "Bob",
        main: false,
        owned: true,
        personal: [],
        shared: [{ id: "shared-ops", name: "Shared Ops" }],
      },
    });
    expect(enforced).toBe(2);

    // Refuses handoff to an assistant outside the active policy (e.g. Bob's private bot).
    await expect(
      runtime.deliverBotMessage({
        sourceBotId: "alice-main",
        targetBotId: "bob-private",
        message: "secret peek",
      }),
    ).rejects.toThrow(Conflict);

    // Allowed handoff enqueues and formats as an agentEnvelope message without human sender.
    driver.nextReply = () => "Handled by Alice Side";
    await runtime.deliverBotMessage({
      sourceBotId: "alice-main",
      targetBotId: "alice-side",
      message: "Please check the calendar.",
    });

    // Wait for drain to finish the turn.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const convo = await runtime.conversation("alice-side");
    const userMsg = convo.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg?.sender).toBeUndefined();
    expect(agentEnvelope(userMsg!)).toEqual({
      name: "Alice Main",
      handle: "alice-main",
      text: "Please check the calendar.",
    });

    // Verify main assistant system prompt includes roster guidance.
    await runtime.submit({
      requestId: "req-main-prompt",
      botId: "alice-main",
      senderId: "local-one",
      text: "hello",
      attachments: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const mainSpec = driver.specs.find((s) => s.botId === "alice-main");
    expect(mainSpec?.systemPrompt).toContain("# Household assistants");
    expect(mainSpec?.systemPrompt).toContain("Alice's main assistant");
    expect(mainSpec?.systemPrompt).toContain("`alice-side` (Alice Side)");
    expect(mainSpec?.systemPrompt).toContain("`shared-ops` (Shared Ops)");
  });

  it("activates a Main Assistant and creates managed check-ins natively through the HTTP API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wildbots-main-http-"));
    const store = new Store(join(dir, "app.sqlite"));
    store.user({ id: "local-one", email: "one@localhost.invalid", name: "Alice" });
    store.managedBots.upsertCredential({
      id: "cred-1",
      label: "API key",
      kind: "api_key",
      vendor: "openai",
      envVar: "TEST_OPENAI_KEY",
      allowedHarnesses: ["codex"],
    });
    process.env.TEST_OPENAI_KEY = "test-key";
    store.managedBots.upsertManagedBot({
      id: "alice-main",
      name: "Alice Main",
      description: "",
      instructions: "You are Alice Main.",
      harness: "codex",
      model: "gpt-5.4",
      provider: "openai",
      reasoning: "",
      speed: "",
      ownerId: "local-one",
      ownerOsUser: "",
      shared: false,
      credentialId: "cred-1",
      enabledTools: [],
      enabledSkills: [],
      enabledMcpServers: ["wildbots"],
      createdAt: 1,
      updatedAt: 1,
    });
    const runtime = createHarnessRuntime({
      store,
      drivers: { codex: new StubDriver() },
      workspaceRoot: join(dir, "harness"),
      files: fileSigner(store.fileKeys()),
    });
    const config = loadConfig({
      LOCAL_DEV_AUTH: "true",
      APP_ORIGIN: "http://127.0.0.1:3000",
      APP_DATABASE: ":memory:",
    });
    const { app } = await createApp(config, runtime, { store, background: false });
    cleanups.push(async () => {
      delete process.env.TEST_OPENAI_KEY;
      await app.close();
      await rm(dir, { recursive: true, force: true });
    });
    const alice = signIn(store, "http://127.0.0.1:3000", "local-one");

    const setMain = await app.inject({
      method: "PUT",
      url: "/api/preferences/main",
      headers: alice,
      payload: { botId: "alice-main" },
    });
    expect(setMain.statusCode).toBe(200);

    const setCheckIns = await app.inject({
      method: "PUT",
      url: "/api/preferences/check-ins",
      headers: alice,
      payload: { enabled: true, everyHours: 2, timezone: "America/Chicago" },
    });
    expect(setCheckIns.statusCode).toBe(200);

    const routines = await runtime.routines("alice-main");
    expect(routines).toHaveLength(1);
    expect(routines[0].name).toBe("Check-ins");
    expect(managedConfig(routines[0])).toBe(true);
  });

  it("delivers routine output to target group chats as scheduledPost events and triggers @mentioned members", async () => {
    const { store, runtime, driver } = await setup();
    await runtime.groupRequest({
      operation: "create",
      roomId: "ops-room",
      name: "Ops Sync",
      members: [
        {
          member_id: "shared-ops",
          profile: "shared-ops",
          handle: "shared-ops",
          display_name: "Shared Ops",
        },
        {
          member_id: "alice-side",
          profile: "alice-side",
          handle: "alice-side",
          display_name: "Alice Side",
        },
      ],
      actorId: "local-one",
    });

    const saved = await runtime.saveRoutine({
      botId: "shared-ops",
      name: "Morning Digest",
      prompt: "Summarize ops.",
      schedule: "every 1h",
      enabled: true,
      roomIds: ["ops-room"],
    });
    expect(saved.roomIds).toEqual(["ops-room"]);
    expect(saved.delivery?.deliver).toBe("bot-chat:shared-ops,room:ops-room");

    // Simulate the scheduler running and delivering a message mentioning @alice-side.
    driver.nextReply = (_spec, input) =>
      input.text.includes("Morning Digest") || input.text.includes("Summarize ops")
        ? "All systems nominal. @alice-side please review the checklist."
        : "Reviewed the checklist!";

    // Mark the routine due with missed_policy='run_once' so the scheduler catches up immediately on start.
    store.db
      .prepare("UPDATE native_routines SET next_run_at=?, missed_policy='run_once' WHERE id=?")
      .run(Date.now() - 1000, saved.id);
    const dir2 = await mkdtemp(join(tmpdir(), "wildbots-sched-"));
    const runtime2 = createHarnessRuntime({
      store,
      drivers: { codex: driver },
      workspaceRoot: dir2,
      files: fileSigner(store.fileKeys()),
      startScheduler: true,
    });
    cleanups.push(async () => {
      await runtime2.close();
      await rm(dir2, { recursive: true, force: true });
    });

    // Wait for routine execution + group mention reply to settle.
    let page: GroupPage = { events: [], cursor: 0, latest_seq: 0, has_more: false };
    for (let i = 0; i < 60; i++) {
      page = (await runtime2.groupRequest({
        operation: "log",
        roomId: "ops-room",
        since: 0,
      })) as GroupPage;
      if (page.events.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(page.events.length).toBeGreaterThanOrEqual(2);
    expect(scheduledPost(page.events[0])).toEqual({ name: "Morning Digest", failed: false });
    expect(page.events[0].payload.text).toContain("All systems nominal.");
    expect(page.events[1]).toMatchObject({
      kind: "message.member",
      actor: { id: "alice-side" },
      payload: { text: "Reviewed the checklist!" },
    });
  });
});
