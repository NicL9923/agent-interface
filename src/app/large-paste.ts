/** Pasted text at least this many UTF-8 bytes becomes an attachment instead of composer text. */
export const LARGE_PASTE_BYTES = 32 * 1024;

const encoder = new TextEncoder();

/** A text file for a large paste, or null when the paste should insert normally. */
export function largePasteFile(text: string): File | null {
  const bytes = encoder.encode(text);
  if (bytes.byteLength < LARGE_PASTE_BYTES) return null;
  return new File([bytes], "Pasted text.txt", { type: "text/plain" });
}
