import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { completeRoster, Roster, rosterBot } from "../src/server/bot-access.js";
import { loadConfig } from "../src/server/config.js";
import { LiveActivities, type LiveActivitySender, type LiveState } from "../src/server/live-activity.js";
import { MainAssistants, ReconcileError } from "../src/server/main-assistant.js";
import { BackgroundWorker } from "../src/server/notifications.js";
import { assertRoutinesStayPrivate } from "../src/server/routine-delivery.js";
import { createRuntimeRouter, hermesRuntimeId } from "../src/server/runtime-router.js";
import { runtimeSnapshots } from "../src/server/runtime-snapshot.js";
import { Store } from "../src/server/store.js";
import type { GroupRoom } from "../src/shared/collaboration.js";
import { defaultPreferences, type ActivityState, type Bot, type BotListing, type Runtime, type RuntimeEvent } from "../src/shared/types.js";
import { capabilitiesFixture, conversationFixture, routineFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const bot = (id: string): Bot => ({ id, name: id, shared: true, model: "test", activity: "idle" });
const routine = (id: string, botId: string) => routineFixture({ id, botId, name: id });
// Every assistant runs on Hermes except barn, which runs on codex.
const routerOver = (hermes: Partial<Runtime>, codex: Partial<Runtime>) => createRuntimeRouter({
  runtimes: { [hermesRuntimeId]: fakeRuntime(hermes), codex: fakeRuntime(codex) },
  defaultRuntime: hermesRuntimeId,
  runtimeOf: botId => botId === "barn" ? "codex" : undefined,
});

describe("runtime router", () => {
  it("sends each call that names an assistant to that assistant's runtime, with its arguments as given", async () => {
    const hermesConversation = vi.fn(async (botId: string) => conversationFixture({ botId }));
    const codexConversation = vi.fn(async (botId: string) => conversationFixture({ botId }));
    const submit = vi.fn<Runtime["submit"]>(async input => ({ requestId: input.requestId, status: "accepted" }));
    const deleteRoutine = vi.fn<Runtime["deleteRoutine"]>(async () => {});
    const automationRequest = vi.fn(async () => ({ ok: true }));
    const router = routerOver({ conversation: hermesConversation }, { conversation: codexConversation, submit, deleteRoutine,
      automationRequest: automationRequest as unknown as Runtime["automationRequest"] });
    await router.conversation("barn", { history: false });
    await router.conversation("ranch");
    expect(codexConversation.mock.calls).toEqual([["barn", { history: false }]]);
    expect(hermesConversation.mock.calls).toEqual([["ranch"]]);
    const input = { requestId: "r1", botId: "barn", text: "Feed", attachments: [], senderId: "one" };
    await router.submit(input);
    expect(submit).toHaveBeenCalledWith(input);
    // The routine's assistant is the second argument.
    await router.deleteRoutine("morning", "barn");
    expect(deleteRoutine).toHaveBeenCalledWith("morning", "barn");
    await router.automationRequest!({ operation: "overview", profile: "barn" });
    expect(automationRequest).toHaveBeenCalledWith({ operation: "overview", profile: "barn" });
  });

  it("answers calls that name no assistant from the default runtime, and creates new assistants there", async () => {
    const saveBot = vi.fn<Runtime["saveBot"]>(async input => ({ ...bot("new"), name: input.name }));
    const router = routerOver({
      status: async () => ({ connected: true, code: "ready" }),
      capabilities: async () => capabilitiesFixture({ steering: { supported: true } }),
      saveBot,
    }, { capabilities: async () => capabilitiesFixture() });
    expect(await router.status()).toEqual({ connected: true, code: "ready" });
    expect((await router.capabilities()).steering.supported).toBe(true);
    expect((await router.capabilities("barn")).steering.supported).toBe(false);
    await router.saveBot({ name: "New", instructions: "", model: "test", shared: true });
    expect(saveBot).toHaveBeenCalledWith({ name: "New", instructions: "", model: "test", shared: true });
  });

  it("refuses to start without its default runtime, and fails a call for an assistant on an unregistered one", async () => {
    expect(() => createRuntimeRouter({ runtimes: { codex: fakeRuntime({}) }, defaultRuntime: hermesRuntimeId }))
      .toThrow("The default runtime hermes is not registered.");
    const router = createRuntimeRouter({ runtimes: { [hermesRuntimeId]: fakeRuntime({}) }, defaultRuntime: hermesRuntimeId, runtimeOf: () => "grok" });
    await expect(router.conversation("barn")).rejects.toThrow("No runtime is registered as grok.");
  });

  it("lists each assistant and routine once, from the runtime it runs on", async () => {
    // Hermes still lists barn, which has moved to codex.
    const router = routerOver({
      listBots: async () => [bot("ranch"), bot("barn")],
      routines: async () => [routine("morning", "ranch"), routine("feed", "barn")],
    }, {
      listBots: async () => [bot("barn")],
      routines: async () => [routine("feed", "barn")],
    });
    expect((await router.listBots()).map(row => row.id)).toEqual(["ranch", "barn"]);
    expect((await router.routines()).map(row => `${row.botId}/${row.id}`)).toEqual(["ranch/morning", "barn/feed"]);
    // Naming the assistant asks only its runtime.
    expect((await router.routines("barn")).map(row => `${row.botId}/${row.id}`)).toEqual(["barn/feed"]);
  });

  it("lists the assistants that can be shown while one runtime is down, and marks every listing without its fresh answer incomplete", async () => {
    let codexDown = true;
    const codexBots = vi.fn<Runtime["listBots"]>(async () => { if (codexDown) throw new Error("Codex is unreachable"); return [bot("barn")]; });
    const router = routerOver({ listBots: async () => [bot("ranch")] }, { listBots: codexBots });
    const read = async () => { const bots = await router.listBots(); return [bots.map(row => `${row.id}:${row.activity}`), bots.incomplete] as const; };
    // Before codex has answered once there is nothing of its to show, and leaving barn out proves nothing.
    expect(await read()).toEqual([["ranch:idle"], true]);
    codexDown = false;
    expect(await read()).toEqual([["ranch:idle", "barn:idle"], undefined]);
    codexDown = true;
    expect(await read()).toEqual([["ranch:idle", "barn:disconnected"], true]);
  });

  it("passes a runtime's own incomplete roster on as incomplete, and never keeps it as that runtime's last complete one", async () => {
    let hermes: BotListing | Error = [bot("ranch"), bot("gate")];
    const router = routerOver({ listBots: async () => { if (hermes instanceof Error) throw hermes; return hermes; } }, { listBots: async () => [bot("barn")] });
    const read = async () => { const bots = await router.listBots(); return [bots.map(row => `${row.id}:${row.activity}`), bots.incomplete] as const; };
    await router.listBots();
    // Hermes marks its own last roster incomplete while it cannot read a new one.
    hermes = Object.assign([{ ...bot("ranch"), activity: "disconnected" as const }], { incomplete: true as const });
    expect(await read()).toEqual([["ranch:disconnected", "barn:idle"], true]);
    // When Hermes then fails outright, the router falls back to the last complete roster, gate included.
    hermes = new Error("Hermes is unreachable");
    expect(await read()).toEqual([["ranch:disconnected", "gate:disconnected", "barn:idle"], true]);
  });

  it("keeps the roster of the read that started last, whichever answers first", async () => {
    const answers: ((bots: Bot[]) => void)[] = [];
    let codexDown = false;
    const router = routerOver({ listBots: async () => [] }, { listBots: () => codexDown
      ? Promise.reject(new Error("Codex is unreachable")) : new Promise(resolve => answers.push(resolve)) });
    const older = router.listBots(), newer = router.listBots();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!([bot("barn")]);
    await newer;
    // The older read answers last, from before barn was added.
    answers[0]!([]);
    await older;
    codexDown = true;
    expect((await router.listBots()).map(row => `${row.id}:${row.activity}`)).toEqual(["barn:disconnected"]);
  });

  it("fails the routine inventory whole when one runtime fails, since callers prune by what it leaves out", async () => {
    const router = routerOver({ routines: async () => [routine("morning", "ranch")] },
      { routines: async () => { throw new Error("Codex is unreachable"); } });
    await expect(router.routines()).rejects.toThrow("Codex is unreachable");
  });

  it("undoes every watcher already registered when a later runtime refuses its own", () => {
    const stopHermes = vi.fn();
    const router = routerOver({ watchRoster: () => stopHermes },
      { watchRoster: () => { throw new Error("Codex refused the watcher"); } });
    expect(() => router.watchRoster!(() => {})).toThrow("Codex refused the watcher");
    expect(stopHermes).toHaveBeenCalled();
  });

  it("tries every stop when one throws, then reports the first failure", () => {
    const stopCodex = vi.fn();
    const router = routerOver({ watchTurns: () => () => { throw new Error("Hermes stop failed"); } }, { watchTurns: () => stopCodex });
    const stop = router.watchTurns!({ changed: () => {}, disconnected: () => {} } as never);
    expect(stop).toThrow("Hermes stop failed");
    expect(stopCodex).toHaveBeenCalled();
  });

  it("offers an optional member while any runtime has it, and refuses it for an assistant whose runtime lacks it", async () => {
    const inferenceSettings = vi.fn(async () => ({ reasoning: "high", speed: "default" }) as never);
    const codex = fakeRuntime({});
    const router = createRuntimeRouter({ runtimes: { [hermesRuntimeId]: fakeRuntime({ inferenceSettings, watch: () => () => {} }), codex },
      defaultRuntime: hermesRuntimeId, runtimeOf: botId => botId === "barn" ? "codex" : undefined });
    // Absent everywhere, so a call site's own check answers as it does for one runtime.
    expect(router.setVoice).toBeUndefined();
    await router.inferenceSettings!("ranch");
    expect(inferenceSettings).toHaveBeenCalledWith("ranch");
    await expect(router.inferenceSettings!("barn")).rejects.toMatchObject({ statusCode: 409, message: "This assistant's runtime doesn't support this yet." });
    // Watchers on a runtime without them never fire, and stop cleanly.
    expect(router.watch!("barn", () => { throw new Error("A runtime without watch fired a change."); })).toBeTypeOf("function");
    // A runtime that gains a member later is seen.
    const setVoice = vi.fn<NonNullable<Runtime["setVoice"]>>(async () => {});
    codex.setVoice = setVoice;
    await router.setVoice!("barn", "cedar");
    expect(setVoice).toHaveBeenCalledWith("barn", "cedar");
  });

  it("looks a receipt up on the assistant's runtime, or on every runtime when nobody knows the assistant", async () => {
    const hermesLookup = vi.fn<Runtime["lookupSubmission"]>(async () => { throw new Error("Hermes is unreachable"); });
    const codexLookup = vi.fn<Runtime["lookupSubmission"]>(async requestId => ({ requestId, status: "accepted" }));
    const router = routerOver({ lookupSubmission: hermesLookup }, { lookupSubmission: codexLookup });
    expect(await router.lookupSubmission("r1", "barn")).toEqual({ requestId: "r1", status: "accepted" });
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
    const hermesDownload = vi.fn<Runtime["download"]>(async () => { throw new Error("Unsigned file"); });
    const codexDownload = vi.fn<Runtime["download"]>(async () => file);
    const router = routerOver({ download: hermesDownload, fileBotId: () => undefined },
      { download: codexDownload, fileBotId: id => id === "signed-by-codex" ? "barn" : undefined });
    expect(router.fileBotId!("signed-by-codex")).toBe("barn");
    expect(await router.download("signed-by-codex", 10)).toBe(file);
    expect(codexDownload).toHaveBeenCalledWith("signed-by-codex", 10);
    await expect(router.download("forged", 10)).rejects.toThrow("Unsigned file");
  });

  it("reads each runtime's events from its own source, and fails one without durable events", async () => {
    const event = (id: string, botId: string): RuntimeEvent => ({ id, botId, kind: "completed", title: id, occurredAt: "2026-11-14T00:00:00Z" });
    const router = routerOver({
      capabilities: async () => capabilitiesFixture({ durableEvents: { supported: true } }),
      discoverEvents: async cursor => ({ cursor: `${cursor}+h`, events: [event("h", "ranch")] }),
    }, { capabilities: async () => capabilitiesFixture({ durableEvents: { supported: false, reason: "Codex keeps no event log." } }) });
    expect(router.eventSources!()).toEqual([hermesRuntimeId, "codex"]);
    expect(await router.discoverEvents("7", hermesRuntimeId)).toEqual({ cursor: "7+h", events: [event("h", "ranch")] });
    await expect(router.discoverEvents("", "codex")).rejects.toThrow("Codex keeps no event log.");
  });
});

describe("background discovery over several runtimes", () => {
  it("keeps each runtime's cursor, and lets one runtime's failure hold up no other's events", async () => {
    const store = new Store(":memory:");
    const discovered = vi.fn<Runtime["discoverEvents"]>(async cursor => ({ cursor: "codex-2", events: cursor === "codex-1"
      ? [{ id: "barn-done", botId: "barn", kind: "completed", title: "Fed", occurredAt: "2026-11-14T00:00:00Z" }] : [] }));
    const durable = async () => capabilitiesFixture({ durableEvents: { supported: true } });
    const router = routerOver({ capabilities: durable, discoverEvents: async () => { throw new Error("Hermes is unreachable"); } },
      { capabilities: durable, discoverEvents: discovered, listBots: async () => [bot("barn")] });
    store.recordEvents([], "hermes-9");
    store.recordEvents([], "codex-1", "codex");
    const worker = new BackgroundWorker(store, router, loadConfig({}));
    try {
      await worker.tick();
      expect(discovered).toHaveBeenCalledWith("codex-1");
      expect([store.cursor(), store.cursor("codex")]).toEqual(["hermes-9", "codex-2"]);
      expect(store.db.prepare("SELECT id FROM notification_events").all()).toEqual([{ id: "barn-done" }]);
    } finally { await worker.stop(); store.close(); }
  });
});

describe("notification titles during one runtime's outage", () => {
  it("names the assistants the roster lists now and keeps the names of those it leaves out", async () => {
    const store = new Store(":memory:");
    const durable = async () => capabilitiesFixture({ durableEvents: { supported: true } });
    const router = routerOver({ capabilities: durable, discoverEvents: async () => ({ cursor: "hermes-10", events: [] }),
      listBots: async () => { throw new Error("Hermes is unreachable"); } },
    { capabilities: durable, listBots: async () => [{ ...bot("barn"), name: "Barn Owl" }],
      discoverEvents: async () => ({ cursor: "codex-2", events: [{ id: "barn-done", botId: "barn", kind: "completed", title: "Fed", occurredAt: "2026-11-14T00:00:00Z" }] }) });
    store.botNames = new Map([["ranch", "Ranch Hand"], ["barn", "Barn"]]);
    const worker = new BackgroundWorker(store, router, loadConfig({}));
    try {
      await worker.tick();
      expect(Object.fromEntries(store.botNames)).toEqual({ ranch: "Ranch Hand", barn: "Barn Owl" });
    } finally { await worker.stop(); store.close(); }
  });
});

describe("background discovery when the default runtime has no durable events", () => {
  it("still reads every other runtime's events", async () => {
    const store = new Store(":memory:");
    const discovered = vi.fn<Runtime["discoverEvents"]>(async () => ({ cursor: "codex-2", events: [] }));
    // Hermes, disconnected, says durable events are unavailable. Reaching its discoverEvents fails the test.
    const router = routerOver({ capabilities: async () => capabilitiesFixture({ durableEvents: { supported: false, reason: "Hermes is disconnected." } }) },
      { capabilities: async () => capabilitiesFixture({ durableEvents: { supported: true } }), discoverEvents: discovered });
    store.recordEvents([], "hermes-9");
    store.recordEvents([], "codex-1", "codex");
    const worker = new BackgroundWorker(store, router, loadConfig({}));
    try {
      await worker.tick();
      expect(discovered).toHaveBeenCalledWith("codex-1");
      expect([store.cursor(), store.cursor("codex")]).toEqual(["hermes-9", "codex-2"]);
    } finally { await worker.stop(); store.close(); }
  });
});

describe("background discovery from a lone runtime", () => {
  it("asks that runtime whether it has durable events, and reads none when it says no", async () => {
    const store = new Store(":memory:");
    store.recordEvents([], "hermes-9");
    const discoverEvents = vi.fn<Runtime["discoverEvents"]>(async () => ({ cursor: "hermes-10", events: [] }));
    const worker = new BackgroundWorker(store, fakeRuntime({ discoverEvents,
      capabilities: async () => capabilitiesFixture({ durableEvents: { supported: false, reason: "This Hermes keeps no event journal." } }) }), loadConfig({}));
    try {
      await worker.tick();
      expect(discoverEvents).not.toHaveBeenCalled();
      expect([store.cursor(), worker.discovery.lastError]).toEqual(["hermes-9", "This Hermes keeps no event journal."]);
    } finally { await worker.stop(); store.close(); }
  });
});

describe("reconciling over several runtimes", () => {
  it("clears no main assistant while one runtime has not answered, since its assistants are missing, not deleted", async () => {
    const store = new Store(":memory:");
    const router = routerOver({
      status: async () => ({ connected: true, code: "ready" }),
      listBots: async () => [bot("ranch")],
    }, { listBots: async () => { throw new Error("Codex is unreachable"); } });
    store.user({ id: "mom", name: "Mom", email: "mom@example.test" });
    store.savePresentation("barn", { shared: false, ownerId: "mom" });
    store.savePreferences("mom", { ...defaultPreferences, mainBotId: "barn" });
    try {
      const failed = await new MainAssistants(router, store, loadConfig({})).reconcile().then(() => undefined, (error: unknown) => error);
      expect([failed instanceof ReconcileError, (failed as Error).message]).toEqual([true, "Hermes is unavailable, so check-ins were not reconciled."]);
      expect(store.preferences("mom").mainBotId).toBe("barn");
    } finally { store.close(); }
  });

  it("removes no tracked check-in while one runtime's routines cannot be read", async () => {
    const store = new Store(":memory:");
    const router = routerOver({
      status: async () => ({ connected: true, code: "ready" }),
      capabilities: async () => capabilitiesFixture({ routines: { supported: true } }),
      listBots: async () => [bot("ranch")],
      routines: async () => [],
    }, { listBots: async () => [bot("barn")], routines: async () => { throw new Error("Codex is unreachable"); } });
    store.user({ id: "mom", name: "Mom", email: "mom@example.test" });
    store.checkIns.track({ botId: "barn", jobId: "job1", userId: "mom" });
    try {
      const failed = await new MainAssistants(router, store, loadConfig({})).reconcile().then(() => undefined, (error: unknown) => error);
      expect(failed).toBeInstanceOf(ReconcileError);
      expect((failed as ReconcileError).whole).toBe(true);
      expect(store.checkIns.current()).toEqual([{ botId: "barn", jobId: "job1", userId: "mom" }]);
    } finally { store.close(); }
  });
});

describe("the roster during one runtime's outage", () => {
  const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

  it("lists every assistant, the failed runtime's as disconnected", async () => {
    let codexDown = false;
    const router = routerOver({ listBots: async () => [bot("ranch")], close: async () => {},
      status: async () => ({ connected: true, code: "ready" }), capabilities: async () => capabilitiesFixture() },
    { listBots: async () => { if (codexDown) throw new Error("Codex is unreachable"); return [bot("barn")]; }, close: async () => {} });
    const { app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), router, { background: false });
    apps.push(app);
    const headers = await localLogin(app, "http://127.0.0.1:3000");
    await app.inject({ method: "GET", url: "/api/bots", headers });
    codexDown = true;
    const listed = await app.inject({ method: "GET", url: "/api/bots", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((row: Bot) => `${row.id}:${row.activity}`)).toEqual(["ranch:idle", "barn:disconnected"]);
  });

  it("lists the other runtimes' assistants when one has not answered since the server started", async () => {
    const router = routerOver({ listBots: async () => [bot("ranch")], close: async () => {},
      status: async () => ({ connected: true, code: "ready" }), capabilities: async () => capabilitiesFixture() },
    { listBots: async () => { throw new Error("Codex is unreachable"); }, close: async () => {} });
    const { app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), router, { background: false });
    apps.push(app);
    const headers = await localLogin(app, "http://127.0.0.1:3000");
    for (let read = 0; read < 3; read++) {
      const listed = await app.inject({ method: "GET", url: "/api/bots", headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().map((row: Bot) => row.id)).toEqual(["ranch"]);
    }
  });
});

describe("capabilities checked per assistant", () => {
  const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

  it("refuses steering only for an assistant whose runtime cannot steer", async () => {
    const steer = vi.fn<Runtime["steer"]>(async input => ({ requestId: input.requestId, status: "accepted" }));
    const common = (botId: string) => ({ listBots: async () => [bot(botId)], close: async () => {},
      conversation: async () => conversationFixture({ botId, activity: { state: "working" } }) });
    const router = routerOver({ ...common("ranch"), steer, status: async () => ({ connected: true, code: "ready" }),
      capabilities: async () => capabilitiesFixture({ chat: { supported: true }, steering: { supported: true } }) },
    { ...common("barn"),
      // No steer: reaching it fails the test.
      capabilities: async () => capabilitiesFixture({ chat: { supported: true }, steering: { supported: false, reason: "Barn's runtime starts your message after this reply." } }) });
    const { app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), router, { background: false });
    apps.push(app);
    const headers = await localLogin(app, "http://127.0.0.1:3000");
    const steerOn = (botId: string) => app.inject({ method: "POST", url: `/api/bots/${botId}/steer`, headers, payload: { requestId: crypto.randomUUID(), text: "Also the gate" } });
    const refused = await steerOn("barn");
    expect([refused.statusCode, refused.json().error]).toEqual([409, "Barn's runtime starts your message after this reply."]);
    const steered = await steerOn("ranch");
    expect([steered.statusCode, steered.json().status]).toEqual([200, "accepted"]);
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ botId: "ranch", text: "Also the gate" }));
  });
});

describe("decisions by absence during one runtime's outage", () => {
  const codexDown = { listBots: async () => { throw new Error("Codex is unreachable"); } };

  it("never serves a bootstrap from memory while the roster is incomplete", async () => {
    const listBots = vi.fn<Runtime["listBots"]>(async () => [bot("ranch")]);
    let codex: Partial<Runtime> = codexDown;
    const router = createRuntimeRouter({
      runtimes: { [hermesRuntimeId]: fakeRuntime({ listBots, capabilities: async () => capabilitiesFixture(), status: async () => ({ connected: true, code: "ready" }) }),
        codex: { ...fakeRuntime({}), listBots: (...args) => codex.listBots!(...args) } },
      defaultRuntime: hermesRuntimeId, runtimeOf: botId => botId === "barn" ? "codex" : undefined,
    });
    const snapshots = runtimeSnapshots(router);
    await snapshots.read(); await snapshots.read();
    expect(listBots.mock.calls).toHaveLength(2);
    // Once every runtime answers, the read is kept for the next bootstrap.
    codex = { listBots: async () => [bot("barn")] };
    await snapshots.read(); await snapshots.read();
    expect(listBots.mock.calls).toHaveLength(3);
  });

  it("refuses a sharing change it cannot check, since a room whose member is missing would look closed", async () => {
    const store = new Store(":memory:");
    let codex: Partial<Runtime> = codexDown;
    // Ranch's routine posts in a room of barn and gate. Barn is shared, so making ranch private would let anyone read its posts.
    const room = { room_id: "yard", name: "Yard", members: [{ profile: "barn" }, { profile: "gate" }] } as GroupRoom;
    const router = createRuntimeRouter({
      runtimes: {
        [hermesRuntimeId]: fakeRuntime({ listBots: async () => [bot("ranch"), bot("gate")], routines: async () => [{ ...routine("evening", "ranch"), roomIds: ["yard"] }],
          groupRequest: async () => ({ supported: true, canSend: true, rooms: [room], routineDelivery: true }) }),
        codex: { ...fakeRuntime({ routines: async () => [] }), listBots: (...args) => codex.listBots!(...args) },
      },
      defaultRuntime: hermesRuntimeId,
      runtimeOf: botId => botId === "barn" ? "codex" : undefined,
    });
    const makePrivate = () => assertRoutinesStayPrivate(router, store, "mom", "ranch", { shared: false, ownerId: "mom" }).then(() => undefined, (error: { code?: string }) => error.code);
    try {
      expect(await makePrivate()).toBe("routine_rooms_unknown");
      codex = { listBots: async () => [bot("barn")] };
      expect(await makePrivate()).toBe("routine_rooms");
    } finally { store.close(); }
  });

  it("lets a known assistant past the access check while its runtime is down, and still refuses an ID never seen", async () => {
    const store = new Store(":memory:");
    store.rememberNames([bot("barn")]);
    try {
      const roster = new Roster(routerOver({ listBots: async () => [bot("ranch")] }, codexDown), store);
      expect([await roster.exists("ranch"), await roster.exists("barn"), await roster.exists("ghost")]).toEqual([true, true, false]);
      // Absent from an incomplete roster is not "no such assistant", so a new one may not take the name.
      await expect(roster.has("barn")).rejects.toMatchObject({ statusCode: 503 });
      // A complete roster still proves an assistant is gone.
      const complete = new Roster(routerOver({ listBots: async () => [bot("ranch")] }, { listBots: async () => [] }), store);
      expect(await complete.exists("barn")).toBe(false);
    } finally { store.close(); }
  });

  it("answers a lookup by ID with a refusal, not \"not found\", when the roster lacks the runtime it may run on", async () => {
    const partial = routerOver({ listBots: async () => [bot("ranch")] }, codexDown);
    expect((await rosterBot(partial, "ranch"))?.id).toBe("ranch");
    await expect(rosterBot(partial, "barn")).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("runtime isn't answering") });
    await expect(completeRoster(partial)).rejects.toMatchObject({ statusCode: 503 });
    const complete = routerOver({ listBots: async () => [bot("ranch")] }, { listBots: async () => [] });
    expect(await rosterBot(complete, "barn")).toBeUndefined();
    expect((await completeRoster(complete)).map(row => row.id)).toEqual(["ranch"]);
  });
});

describe("Live Activities during one runtime's outage", () => {
  type Sent = Parameters<LiveActivitySender>;
  let clock: number, store: Store, sent: ReturnType<typeof vi.fn<LiveActivitySender>>;
  const config = () => {
    const value = loadConfig({ HOUSEHOLD_EMAILS: "mom@example.test" });
    value.apns = { teamId: "TEAM123456", keyId: "KEY1234567", topic: "test.agentinterface", privateKeyFile: "unused", environment: "sandbox" };
    return value;
  };
  const token = "a".repeat(64);
  // Barn runs on codex. Its state, or the error codex fails every read with.
  const codexWith = (barn: () => ActivityState | Error): Partial<Runtime> => ({
    listBots: async () => { const state = barn(); if (state instanceof Error) throw state; return [{ ...bot("barn"), name: "Barn", activity: state }]; },
    conversation: async botId => { const state = barn(); if (state instanceof Error) throw state; return conversationFixture({ botId, activity: { state } }); },
  });
  const pass = async (router: Runtime, ms: number) => { clock += ms; await new LiveActivities(store, router, config(), sent, undefined, () => clock).tick(); };
  const pushed = (call: Sent | undefined) => {
    const aps = (call?.[1] as { aps: { event: string; "content-state": LiveState } } | undefined)?.aps;
    return aps && { event: aps.event, title: aps["content-state"].title, rows: aps["content-state"].rows.map(row => `${row.botId}:${row.phase}`) };
  };

  beforeEach(() => {
    clock = Date.parse("2026-11-14T12:00:00Z");
    store = new Store(":memory:");
    store.user({ id: "mom", name: "Mom", email: "mom@example.test" });
    store.nativeSession("mom", "mom", Date.now() + 7 * 86400000);
    store.savePreferences("mom", { ...defaultPreferences, followBots: ["barn"] });
    store.registerLiveActivity("mom", "mom", "mom-device", token, "sandbox", [], clock);
    sent = vi.fn<LiveActivitySender>(async () => {});
  });
  afterEach(() => store.close());

  it("keeps a run whose runtime went down as it was, and ends the activity only once a fresh answer says it finished", async () => {
    let barn: ActivityState | Error = "working";
    const router = routerOver({ listBots: async () => [bot("ranch")] }, codexWith(() => barn));
    await pass(router, 0);
    expect(pushed(sent.mock.calls.at(-1))).toEqual({ event: "update", title: "Barn is working", rows: ["barn:working"] });
    barn = new Error("Codex is unreachable");
    // Past the heartbeat: nothing is sent, so the activity stays as it was and its stale date passes.
    await pass(router, 6 * 60_000);
    expect(sent.mock.calls).toHaveLength(1);
    expect(store.liveActivities("sandbox", clock).map(row => [row.token, row.lastState?.rows.map(value => `${value.botId}:${value.phase}`)]))
      .toEqual([[token, ["barn:working"]]]);
    barn = "idle";
    await pass(router, 60_000);
    expect(pushed(sent.mock.calls.at(-1))).toEqual({ event: "end", title: "Barn finished", rows: ["barn:done"] });
    expect(sent.mock.calls.at(-1)?.[0]).toEqual({ token, environment: "sandbox" });
  });

  it("keeps the row of an assistant a restarted server cannot list yet, since its runtime has not answered", async () => {
    await pass(routerOver({ listBots: async () => [bot("ranch")] }, codexWith(() => "working")), 0);
    // A new router, as after a restart: it has no roster of codex's to keep.
    await pass(routerOver({ listBots: async () => [bot("ranch")] }, codexWith(() => new Error("Codex is unreachable"))), 6 * 60_000);
    expect(sent.mock.calls.map(call => pushed(call))).toEqual([{ event: "update", title: "Barn is working", rows: ["barn:working"] }]);
    expect(store.liveActivities("sandbox", clock).map(row => [row.token, row.lastState?.rows.map(value => `${value.botId}:${value.phase}`)]))
      .toEqual([[token, ["barn:working"]]]);
  });
});
