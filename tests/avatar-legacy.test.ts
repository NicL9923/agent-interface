import { expect, it } from "vitest";
import { bot } from "../src/server/hermes-mapping";
import { Store } from "../src/server/store";
import { currentAvatar, legacyMascots } from "../src/shared/avatar-legacy";
import { avatarShapes, type Avatar } from "../src/shared/types";

const mascot = (family: unknown, color = "#123456") => ({
  mode: "mascot",
  family,
  color,
  eyes: "spark",
  accessory: "glasses",
  eyeSpacing: 1.3,
});

it("reads a retired mascot as its shape and keeps every choice made on it", () => {
  expect(currentAvatar(mascot("dinosaur"))).toEqual({
    mode: "geometric",
    shape: "dino",
    color: "#123456",
    eyes: "spark",
    accessory: "glasses",
    eyeSpacing: 1.3,
  });
});

it("gives every retired mascot a shape this release draws", () => {
  // The table is typed, so this guards the names: the 18 families older releases could store.
  expect(Object.keys(legacyMascots).sort()).toEqual([
    "bat",
    "bear",
    "bunny",
    "cactus",
    "dinosaur",
    "eagle",
    "fox",
    "ghost",
    "leprechaun",
    "owl",
    "panda",
    "pumpkin",
    "raccoon",
    "rudolph",
    "santa",
    "snowman",
    "sprout",
    "turkey",
  ]);
  const shapes: readonly string[] = avatarShapes;
  expect(Object.values(legacyMascots).filter(({ shape }) => !shapes.includes(shape))).toEqual([]);
});

it("swaps a seasonal mascot's fixed face color for its shape's, and leaves a chosen color alone", () => {
  const color = (family: string, was: string) =>
    (currentAvatar<unknown>(mascot(family, was)) as { color: string }).color;
  // Santa and the leprechaun were skin-colored faces; the eagle was a white head.
  expect([
    color("santa", "#F2B08B"),
    color("leprechaun", "#f2b08b"),
    color("eagle", "#F7F3EA"),
  ]).toEqual(["#FF263C", "#1FBF68", "#FF9800"]);
  expect(color("santa", "#123456")).toBe("#123456");
  // The same hex on a mascot that never had it as its own color is someone's choice.
  expect(color("bear", "#F2B08B")).toBe("#F2B08B");
  // A color that is not text is left for the avatar's own checks to refuse.
  expect(currentAvatar({ ...mascot("santa"), color: 7 })).toMatchObject({ color: 7 });
});

it("reads a mascot family it never had as the blob, including an object's own property names", () => {
  const shape = (family: unknown) =>
    (currentAvatar<unknown>(mascot(family)) as { shape: string }).shape;
  expect([
    shape("dragon"),
    shape("constructor"),
    shape("__proto__"),
    shape(undefined),
    shape(7),
  ]).toEqual(Array(5).fill("blob"));
});

it("returns anything that is not a mascot exactly as it was", () => {
  const geometric = { mode: "geometric", shape: "hex", color: "#123456", family: "bear" };
  const portrait = { mode: "portrait", src: "/api/files/a", origin: "uploaded" };
  for (const value of [geometric, portrait, undefined, null, "mascot", 7, { mode: "hologram" }])
    expect(currentAvatar(value)).toBe(value);
});

// The two places a mascot is still stored: Hermes profile metadata, and this app's own store for
// a Hermes that keeps none. Both hand it to every client as its shape.
it("reads a mascot kept in Hermes profile metadata as its shape", () => {
  const row = { name: "garden", ui_meta: { agent_interface: { avatar: mascot("sprout") } } };
  expect(bot(row, "idle").avatar).toMatchObject({ mode: "geometric", shape: "sprout" });
  expect(bot({ name: "plain" }, "idle").avatar).toBeUndefined();
});

it("reads a mascot kept in the app's store as its shape", () => {
  const store = new Store(":memory:");
  try {
    store.saveAvatar("garden", mascot("owl") as unknown as Avatar, true);
    expect(store.presentation("garden").avatar).toMatchObject({ mode: "geometric", shape: "owl" });
  } finally {
    store.close();
  }
});
