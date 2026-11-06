/**
 * X11 keysyms for typing into the shared desktop, used by the web panel and the iOS viewer page.
 * noVNC's `sendKey(keysym)` presses and releases one key; the desktop's server applies Shift
 * for capitals and symbols itself.
 */
export const desktopKeys = {
  enter: 0xff0d, tab: 0xff09, backspace: 0xff08, escape: 0xff1b, delete: 0xffff,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
  home: 0xff50, end: 0xff57, pageUp: 0xff55, pageDown: 0xff56,
} as const;
export type DesktopKey = keyof typeof desktopKeys;
export const controlKey = 0xffe3;
/** The most characters one paste types into the desktop, as the Type text box allows. */
export const pasteLimit = 8192;
/** The text a paste types, cut at a whole character, and whether it was cut. */
export function limitPaste(text: string) {
  const characters = Array.from(text);
  return { text: characters.slice(0, pasteLimit).join(""), cut: characters.length > pasteLimit };
}

export function isDesktopKey(value: unknown): value is DesktopKey {
  return typeof value === "string" && Object.hasOwn(desktopKeys, value);
}

/** One keysym per character: line breaks press Enter, a tab presses Tab, Latin-1 is its own keysym. */
export function keysymsFor(text: string): number[] {
  const keys: number[] = [];
  for (const character of text.replace(/\r\n?/g, "\n")) {
    const point = character.codePointAt(0)!;
    keys.push(point === 10 ? desktopKeys.enter : point === 9 ? desktopKeys.tab : point <= 255 ? point : 0x01000000 | point);
  }
  return keys;
}
