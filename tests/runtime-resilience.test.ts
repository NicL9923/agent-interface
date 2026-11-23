import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { badgeFor } from "../src/server/badge.js";
import { routineById } from "../src/server/bot-access.js";
import { loadConfig } from "../src/server/config.js";
import { LiveActivities } from "../src/server/live-activity.js";
import { MainAssistants, ReconcileError } from "../src/server/main-assistant.js";
import { assertRoutinesStayPrivate } from "../src/server/routine-delivery.js";
import { createRuntimeRouter, hermesRuntimeId } from "../src/server/runtime-router.js";
import { Store } from "../src/server/store.js";
import {
  failedRuntimeOmits,
  isIncomplete,
  isPartialAnswer,
  isUnknownRoster,
  mayOmit,
  unknownRoster,
} from "../src/server/unknown-roster.js";
import { HermesUpgrades } from "../src/server/upgrades.js";
import type { GroupCatalog } from "../src/shared/collaboration.js";
import type { ActivityState, Bot, Routine, Runtime, RuntimeEvent } from "../src/shared/types.js";
import { capabilitiesFixture, routineFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, localLogin } from "./helpers/server.js";

const bot = (id: string, activity: ActivityState = "idle"): Bot => ({
  id,
  name: id,
  shared: true,
  model: "test",
  activity,
});
const routine = (id: string, botId: string): Routine => routineFixture({ id, botId, name: id });
const unreachable = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is unreachable`);
};
const origin = "http://127.0.0.1:3000";

/** Hermes runs ranch, and codex runs barn and silo. A member set to `unreachable` takes that runtime's read down. */
function runtimes(hermes: Partial<Runtime> = {}, codex: Partial<Runtime> = {}) {
  const parts = {
    hermes: {
      status: async () => ({ connected: true, code: "ready" }),
      capabilities: async () =>
        capabilitiesFixture({
          chat: { supported: true },
          steering: { supported: true },
          routines: { supported: true },
        }),
      listBots: async () => [bot("ranch")],
      routines: async () => [routine("morning", "ranch")],
      close: async () => {},
      ...hermes,
    } as Partial<Runtime>,
    codex: {
      capabilities: async () =>
        capabilitiesFixture({
          chat: { supported: true },
          queueManagement: { supported: true },
          steering: { supported: false, reason: "Codex starts your message after this reply." },
        }),
      listBots: async () => [bot("barn"), bot("silo")],
      routines: async () => [routine("feed", "barn")],
      close: async () => {},
      ...codex,
    } as Partial<Runtime>,
  };
  const router = createRuntimeRouter({
    runtimes: {
      [hermesRuntimeId]: fakeRuntime(parts.hermes),
      codex: fakeRuntime(parts.codex),
    },
    defaultRuntime: hermesRuntimeId,
    runtimeOf: (botId) => (["barn", "silo"].includes(botId) ? "codex" : undefined),
  });
  return router;
}

describe("the router's roster while one runtime is down", () => {
  it("lists the healthy runtime's assistants, and says the down runtime's may be missing", async () => {
    const router = runtimes({}, { listBots: unreachable("Codex") });
    const bots = await router.listBots();
    expect(bots.map((row) => [row.id, row.harness])).toEqual([["ranch", hermesRuntimeId]]);
    expect(isPartialAnswer(bots)).toBe(true);
    // Codex never answered, so nothing says who runs on it.
    expect(isUnknownRoster(bots)).toBe(true);
    expect(mayOmit(bots, "barn")).toBe(true);
    expect(failedRuntimeOmits(bots, "barn")).toBe(true);
    expect(failedRuntimeOmits(bots, "ranch")).toBe(false);
  });

  it("names each assistant's runtime, and marks nothing while every runtime answers", async () => {
    const live = await runtimes().listBots();
    expect(isIncomplete(live)).toBe(false);
    expect(live.map((row) => `${row.harness}/${row.id}`)).toEqual([
      "hermes/ranch",
      "codex/barn",
      "codex/silo",
    ]);
  });

  it("lists the last roster of a runtime that answered before, disconnected, without leaving the roster unknown", async () => {
    let codexUp = true;
    const router = runtimes(
      {},
      {
        listBots: async () => {
          if (!codexUp) throw new Error("Codex is unreachable");
          return [bot("barn", "working"), bot("silo")];
        },
      },
    );
    await router.listBots();
    codexUp = false;
    const bots = await router.listBots();
    expect(bots.map((row) => `${row.id}/${row.activity}`)).toEqual([
      "ranch/idle",
      "barn/disconnected",
      "silo/disconnected",
    ]);
    expect(isUnknownRoster(bots)).toBe(false);
    expect(isPartialAnswer(bots)).toBe(true);
    codexUp = true;
    expect(isIncomplete(await router.listBots())).toBe(false);
  });

  it("leaves a down runtime's routines out, never listed from memory, and marks the inventory partial", async () => {
    let codexUp = true;
    const router = runtimes(
      {},
      {
        routines: async () => {
          if (!codexUp) throw new Error("Codex is unreachable");
          return [routine("feed", "barn")];
        },
      },
    );
    expect(isIncomplete(await router.routines())).toBe(false);
    codexUp = false;
    const routines = await router.routines();
    expect(routines.map((row) => `${row.botId}/${row.id}`)).toEqual(["ranch/morning"]);
    expect(isPartialAnswer(routines)).toBe(true);
    expect(mayOmit(routines, "barn")).toBe(true);
    expect(mayOmit(routines, "ranch")).toBe(false);
  });
});

describe("event IDs across runtimes", () => {
  it("prefixes another runtime's event IDs once and keeps Hermes's, so equal raw IDs never share a row", async () => {
    const event = (id: string, botId: string): RuntimeEvent => ({
      id,
      botId,
      kind: "completed",
      title: id,
      occurredAt: "2026-11-23T00:00:00Z",
    });
    const durable = async () => capabilitiesFixture({ durableEvents: { supported: true } });
    const router = runtimes(
      {
        capabilities: durable,
        discoverEvents: async () => ({ cursor: "h1", events: [event("7", "ranch")] }),
      },
      {
        capabilities: durable,
        discoverEvents: async () => ({
          cursor: "c1",
          events: [event("7", "barn"), event("codex:8", "barn")],
        }),
      },
    );
    const hermes = await router.discoverEvents("", hermesRuntimeId);
    const codex = await router.discoverEvents("", "codex");
    expect(hermes.events.map((row) => row.id)).toEqual(["7"]);
    expect(codex.events.map((row) => row.id)).toEqual(["codex:7", "codex:8"]);
    const store = new Store(":memory:");
    try {
      store.recordEvents(hermes.events, hermes.cursor);
      store.recordEvents(codex.events, codex.cursor, "codex");
      expect(store.db.prepare("SELECT id FROM notification_events ORDER BY id").all()).toEqual([
        { id: "7" },
        { id: "codex:7" },
        { id: "codex:8" },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("decisions that must not act on a partial roster", () => {
  it("refuses a missing routine as unavailable, not gone, only while the inventory is partial", async () => {
    const store = new Store(":memory:");
    try {
      const router = runtimes({}, { routines: unreachable("Codex") });
      expect(() =>
        routineById([routine("morning", "ranch")], "feed", store, "local-one"),
      ).not.toThrow();
      const partial = await router.routines();
      expect(() => routineById(partial, "feed", store, "local-one")).toThrow(
        expect.objectContaining({ statusCode: 503, code: "assistants_unavailable" }),
      );
    } finally {
      store.close();
    }
  });

  it("counts no badge from a roster that may leave assistants out", async () => {
    const store = new Store(":memory:");
    try {
      expect(badgeFor([bot("ranch")], store, "local-one")).toBe(0);
      expect(badgeFor(unknownRoster([bot("ranch")]), store, "local-one")).toBeUndefined();
      const router = runtimes({}, { listBots: unreachable("Codex") });
      expect(badgeFor(await router.listBots(), store, "local-one")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("keeps a member's main assistant while its runtime has never answered", async () => {
    const store = new Store(":memory:");
    try {
      const router = runtimes({}, { listBots: unreachable("Codex") });
      store.user({ id: "local-one", name: "One", email: "one@localhost.invalid" });
      store.savePresentation("barn", { shared: false, ownerId: "local-one" });
      store.savePreferences("local-one", { ...store.preferences("local-one"), mainBotId: "barn" });
      const mains = new MainAssistants(router, store, loadConfig({ LOCAL_DEV_AUTH: "true" }));
      const failed = await mains.reconcile().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(ReconcileError);
      expect(store.preferences("local-one").mainBotId).toBe("barn");
    } finally {
      store.close();
    }
  });

  it("refuses a sharing change while a down runtime's routines might post in a room", async () => {
    const store = new Store(":memory:");
    try {
      const groupRequest = vi.fn(async () => ({ supported: true, canSend: true, rooms: [] }));
      const router = runtimes(
        { groupRequest: groupRequest as unknown as Runtime["groupRequest"] },
        { routines: unreachable("Codex") },
      );
      await expect(
        assertRoutinesStayPrivate(router, store, "local-one", "ranch", {
          shared: false,
          ownerId: "local-one",
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "routine_rooms_unknown" });
      // The room catalog is never asked: the check stops at the incomplete inventory.
      expect(groupRequest).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("holds a Live Activity row whose assistant's runtime did not answer, instead of dropping it", async () => {
    const store = new Store(":memory:");
    try {
      const router = runtimes(
        {},
        { listBots: unreachable("Codex"), conversation: unreachable("Codex") },
      );
      const live = new LiveActivities(store, router, loadConfig({}));
      const previous = {
        title: "1 assistant working",
        activeCount: 1,
        attentionCount: 0,
        updatedAt: 1,
        rows: [{ botId: "barn", name: "Barn", phase: "working" as const, status: "Working" }],
      };
      const state = await live.state("local-one", undefined, previous);
      expect(state.rows).toMatchObject([
        { botId: "barn", name: "Barn", phase: "working", detail: "Can't check on this right now" },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("routes over a partial roster", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function serve(router: Runtime, extra: Parameters<typeof loadConfig>[0] = {}) {
    const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", ...extra });
    const upgrades = new HermesUpgrades(config, router, () => {});
    const result = await createApp(config, router, { background: false, upgrades });
    cleanups.push(() => result.app.close());
    return result;
  }

  it("keeps /bots up when a second runtime that has never answered fails", async () => {
    const router = runtimes({}, { listBots: unreachable("Codex") });
    const { app } = await serve(router);
    const headers = await localLogin(app, origin);
    const bots = await app.inject({ url: "/api/bots?roster=lean", headers });
    expect(bots.statusCode).toBe(200);
    expect(bots.json().map((row: Bot) => row.id)).toEqual(["ranch"]);
    // Clients keep what they showed rather than take codex's assistants for gone.
    expect((await app.inject({ url: "/api/bootstrap", headers })).json()).toMatchObject({
      rosterUnknown: true,
    });
  });

  it("still fails /bots when every runtime fails", async () => {
    const router = runtimes(
      { listBots: unreachable("Hermes") },
      { listBots: unreachable("Codex") },
    );
    const { app } = await serve(router);
    const headers = await localLogin(app, origin);
    expect((await app.inject({ url: "/api/bots", headers })).statusCode).toBe(502);
  });

  it("lists a down runtime's known assistants as disconnected on /bots", async () => {
    let codexUp = true;
    const router = runtimes(
      {},
      {
        listBots: async () => {
          if (!codexUp) throw new Error("Codex is unreachable");
          return [bot("barn"), bot("silo")];
        },
      },
    );
    const { app } = await serve(router);
    const headers = await localLogin(app, origin);
    await app.inject({ url: "/api/bots?roster=lean", headers });
    codexUp = false;
    const bots = (await app.inject({ url: "/api/bots?roster=lean", headers })).json() as Bot[];
    expect(bots.map((row) => `${row.id}/${row.activity}`)).toEqual([
      "ranch/idle",
      "barn/disconnected",
      "silo/disconnected",
    ]);
  });

  // Made-up IDs answer exactly as a hidden assistant does; a known one goes on to its runtime.
  it.each<[string, Runtime["listBots"]]>([
    ["the roster is empty", async () => unknownRoster([])],
    ["every assistant is disconnected", async () => [bot("ranch", "disconnected")]],
    ["every runtime fails", unreachable("Hermes")],
  ])("refuses a made-up assistant ID when %s", async (_, listBots) => {
    const router = runtimes(
      { listBots, conversation: unreachable("Hermes") },
      { listBots: unreachable("Codex"), conversation: unreachable("Codex") },
    );
    const { app, store } = await serve(router);
    // Listed before this server restarted.
    store.rememberNames([{ id: "barn", name: "Barn" }]);
    const headers = await localLogin(app, origin);
    const made = await app.inject({ url: "/api/bots/ghost/conversation", headers });
    expect([made.statusCode, made.json().code]).toEqual([404, "assistant_not_found"]);
    const known = await app.inject({ url: "/api/bots/barn/conversation", headers });
    expect(known.statusCode).toBe(502);
  });

  it("lists a room with a down runtime's assistant by this app's record, hides it from whom the record hides it, and refuses when there is no record", async () => {
    const room = (room_id: string, profiles: string[]) => ({
      room_id,
      name: room_id,
      latest_seq: 0,
      members: profiles.map((profile) => ({ member_id: profile, profile, handle: profile })),
    });
    // "old" lists an assistant Hermes no longer has, whose sharing record outlived it.
    const catalog = {
      supported: true,
      canSend: true,
      rooms: [room("chores", ["ranch", "silo"]), room("old", ["ranch", "gone"])],
    } as GroupCatalog;
    const groupRequest = async (input: { operation: string }) => {
      if (input.operation === "list") return catalog;
      throw new Error("Hermes is busy");
    };
    let codexUp = true;
    const router = runtimes(
      { groupRequest: groupRequest as unknown as Runtime["groupRequest"] },
      {
        listBots: async () => {
          if (!codexUp) throw new Error("Codex is unreachable");
          return [bot("barn")];
        },
      },
    );
    const { app, store } = await serve(router);
    store.savePresentation("gone", { shared: true });
    const one = await localLogin(app, origin);
    const rooms = (headers: Record<string, string>) => app.inject({ url: "/api/groups", headers });
    const ids = async (headers: Record<string, string>) =>
      (await rooms(headers)).json().rooms.map((row: { room_id: string }) => row.room_id);
    // Every runtime answered without silo or "gone", so neither room opens.
    expect(await ids(one)).toEqual([]);
    // Codex has answered once, so its outage leaves a partial roster, not an unknown one. Silo,
    // made on codex since, is missing from codex's last roster.
    codexUp = false;
    // No record of who sees silo: the room is neither listed as gone nor opened on a guess.
    const unsure = await rooms(one);
    expect([unsure.statusCode, unsure.json().code]).toEqual([503, "assistants_unavailable"]);
    store.savePresentation("silo", { shared: true });
    // Hermes answered without "gone", so its record opens nothing.
    expect(await ids(one)).toEqual(["chores"]);
    store.savePresentation("silo", { shared: false, ownerId: "local-two" });
    expect(await ids(one)).toEqual([]);
    expect(await ids(await localLogin(app, origin, "two"))).toEqual(["chores"]);
  });

  it("refuses the routine list while it may leave out routines of an assistant this person sees", async () => {
    const router = runtimes({}, { routines: unreachable("Codex") });
    const { app, store } = await serve(router);
    const one = await localLogin(app, origin);
    const refused = await app.inject({ url: "/api/routines", headers: one });
    expect([refused.statusCode, refused.json().code]).toEqual([503, "assistants_unavailable"]);
    // Nobody on codex is theirs to see, so the list is whole for them.
    store.savePresentation("barn", { shared: false, ownerId: "local-two" });
    store.savePresentation("silo", { shared: false, ownerId: "local-two" });
    const listed = await app.inject({ url: "/api/routines", headers: one });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((row: Routine) => row.id)).toEqual(["morning"]);
  });

  it("refuses to create an assistant whose name a down runtime may already hold", async () => {
    const saveBot = vi.fn<Runtime["saveBot"]>();
    const router = runtimes(
      {
        saveBot,
        capabilities: async () => capabilitiesFixture({ botConfiguration: { supported: true } }),
      },
      { listBots: unreachable("Codex") },
    );
    const { app } = await serve(router);
    const headers = await localLogin(app, origin);
    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name: "Silo", instructions: "", model: "test", shared: true },
    });
    expect([created.statusCode, created.json().code]).toEqual([503, "assistants_unavailable"]);
    expect(saveBot).not.toHaveBeenCalled();
  });

  it("holds a Hermes upgrade while a down runtime's assistants' activity is unknown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-resilience-upgrade-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const workerConfig = join(directory, "worker.json");
    writeFileSync(workerConfig, "{}", { mode: 0o600 });
    const router = runtimes({}, { listBots: unreachable("Codex") });
    const { app } = await serve(router, {
      HERMES_UPGRADE_ENABLED: "true",
      HERMES_UPGRADE_ADMINS: "one@localhost.invalid",
      HERMES_UPGRADE_CONFIG: workerConfig,
      HERMES_UPGRADE_STATE_DIR: directory,
      HERMES_UPGRADE_PYTHON: "/usr/bin/python3",
    });
    const headers = await localLogin(app, origin);
    expect((await app.inject({ url: "/api/hermes/upgrade", headers })).json().busyBots).toEqual([
      "Some assistants' activity unavailable",
    ]);
  });

  it("gives each assistant its own runtime's capabilities in bootstrap, reading each runtime once", async () => {
    const codexCapabilities = vi.fn(async () =>
      capabilitiesFixture({
        chat: { supported: true },
        queueManagement: { supported: true },
        steering: { supported: false, reason: "Codex starts your message after this reply." },
      }),
    );
    const router = runtimes({}, { capabilities: codexCapabilities });
    const { app } = await serve(router);
    const headers = await localLogin(app, origin);
    const boot = (await app.inject({ url: "/api/bootstrap", headers })).json();
    const of = (id: string) => boot.bots.find((row: Bot) => row.id === id) as Bot;
    // The top-level set stays the default runtime's, for clients that read only it.
    expect(boot.capabilities.steering.supported).toBe(true);
    expect([of("ranch").harness, of("ranch").capabilities?.steering.supported]).toEqual([
      hermesRuntimeId,
      true,
    ]);
    expect([
      of("barn").harness,
      of("barn").capabilities?.steering.supported,
      of("barn").capabilities?.queueManagement.supported,
      of("silo").capabilities?.queueManagement.supported,
    ]).toEqual(["codex", false, true, true]);
    // Two codex assistants, one read of codex's capabilities.
    expect(codexCapabilities).toHaveBeenCalledTimes(1);
  });

  it("marks every capability unsupported for an assistant whose runtime cannot say", async () => {
    const router = runtimes({}, { capabilities: unreachable("Codex") });
    const { app } = await serve(router);
    const headers = await localLogin(app, origin);
    const boot = (await app.inject({ url: "/api/bootstrap", headers })).json();
    const barn = boot.bots.find((row: Bot) => row.id === "barn") as Bot;
    expect(Object.values(barn.capabilities!).every((value) => !value.supported)).toBe(true);
    expect(barn.capabilities!.chat.reason).toBe("This assistant's runtime is unavailable.");
  });
});
