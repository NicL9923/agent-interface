// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { AvatarEditor } from "../src/components/AvatarEditor";
import { mountRoot } from "./ui-harness";
import type { Avatar } from "../src/shared/types";

let container: HTMLDivElement;
let root: Root;
let current: Avatar;
const editor = () =>
  createElement(AvatarEditor, {
    avatar: current,
    // Runs inside the act scope of the click that changed the avatar, so it must not open another.
    onChange: (next: Avatar) => {
      current = next;
      root.render(editor());
    },
    portraitControls: createElement("p", null, "Portrait controls"),
  });
const render = () => act(async () => root.render(editor()));
const choose = async (label: string) => {
  const input = Array.from(container.querySelectorAll("label"))
    .find((element) => element.textContent?.trim() === label)
    ?.querySelector("input");
  expect(input, label).toBeTruthy();
  await act(async () => input!.click());
};

beforeEach(async () => {
  current = {
    mode: "geometric",
    shape: "hex",
    color: "#FF309B",
    eyes: "visor",
    accessory: "hat",
    eyeWidth: 1.2,
  };
  ({ container, root } = mountRoot());
  await render();
});

describe("avatar editor", () => {
  it("brings a seasonal shape in its own color and keeps every other choice", async () => {
    await choose("Pumpkin");
    expect(current).toEqual({
      mode: "geometric",
      shape: "pumpkin",
      color: "#FF6700",
      eyes: "visor",
      accessory: "hat",
      eyeWidth: 1.2,
    });
  });

  it("offers every other shape in the color already chosen", async () => {
    // The names with two words and the acronym are the ones a derived label could get wrong.
    for (const [label, shape] of [
      ["Watering can", "watering-can"],
      ["TARS", "tars"],
      ["Rocky", "rocky"],
    ]) {
      await choose(label);
      expect(current).toMatchObject({ mode: "geometric", shape, color: "#FF309B", eyes: "visor" });
    }
  });

  it("restores the drawn character after trying a portrait", async () => {
    const drawn = current;
    await choose("Portrait");
    expect(current.mode).toBe("portrait");
    expect(container.textContent).toContain("Portrait controls");
    await choose("Character");
    expect(current).toEqual(drawn);
  });

  it("restores a saved portrait after trying a drawn style", async () => {
    current = { mode: "portrait", src: "/api/files/portrait", origin: "uploaded" };
    await render();
    await choose("Character");
    await choose("Portrait");
    expect(current).toEqual({ mode: "portrait", src: "/api/files/portrait", origin: "uploaded" });
  });

  it("updates the chosen shape and resets eye tuning", async () => {
    await choose("Drop");
    expect(current).toMatchObject({ shape: "drop" });
    const reset = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reset eyes",
    )!;
    await act(async () => reset.click());
    expect(current).toMatchObject({ eyeWidth: undefined });
  });

  it("previews states without changing the saved avatar", async () => {
    const before = current;
    const working = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Working",
    )!;
    await act(async () => working.click());
    expect(working.getAttribute("aria-pressed")).toBe("true");
    expect(current).toBe(before);
  });
  it("names each eye tuning slider even though the label contains an output", () => {
    for (const range of container.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      expect(range.labels?.length).toBe(1);
      expect(range.labels![0].control).toBe(range);
      expect(range.labels![0].textContent).toMatch(/Eye (width|height|spacing)/);
    }
  });
});
