import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import type { Config } from "./config.js";
import type { LiveActivitySender } from "./live-activity.js";

export interface NativeDevice { deviceId: string; token: string; environment: "sandbox" | "production" }
export type ApnsSender = (device: NativeDevice, payload: string) => Promise<unknown>;
/** Asks a device to remove these delivered notifications, named by tag, and to show this badge if known. */
export type ApnsClearSender = (device: NativeDevice, tags: string[], badge?: number) => Promise<unknown>;
export type ApnsTransport = (origin: string, headers: Record<string, string>, body: string) => Promise<{ statusCode: number; reason?: string }>;
/**
 * A push Apple refused, with Apple's status and reason for the workers to judge the token by.
 * The status is Apple's, not this app's: it is not `statusCode`, so one that reached a route
 * would answer as an unexplained 502 instead of passing Apple's status and text to the client.
 */
export class ApnsError extends Error {
  constructor(message: string, readonly apnsStatus: number, readonly reason?: string) {
    super(message);
    this.name = "ApnsError";
  }
}
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

/** Names the account a notification was sent to without revealing its ID to Apple. The app and server compare it. */
export const accountMarker = (userId: string) => createHash("sha256").update(`wildbots-account:${userId}`).digest("hex").slice(0, 16);
/** APNs replaces a delivered notification that has the same collapse ID. Apple allows 64 bytes; longer or unusual tags are hashed. */
export const apnsCollapseId = (tag: string) => /^[\x21-\x7e]{1,64}$/.test(tag) ? tag : createHash("sha256").update(tag).digest("base64url");
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
// Notification identities are short IDs; anything longer gets no grouping or actions instead of a truncated ID.
const short = (value: unknown): value is string => typeof value === "string" && !!value && Buffer.byteLength(JSON.stringify(value)) <= 202;

export function apnsPayload(payload: string) {
  const value = JSON.parse(payload) as { title: string; body: string; url: string; tag: string; kind?: string; botId?: string; approvalId?: string; account?: string; badge?: number };
  // Keep standard APNs payload under 4KB even when Hermes reports a long completion.
  // Never truncate a deep link into a different bot ID. Oversized runtime links are omitted.
  const url = Buffer.byteLength(JSON.stringify(value.url)) <= 2402 ? value.url : undefined;
  const alert = { title: fit(value.title, 160), body: fit(value.body, 1000) }, tag = fit(value.tag, 160);
  const botId = short(value.botId) ? value.botId : undefined, account = short(value.account) ? value.account : undefined;
  // Approval requests break through Focus; the app carries the Time Sensitive Notifications entitlement.
  const urgent = value.kind === "approval" ? { "interruption-level": "time-sensitive" } : {};
  // Actions the app registers: APPROVAL decides from the notification, REPLY starts a reviewed draft. Routine results,
  // digests and alerts without an assistant get none. Older app builds ignore categories they never registered.
  const routine = /[?&]routine=/.test(typeof value.url === "string" ? value.url : "");
  const actions = !botId || !account || routine ? undefined
    : value.kind === "approval" && short(value.approvalId) ? { category: "APPROVAL", fields: { botId, approvalId: value.approvalId, account } }
    : value.kind === "completed" ? { category: "REPLY", fields: { botId, account } } : undefined;
  // The app's notification service extension shows the assistant as the sender, with its avatar,
  // when it knows which assistant and account this is. It reads both from the App Group only.
  const sender = botId && account ? { botId, account } : undefined;
  const build = (thread: boolean, act: boolean) => JSON.stringify({
    aps: { alert, sound: "default", ...(count(value.badge) ? { badge: value.badge } : {}), ...(thread && botId ? { "thread-id": botId } : {}), ...(thread && sender ? { "mutable-content": 1 } : {}),
      ...urgent, ...(act && actions ? { category: actions.category } : {}) },
    url, tag, ...(thread && sender ? sender : {}), ...(act && actions ? actions.fields : {}) });
  // Grouping and actions are extras: drop them before the alert itself would exceed the limit.
  return [build(true, true), build(true, false)].find(body => Buffer.byteLength(body) <= 4000) ?? build(false, false);
}

/**
 * A background push the app handles silently; it carries no alert and never wakes the screen.
 * It names notifications, not chats, so a late clear never removes a newer unread one. Tags
 * that would push it past APNs' 4KB limit are left on the device until its chat opens there.
 * A background push's aps may hold only content-available, so the app reads the badge it
 * should show from `badge` beside it.
 */
export function apnsClearPayload(tags: string[], badge?: number) {
  const extra = count(badge) ? { badge } : {};
  const kept: string[] = [];
  for (const tag of tags) {
    if (Buffer.byteLength(JSON.stringify({ aps: { "content-available": 1 }, clear: { tags: [...kept, tag] }, ...extra })) > 4000) break;
    kept.push(tag);
  }
  return JSON.stringify({ aps: { "content-available": 1 }, clear: { tags: kept }, ...extra });
}
/** A silent alert push that only sets the app icon's badge, which iOS applies even while the app is closed. */
export const apnsBadgePayload = (badge: number) => JSON.stringify({ aps: { badge } });

export function createApnsSender(config: Config["apns"], transport?: ApnsTransport): (ApnsSender & { close(): void; liveActivity: LiveActivitySender; clear: ApnsClearSender }) | undefined {
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
      const timeout = setTimeout(() => { request.close(); reject(new Error("APNs delivery timed out")); }, 15000);
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
    // The collapse ID only replaces a resend of the same notification; clears still match the payload's tag.
    const tag = (JSON.parse(payload) as { tag?: unknown }).tag;
    const result = await sendRequest(origin, { ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${providerToken()}`, "apns-topic": config.topic,
      "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400), "content-type": "application/json",
      ...(typeof tag === "string" && tag ? { "apns-collapse-id": apnsCollapseId(tag) } : {}) }, apnsPayload(payload));
    if (result.statusCode !== 200) throw new ApnsError(`APNs rejected notification (${result.statusCode})`, result.statusCode, result.reason);
  };
  // Live Activities take their own topic suffix and push type; the payload is built by LiveActivities.
  const liveActivity: LiveActivitySender = async (target, payload, priority) => {
    if (target.environment !== config.environment) throw new Error("APNs device environment does not match this host");
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 4096) throw new ApnsError("Live Activity payload exceeds APNs' 4096-byte limit", 413, "PayloadTooLarge");
    const result = await sendRequest(origin, { ":method": "POST", ":path": `/3/device/${target.token}`, authorization: `bearer ${providerToken()}`,
      "apns-topic": `${config.topic}.push-type.liveactivity`, "apns-push-type": "liveactivity", "apns-priority": String(priority),
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 900), "content-type": "application/json" }, body);
    if (result.statusCode !== 200) throw new ApnsError(`APNs rejected Live Activity update (${result.statusCode})`, result.statusCode, result.reason);
  };
  // Background pushes must use priority 5; iOS budgets them, so the worker sends one per device per pass.
  const clear: ApnsClearSender = async (device, tags, badge) => {
    if (device.environment !== config.environment) throw new Error("APNs device environment does not match this host");
    const result = await sendRequest(origin, { ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${providerToken()}`, "apns-topic": config.topic,
      "apns-push-type": "background", "apns-priority": "5", "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400), "content-type": "application/json" }, apnsClearPayload(tags, badge));
    if (result.statusCode !== 200) throw new ApnsError(`APNs rejected notification clear (${result.statusCode})`, result.statusCode, result.reason);
    // iOS drops background pushes for an app the person closed, so the badge goes separately too.
    if (!count(badge)) return;
    const shown = await sendRequest(origin, { ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${providerToken()}`, "apns-topic": config.topic,
      "apns-push-type": "alert", "apns-priority": "5", "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400), "content-type": "application/json" }, apnsBadgePayload(badge));
    if (shown.statusCode !== 200) throw new ApnsError(`APNs rejected badge update (${shown.statusCode})`, shown.statusCode, shown.reason);
  };
  return Object.assign(send, { close() { session?.destroy(); }, liveActivity, clear });
}
