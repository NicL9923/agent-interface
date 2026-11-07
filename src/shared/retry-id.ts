/**
 * The request ID for retrying one failed turn, the same on every device, tab and reload: a
 * version 8 UUID from SHA-256 over `wildbots-retry`, the assistant's ID, the retried message's
 * ID and the failed run's ID (empty without one), separated by NUL characters. The first 16
 * bytes of the digest get version 8 in the high nibble of byte 6 and the RFC 9562 variant in
 * the top two bits of byte 8. iOS computes the same; docs/native-api.md has a test vector.
 */
export function retryRequestId(botId: string, messageId: string, runId = ""): Promise<string> {
  return derivedId(["wildbots-retry", botId, messageId, runId], 0x80);
}
/**
 * The request ID for one person's answers to one form card, the same in every tab and on every
 * device, so the server's submission record admits them once. Built like a retry ID over
 * `wildbots-form`, the person's, assistant's, message's and card's IDs and the attempt number,
 * but with version 4, so it can never take a retry's version 8 ID. The attempt grows only after
 * Hermes refuses an attempt, whose ID then stays refused.
 */
export function formRequestId(userId: string, botId: string, messageId: string, cardId: string, attempt: number): Promise<string> {
  return derivedId(["wildbots-form", userId, botId, messageId, cardId, String(attempt)], 0x40);
}
async function derivedId(parts: string[], version: number): Promise<string> {
  const input = new TextEncoder().encode(parts.join("\u0000"));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | version;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/**
 * Whether a request ID has a retry ID's shape, version 8. Other requests use random version 4
 * IDs, so an ordinary message can never take, and so block, a failed turn's retry ID.
 */
export const isRetryRequestId = (requestId: string) => requestId[14] === "8";
