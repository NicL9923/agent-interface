// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearResponseCache, request } from "../src/client-api";
import { savedThemeKey, signInHintKey } from "../src/app/storage";
import { STARTUP_READ_VERSION } from "../src/startup-read";

// public/boot.js runs here as the browser runs it, as a classic script, against the app's real client
// API. fetch is the edge: each call is recorded and answered by the test.
const BOOT = readFileSync("public/boot.js", "utf8");
const runBoot = () => window.eval(BOOT);
const NOW = Date.UTC(2026, 10, 10, 15);
const LEAN = "/bootstrap?roster=lean";
type Call = { url: string; init: RequestInit };
let calls: Call[];
let answers: (() => Promise<Response>)[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const bootstrap = { user: { id: "one" }, bots: [] };
const leanBootstrap = () => request("GET /bootstrap", { query: { roster: "lean" } });
const startup = () => window.__wildbotsStartup as { version: number; path: string; abort(): void } | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  window.__wildbotsStartup = undefined;
  clearResponseCache();
  localStorage.clear();
  document.documentElement.setAttribute("data-theme", "system");
  calls = [];
  answers = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error(`Unexpected request ${url}`);
    return next();
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.__wildbotsStartup = undefined;
});

describe("the read boot.js starts", () => {
  it("is the request the app makes for its first bootstrap", async () => {
    answers.push(async () => json(bootstrap));
    await leanBootstrap();
    const own = calls.shift()!;
    answers.push(async () => json(bootstrap));
    runBoot();
    const early = calls.shift()!;
    expect(early.url).toBe(own.url);
    // Everything the server sees: method, cookie, cache mode and headers. api() sends none on a GET it has no copy of.
    const sent = ({ init }: Call) => ({ method: init.method ?? "GET", credentials: init.credentials, cache: init.cache, headers: [...new Headers(init.headers)] });
    expect(sent(early)).toEqual(sent(own));
    expect(startup()?.path).toBe(LEAN);
  });

  it("answers the app's first bootstrap, so the page reads it once", async () => {
    answers.push(async () => json(bootstrap));
    runBoot();
    await expect(leanBootstrap()).resolves.toEqual(bootstrap);
    expect(calls.map(call => call.url)).toEqual([`/api${LEAN}`]);
    // Taken once: the next bootstrap reads again.
    answers.push(async () => json({ ...bootstrap, bots: [{ id: "later" }] }));
    await expect(leanBootstrap()).resolves.toMatchObject({ bots: [{ id: "later" }] });
    expect(calls).toHaveLength(2);
  });

  it("is taken once, so the read after an error answer asks the server again", async () => {
    // An error is not cached, so nothing else stops the next read from taking the spent one.
    answers.push(async () => json({ error: "Hermes is restarting" }, 503), async () => json(bootstrap));
    runBoot();
    await expect(leanBootstrap()).rejects.toMatchObject({ status: 503 });
    await expect(leanBootstrap()).resolves.toEqual(bootstrap);
    expect(calls).toHaveLength(2);
  });

  it("starts once per page", () => {
    answers.push(async () => json(bootstrap));
    runBoot();
    runBoot();
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["an abort", () => Promise.reject(new DOMException("The operation was aborted.", "AbortError"))],
  ])("hands over to the app's own read after %s", async (_name, failure) => {
    answers.push(failure, async () => json(bootstrap));
    runBoot();
    await expect(leanBootstrap()).resolves.toEqual(bootstrap);
    expect(calls.map(call => call.url)).toEqual([`/api${LEAN}`, `/api${LEAN}`]);
  });

  it("is judged as the app's own answer would be: a refused session is the sign-in, read once", async () => {
    answers.push(async () => json({ error: "Sign in required", code: "session_expired" }, 401));
    runBoot();
    await expect(leanBootstrap()).rejects.toMatchObject({ status: 401, code: "session_expired" });
    expect(calls).toHaveLength(1);
  });

  it("is judged as the app's own answer would be: a page in place of JSON is refused, not shown", async () => {
    answers.push(async () => new Response("<html>Proxy error</html>", { status: 200 }));
    runBoot();
    await expect(leanBootstrap()).rejects.toMatchObject({ status: 502, code: "INVALID_RESPONSE" });
  });

  it("is left for its own path: another read of bootstrap reads for itself", async () => {
    answers.push(async () => json(bootstrap), async () => json({ user: { id: "one" } }));
    runBoot();
    await request("GET /bootstrap");
    expect(calls.map(call => call.url)).toEqual([`/api${LEAN}`, "/api/bootstrap"]);
    expect(startup()?.path).toBe(LEAN);
    await expect(leanBootstrap()).resolves.toEqual(bootstrap);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["a version from the future", (read: Record<string, unknown>) => ({ ...read, version: STARTUP_READ_VERSION + 1 })],
    ["no response", (read: Record<string, unknown>) => ({ ...read, response: undefined })],
    ["a path that is not text", (read: Record<string, unknown>) => ({ ...read, path: 1 })],
  ])("is dropped, and aborted, when it has %s", async (_name, change) => {
    const abort = vi.fn();
    window.__wildbotsStartup = change({ version: STARTUP_READ_VERSION, path: LEAN, response: Promise.resolve(json({ user: { id: "stale" } })), abort });
    answers.push(async () => json(bootstrap));
    await expect(leanBootstrap()).resolves.toEqual(bootstrap);
    expect(abort).toHaveBeenCalled();
    expect(window.__wildbotsStartup).toBeUndefined();
  });

  it("is not something other than a read", async () => {
    window.__wildbotsStartup = "not a read";
    answers.push(async () => json(bootstrap));
    await expect(leanBootstrap()).resolves.toEqual(bootstrap);
    expect(window.__wildbotsStartup).toBeUndefined();
  });

  it("is dropped when the account changes before the app asks for it", async () => {
    answers.push(() => new Promise<Response>(() => {}));
    runBoot();
    const abort = vi.spyOn(startup()!, "abort");
    clearResponseCache();
    expect(abort).toHaveBeenCalled();
    answers.push(async () => json(bootstrap));
    await expect(leanBootstrap()).resolves.toEqual(bootstrap);
    expect(calls).toHaveLength(2);
  });

  it("counts toward the app's deadline, which aborts it without a second read", async () => {
    let signal: AbortSignal | undefined;
    answers.push(() => new Promise<Response>((_resolve, reject) => {
      signal = calls[0].init.signal!;
      signal.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    runBoot();
    const failure = expect(leanBootstrap()).rejects.toMatchObject({ status: 504, code: "CONNECTION_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(20_000);
    await failure;
    expect(signal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("lets go after a minute when no bundle asks for it", async () => {
    answers.push(() => new Promise<Response>(() => {}));
    runBoot();
    const signal = calls[0].init.signal!;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(startup()).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect([startup(), signal.aborted]).toEqual([undefined, true]);
  });
});

describe("the theme boot.js applies before the bundle", () => {
  const hint = (value: Record<string, unknown> = {}) => ({ until: NOW + 60_000, user: "one", bots: [], ...value });
  const theme = (value: Record<string, unknown> = {}) => ({ v: 1, user: "one", theme: "dark", ...value });
  const store = (key: string, value: unknown) => localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  const shown = () => document.documentElement.getAttribute("data-theme");
  beforeEach(() => { answers.push(async () => json(bootstrap)); });

  it("is the one this device last showed the account its sign-in names", () => {
    store(signInHintKey, hint());
    store(savedThemeKey, theme());
    runBoot();
    expect(shown()).toBe("dark");
  });

  // Each leaves the page's own default, as before boot.js, and the read still starts.
  it.each([
    ["no sign-in on this browser", null, theme()],
    ["a lapsed sign-in", hint({ until: NOW }), theme()],
    ["a sign-in no bootstrap has named yet", hint({ user: undefined }), theme()],
    ["a sign-in without its chat list", hint({ bots: undefined }), theme()],
    ["an unreadable sign-in", "{not json", theme()],
    ["a theme saved for another account", hint(), theme({ user: "two" })],
    ["a theme from a future format", hint(), theme({ v: 2 })],
    ["a theme the page does not have", hint(), theme({ theme: "sepia" })],
    ["an unreadable theme", hint(), "{not json"],
  ])("is not applied for %s", (_name, signIn, saved) => {
    if (signIn !== null) store(signInHintKey, signIn);
    store(savedThemeKey, saved);
    runBoot();
    expect(shown()).toBe("system");
    expect(calls).toHaveLength(1);
  });

  it("leaves the default, and still starts the read, when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    runBoot();
    expect([shown(), calls.length]).toEqual(["system", 1]);
  });
});
