/** Explicit opt-in format. Ordinary HTML code examples remain code. */
export interface InlineDocument { version: 1; title: string; html: string }
export const MAX_INLINE_UI = 100_000;
export function parseInlineDocument(code: string): InlineDocument | null {
  if (code.length > MAX_INLINE_UI) return null;
  try {
    const value = JSON.parse(code);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["version", "title", "html"].includes(key)) || value.version !== 1 ||
      typeof value.title !== "string" || !value.title.trim() || value.title.length > 200 ||
      typeof value.html !== "string" || !value.html.trim()) return null;
    return { version: 1, title: value.title.trim(), html: value.html };
  } catch { return null; }
}

export { default as inlineUiInstructions } from "./inline-ui-instructions.json" with { type: "json" };

/** No network or application authority. The iframe also omits allow-same-origin. */
export const inlineUiPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; frame-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
