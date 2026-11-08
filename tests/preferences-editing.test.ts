import { describe, expect, it, vi } from "vitest";
import {
  addSection, checkSectionName, moveBotToSection, moveSection, newSectionId, removeSection, renameSection,
  sectionOf, setFollowedBots, setFollowing, setSectionBots,
} from "../src/app/preferences-editing";
import { defaultPreferences, type Preferences } from "../src/shared/types";

const prefs = (sections: Preferences["sections"], followBots: string[] = []): Preferences =>
  ({ ...defaultPreferences, sections, followBots });
const house = { id: "house", name: "Around the house", botIds: ["ranch", "kitchen"] };
const kids = { id: "kids", name: "Kids", botIds: ["homework"] };

describe("following", () => {
  it("adds and removes one bot without duplicating it", () => {
    const on = setFollowing(prefs([], ["ranch"]), "ranch", true);
    expect(on.followBots).toEqual(["ranch"]);
    expect(setFollowing(on, "garden", true).followBots).toEqual(["ranch", "garden"]);
    expect(setFollowing(on, "ranch", false).followBots).toEqual([]);
  });

  it("replaces the followed set and keeps the existing order", () => {
    expect(setFollowedBots(prefs([], ["kitchen", "ranch"]), ["ranch", "garden", "kitchen"]).followBots)
      .toEqual(["kitchen", "ranch", "garden"]);
    expect(setFollowedBots(prefs([], ["kitchen"]), []).followBots).toEqual([]);
  });
});

describe("sections", () => {
  it("moves a bot into exactly one section, or out of all of them", () => {
    const moved = moveBotToSection(prefs([house, kids]), "ranch", "kids");
    expect(moved.sections).toEqual([{ ...house, botIds: ["kitchen"] }, { ...kids, botIds: ["homework", "ranch"] }]);
    expect(sectionOf(moved, "ranch")?.id).toBe("kids");
    const none = moveBotToSection(moved, "ranch", null);
    expect(sectionOf(none, "ranch")).toBeUndefined();
    // Earlier settings allowed one bot in two sections; any move repairs that.
    const doubled = prefs([house, { ...kids, botIds: ["ranch"] }]);
    expect(moveBotToSection(doubled, "ranch", "house").sections.flatMap(section => section.botIds).filter(id => id === "ranch")).toHaveLength(1);
  });

  it("sets a section's members and takes them out of other sections", () => {
    const next = setSectionBots(prefs([house, kids]), "kids", ["homework", "kitchen"]);
    expect(next.sections).toEqual([{ ...house, botIds: ["ranch"] }, { ...kids, botIds: ["homework", "kitchen"] }]);
    expect(setSectionBots(next, "kids", []).sections[1].botIds).toEqual([]);
  });

  it("adds a section with a fresh id, and can move a bot into it at once", () => {
    const added = addSection(prefs([house]), "  Kids ", "new", "ranch");
    expect(added.sections).toEqual([{ ...house, botIds: ["kitchen"] }, { id: "new", name: "Kids", botIds: ["ranch"] }]);
  });

  it("checks names for blanks, length and duplicates", () => {
    const current = prefs([house, kids]);
    expect(checkSectionName(current, "   ")).toEqual({ error: "Enter a section name." });
    expect(checkSectionName(current, "x".repeat(101))).toHaveProperty("error");
    expect(checkSectionName(current, " kids ")).toEqual({ error: "You already have a section called kids." });
    expect(checkSectionName(current, "Kids", "kids")).toEqual({ name: "Kids" });
    expect(checkSectionName(current, " Ranch   chores ")).toEqual({ name: "Ranch chores" });
  });

  it("renames, removes and reorders without touching members", () => {
    expect(renameSection(prefs([house, kids]), "kids", " Family ").sections[1]).toEqual({ ...kids, name: "Family" });
    expect(removeSection(prefs([house, kids]), "house").sections).toEqual([kids]);
    expect(moveSection(prefs([house, kids]), "kids", -1).sections).toEqual([kids, house]);
    const unchanged = prefs([house, kids]);
    expect(moveSection(unchanged, "house", -1)).toBe(unchanged);
    expect(moveSection(unchanged, "kids", 1)).toBe(unchanged);
  });

  it("makes ids where crypto.randomUUID is missing, as on a plain-HTTP LAN address", () => {
    vi.stubGlobal("crypto", {});
    try {
      const first = newSectionId(), second = newSectionId();
      expect(first).toMatch(/^section-/);
      expect(first).not.toBe(second);
    } finally { vi.unstubAllGlobals(); }
  });
});
