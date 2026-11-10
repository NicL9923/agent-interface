/** An image's natural size in pixels. */
export type ImageSize = { width: number; height: number };
/**
 * The natural sizes of images this page has shown, by file ID, so a transcript image can reserve its space before it
 * loads. Hermes reports no image sizes. The composer records each attachment's size from its preview, so the person's
 * own images know theirs from the moment they are sent; any other image learns its size the first time it loads here.
 * A file ID names a path, so new bytes written to the same path keep the ID; the size learned on their load replaces
 * the old one.
 */
const sizes = new Map<string, ImageSize>();
/** A long session's images stay well inside this; past it the least recently learned sizes go first. */
export const MAX_REMEMBERED = 500;
export const imageSize = (id: string): ImageSize | undefined => sizes.get(id);
/** Keeps a loaded image's natural size. An image without one, such as a broken file, is not kept. */
export function rememberImageSize(id: string, image: Pick<HTMLImageElement, "naturalWidth" | "naturalHeight">) {
  if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) return;
  sizes.delete(id);
  sizes.set(id, { width: image.naturalWidth, height: image.naturalHeight });
  if (sizes.size > MAX_REMEMBERED) sizes.delete(sizes.keys().next().value!);
}
/** The frame an image of unknown size gets, as `.file-frame` in styles.css draws it. */
const FRAME_RATIO = 4 / 3;
/**
 * A loaded image whose shape is within this factor of its frame's keeps the frame: the bars beside or above it are
 * at most about 5% of the frame on each side, and reshaping would move every row below it. Farther off, the image
 * takes its own shape once, within the same caps.
 */
const RESHAPE_FACTOR = 1.1;
/** Whether a loaded image should take its own shape instead of the frame it was given (`undefined`: the 4:3 one). */
export function reshapes(frame: ImageSize | undefined, loaded: ImageSize) {
  if (!(loaded.width > 0 && loaded.height > 0)) return false;
  const ratio = (loaded.width / loaded.height) / (frame ? frame.width / frame.height : FRAME_RATIO);
  return Math.max(ratio, 1 / ratio) > RESHAPE_FACTOR;
}

/** The nearest ancestor that scrolls vertically, such as the transcript. */
export function scrollerOf(element: Element): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}
/** The transcript row an image sits in, which keeping the reader's place moves as one; the frame itself outside one. */
export const rowOf = (frame: Element) => frame.closest("[data-message-id]") ?? frame;
/**
 * Whether reshaping this frame now would move what the reader sees. Keeping the reader's place holds the row at the
 * view's top edge, so a reshape in that row or any row in view moves the rows after it; in a row wholly above or
 * below the view it moves nothing seen. A chat pinned to its end keeps the latest message still, so it reshapes at once.
 */
export function readerSees(frame: Element) {
  const scroller = scrollerOf(frame);
  if (!scroller) return false;
  const view = scroller.getBoundingClientRect(), box = rowOf(frame).getBoundingClientRect();
  const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
  return !atEnd && box.bottom > view.top && box.top < view.bottom;
}
/**
 * Whether the frame's row is in view at both ends the scroller can reach, so no scroll ever takes it out of view, as
 * in a short thread. A reshape waiting for the row to leave would then never be applied.
 */
export function neverLeaves(frame: Element) {
  const scroller = scrollerOf(frame);
  if (!scroller) return false;
  const view = scroller.getBoundingClientRect(), box = rowOf(frame).getBoundingClientRect();
  // The row's place in the scroller's content, against the view at the top and at the end.
  const top = box.top - view.top + scroller.scrollTop, bottom = box.bottom - view.top + scroller.scrollTop;
  return top < scroller.clientHeight && bottom > scroller.scrollHeight - scroller.clientHeight;
}
