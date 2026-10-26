import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { hash } from "../src/server/auth.js";
import type { Activity, Bot, Inflight, Message, Runtime, ToolCall } from "../src/shared/types.js";
const origin = "http://127.0.0.1:3000";
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

// An app contract double whose watched conversations change when a test says so.
function runtimeDouble() {
  const watchers = new Map<string, Set<(kind?: "inflight") => void>>();
  const rosterWatchers = new Set<() => void>();
  const bots: Bot[] = [{ id: "shared", name: "Shared", model: "test", shared: true, activity: "idle" }];
  const fixed: Partial<Runtime> = {
    watchRoster(changed) { rosterWatchers.add(changed); return () => { rosterWatchers.delete(changed); }; },
    botDetail: async botId => ({id:botId,name:"Shared",model:"test",shared:true,activity:"idle",instructions:"Saved soul",enabledMcpServers:["calendar"],enabledTools:["terminal"],enabledSkills:["research"]}),
    status: async () => ({ connected: true }),
    capabilities: async () => new Proxy({}, { get: () => ({ supported: true }) }) as never,
    listBots: vi.fn(async () => bots),
    inflight: botId => ({botId,message:{id:"sid-inflight",role:"assistant",text:"Live reply"},activity:{state:"thinking"},toolCalls:[]}),
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
  return { bots, rosterChanged: () => { for (const changed of rosterWatchers) changed(); }, runtime: fixed as Runtime, change: (botId: string, kind?: "inflight") => { for (const changed of watchers.get(botId) ?? []) changed(kind); }, watchers };
}
async function setup() {
  const fake = runtimeDouble();
  const { app, store } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), fake.runtime, { background: false });
  apps.push(app);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const signIn = await fetch(`${base}/api/auth/local`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ member: "one" }) });
  const cookie = signIn.headers.getSetCookie()[0].split(";")[0];
  const { csrfToken } = await signIn.json() as { csrfToken: string };
  return { ...fake, app, store, base, cookie, csrfToken };
}
/** Reads server-sent text as it arrives, so a test can wait for the next notice. */
async function stream(url: string, cookie: string, headers: Record<string, string> = { cookie }) {
  const response = await fetch(url, { headers });
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
  it("rebuilds inflight redaction when another assistant becomes private", async () => {
    const s=await setup();
    const events=await stream(`${s.base}/api/bots/shared/events?inflight=1`,s.cookie);
    await events.until(()=>events.text.includes("retry"));
    s.runtime.inflight=botId=>({botId,message:{id:"sid-inflight",role:"assistant",text:"Private reply",reasoning:"Private thought",origin:{kind:"agent",visibility:"activity",handle:"hidden"}},activity:{state:"working"},toolCalls:[{id:"call",name:"message_agent",arguments:JSON.stringify({target:"hidden",text:"private input"}),result:"private output",status:"running"}]});
    s.store.savePresentation("hidden",{shared:false,ownerId:"local-two"});
    s.change("shared","inflight");
    await events.until(()=>events.text.includes("event: inflight"));
    expect(events.text).not.toContain("Private reply");
    expect(events.text).not.toContain("Private thought");
    expect(events.text).not.toContain("private input");
    expect(events.text).not.toContain("private output");
    expect(events.text).toContain("another member's assistant");
    await events.close();
  });
  describe("inflight growth notices", () => {
    const live = (text: string, extra: Partial<Message> = {}, id = "sid-inflight", toolCalls: ToolCall[] = [], activity: Activity = { state: "thinking", runId: "run" }) =>
      ({ botId: "shared", message: { id, role: "assistant" as const, text, ...extra }, activity, toolCalls });
    /** Sets the live reply, notices it, and resolves with what the stream wrote for it, if anything. */
    async function send(s: Awaited<ReturnType<typeof setup>>, events: Awaited<ReturnType<typeof stream>>, value: Inflight) {
      s.runtime.inflight = () => value;
      const before = events.text.length;
      s.change("shared", "inflight");
      await new Promise(resolve => setTimeout(resolve, 300));
      return events.text.slice(before);
    }
    const frames = (text: string) => text.split("\n\n").filter(frame => frame.startsWith("event:")).map(frame => {
      const [event, data] = frame.split("\n");
      return [event.slice(7), JSON.parse(data.slice(6))] as const;
    });

    it("keeps the ?inflight=1 payload as it was, whole on every notice", async () => {
      const s = await setup();
      const events = await stream(`${s.base}/api/bots/shared/events?inflight=1`, s.cookie);
      await events.until(() => events.text.includes("retry"));
      const first = await send(s, events, live("Hello"));
      const second = await send(s, events, live("Hello there", { reasoning: "Hmm" }));
      expect(first).toBe('event: inflight\ndata: {"botId":"shared","message":{"id":"sid-inflight","role":"assistant","text":"Hello"},"activity":{"state":"thinking","runId":"run"},"toolCalls":[]}\n\n');
      expect(second).toBe('event: inflight\ndata: {"botId":"shared","message":{"id":"sid-inflight","role":"assistant","text":"Hello there","reasoning":"Hmm"},"activity":{"state":"thinking","runId":"run"},"toolCalls":[]}\n\n');
      await events.close();
    });

    it("sends ?inflight=2 growth as a delta on a base, and everything else whole", async () => {
      const s = await setup();
      const events = await stream(`${s.base}/api/bots/shared/events?inflight=2`, s.cookie);
      await events.until(() => events.text.includes("retry"));
      const call: ToolCall = { id: "call", name: "web_search", arguments: "{}", status: "running" };
      const out = [
        await send(s, events, live("Hello")),
        await send(s, events, live("Hello there", { reasoning: "Hm" })),
        await send(s, events, live("Hello there, partner", { reasoning: "Hm, ok" }, "sid-inflight", [call], { state: "working", runId: "run" })),
        // Nothing grew: no event at all.
        await send(s, events, live("Hello there, partner", { reasoning: "Hm, ok" }, "sid-inflight", [call], { state: "working", runId: "run" })),
        // Not an extension of what was sent: whole again, then a delta from there.
        await send(s, events, live("Howdy", { reasoning: "Hm, ok" })),
        await send(s, events, live("Howdy y'all", { reasoning: "Hm, ok" })),
        // A new message id starts over.
        await send(s, events, live("Howdy y'all, again", {}, "next-inflight")),
        // Anything else about the message changing cannot ride on a delta.
        await send(s, events, live("Howdy y'all, again!", { createdAt: "2026-10-25T00:00:00Z" }, "next-inflight")),
      ];
      expect(out[3]).toBe("");
      expect(frames(out.join(""))).toEqual([
        ["inflight", live("Hello")],
        ["inflight-delta", { botId: "shared", messageId: "sid-inflight", baseTextLength: 5, baseReasoningLength: 0, appendText: " there", appendReasoning: "Hm", activity: { state: "thinking", runId: "run" } }],
        ["inflight-delta", { botId: "shared", messageId: "sid-inflight", baseTextLength: 11, baseReasoningLength: 2, appendText: ", partner", appendReasoning: ", ok", activity: { state: "working", runId: "run" }, toolCalls: [call] }],
        ["inflight", live("Howdy", { reasoning: "Hm, ok" })],
        ["inflight-delta", { botId: "shared", messageId: "sid-inflight", baseTextLength: 5, baseReasoningLength: 6, appendText: " y'all", activity: { state: "thinking", runId: "run" } }],
        ["inflight", live("Howdy y'all, again", {}, "next-inflight")],
        ["inflight", live("Howdy y'all, again!", { createdAt: "2026-10-25T00:00:00Z" }, "next-inflight")],
      ]);
      await events.close();
    });

    it("starts again whole after a change notice, which clients answer by dropping the live reply", async () => {
      const s = await setup();
      const events = await stream(`${s.base}/api/bots/shared/events?inflight=2`, s.cookie);
      await events.until(() => events.text.includes("retry"));
      await send(s, events, live("Hello"));
      s.change("shared");
      await events.until(() => events.notices() === 1);
      expect(frames(await send(s, events, live("Hello there")))).toEqual([["inflight", live("Hello there")]]);
      await events.close();
    });

    it("measures growth on the redacted reply, so a hidden handoff never leaks through a delta", async () => {
      const s = await setup();
      const events = await stream(`${s.base}/api/bots/shared/events?inflight=2`, s.cookie);
      await events.until(() => events.text.includes("retry"));
      s.store.savePresentation("hidden", { shared: false, ownerId: "local-two" });
      const handoff = (text: string, reasoning: string, result: string): Inflight => live(text, { reasoning, origin: { kind: "agent", visibility: "activity", handle: "hidden" } }, "sid-inflight",
        [{ id: "call", name: "message_agent", arguments: JSON.stringify({ target: "hidden", text: "private input" }), result, status: "running" }]);
      const out = [await send(s, events, handoff("Private reply", "Private thought", "private output")),
        // Raw text keeps growing while what this person may see stays the same.
        await send(s, events, handoff("Private reply, more", "Private thought, more", "private output, more")),
        await send(s, events, live("Public now"))].join("");
      expect(out).not.toMatch(/Private (reply|thought)|private (input|output)|more/);
      expect(frames(out).map(([event]) => event)).toEqual(["inflight", "inflight"]);
      await events.close();
    });
  });

  it("returns configuration through the lazy detail route", async () => {
    const s=await setup();
    const response=await fetch(`${s.base}/api/bots/shared`,{headers:{cookie:s.cookie}});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({instructions:"Saved soul",enabledMcpServers:["calendar"],enabledTools:["terminal"],enabledSkills:["research"]});
  });
  it("sends opted-in deltas without conversation notices and keeps legacy delta notices", async () => {
    const s = await setup();
    const current = await stream(`${s.base}/api/bots/shared/events?inflight=1`, s.cookie);
    const legacy = await stream(`${s.base}/api/bots/shared/events`, s.cookie);
    await current.until(() => current.text.includes("retry"));
    for (let i=0;i<20;i++) s.change("shared", "inflight");
    await current.until(() => current.text.includes("event: inflight"));
    await legacy.until(() => legacy.notices() === 1);
    expect(current.text).toContain('"text":"Live reply"');
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(current.notices()).toBe(0);
    s.change("shared");
    await current.until(() => current.notices() === 1);
    await current.close(); await legacy.close();
  });
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

  it("serves the iOS app's bearer session and ends when that session is revoked", async () => {
    const s = await setup();
    const token = randomBytes(32).toString("base64url");
    s.store.nativeSession(hash(token), "local-one", Date.now() + 60_000);
    const events = await stream(`${s.base}/api/bots/shared/events`, "", { authorization: `Bearer ${token}` });
    expect(events.response.status).toBe(200);
    await events.until(() => events.text.includes("retry"));
    s.change("shared");
    await events.until(() => events.notices() === 1);
    s.store.deleteNativeSession(hash(token));
    await new Promise(resolve => setTimeout(resolve, 1100));
    s.change("shared");
    await events.until(() => events.done);
    expect(events.notices()).toBe(1);
  });

  it("closes open streams when the app shuts down", async () => {
    const s = await setup();
    const events = await stream(`${s.base}/api/bots/shared/events`, s.cookie);
    await events.until(() => events.text.includes("retry"));
    await apps.pop()!.close();
    await events.until(() => events.done);
  });
});


describe("roster compatibility and household events", () => {
  it("keeps full configuration by default and omits it only for opted-in rosters", async () => {
    const s = await setup();
    for (const route of ["bootstrap", "bots"]) {
      const read = async (suffix: string) => {
        const response = await fetch(`${s.base}/api/${route}${suffix}`, { headers: { cookie: s.cookie } });
        expect(response.status).toBe(200);
        const value = await response.json();
        return route === "bootstrap" ? value.bots[0] : value[0];
      };
      const full = await read("");
      expect(full).toMatchObject({ instructions: "Saved soul", enabledMcpServers: ["calendar"],
        enabledTools: ["terminal"], enabledSkills: ["research"] });
      const lean = await read("?roster=lean");
      for (const key of ["instructions", "enabledMcpServers", "enabledTools", "enabledSkills"]) expect(lean).not.toHaveProperty(key);
    }
  });

  it("rejects anonymous household subscriptions", async () => {
    const s = await setup();
    const response = await fetch(`${s.base}/api/events`);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("session_expired");
  });

  it("ignores unchanged frames, coalesces evaluations, and notifies only the private bot's owner", async () => {
    const s = await setup();
    s.bots.push({ ...s.bots[0], id: "private", name: "Secret assistant" });
    s.store.savePresentation("private", { shared: false, ownerId: "local-one" });
    const login = await fetch(`${s.base}/api/auth/local`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ member: "two" }) });
    const twoCookie = login.headers.getSetCookie()[0].split(";")[0];
    const owner = await stream(`${s.base}/api/events`, s.cookie);
    const other = await stream(`${s.base}/api/events`, twoCookie);
    const notices = (value: typeof owner) => value.text.split("event: roster").length - 1;
    expect(notices(owner)).toBe(0);
    vi.mocked(s.runtime.listBots).mockClear();
    for (let i = 0; i < 40; i++) s.rosterChanged();
    await new Promise(resolve => setTimeout(resolve, 1150));
    expect(notices(owner)).toBe(0);
    expect(notices(other)).toBe(0);
    expect(s.runtime.listBots).toHaveBeenCalledOnce();
    s.bots[1].activity = "working";
    for (let i = 0; i < 40; i++) s.rosterChanged();
    await owner.until(() => notices(owner) === 1);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(notices(owner)).toBe(1);
    expect(notices(other)).toBe(0);
    expect(s.runtime.listBots).toHaveBeenCalledTimes(2);
    expect(owner.text).toBe("retry: 3000\n\nevent: roster\ndata: roster\n\n");
    expect(owner.text).not.toMatch(/private|Secret|working/);
    await owner.close(); await other.close();
  });

  it("lets the bootstrap that follows a roster notice reuse the evaluation's read", async () => {
    const s = await setup();
    // Copies, as Hermes answers: a held read must not change because the double's rows did.
    s.runtime.listBots = vi.fn(async () => s.bots.map(bot => ({ ...bot })));
    const events = await stream(`${s.base}/api/events`, s.cookie);
    await events.until(() => events.text.includes("retry"));
    s.bots[0].activity = "working";
    vi.mocked(s.runtime.listBots).mockClear();
    s.rosterChanged();
    await events.until(() => events.text.includes("event: roster"));
    expect(s.runtime.listBots).toHaveBeenCalledTimes(1);
    // The stream's own opening read is still inside the hold, so only the evaluation's read can show this.
    const read = async () => (await (await fetch(`${s.base}/api/bootstrap?roster=lean`, { headers: { cookie: s.cookie } })).json() as { bots: Bot[] }).bots[0].activity;
    expect(await read()).toBe("working");
    expect(await read()).toBe("working");
    expect(s.runtime.listBots).toHaveBeenCalledTimes(1);
    await events.close();
  });

  it("notifies on an app write only when the visible roster changes and ends on sign-out", async () => {
    const s = await setup();
    const events = await stream(`${s.base}/api/events`, s.cookie);
    s.runtime.submit = async input => {
      s.bots[0].activity = "thinking";
      return { requestId: input.requestId, status: "accepted", runId: "run" };
    };
    const headers = { cookie: s.cookie, origin, "x-csrf-token": s.csrfToken, "content-type": "application/json" };
    const send = () => fetch(`${s.base}/api/bots/shared/messages`, { method: "POST", headers,
      body: JSON.stringify({ requestId: randomUUID(), text: "Hello" }) });
    expect((await send()).status).toBe(200);
    await events.until(() => events.text.includes("event: roster"));
    expect((await send()).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(events.text.split("event: roster")).toHaveLength(2);
    expect((await fetch(`${s.base}/api/auth/logout`, { method: "POST", headers: { cookie: s.cookie, origin, "x-csrf-token": s.csrfToken } })).status).toBe(200);
    s.rosterChanged();
    await events.until(() => events.done);
  });
});
