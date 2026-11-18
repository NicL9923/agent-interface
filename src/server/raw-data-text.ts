import type { RawData } from "ws";

/** A WebSocket message as UTF-8 text, whichever shape the socket's binary type delivers. */
export function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
