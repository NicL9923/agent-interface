// @vitest-environment jsdom
import { act, createElement, lazy } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Loading } from "../src/app/panels";
import { advance, mountRoot } from "./ui-harness";
import { quietConsoleErrors } from "./act-guard";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  ({ container, root } = mountRoot());
});

describe("lazy screens", () => {
  it("hold back the opening status for fast loads, show it after the delay, then show the screen", async () => {
    vi.useFakeTimers();
    type Module = { default: () => ReturnType<typeof createElement> };
    let finish!: (module: Module) => void;
    const Screen = lazy(
      () =>
        new Promise<Module>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => root.render(createElement(Loading, null, createElement(Screen))));
    // Fast transitions never flash "Opening…".
    await advance(140);
    expect(container.querySelector("[role=status]")).toBeNull();
    // Slower loads surface the status once the 150 ms delay elapses.
    await advance(15);
    expect(container.querySelector("[role=status]")?.textContent).toBe("Opening…");
    await act(async () =>
      finish({ default: () => createElement("p", { id: "screen" }, "Settings") }),
    );
    expect(container.querySelector("#screen")?.textContent).toBe("Settings");
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("never flashes Opening… when the screen resolves before the delay", async () => {
    vi.useFakeTimers();
    type Module = { default: () => ReturnType<typeof createElement> };
    let finish!: (module: Module) => void;
    const Screen = lazy(
      () =>
        new Promise<Module>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => root.render(createElement(Loading, null, createElement(Screen))));
    await advance(50);
    expect(container.querySelector("[role=status]")).toBeNull();
    await act(async () =>
      finish({ default: () => createElement("p", { id: "screen" }, "Fast screen") }),
    );
    expect(container.querySelector("#screen")?.textContent).toBe("Fast screen");
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("offer a reload instead of blanking the app when a screen cannot load", async () => {
    quietConsoleErrors();
    const Screen = lazy(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module")),
    );
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement("p", { id: "app" }, "App"),
          createElement(Loading, null, createElement(Screen)),
        ),
      ),
    );
    expect(container.querySelector("#app")?.textContent).toBe("App");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("could not load");
    expect(container.querySelector("[role=alert] button")?.textContent).toBe("Reload");
  });
});
