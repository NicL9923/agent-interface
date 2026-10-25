import { EventEmitter } from "node:events";
import http from "node:http";
import type { FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { eventStreamConnection } from "../src/server/event-stream.js";
import { GROUP_POLL_MAX_MS, GROUP_WATCHED_ROOMS, GROUP_WATCHES_PER_PERSON, GroupWatch } from "../src/server/group-watch.js";
import type { GroupRequest, GroupState } from "../src/shared/collaboration.js";
import type { Runtime } from "../src/shared/types.js";
import { botFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";
const member = (profile: string) => ({ member_id: profile, profile, handle: profile });
const state = (roomId: string, latest_seq: number, working = false): GroupState => ({
  room: { room_id: roomId, name: roomId, members: [member("ranch"), member("planner")], latest_seq },
  driver_status: { running: true, working, blocked: false, pending_actions: [] },
});
afterEach(() => { vi.useRealTimers(); });

describe("group room watcher", () => {
  it("polls each watched room once however many watch it, announcing only changes", async () => {
    vi.useFakeTimers();
    let seq = 1, working = false;
    const groupRequest = vi.fn(async (input: GroupRequest) => state((input as { roomId: string }).roomId, seq, working));
    const watch = new GroupWatch({ groupRequest });
    const first = vi.fn(), second = vi.fn(), other = vi.fn();
    const stopFirst = watch.watch("ranch", "one", first), stopSecond = watch.watch("ranch", "one", second);
    const stopOther = watch.watch("barn", "one", other);
    await vi.advanceTimersByTimeAsync(0);
    expect(groupRequest).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1); expect(other).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(groupRequest).toHaveBeenCalledTimes(4);
    expect(first).toHaveBeenCalledTimes(1);
    seq = 2;
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).toHaveBeenLastCalledWith(expect.objectContaining({ room: expect.objectContaining({ latest_seq: 2 }) }));
    expect(second).toHaveBeenCalledTimes(2);
    // A pending approval or a working driver changes without a new event.
    working = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).toHaveBeenCalledTimes(3);
    stopFirst();
    seq = 3;
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).toHaveBeenCalledTimes(3); expect(second).toHaveBeenCalledTimes(4);
    stopSecond(); stopOther();
    expect(watch.watched).toEqual([]);
    const calls = groupRequest.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(groupRequest).toHaveBeenCalledTimes(calls);
  });

  it("backs off while Hermes fails and returns to the normal pace once it answers", async () => {
    vi.useFakeTimers();
    let failing = true;
    const at: number[] = [];
    const groupRequest = vi.fn(async () => { at.push(Date.now()); if (failing) throw new Error("coordinator down"); return state("ranch", 1); });
    const watch = new GroupWatch({ groupRequest });
    const listener = vi.fn();
    watch.watch("ranch", "one", listener);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000 + 8000 + 16000 + 30000 + 30000);
    const gaps = at.slice(1).map((time, index) => time - at[index]);
    expect(gaps).toEqual([4000, 8000, 16000, GROUP_POLL_MAX_MS, GROUP_POLL_MAX_MS]);
    expect(listener).not.toHaveBeenCalled();
    failing = false;
    await vi.advanceTimersByTimeAsync(GROUP_POLL_MAX_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    const before = groupRequest.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(groupRequest).toHaveBeenCalledTimes(before + 1);
    watch.close();
  });

  it("drops a poll answered after the last watcher left", async () => {
    vi.useFakeTimers();
    let answer!: (value: GroupState) => void;
    const groupRequest = vi.fn(() => new Promise<GroupState>(resolve => { answer = resolve; }));
    const watch = new GroupWatch({ groupRequest });
    const listener = vi.fn();
    const stop = watch.watch("ranch", "one", listener);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    answer(state("ranch", 5));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listener).not.toHaveBeenCalled();
    expect(groupRequest).toHaveBeenCalledTimes(1);
  });

  it("caps each person's watches and the rooms watched in total, freeing a place when a watch ends", async () => {
    vi.useFakeTimers();
    const groupRequest = vi.fn(async (input: GroupRequest) => state((input as { roomId: string }).roomId, 1));
    const watch = new GroupWatch({ groupRequest });
    const mine = Array.from({ length: GROUP_WATCHES_PER_PERSON }, (_, index) => watch.watch(index % 2 ? "ranch" : "barn", "one", () => {}));
    expect(() => watch.watch("ranch", "one", () => {})).toThrow(expect.objectContaining({ statusCode: 429, message: expect.stringContaining("Too many group chats are open for you") }));
    // Someone else still gets in, and ending one watch frees its place. Ending it twice frees nothing more.
    const theirs = watch.watch("ranch", "two", () => {});
    mine[0](); mine[0]();
    const again = watch.watch("ranch", "one", () => {});
    expect(() => watch.watch("ranch", "one", () => {})).toThrow(expect.objectContaining({ statusCode: 429 }));
    for (const stop of [...mine, theirs, again]) stop();
    expect(watch.watched).toEqual([]);
    // Rooms beyond the total are refused for anyone, before any poll; a room already watched still takes more watchers.
    const people = Array.from({ length: GROUP_WATCHED_ROOMS }, (_, index) => watch.watch(`room-${index}`, `person-${index}`, () => {}));
    groupRequest.mockClear();
    expect(() => watch.watch("one-more", "newcomer", () => {})).toThrow(expect.objectContaining({ statusCode: 429, message: expect.stringContaining("in this household") }));
    const joined = watch.watch("room-0", "newcomer", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(groupRequest).not.toHaveBeenCalledWith({ operation: "state", roomId: "one-more" });
    expect(watch.watched).toHaveLength(GROUP_WATCHED_ROOMS);
    for (const stop of [...people, joined]) stop();
    watch.close();
  });
});

describe("watching a group chat on the app event stream", () => {
  async function setup(extra: Partial<Runtime> = {}) {
    let seq = 1;
    // A gate the next room lookup waits on, when a test sets one.
    let gate: Promise<void> | undefined;
    const rooms = [state("shared", 1).room, { ...state("private", 1).room, members: [member("ranch"), member("secret")] }];
    const groupRequest = vi.fn(async (input: GroupRequest) => {
      if (gate && input.operation === "state") { const waiting = gate; gate = undefined; await waiting; }
      return input.operation === "list" ? { supported: true, canSend: true, rooms }
        : { ...state((input as { roomId: string }).roomId, seq), room: { ...rooms.find(room => room.room_id === (input as { roomId: string }).roomId)!, latest_seq: seq } };
    });
    const runtime: Runtime = fakeRuntime({
      groupRequest, status: async () => ({ connected: true }), close: async () => {},
      capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }) as never,
      listBots: async () => [botFixture({ id: "ranch" }), botFixture({ id: "planner" }), botFixture({ id: "secret", shared: false, ownerId: "local-two" })],
      ...extra,
    });
    const { app, store } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const signIn = await fetch(`${base}/api/auth/local`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ member: "one" }) });
    const cookie = signIn.headers.getSetCookie()[0].split(";")[0];
    return { app, store, base, cookie, groupRequest, setSeq: (value: number) => { seq = value; },
      holdNextLookup: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return release; } };
  }
  const read = async (response: Response, until: (text: string) => boolean, ms = 4000) => {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    const deadline = Date.now() + ms;
    while (!until(text)) {
      if (Date.now() > deadline) throw new Error(`Stream never got there: ${JSON.stringify(text)}`);
      const chunk = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(() => resolve(null), 50))]);
      if (chunk?.done) return { text, done: true, reader };
      if (chunk) text += chunk.value;
    }
    return { text, done: false, reader };
  };

  // Sends a stream request over a real socket and disconnects once the server is handling it.
  async function abandon(s: Awaited<ReturnType<typeof setup>>, path: string) {
    const handled = new Promise<void>(resolve => s.app.server.once("request", (_request, response) => response.once("close", () => resolve())));
    const request = http.get(`${s.base}${path}`, { headers: { cookie: s.cookie } });
    request.on("error", () => {});
    await new Promise(resolve => setTimeout(resolve, 50));
    request.destroy();
    await handled;
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it("frees a watch whose client disconnected while the room was still being looked up", async () => {
    const s = await setup();
    const open: Response[] = [];
    try {
      const release = s.holdNextLookup();
      await abandon(s, "/api/events?group=shared");
      release();
      await settle();
      // The abandoned request took no place, so every one of this person's watches still opens.
      for (let index = 0; index < GROUP_WATCHES_PER_PERSON; index++) {
        const response = await fetch(`${s.base}/api/events?group=shared`, { headers: { cookie: s.cookie } });
        open.push(response);
        expect(response.status, `stream ${index + 1}`).toBe(200);
      }
    } finally {
      await Promise.all(open.map(response => response.body?.cancel()));
      await s.app.close();
    }
  });

  it("leaves no conversation watcher behind for a client that disconnected during setup", async () => {
    let release!: () => void, asked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { asked = resolve; });
    const unwatch = vi.fn();
    const watch = vi.fn(() => unwatch);
    let delay = true;
    const s = await setup({ watch,
      // The assistant access check reads Hermes's roster before the stream opens.
      listBots: async () => { if (delay) { delay = false; asked(); await held; } return [botFixture({ id: "ranch" }), botFixture({ id: "planner" })]; } });
    try {
      const abandoned = abandon(s, "/api/bots/ranch/events");
      await reached;
      await abandoned;
      release();
      await settle();
      expect(watch).not.toHaveBeenCalled();
      // A stream that does open still watches until it closes.
      const response = await fetch(`${s.base}/api/bots/ranch/events`, { headers: { cookie: s.cookie } });
      expect(response.status).toBe(200);
      expect(watch).toHaveBeenCalledTimes(1);
      await response.body?.cancel();
      await settle();
      expect(unwatch).toHaveBeenCalledTimes(1);
    } finally { await s.app.close(); }
  });

  it("announces room changes to a stream that asked for the room, and stops polling once it closes", async () => {
    const s = await setup();
    try {
      const response = await fetch(`${s.base}/api/events?group=shared`, { headers: { cookie: s.cookie } });
      expect(response.status).toBe(200);
      const first = await read(response, text => text.includes("event: group"));
      expect(first.text).toContain(`event: group\ndata: {"roomId":"shared","latestSeq":1}\n\n`);
      // The room gains someone else's private assistant: the watch ends like its routes answer 404.
      s.store.savePresentation("planner", { shared: false, ownerId: "local-two" });
      s.setSeq(2);
      let text = "";
      for (;;) {
        const chunk = await first.reader.read();
        if (chunk.done) break;
        text += chunk.value;
      }
      expect(text).not.toContain("latestSeq\":2");
      const polls = s.groupRequest.mock.calls.filter(([input]) => input.operation === "state").length;
      await new Promise(resolve => setTimeout(resolve, 2300));
      expect(s.groupRequest.mock.calls.filter(([input]) => input.operation === "state")).toHaveLength(polls);
    } finally { await s.app.close(); }
  });

  it("refuses a hidden or unknown room before opening the stream", async () => {
    const s = await setup();
    try {
      expect((await fetch(`${s.base}/api/events?group=private`, { headers: { cookie: s.cookie } })).status).toBe(404);
      expect((await fetch(`${s.base}/api/events?group=missing`, { headers: { cookie: s.cookie } })).status).toBe(404);
      expect(s.groupRequest.mock.calls.filter(([input]) => input.operation === "state")).toHaveLength(2);
      expect((await fetch(`${s.base}/api/events?group=shared`)).status).toBe(401);
    } finally { await s.app.close(); }
  });

  it("refuses a watch beyond the person's share with a clear 429, before opening the stream", async () => {
    const s = await setup();
    const open: Response[] = [];
    try {
      for (let index = 0; index < GROUP_WATCHES_PER_PERSON; index++) {
        const response = await fetch(`${s.base}/api/events?group=shared`, { headers: { cookie: s.cookie } });
        expect(response.status).toBe(200);
        open.push(response);
      }
      const refused = await fetch(`${s.base}/api/events?group=shared`, { headers: { cookie: s.cookie } });
      expect(refused.status).toBe(429);
      expect((await refused.json()).error).toContain("Too many group chats are open for you");
      // A stream without a room is not a watch and still opens.
      const roster = await fetch(`${s.base}/api/events`, { headers: { cookie: s.cookie } });
      expect(roster.status).toBe(200);
      open.push(roster);
    } finally {
      await Promise.all(open.map(response => response.body?.cancel()));
      await s.app.close();
    }
  });
});

describe("event stream setup", () => {
  // Just enough of a hijackable Fastify reply over a real ServerResponse-like emitter.
  function reply(destroyed: boolean) {
    const raw = Object.assign(new EventEmitter(), {
      destroyed, writableEnded: false, writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn(),
    });
    return { raw, hijack: vi.fn(), getHeaders: () => ({}) } as unknown as FastifyReply & { raw: typeof raw };
  }

  it("ends at once, tearing down what setup reserved, when the client already left", () => {
    const left = reply(true), streams = new Set<() => void>(), teardown = vi.fn();
    const stream = eventStreamConnection(left).open(streams, { allowed: () => true, teardown });
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(left.raw.writeHead).not.toHaveBeenCalled();
    expect(streams.size).toBe(0);
    stream.send("data: change\n\n");
    stream.end();
    expect(left.raw.write).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("notices a client that leaves while setup awaits, and ends that request without a stream", () => {
    const leaving = reply(false);
    const connection = eventStreamConnection(leaving);
    expect(connection.closed).toBe(false);
    leaving.raw.emit("close");
    expect(connection.closed).toBe(true);
    connection.abandon();
    expect(leaving.raw.destroy).toHaveBeenCalled();
    expect(leaving.raw.writeHead).not.toHaveBeenCalled();
  });
});
