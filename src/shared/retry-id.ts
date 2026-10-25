/**
 * The request ID for retrying one failed turn, the same on every device, tab and reload: a
 * version 8 UUID from SHA-256 over `wildbots-retry`, the assistant's ID, the retried message's
 * ID and the failed run's ID (empty without one), separated by NUL characters. The first 16
 * bytes of the digest get version 8 in the high nibble of byte 6 and the RFC 9562 variant in
 * the top two bits of byte 8. iOS computes the same; docs/native-api.md has a test vector.
 */
export async function retryRequestId(botId: string, messageId: string, runId = ""): Promise<string> {
  const input = new TextEncoder().encode(["wildbots-retry", botId, messageId, runId].join("\u0000"));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
