import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { CLIENT_ERROR_WINDOW_MS, CLIENT_ERRORS_PER_WINDOW } from "../src/server/client-errors.js";
import { loadConfig } from "../src/server/config.js";
import { withoutUrlQueries } from "../src/shared/api.js";
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

it("logs an iOS crash and hang report with their platform, and refuses an unknown platform or kind", async () => {
  const s = await setup();
  const crash = { kind: "crash", platform: "ios", message: "EXC_BAD_ACCESS (SIGSEGV) KERN_INVALID_ADDRESS 1.4.0 (23)",
    stack: "0 AgentInterface +0x1a2b4\n1 UIKitCore +0x9f00", route: "/ios/crash", release: "1.4.0-23" };
  const hang = { ...crash, kind: "hang", message: "Hang of 3.2s 1.4.0 (23)", route: "/ios/hang" };
  for (const accepted of [crash, hang]) expect((await s.app.inject(post(s.one, accepted))).statusCode).toBe(200);
  expect(s.logged().map(line => line.clientError)).toEqual([crash, hang]);
  for (const [refused, field] of [[{ ...crash, platform: "android" }, "platform"], [{ ...crash, kind: "freeze" }, "kind"]] as const) {
    const response = await s.app.inject(post(s.one, refused));
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json()), field).toContain(field);
  }
  expect(s.logged()).toHaveLength(2);
});

it("logs no URL query or hash from a report's message or stack, whatever the client sent", async () => {
  const s = await setup();
  const leaky = { ...report,
    message: "TypeError: failed https://app.example.invalid/native/callback?code=SENTINEL#private-draft",
    stack: "at load (/api/search?q=SENTINEL:3:9)\nat Home (https://app.example.invalid/assets/index-abc.js:1:2)" };
  expect((await s.app.inject(post(s.one, leaky))).statusCode).toBe(200);
  const [line] = s.logged();
  expect(JSON.stringify(line)).not.toMatch(/SENTINEL|private-draft/);
  expect(line.clientError).toMatchObject({
    message: "TypeError: failed https://app.example.invalid/native/callback",
    stack: "at load (/api/search)\nat Home (https://app.example.invalid/assets/index-abc.js:1:2)" });
});

it("leaves text without a URL query alone", () => {
  for (const text of ["Is the gate shut? yes", "Expected 3 rows, got 2 (page 1)", "at f (index-abc.js:1:2)", "Section #3 is missing", "What now?"])
    expect(withoutUrlQueries(text), text).toBe(text);
});

it("drops the query and hash of absolute, relative and blob URLs and file names", () => {
  for (const [text, safe] of [
    ["see (https://x.invalid/a?b=1) and /p#q.", "see (https://x.invalid/a) and /p"],
    ["fetch ./api/search?q=SENTINEL failed", "fetch ./api/search failed"],
    ["blob:null/0b8e?token=SENTINEL", "blob:null/0b8e"],
    ["https://x.invalid/a?q=(SENTINEL)", "https://x.invalid/a"],
    ['fetch "https://x.invalid/a?q=SENTINEL" failed', 'fetch "https://x.invalid/a failed'],
    ["Failed to load manifest.webmanifest?token=SENTINEL", "Failed to load manifest.webmanifest"],
    ["Unable to load backup.7z?token=SENTINEL", "Unable to load backup.7z"],
    ["a/b?c either/or?maybe", "a/b either/or"],
    // A message never keeps digits after a query, even where it reads like a frame.
    ["Failed to load script at https://x.invalid/app.js?token=account:123456", "Failed to load script at https://x.invalid/app.js"],
    ["Failed (https://x.invalid/app.js?token=account:1:2)", "Failed (https://x.invalid/app.js)"],
  ]) expect(withoutUrlQueries(text), text).toBe(safe);
});

it("keeps a script's line and column only on a stack's frame lines", () => {
  const stack = [
    "Error: load failed for https://x.invalid/app.js?token=account:1:2",
    "    at load (/api/search?q=SENTINEL:3:9)",
    "    at eval (app.js?token=SENTINEL:1:1)",
    "    at eval (https://x.invalid/app.js?token=x'SENTINEL:1:1)",
    "    at https://x.invalid/assets/app-1.js?v=SENTINEL:10:5",
    "    at f (https://x.invalid/app.js?token=account:123456)",
    "load@https://x.invalid/assets/app-1.js?t=SENTINEL:10:5",
    "@https://x.invalid/assets/app-1.js#SENTINEL:7:1",
    "global code@https://x.invalid/app.js?token=SENTINEL:12:3",
    "Error: mail me@https://x.invalid/app.js?token=SENTINEL:12:3",
  ].join("\n");
  expect(withoutUrlQueries(stack, { stack: true }).split("\n")).toEqual([
    "Error: load failed for https://x.invalid/app.js",
    "    at load (/api/search)",
    "    at eval (app.js:1:1)",
    "    at eval (https://x.invalid/app.js:1:1)",
    "    at https://x.invalid/assets/app-1.js:10:5",
    "    at f (https://x.invalid/app.js)",
    "load@https://x.invalid/assets/app-1.js:10:5",
    "@https://x.invalid/assets/app-1.js:7:1",
    "global code@https://x.invalid/app.js:12:3",
    "Error: mail me@https://x.invalid/app.js",
  ]);
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
