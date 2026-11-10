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
 * The layout viewport's height is the root element's `clientHeight`, not `innerHeight`. Safari on
 * iOS 27.0 was measured reporting `innerHeight` as that height less the page's scroll once it has
 * panned to the field, 699 - 330 = 369, which equals the visual viewport and would read as no
 * keyboard. The root's `clientHeight` stayed 699 throughout.
 *
 * WebKit implements the meta from the iOS 27.3 beta (bug 259770), where it is reported to leave the
 * field behind the keyboard still; how this code and that beta interact is unverified.
 *
 * The top is the larger of the visual viewport's `pageTop` and the window's `scrollY`. On iOS 27.0, on 4 of 5
 * keyboard opens measured, Safari fired the window's scroll with `scrollY` 330 while `pageTop` still read 0, and the
 * visual viewport's own scroll 390 to 420ms later; until then the screen showed only the composer. At rest the two
 * agree. `scrollY + offsetTop` is not the answer there: Safari reports `offsetTop` equal to `pageTop` at rest.
 *
 * A pinch zoom shrinks the visual viewport too. While the page is zoomed nothing changes, so a
 * zoom does not resize the shell; the next event at normal scale sets it right. A scale within
 * UNZOOMED of 1 counts as normal, so a zoom that slight is treated as a keyboard would be.
 */
export type ViewportLike = Pick<VisualViewport, "height" | "scale" | "pageTop" | "addEventListener" | "removeEventListener">;
type Host = Pick<Window, "scrollY" | "addEventListener" | "removeEventListener"> & {
  visualViewport?: ViewportLike | null;
  document: Pick<Document, "documentElement">;
};

/** Subpixel layout leaves the two viewports a fraction apart with no keyboard at all. */
const SLACK = 1;
/** A scale this close to 1 is the normal, unzoomed page. */
const UNZOOMED = 0.01;
/**
 * The shortest visible frame the shell is fitted to. It is `.composer-area`'s floor in `src/styles.css` with the
 * draft stacked above the buttons and the keyboard up: `--composer-floor` 98px, 6px above and 8px below. A shorter
 * frame would cut Send off, and Safari has reported -44px, 2px and 34px in landscape on an iPhone 17e. There the
 * shell keeps the layout viewport's height and Safari pans to the field, so a person still sees what they type.
 */
const LEAST_FRAME = 112;

/** The visible frame the shell should fill, null for the layout viewport, undefined to leave it as it is. */
export function keyboardFrame(layoutHeight: number, viewport: Pick<ViewportLike, "height" | "scale" | "pageTop">, scrollY = 0) {
  if (Math.abs(viewport.scale - 1) > UNZOOMED) return undefined;
  if (layoutHeight - viewport.height <= SLACK || viewport.height < LEAST_FRAME) return null;
  const top = Math.max(viewport.pageTop, scrollY);
  // Safari can pan the visual viewport past the page's end; a shell placed there would make the page taller.
  return { height: viewport.height, top: Math.max(0, Math.min(top, layoutHeight - viewport.height)) };
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
    const frame = keyboardFrame(root.clientHeight, viewport, host.scrollY);
    if (frame === undefined) return;
    if (!frame) return clear();
    root.style.setProperty("--keyboard-height", `${frame.height}px`);
    root.style.setProperty("--keyboard-top", `${frame.top}px`);
    root.dataset.keyboardOpen = "";
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  host.addEventListener("scroll", update, { passive: true });
  update();
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    host.removeEventListener("scroll", update);
    clear();
  };
}
