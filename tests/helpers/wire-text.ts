/** A request body a test sent as text. A body that is not text fails the test instead of becoming "[object Object]". */
export function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  throw new TypeError(`Expected a text request body, got ${body === null ? "null" : typeof body}`);
}

/** The URL a fetch call was given, whether it passed text, a URL or a Request. */
export function urlText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new TypeError(`Expected a fetch input, got ${typeof input}`);
}
