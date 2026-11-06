import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { CLIENT_ERROR_WINDOW_MS, CLIENT_ERRORS_PER_WINDOW } from "../src/server/client-errors.js";
import { loadConfig } from "../src/server/config.js";
import { fakeRuntime, signIn } from "./helpers/server.js";

const origin = "https://app.example.invalid";
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
});
async function setup() {
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, APP_DATABASE: ":memory:", LOG_LEVEL: "warn",
    GOOGLE_CLIENT_ID: "fixture-client", HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid" });
  const lines: string[] = [];
  const result = await createApp(config, fakeRuntime({ close: async () => {} }), { background: false, logStream: { write: line => { lines.push(line); } } });
  apps.push(result.app);
  const logged = () => lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.msg === "Client error");
  return { ...result, logged, one: signIn(result.store, origin, "one"), two: signIn(result.store, origin, "two") };
}
const report = { kind: "render", message: "TypeError: rows is undefined", stack: "at Home (index-abc.js:1:2)", route: "/", release: "index-DjeCT2iD" };
const post = (headers: Record<string, string> | undefined, payload: object = report) =>
  ({ method: "POST" as const, url: "/api/client-errors", headers, payload });

it("logs a signed-in person's report with their id and stores nothing", async () => {
  const s = await setup();
  const response = await s.app.inject(post(s.one));
  expect([response.statusCode, response.json()]).toEqual([200, { ok: true }]);
  expect(s.logged()).toEqual([expect.objectContaining({ level: 40, userId: "one", clientError: report })]);
});

it("requires a session, the app's Origin and the CSRF token", async () => {
  const s = await setup();
  expect((await s.app.inject(post(undefined))).statusCode).toBe(401);
  expect((await s.app.inject(post({ cookie: s.one.cookie, origin }))).statusCode).toBe(403);
  expect((await s.app.inject(post({ ...s.one, origin: "https://other.invalid" }))).statusCode).toBe(403);
  expect(s.logged()).toEqual([]);
});

it("refuses reports past their bounds, with a query or hash in the route, or with unknown fields", async () => {
  const s = await setup();
  const fits = { ...report, message: "m".repeat(1024), stack: "s".repeat(8192), route: `/${"r".repeat(511)}` };
  expect((await s.app.inject(post(s.one, fits))).statusCode).toBe(200);
  for (const refused of [
    { ...report, message: "m".repeat(1025) },
    { ...report, message: "" },
    { ...report, stack: "s".repeat(8193) },
    { ...report, route: `/${"r".repeat(512)}` },
    { ...report, route: "/?bot=private" },
    { ...report, route: "/#room" },
    { ...report, route: "https://app.example.invalid/" },
    { ...report, release: "index abc" },
    { ...report, kind: "warning" },
    { ...report, userId: "two" },
  ]) expect((await s.app.inject(post(s.one, refused))).statusCode, JSON.stringify(refused).slice(0, 80)).toBe(400);
  expect(s.logged()).toHaveLength(1);
});

it("limits each person's reports per window, separately from everyone else's", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const s = await setup();
  for (let index = 0; index < CLIENT_ERRORS_PER_WINDOW; index++)
    expect((await s.app.inject(post(s.one))).statusCode).toBe(200);
  const refused = await s.app.inject(post(s.one));
  expect([refused.statusCode, refused.json().error]).toEqual([429, "Too many error reports. Try again later."]);
  expect((await s.app.inject(post(s.two))).statusCode).toBe(200);
  expect(s.logged()).toHaveLength(CLIENT_ERRORS_PER_WINDOW + 1);
  vi.setSystemTime(Date.now() + CLIENT_ERROR_WINDOW_MS);
  // The fixture's session lasts as long as the window, so this signs in again.
  expect((await s.app.inject(post(signIn(s.store, origin, "one")))).statusCode).toBe(200);
});
