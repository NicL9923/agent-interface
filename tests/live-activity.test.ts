import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ApnsError, createApnsSender } from "../src/server/apns.js";
import { loadConfig, type Config } from "../src/server/config.js";
import { ARMED_MS, FINISHED_MS, LiveActivities, type LiveState } from "../src/server/live-activity.js";
import { Store } from "../src/server/store.js";
import { defaultPreferences, type ActivityState, type Bot, type Conversation } from "../src/shared/types.js";

const apns = (): NonNullable<Config["apns"]> => ({ teamId: "TEAM123456", keyId: "KEY1234567", topic: "test.agentinterface", privateKeyFile: "unused", environment: "sandbox" });
type Push = { token: string; payload: { aps: { event: string; timestamp: number; "content-state": LiveState; "stale-date"?: number; "dismissal-date"?: number } }; priority: number };

let clock: number, store: Store, pushes: Push[], failure: Error | undefined;
let bots: Bot[], conversations: Record<string, Partial<Conversation["activity"]>>, live: LiveActivities;
let duringSend: (() => void) | undefined;
const bot = (id: string, activity: ActivityState = "idle", extra: Partial<Bot> = {}): Bot => ({ id, name: id[0].toUpperCase() + id.slice(1), shared: true, model: "test", activity, ...extra });
const set = (id: string, state: ActivityState, extra: Partial<Conversation["activity"]> = {}, botExtra: Partial<Bot> = {}) => {
  bots = bots.map(value => value.id === id ? { ...value, activity: state, ...botExtra } : value);
  conversations[id] = { state, ...extra };
};
const register = (userId: string, armed: string[] = [], token = userId.repeat(32).slice(0, 64)) =>
  store.registerLiveActivity(userId, userId, `${userId}-device`, token, "sandbox", armed, clock);
const tick = async (ms = 0) => { clock += ms; await live.tick(); };
const last = () => pushes.at(-1)!;
const rows = (push = last()) => push.payload.aps["content-state"].rows.map(row => `${row.botId}:${row.phase}`);

beforeEach(() => {
  clock = Date.parse("2026-10-16T12:00:00Z");
  store = new Store(":memory:");
  for (const id of ["one", "two"]) {
    store.user({ id, name: id, email: `${id}@example.test` });
    // The store prunes sessions by real time, not this test's fixed clock, so they must outlive today.
    store.nativeSession(id, id, Date.now() + 7 * 86400000);
  }
  bots = [bot("kitchen"), bot("garden"), bot("secret")];
  conversations = {};
  pushes = []; failure = undefined; duringSend = undefined;
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" }); config.apns = apns();
  const runtime = {
    listBots: async () => bots,
    conversation: async (botId: string) => ({ botId, messages: [], approvals: [], files: [], activity: { state: "idle", ...conversations[botId] } }) as Conversation,
  };
  live = new LiveActivities(store, runtime, config, async (target, payload, priority) => {
    duringSend?.();
    if (failure) throw failure;
    pushes.push({ token: target.token, payload: payload as Push["payload"], priority });
  }, undefined, () => clock);
});

describe("aggregate Live Activity", () => {
  it("follows a sent message from starting to working to done, then ends with the result", async () => {
    register("one", ["kitchen"]);
    await tick();
    expect(rows()).toEqual(["kitchen:starting"]);
    expect(last().payload.aps).toMatchObject({ event: "update", "stale-date": Math.floor(clock / 1000) + 900 });
    expect(last().payload.aps["content-state"]).toMatchObject({ title: "Kitchen is starting", activeCount: 1, attentionCount: 0 });
    expect(last().priority).toBe(5);

    store.participate("run-1", "one");
    set("kitchen", "working", { runId: "run-1", detail: "  Using   web_search " });
    await tick(5_000);
    expect(pushes).toHaveLength(1); // A plain phase change waits out the 15-second throttle.
    await tick(10_000);
    expect(rows()).toEqual(["kitchen:working"]);
    expect(last().payload.aps["content-state"].rows[0]).toMatchObject({ status: "Working", detail: "Using web_search", since: Math.floor(clock / 1000) - 10 });

    set("kitchen", "idle", {}, { lastMessage: { text: "Dinner is planned.", at: new Date(clock).toISOString() } });
    await tick(ARMED_MS); // The grace period has passed, so finishing ends the activity.
    expect(last().payload.aps).toMatchObject({ event: "end", "dismissal-date": Math.floor(clock / 1000) + 300 });
    expect(last().priority).toBe(10);
    expect(last().payload.aps["content-state"]).toMatchObject({ title: "Kitchen finished", activeCount: 0, rows: [{ phase: "done", detail: "Dinner is planned." }] });
    expect(store.liveActivities("sandbox", clock)).toHaveLength(0);
  });

  it("shows a run that finished between two looks as done", async () => {
    register("one", ["kitchen"]);
    await tick();
    set("kitchen", "idle", {}, { lastMessage: { text: "Quick answer", at: new Date(clock + 1000).toISOString() } });
    await tick(5_000);
    expect(last().payload.aps.event).toBe("end");
    expect(rows()).toEqual(["kitchen:done"]);
    expect(last().payload.aps["content-state"]).toMatchObject({ title: "Kitchen finished", rows: [{ detail: "Quick answer" }] });
  });

  it("keeps a just-sent activity open through the grace period, then ends it empty", async () => {
    register("one", ["kitchen"]);
    await tick();
    await tick(ARMED_MS - 1000);
    expect(pushes.map(push => push.payload.aps.event)).toEqual(["update"]);
    await tick(1000);
    expect(last().payload.aps).toMatchObject({ event: "end", "content-state": { title: "All caught up", rows: [] } });
  });

  it("puts waiting work first, raises its priority and keeps finished rows beside running work", async () => {
    store.savePreferences("one", { ...defaultPreferences, followBots: ["kitchen", "garden"] });
    set("kitchen", "working");
    set("garden", "working");
    register("one");
    await tick();
    expect(last().payload.aps["content-state"]).toMatchObject({ title: "2 assistants working", activeCount: 2 });
    set("garden", "waiting");
    await tick(1000);
    expect(rows()).toEqual(["garden:waiting", "kitchen:working"]);
    expect(last().priority).toBe(10);
    expect(last().payload.aps["content-state"]).toMatchObject({ title: "Garden needs you", attentionCount: 1 });
    set("kitchen", "failed");
    await tick(1000);
    expect(rows()).toEqual(["garden:waiting", "kitchen:failed"]);
    expect(last().payload.aps["content-state"].activeCount).toBe(1);
    // Unchanged content repeats every five minutes so the stale date keeps moving.
    const count = pushes.length;
    await tick(60_000);
    expect(pushes).toHaveLength(count);
    await tick(4 * 60_000);
    expect(pushes).toHaveLength(count + 1);
    expect(rows()).toEqual(["garden:waiting", "kitchen:failed"]);
    await tick(FINISHED_MS);
    expect(rows()).toEqual(["garden:waiting"]);
  });

  it("shows only assistants this person sent to or follows, and a private one only to its owner", async () => {
    store.db.prepare("INSERT INTO bot_presentation VALUES(?,?,?,?)").run("secret", "two", 0, null);
    store.participate("run-k", "two");
    store.participate("run-s", "one");
    set("kitchen", "working", { runId: "run-k" });
    set("secret", "working", { runId: "run-s" });
    set("garden", "thinking", { runId: "run-g" });
    store.savePreferences("two", { ...defaultPreferences, followBots: ["garden"] });
    register("one"); register("two");
    await tick();
    const byToken = (user: string) => pushes.filter(push => push.token.startsWith(user)).at(-1)!;
    // One sent to the private assistant before it turned private; that no longer shows it.
    expect(byToken("one").payload.aps.event).toBe("end");
    expect(rows(byToken("two"))).toEqual(["kitchen:working", "garden:thinking"]);
    expect((await live.state("one")).rows).toEqual([]);
  });

  it("forgets a rejected token and backs off a failing one without losing the change", async () => {
    store.savePreferences("one", { ...defaultPreferences, followBots: ["kitchen"] });
    set("kitchen", "working");
    register("one");
    failure = new ApnsError("APNs outage", 503);
    await expect(tick()).resolves.toBeUndefined();
    expect(store.liveActivities("sandbox", clock)).toHaveLength(0);
    expect(store.liveActivities("sandbox", clock + 15_000)).toHaveLength(1);
    failure = undefined;
    await tick(15_000);
    expect(rows()).toEqual(["kitchen:working"]);
    failure = new ApnsError("Gone", 410);
    set("kitchen", "waiting");
    await tick(1000);
    expect(store.liveActivities("sandbox", clock + 3_600_000)).toHaveLength(0);
  });

  it("replays the current state when the device registers a new token", async () => {
    store.savePreferences("one", { ...defaultPreferences, followBots: ["kitchen"] });
    set("kitchen", "working");
    register("one", [], "ab".repeat(32));
    await tick();
    register("one", [], "cd".repeat(32));
    await tick(1000);
    expect(pushes.map(push => push.token)).toEqual(["ab".repeat(32), "cd".repeat(32)]);
    expect(store.liveActivities("sandbox", clock)).toHaveLength(1);
  });

  it.each([undefined, 410, 413, 400])("keeps a replacement token when old cleanup finishes with %s", async statusCode => {
    const oldToken = "ab".repeat(32), replacement = "cd".repeat(32);
    register("one", [], oldToken);
    if (statusCode) failure = new ApnsError("Old activity rejected", statusCode, "BadDeviceToken");
    duringSend = () => register("one", ["kitchen"], replacement);
    await tick();
    expect(store.liveActivities("sandbox", clock)).toMatchObject([{ token: replacement, armed: ["kitchen"], sentAt: 0 }]);
    failure = undefined; duringSend = undefined;
    await tick();
    expect(last().token).toBe(replacement);
    expect(rows()).toEqual(["kitchen:starting"]);
  });

  it("preserves device grace and observed work across foreground re-registration", async () => {
    register("one", ["kitchen"]);
    await tick();
    const initial = store.liveActivities("sandbox", clock)[0];
    await tick(15_000);
    const remembered = store.liveActivities("sandbox", clock)[0];
    register("one");
    const context = store.liveActivityContext("one", "one", "one-device")!;
    expect(context).toMatchObject({ armed: ["kitchen"], armedAt: initial.armedAt, lastState: remembered.lastState });
    expect(await live.state("one", context, context.lastState)).toMatchObject({ activeCount: 1, rows: [{ phase: "starting", since: initial.armedAt / 1000 }] });
    expect(store.liveActivityContext("two", "two", "one-device")).toBeUndefined();
    expect(store.liveActivityContext("one", "another-session", "one-device")).toBeUndefined();
    store.participate("run", "one");
    set("kitchen", "working", { runId: "run" });
    await tick(15_000);
    const working = store.liveActivities("sandbox", clock)[0];
    register("one");
    expect(store.liveActivities("sandbox", clock)[0]).toMatchObject({ lastState: working.lastState, sentState: working.sentState, sentAt: working.sentAt, armed: [] });
  });

  it("bounds Unicode and escaped content before sending and drops permanent oversized-payload failures", async () => {
    bots = Array.from({ length: 4 }, (_, i) => bot('x'.repeat(250) + i, "working", { name: '\u0000'.repeat(2000), avatar: { mode: "geometric", shape: "blob", eyes: "oval", accessory: "none", color: 'x'.repeat(8000) } }));
    store.savePreferences("one", { ...defaultPreferences, followBots: bots.map(bot => bot.id) });
    for (const bot of bots) conversations[bot.id] = { state: "working", detail: '🐎'.repeat(2000) };
    register("one");
    await tick();
    expect(Buffer.byteLength(JSON.stringify(last().payload))).toBeLessThanOrEqual(4096);
    expect(last().payload.aps["content-state"].activeCount).toBe(4);
    expect(last().payload.aps["content-state"].rows.length).toBeGreaterThan(0);
    failure = new ApnsError("PayloadTooLarge", 413);
    set(bots[0].id, "waiting");
    await tick(1000);
    expect(store.liveActivities("sandbox", clock + 3_600_000)).toHaveLength(0);
  });

  it("starts a finished assistant again without discarding another assistant's running row", async () => {
    store.savePreferences("one", { ...defaultPreferences, followBots: ["kitchen", "garden"] });
    set("kitchen", "working"); set("garden", "working");
    register("one"); await tick();
    set("kitchen", "idle"); await tick(15_000);
    expect(rows()).toEqual(["garden:working", "kitchen:done"]);
    register("one", ["kitchen"]);
    const context = store.liveActivityContext("one", "one", "one-device")!;
    const current = await live.state("one", context, context.lastState);
    expect(current.activeCount).toBe(2);
    expect(current.rows.map(row => `${row.botId}:${row.phase}`)).toContain("kitchen:starting");
    expect(current.rows.find(row => row.botId === "garden")?.since).toBe(Date.parse("2026-10-16T12:00:00Z") / 1000);
  });

  it("removes the registration with its native session", () => {
    register("one");
    store.deleteNativeSession("one");
    expect(store.liveActivities("sandbox", clock)).toHaveLength(0);
  });
});

it("sends Live Activity pushes with their own topic, push type and priority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apns-live-"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const config = { ...apns(), privateKeyFile: join(dir, "key.p8") };
  writeFileSync(config.privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const seen: { headers: Record<string, string>; body: string }[] = [];
  const sender = createApnsSender(config, async (_origin, headers, body) => { seen.push({ headers, body }); return { statusCode: 200 }; })!;
  try {
    const target = { token: "ab".repeat(32), environment: "sandbox" as const };
    await sender.liveActivity(target, { aps: { event: "update" } }, 5);
    expect(seen[0].headers).toMatchObject({ ":path": `/3/device/${target.token}`, "apns-topic": "test.agentinterface.push-type.liveactivity", "apns-push-type": "liveactivity", "apns-priority": "5" });
    expect(JSON.parse(seen[0].body)).toEqual({ aps: { event: "update" } });
    await expect(sender.liveActivity({ ...target, environment: "production" }, {}, 10)).rejects.toThrow("environment");
    await expect(sender.liveActivity(target, { detail: '🐎'.repeat(2000) }, 5)).rejects.toMatchObject({ apnsStatus: 413, reason: "PayloadTooLarge" });
    expect(seen).toHaveLength(1);
  } finally { sender.close(); rmSync(dir, { recursive: true }); }
});

it("advertises a distributed iOS build only when both settings are valid", () => {
  expect(loadConfig({}).nativeApp).toBeUndefined();
  expect(loadConfig({ IOS_APP_LATEST_BUILD: "12", IOS_APP_UPDATE_URL: "https://testflight.apple.com/join/ABCD" }).nativeApp)
    .toEqual({ latestBuild: 12, updateUrl: "https://testflight.apple.com/join/ABCD" });
  expect(() => loadConfig({ IOS_APP_LATEST_BUILD: "12" })).toThrow("together");
  expect(() => loadConfig({ IOS_APP_LATEST_BUILD: "1.2", IOS_APP_UPDATE_URL: "https://example.test" })).toThrow("whole-number");
  expect(() => loadConfig({ IOS_APP_LATEST_BUILD: "3", IOS_APP_UPDATE_URL: "http://example.test" })).toThrow("HTTPS");
  expect(() => loadConfig({ IOS_APP_LATEST_BUILD: "3", IOS_APP_UPDATE_URL: "itms-beta://x" })).toThrow("HTTPS");
});
