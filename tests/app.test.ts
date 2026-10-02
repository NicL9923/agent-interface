import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import type { Avatar, Capabilities, Runtime, Submission } from "../src/shared/types.js";
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
      data: Buffer.from("hello"),
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
