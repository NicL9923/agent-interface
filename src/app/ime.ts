/**
 * Whether a key press belongs to an input method, such as a Japanese, Chinese or Korean IME, and
 * not to the page. Safari ends the composition before the keydown of the Enter that confirms it, so
 * that keydown reports `isComposing` false. Its `keyCode` is still 229 (WebKit bug 165004), so both
 * are checked. Without the second check, confirming a word in Safari sends the message.
 */
export function imeKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">) {
  return event.isComposing || event.keyCode === 229;
}
