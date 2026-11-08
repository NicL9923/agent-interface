import { deviceIdPattern } from "../shared/device-activity";

const key = "wildbots.device-id";
let memory: string | undefined;
/** A version 4 UUID. Plain-HTTP previews lack randomUUID, but have getRandomValues. */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/**
 * This browser profile's installation ID, shared by its tabs and kept across sign-ins, so the server
 * can tell which of a person's devices they are using (docs/native-api.md, Device activity). Storage
 * that is blocked or holds something else gets a fresh one; blocked storage keeps it for this page only.
 */
export function deviceId(): string {
  try {
    const stored = localStorage.getItem(key);
    if (stored && deviceIdPattern.test(stored)) return stored.toLowerCase();
    const value = uuid();
    localStorage.setItem(key, value);
    return value;
  } catch {
    return memory ??= uuid();
  }
}
