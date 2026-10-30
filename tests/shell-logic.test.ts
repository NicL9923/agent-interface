// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { rankItems, scoreText, step, type PaletteItem } from "../src/app/palette";
import { applePlatform, formatCombo, isTypingTarget, matchCombo, shortcuts } from "../src/app/shortcuts";
import { ownPrompts, recallStep, type Recall } from "../src/app/prompt-recall";
import { LARGE_PASTE_BYTES, largePasteFile } from "../src/app/large-paste";
import { sortDock, type DockItem } from "../src/app/StatusDock";
import { insertMention, matchMembers, mentionAt } from "../src/app/mentions";
import { badgeCount, badgeTitle } from "../src/app/badge";
import { moveSectionEdit, togglePinEdit } from "../src/app/home-undo";
import { defaultPreferences, type Bot, type Message, type Preferences } from "../src/shared/types";
import type { GroupMember } from "../src/shared/collaboration";

describe("palette ranking", () => {
  const items: PaletteItem[] = [
    { id: "kitchen", group: "Assistants", label: "Kitchen companion" },
    { id: "trail", group: "Assistants", label: "Trail guide" },
    { id: "ranch", group: "Assistants", label: "Ranch hand", keywords: ["Fences and the north gate"] },
    { id: "today", group: "Go to", label: "Today" },
    { id: "groups", group: "Go to", label: "Group chats" },
    { id: "dark", group: "Appearance", label: "Appearance: Dark", keywords: ["theme"] },
    { id: "search", group: "Search", label: "", trailing: true },
  ];
  const ids = (query: string) => rankItems(query, items).map(item => item.id);

  it("keeps the given order and hides trailing items without a query", () => {
    expect(ids("")).toEqual(["kitchen", "trail", "ranch", "today", "groups", "dark"]);
  });
  it("ranks a prefix over a word start over letters in order, and keeps the search item last", () => {
    expect(ids("tr")).toEqual(["trail", "search"]);
    expect(ids("g")).toEqual(["groups", "trail", "ranch", "search"]);
    // Initials and scattered letters still find an assistant.
    expect(ids("kc")[0]).toBe("kitchen");
    expect(ids("ktch")[0]).toBe("kitchen");
    expect(ids("zzz")).toEqual(["search"]);
  });
  it("finds items by keyword, below a name match", () => {
    expect(ids("theme")).toEqual(["dark", "search"]);
    expect(ids("gate")).toEqual(["ranch", "search"]);
    expect(scoreText("Group", "Group chats")!).toBeGreaterThan(scoreText("chats", "Group chats")!);
  });
  it("ignores case and accents", () => {
    expect(scoreText("CAFE", "Café helper")).not.toBeNull();
  });
  it("wraps the highlight at both ends", () => {
    expect(step(0, -1, 3)).toBe(2);
    expect(step(2, 1, 3)).toBe(0);
    expect(step(-1, 1, 3)).toBe(0);
    expect(step(0, 1, 0)).toBe(-1);
  });
});

describe("shortcut matching", () => {
  it.each([
    [{ userAgentData: { platform: "macOS" }, platform: "MacIntel" }, true],
    [{ userAgentData: { platform: "Windows" }, platform: "Win32" }, false],
    [{ userAgentData: { platform: "Linux" }, platform: "Linux aarch64" }, false],
    [{ platform: "MacIntel" }, true],
    [{ platform: "iPhone" }, true],
    [{ platform: "", userAgent: "Mozilla/5.0 (iPad; CPU OS)" }, true],
  ])("detects the shortcut modifier from platform data %j", (platform, apple) => {
    vi.stubGlobal("navigator", platform);
    try {
      expect(applePlatform()).toBe(apple);
      expect(formatCombo(shortcuts.palette)).toBe(apple ? "⌘K" : "Ctrl+K");
      expect(matchCombo(new KeyboardEvent("keydown", { key: "k", metaKey: apple, ctrlKey: !apple }), shortcuts.palette)).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });
  const key = (init: KeyboardEventInit & { target?: EventTarget }) => {
    const event = new KeyboardEvent("keydown", init);
    if (init.target) Object.defineProperty(event, "target", { value: init.target });
    return event;
  };
  it("uses Command on Apple platforms and Control elsewhere", () => {
    expect(matchCombo(key({ key: "k", metaKey: true }), shortcuts.palette, true)).toEqual({});
    expect(matchCombo(key({ key: "k", ctrlKey: true }), shortcuts.palette, true)).toBe(false);
    expect(matchCombo(key({ key: "K", ctrlKey: true }), shortcuts.palette, false)).toEqual({});
    expect(matchCombo(key({ key: "k", ctrlKey: true, metaKey: true }), shortcuts.palette, false)).toBe(false);
    expect(matchCombo(key({ key: "k", metaKey: true, altKey: true }), shortcuts.palette, true)).toBe(false);
    expect(formatCombo(shortcuts.palette, true)).toBe("⌘K");
    expect(formatCombo(shortcuts.stop, false)).toBe("Ctrl+.");
  });
  it("reads the pinned digit by key or physical key", () => {
    expect(matchCombo(key({ key: "3", metaKey: true }), shortcuts.pinned, true)).toEqual({ digit: 3 });
    // A layout where the digit row types symbols without Shift.
    expect(matchCombo(key({ key: "&", code: "Digit1", metaKey: true }), shortcuts.pinned, true)).toEqual({ digit: 1 });
    expect(matchCombo(key({ key: "0", metaKey: true }), shortcuts.pinned, true)).toBe(false);
  });
  it("leaves plain keys to the person typing but lets field shortcuts through", () => {
    const field = document.createElement("textarea");
    const checkbox = Object.assign(document.createElement("input"), { type: "checkbox" });
    expect(isTypingTarget(field)).toBe(true);
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(matchCombo(key({ key: "?", shiftKey: true, target: field }), shortcuts.help, true)).toBe(false);
    expect(matchCombo(key({ key: "?", shiftKey: true, target: document.body }), shortcuts.help, true)).toEqual({});
    expect(matchCombo(key({ key: "z", metaKey: true, target: field }), shortcuts.undo, true)).toBe(false);
    expect(matchCombo(key({ key: "k", metaKey: true, target: field }), shortcuts.palette, true)).toEqual({});
    expect(matchCombo(key({ key: "k", metaKey: true, isComposing: true }), shortcuts.palette, true)).toBe(false);
    expect(matchCombo(key({ key: "z", metaKey: true, shiftKey: true }), shortcuts.undo, true)).toBe(false);
  });
});

describe("prompt recall", () => {
  const message = (id: string, text: string, sender = "one", role: Message["role"] = "user"): Message => ({ id, role, text, sender: { id: sender, name: sender } });
  const messages = [
    message("1", "Plan dinner"), message("2", "Sure", "one", "assistant"), message("3", "Fix the gate", "two"),
    message("4", "What about Tuesday?"), message("5", "Plan dinner"), message("6-inflight", "Sending now"),
  ];
  it("lists this person's own messages newest first, once each", () => {
    expect(ownPrompts(messages, "one")).toEqual(["Plan dinner", "What about Tuesday?"]);
    expect(ownPrompts(undefined, "one")).toEqual([]);
  });
  it("walks back and forward, then restores the empty draft", () => {
    const prompts = ownPrompts(messages, "one");
    let recall: Recall = null;
    const press = (key: "ArrowUp" | "ArrowDown", text: string, start = true, end = true) => {
      const move = recallStep(recall, key, prompts, text, start, end);
      if (move) recall = move.recall;
      return move?.text ?? null;
    };
    expect(press("ArrowDown", "")).toBeNull();
    expect(press("ArrowUp", "")).toBe("Plan dinner");
    expect(press("ArrowUp", "Plan dinner")).toBe("What about Tuesday?");
    // The oldest stays put.
    expect(press("ArrowUp", "What about Tuesday?")).toBe("What about Tuesday?");
    expect(press("ArrowDown", "What about Tuesday?")).toBe("Plan dinner");
    expect(press("ArrowDown", "Plan dinner")).toBe("");
    expect(recall).toBeNull();
  });
  it("leaves the arrows alone with a draft, a caret inside the text, or nothing to recall", () => {
    expect(recallStep(null, "ArrowUp", ["Hi"], "draft", true, false)).toBeNull();
    expect(recallStep(null, "ArrowUp", [], "", true, true)).toBeNull();
    // Inside a long recalled message the caret moves first.
    expect(recallStep({ index: 0, draft: "" }, "ArrowUp", ["a\nb", "c"], "a\nb", false, true)).toBeNull();
    expect(recallStep({ index: 0, draft: "" }, "ArrowDown", ["a\nb", "c"], "a\nb", true, false)).toBeNull();
  });
});

describe("large paste", () => {
  it("attaches text of 32 KiB or more in UTF-8 bytes as a text file", async () => {
    expect(largePasteFile("a".repeat(LARGE_PASTE_BYTES - 1))).toBeNull();
    const file = largePasteFile("a".repeat(LARGE_PASTE_BYTES))!;
    expect([file.name, file.type, file.size]).toEqual(["Pasted text.txt", "text/plain", LARGE_PASTE_BYTES]);
    // Characters are counted as bytes: 8,192 four-byte emoji reach the limit with a quarter of the characters.
    const emoji = largePasteFile("🐴".repeat(LARGE_PASTE_BYTES / 8));
    expect(emoji).toBeNull();
    expect(await largePasteFile("🐴".repeat(LARGE_PASTE_BYTES / 4))!.text()).toBe("🐴".repeat(LARGE_PASTE_BYTES / 4));
  });
});

describe("status dock", () => {
  it("puts the most pressing notice first and keeps the given order within a kind", () => {
    const item = (id: string, kind: DockItem["kind"]): DockItem => ({ id, kind, node: null });
    const order = sortDock([item("update", "update"), item("connection", "connection"), item("decisions", "decisions"),
      item("rejected", "send"), item("interrupted", "interrupted"), item("uncertain", "send")]).map(entry => entry.id);
    expect(order).toEqual(["rejected", "uncertain", "interrupted", "connection", "decisions", "update"]);
  });
});

describe("group mentions", () => {
  const members: GroupMember[] = [
    { member_id: "ranch", profile: "ranch", handle: "ranch", display_name: "Ranch hand" },
    { member_id: "planner", profile: "planner", handle: "planner", display_name: "Trip planner" },
    { member_id: "rain", profile: "rain", handle: "rainy", display_name: "Weather" },
  ];
  it("finds the handle being typed before the caret, but not an email address", () => {
    expect(mentionAt("Ask @ra", 7)).toEqual({ start: 4, query: "ra" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("(@pl", 4)).toEqual({ start: 1, query: "pl" });
    expect(mentionAt("mail me@ranch", 13)).toBeNull();
    expect(mentionAt("Ask @ranch now", 14)).toBeNull();
  });
  it("matches handles first, then words of the name", () => {
    expect(matchMembers(members, "ra").map(member => member.handle)).toEqual(["ranch", "rainy"]);
    expect(matchMembers(members, "trip").map(member => member.handle)).toEqual(["planner"]);
    expect(matchMembers(members, "").length).toBe(3);
  });
  it("replaces the partial handle and places the caret after one space", () => {
    expect(insertMention("Ask @ra", { start: 4, query: "ra" }, "ranch")).toEqual({ text: "Ask @ranch ", caret: 11 });
    expect(insertMention("Ask @ra about rain", { start: 4, query: "ra" }, "ranch")).toEqual({ text: "Ask @ranch about rain", caret: 11 });
  });
});

describe("app badge", () => {
  const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({ id, name: id, shared: true, model: "m", activity: "idle", ...extra });
  const at = "2026-10-25T12:00:00Z";
  it("counts unread chats and assistants waiting on a decision once each", () => {
    const bots = [
      bot("unread", { unread: true, lastMessage: { text: "hi", at } }),
      bot("asking", { activity: "waiting" }),
      bot("both", { unread: true, activity: "blocked", lastMessage: { text: "?", at } }),
      bot("shown", { unread: true, lastMessage: { text: "hi", at } }),
      bot("read", { unread: true, lastMessage: { text: "hi", at } }),
      bot("quiet", { activity: "working" }),
    ];
    expect(badgeCount(bots, "shown", { read: at })).toBe(3);
  });
  it("puts the count in the title", () => {
    expect(badgeTitle(0)).toBe("WildBots");
    expect(badgeTitle(3)).toBe("(3) WildBots");
    expect(badgeTitle(250)).toBe("(99+) WildBots");
  });
});

describe("home undo", () => {
  const prefs: Preferences = { ...defaultPreferences, favorites: ["a", "b", "c"], sections: [
    { id: "house", name: "Around the house", botIds: ["x", "y", "z"] }, { id: "kids", name: "Kids", botIds: [] },
  ] };
  it("returns an unpinned assistant to its old place", () => {
    const change = togglePinEdit(prefs, "b", "Bee");
    expect(change.message).toBe("Unpinned Bee");
    const after = change.apply(prefs);
    expect(after.favorites).toEqual(["a", "c"]);
    expect(change.undo(after).favorites).toEqual(["a", "b", "c"]);
    const pin = togglePinEdit(after, "b", "Bee");
    expect(pin.message).toBe("Pinned Bee");
    expect(pin.undo(pin.apply(after)).favorites).toEqual(["a", "c"]);
  });
  it("returns a moved assistant to its old section and position", () => {
    const change = moveSectionEdit(prefs, "y", "Why", "kids");
    expect(change.message).toBe("Moved Why to Kids");
    const after = change.apply(prefs);
    expect(after.sections.map(section => section.botIds)).toEqual([["x", "z"], ["y"]]);
    expect(change.undo(after).sections.map(section => section.botIds)).toEqual([["x", "y", "z"], []]);
    expect(moveSectionEdit(prefs, "y", "Why", null).message).toBe("Removed Why from Around the house");
  });
});
