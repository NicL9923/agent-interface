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
 * `scrollY` is the window's scroll, which fires its own `scroll` event through `scroll()`.
 */
class FakeWindow extends EventTarget {
  layout = 800;
  innerHeight = 800;
  scrollY = 0;
  constructor(readonly visualViewport: FakeViewport | null) { super(); }
  readonly document = document;
  scroll(scrollY: number) {
    this.scrollY = scrollY;
    this.dispatchEvent(new Event("scroll"));
  }
}
let page = new FakeWindow(null);
Object.defineProperty(root, "clientHeight", { configurable: true, get: () => page.layout });
const follow = (viewport: FakeViewport | null, layout = 800) => {
  page = Object.assign(new FakeWindow(viewport), { layout, innerHeight: layout });
  stop = followKeyboard(page);
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

  // Measured in Safari on iOS 27.0 in landscape on an iPhone 17e: the visible frame was -44px with two tabs
  // open, 2px with one and 34px in another run. Fitting the shell to that cut Send off, and a negative height
  // made the CSS invalid and the shell thousands of pixels tall. The composer area needs 112px with a draft
  // stacked above its buttons; the iPhone 18 Pro Max's 116px landscape frame showed Send whole.
  it.each([
    ["a negative height", -44],
    ["no height at all", 0],
    ["one pixel short of the composer's floor", 111],
  ])("keeps the layout viewport's height when the visible frame is %s, so Safari pans to the field", (_, height) => {
    const viewport = new FakeViewport();
    follow(viewport, 326);
    viewport.set({ height: 160, pageTop: 0 });
    expect(shell().open).toBe(true);
    viewport.set({ height });
    expect(shell()).toEqual(full);
  });

  it("fits the shell to a frame exactly as tall as the composer's floor", () => {
    const viewport = new FakeViewport();
    follow(viewport, 326);
    viewport.set({ height: 112, pageTop: 0 });
    expect(shell()).toEqual({ height: "112px", top: "0px", open: true });
  });

  // Measured on an iPhone 18 Pro Max after a drag that started on the notice: Safari's visual viewport sat at
  // 478 with a height of 349, past the root's 796. A shell placed there made the page 827px tall, which gave
  // Safari more room to pan.
  it("never places the shell past the bottom of the page", () => {
    const viewport = new FakeViewport();
    follow(viewport, 796);
    viewport.set({ height: 349, pageTop: 478 });
    expect(shell()).toEqual({ height: "349px", top: "447px", open: true });
    viewport.set({ pageTop: 447 }, "scroll");
    expect(shell().top).toBe("447px");
    viewport.set({ pageTop: 446 }, "scroll");
    expect(shell().top).toBe("446px");
  });

  // Measured in Safari on iOS 27.0 on an iPhone 17e, on 4 of 5 keyboard opens: the visual viewport's resize came
  // with `pageTop` 0, the window's scroll 30ms later with `scrollY` 330 and `pageTop` still 0, and the visual
  // viewport's own scroll 390 to 420ms after that. Through that gap the screen showed only the composer.
  it("follows the window's scroll when Safari reports it before the visual viewport's", () => {
    const viewport = new FakeViewport();
    const host = follow(viewport, 699);
    viewport.set({ height: 369, pageTop: 0 });
    host.scroll(330);
    expect(shell()).toEqual({ height: "369px", top: "330px", open: true });
    viewport.set({ pageTop: 330 }, "scroll");
    expect(shell().top).toBe("330px");
    // The visual viewport leads when the keyboard closes, and the larger of the two is still the one to follow.
    viewport.set({ pageTop: 46.5 }, "scroll");
    host.scroll(0);
    expect(shell().top).toBe("46.5px");
  });

  it("stops following the window's scroll when stopped", () => {
    const viewport = new FakeViewport();
    const host = follow(viewport, 699);
    viewport.set({ height: 369, pageTop: 0 });
    stop();
    host.scroll(330);
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
