// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authEpochKey } from "../src/app/storage";
import { browserLocks } from "./helpers/web-locks";
import { bodyText } from "./helpers/wire-text";

type Tab = { change: typeof import("../src/app/account-change"); epoch: typeof import("../src/app/account-epoch"); api: typeof import("../src/client-api") };
async function tab(): Promise<Tab> {
  vi.resetModules();
  const change = await import("../src/app/account-change");
  return { change, epoch: await import("../src/app/account-epoch"), api: await import("../src/client-api") };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
let cookie: string;
beforeEach(() => {
  localStorage.clear(); cookie = "";
  Object.defineProperty(navigator, "locks", { configurable: true, value: browserLocks() });
});
afterEach(() => { vi.unstubAllGlobals(); delete (navigator as { locks?: unknown }).locks; });

it("still tells the worker it is signed out when cleanup rewrites the pending record before registration arrives", async () => {
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "offline", at: Date.now(), signedOut: true, logout: true, user: "one" }));
  const a = await tab();
  const posted: object[] = [];
  const registration = { active: { postMessage: (message: object) => { posted.push(message); } } };
  const waiting = deferred<typeof registration>();
  const getRegistration = vi.fn().mockResolvedValue(registration).mockImplementationOnce(() => waiting.promise);
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: {}, getRegistration } });
  const fetcher = vi.fn(async (url: string) => {
    expect(url).toBe("/api/bootstrap?roster=lean");
    return json({ error: "Signed out" }, 401);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    expect(a.epoch.accountStart()).toMatchObject({ start: "signed-out" });
    await vi.waitFor(() => expect(getRegistration).toHaveBeenCalled());
    await a.change.finishSignOut();
    expect(a.epoch.pendingSignOut()).toBeNull();
    expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ signedOut: true, user: "one" });
    expect(JSON.parse(localStorage.getItem(authEpochKey)!)).not.toHaveProperty("logout");
    // A badge request after cleanup must follow the replacement account word, not an obsolete one.
    expect(a.epoch.tellWorkerInOrder({ type: "BADGE", user: null, count: 0 })).toBe(true);
    waiting.resolve(registration);
    await vi.waitFor(() => expect(posted).toEqual([{ type: "ACCOUNT", user: null }, { type: "BADGE", user: null, count: 0 }]));
  } finally {
    waiting.resolve(registration);
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

it("serializes the cookie-changing sign-ins through settlement across tabs", async () => {
  const a = await tab(), b = await tab();
  a.epoch.accountStart();
  const gate = deferred<void>();
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    if (!init.body) return json({ user: { id: cookie } });
    const user = JSON.parse(bodyText(init.body)).user as string;
    calls.push(user);
    if (user === "a") await gate.promise;
    cookie = user;
    return json({ user: { id: user } });
  });
  const first = a.change.signInWith("/auth/login", { user: "a" });
  await vi.waitFor(() => expect(calls).toEqual(["a"]));
  let secondSettled = false;
  const second = b.change.signInWith("/auth/login", { user: "b" }).then(() => { secondSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  if (secondSettled) b.epoch.accountStart();
  const beforeRelease = [...calls];
  gate.resolve();
  const results = await Promise.allSettled([first, second]);
  expect(beforeRelease).toEqual(["a"]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(calls).toEqual(["a", "b"]);
  expect(cookie).toBe("b");
  expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ user: "b" });
  b.epoch.accountStart();
  expect(await b.api.api("/whoami")).toEqual({ user: { id: "b" } });
});

it("waits for logout before another tab signs in", async () => {
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "one", at: Date.now(), user: "one" }));
  cookie = "one";
  const a = await tab(), b = await tab();
  a.epoch.accountStart(); b.epoch.accountStart();
  const gate = deferred<void>(), calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.endsWith("/auth/logout")) { await gate.promise; cookie = ""; return json({}); }
    cookie = "two"; return json({ user: { id: "two" } });
  });
  const out = a.change.signOutOf("one");
  await vi.waitFor(() => expect(calls).toEqual(["/api/auth/logout"]));
  const incoming = b.change.signInWith("/auth/login", {});
  await new Promise(resolve => setTimeout(resolve, 20));
  const beforeRelease = [...calls];
  gate.resolve();
  await Promise.all([out, incoming]);
  expect(beforeRelease).toEqual(["/api/auth/logout"]);
  expect(cookie).toBe("two");
  expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ user: "two" });
});

it("undoes a refused sign-in and releases the operation lock for the next attempt", async () => {
  const a = await tab(), b = await tab();
  let calls = 0;
  vi.stubGlobal("fetch", async () => ++calls === 1 ? json({ error: "Invalid credentials" }, 401) : json({ user: { id: "b" } }));
  await expect(a.change.signInWith("/auth/login", {})).rejects.toMatchObject({ status: 401, message: "Invalid credentials" });
  expect(localStorage.getItem(authEpochKey)).toBeNull();
  await b.change.signInWith("/auth/login", {});
  expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ user: "b" });
});

it("propagates a denied lock without sending an authentication request", async () => {
  const a = await tab();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: () => Promise.reject(new DOMException("Denied", "SecurityError")) } });
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(a.change.signInWith("/auth/login", {})).rejects.toMatchObject({ name: "SecurityError", message: "Denied" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps the newer CSRF token when an old offline logout finishes after a new account record settles", async () => {
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "offline", at: Date.now(), signedOut: true, logout: true, user: "one" }));
  const a = await tab();
  const gate = deferred<void>(), calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.includes("/bootstrap")) return json({ csrfToken: "old" });
    if (url.endsWith("/auth/logout")) { await gate.promise; return json({}); }
    return json({ user: { id: "two" } });
  });
  const out = a.change.finishSignOut();
  await vi.waitFor(() => expect(calls).toContain("/api/auth/logout"));
  const change = await a.epoch.beginAccountChange();
  await change.settle({ user: "two" });
  a.api.setCsrf("newtoken");
  gate.resolve(); await out;
  expect(a.api.hasSession()).toBe(true);
  expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ user: "two" });
});

it("releases the operation lock after a network failure and restores the previous record", async () => {
  const before = JSON.stringify({ id: "one", at: Date.now(), user: "one" });
  localStorage.setItem(authEpochKey, before);
  const a = await tab(), b = await tab();
  let attempts = 0;
  vi.stubGlobal("fetch", async () => {
    if (++attempts === 1) throw new TypeError("offline");
    return json({ user: { id: "two" } });
  });
  await expect(a.change.signInWith("/auth/login", {})).rejects.toMatchObject({ status: 503, code: "CONNECTION_UNAVAILABLE" });
  expect(localStorage.getItem(authEpochKey)).toBe(before);
  await b.change.signInWith("/auth/login", {});
  expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ user: "two" });
});

it("can sign in after a tab left an expired changing record", async () => {
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "abandoned", at: Date.now() - 70_000, changing: true, fromSignedOut: true }));
  const a = await tab();
  expect(a.epoch.accountStart()).toMatchObject({ start: "bootstrap" });
  vi.stubGlobal("fetch", async () => json({ user: { id: "two" } }));
  await a.change.signInWith("/auth/login", {});
  expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ user: "two" });
});

it("does not send a stale offline logout after a queued sign-in settles", async () => {
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "offline", at: Date.now(), signedOut: true, logout: true, user: "one" }));
  const a = await tab(), b = await tab();
  const gate = deferred<void>(), calls: string[] = [];
  const occupied = navigator.locks.request("agent-interface:auth-operation", () => gate.promise);
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.endsWith("/auth/login")) return json({ user: { id: "two" } });
    throw new Error(`Unexpected request ${url}`);
  });
  const incoming = a.change.signInWith("/auth/login", {});
  const out = b.change.finishSignOut();
  gate.resolve();
  await Promise.all([occupied, incoming, out]);
  expect(calls).toEqual(["/api/auth/login"]);
  expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ user: "two" });
});

it("keeps a newer token after an undone account change advances the era", async () => {
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "offline", at: Date.now(), signedOut: true, logout: true, user: "one" }));
  const a = await tab();
  const gate = deferred<void>(), calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.includes("/bootstrap")) return json({ csrfToken: "old" });
    if (url.endsWith("/auth/logout")) { await gate.promise; return json({}); }
    return json({ error: "Invalid credentials" }, 401);
  });
  const out = a.change.finishSignOut();
  await vi.waitFor(() => expect(calls).toContain("/api/auth/logout"));
  const change = await a.epoch.beginAccountChange();
  await change.undo();
  a.api.setCsrf("newtoken");
  gate.resolve(); await out;
  expect(a.api.hasSession()).toBe(true);
  expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ logout: true });
});

it("keeps the offline logout pending if access to the operation lock is denied", async () => {
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "offline", at: Date.now(), signedOut: true, logout: true, user: "one" }));
  const a = await tab();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: () => Promise.reject(new DOMException("Denied", "SecurityError")) } });
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(a.change.finishSignOut()).resolves.toBeUndefined();
  expect(a.epoch.pendingSignOut()).toBe("one");
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not use a late offline bootstrap after an undone account change advances the era", async () => {
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "offline", at: Date.now(), signedOut: true, logout: true, user: "one" }));
  const a = await tab();
  const gate = deferred<void>(), calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.includes("/bootstrap")) { await gate.promise; return json({ csrfToken: "old" }); }
    if (url.endsWith("/auth/login")) return json({ user: { id: "two" } });
    throw new Error(`Unexpected request ${url}`);
  });
  const out = a.change.finishSignOut();
  await vi.waitFor(() => expect(calls.some(url => url.includes("/bootstrap"))).toBe(true));
  const change = await a.epoch.beginAccountChange();
  await change.undo();
  a.api.setCsrf("newtoken");
  gate.resolve(); await out;
  expect(calls).not.toContain("/api/auth/logout");
  expect(a.api.hasSession()).toBe(true);
});


it("refuses cookie changes when Web Locks are absent", async () => {
  delete (navigator as { locks?: unknown }).locks;
  const a = await tab();
  const before = JSON.stringify({ id: "one", at: Date.now(), user: "one" });
  localStorage.setItem(authEpochKey, before);
  const fetcher = vi.fn(() => { throw new Error("Authentication must not reach fetch"); });
  vi.stubGlobal("fetch", fetcher);
  await expect(a.change.signInWith("/auth/login", {})).rejects.toThrow("safely change accounts");
  await expect(a.change.signOutOf("one")).rejects.toThrow("safely change accounts");
  expect(fetcher).not.toHaveBeenCalled();
  expect(localStorage.getItem(authEpochKey)).toBe(before);
});

it("leaves logout pending when Web Locks are absent", async () => {
  delete (navigator as { locks?: unknown }).locks;
  const before = JSON.stringify({ id: "offline", at: Date.now(), signedOut: true, logout: true, user: "one" });
  localStorage.setItem(authEpochKey, before);
  const a = await tab();
  const fetcher = vi.fn(() => { throw new Error("Pending logout must not reach fetch"); });
  vi.stubGlobal("fetch", fetcher);
  await expect(a.change.finishSignOut()).resolves.toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(localStorage.getItem(authEpochKey)).toBe(before);
});

it("keeps device-only sign-out available without Web Locks", async () => {
  delete (navigator as { locks?: unknown }).locks;
  localStorage.setItem(authEpochKey, JSON.stringify({ id: "one", at: Date.now(), user: "one" }));
  const a = await tab();
  a.epoch.accountStart();
  const fetcher = vi.fn(() => { throw new Error("Device-only sign-out must not reach fetch"); });
  vi.stubGlobal("fetch", fetcher);
  await expect(a.change.signOutHere("one")).resolves.toBe(true);
  expect(JSON.parse(localStorage.getItem(authEpochKey)!)).toMatchObject({ user: "one", signedOut: true, logout: true });
  expect(fetcher).not.toHaveBeenCalled();
});


it("refuses cookie changes outside a browser without touching fetch", async () => {
  const a = await tab();
  vi.stubGlobal("navigator", undefined);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(a.change.signInWith("/auth/login", {})).rejects.toThrow("safely change accounts");
  expect(fetcher).not.toHaveBeenCalled();
});
