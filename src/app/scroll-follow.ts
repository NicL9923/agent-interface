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
export const distanceToEnd = ({ scrollTop, scrollHeight, clientHeight }: Geometry) => scrollHeight - scrollTop - clientHeight;
export const atTrueEnd = (geometry: Geometry) => distanceToEnd(geometry) <= END_SLACK;

/** What a reader's input asks of the transcript. Scroll events alone cannot tell the reader from the app. */
export type Intent = "up" | "down" | "drag";
type InputEvent = { type: string; deltaY?: number; key?: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
export function scrollIntent(event: InputEvent): Intent | undefined {
  if (event.type === "wheel") return (event.deltaY ?? 0) < 0 ? "up" : (event.deltaY ?? 0) > 0 ? "down" : undefined;
  if (event.type === "touchmove") return "drag";
  if (event.type === "keydown") {
    if (event.altKey || event.ctrlKey || event.metaKey) return undefined;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key ?? "") || event.key === " " && event.shiftKey) return "up";
    if (["ArrowDown", "PageDown", "End", " "].includes(event.key ?? "")) return "down";
  }
  return undefined;
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
export function endReserve({ offset, scrollHeight, clientHeight, reserve, gap = ANCHOR_GAP }: {
  offset: number; scrollHeight: number; clientHeight: number; reserve: number; gap?: number;
}) {
  const reach = scrollHeight - reserve - clientHeight;
  return Math.max(0, Math.ceil(offset - gap - reach));
}
