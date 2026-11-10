/**
 * Keeps the app the size of what a person can see while an on-screen keyboard is up, so the
 * composer sits directly above the keyboard.
 *
 * The viewport meta asks for `interactive-widget=resizes-content`. Chrome and Firefox on Android
 * honor it: the keyboard shrinks the layout viewport, `100dvh` shrinks with it, and the visual
 * viewport stays the same height as the layout viewport, so this does nothing there. Safari on
 * iOS through 27.2 and an installed web app on iOS ignore it: the keyboard shrinks only the visual
 * viewport, and Safari pans it to the field. There the shell is sized to the visual viewport and
 * moved down to where it was panned. The check is the visual viewport against the layout viewport,
 * not a guess at the browser, so a browser that starts honoring the meta needs no change here.
 *
 * A pinch zoom shrinks the visual viewport too. While the page is zoomed nothing changes, so a
 * zoom never resizes the shell; the next event at normal scale sets it right.
 */
export type ViewportLike = Pick<VisualViewport, "height" | "scale" | "pageTop" | "addEventListener" | "removeEventListener">;
type Host = { innerHeight: number; visualViewport?: ViewportLike | null; document: Pick<Document, "documentElement"> };

/** Subpixel layout leaves the two viewports a fraction apart with no keyboard at all. */
const SLACK = 1;
/** A scale this close to 1 is the normal, unzoomed page. */
const UNZOOMED = 0.01;

/** The visible frame the shell should fill, null for the layout viewport, undefined to leave it as it is. */
export function keyboardFrame(layoutHeight: number, viewport: Pick<ViewportLike, "height" | "scale" | "pageTop">) {
  if (Math.abs(viewport.scale - 1) > UNZOOMED) return undefined;
  if (layoutHeight - viewport.height <= SLACK) return null;
  return { height: viewport.height, top: Math.max(0, viewport.pageTop) };
}

/** Follows the visual viewport until the returned function is called. Without one it does nothing. */
export function followKeyboard(host: Host = window) {
  const viewport = host.visualViewport;
  if (!viewport) return () => {};
  const root = host.document.documentElement;
  const clear = () => {
    root.style.removeProperty("--keyboard-height");
    root.style.removeProperty("--keyboard-top");
    delete root.dataset.keyboardOpen;
  };
  const update = () => {
    const frame = keyboardFrame(host.innerHeight, viewport);
    if (frame === undefined) return;
    if (!frame) return clear();
    root.style.setProperty("--keyboard-height", `${frame.height}px`);
    root.style.setProperty("--keyboard-top", `${frame.top}px`);
    root.dataset.keyboardOpen = "";
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    clear();
  };
}
