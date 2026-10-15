import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { Runtime } from "../src/shared/types.js";
const origin = "http://127.0.0.1:3000";
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

// An app contract double whose watched conversations change when a test says so.
function runtimeDouble() {
  const watchers = new Map<string, Set<() => void>>();
  const fixed: Partial<Runtime> = {
    status: async () => ({ connected: true }),
    capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }) as never,
    listBots: async () => [{ id: "shared", name: "Shared", model: "test", shared: true, activity: "idle" }],
    conversation: async botId => ({ botId, messages: [], activity: { state: "idle" }, approvals: [], files: [] }),
    submit: async input => ({ requestId: input.requestId, status: "accepted", runId: "run" }),
    lookupSubmission: async () => null,
    routines: async () => [],
    discoverEvents: async cursor => ({ cursor, events: [] }),
    close: async () => {},
    watch(botId, changed) {
      const set = watchers.get(botId) ?? new Set();
      watchers.set(botId, set.add(changed));
      return () => set.delete(changed);
    },
  };
  return { runtime: fixed as Runtime, change: (botId: string) => { for (const changed of watchers.get(botId) ?? []) changed(); }, watchers };
}
async function setup() {
  const fake = runtimeDouble();
  const { app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), fake.runtime, { background: false });
  apps.push(app);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const signIn = await fetch(`${base}/api/auth/local`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ member: "one" }) });
  const cookie = signIn.headers.getSetCookie()[0].split(";")[0];
  const { csrfToken } = await signIn.json() as { csrfToken: string };
  return { ...fake, app, base, cookie, csrfToken };
}
/** Reads server-sent text as it arrives, so a test can wait for the next notice. */
async function stream(url: string, cookie: string) {
  const response = await fetch(url, { headers: { cookie } });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "", done = false;
  const pump = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; return; }
      text += chunk.value;
    }
  })().catch(() => { done = true; });
  return {
    response,
    get text() { return text; },
    get done() { return done; },
    notices: () => text.split("data: change\n\n").length - 1,
    until: async (ready: () => boolean, ms = 3000) => {
      const deadline = Date.now() + ms;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error(`Stream never got there: ${JSON.stringify(text)}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    close: () => reader.cancel().then(() => pump),
  };
}

describe("conversation change stream", () => {
  it("refuses a request without a session, as the conversation read does", async () => {
    const s = await setup();
    for (const path of ["events", "conversation"]) {
      const response = await fetch(`${s.base}/api/bots/shared/${path}`);
      expect([path, response.status, (await response.json()).code]).toEqual([path, 401, "session_expired"]);
    }
    expect(s.watchers.get("shared")?.size ?? 0).toBe(0);
  });

  it("sends a notice when Hermes reports a change, one per burst of streamed frames", async () => {
    const s = await setup();
    const events = await stream(`${s.base}/api/bots/shared/events`, s.cookie);
    expect(events.response.status).toBe(200);
    expect(events.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    // An encoded body would sit in Caddy's compressor instead of reaching the browser.
    expect(events.response.headers.get("content-encoding")).toBe("identity");
    expect(events.response.headers.get("cache-control")).toBe("no-store");
    await events.until(() => events.text.includes("retry: 3000"));
    for (let token = 0; token < 50; token++) s.change("shared");
    s.change("other");
    await events.until(() => events.notices() === 1);
    s.change("shared");
    await new Promise(resolve => setTimeout(resolve, 500));
    // Still within a second of the last notice: held, then sent.
    expect(events.notices()).toBe(1);
    await events.until(() => events.notices() === 2);
    await events.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(s.watchers.get("shared")?.size).toBe(0);
  });

  it("notifies open chats of the app's own conversation writes", async () => {
    const s = await setup();
    const events = await stream(`${s.base}/api/bots/shared/events`, s.cookie);
    await events.until(() => events.text.includes("retry"));
    const sent = await fetch(`${s.base}/api/bots/shared/messages`, { method: "POST",
      headers: { cookie: s.cookie, origin, "x-csrf-token": s.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), text: "Hello" }) });
    expect(sent.status).toBe(200);
    await events.until(() => events.notices() === 1);
    await events.close();
  });

  it("ends the stream instead of notifying once its session is signed out", async () => {
    const s = await setup();
    const events = await stream(`${s.base}/api/bots/shared/events`, s.cookie);
    await events.until(() => events.text.includes("retry"));
    expect((await fetch(`${s.base}/api/auth/logout`, { method: "POST", headers: { cookie: s.cookie, origin, "x-csrf-token": s.csrfToken } })).status).toBe(200);
    s.change("shared");
    await events.until(() => events.done);
    expect(events.notices()).toBe(0);
    expect(s.watchers.get("shared")?.size).toBe(0);
  });

  it("closes open streams when the app shuts down", async () => {
    const s = await setup();
    const events = await stream(`${s.base}/api/bots/shared/events`, s.cookie);
    await events.until(() => events.text.includes("retry"));
    await apps.pop()!.close();
    await events.until(() => events.done);
  });
});
