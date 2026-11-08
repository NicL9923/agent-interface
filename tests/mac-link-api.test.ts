import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { GRACE_MS, MacBroker, MAX_IN_FLIGHT, STALE_MS, type MacState } from "../src/server/mac-link.js";
import { Store } from "../src/server/store.js";
import { fakeRuntime } from "./helpers/server.js";

const origin = "http://127.0.0.1:3000";
const key = randomBytes(32).toString("base64url");
const opened: { app: { close(): Promise<unknown> } }[] = [];
afterEach(async () => { for (const { app } of opened.splice(0)) await app.close(); vi.useRealTimers(); });

const ready: MacState = { paused: false, screenLocked: false, screenPermission: "granted", folders: [{ name: "dev", path: "/Users/one/dev" }],
  grants: [{ assistantId: "patch", abilities: ["files_read", "run"], unattended: false }] };

async function setup(env: Record<string, string> = { MAC_LINK_KEY: key }) {
  const created = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_ORIGIN: origin, APP_DATABASE: ":memory:", ...env }),
    fakeRuntime({ close: async () => {} }), { background: false });
  opened.push(created);
  const { app, store } = created;
  for (const id of ["local-one", "local-two"]) store.user({ id, name: id, email: `${id.slice(6)}@localhost.invalid` });
  store.savePresentation("patch", { shared: false, ownerId: "local-one" });
  store.savePresentation("diary", { shared: false, ownerId: "local-two" });
  store.savePresentation("family", { shared: true });
  // Shared by its owner: everyone uses it, so it may not reach the owner's Mac.
  store.savePresentation("ranch", { shared: true, ownerId: "local-one" });
  store.savePresentation("legacy", { shared: false });
  /** Bearer headers for a native session, confirmed `confirmedAgo` ms ago, or never when null. */
  const native = (userId = "local-one", confirmedAgo: number | null = 0) => {
    const token = randomBytes(32).toString("base64url");
    store.nativeSession(hash(token), userId, Date.now() + 600_000);
    if (confirmedAgo !== null) store.confirmNativeSession(hash(token), Date.now() - confirmedAgo);
    return { authorization: `Bearer ${token}`, "user-agent": "fixture-mac" };
  };
  const enroll = async (name = "Studio", userId = "local-one") => {
    const response = await app.inject({ method: "POST", url: "/api/mac/devices", headers: native(userId), payload: { name } });
    expect(response.statusCode).toBe(201);
    return response.json() as { deviceId: string; credential: string };
  };
  // A real listener and client: a refused link closes during its handshake, which injected sockets never report.
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  /** A linked Mac's socket; the test plays the Mac. */
  const connect = async (mac: { deviceId: string; credential: string }, state: MacState | null = ready) => {
    const socket = new WebSocket(`${address.replace("http", "ws")}/api/mac/link`, { headers: { authorization: `Device ${mac.deviceId}.${mac.credential}` } });
    const closing = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
    const inbox: Record<string, unknown>[] = [];
    socket.on("message", data => inbox.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const next = (type: string) => vi.waitFor(() => {
      const index = inbox.findIndex(message => message.type === type);
      if (index < 0) throw new Error(`no ${type} yet`);
      return inbox.splice(index, 1)[0];
    });
    if (state) {
      socket.send(JSON.stringify({ type: "hello", protocol: 1, appVersion: "1.0", state }));
      await next("welcome");
    }
    return { socket, closing, next, send: (message: object) => socket.send(JSON.stringify(message)) };
  };
  const closed = (socket: WebSocket) => new Promise<number>(resolve => socket.once("close", code => resolve(code)));
  const invoke = (body: object, headers: Record<string, string> = { authorization: `Bearer ${key}` }, remoteAddress = "127.0.0.1") =>
    app.inject({ method: "POST", url: "/api/agent-link/mac", headers, remoteAddress,
      payload: { invocationId: "inv-" + randomBytes(6).toString("hex"), assistantId: "patch", scheduled: false, action: "list", args: {}, ...body } });
  return { app, store, native, enroll, connect, closed, invoke };
}

describe("configuration", () => {
  it("accepts only a generated key of its own", () => {
    expect(loadConfig({}).macLinkKey).toBeUndefined();
    expect(loadConfig({ MAC_LINK_KEY: key }).macLinkKey).toBe(key);
    for (const env of [{ MAC_LINK_KEY: "short" }, { MAC_LINK_KEY: key.slice(0, 42) + "!" }, { MAC_LINK_KEY: key, HERMES_TOKEN: key }])
      expect(() => loadConfig(env)).toThrow("MAC_LINK_KEY must be its own");
  });
});

describe("linking a Mac", () => {
  it("enrolls only from a recently confirmed native session, with a credential shown once", async () => {
    const s = await setup();
    const login = await s.app.inject({ method: "POST", url: "/api/auth/local", headers: { origin }, payload: { member: "one" } });
    const web = { origin, cookie: `session=${login.cookies[0].value}`, "x-csrf-token": login.json().csrfToken };
    const attempt = (headers: Record<string, string>, payload: object = { name: "Studio" }) =>
      s.app.inject({ method: "POST", url: "/api/mac/devices", headers, payload });
    expect((await attempt(web)).json()).toMatchObject({ code: "native_required" });
    expect((await attempt(s.native("local-one", null))).json()).toMatchObject({ code: "confirmation_required" });
    expect((await attempt(s.native("local-one", 2 * 3600_000 + 1000))).json()).toMatchObject({ code: "confirmation_required" });
    for (const payload of [{ name: "" }, { name: "x".repeat(65) }, { name: "Studio", deviceId: "mac_reuse" }])
      expect((await attempt(s.native(), payload)).statusCode).toBe(400);
    const enrolled = await attempt(s.native(), { name: "Studio", model: "Mac16,7", osVersion: "27.0.1", appVersion: "1.0" });
    expect(enrolled.statusCode).toBe(201);
    const { deviceId, credential } = enrolled.json();
    expect(deviceId).toMatch(/^mac_[A-Za-z0-9_-]{22}$/);
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const listing = await s.app.inject({ url: "/api/mac/devices", headers: web });
    expect(listing.json()).toMatchObject({ available: true, devices: [{ id: deviceId, name: "Studio", model: "Mac16,7", online: false, lastSeenAt: null }] });
    expect(listing.body).not.toContain(credential);
    // Only a hash is stored.
    expect(JSON.stringify(s.store.db.prepare("SELECT * FROM mac_devices").all())).not.toContain(credential);
  });

  it("refuses enrollment while links are off and lists them as unavailable", async () => {
    const s = await setup({});
    expect((await s.app.inject({ method: "POST", url: "/api/mac/devices", headers: s.native(), payload: { name: "Studio" } })).json())
      .toMatchObject({ code: "link_unavailable" });
    expect((await s.app.inject({ url: "/api/mac/devices", headers: s.native() })).json()).toMatchObject({ available: false, devices: [] });
  });

  it("caps each person at five Macs", async () => {
    const s = await setup();
    for (let index = 0; index < 5; index++) await s.enroll(`Mac ${index}`);
    expect((await s.app.inject({ method: "POST", url: "/api/mac/devices", headers: s.native(), payload: { name: "Sixth" } })).json())
      .toMatchObject({ code: "mac_limit" });
    // Another member has their own five.
    await s.enroll("Theirs", "local-two");
  });

  it("revokes only the person's own Mac, disconnects it and never accepts its credential again", async () => {
    const s = await setup();
    const mac = await s.enroll();
    const link = await s.connect(mac);
    const other = await s.app.inject({ method: "DELETE", url: `/api/mac/devices/${mac.deviceId}`, headers: s.native("local-two") });
    expect(other.json()).toMatchObject({ code: "mac_not_found" });
    const closing = s.closed(link.socket);
    expect((await s.app.inject({ method: "DELETE", url: `/api/mac/devices/${mac.deviceId}`, headers: s.native() })).json()).toEqual({ ok: true });
    await link.next("revoked");
    expect(await closing).toBe(4401);
    const again = await s.connect(mac, null);
    expect(await again.closing).toBe(4401);
    expect((await s.app.inject({ url: "/api/mac/devices", headers: s.native() })).json().devices).toEqual([]);
  });
});

describe("a Mac unlinking itself", () => {
  it("revokes only with its own device credential, and leaves the owner's list at once", async () => {
    const s = await setup();
    const mac = await s.enroll();
    const device = `Device ${mac.deviceId}.${mac.credential}`;
    const unlink = (headers: Record<string, string>) => s.app.inject({ method: "DELETE", url: "/api/mac/link", headers });
    const refused: Record<string, string>[] = [{}, { authorization: `Device ${mac.deviceId}.${"C".repeat(43)}` }, { authorization: device, origin },
      { authorization: s.native().authorization }];
    for (const headers of refused)
      expect({ headers, status: (await unlink(headers)).statusCode }).toEqual({ headers, status: 401 });
    expect((await unlink({ authorization: device })).json()).toEqual({ ok: true });
    expect((await s.app.inject({ url: "/api/mac/devices", headers: s.native() })).json().devices).toEqual([]);
    expect((await unlink({ authorization: device })).statusCode).toBe(401);
  });
});

describe("the link socket", () => {
  it("never upgrades without a device credential, from a browser, or with a session token", async () => {
    const s = await setup();
    const mac = await s.enroll();
    const device = `Device ${mac.deviceId}.${mac.credential}`;
    for (const headers of [{}, { authorization: s.native().authorization }, { authorization: device, origin }, { authorization: device, cookie: "session=x" }])
      await expect(s.app.injectWS("/api/mac/link", { headers })).rejects.toThrow("401");
  });

  it("closes with the reason the app acts on", async () => {
    const s = await setup();
    const unknown = await s.connect({ deviceId: "mac_" + "A".repeat(22), credential: "B".repeat(43) }, null);
    expect(await unknown.closing).toBe(4401);
    const mac = await s.enroll();
    const wrong = await s.connect({ deviceId: mac.deviceId, credential: "C".repeat(43) }, null);
    expect(await wrong.closing).toBe(4401);
    // A Mac whose owner is not a household member.
    s.store.user({ id: "local-three", name: "Three", email: "three@localhost.invalid" });
    const outsider = s.store.macs.enroll("local-three", { name: "Outside" })!;
    const refused = await s.connect({ deviceId: outsider.device.id, credential: outsider.credential }, null);
    expect(await refused.closing).toBe(4403);
    const off = await setup({});
    const offMac = off.store.macs.enroll("local-one", { name: "Studio" })!;
    const disabled = await off.connect({ deviceId: offMac.device.id, credential: offMac.credential }, null);
    expect(await disabled.closing).toBe(4404);
  });

  it("requires a supported hello first and well-formed messages", async () => {
    const s = await setup();
    const mac = await s.enroll();
    const cases: [object | string, number][] = [
      [{ type: "hello", protocol: 2, state: ready }, 4400],
      [{ type: "state", state: ready }, 1008],
      ["not json", 1007],
      [{ type: "hello", protocol: 1, state: { ...ready, grants: [{ assistantId: "patch", abilities: ["everything"], unattended: true }] } }, 1007],
    ];
    for (const [message, code] of cases) {
      const link = await s.connect(mac, null);
      const closing = s.closed(link.socket);
      link.socket.send(typeof message === "string" ? message : JSON.stringify(message));
      expect({ message, code: await closing }).toEqual({ message, code });
    }
  });

  it("lets a newer socket replace an older one without the old close taking the Mac offline", async () => {
    const s = await setup();
    const mac = await s.enroll();
    const first = await s.connect(mac);
    const replaced = s.closed(first.socket);
    const second = await s.connect(mac);
    expect(await replaced).toBe(4409);
    const call = s.invoke({ action: "read_file", args: { path: "~/dev/a.txt" } });
    const sent = await second.next("invoke");
    second.send({ type: "result", id: sent.id, ok: true, value: { content: "a" } });
    expect((await call).json()).toEqual({ ok: true, value: { content: "a" } });
  });
});

describe("assistant requests from Hermes", () => {
  it("accepts only the link key from a direct local process", async () => {
    const s = await setup();
    const bearer = { authorization: `Bearer ${key}` };
    const refusals: [Record<string, string>, string?][] = [
      [{}], [{ authorization: `Bearer ${"A".repeat(43)}` }], [{ authorization: key }],
      [{ ...bearer, "x-forwarded-for": "203.0.113.9" }], [{ ...bearer, forwarded: "for=203.0.113.9" }],
      [{ ...bearer, origin }], [{ ...bearer, cookie: "session=x" }], [bearer, "100.100.0.8"],
    ];
    for (const [headers, remote] of refusals)
      expect({ headers, remote, status: (await s.invoke({}, headers, remote)).statusCode }).toEqual({ headers, remote, status: 401 });
    const off = await setup({});
    expect((await off.invoke({}, bearer)).statusCode).toBe(401);
    // A native session token is not the link key, even on the right route.
    expect((await s.invoke({}, { authorization: s.native().authorization })).statusCode).toBe(401);
  });

  it("names the field that is wrong", async () => {
    const s = await setup();
    for (const [body, field] of [[{ invocationId: "x" }, "invocationId"], [{ action: "erase" }, "action"], [{ scheduled: "no" }, "scheduled"],
      [{ assistantId: "" }, "assistantId"], [{ extra: true }, ""]] as const) {
      const response = await s.invoke(body);
      expect(response.statusCode).toBe(400);
      expect(response.json().issues).toContain(field);
    }
  });

  it("serves only the owner's personal assistants", async () => {
    const s = await setup();
    await s.enroll();
    for (const assistantId of ["family", "ranch", "legacy", "nobody-knows"])
      expect((await s.invoke({ assistantId })).json().error.code).toBe("assistant_not_personal");
    // Another member's personal assistant sees only that member's Macs, which here are none.
    expect((await s.invoke({ assistantId: "diary", action: "read_file", args: { path: "a" } })).json().error.code).toBe("no_mac");
    expect((await s.invoke({ assistantId: "diary" })).json()).toEqual({ ok: true, value: { macs: [] } });
  });

  it("lists the owner's Macs with what this assistant may do on each", async () => {
    const s = await setup();
    const studio = await s.enroll("Studio");
    await s.enroll("Laptop");
    await s.connect(studio, { ...ready, grants: [...ready.grants, { assistantId: "other", abilities: ["screenshot"], unattended: true }] });
    const listed = (await s.invoke({})).json();
    expect(listed.value.macs).toEqual([
      { name: "Studio", online: true, lastSeenAt: expect.any(String), paused: false, screenLocked: false, folders: ready.folders, allowed: ["files_read", "run"], unattended: false },
      { name: "Laptop", online: false, lastSeenAt: null },
    ]);
    // An assistant the Mac allows nothing learns it is there, not what is on it.
    s.store.savePresentation("notes", { shared: false, ownerId: "local-one" });
    expect((await s.invoke({ assistantId: "notes" })).json().value.macs[0]).toMatchObject({ name: "Studio", folders: [], allowed: [] });
  });

  it("chooses a Mac only when the choice is unambiguous", async () => {
    const s = await setup();
    const studio = await s.enroll("Studio");
    await s.enroll("Laptop");
    const read = { action: "read_file", args: { path: "a" } };
    expect((await s.invoke(read)).json().error).toMatchObject({ code: "choose_mac", macs: ["Studio", "Laptop"] });
    expect((await s.invoke({ ...read, device: "Kitchen" })).json().error).toMatchObject({ code: "choose_mac", macs: ["Studio", "Laptop"] });
    expect((await s.invoke({ ...read, device: "laptop" })).json().error).toMatchObject({ code: "mac_offline", lastSeenAt: null });
    const link = await s.connect(studio);
    const call = s.invoke({ ...read, device: "studio" });
    const sent = await link.next("invoke");
    link.send({ type: "result", id: sent.id, ok: false, error: { code: "not_found", message: "No such file" } });
    expect((await call).json()).toEqual({ ok: false, error: { code: "not_found", message: "No such file" } });
  });

  it("refuses early what the Mac's grants refuse, and says why", async () => {
    const s = await setup();
    const mac = await s.enroll();
    const link = await s.connect(mac);
    const cases: [object, string][] = [
      [{ action: "write_file", args: { path: "a", content: "b" } }, "not_allowed"],
      [{ action: "screenshot" }, "not_allowed"],
      [{ action: "run", scheduled: true, args: { command: "ls" } }, "unattended_not_allowed"],
      [{ action: "run", args: { command: "ls", timeoutSeconds: 601 } }, "invalid_arguments"],
      [{ action: "run", args: { command: "ls", timeoutSeconds: 1.5 } }, "invalid_arguments"],
    ];
    for (const [body, code] of cases) expect({ body, code: (await s.invoke(body)).json().error.code }).toEqual({ body, code });
    link.send({ type: "state", state: { ...ready, paused: true } });
    await vi.waitFor(async () => expect((await s.invoke({ action: "read_file", args: { path: "a" } })).json().error.code).toBe("paused"));
  });

  it("sends the Mac what the assistant asked, with its timeout, and returns the Mac's answer", async () => {
    const s = await setup();
    const mac = await s.enroll();
    const link = await s.connect(mac, { ...ready, grants: [{ assistantId: "patch", abilities: ["run"], unattended: true }] });
    const call = s.invoke({ invocationId: "inv-run-0001", assistantName: "Patch", scheduled: true, action: "run", args: { command: "uptime", timeoutSeconds: 30 } });
    expect(await link.next("invoke")).toEqual({ type: "invoke", id: "inv-run-0001", assistantId: "patch", assistantName: "Patch", scheduled: true,
      action: "run", args: { command: "uptime", timeoutSeconds: 30 }, timeoutMs: 30_000 });
    link.send({ type: "result", id: "inv-run-0001", ok: true, value: { exitCode: 0, stdout: "up" } });
    expect((await call).json()).toEqual({ ok: true, value: { exitCode: 0, stdout: "up" } });
    expect(await link.next("ack")).toEqual({ type: "ack", id: "inv-run-0001" });
    // A result nobody waits for any more is still acknowledged, so the Mac stops resending it.
    link.send({ type: "result", id: "inv-long-gone", ok: true, value: {} });
    expect(await link.next("ack")).toEqual({ type: "ack", id: "inv-long-gone" });
  });

  it("shortens a long error and fails, without dropping the link, a result it cannot read", async () => {
    const s = await setup();
    const mac = await s.enroll();
    const link = await s.connect(mac);
    const long = s.invoke({ action: "read_file", args: { path: "x".repeat(4096) } });
    const first = await link.next("invoke");
    link.send({ type: "result", id: first.id, ok: false, error: { code: "outside_folders", message: "Outside: " + "x".repeat(4096) } });
    const error = (await long).json().error;
    expect(error.code).toBe("outside_folders");
    expect(error.message).toHaveLength(4000);
    expect(await link.next("ack")).toEqual({ type: "ack", id: first.id });
    const garbled = s.invoke({ action: "read_file", args: { path: "a" } });
    const second = await link.next("invoke");
    link.send({ type: "result", id: second.id, ok: false, error: { code: "Not A Code", message: "x" } });
    expect((await garbled).json().error.code).toBe("failed");
    expect(await link.next("ack")).toEqual({ type: "ack", id: second.id });
    expect(link.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps waiting across a reconnect for the result the Mac resends", async () => {
    const s = await setup();
    const mac = await s.enroll();
    const first = await s.connect(mac);
    const call = s.invoke({ action: "run", args: { command: "make" } });
    const sent = await first.next("invoke");
    const gone = s.closed(first.socket);
    first.socket.close();
    await gone;
    const second = await s.connect(mac);
    second.send({ type: "result", id: sent.id, ok: true, value: { exitCode: 0 } });
    expect((await call).json()).toEqual({ ok: true, value: { exitCode: 0 } });
    expect(await second.next("ack")).toEqual({ type: "ack", id: sent.id });
  });
});

/** A socket double for broker timing tests: the I/O edge, with real broker logic. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  closedWith?: number;
  terminated = false;
  pings = 0;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  ping() { this.pings++; }
  close(code: number) { this.closedWith = code; this.readyState = WebSocket.CLOSED; this.emit("close", code); }
  terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; this.emit("close", 1006); }
  hello(state: MacState = ready) { this.emit("message", Buffer.from(JSON.stringify({ type: "hello", protocol: 1, state })), false); }
}

describe("broker timing", () => {
  function broker() {
    vi.useFakeTimers();
    const store = new Store(":memory:");
    const config = loadConfig({ LOCAL_DEV_AUTH: "true", APP_ORIGIN: origin, MAC_LINK_KEY: key });
    store.user({ id: "local-one", name: "One", email: "one@localhost.invalid" });
    store.savePresentation("patch", { shared: false, ownerId: "local-one" });
    const log = { info: vi.fn() } as unknown as ConstructorParameters<typeof MacBroker>[2];
    const macs = new MacBroker(store, config, log);
    const device = store.macs.enroll("local-one", { name: "Studio" })!.device;
    const socket = new FakeSocket();
    macs.attach(device, socket as unknown as WebSocket);
    socket.hello();
    let next = 0;
    const call = (action = "read_file", args: Record<string, unknown> = { path: "a" }) =>
      macs.invoke({ invocationId: `inv-timing-${next++}`, assistantId: "patch", scheduled: false, action: action as "read_file", args });
    return { store, macs, device, socket, call };
  }

  it("answers uncertain when the Mac never reports back before the deadline", async () => {
    const b = broker();
    const call = b.call("run", { command: "sleep 5", timeoutSeconds: 5 });
    await vi.advanceTimersByTimeAsync(5_000 + GRACE_MS - 1);
    let settled = false;
    void call.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await call)).toMatchObject({ ok: false, error: { code: "uncertain" } });
    b.macs.close();
  });

  it("allows four actions at once per Mac and refuses a reused invocation ID", async () => {
    const b = broker();
    const calls = Array.from({ length: MAX_IN_FLIGHT }, () => b.call());
    expect(await b.call()).toMatchObject({ ok: false, error: { code: "mac_busy" } });
    const first = b.socket.sent.find(message => message.type === "invoke")!;
    b.socket.emit("message", Buffer.from(JSON.stringify({ type: "result", id: first.id, ok: true, value: {} })), false);
    expect(await calls[0]).toEqual({ ok: true, value: {} });
    const reused = await b.macs.invoke({ invocationId: "inv-timing-1", assistantId: "patch", scheduled: false, action: "read_file", args: {} });
    expect(reused).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    b.macs.close();
  });

  it("drops a silent link, and one whose owner left the household or unlinked it", async () => {
    const b = broker();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(b.socket.pings).toBe(1);
    await vi.advanceTimersByTimeAsync(STALE_MS);
    expect(b.socket.terminated).toBe(true);
    expect(b.macs.online(b.device.id)).toBe(false);
    const next = new FakeSocket();
    b.macs.attach(b.device, next as unknown as WebSocket);
    next.hello();
    b.store.macs.revoke(b.device.id, "local-one");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(next.closedWith).toBe(4403);
    b.macs.close();
  });

  it("settles what was running as uncertain when the Mac is unlinked", async () => {
    const b = broker();
    const call = b.call("run", { command: "make" });
    await vi.advanceTimersByTimeAsync(0);
    b.macs.revoked(b.device.id);
    expect(b.socket.sent.at(-1)).toEqual({ type: "revoked" });
    expect(b.socket.closedWith).toBe(4401);
    expect(await call).toMatchObject({ ok: false, error: { code: "uncertain" } });
    b.macs.close();
  });
});
