import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { Runtime } from "../src/shared/types.js";
import { botFixture } from "./helpers/runtime-fixtures.js";
import { fakeRuntime } from "./helpers/server.js";

// The web client opens streams with `?ping=10` to notice a dead one within 25 seconds. Every other query,
// the iOS app's and older bundles' included, must start and ping exactly as before. These requests go
// through the real app and its query parser over a socket; only the ping interval's clock is virtual.
const origin = "http://127.0.0.1:3000";
const FALLBACK_OPEN = "retry: 3000\n\n", FALLBACK_PING = "event: ping\ndata: ping\n\n";
const FAST_PING = "event: ping\ndata: 10\n\n";
let app: Awaited<ReturnType<typeof createApp>>["app"], base: string, cookie: string;
beforeEach(async () => {
  const runtime: Runtime = fakeRuntime({
    status: async () => ({ connected: true }), close: async () => {},
    capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }) as never,
    listBots: async () => [botFixture({ id: "ranch" })],
  });
  ({ app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false }));
  base = await app.listen({ port: 0, host: "127.0.0.1" });
  const signIn = await fetch(`${base}/api/auth/local`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ member: "one" }) });
  cookie = signIn.headers.getSetCookie()[0].split(";")[0];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Opens the household stream with `query` and gathers everything it sends, as it arrives. */
async function stream(query: string) {
  const response = await fetch(`${base}/api/events${query}`, { headers: { cookie } });
  expect(response.status).toBe(200);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const got = { text: "" };
  void (async () => { for (;;) { const chunk = await reader.read().catch(() => ({ done: true, value: "" })); if (chunk.done) return; got.text += chunk.value; } })();
  return { got, stop: () => reader.cancel() };
}
/** Lets the socket deliver what the server wrote. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
/** Waits for what the stream is expected to have written, by the stream's own bytes; the step count only ends a stream that never writes it. */
async function until(test: () => boolean, expected = "its opening") {
  for (let step = 0; !test(); step++) {
    if (step > 100) throw new Error(`The stream never sent ${expected}`);
    await settle();
  }
}

describe("a stream's pings", () => {
  it.each([
    ["no ping", ""],
    ["an empty ping", "?ping="],
    ["ping=0", "?ping=0"],
    ["a negative ping", "?ping=-10"],
    ["a fractional ping", "?ping=10.5"],
    ["ten written another way", "?ping=1e1"],
    ["ten with a leading zero", "?ping=010"],
    ["a huge ping", "?ping=99999999999999999999999"],
    ["a word", "?ping=fast"],
    ["ping=5", "?ping=5"],
    ["ping=25", "?ping=25"],
    ["ping twice", "?ping=10&ping=10"],
  ])("keep the old bytes and 25-second interval for %s", async (_name, query) => {
    const { got, stop } = await stream(query);
    await until(() => got.text.length > 0);
    expect(got.text).toBe(FALLBACK_OPEN);
    vi.advanceTimersByTime(24_999);
    await settle();
    expect(got.text).toBe(FALLBACK_OPEN);
    vi.advanceTimersByTime(1);
    await until(() => got.text === FALLBACK_OPEN + FALLBACK_PING, "the ping");
    expect(got.text).toBe(FALLBACK_OPEN + FALLBACK_PING);
    await stop();
  });

  it("come at once and every 10 seconds, naming the interval, for exactly ping=10", async () => {
    const { got, stop } = await stream("?ping=10");
    await until(() => got.text.length > 0);
    expect(got.text).toBe(FALLBACK_OPEN + FAST_PING);
    // 22 bytes each, the cost the ledger states.
    expect(Buffer.byteLength(FAST_PING)).toBe(22);
    vi.advanceTimersByTime(9_999);
    await settle();
    expect(got.text).toBe(FALLBACK_OPEN + FAST_PING);
    vi.advanceTimersByTime(1);
    await until(() => got.text === FALLBACK_OPEN + FAST_PING.repeat(2), "the ping");
    expect(got.text).toBe(FALLBACK_OPEN + FAST_PING.repeat(2));
    vi.advanceTimersByTime(10_000);
    await until(() => got.text === FALLBACK_OPEN + FAST_PING.repeat(3), "the ping");
    expect(got.text).toBe(FALLBACK_OPEN + FAST_PING.repeat(3));
    await stop();
  });
});
