// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { followKeyboard } from "../src/app/keyboard-viewport";

/** A visual viewport at the browser's edge: the sizes a phone reports, and the events it fires. */
class FakeViewport extends EventTarget {
  height = 800;
  scale = 1;
  pageTop = 0;
  set(next: Partial<Pick<FakeViewport, "height" | "scale" | "pageTop">>, event: "resize" | "scroll" = "resize") {
    Object.assign(this, next);
    this.dispatchEvent(new Event(event));
  }
}
const root = document.documentElement;
const shell = () => ({
  height: root.style.getPropertyValue("--keyboard-height"),
  top: root.style.getPropertyValue("--keyboard-top"),
  open: root.hasAttribute("data-keyboard-open"),
});
const full = { height: "", top: "", open: false };
let stop = () => {};
/**
 * The page as a phone reports it. `layout` is the root element's `clientHeight`, the layout viewport.
 * `innerHeight` is there because Safari changes it while the keyboard is up, and nothing may read it.
 */
const page = { layout: 800, innerHeight: 800 };
Object.defineProperty(root, "clientHeight", { configurable: true, get: () => page.layout });
const follow = (viewport: FakeViewport | null, layout = 800) => {
  Object.assign(page, { layout, innerHeight: layout });
  const host = { get innerHeight() { return page.innerHeight; }, visualViewport: viewport, document };
  stop = followKeyboard(host);
  return page;
};
afterEach(() => { stop(); stop = () => {}; });

describe("following an on-screen keyboard", () => {
  it("fits the shell to what is visible while an iOS keyboard is up, and gives the space back when it closes", () => {
    const viewport = new FakeViewport();
    follow(viewport);
    expect(shell()).toEqual(full);
    // Safari shrinks only the visual viewport and pans it down to the field.
    viewport.set({ height: 460, pageTop: 120 });
    expect(shell()).toEqual({ height: "460px", top: "120px", open: true });
    viewport.set({ pageTop: 60 }, "scroll");
    expect(shell().top).toBe("60px");
    viewport.set({ height: 800, pageTop: 0 });
    expect(shell()).toEqual(full);
  });

  // Measured in Safari on iOS 27.0: once it has panned the page to the field, `innerHeight` reads the
  // root's height less the scroll, 699 - 330 = 369, the same as the visual viewport. The root's own
  // height stays 699, so that is what the visual viewport is compared with.
  it("keeps the shell fitted after Safari pans the page and innerHeight drops to the visible height", () => {
    const viewport = new FakeViewport();
    const host = follow(viewport, 699);
    viewport.set({ height: 369, pageTop: 0 });
    expect(shell()).toEqual({ height: "369px", top: "0px", open: true });
    host.innerHeight = 369;
    viewport.set({ pageTop: 330 }, "scroll");
    expect(shell()).toEqual({ height: "369px", top: "330px", open: true });
    host.innerHeight = 699;
    viewport.set({ height: 699, pageTop: 0 });
    expect(shell()).toEqual(full);
  });

  it("does nothing where the keyboard already shrinks the layout viewport, as the meta asks of Android", () => {
    const viewport = new FakeViewport();
    const host = follow(viewport);
    host.layout = 470;
    viewport.set({ height: 470 });
    expect(shell()).toEqual(full);
    // A fraction of a pixel between the two is layout rounding, not a keyboard.
    viewport.set({ height: 469.4 });
    expect(shell()).toEqual(full);
  });

  it("leaves the shell alone through a pinch zoom past normal scale", () => {
    const viewport = new FakeViewport();
    follow(viewport);
    viewport.set({ scale: 2, height: 400, pageTop: 200 });
    expect(shell()).toEqual(full);
    viewport.set({ scale: 2, pageTop: 350 }, "scroll");
    expect(shell()).toEqual(full);
  });

  it("holds the keyboard's frame through a zoom and settles once the zoom ends", () => {
    const viewport = new FakeViewport();
    follow(viewport);
    viewport.set({ height: 460, pageTop: 0 });
    viewport.set({ scale: 1.5, height: 306 });
    expect(shell()).toEqual({ height: "460px", top: "0px", open: true });
    // The keyboard closed while zoomed; back at normal scale the full height returns.
    viewport.set({ scale: 1, height: 800 });
    expect(shell()).toEqual(full);
  });

  it("stops listening and restores the full height when stopped", () => {
    const viewport = new FakeViewport();
    follow(viewport);
    viewport.set({ height: 460 });
    stop();
    expect(shell()).toEqual(full);
    viewport.set({ height: 300 });
    expect(shell()).toEqual(full);
  });

  it("leaves the CSS height alone in a browser without a visual viewport", () => {
    follow(null);
    expect(shell()).toEqual(full);
  });
});
