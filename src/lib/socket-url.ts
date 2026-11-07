/** The WebSocket address for a computer attachment path the server issued, refusing any other origin or route. */
export function computerSocketUrl(path: string) {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/computer/")) {
    throw new Error("The computer returned an invalid connection address.");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
