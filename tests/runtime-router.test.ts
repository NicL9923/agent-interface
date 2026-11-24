import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { MainAssistants, ReconcileError } from "../src/server/main-assistant.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { createRuntimeRouter, hermesRuntimeId } from "../src/server/runtime-router.js";
import { isUnknownRoster, unknownRoster } from "../src/server/unknown-roster.js";
import { Store } from "../src/server/store.js";
import type { Bot, Runtime, RuntimeEvent } from "../src/shared/types.js";
import {
  capabilitiesFixture,
  conversationFixture,
  routineFixture,
} from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const bot = (id: string): Bot => ({ id, name: id, shared: true, model: "test", activity: "idle" });
const routine = (id: string, botId: string) => routineFixture({ id, botId, name: id });
// Every assistant runs on Hermes except barn, which runs on codex.
const routerOver = (hermes: Partial<Runtime>, codex: Partial<Runtime>) =>
  createRuntimeRouter({
    runtimes: { [hermesRuntimeId]: fakeRuntime(hermes), codex: fakeRuntime(codex) },
    defaultRuntime: hermesRuntimeId,
    runtimeOf: (botId) => (botId === "barn" ? "codex" : undefined),
  });

describe("runtime router", () => {
  it("sends each call that names an assistant to that assistant's runtime, with its arguments as given", async () => {
    const hermesConversation = vi.fn(async (botId: string) => conversationFixture({ botId }));
    const codexConversation = vi.fn(async (botId: string) => conversationFixture({ botId }));
    const submit = vi.fn<Runtime["submit"]>(async (input) => ({
      requestId: input.requestId,
      status: "accepted",
    }));
    const deleteRoutine = vi.fn<Runtime["deleteRoutine"]>(async () => {});
    const automationRequest = vi.fn(async () => ({ ok: true }));
    const router = routerOver(
      { conversation: hermesConversation },
      {
        conversation: codexConversation,
        submit,
        deleteRoutine,
        automationRequest: automationRequest as unknown as Runtime["automationRequest"],
      },
    );
    await router.conversation("barn", { history: false });
    await router.conversation("ranch");
    expect(codexConversation.mock.calls).toEqual([["barn", { history: false }]]);
    expect(hermesConversation.mock.calls).toEqual([["ranch"]]);
    const input = {
      requestId: "r1",
      botId: "barn",
      text: "Feed",
      attachments: [],
      senderId: "one",
    };
    await router.submit(input);
    expect(submit).toHaveBeenCalledWith(input);
    // The routine's assistant is the second argument.
    await router.deleteRoutine("morning", "barn");
    expect(deleteRoutine).toHaveBeenCalledWith("morning", "barn");
    await router.automationRequest!({ operation: "overview", profile: "barn" });
    expect(automationRequest).toHaveBeenCalledWith({ operation: "overview", profile: "barn" });
  });

  it("answers calls that name no assistant from the default runtime, and creates new assistants there", async () => {
    const saveBot = vi.fn<Runtime["saveBot"]>(async (input) => ({
      ...bot("new"),
      name: input.name,
    }));
    const router = routerOver(
      {
        status: async () => ({ connected: true, code: "ready" }),
        capabilities: async () => capabilitiesFixture({ steering: { supported: true } }),
        saveBot,
      },
      { capabilities: async () => capabilitiesFixture() },
    );
    expect(await router.status()).toEqual({ connected: true, code: "ready" });
    expect((await router.capabilities()).steering.supported).toBe(true);
    expect((await router.capabilities("barn")).steering.supported).toBe(false);
    await router.saveBot({ name: "New", instructions: "", model: "test", shared: true });
    expect(saveBot).toHaveBeenCalledWith({
      name: "New",
      instructions: "",
      model: "test",
      shared: true,
    });
  });

  it("refuses to start without its default runtime, and fails a call for an assistant on an unregistered one", async () => {
    expect(() =>
      createRuntimeRouter({
        runtimes: { codex: fakeRuntime({}) },
        defaultRuntime: hermesRuntimeId,
      }),
    ).toThrow("The default runtime hermes is not registered.");
    const router = createRuntimeRouter({
      runtimes: { [hermesRuntimeId]: fakeRuntime({}) },
      defaultRuntime: hermesRuntimeId,
      runtimeOf: () => "grok",
    });
    await expect(router.conversation("barn")).rejects.toThrow("No runtime is registered as grok.");
  });

  it("lists each assistant and routine once, from the runtime it runs on", async () => {
    // Hermes still lists barn, which has moved to codex.
    const router = routerOver(
      {
        listBots: async () => [bot("ranch"), bot("barn")],
        routines: async () => [routine("morning", "ranch"), routine("feed", "barn")],
      },
      {
        listBots: async () => [bot("barn")],
        routines: async () => [routine("feed", "barn")],
      },
    );
    expect((await router.listBots()).map((row) => row.id)).toEqual(["ranch", "barn"]);
    expect((await router.routines()).map((row) => `${row.botId}/${row.id}`)).toEqual([
      "ranch/morning",
      "barn/feed",
    ]);
    // Naming the assistant asks only its runtime.
    expect((await router.routines("barn")).map((row) => `${row.botId}/${row.id}`)).toEqual([
      "barn/feed",
    ]);
  });

  // A runtime that has had no roster yet says nothing about who is on it, so neither does the whole
  // answer. Bootstrap reads that through the router, which builds a new list, so the router must say it.
  it("says the roster is unknown when one runtime does not know its own, and bootstrap says so too", async () => {
    let hermesRows: () => Bot[] = () => unknownRoster([]);
    const router = routerOver(
      {
        listBots: async () => hermesRows(),
        capabilities: async () => capabilitiesFixture(),
        status: async () => ({ connected: true }),
        close: async () => {},
      },
      { listBots: async () => [bot("barn")], close: async () => {} },
    );
    const listed = await router.listBots();
    expect(listed.map((row) => row.id)).toEqual(["barn"]);
    expect(isUnknownRoster(listed)).toBe(true);
    const { app } = await createApp(
      loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }),
      router,
      { background: false },
    );
    try {
      const headers = await localLogin(app, "http://127.0.0.1:3000");
      expect((await app.inject({ url: "/api/bootstrap", headers })).json()).toMatchObject({
        rosterUnknown: true,
      });
      hermesRows = () => [bot("ranch")];
      expect(isUnknownRoster(await router.listBots())).toBe(false);
      expect((await app.inject({ url: "/api/bootstrap", headers })).json()).toMatchObject({
        rosterUnknown: false,
      });
    } finally {
      await app.close();
    }
  });

  it("fails the roster and the routine inventory only when every runtime fails, with the first runtime's error", async () => {
    const router = routerOver(
      {
        listBots: async () => {
          throw new Error("Hermes roster is unreachable");
        },
        routines: async () => {
          throw new Error("Hermes is unreachable");
        },
      },
      {
        listBots: async () => {
          throw new Error("Codex roster is unreachable");
        },
        routines: async () => {
          throw new Error("Codex is unreachable");
        },
      },
    );
    await expect(router.listBots()).rejects.toThrow("Hermes roster is unreachable");
    await expect(router.routines()).rejects.toThrow("Hermes is unreachable");
  });

  it("undoes every watcher already registered when a later runtime refuses its own", () => {
    const stopHermes = vi.fn();
    const router = routerOver(
      { watchRoster: () => stopHermes },
      {
        watchRoster: () => {
          throw new Error("Codex refused the watcher");
        },
      },
    );
    expect(() => router.watchRoster!(() => {})).toThrow("Codex refused the watcher");
    expect(stopHermes).toHaveBeenCalled();
  });

  it("tries every stop when one throws, then reports the first failure", () => {
    const stopCodex = vi.fn();
    const router = routerOver(
      {
        watchTurns: () => () => {
          throw new Error("Hermes stop failed");
        },
      },
      { watchTurns: () => stopCodex },
    );
    const stop = router.watchTurns!({ changed: () => {}, disconnected: () => {} } as never);
    expect(stop).toThrow("Hermes stop failed");
    expect(stopCodex).toHaveBeenCalled();
  });

  it("offers an optional member while any runtime has it, and refuses it for an assistant whose runtime lacks it", async () => {
    const inferenceSettings = vi.fn(async () => ({ reasoning: "high", speed: "default" }) as never);
    const codex = fakeRuntime({});
    const router = createRuntimeRouter({
      runtimes: {
        [hermesRuntimeId]: fakeRuntime({ inferenceSettings, watch: () => () => {} }),
        codex,
      },
      defaultRuntime: hermesRuntimeId,
      runtimeOf: (botId) => (botId === "barn" ? "codex" : undefined),
    });
    // Absent everywhere, so a call site's own check answers as it does for one runtime.
    expect(router.setVoice).toBeUndefined();
    await router.inferenceSettings!("ranch");
    expect(inferenceSettings).toHaveBeenCalledWith("ranch");
    await expect(router.inferenceSettings!("barn")).rejects.toMatchObject({
      statusCode: 409,
      message: "This assistant's runtime doesn't support this yet.",
    });
    // Watchers on a runtime without them never fire, and stop cleanly.
    expect(
      router.watch!("barn", () => {
        throw new Error("A runtime without watch fired a change.");
      }),
    ).toBeTypeOf("function");
    // A runtime that gains a member later is seen.
    const setVoice = vi.fn<NonNullable<Runtime["setVoice"]>>(async () => {});
    codex.setVoice = setVoice;
    await router.setVoice!("barn", "cedar");
    expect(setVoice).toHaveBeenCalledWith("barn", "cedar");
  });

  it("looks a receipt up on the assistant's runtime, or on every runtime when nobody knows the assistant", async () => {
    const hermesLookup = vi.fn<Runtime["lookupSubmission"]>(async () => {
      throw new Error("Hermes is unreachable");
    });
    const codexLookup = vi.fn<Runtime["lookupSubmission"]>(async (requestId) => ({
      requestId,
      status: "accepted",
    }));
    const router = routerOver(
      { lookupSubmission: hermesLookup },
      { lookupSubmission: codexLookup },
    );
    expect(await router.lookupSubmission("r1", "barn")).toEqual({
      requestId: "r1",
      status: "accepted",
    });
    expect(hermesLookup).not.toHaveBeenCalled();
    // One runtime's failure does not hide another's receipt.
    expect(await router.lookupSubmission("r2")).toEqual({ requestId: "r2", status: "accepted" });
    codexLookup.mockResolvedValue(null);
    // With no receipt anywhere, a failure means nobody can say, so it is not reported as none.
    await expect(router.lookupSubmission("r3")).rejects.toThrow("Hermes is unreachable");
    hermesLookup.mockResolvedValue(null);
    expect(await router.lookupSubmission("r4")).toBeNull();
  });

  it("downloads a file from the runtime its signature names, and sends an ID nobody signed to the default", async () => {
    const file = { name: "a.txt", mime: "text/plain", body: new ReadableStream<Uint8Array>() };
    const hermesDownload = vi.fn<Runtime["download"]>(async () => {
      throw new Error("Unsigned file");
    });
    const codexDownload = vi.fn<Runtime["download"]>(async () => file);
    const router = routerOver(
      { download: hermesDownload, fileBotId: () => undefined },
      {
        download: codexDownload,
        fileBotId: (id) => (id === "signed-by-codex" ? "barn" : undefined),
      },
    );
    expect(router.fileBotId!("signed-by-codex")).toBe("barn");
    expect(await router.download("signed-by-codex", 10)).toBe(file);
    expect(codexDownload).toHaveBeenCalledWith("signed-by-codex", 10);
    await expect(router.download("forged", 10)).rejects.toThrow("Unsigned file");
  });

  it("falls back to a runtime that owns a migrated bot's historical file ID", async () => {
    const portrait = {
      name: "tars.jpg",
      mime: "image/jpeg",
      body: new ReadableStream<Uint8Array>(),
    };
    const hermesDownload = vi.fn<Runtime["download"]>(async () => portrait);
    const codexDownload = vi.fn<Runtime["download"]>(async () => {
      throw new Error("File not found");
    });
    const router = routerOver(
      {
        download: hermesDownload,
        fileBotId: (id) =>
          id === "legacy-portrait" ? "barn" : id === "legacy-ranch" ? "ranch" : undefined,
      },
      {
        download: codexDownload,
        fileBotId: () => undefined,
      },
    );
    expect(await router.download("legacy-portrait", 1024, "barn")).toBe(portrait);
    expect(hermesDownload).toHaveBeenCalledWith("legacy-portrait", 1024, "barn");
    expect(codexDownload).not.toHaveBeenCalled();
    await expect(router.download("legacy-ranch", 1024, "barn")).rejects.toThrow("File not found");
  });

  it("reads each runtime's events from its own source, and fails one without durable events", async () => {
    const event = (id: string, botId: string): RuntimeEvent => ({
      id,
      botId,
      kind: "completed",
      title: id,
      occurredAt: "2026-11-14T00:00:00Z",
    });
    const router = routerOver(
      {
        capabilities: async () => capabilitiesFixture({ durableEvents: { supported: true } }),
        discoverEvents: async (cursor) => ({
          cursor: `${cursor}+h`,
          events: [event("h", "ranch")],
        }),
      },
      {
        capabilities: async () =>
          capabilitiesFixture({
            durableEvents: { supported: false, reason: "Codex keeps no event log." },
          }),
      },
    );
    expect(router.eventSources!()).toEqual([hermesRuntimeId, "codex"]);
    expect(await router.discoverEvents("7", hermesRuntimeId)).toEqual({
      cursor: "7+h",
      events: [event("h", "ranch")],
    });
    await expect(router.discoverEvents("", "codex")).rejects.toThrow("Codex keeps no event log.");
  });
});

describe("background discovery over several runtimes", () => {
  it("keeps each runtime's cursor, and lets one runtime's failure hold up no other's events", async () => {
    const store = new Store(":memory:");
    const discovered = vi.fn<Runtime["discoverEvents"]>(async (cursor) => ({
      cursor: "codex-2",
      events:
        cursor === "codex-1"
          ? [
              {
                id: "barn-done",
                botId: "barn",
                kind: "completed",
                title: "Fed",
                occurredAt: "2026-11-14T00:00:00Z",
              },
            ]
          : [],
    }));
    const durable = async () => capabilitiesFixture({ durableEvents: { supported: true } });
    const router = routerOver(
      {
        capabilities: durable,
        discoverEvents: async () => {
          throw new Error("Hermes is unreachable");
        },
      },
      { capabilities: durable, discoverEvents: discovered, listBots: async () => [bot("barn")] },
    );
    store.recordEvents([], "hermes-9");
    store.recordEvents([], "codex-1", "codex");
    const worker = new BackgroundWorker(store, router, loadConfig({}));
    try {
      await worker.tick();
      expect(discovered).toHaveBeenCalledWith("codex-1");
      expect([store.cursor(), store.cursor("codex")]).toEqual(["hermes-9", "codex-2"]);
      // Another runtime's event IDs carry its ID, so none can take a Hermes event's row.
      expect(store.db.prepare("SELECT id FROM notification_events").all()).toEqual([
        { id: "codex:barn-done" },
      ]);
    } finally {
      await worker.stop();
      store.close();
    }
  });
});

describe("background discovery when the default runtime has no durable events", () => {
  it("still reads every other runtime's events", async () => {
    const store = new Store(":memory:");
    const discovered = vi.fn<Runtime["discoverEvents"]>(async () => ({
      cursor: "codex-2",
      events: [],
    }));
    // Hermes, disconnected, says durable events are unavailable. Reaching its discoverEvents fails the test.
    const router = routerOver(
      {
        capabilities: async () =>
          capabilitiesFixture({
            durableEvents: { supported: false, reason: "Hermes is disconnected." },
          }),
      },
      {
        capabilities: async () => capabilitiesFixture({ durableEvents: { supported: true } }),
        discoverEvents: discovered,
      },
    );
    store.recordEvents([], "hermes-9");
    store.recordEvents([], "codex-1", "codex");
    const worker = new BackgroundWorker(store, router, loadConfig({}));
    try {
      await worker.tick();
      expect(discovered).toHaveBeenCalledWith("codex-1");
      expect([store.cursor(), store.cursor("codex")]).toEqual(["hermes-9", "codex-2"]);
    } finally {
      await worker.stop();
      store.close();
    }
  });
});

describe("background discovery from a lone runtime", () => {
  it("asks that runtime whether it has durable events, and reads none when it says no", async () => {
    const store = new Store(":memory:");
    store.recordEvents([], "hermes-9");
    const discoverEvents = vi.fn<Runtime["discoverEvents"]>(async () => ({
      cursor: "hermes-10",
      events: [],
    }));
    const worker = new BackgroundWorker(
      store,
      fakeRuntime({
        discoverEvents,
        capabilities: async () =>
          capabilitiesFixture({
            durableEvents: { supported: false, reason: "This Hermes keeps no event journal." },
          }),
      }),
      loadConfig({}),
    );
    try {
      await worker.tick();
      expect(discoverEvents).not.toHaveBeenCalled();
      expect([store.cursor(), worker.discovery.lastError]).toEqual([
        "hermes-9",
        "This Hermes keeps no event journal.",
      ]);
    } finally {
      await worker.stop();
      store.close();
    }
  });
});

describe("reconciling over several runtimes", () => {
  it("removes no tracked check-in while one runtime's routines cannot be read", async () => {
    const store = new Store(":memory:");
    const router = routerOver(
      {
        status: async () => ({ connected: true, code: "ready" }),
        capabilities: async () => capabilitiesFixture({ routines: { supported: true } }),
        listBots: async () => [bot("ranch")],
        routines: async () => [],
      },
      {
        listBots: async () => [bot("barn")],
        routines: async () => {
          throw new Error("Codex is unreachable");
        },
      },
    );
    store.user({ id: "mom", name: "Mom", email: "mom@example.test" });
    store.checkIns.track({ botId: "barn", jobId: "job1", userId: "mom" });
    try {
      const failed = await new MainAssistants(router, store, loadConfig({})).reconcile().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(ReconcileError);
      expect((failed as ReconcileError).whole).toBe(true);
      expect(store.checkIns.current()).toEqual([{ botId: "barn", jobId: "job1", userId: "mom" }]);
    } finally {
      store.close();
    }
  });
});

describe("capabilities checked per assistant", () => {
  const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("refuses steering only for an assistant whose runtime cannot steer", async () => {
    const steer = vi.fn<Runtime["steer"]>(async (input) => ({
      requestId: input.requestId,
      status: "accepted",
    }));
    const common = (botId: string) => ({
      listBots: async () => [bot(botId)],
      close: async () => {},
      conversation: async () => conversationFixture({ botId, activity: { state: "working" } }),
    });
    const router = routerOver(
      {
        ...common("ranch"),
        steer,
        status: async () => ({ connected: true, code: "ready" }),
        capabilities: async () =>
          capabilitiesFixture({ chat: { supported: true }, steering: { supported: true } }),
      },
      {
        ...common("barn"),
        // No steer: reaching it fails the test.
        capabilities: async () =>
          capabilitiesFixture({
            chat: { supported: true },
            steering: {
              supported: false,
              reason: "Barn's runtime starts your message after this reply.",
            },
          }),
      },
    );
    const { app } = await createApp(
      loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }),
      router,
      { background: false },
    );
    apps.push(app);
    const headers = await localLogin(app, "http://127.0.0.1:3000");
    const steerOn = (botId: string) =>
      app.inject({
        method: "POST",
        url: `/api/bots/${botId}/steer`,
        headers,
        payload: { requestId: crypto.randomUUID(), text: "Also the gate" },
      });
    const refused = await steerOn("barn");
    expect([refused.statusCode, refused.json().error]).toEqual([
      409,
      "Barn's runtime starts your message after this reply.",
    ]);
    const steered = await steerOn("ranch");
    expect([steered.statusCode, steered.json().status]).toEqual([200, "accepted"]);
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "ranch", text: "Also the gate" }),
    );
  });
});
