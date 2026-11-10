import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { GROUP_CATALOG_POLL_MS, GROUP_CATALOG_WRITE_FLOOR_MS, GroupCatalogWatch } from "../src/server/group-catalog-watch.js";
import { stateVersion } from "../src/server/event-stream.js";
import type { GroupEvent, GroupRequest, GroupRoom } from "../src/shared/collaboration.js";
import type { Runtime } from "../src/shared/types.js";
import { botFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime, signIn } from "./helpers/server.js";

afterEach(() => { vi.useRealTimers(); });

describe("group catalog watch", () => {
  // Each person's catalog is whatever `catalogs` says now; the read counts how often Hermes is asked.
  function setup() {
    const catalogs = new Map<string, string>([["one", "a"], ["two", "b"]]);
    const read = vi.fn(async (_userIds: string[]) => {
      const now = new Map(catalogs);
      return (userId: string) => now.get(userId) ?? "";
    });
    return { catalogs, read, watch: new GroupCatalogWatch(read) };
  }

  it("shares one check every 30 seconds across streams and stops with the last one", async () => {
    vi.useFakeTimers();
    const { read, watch } = setup();
    const stops = [watch.watch("one", vi.fn()), watch.watch("one", vi.fn()), watch.watch("two", vi.fn())];
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenLastCalledWith(["one", "two"]);
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    stops[0](); stops[1]();
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith(["two"]);
    stops[2]();
    expect(watch.watching).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * GROUP_CATALOG_POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tells only the people whose catalog changed, and nobody while nothing changed", async () => {
    vi.useFakeTimers();
    const { catalogs, watch } = setup();
    const one = vi.fn(), two = vi.fn();
    watch.watch("one", one); watch.watch("two", two);
    await vi.advanceTimersByTimeAsync(0);
    expect([one.mock.calls.length, two.mock.calls.length], "the first check tells each starting stream once").toEqual([1, 1]);
    one.mockClear(); two.mockClear();
    await vi.advanceTimersByTimeAsync(3 * GROUP_CATALOG_POLL_MS);
    expect([one.mock.calls.length, two.mock.calls.length]).toEqual([0, 0]);
    catalogs.set("one", "a2");
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect([one.mock.calls.length, two.mock.calls.length]).toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect(one).toHaveBeenCalledTimes(1);
    watch.close();
  });

  it("tells a later viewer once as it joins, from the last check, then only about a later change", async () => {
    vi.useFakeTimers();
    const { catalogs, read, watch } = setup();
    watch.watch("one", vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const two = vi.fn();
    watch.watch("two", two);
    // Joining a running watch adds no read of its own, and hears at once that its catalog is known.
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
    two.mockClear();
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect(two).not.toHaveBeenCalled();
    catalogs.set("two", "b2");
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect(two).toHaveBeenCalledTimes(1);
    watch.close();
  });

  it("checks soon after a write through the app, sharing one check for a burst, then waits the full interval", async () => {
    vi.useFakeTimers();
    const { catalogs, read, watch } = setup();
    const one = vi.fn();
    watch.watch("one", one);
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_WRITE_FLOOR_MS);
    one.mockClear();
    catalogs.set("one", "sent");
    for (let index = 0; index < 5; index++) watch.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(one).toHaveBeenCalledTimes(1);
    // A write right after a check waits out the floor.
    watch.changed();
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_WRITE_FLOOR_MS - 1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS - 1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(4);
    watch.close();
    // Without a viewer a write reads nothing.
    watch.changed();
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("tells a starting stream about a change its client's own read may have missed", async () => {
    vi.useFakeTimers();
    const { catalogs, watch } = setup();
    const one = vi.fn();
    // The client read "a" as it connected; the room changed before the first check read it.
    watch.watch("one", one);
    catalogs.set("one", "a2");
    await vi.advanceTimersByTimeAsync(0);
    expect(one).toHaveBeenCalledTimes(1);
    watch.close();
  });

  it("tells a starting stream once its first successful check lands, even after Hermes failed", async () => {
    vi.useFakeTimers();
    const { read, watch } = setup();
    const one = vi.fn();
    read.mockRejectedValueOnce(new Error("coordinator down"));
    watch.watch("one", one);
    await vi.advanceTimersByTimeAsync(0);
    expect(one).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect(one).toHaveBeenCalledTimes(1);
    watch.close();
  });

  it("never runs a second Hermes read while one from before a reconnect is still running", async () => {
    vi.useFakeTimers();
    const { read, watch } = setup();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    read.mockImplementationOnce(async () => { await held; return () => "a"; });
    let running = 0, most = 0;
    const counted = read.getMockImplementation()!;
    read.mockImplementation(async (userIds: string[]) => {
      running++; most = Math.max(most, running);
      try { return await counted(userIds); } finally { running--; }
    });
    // The first read hangs; streams drop and reconnect three times meanwhile.
    for (let cycle = 0; cycle < 3; cycle++) {
      const stop = watch.watch("one", vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      stop();
    }
    const one = vi.fn();
    watch.watch("one", one);
    await vi.advanceTimersByTimeAsync(0);
    expect(read, "later checks wait for the hung read").toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
    expect(one, "the reconnected stream hears from the read that followed").toHaveBeenCalledTimes(1);
    watch.close();
  });

  it("starts a later stream fresh when a listener ended the last stream during a check", async () => {
    vi.useFakeTimers();
    const { catalogs, watch } = setup();
    let stop: () => void = () => {};
    stop = watch.watch("one", () => stop());
    // The first check tells the starting stream, whose listener ends it: nothing it saw may linger.
    await vi.advanceTimersByTimeAsync(0);
    expect(watch.watching).toBe(0);
    // The client reads "b" as it reconnects; the catalog is back to "a" by the first check.
    catalogs.set("one", "b");
    const later = vi.fn();
    watch.watch("one", later);
    catalogs.set("one", "a");
    await vi.advanceTimersByTimeAsync(0);
    expect(later).toHaveBeenCalledTimes(1);
    watch.close();
  });

  it("says nothing to a stream that ended before its joining notice", async () => {
    vi.useFakeTimers();
    const { watch } = setup();
    watch.watch("one", vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const gone = vi.fn();
    watch.watch("one", gone)();
    await vi.advanceTimersByTimeAsync(0);
    expect(gone).not.toHaveBeenCalled();
    watch.close();
  });

  // A stream that names the catalog version its client read skips the notice every stream hears once, but
  // only while the catalog is still that one: a change before the open is told, and so is one after it.
  it.each([
    ["first check", "a", 0], ["first check", "stale", 1], ["first check", "", 1],
    ["later viewer", "a", 0], ["later viewer", "stale", 1],
  ] as const)("on a %s, a stream naming version %j hears %i joining notices", async (when, named, told) => {
    vi.useFakeTimers();
    const { catalogs, watch } = setup();
    if (when === "later viewer") { watch.watch("two", vi.fn()); await vi.advanceTimersByTimeAsync(0); }
    const one = vi.fn();
    watch.watch("one", one, named === "a" ? stateVersion("a") : named);
    await vi.advanceTimersByTimeAsync(0);
    expect(one).toHaveBeenCalledTimes(told);
    catalogs.set("one", "a2");
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect(one, "a later change is told either way").toHaveBeenCalledTimes(told + 1);
    watch.close();
  });

  it("keeps what it saw when Hermes fails, and tries again at the next check", async () => {
    vi.useFakeTimers();
    const { catalogs, read, watch } = setup();
    const one = vi.fn();
    watch.watch("one", one);
    await vi.advanceTimersByTimeAsync(0);
    one.mockClear();
    read.mockRejectedValueOnce(new Error("coordinator down"));
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect(one).not.toHaveBeenCalled();
    catalogs.set("one", "a2");
    await vi.advanceTimersByTimeAsync(GROUP_CATALOG_POLL_MS);
    expect(one).toHaveBeenCalledTimes(1);
    watch.close();
  });
});

describe("groups notices on the household stream", () => {
  const origin = "https://app.example.invalid";
  const member = (profile: string) => ({ member_id: profile, profile, handle: profile, display_name: profile });
  async function setup() {
    // "secret" is one's personal assistant, so only one can open the room it is in.
    const rooms: GroupRoom[] = [
      { room_id: "shared", name: "Supper", members: [member("ranch"), member("planner")], latest_seq: 1 },
      { room_id: "private", name: "Taxes", members: [member("ranch"), member("secret")], latest_seq: 1 },
    ];
    const logs = new Map<string, GroupEvent[]>(rooms.map(room => [room.room_id, []]));
    const post = (roomId: string, text: string, kind = "message.member") => {
      const room = rooms.find(item => item.room_id === roomId)!;
      room.latest_seq = (room.latest_seq ?? 0) + 1;
      const event: GroupEvent = { event_id: `${roomId}-${room.latest_seq}`, seq: room.latest_seq, kind, created_at: 1_800_000_000,
        actor: { kind: "member", id: "ranch" }, payload: { text, member_id: "ranch" } };
      logs.get(roomId)!.push(event);
      return event;
    };
    const groupRequest = vi.fn(async (input: GroupRequest) => {
      if (input.operation === "list") return { supported: true, canSend: true, rooms: structuredClone(rooms) };
      if (input.operation === "log") return { events: logs.get(input.roomId)!.filter(event => event.seq > input.since), cursor: 0, latest_seq: 0, has_more: false };
      if (input.operation === "send") return { event: post(input.roomId, input.text, "message.user") };
      const room = rooms.find(item => item.room_id === (input as { roomId: string }).roomId);
      if (!room) throw Object.assign(new Error("Group chat not found"), { statusCode: 404 });
      return { room: structuredClone(room), driver_status: { running: true, working: false, blocked: false, pending_actions: [] } };
    });
    const runtime: Runtime = fakeRuntime({
      groupRequest, status: async () => ({ connected: true }), close: async () => {},
      capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }) as never,
      listBots: async () => [botFixture({ id: "ranch" }), botFixture({ id: "planner" }), botFixture({ id: "secret", shared: false, ownerId: "one" })],
    });
    const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, APP_DATABASE: ":memory:",
      GOOGLE_CLIENT_ID: "fixture-client", HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid" });
    const { app, store } = await createApp(config, runtime, { background: false });
    store.savePresentation("secret", { shared: false, ownerId: "one" });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const one = signIn(store, origin, "one"), two = signIn(store, origin, "two");
    const lists = () => groupRequest.mock.calls.filter(([input]) => input.operation === "list").length;
    return { app, base, one, two, post, lists, rooms };
  }
  // Reads a stream as it arrives, so a test can check what it has said so far.
  async function listen(base: string, path: string, headers: Record<string, string>) {
    const response = await fetch(`${base}${path}`, { headers: { cookie: headers.cookie } });
    expect(response.status).toBe(200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const heard = { text: "", close: () => reader.cancel() };
    void (async () => { for (;;) { const chunk = await reader.read(); if (chunk.done) return; heard.text += chunk.value; } })().catch(() => {});
    return heard;
  }
  // Only the check's timer is virtual. Sockets stay real, so time moves in small steps that let them work.
  async function wait(ms: number) {
    for (let passed = 0; passed <= ms; passed += 250) {
      await vi.advanceTimersByTimeAsync(Math.min(250, ms - passed));
      for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
    }
  }
  const notices = (heard: { text: string }) => heard.text.split("event: groups\ndata: groups\n\n").length - 1;

  it("tells each person when a room they can open changes outside the app, never about one they cannot", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const one = await listen(s.base, "/api/events", s.one), two = await listen(s.base, "/api/events", s.two);
      // A stream that watches a room hears catalog changes too.
      const room = await listen(s.base, "/api/events?group=shared", s.two);
      await wait(GROUP_CATALOG_POLL_MS);
      expect(s.lists(), "one shared check, then one per interval").toBeLessThanOrEqual(2);
      // Each stream hears once as its first check lands, in case its client's read missed a change.
      expect([notices(one), notices(two), notices(room)]).toEqual([1, 1, 1]);
      s.post("shared", "The smoker is free Sunday.");
      await wait(GROUP_CATALOG_POLL_MS);
      expect([notices(one), notices(two), notices(room)]).toEqual([2, 2, 2]);
      s.post("private", "The receipts are filed.");
      await wait(GROUP_CATALOG_POLL_MS);
      expect([notices(one), notices(two), notices(room)]).toEqual([3, 2, 2]);
      // A renamed room is a change; a quiet interval is not.
      s.rooms[0].name = "Sunday supper";
      await wait(2 * GROUP_CATALOG_POLL_MS);
      expect([notices(one), notices(two), notices(room)]).toEqual([4, 3, 3]);
      await Promise.all([one.close(), two.close(), room.close()]);
      await wait(1000);
      const reads = s.lists();
      await wait(3 * GROUP_CATALOG_POLL_MS);
      expect(s.lists(), "no stream, no checks").toBe(reads);
    } finally { vi.useRealTimers(); await s.app.close(); }
  });

  // GET /api/groups names the version the stream compares, so a client that read the catalog and opens naming it
  // hears no connect notice until the catalog changes. A change Hermes made before the open, which no check has
  // seen yet, reaches it at the next check, as it reaches every open stream.
  it("sends the connect notice only when the catalog the client names is no longer current", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const read = await (await fetch(`${s.base}/api/groups`, { headers: { cookie: s.one.cookie } })).json() as { version?: string };
      expect(read.version).toMatch(/^[\w-]{22}$/);
      const current = await listen(s.base, `/api/events?groups=${read.version}`, s.one);
      await wait(GROUP_CATALOG_WRITE_FLOOR_MS);
      expect(notices(current), "nothing changed since the read").toBe(0);
      s.post("shared", "The smoker is free Sunday.");
      const stale = await listen(s.base, `/api/events?groups=${read.version}`, s.one);
      await wait(GROUP_CATALOG_POLL_MS);
      expect([notices(current), notices(stale)]).toEqual([1, 1]);
      await Promise.all([current.close(), stale.close()]);
    } finally { vi.useRealTimers(); await s.app.close(); }
  });

  it("tells a device that connects while another is open at once, with no extra Hermes read", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const phone = await listen(s.base, "/api/events", s.one);
      await wait(GROUP_CATALOG_WRITE_FLOOR_MS);
      expect(notices(phone)).toBe(1);
      const reads = s.lists();
      const laptop = await listen(s.base, "/api/events", s.one);
      await wait(500);
      expect(notices(laptop)).toBe(1);
      expect([notices(phone), s.lists()]).toEqual([1, reads]);
      await Promise.all([phone.close(), laptop.close()]);
    } finally { vi.useRealTimers(); await s.app.close(); }
  });

  it("tells everyone who can open the room as soon as a message is sent through the app", async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const two = await listen(s.base, "/api/events", s.two);
      await wait(GROUP_CATALOG_WRITE_FLOOR_MS);
      expect(notices(two), "the first check").toBe(1);
      const sent = await fetch(`${s.base}/api/groups/shared/messages`, { method: "POST",
        headers: { ...s.one, "content-type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), text: "Bring the brisket", threadId: "main" }) });
      expect(sent.status).toBe(200);
      await wait(GROUP_CATALOG_WRITE_FLOOR_MS);
      expect(notices(two)).toBe(2);
      await two.close();
    } finally { vi.useRealTimers(); await s.app.close(); }
  });
});
