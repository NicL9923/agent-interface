// @vitest-environment jsdom
import { act, createElement, lazy } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Loading } from "../src/app/panels";
import { mountRoot } from "./ui-harness";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  ({ container, root } = mountRoot());
});

describe("lazy screens", () => {
  it("say they are opening, then show the screen", async () => {
    type Module = { default: () => ReturnType<typeof createElement> };
    let finish!: (module: Module) => void;
    const Screen = lazy(() => new Promise<Module>(resolve => { finish = resolve; }));
    await act(async () => root.render(createElement(Loading, null, createElement(Screen))));
    expect(container.querySelector("[role=status]")?.textContent).toBe("Opening…");
    await act(async () => finish({ default: () => createElement("p", { id: "screen" }, "Settings") }));
    expect(container.querySelector("#screen")?.textContent).toBe("Settings");
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("offer a reload instead of blanking the app when a screen cannot load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Screen = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    await act(async () => root.render(createElement("div", null, createElement("p", { id: "app" }, "App"), createElement(Loading, null, createElement(Screen)))));
    expect(container.querySelector("#app")?.textContent).toBe("App");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("could not load");
    expect(container.querySelector("[role=alert] button")?.textContent).toBe("Reload");
  });
});
