import type { ITerminalOptions } from "@xterm/xterm";
import type { DesktopKey } from "./desktop-keys";

/**
 * The system terminal's xterm setup and input encoding, shared by the web panel and the iOS
 * terminal page so both look and type the same. Type-only xterm imports keep the emulator itself
 * out of every page's first load.
 */
export const terminalOptions: ITerminalOptions = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 14, cursorBlink: true, screenReaderMode: true,
  scrollback: 3000, theme: { background: "#151c18", foreground: "#f1efdf", cursor: "#8bd2b2", selectionBackground: "#3a5947" },
};

/** The largest input message the server accepts, in UTF-8 bytes. */
export const inputLimit = 16384;

/**
 * Splits terminal input into wire messages of at most `limit` UTF-8 bytes. xterm emits a whole paste
 * at once; a split never cuts a code point in half, which the server would read as two broken ones.
 */
export function chunkInput(data: string, limit = inputLimit): string[] {
  const chunks: string[] = [];
  let chunk = "", bytes = 0;
  for (const character of data) {
    const point = character.codePointAt(0)!;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + size > limit) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += character; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/**
 * What xterm sends for each key the iOS keyboard's accessory row offers. The names are the iOS
 * app's `DesktopTyping.Key` values. Arrows, Home and End change form when the running program
 * asks for application cursor keys, as full-screen programs such as vim and less do.
 */
const keys: Record<DesktopKey, string | readonly [normal: string, application: string]> = {
  enter: "\r", tab: "\t", backspace: "\x7f", escape: "\x1b", delete: "\x1b[3~",
  left: ["\x1b[D", "\x1bOD"], up: ["\x1b[A", "\x1bOA"], right: ["\x1b[C", "\x1bOC"], down: ["\x1b[B", "\x1bOB"],
  home: ["\x1b[H", "\x1bOH"], end: ["\x1b[F", "\x1bOF"], pageUp: "\x1b[5~", pageDown: "\x1b[6~",
};
export function keySequence(key: DesktopKey, applicationCursor: boolean) {
  const sequence = keys[key];
  return typeof sequence === "string" ? sequence : sequence[applicationCursor ? 1 : 0];
}

/** Control plus one letter or one of @[\]^_ and space, as a terminal sends it (Control-C is \x03), or undefined. */
export function controlCharacter(text: string) {
  if (!/^[A-Za-z@[\\\]^_ ]$/.test(text)) return undefined;
  return String.fromCharCode(text.toUpperCase().charCodeAt(0) & 0x1f);
}
