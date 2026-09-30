import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import type { Config } from "./config.js";

export interface NativeDevice { deviceId: string; token: string; environment: "sandbox" | "production" }
export type ApnsSender = (device: NativeDevice, payload: string) => Promise<unknown>;
export type ApnsTransport = (origin: string, headers: Record<string, string>, body: string) => Promise<{ statusCode: number; reason?: string }>;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fit = (value: string, limit: number) => {
  let result = "", bytes = 0;
  for (const character of value) {
    // Count JSON escapes as transmitted, including control characters and backslashes.
    bytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > limit) break;
    result += character;
  }
  return result;
};

export function apnsPayload(payload: string) {
  const value = JSON.parse(payload) as { title: string; body: string; url: string; tag: string };
  // Keep standard APNs payload under 4KB even when Hermes reports a long completion.
  // Never truncate a deep link into a different bot ID. Oversized runtime links are omitted.
  const url = Buffer.byteLength(JSON.stringify(value.url)) <= 2402 ? value.url : undefined;
  return JSON.stringify({ aps: { alert: { title: fit(value.title, 160), body: fit(value.body, 1000) }, sound: "default" }, url, tag: fit(value.tag, 160) });
}

export function createApnsSender(config: Config["apns"], transport?: ApnsTransport): (ApnsSender & { close(): void }) | undefined {
  if (!config) return undefined;
  const key = createPrivateKey(readFileSync(config.privateKeyFile));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("APNs signing key must be a P-256 EC private key");
  let cachedToken = "", issuedAt = 0, session: ClientHttp2Session | undefined;
  const origin = config.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const providerToken = () => {
    const now = Math.floor(Date.now() / 1000);
    if (!cachedToken || now - issuedAt >= 3000 || now < issuedAt) {
      const input = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({ iss: config.teamId, iat: now })}`;
      cachedToken = `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
      issuedAt = now;
    }
    return cachedToken;
  };
  const sendRequest: ApnsTransport = transport ?? (async (url, headers, body) => {
    if (!session || session.closed || session.destroyed) {
      const created = connect(url, { minVersion: "TLSv1.2" });
      created.on("error", () => { created.destroy(); });
      session = created;
    }
    const current = session;
    return new Promise((resolve, reject) => {
      const request = current.request(headers);
      let statusCode = 0, responseBody = "";
      const timeout = setTimeout(() => { request.close(); current.destroy(); reject(new Error("APNs delivery timed out")); }, 15000);
      request.on("response", response => { statusCode = Number(response[":status"]); });
      request.setEncoding("utf8");
      request.on("data", chunk => { if (responseBody.length < 8192) responseBody += chunk; });
      request.on("error", error => { clearTimeout(timeout); reject(error); });
      request.on("end", () => {
        clearTimeout(timeout);
        let reason: string | undefined;
        try { reason = (JSON.parse(responseBody) as { reason?: string }).reason; } catch { /* Empty successful response. */ }
        resolve({ statusCode, reason });
      });
      request.end(body);
    });
  });
  const send: ApnsSender = async (device, payload) => {
    if (device.environment !== config.environment) throw new Error("APNs device environment does not match this host");
    const result = await sendRequest(origin, { ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${providerToken()}`, "apns-topic": config.topic,
      "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400), "content-type": "application/json" }, apnsPayload(payload));
    if (result.statusCode !== 200) throw Object.assign(new Error(`APNs rejected notification (${result.statusCode})`), { statusCode: result.statusCode, reason: result.reason });
  };
  return Object.assign(send, { close() { session?.destroy(); } });
}
