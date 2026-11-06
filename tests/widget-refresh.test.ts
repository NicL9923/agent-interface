import { beforeEach, describe, expect, it } from "vitest";
import { ApnsError, type NativeDevice } from "../src/server/apns.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { WIDGET_CHECK_MS, WIDGET_REFRESH_MS, WidgetRefresh } from "../src/server/widget-refresh.js";
import { defaultPreferences, type ActivityState, type Bot } from "../src/shared/types.js";

let clock: number, store: Store, bots: Bot[], woken: string[], failure: Error | undefined, widgets: WidgetRefresh;
const bot = (id: string, activity: ActivityState = "idle", extra: Partial<Bot> = {}): Bot => ({ id, name: id, shared: true, model: "test", activity, ...extra });
const set = (id: string, extra: Partial<Bot>) => { bots = bots.map(value => value.id === id ? { ...value, ...extra } : value); };
const tick = async (ms = WIDGET_CHECK_MS) => { clock += ms; await widgets.tick(); };

beforeEach(() => {
  clock = Date.parse("2026-11-06T12:00:00Z");
  store = new Store(":memory:");
  for (const id of ["one", "two"]) {
    store.user({ id, name: id, email: `${id}@example.test` });
    store.nativeSession(id, id, Date.now() + 7 * 86400000);
    store.registerNativeDevice(id, id, `${id}-phone`, id.repeat(32).slice(0, 64), "sandbox");
  }
  bots = [bot("kitchen"), bot("garden")];
  woken = []; failure = undefined;
  const config = loadConfig({ HOUSEHOLD_EMAILS: "one@example.test,two@example.test" });
  config.apns = { teamId: "TEAM123456", keyId: "KEY1234567", topic: "test.agentinterface", privateKeyFile: "unused", environment: "sandbox" };
  widgets = new WidgetRefresh(store, { listBots: async () => bots }, config, async (device: NativeDevice) => {
    if (failure) throw failure;
    woken.push(device.deviceId);
  }, undefined, () => clock);
});

describe("widget refresh pushes", () => {
  it("wakes a phone when what its widgets show changes, at most once per window", async () => {
    // Devices first seen since the server started are not all woken at once.
    await tick();
    expect(woken).toEqual([]);
    set("kitchen", { activity: "waiting" });
    await tick();
    expect(woken.sort()).toEqual(["one-phone", "two-phone"]);
    // A change inside the window waits for it to end, then goes out once.
    set("kitchen", { activity: "working" });
    await tick();
    set("kitchen", { activity: "idle", lastMessage: { text: "Dinner is planned.", at: new Date(clock).toISOString() } });
    await tick(WIDGET_REFRESH_MS - 2 * WIDGET_CHECK_MS);
    expect(woken).toHaveLength(2);
    await tick();
    expect(woken).toHaveLength(4);
    // Nothing changed, nothing sent.
    await tick(WIDGET_REFRESH_MS);
    expect(woken).toHaveLength(4);
  });

  it("compares the roster no more often than every check interval", async () => {
    await tick();
    set("kitchen", { activity: "working" });
    await tick(WIDGET_CHECK_MS - 1);
    expect(woken).toEqual([]);
    await tick(1);
    expect(woken).toHaveLength(2);
  });

  it("wakes only the person whose view changed: a pin, or a private assistant only its owner sees", async () => {
    await tick();
    store.savePreferences("one", { ...defaultPreferences, favorites: ["garden"] });
    await tick();
    expect(woken).toEqual(["one-phone"]);
    store.savePresentation("garden", { shared: false, ownerId: "two" });
    set("garden", { activity: "working" });
    await tick(WIDGET_REFRESH_MS);
    // One loses the assistant; two sees it start working. Both views changed.
    expect(woken.slice(1).sort()).toEqual(["one-phone", "two-phone"]);
    set("garden", { activity: "idle" });
    await tick(WIDGET_REFRESH_MS);
    expect(woken.slice(3)).toEqual(["two-phone"]);
  });

  it("forgets a device Apple says is gone and backs off any other failure", async () => {
    await tick();
    failure = new ApnsError("Unregistered", 410);
    set("kitchen", { activity: "working" });
    await tick();
    expect(store.nativeDevices("one", "sandbox")).toHaveLength(0);
    failure = new Error("Temporary outage");
    store.registerNativeDevice("one", "one", "one-phone", "aa".repeat(32), "sandbox");
    store.registerNativeDevice("two", "two", "two-phone", "bb".repeat(32), "sandbox");
    await tick();
    set("kitchen", { activity: "idle" });
    await tick();
    failure = undefined;
    // The failed attempt counts against the window, so the outage is not hammered every pass.
    await tick();
    expect(woken).toEqual([]);
    await tick(WIDGET_REFRESH_MS);
    expect(woken.sort()).toEqual(["one-phone", "two-phone"]);
  });

  it("stays quiet without APNs or devices, and for people no longer in the household", async () => {
    store.removeNativeDevice("one", "one-phone");
    store.removeNativeDevice("two", "two-phone");
    await tick();
    set("kitchen", { activity: "working" });
    await tick();
    expect(woken).toEqual([]);
  });
});
