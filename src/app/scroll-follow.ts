/**
 * How the transcript moves as it grows. Following pins the end in view. After a send, the person's
 * message is anchored near the top while the reply grows below it. Free holds the reader's place.
 */
export type ScrollMode = "follow" | "anchored" | "free";
/** Subpixel layout leaves a rounding error, so this close counts as the true end. */
export const END_SLACK = 2;
/** Space kept above a message anchored after a send. */
export const ANCHOR_GAP = 24;
export type Geometry = { scrollTop: number; scrollHeight: number; clientHeight: number };
export const distanceToEnd = ({ scrollTop, scrollHeight, clientHeight }: Geometry) =>
  scrollHeight - scrollTop - clientHeight;
export const atTrueEnd = (geometry: Geometry) => distanceToEnd(geometry) <= END_SLACK;

/** What a reader's input asks of the transcript. Scroll events alone cannot tell the reader from the app. */
export type Intent = "up" | "down" | "drag";
type InputEvent = {
  type: string;
  deltaY?: number;
  key?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
};
export function scrollIntent(event: InputEvent): Intent | undefined {
  if (event.type === "wheel")
    return (event.deltaY ?? 0) < 0 ? "up" : (event.deltaY ?? 0) > 0 ? "down" : undefined;
  if (event.type === "touchmove") return "drag";
  if (event.type === "keydown") {
    if (event.altKey || event.ctrlKey || event.metaKey) return undefined;
    if (
      ["ArrowUp", "PageUp", "Home"].includes(event.key ?? "") ||
      (event.key === " " && event.shiftKey)
    )
      return "up";
    if (["ArrowDown", "PageDown", "End", " "].includes(event.key ?? "")) return "down";
  }
  return undefined;
}
/**
 * Whether a key pressed inside `transcript` scrolls it, so it counts as the reader scrolling. Read once
 * every handler has had the key. It does not scroll the transcript when a handler took it, as a menu or
 * listbox does; when the focused field uses it; when Space presses the focused button or opens a summary;
 * or when a box between the focus and the transcript keeps it. See `keptBy`.
 */
export function keyScrollsTranscript(event: KeyboardEvent, transcript: Element, intent: Intent) {
  const target = event.target instanceof Element ? event.target : null;
  if (event.defaultPrevented || !target) return false;
  if (
    (target instanceof HTMLElement && target.isContentEditable) ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  )
    return false;
  if (event.key === " " && /^(BUTTON|SUMMARY)$/.test(target.tagName)) return false;
  for (let box: Element | null = target; box && box !== transcript; box = box.parentElement)
    if (keptBy(box, intent)) return false;
  return true;
}
/**
 * Whether a scroll key stops at `box` on its way from the focus to the transcript. A fixed box, such as a
 * modal dialog, scrolls with the viewport. A scrolling box keeps the key while it can still move that way.
 * At its end it passes the key on, unless it sets `overscroll-behavior`, which Chromium honors. WebKit
 * passes the key on anyway, and the scroll that makes is heard as a scroll: see measurePosition.
 */
function keptBy(box: Element, intent: Intent) {
  const style = getComputedStyle(box);
  if (style.position === "fixed") return true;
  if (!/auto|scroll/.test(style.overflowY)) return false;
  const room =
    intent === "up" ? box.scrollTop : box.scrollHeight - box.clientHeight - box.scrollTop;
  // Safari before 16 has no `overscroll-behavior` and reads it as empty.
  return room >= 1 || (style.overscrollBehaviorY || "auto") !== "auto";
}
/** Any intent ends an anchor; following ends only when the reader heads away from the end. */
export function afterIntent(mode: ScrollMode, intent: Intent): ScrollMode {
  if (mode === "anchored") return "free";
  if (mode === "follow" && intent !== "down") return "free";
  return mode;
}
/**
 * The empty space the end of the transcript needs so `offset`, a message's distance from the top of
 * the scrolled content, can sit `gap` below the top of the view. The space shrinks as a reply grows
 * into it, and never moves anything above it.
 */
export function endReserve({
  offset,
  scrollHeight,
  clientHeight,
  reserve,
  gap = ANCHOR_GAP,
}: {
  offset: number;
  scrollHeight: number;
  clientHeight: number;
  reserve: number;
  gap?: number;
}) {
  const reach = scrollHeight - reserve - clientHeight;
  return Math.max(0, Math.ceil(offset - gap - reach));
}
