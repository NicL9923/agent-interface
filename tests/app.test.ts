import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { publicApiRoutes } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import type { Avatar, Capabilities, ConversationOptions, Message, Runtime, Submission } from "../src/shared/types.js";
import { historyWindow } from "../src/shared/history.js";
import { MAX_DOWNLOAD_BYTES } from "../src/shared/uploads.js";
const origin = "http://127.0.0.1:3000";
// This is an isolated app contract double, not evidence of Hermes integration.
function runtimeDouble() {
  let calls = 0,
    steers = 0,
    unknown = false;
  const capabilities = Object.fromEntries(
    [
      "chat",
      "steering",
      "approvals",
      "uploads",
      "generatedFiles",
      "botConfiguration",
      "tools",
      "skills",
      "routines",
      "durableEvents",
      "idempotency",
      "imageGeneration",
      "stop",
      "portraitGeneration",
      "avatarMetadata",
    ].map((key) => [key, { supported: true }]),
  ) as Capabilities;
  let activity = "idle";
  const runtime: Runtime = {
    status: async () => ({ connected: true, version: "contract-double" }),
    capabilities: async () => capabilities,
    listBots: async () => [
      {
        id: "shared",
        name: "Shared",
        model: "test",
        shared: true,
        activity: "idle",
      },
    ],
    saveBot: async (input, id = "new") => ({ ...input, id, activity: "idle" }),
    deleteBot: async () => {},
    conversation: async () => ({
      botId: "shared",
      messages: [],
      activity: {
        state: activity as "idle",
        runId: activity === "working" ? "run" : undefined,
      },
      approvals: [
        {
          id: "approval",
          title: "Use tool?",
          detail: "A test tool",
          status: "pending",
        },
      ],
      files: [],
    }),
    submit: async (input: Submission) => {
      calls++;
      if (unknown) throw new Error("Response lost after possible admission");
      return { requestId: input.requestId, status: "accepted", runId: "run" };
    },
    steer: async (input: Submission) => {
      steers++;
      return { requestId: input.requestId, status: "accepted", runId: "run" };
    },
    lookupSubmission: async () => null,
    answerRequest: async () => {},
    approve: async () => {},
    upload: async () => ({ id: "file", name: "test", mime: "text/plain" }),
    download: async () => ({
      body: new Blob(["hello"]).stream(),
      name: "test",
      mime: "text/plain",
    }),
    tools: async () => [],
    setTools: async () => {},
    skills: async () => [],
    setSkills: async () => {},
    routines: async () => [],
    saveRoutine: async (input) => ({ ...input, id: "routine" }),
    deleteRoutine: async () => {},
    discoverEvents: async (cursor) => ({ cursor, events: [] }),
    close: async () => {},
    stop: async () => {},
    generatePortrait: async () => ({
      id: "portrait",
      name: "portrait",
      mime: "image/png",
    }),
    setAvatar: async () => {},
  };
  return {
    runtime,
    capabilities,
    get calls() {
      return calls;
    },
    get steers() {
      return steers;
    },
    set unknown(v: boolean) {
      unknown = v;
    },
    set activity(v: string) {
      activity = v;
    },
  };
}
async function login(
  app: Awaited<ReturnType<typeof createApp>>["app"],
  member = "one",
) {
  const result = await app.inject({
    method: "POST",
    url: "/api/auth/local",
    headers: { origin },
    payload: { member },
  });
  expect(result.statusCode).toBe(200);
  return {
    cookie: result.cookies[0].name + "=" + result.cookies[0].value,
    "x-csrf-token": result.json().csrfToken,
    origin,
  };
}
const config = () =>
  loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" });
describe("authentication and household state", () => {
  it("saves seasonal avatars through native metadata and round-trips them through household presentation", async () => {
    const fake = runtimeDouble();
    let nativeAvatar: Avatar | undefined;
    const originalList = fake.runtime.listBots;
    fake.runtime.listBots = async () => (await originalList()).map(bot => ({ ...bot, avatar: nativeAvatar }));
    fake.runtime.setAvatar = async (_id, value) => { nativeAvatar = value; };
    const { app } = await createApp(config(), fake.runtime, { background: false });
    try {
      const headers = await login(app);
      for (const family of ["pumpkin", "santa", "rudolph", "turkey", "bunny"] as const) {
        const value: Avatar = { mode: "mascot", family, color: "#FF9800", eyes: "round", accessory: "none", eyeWidth: 1.1 };
        const saved = await app.inject({ method: "PUT", url: "/api/bots/shared/avatar", headers, payload: value });
        expect(saved.statusCode).toBe(200);
        expect(saved.json()).toEqual(value);
        expect(nativeAvatar).toEqual(value);
        expect((await app.inject({ url: "/api/bootstrap", headers })).json().bots[0].avatar).toEqual(value);
        fake.capabilities.avatarMetadata.supported = false;
        expect((await app.inject({ url: "/api/bootstrap", headers })).json().bots[0].avatar).toEqual(value);
        fake.capabilities.avatarMetadata.supported = true;
      }
    } finally { await app.close(); }
  });

  it("fails closed for production bypass and absent production identity settings", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", LOCAL_DEV_AUTH: "true" }),
    ).toThrow("Local development auth");
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "Production requires",
    );
    expect(() =>
      loadConfig({ HOST: "0.0.0.0", LOCAL_DEV_AUTH: "true" }),
    ).toThrow("loopback");
  });
  it("requires a session on every non-public API route, including percent-encoded paths", async () => {
    const { app, routes } = await createApp(config(), runtimeDouble().runtime, { background: false });
    try {
      const gated = routes.filter(({ method, url }) => url.startsWith("/api/") && method !== "HEAD" && !publicApiRoutes.includes(url));
      expect(gated.length).toBeGreaterThan(50);
      for (const { method, url } of gated) {
        const concrete = url.replace(/:[^/]+/g, "x").replace("*", "x");
        // Fastify decodes "%61" before routing, so the encoded form must reach the same gate.
        for (const path of [concrete, concrete.replace("/api/", "/%61pi/"), concrete.replace("/api/", "/%61%70%69/")]) {
          const response = await app.inject({ method: method as "GET", url: path, headers: { origin: "https://attacker.invalid" } });
          expect({ method, path, status: response.statusCode }).toEqual({ method, path, status: 401 });
        }
      }
      // The built client's static wildcard also matches unknown API paths.
      for (const path of ["/api/no-such-route", "/%61pi/no-such-route"])
        expect((await app.inject(path)).statusCode).toBe(401);
      // A signed-in browser still needs its CSRF token and Origin on an encoded write.
      const { "x-csrf-token": csrf, ...cookieOnly } = await login(app);
      expect(csrf).toBeTruthy();
      for (const headers of [cookieOnly, { ...cookieOnly, "x-csrf-token": csrf, origin: "https://attacker.invalid" }])
        expect((await app.inject({ method: "POST", url: "/%61pi/bots/shared/stop", headers })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it("requires login and rejects foreign-origin or missing-CSRF writes", async () => {
    const { app } = await createApp(config(), runtimeDouble().runtime, {
      background: false,
    });
    expect((await app.inject("/api/bootstrap")).statusCode).toBe(401);
    const headers = await login(app);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/preferences",
          headers: { cookie: headers.cookie, origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/bots/shared/stop",
          headers: { ...headers, origin: "https://other.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: "/api/bootstrap", headers })).headers[
        "cache-control"
      ],
    ).toBe("no-store");
    await app.close();
  });
  it("verifies exact allowed email and verified Google identity", async () => {
    let email = "family@example.test",
      verified = false;
    const c = loadConfig({
      GOOGLE_CLIENT_ID: "test",
      HOUSEHOLD_EMAILS: "family@example.test",
      APP_DATABASE: ":memory:",
    });
    const { app } = await createApp(c, runtimeDouble().runtime, {
      background: false,
      verifyGoogle: async () => ({
        sub: "subject",
        email,
        email_verified: verified,
        name: "Family",
      }),
    });
    const signIn = () =>
      app.inject({
        method: "POST",
        url: "/api/auth/google",
        headers: { origin },
        payload: { credential: "test" },
      });
    expect((await signIn()).statusCode).toBe(403);
    verified = true;
    email = "family@example.test.attacker.example";
    expect((await signIn()).statusCode).toBe(403);
    email = "FAMILY@example.test";
    expect((await signIn()).statusCode).toBe(200);
    await app.close();
  });
  it("lists a private assistant, with its latest reply, only for its owner", async () => {
    const fake = runtimeDouble();
    const lastMessage = { text: "Your private reply", at: "2026-10-08T12:00:00.000Z" };
    fake.runtime.listBots = async () => [
      { id: "shared", name: "Shared", model: "test", shared: true, activity: "idle", lastMessage },
      { id: "mine", name: "Mine", model: "test", shared: false, activity: "idle", lastMessage },
    ];
    const { app, store } = await createApp(config(), fake.runtime, { background: false });
    const one = await login(app), two = await login(app, "two");
    const ownerId = (await app.inject({ url: "/api/bootstrap", headers: one })).json().user.id;
    store.savePresentation("mine", { shared: false, ownerId });
    for (const url of ["/api/bootstrap", "/api/bots"]) {
      const bots = (response: { json(): { bots?: unknown[] } | unknown[] }) => {
        const value = response.json();
        return (Array.isArray(value) ? value : value.bots) as { id: string; lastMessage?: unknown }[];
      };
      const theirs = bots(await app.inject({ url, headers: two }));
      expect(theirs.map(bot => bot.id)).toEqual(["shared"]);
      expect(theirs[0].lastMessage).toEqual(lastMessage);
      expect(bots(await app.inject({ url, headers: one })).find(bot => bot.id === "mine")?.lastMessage).toEqual(lastMessage);
    }
    await app.close();
  });
  it("windows conversation history only when the web client asks", async () => {
    const fake = runtimeDouble();
    const conversation = await fake.runtime.conversation("shared");
    const messages = Array.from({ length: 30 }, (_, turn) => [
      { id: `p${turn}`, role: "user" as const, text: `Prompt ${turn}` },
      { id: `a${turn}`, role: "assistant" as const, text: `Reply ${turn}` },
    ]).flat();
    fake.runtime.conversation = async () => ({ ...conversation, messages });
    const { app } = await createApp(config(), fake.runtime, { background: false });
    const one = await login(app);
    const read = async (query = "") => (await app.inject({ url: `/api/bots/shared/conversation${query}`, headers: one })).json();
    const native = await read();
    expect(native.messages).toHaveLength(60);
    expect(native).not.toHaveProperty("earlier");
    const page = await read("?turns=20");
    expect(page.messages[0].id).toBe("p10");
    expect(page.earlier).toBe(20);
    const extended = await read("?start=p10&turns=20");
    expect(extended.messages[0].id).toBe("p0");
    expect(extended.earlier).toBe(0);
    expect((await app.inject({ url: "/api/bots/shared/conversation?turns=-1", headers: one })).statusCode).toBe(400);
    await app.close();
  });
  it("sends signed file references only for the window and lists earlier ones on demand", async () => {
    const fake = runtimeDouble();
    const conversation = await fake.runtime.conversation("shared");
    const file = (n: number) => ({ id: `f${n}`, name: `file-${n}.txt`, mime: "text/plain", url: `/api/files/f${n}` });
    const messages = Array.from({ length: 30 }, (_, turn) => [
      { id: `p${turn}`, role: "user" as const, text: `Prompt ${turn}`, ...(turn === 2 ? { files: [file(2)] } : {}) },
      // The newest reply passes along a file first shared in an early turn.
      { id: `a${turn}`, role: "assistant" as const, text: `Reply ${turn}`, files: turn === 29 ? [file(turn), file(0)] : [file(turn)] },
    ]).flat();
    const files = messages.flatMap(message => message.files ?? []);
    fake.runtime.conversation = async () => ({ ...conversation, messages, files });
    const { app } = await createApp(config(), fake.runtime, { background: false });
    const one = await login(app);
    const read = async (url: string) => (await app.inject({ url, headers: one })).json();
    // The native app reads the whole history and keeps every reference.
    expect((await read("/api/bots/shared/conversation")).files).toEqual(files);
    const page = await read("/api/bots/shared/conversation?turns=20");
    const ids = (list: { id: string }[]) => [...new Set(list.map(item => item.id))];
    expect(ids(page.files)).toEqual(["f0", ...Array.from({ length: 20 }, (_, n) => `f${n + 10}`)]);
    // Earlier turns hold f1 to f9 and the user's f2; f0 is also in the window.
    expect(page.earlierFiles).toBe(9);
    const earlier = await read("/api/bots/shared/files?before=p10");
    expect(earlier.messages.map((message: { id: string }) => message.id)).toEqual(["a0", "a1", "p2", "a2", ...Array.from({ length: 7 }, (_, n) => `a${n + 3}`)]);
    expect(earlier.messages[2]).toEqual({ id: "p2", role: "user", files: [file(2)] });
    // A window start that left the history lists every file-bearing message.
    expect((await read("/api/bots/shared/files?before=gone")).messages).toHaveLength(31);
    expect((await read("/api/bots/shared/conversation?start=p0")).earlierFiles).toBe(0);
    await app.close();
  });
  it("answers a window Hermes already cut exactly as it answers its own cut", async () => {
    const fake = runtimeDouble();
    const conversation = await fake.runtime.conversation("shared");
    const file = (n: number) => ({ id: `f${n}`, name: `file-${n}.txt`, mime: "text/plain", url: `/api/files/f${n}` });
    const messages: Message[] = Array.from({ length: 30 }, (_, turn) => [
      { id: `p${turn}`, role: "user" as const, text: `Prompt ${turn}`, ...(turn === 2 ? { files: [file(2)] } : {}) },
      { id: `a${turn}`, role: "assistant" as const, text: `Reply ${turn}`, ...(turn % 3 === 0 ? { files: turn === 27 ? [file(turn), file(0)] : [file(turn)] } : {}) },
    ]).flat();
    // The add-on's cut, as src/hermes/extension.py history_window makes it.
    const cut = (window: NonNullable<ConversationOptions["window"]>) => {
      const { earlier } = historyWindow(messages, window);
      if (!earlier || messages[earlier].role !== "user") return undefined;
      const kept = new Set<number>(); let prompt: number | undefined;
      messages.slice(0, earlier).forEach((message, index) => {
        if (message.role === "user") prompt = index;
        if (message.files?.length) { kept.add(index); if (message.role === "assistant" && prompt !== undefined) kept.add(prompt); }
      });
      return { earlier, context: [...kept].sort((a, b) => a - b).map(index => messages[index]) };
    };
    const full = { ...conversation, messages, files: messages.flatMap(message => message.files ?? []) };
    const answers = async (runtime: Runtime) => {
      const { app } = await createApp(config(), runtime, { background: false });
      const one = await login(app);
      const bodies = [];
      for (const query of ["?turns=20", "?start=p10&turns=20", "?start=p15", "?start=a12", "?turns=40", "?start=gone"])
        bodies.push((await app.inject({ url: `/api/bots/shared/conversation${query}`, headers: one })).json());
      await app.close();
      return bodies;
    };
    fake.runtime.conversation = async () => full;
    const ownCut = await answers(fake.runtime);
    let windows = 0;
    fake.runtime.conversation = async (_botId, options) => {
      const window = options?.window && cut(options.window);
      if (!window) return full;
      windows++;
      const shown = messages.slice(window.earlier);
      return { ...conversation, messages: shown, window, files: [...window.context, ...shown].flatMap(message => message.files ?? []) };
    };
    expect(await answers(fake.runtime)).toEqual(ownCut);
    expect(windows).toBe(3);
    expect(ownCut[0].earlierFiles).toBeGreaterThan(0);
  });
  it("keeps personal drafts and read positions separate while bots stay shared", async () => {
    const { app } = await createApp(config(), runtimeDouble().runtime, {
      background: false,
    });
    const one = await login(app),
      two = await login(app, "two");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/bots/shared/draft",
          headers: one,
          payload: { text: "Unsent", attachments: [] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({ url: "/api/bots/shared/draft", headers: two })
      ).json(),
    ).toBe(null);
    expect(
      (await app.inject({ url: "/api/bots/shared/draft", headers: one })).json()
        .text,
    ).toBe("Unsent");
    const position = await app.inject({ method: "PUT", url: "/api/bots/shared/read-position",
      headers: one, payload: { messageId: "earlier-answer" } });
    expect(position.statusCode).toBe(200);
    expect(position.json()).toEqual({ messageId: "earlier-answer" });
    expect((await app.inject({ url: "/api/bots/shared/conversation", headers: one })).json().readPosition)
      .toEqual({ messageId: "earlier-answer" });
    expect((await app.inject({ url: "/api/bots/shared/read-position", headers: two })).json()).toBe(null);
    expect(
      (await app.inject({ url: "/api/bootstrap", headers: two })).json().bots[0]
        .shared,
    ).toBe(true);
    await app.close();
  });
});
describe("safe admission, steering, and approvals", () => {
  it.each(["a Hermes restart", "a stopped task terminal event"])("keeps interruption review retryable after %s with canonical admission", async () => {
    const fake=runtimeDouble();
    fake.runtime.canonicalSubmit=async()=>true;
    fake.runtime.conversation=vi.fn().mockRejectedValue(new Error("Unexpected read"));
    fake.runtime.submit=vi.fn(async input=>{
      if(!input.reviewedInterruption)throw Object.assign(new Error("Review"),{code:"interruption_pending",statusCode:409});
      return {requestId:input.requestId,status:"accepted" as const,runId:"run"};
    });
    const {app,store}=await createApp(config(),fake.runtime,{background:false});
    const headers=await login(app),payload={requestId:randomUUID(),text:"Continue"};
    const first=await app.inject({method:"POST",url:"/api/bots/shared/messages",headers,payload});
    expect(first.statusCode).toBe(409);
    expect(first.json().error).toBe("Review the interrupted task before starting another message.");
    const sent=await app.inject({method:"POST",url:"/api/bots/shared/messages",headers,payload:{...payload,reviewedInterruption:true}});
    expect(sent.json().status).toBe("accepted");
    expect(fake.runtime.conversation).not.toHaveBeenCalled();
    expect(store.recipients({id:"event",botId:"shared",runId:"run",kind:"completed",title:"Done",occurredAt:""})).toEqual(["local-one"]);
    await app.close();
  });
  it("forwards a request once, rejects reused IDs with changed content, and persists uncertain intent across app restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-interface-"));
    const path = join(dir, "app.sqlite");
    const c = { ...config(), database: path };
    const fake = runtimeDouble();
    fake.unknown = true;
    let result = await createApp(c, fake.runtime, { background: false });
    const headers = await login(result.app);
    const requestId = randomUUID(),
      payload = { requestId, text: "Do the thing", attachments: [] };
    const submit = () =>
      result.app.inject({
        method: "POST",
        url: "/api/bots/shared/messages",
        headers,
        payload,
      });
    expect((await submit()).json().status).toBe("uncertain");
    expect((await submit()).json().status).toBe("uncertain");
    expect(fake.calls).toBe(1);
    expect(
      (
        await result.app.inject({
          method: "POST",
          url: "/api/bots/shared/messages",
          headers,
          payload: { ...payload, text: "Changed" },
        })
      ).statusCode,
    ).toBe(409);
    await result.app.close();
    result = await createApp(c, fake.runtime, { background: false });
    expect((await submit()).json().status).toBe("uncertain");
    expect(fake.calls).toBe(1);
    await result.app.close();
    rmSync(dir, { recursive: true });
  });
  it("defaults active work to steering and records both task participants", async () => {
    const fake = runtimeDouble();
    const { app, store } = await createApp(config(), fake.runtime, {
      background: false,
    });
    const one = await login(app),
      two = await login(app, "two");
    await app.inject({
      method: "POST",
      url: "/api/bots/shared/messages",
      headers: one,
      payload: { requestId: randomUUID(), text: "Start" },
    });
    fake.activity = "working";
    await app.inject({
      method: "POST",
      url: "/api/bots/shared/messages",
      headers: two,
      payload: { requestId: randomUUID(), text: "Use blue" },
    });
    expect(fake.calls).toBe(1);
    expect(fake.steers).toBe(1);
    expect(
      store.recipients({
        id: "event",
        botId: "shared",
        runId: "run",
        kind: "completed",
        title: "Done",
        occurredAt: "",
      }),
    ).toEqual(["local-one", "local-two"]);
    await app.close();
  });
  it("lets either person approve once and records attribution", async () => {
    const { app, store } = await createApp(config(), runtimeDouble().runtime, {
      background: false,
    });
    const two = await login(app, "two");
    const options = {
      method: "POST" as const,
      url: "/api/bots/shared/approvals/approval",
      headers: two,
      payload: { decision: "approved" },
    };
    expect((await app.inject(options)).statusCode).toBe(200);
    expect(store.approval("approval")).toMatchObject({
      userId: "local-two",
      decision: "approved",
    });
    expect((await app.inject(options)).statusCode).toBe(409);
    await app.close();
  });
  it("explains unavailable runtime capabilities instead of accepting a fake operation", async () => {
    const fake = runtimeDouble();
    fake.capabilities.tools = {
      supported: false,
      reason: "This revision has no tool configuration API",
    };
    const { app } = await createApp(config(), fake.runtime, {
      background: false,
    });
    const headers = await login(app);
    const result = await app.inject({
      method: "PUT",
      url: "/api/bots/shared/tools",
      headers,
      payload: { ids: [] },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toContain("no tool configuration");
    await app.close();
  });
});
it("invalidates an active session when its identity is removed from the allowlist", async () => {
  const c = loadConfig({
    GOOGLE_CLIENT_ID: "test",
    HOUSEHOLD_EMAILS: "family@example.test",
    APP_DATABASE: ":memory:",
  });
  const { app } = await createApp(c, runtimeDouble().runtime, {
    background: false,
    verifyGoogle: async () => ({
      sub: "subject",
      email: "family@example.test",
      email_verified: true,
      name: "Family",
    }),
  });
  const result = await app.inject({
    method: "POST",
    url: "/api/auth/google",
    headers: { origin },
    payload: { credential: "test" },
  });
  const headers = {
    cookie: result.cookies[0].name + "=" + result.cookies[0].value,
  };
  expect(
    (await app.inject({ url: "/api/bootstrap", headers })).statusCode,
  ).toBe(200);
  c.householdEmails = [];
  expect(
    (await app.inject({ url: "/api/bootstrap", headers })).statusCode,
  ).toBe(401);
  await app.close();
});
it("requires review acknowledgement before starting new work after interruption", async () => {
  const fake = runtimeDouble();
  fake.activity = "interrupted";
  const { app } = await createApp(config(), fake.runtime, {
    background: false,
  });
  const headers = await login(app),
    payload = { requestId: randomUUID(), text: "Restart after review" };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/bots/shared/messages",
        headers,
        payload,
      })
    ).statusCode,
  ).toBe(409);
  expect(fake.calls).toBe(0);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/bots/shared/messages",
        headers,
        payload: { ...payload, reviewedInterruption: true },
      })
    ).json().status,
  ).toBe("accepted");
  await app.close();
});
it("reconciles a client-only pending ID and preserves uncertainty when the runtime is unavailable", async () => {
  const fake = runtimeDouble();
  const { app } = await createApp(config(), fake.runtime, {
    background: false,
  });
  const headers = await login(app),
    requestId = randomUUID();
  const query = () =>
    app.inject({ url: `/api/submissions/${requestId}`, headers });
  expect((await query()).json().status).toBe("uncertain");
  fake.runtime.lookupSubmission = async () => ({
    requestId,
    status: "accepted",
    runId: "run",
  });
  expect((await query()).json().status).toBe("accepted");
  fake.runtime.lookupSubmission = async () => {
    throw new Error("Offline");
  };
  expect((await query()).json().status).toBe("uncertain");
  await app.close();
});
it("scopes canonical row attribution by bot because each Hermes profile can reuse row IDs", () => {
  const store = new Store(":memory:");
  store.user({ id: "one", name: "One", email: "one@example.test" });
  store.user({ id: "two", name: "Two", email: "two@example.test" });
  for (const [botId, senderId] of [
    ["first", "one"],
    ["second", "two"],
  ]) {
    const requestId = randomUUID();
    store.intent({
      botId,
      senderId,
      requestId,
      text: "Synthetic",
      attachments: [],
    });
    store.receipt({ requestId, status: "accepted", messageId: "1" });
  }
  expect(store.submissionForMessage("first", "1")?.input.senderId).toBe("one");
  expect(store.submissionForMessage("second", "1")?.input.senderId).toBe("two");
  store.close();
});
it("requires an explicit review and durable idempotency before retrying the same uncertain message", async () => {
  const fake = runtimeDouble();
  fake.unknown = true;
  const { app } = await createApp(config(), fake.runtime, {
    background: false,
  });
  const headers = await login(app),
    payload = { requestId: randomUUID(), text: "Uncertain original" };
  const submit = (reviewedUncertain = false) =>
    app.inject({
      method: "POST",
      url: "/api/bots/shared/messages",
      headers,
      payload: { ...payload, reviewedUncertain },
    });
  await submit();
  await submit();
  expect(fake.calls).toBe(1);
  fake.capabilities.idempotency.supported = false;
  expect((await submit(true)).statusCode).toBe(409);
  expect(fake.calls).toBe(1);
  fake.capabilities.idempotency.supported = true;
  await submit(true);
  expect(fake.calls).toBe(2);
  await app.close();
});
it("accepts long signed file identifiers in uploads, drafts, and authenticated downloads", async () => {
  const { app } = await createApp(config(), runtimeDouble().runtime, {
    background: false,
  });
  const headers = await login(app),
    fileId = "a".repeat(500) + "." + "b".repeat(43),
    attachment = { id: fileId, name: "proof.txt", mime: "text/plain" };
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/bots/shared/draft",
        headers,
        payload: { text: "Draft", attachments: [attachment] },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ url: `/api/files/${fileId}`, headers })).statusCode,
  ).toBe(200);
  await app.close();
});
it("streams downloads under the shared cap and explains a file that is too large", async () => {
  const fake = runtimeDouble();
  const limits: number[] = [];
  fake.runtime.download = async (_id, maxBytes) => {
    limits.push(maxBytes);
    if (limits.length > 1) throw Object.assign(new Error("huge.zip is larger than 100 MB, the most this app opens."), { statusCode: 502, code: "file_too_large", expose: true });
    return { name: "notes.txt", mime: "text/plain", size: 11, body: new Blob(["hello ", "world"]).stream() };
  };
  const { app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), fake.runtime, { background: false });
  const headers = await login(app);
  const file = await app.inject({ url: "/api/files/a.b", headers });
  expect([file.statusCode, file.body, file.headers["content-length"]]).toEqual([200, "hello world", "11"]);
  // A file id is signed over a path, so one overwritten later must never come from a browser cache.
  expect(file.headers["cache-control"]).toBe("no-store");
  const tooLarge = await app.inject({ url: "/api/files/a.b", headers });
  expect(tooLarge.statusCode).toBe(502);
  expect(tooLarge.json()).toMatchObject({ code: "file_too_large", error: "huge.zip is larger than 100 MB, the most this app opens." });
  expect(limits).toEqual([MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES]);
  await app.close();
});
it("answers HEAD without reading the file and reports a stream that fails before its first byte", async () => {
  const fake = runtimeDouble();
  const cancel = vi.fn();
  let fail = false;
  fake.runtime.download = async () => ({ name: "notes.txt", mime: "text/plain", size: 5, body: new ReadableStream({
    pull: controller => fail ? controller.error(Object.assign(new Error("notes.txt is larger than 100 MB, the most this app opens."), { statusCode: 502, code: "file_too_large", expose: true })) : new Promise(() => {}),
    cancel,
  }) });
  const { app } = await createApp(config(), fake.runtime, { background: false });
  const headers = await login(app);
  // The response returns either way; the stalled Hermes read must also be cancelled.
  const head = await app.inject({ method: "HEAD", url: "/api/files/a.b", headers });
  expect([head.statusCode, head.headers["content-length"], head.body]).toEqual([200, "5", ""]);
  expect(cancel.mock.calls).toEqual([[undefined]]);
  fail = true;
  const failed = await app.inject({ url: "/api/files/a.b", headers });
  expect([failed.statusCode, failed.headers["content-type"], failed.headers["content-disposition"]]).toEqual([502, "application/json; charset=utf-8", undefined]);
  expect(failed.json()).toMatchObject({ code: "file_too_large", error: "notes.txt is larger than 100 MB, the most this app opens." });
  await app.close();
});
it("preserves a native model confirmation request until the user explicitly confirms", async () => {
  const fake = runtimeDouble();
  fake.runtime.saveBot = async (input, id = "new") => {
    if (!input.confirmModel)
      throw Object.assign(new Error("Confirm this model selection."), {
        statusCode: 409,
        code: "MODEL_CONFIRMATION_REQUIRED",
        confirmRequired: true,
      });
    return { ...input, id, activity: "idle" };
  };
  const { app } = await createApp(config(), fake.runtime, {
    background: false,
  });
  const headers = await login(app),
    payload = {
      name: "Shared",
      instructions: "Safe synthetic instructions",
      provider: "existing",
      model: "selected",
      shared: true,
    };
  const first = await app.inject({
    method: "PATCH",
    url: "/api/bots/shared",
    headers,
    payload,
  });
  expect(first.statusCode).toBe(409);
  expect(first.json()).toMatchObject({
    confirmRequired: true,
    code: "MODEL_CONFIRMATION_REQUIRED",
  });
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/bots/shared",
        headers,
        payload: { ...payload, confirmModel: true },
      })
    ).statusCode,
  ).toBe(200);
  await app.close();
});
it("answers live clarification requests and directs credential requests to the official interface", async () => {
  const fake = runtimeDouble();
  const original = fake.runtime.conversation;
  fake.runtime.conversation = async (botId) => ({
    ...(await original(botId)),
    attention: [
      {
        id: "clarify",
        kind: "clarify",
        title: "Question",
        detail: "Choose a color",
        questions: [{ id: "color", prompt: "Color?" }],
      },
      {
        id: "credential",
        kind: "official",
        title: "Provider sign-in",
        detail: "Use official Hermes",
      },
    ],
  });
  let answered = false;
  fake.runtime.answerRequest = async () => {
    answered = true;
  };
  const { app } = await createApp(config(), fake.runtime, {
    background: false,
  });
  const headers = await login(app);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/bots/shared/requests/credential",
        headers,
        payload: { answers: { secret: "do not forward" } },
      })
    ).statusCode,
  ).toBe(409);
  expect(answered).toBe(false);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/bots/shared/requests/clarify",
        headers,
        payload: { answers: { color: "Blue" } },
      })
    ).statusCode,
  ).toBe(200);
  expect(answered).toBe(true);
  await app.close();
});
it("logs out and invalidates the server session immediately", async () => {
  const { app } = await createApp(config(), runtimeDouble().runtime, {
    background: false,
  });
  const headers = await login(app);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ url: "/api/bootstrap", headers })).statusCode,
  ).toBe(401);
  await app.close();
});
it("requires production identity and HTTPS on any public listener or origin, even when NODE_ENV is development", () => {
  expect(() =>
    loadConfig({ NODE_ENV: "development", HOST: "0.0.0.0" }),
  ).toThrow("Production requires");
  expect(() =>
    loadConfig({
      NODE_ENV: "development",
      APP_ORIGIN: "http://public.example.test",
    }),
  ).toThrow("Production requires");
  const configured = loadConfig({
    NODE_ENV: "development",
    HOST: "0.0.0.0",
    APP_ORIGIN: "https://public.example.test",
    GOOGLE_CLIENT_ID: "configured",
    HOUSEHOLD_EMAILS: "family@example.test",
  });
  expect(configured.production).toBe(true);
});
