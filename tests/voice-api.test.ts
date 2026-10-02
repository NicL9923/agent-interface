import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { installAuth, hash } from "../src/server/auth.js";
import { Store } from "../src/server/store.js";
import { loadConfig } from "../src/server/config.js";
import { registerVoiceRoutes } from "../src/server/voice.js";
import { MAX_VOICE_BYTES } from "../src/shared/voice.js";
import type { Runtime } from "../src/shared/types.js";

const origin = "https://voice.example.invalid";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup() {
  let clock = Date.now();
  const app = Fastify({ logger: false }); apps.push(app);
  const store = new Store(":memory:");
  const config = loadConfig({ NODE_ENV: "production", APP_ORIGIN: origin, APP_DATABASE: ":memory:", GOOGLE_CLIENT_ID: "fixture", HOUSEHOLD_EMAILS: "first@example.invalid,second@example.invalid" });
  await app.register(cookie); await app.register(multipart);
  await installAuth(app, store, config);
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 502).send({ error: (error as Error).message }));
  const transcribeVoice = vi.fn(async () => ({ text: " Pick up milk ", provider: "fixture" }));
  const synthesizeVoice = vi.fn(async () => ({ data: Buffer.from("fixture audio"), mime: "audio/mpeg" }));
  const conversation = vi.fn(async () => ({ messages: [{ id: "reply", role: "assistant", text: "The list is ready." }, { id: "user", role: "user", text: "secret user text" }, { id: "ranch-inflight", role: "assistant", text: "Unfinished thought" }] }));
  const listBots = vi.fn(async () => [{ id: "ranch" }]);
  const runtime = { transcribeVoice, synthesizeVoice, conversation, listBots } as unknown as Runtime;
  await registerVoiceRoutes(app, runtime, { now: () => clock });
  const login = (id: string) => {
    store.user({ id, name: id, email: `${id}@example.invalid` });
    const token = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
    store.session(hash(token), id, csrf, clock + 600000);
    return { origin, cookie: `session=${token}`, "x-csrf-token": csrf };
  };
  app.addHook("onClose", async () => store.close());
  return { app, store, runtime, transcribeVoice, synthesizeVoice, conversation, listBots, first: login("first"), second: login("second"), advance: (ms: number) => { clock += ms; } };
}
function recording(mime = "audio/webm", data = Buffer.from("fixture recording")) {
  const boundary = "voice-fixture";
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="../../ignored-name.webm"\r\nContent-Type: ${mime}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]) };
}
it("authenticates and CSRF-protects recordings before contacting a provider", async () => {
  const s = await setup(), upload = recording();
  for (const [headers, status] of [[{}, 401], [{ cookie: s.first.cookie, origin }, 403], [{ ...s.first, origin: "https://other.invalid" }, 403]] as const) {
    expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/transcribe", payload: upload.payload, headers: { ...upload.headers, ...headers } })).statusCode).toBe(status);
  }
  expect(s.transcribeVoice).not.toHaveBeenCalled();
  const response = await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/transcribe", payload: upload.payload, headers: { ...upload.headers, ...s.first } });
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ text: "Pick up milk", provider: "fixture" });
  expect(s.transcribeVoice).toHaveBeenCalledWith("ranch", { mime: "audio/webm", data: Buffer.from("fixture recording") });
  expect(response.headers["cache-control"]).toBe("private, no-store");
});
it("rejects missing assistants, unsupported, empty, oversized and malformed recordings", async () => {
  const s = await setup();
  for (const [mime, bytes, expected] of [["text/html", Buffer.from("html"), 415], ["audio/mp4", Buffer.alloc(0), 400], ["audio/mp4", Buffer.alloc(MAX_VOICE_BYTES + 1), 413]] as const) {
    const upload = recording(mime, bytes);
    expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/transcribe", headers: { ...upload.headers, ...s.first }, payload: upload.payload })).statusCode).toBe(expected);
  }
  const upload = recording();
  expect((await s.app.inject({ method: "POST", url: "/api/bots/missing/voice/transcribe", headers: { ...upload.headers, ...s.first }, payload: upload.payload })).statusCode).toBe(404);
  expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/transcribe", headers: s.first, payload: {} })).statusCode).toBe(406);
  const extra = Buffer.concat([upload.payload.subarray(0, upload.payload.length - Buffer.byteLength("--voice-fixture--\r\n")), Buffer.from('--voice-fixture\r\nContent-Disposition: form-data; name="extra"\r\n\r\nextra field\r\n--voice-fixture--\r\n')]);
  expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/transcribe", headers: { ...upload.headers, ...s.first }, payload: extra })).statusCode).toBe(413);
  expect(s.transcribeVoice).not.toHaveBeenCalled();
});
it("reads only stored assistant replies and delivers speech once to its requesting identity", async () => {
  const s = await setup();
  for (const payload of [{ messageId: "user" }, { messageId: "missing" }, { messageId: "reply", text: "client-controlled" }])
    expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/speak", headers: s.first, payload })).statusCode).toBe(payload.messageId === "reply" ? 400 : 404);
  expect(s.synthesizeVoice).not.toHaveBeenCalled();
  expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/speak", headers: s.first, payload: { messageId: "ranch-inflight" } })).statusCode).toBe(409);
  const response = await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/speak", headers: s.first, payload: { messageId: "reply" } });
  const url = response.json().url;
  expect(response.statusCode).toBe(200); expect(s.synthesizeVoice).toHaveBeenCalledWith("ranch", "The list is ready.");
  expect((await s.app.inject({ url })).statusCode).toBe(401);
  expect((await s.app.inject({ url, headers: s.second })).statusCode).toBe(404);
  const audio = await s.app.inject({ url, headers: s.first });
  expect(audio.body).toBe("fixture audio"); expect(audio.headers["content-type"]).toBe("audio/mpeg"); expect(audio.headers["cache-control"]).toBe("private, no-store");
  expect((await s.app.inject({ url, headers: s.first })).statusCode).toBe(404);
  const concurrentUrl = (await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/speak", headers: s.first, payload: { messageId: "reply" } })).json().url;
  const concurrent = await Promise.all([s.app.inject({ url: concurrentUrl, headers: s.first }), s.app.inject({ url: concurrentUrl, headers: s.first })]);
  expect(concurrent.map(response => response.statusCode).sort()).toEqual([200, 404]);
});
it("expires prepared audio, replaces old audio and rejects invalid provider output", async () => {
  const s = await setup(), speak = () => s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/speak", headers: s.first, payload: { messageId: "reply" } });
  const previous = (await speak()).json().url, next = (await speak()).json().url;
  expect((await s.app.inject({ url: previous, headers: s.first })).statusCode).toBe(404);
  s.advance(300001);
  expect((await s.app.inject({ url: next, headers: s.first })).statusCode).toBe(404);
  s.synthesizeVoice.mockResolvedValueOnce({ data: Buffer.from("html"), mime: "text/html" });
  expect((await speak()).statusCode).toBe(502);
});
it("limits concurrent voice provider calls for an identity and releases the slot after failure", async () => {
  const s = await setup(); let reject!: (error: Error) => void;
  s.synthesizeVoice.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  const first = s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/speak", headers: s.first, payload: { messageId: "reply" } });
  await vi.waitFor(() => expect(s.synthesizeVoice).toHaveBeenCalledOnce());
  expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/speak", headers: s.first, payload: { messageId: "reply" } })).statusCode).toBe(429);
  reject(new Error("provider fixture failure")); expect((await first).statusCode).toBe(502);
  expect((await s.app.inject({ method: "POST", url: "/api/bots/ranch/voice/speak", headers: s.first, payload: { messageId: "reply" } })).statusCode).toBe(200);
});
