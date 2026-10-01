// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvatarEditor } from "../src/components/AvatarEditor";
import type { Avatar } from "../src/shared/types";

// jsdom has no SVG geometry, so the rig itself is covered by avatar-motion tests.
vi.mock("../src/components/Avatar", async (original) => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: () => null,
}));

let container: HTMLDivElement;
let root: Root;
let current: Avatar;
const render = () => act(async () => root.render(createElement(AvatarEditor, {
  avatar: current,
  onChange: (next: Avatar) => { current = next; void render(); },
  portraitControls: createElement("p", null, "Portrait controls"),
})));
const choose = async (label: string) => {
  const input = Array.from(container.querySelectorAll("label"))
    .find((element) => element.textContent?.trim() === label)?.querySelector("input");
  expect(input, label).toBeTruthy();
  await act(async () => input!.click());
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  current = { mode: "geometric", shape: "hex", color: "#FF309B", eyes: "visor", accessory: "hat", eyeWidth: 1.2 };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("avatar editor", () => {
  it("keeps color, eyes and accessory when switching to a mascot", async () => {
    await choose("Mascot");
    expect(current).toEqual({ mode: "mascot", family: "bear", color: "#FF309B", eyes: "visor", accessory: "hat", eyeWidth: 1.2, eyeHeight: undefined, eyeSpacing: undefined });
  });

  it("restores the drawn character after trying a portrait", async () => {
    await choose("Portrait");
    expect(current.mode).toBe("portrait");
    expect(container.textContent).toContain("Portrait controls");
    await choose("Geometric");
    expect(current).toMatchObject({ mode: "geometric", shape: "hex", color: "#FF309B", eyes: "visor" });
  });

  it("remembers the last shape and character across styles", async () => {
    await choose("Mascot");
    await choose("Fox");
    await choose("Geometric");
    expect(current).toMatchObject({ mode: "geometric", shape: "hex" });
    await choose("Mascot");
    expect(current).toMatchObject({ mode: "mascot", family: "fox" });
  });

  it("restores a saved portrait after trying a drawn style", async () => {
    current = { mode: "portrait", src: "/api/files/portrait", origin: "uploaded" };
    await render();
    await choose("Geometric");
    await choose("Portrait");
    expect(current).toEqual({ mode: "portrait", src: "/api/files/portrait", origin: "uploaded" });
  });

  it("updates the chosen shape and resets eye tuning", async () => {
    await choose("Drop");
    expect(current).toMatchObject({ shape: "drop" });
    const reset = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Reset eyes")!;
    await act(async () => reset.click());
    expect(current).toMatchObject({ eyeWidth: undefined });
  });

  it("previews states without changing the saved avatar", async () => {
    const before = current;
    const working = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Working")!;
    await act(async () => working.click());
    expect(working.getAttribute("aria-pressed")).toBe("true");
    expect(current).toBe(before);
  });
});
