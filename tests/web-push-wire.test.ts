import { createECDH, randomBytes } from "node:crypto";
import https from "node:https";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import * as webpush from "web-push";

afterEach(() => vi.restoreAllMocks());

it("sends an encrypted VAPID notification and preserves expiry responses", async () => {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const subscription = { endpoint: "https://push.example.test/message", keys: {
    p256dh: receiver.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"),
  } };
  const keys = webpush.generateVAPIDKeys();
  webpush.setVapidDetails("mailto:test@example.com", keys.publicKey, keys.privateKey);
  let sent = Buffer.alloc(0);
  let requestOptions: https.RequestOptions | undefined;
  vi.spyOn(https, "request").mockImplementation(((options: https.RequestOptions, callback: (response: EventEmitter & { statusCode: number; headers: object }) => void) => {
    requestOptions = options;
    const request = new EventEmitter() as EventEmitter & { write: (body: Buffer) => void; end: () => void };
    request.write = body => { sent = Buffer.from(body); };
    request.end = () => {
      const response = Object.assign(new EventEmitter(), { statusCode: 410, headers: {} });
      callback(response);
      response.emit("data", "expired");
      response.emit("end");
    };
    return request;
  }) as typeof https.request);
  await expect(webpush.sendNotification(subscription, "hello", { TTL: 86400, timeout: 15000 })).rejects.toMatchObject({ name: "WebPushError", statusCode: 410, body: "expired" });
  expect(requestOptions).toMatchObject({ hostname: "push.example.test", path: "/message", method: "POST", timeout: 15000, headers: { TTL: 86400, "Content-Encoding": "aes128gcm", Urgency: "normal" } });
  expect((requestOptions?.headers as Record<string, string>)?.Authorization).toMatch(/^vapid t=.+,\s*k=.+/);
  expect(sent.length).toBeGreaterThan(86);
  expect(sent.readUInt32BE(16)).toBe(4096);
  expect(sent[20]).toBe(65);
});
