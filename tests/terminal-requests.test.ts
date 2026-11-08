import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, expect, it, vi } from "vitest";
import { installAuth } from "../src/server/auth.js";
import { installTerminalRequestRoutes } from "../src/server/terminal-requests.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import type { Runtime } from "../src/shared/types.js";
import { fakeRuntime, signIn } from "./helpers/server.js";
import { errorHandler } from "../src/server/http-error.js";

const origin = "https://app.example.invalid";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(options: { admins?: string; runtime?: boolean } = {}) {
  const app = Fastify(), store = new Store(":memory:");
  app.setErrorHandler(errorHandler({ production: true }));
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, GOOGLE_CLIENT_ID: "fixture", HOUSEHOLD_EMAILS: "one@example.invalid,two@example.invalid",
    ...(options.admins === undefined ? {} : { COMPUTER_TERMINAL_ADMINS: options.admins }) });
  const computerRequest = vi.fn<NonNullable<Runtime["computerRequest"]>>(async () => ({ status: "ok" }) as never);
  const runtime = fakeRuntime(options.runtime === false ? {} : { computerRequest });
  await app.register(cookie); await installAuth(app, store, config);
  await installTerminalRequestRoutes(app, config, store, runtime);
  cleanups.push(async () => store.close(), () => app.close());
  const post = (headers: Record<string, string>, payload: unknown, bot = "patch", request = "srq-0123456789ab") =>
    app.inject({ method: "POST", url: `/api/bots/${bot}/terminal-requests/${request}`, headers, payload: payload as object });
  return { app, store, computerRequest, post, one: signIn(store, origin, "one"), two: signIn(store, origin, "two") };
}
const body = { decision: "done", epoch: "epoch-one", sessionId: "live-one" };
const reason = (response: { json(): { error?: string } }) => response.json().error;

it("settles Done and Not now with the member from the session and the card's binding", async () => {
  const s = await setup({ admins: "one@example.invalid" });
  const done = await s.post(s.one, body);
  expect(done.statusCode).toBe(200);
  expect(done.json()).toEqual({ status: "ok" });
  expect(s.computerRequest).toHaveBeenCalledWith({ action: "terminal_request", decision: "done", profile: "patch", requestId: "srq-0123456789ab",
    epoch: "epoch-one", sessionId: "live-one", actorId: "one", actorName: "one" });
  s.computerRequest.mockResolvedValue({ status: "expired" } as never);
  expect((await s.post(s.one, { ...body, decision: "decline" })).json()).toEqual({ status: "expired" });
  expect(s.computerRequest).toHaveBeenLastCalledWith(expect.objectContaining({ action: "terminal_request", decision: "decline" }));
});

it("refuses Done from a member who is not a terminal administrator, but lets them say Not now", async () => {
  const s = await setup({ admins: "one@example.invalid" });
  const refused = await s.post(s.two, body);
  expect(refused.statusCode).toBe(403);
  expect(reason(refused)).toBe("Only a terminal administrator can open the terminal.");
  expect(s.computerRequest).not.toHaveBeenCalled();
  expect((await s.post(s.two, { ...body, decision: "decline" })).statusCode).toBe(200);
  expect(s.computerRequest).toHaveBeenCalledWith(expect.objectContaining({ decision: "decline", actorId: "two" }));
});

it("refuses Done for everyone while the terminal is turned off", async () => {
  const s = await setup();
  const refused = await s.post(s.one, body);
  expect(refused.statusCode).toBe(403);
  expect(reason(refused)).toBe("Only a terminal administrator can open the terminal.");
  expect(s.computerRequest).not.toHaveBeenCalled();
});

it("hides an assistant the member cannot see, and requires sign-in", async () => {
  const s = await setup({ admins: "one@example.invalid" });
  expect((await s.app.inject({ method: "POST", url: "/api/bots/patch/terminal-requests/srq-1", payload: body })).statusCode).toBe(401);
  s.store.savePresentation("private", { shared: false, ownerId: "two" });
  const hidden = await s.post(s.one, body, "private");
  expect(hidden.statusCode).toBe(404);
  expect(reason(hidden)).toBe("Assistant not found");
  expect((await s.post(s.one, { ...body, decision: "decline" }, "private")).statusCode).toBe(404);
  expect(s.computerRequest).not.toHaveBeenCalled();
});

it("rejects a malformed decision, binding or request ID before asking Hermes", async () => {
  const s = await setup({ admins: "one@example.invalid" });
  for (const bad of [{ ...body, decision: "take" }, { ...body, decision: undefined }, { ...body, extra: true }, { ...body, epoch: "../x" },
    { ...body, sessionId: "x".repeat(201) }, { decision: "done" }])
    expect((await s.post(s.one, bad)).statusCode, JSON.stringify(bad)).toBe(400);
  expect((await s.post(s.one, body, "patch", "bad id")).statusCode).toBe(400);
  expect(s.computerRequest).not.toHaveBeenCalled();
});

it("says so when the runtime cannot settle terminal requests, and rejects an unreadable answer", async () => {
  const none = await setup({ admins: "one@example.invalid", runtime: false });
  const unavailable = await none.post(none.one, body);
  expect(unavailable.statusCode).toBe(409);
  expect(reason(unavailable)).toBe("The Hermes terminal request integration is unavailable.");
  const s = await setup({ admins: "one@example.invalid" });
  for (const answer of [{ status: "maybe" }, {}, null]) {
    s.computerRequest.mockResolvedValue(answer as never);
    // The production error handler hides a 5xx message, so the status is the observable reason.
    expect((await s.post(s.one, body)).statusCode, JSON.stringify(answer)).toBe(502);
  }
});
