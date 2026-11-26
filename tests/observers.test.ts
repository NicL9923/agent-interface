// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observeIntersection,
  observeResize,
  resetObserversForTest,
  useReducedMotion,
} from "../src/lib/observers";
import { mountRoot, type Mount } from "./ui-harness";

let mount: Mount;

beforeEach(() => {
  resetObserversForTest();
  mount = mountRoot();
});

afterEach(() => {
  resetObserversForTest();
});

describe("observeResize", () => {
  it("shares one ResizeObserver across multiple elements and dispatches per target", () => {
    const instances: {
      callback: ResizeObserverCallback;
      observed: Set<Element>;
      unobserved: Element[];
      disconnected: number;
    }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observed = new Set<Element>();
        unobserved: Element[] = [];
        disconnected = 0;
        constructor(public callback: ResizeObserverCallback) {
          instances.push(this);
        }
        observe(target: Element) {
          this.observed.add(target);
        }
        unobserve(target: Element) {
          this.observed.delete(target);
          this.unobserved.push(target);
        }
        disconnect() {
          this.disconnected++;
          this.observed.clear();
        }
      },
    );

    const a = document.createElement("div");
    const b = document.createElement("div");
    const cbA1 = vi.fn();
    const cbA2 = vi.fn();
    const cbB = vi.fn();
    const stopA1 = observeResize(a, cbA1);
    const stopA2 = observeResize(a, cbA2);
    const stopB = observeResize(b, cbB);

    expect(instances).toHaveLength(1);
    expect([...instances[0]!.observed]).toEqual([a, b]);

    const entryA = { target: a } as unknown as ResizeObserverEntry;
    instances[0]!.callback([entryA], instances[0] as unknown as ResizeObserver);
    expect(cbA1).toHaveBeenCalledExactlyOnceWith(entryA);
    expect(cbA2).toHaveBeenCalledExactlyOnceWith(entryA);
    expect(cbB).not.toHaveBeenCalled();

    // Unsubscribing one callback keeps observing the element until the last leaves.
    stopA1();
    expect(instances[0]!.unobserved).toEqual([]);
    stopA2();
    expect(instances[0]!.unobserved).toEqual([a]);
    stopB();
    expect(instances[0]!.unobserved).toEqual([a, b]);
  });

  it("allocates a fresh singleton when globalThis.ResizeObserver is replaced", () => {
    const makeCtor = () => {
      let count = 0;
      return {
        ctor: class {
          constructor() {
            count++;
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        },
        count: () => count,
      };
    };
    const first = makeCtor();
    const second = makeCtor();
    vi.stubGlobal("ResizeObserver", first.ctor);
    const el = document.createElement("div");
    const stop1 = observeResize(el, () => {});
    expect(first.count()).toBe(1);
    vi.stubGlobal("ResizeObserver", second.ctor);
    const stop2 = observeResize(el, () => {});
    expect(second.count()).toBe(1);
    stop1();
    stop2();
  });

  it("no-ops cleanly when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const stop = observeResize(document.createElement("div"), () => {});
    expect(() => stop()).not.toThrow();
  });
});

describe("observeIntersection", () => {
  it("shares one viewport IntersectionObserver across targets and unobserves on cleanup", () => {
    const instances: {
      callback: IntersectionObserverCallback;
      observed: Set<Element>;
      unobserved: Element[];
    }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observed = new Set<Element>();
        unobserved: Element[] = [];
        constructor(public callback: IntersectionObserverCallback) {
          instances.push(this);
        }
        observe(target: Element) {
          this.observed.add(target);
        }
        unobserve(target: Element) {
          this.observed.delete(target);
          this.unobserved.push(target);
        }
        disconnect() {
          this.observed.clear();
        }
      },
    );

    const a = document.createElement("span");
    const b = document.createElement("span");
    const cbA = vi.fn();
    const cbB = vi.fn();
    const stopA = observeIntersection(a, cbA);
    const stopB = observeIntersection(b, cbB);
    expect(instances).toHaveLength(1);

    const entryB = { target: b, isIntersecting: false } as unknown as IntersectionObserverEntry;
    instances[0]!.callback([entryB], instances[0] as unknown as IntersectionObserver);
    expect(cbA).not.toHaveBeenCalled();
    expect(cbB).toHaveBeenCalledExactlyOnceWith(entryB);

    stopA();
    stopB();
    expect(instances[0]!.unobserved).toEqual([a, b]);
  });

  it("no-ops cleanly when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const stop = observeIntersection(document.createElement("span"), () => {});
    expect(() => stop()).not.toThrow();
  });
});

describe("useReducedMotion", () => {
  it("shares one matchMedia listener across components, updates on change, and detaches on unmount", async () => {
    let matches = false;
    const listeners = new Set<() => void>();
    const addEventListener = vi.fn((_type: string, fn: () => void) => listeners.add(fn));
    const removeEventListener = vi.fn((_type: string, fn: () => void) => listeners.delete(fn));
    const matchMedia = vi.fn((query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      addEventListener,
      removeEventListener,
    }));
    vi.stubGlobal("matchMedia", matchMedia);

    function Probe({ id, force }: { id: string; force?: boolean }) {
      const reduced = useReducedMotion(force);
      return createElement("span", { "data-probe": id }, String(reduced));
    }

    await mount.render(
      createElement(
        "div",
        null,
        createElement(Probe, { id: "a" }),
        createElement(Probe, { id: "b" }),
        createElement(Probe, { id: "forced", force: true }),
      ),
    );
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(mount.container.querySelector('[data-probe="a"]')?.textContent).toBe("false");
    expect(mount.container.querySelector('[data-probe="b"]')?.textContent).toBe("false");
    expect(mount.container.querySelector('[data-probe="forced"]')?.textContent).toBe("true");

    matches = true;
    await act(async () => {
      for (const listener of [...listeners]) listener();
    });
    expect(mount.container.querySelector('[data-probe="a"]')?.textContent).toBe("true");
    expect(mount.container.querySelector('[data-probe="b"]')?.textContent).toBe("true");

    await act(async () => mount.root.unmount());
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});
