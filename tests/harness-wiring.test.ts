import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type {
  HarnessDriver,
  HarnessDriverId,
  HarnessProbeResult,
} from "../src/server/harness/driver.js";
import { createCompositeRuntime } from "../src/server/harness/wiring.js";
import { fileSigner } from "../src/server/hermes-files.js";
import { Store } from "../src/server/store.js";
import { fakeRuntime } from "./helpers/fake-runtime.js";
import {
  botFixture,
  capabilitiesFixture,
  conversationFixture,
} from "./helpers/runtime-fixtures.js";
import { localLogin } from "./helpers/server.js";

/** A native harness that only answers probes. Opening a session means the test routed a turn it should not have. */
class ProbeOnlyDriver implements HarnessDriver {
  readonly displayName: string;
  readonly capabilities = {
    nativeSteering: false,
    resumable: true,
    supportsMcp: true,
    supportsImages: true,
    supportsReasoning: true,
    supportsSpeed: false,
  };
  probes = 0;
  result: HarnessProbeResult | Error = { available: true, version: "1.0.0" };

  constructor(readonly id: HarnessDriverId) {
    this.displayName = id;
  }

  async probe() {
    this.probes += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  async listModels() {
    return [];
  }

  async openSession(): Promise<never> {
    throw new Error(`ProbeOnlyDriver ${this.id} was asked to open a session.`);
  }
}

const origin = "http://127.0.0.1:3000";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** With `appOwnsStore`, the test hands the store to `createApp`, whose `close()` closes it and the runtime. */
async function setup(hermesMembers: Parameters<typeof fakeRuntime>[0] = {}, appOwnsStore = false) {
  const directory = await mkdtemp(join(tmpdir(), "harness-wiring-"));
  const store = new Store(":memory:");
  cleanups.push(async () => {
    if (!appOwnsStore) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const codex = new ProbeOnlyDriver("codex");
  const grok = new ProbeOnlyDriver("grok");
  let clock = 1_000;
  const compose = () => {
    const composite = createCompositeRuntime({
      store,
      hermes: fakeRuntime({ close: async () => {}, ...hermesMembers }),
      drivers: { codex, grok },
      workspaceRoot: join(directory, "sandbox"),
      files: fileSigner(store.fileKeys(), undefined),
      probeTtlMs: 30_000,
      now: () => clock,
    });
    if (!appOwnsStore) cleanups.push(() => composite.runtime.close());
    return composite;
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { store, codex, grok, compose, advance };
}

/** A personal Codex assistant owned by `ownerId`, saved through the native runtime the way the app saves one. */
async function nativeBot(
  store: Store,
  harnessRuntime: ReturnType<typeof createCompositeRuntime>["harnessRuntime"],
  ownerId: string,
) {
  store.user({ id: ownerId, name: ownerId, email: `${ownerId}@example.invalid` });
  store.managedBots.upsertCredential({
    id: "codex-subscription",
    label: "Codex",
    kind: "subscription",
    vendor: "openai",
    ownerId,
    osUser: userInfo().username,
    allowedHarnesses: ["codex"],
  });
  return harnessRuntime.saveBot({
    name: "Planner",
    instructions: "Plan the work.",
    model: "model-1",
    shared: false,
    harness: "codex",
    ownerId,
    credentialId: "codex-subscription",
  });
}

function claim(store: Store, botId: string, requestId: string, runId: string) {
  store.queue.enqueue({ botId, requestId, senderId: "sam", senderName: "Sam", text: requestId });
  return store.queue.claimNext(botId, runId);
}

describe("createCompositeRuntime startup", () => {
  it("interrupts a running row no runtime recovers, so the next message on that queue can start", async () => {
    const { store, compose } = await setup();
    expect(claim(store, "barn", "crashed", "crashed-run")).toMatchObject({ status: "running" });
    store.queue.enqueue({
      botId: "barn",
      requestId: "next",
      senderId: "sam",
      senderName: "Sam",
      text: "next",
    });
    // Before the sweep, the crashed row holds the queue shut.
    expect(store.queue.claimNext("barn", "blocked-run")).toBeUndefined();

    const { sweptQueueItems } = compose();

    expect(sweptQueueItems).toBe(1);
    expect(store.queue.list("barn", { includeSettled: true })).toMatchObject([
      { requestId: "crashed", status: "interrupted" },
      { requestId: "next", status: "queued" },
    ]);
    expect(store.queue.claimNext("barn", "next-run")).toMatchObject({
      requestId: "next",
      status: "running",
    });
  });

  it("leaves a native assistant's crashed row to the harness runtime, which records why it stopped", async () => {
    const { store, compose } = await setup();
    const first = compose();
    const planner = await nativeBot(store, first.harnessRuntime, "sam");
    await first.runtime.close();
    claim(store, planner.id, "orphaned", "orphaned-run");

    const restarted = compose();

    // The runtime settled it from its own records, so the sweep found nothing left running.
    expect(restarted.sweptQueueItems).toBe(0);
    expect(await restarted.harnessRuntime.lookupSubmission("orphaned")).toMatchObject({
      status: "interrupted",
      runId: "orphaned-run",
    });
    expect((await restarted.harnessRuntime.discoverEvents("")).events).toEqual([
      expect.objectContaining({ kind: "interrupted", runId: "orphaned-run" }),
    ]);
  });
});

describe("createCompositeRuntime routing", () => {
  it("lists Hermes and native assistants on /bots and sends each assistant's calls to its own runtime", async () => {
    const conversation = vi.fn(async (botId: string) => conversationFixture({ botId }));
    const { store, compose } = await setup(
      {
        status: async () => ({ connected: true }),
        capabilities: async () => capabilitiesFixture(),
        listBots: async () => [botFixture({ id: "barn", name: "Barn" })],
        conversation,
      },
      true,
    );
    const { runtime, harnessRuntime } = compose();
    const { app } = await createApp(
      loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }),
      runtime,
      { store, background: false },
    );
    cleanups.push(() => app.close());
    const headers = await localLogin(app, origin);
    const planner = await nativeBot(store, harnessRuntime, "local-one");

    const roster = await app.inject({ url: "/api/bots", headers });
    expect(roster.statusCode).toBe(200);
    expect(
      (roster.json() as { id: string; harness?: string }[]).map(({ id, harness }) => ({
        id,
        harness,
      })),
    ).toEqual([
      { id: "barn", harness: "hermes" },
      { id: planner.id, harness: "codex" },
    ]);

    const hermesChat = await app.inject({ url: "/api/bots/barn/conversation", headers });
    expect(hermesChat.statusCode).toBe(200);
    const nativeChat = await app.inject({ url: `/api/bots/${planner.id}/conversation`, headers });
    expect(nativeChat.statusCode).toBe(200);
    expect(nativeChat.json()).toMatchObject({ botId: planner.id, messages: [] });
    // Hermes heard only about its own assistant.
    expect(conversation.mock.calls.map(([botId]) => botId)).toEqual(["barn"]);
  });
});

describe("createCompositeRuntime probeHarnesses", () => {
  it("probes each registered harness once per cache window, sharing one round between concurrent reads", async () => {
    const { codex, grok, compose, advance } = await setup();
    grok.result = { available: false, reason: "Grok is not signed in." };
    const { probeHarnesses } = compose();

    const [first, concurrent] = await Promise.all([probeHarnesses(), probeHarnesses()]);
    expect(first).toEqual([
      { id: "codex", available: true, reason: undefined },
      { id: "grok", available: false, reason: "Grok is not signed in." },
    ]);
    expect(concurrent).toEqual(first);
    expect([codex.probes, grok.probes]).toEqual([1, 1]);

    advance(29_999);
    await probeHarnesses();
    expect([codex.probes, grok.probes]).toEqual([1, 1]);

    grok.result = { available: true };
    advance(1);
    expect(await probeHarnesses()).toEqual([
      { id: "codex", available: true, reason: undefined },
      { id: "grok", available: true, reason: undefined },
    ]);
    expect([codex.probes, grok.probes]).toEqual([2, 2]);
  });

  it("reports a probe that throws as unavailable instead of failing the read", async () => {
    const { codex, compose } = await setup();
    codex.result = new Error("spawn EACCES");
    const { probeHarnesses } = compose();

    await expect(probeHarnesses()).resolves.toEqual([
      { id: "codex", available: false, reason: "The harness probe failed." },
      { id: "grok", available: true, reason: undefined },
    ]);
  });
});
