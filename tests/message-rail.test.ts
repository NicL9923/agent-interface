import { describe, expect, it } from "vitest";
import type { Message } from "../src/shared/types";
import {
  activeTick,
  railEntries,
  railHidden,
  railKey,
  railRoom,
  railShown,
  railWindow,
  RAIL_SPACE,
  tickName,
} from "../src/app/message-rail";

// Hermes names the sender only of a person's message; scheduled prompts and subagent rows carry none.
const user = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  text,
  sender: { id: "one", name: "One" },
  ...extra,
});
const reply = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "assistant",
  text,
  ...extra,
});

describe("railEntries", () => {
  it("ticks every message a person sent, theirs or another member's, and nothing else", () => {
    const entries = railEntries([
      user("own", "Check the gates", { createdAt: "2026-11-19T10:00:00Z" }),
      reply("a1", "Both are shut."),
      user("member", "Did the hay come?", { sender: { id: "two", name: "Two" } }),
      user("scheduled", "Morning check", {
        sender: undefined,
        origin: { kind: "scheduled", visibility: "conversation" },
      }),
      user("subagent", "Subtask", {
        sender: undefined,
        origin: { kind: "subagent", visibility: "activity" },
      }),
      { id: "tool", role: "tool", text: "ran", toolName: "shell" },
      reply("a2", "Morning: all clear."),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["own", "member"]);
    expect(entries[0]).toMatchObject({ text: "Check the gates", at: "2026-11-19T10:00:00Z" });
  });

  it("previews the reply that answered each message, not a later turn's", () => {
    const entries = railEntries([
      user("q1", "What's for dinner?"),
      reply("p1", "Looking at the list…", { interim: true }),
      reply("work", "", { toolCall: { id: "c", name: "list", status: "completed" } }),
      reply("a1", "**Pot roast**, with [carrots](https://example.test)."),
      reply("a1b", "And rolls."),
      user("q2", "And tomorrow?"),
      user("sched", "Daily digest", {
        sender: undefined,
        origin: { kind: "scheduled", visibility: "conversation" },
      }),
      reply("digest", "Here is the digest."),
    ]);
    // A progress line is not the reply; the first answer is, without its Markdown.
    expect(entries[0].reply).toBe("Pot roast, with carrots.");
    // A scheduled prompt starts its own turn, so its answer is not the person's reply.
    expect(entries[1].reply).toBeUndefined();
  });

  // A reaction is a tap, not a question to find again; it reads the message alone, so its place does not matter.
  it("gives a reaction no tick, and ends the reply of the tick before it", () => {
    const entries = railEntries([
      user("q", "Add salt to the list?"),
      reply("a", "Want me to add it to the list?"),
      user("react", "👍"),
      user("member", "🎉", { sender: { id: "two", name: "Two" } }),
      user("after", "And pepper"),
      user("lone", "👍"),
      reply("b", "Added pepper."),
      user("emoji", "🔥"),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["q", "after", "emoji"]);
    expect(entries[1].reply).toBeUndefined();
  });

  it("names a message without words by its files, on one line", () => {
    const [files, spaced] = railEntries([
      user("f", "  ", { files: [{ id: "1", name: "gate.jpg", mime: "image/jpeg" }] }),
      user("s", "Line one\n\n  line two"),
    ]);
    expect(files.text).toBe("gate.jpg");
    expect(spaced.text).toBe("Line one line two");
  });
});

it("names a tick by the first 80 characters of its message", () => {
  const text = "x".repeat(79) + "yz";
  expect(tickName({ id: "m", text })).toBe(`Jump to: ${"x".repeat(79)}y`);
  expect(tickName({ id: "m", text: "Short" })).toBe("Jump to: Short");
});

describe("railRoom", () => {
  it("fits a tick per whole 24 px pitch", () => {
    expect(railRoom(72)).toBe(3);
    // A partial pitch does not fit a tick.
    expect(railRoom(71)).toBe(2);
    expect(railRoom(23)).toBe(0);
    expect(railRoom(-40)).toBe(0);
  });
});

describe("railWindow", () => {
  it("shows every entry when they fit, and none without room", () => {
    expect(railWindow(5, 20, 2)).toEqual({ start: 0, end: 5 });
    expect(railWindow(5, 0, 2)).toEqual({ start: 0, end: 0 });
  });
  it("starts at the latest entries", () => {
    expect(railWindow(64, 20, 63)).toEqual({ start: 44, end: 64 });
  });
  it("holds still while the anchor stays inside with a tick to spare", () => {
    expect(railWindow(64, 20, 45, 44)).toEqual({ start: 44, end: 64 });
    expect(railWindow(64, 20, 47, 30)).toEqual({ start: 30, end: 50 });
  });
  it("moves only as far as it takes to show the anchor and its neighbor toward the hidden side", () => {
    expect(railWindow(64, 20, 44, 44).start).toBe(43);
    expect(railWindow(64, 20, 10, 44).start).toBe(9);
    expect(railWindow(64, 20, 50, 20).start).toBe(32);
  });
  it("reaches both ends, where nothing is hidden to spare a tick for", () => {
    expect(railWindow(64, 20, 0, 44)).toEqual({ start: 0, end: 20 });
    expect(railWindow(64, 20, 63, 0)).toEqual({ start: 44, end: 64 });
  });
});

describe("railHidden", () => {
  it("says how many messages each side hides, and nothing when all show", () => {
    expect(railHidden(44, 0)).toBe("44 earlier messages are not shown. Up and Down reach them.");
    expect(railHidden(0, 1)).toBe("1 later message is not shown. Up and Down reach them.");
    expect(railHidden(3, 2)).toBe(
      "3 earlier and 2 later messages are not shown. Up and Down reach them.",
    );
    expect(railHidden(0, 0)).toBeUndefined();
  });
});

describe("railShown", () => {
  const fits = { canHover: true, gutter: RAIL_SPACE, overflows: true, count: 3 };
  it("shows beside the column for a hovering pointer and three sent messages", () => {
    expect(railShown(fits)).toBe(true);
  });
  it.each([
    ["a touch screen", { canHover: false }],
    ["a gutter narrower than the rail", { gutter: RAIL_SPACE - 1 }],
    ["a transcript with nothing to scroll", { overflows: false }],
    ["two sent messages", { count: 2 }],
  ])("hides for %s", (_, change) => {
    expect(railShown({ ...fits, ...change })).toBe(false);
  });
});

describe("activeTick", () => {
  /** Places from each message's top relative to the view, as measured with the view at the top. */
  const placed = (tops: (number | undefined)[]) =>
    tops.flatMap((offset, index) => (offset === undefined ? [] : [{ index, offset }]));
  // A 600 px view reads the turn whose message reached its upper third, 200 px.
  it("marks the last message above the reading line", () => {
    expect(activeTick(placed([-900, -40, 24, 450]), 0, 600, false)).toBe(2);
    expect(activeTick(placed([-900, -40, 200, 450]), 0, 600, false)).toBe(2);
    expect(activeTick(placed([-900, -40, 201, 450]), 0, 600, false)).toBe(1);
  });
  it("reads the line from where the view has scrolled to", () => {
    expect(activeTick(placed([0, 400, 800, 1200]), 500, 600, false)).toBe(1);
    expect(activeTick(placed([0, 400, 800, 1200]), 600, 600, false)).toBe(2);
  });
  it("marks the last message in view at the end of the transcript", () => {
    expect(activeTick(placed([-900, -40, 450]), 0, 600, true)).toBe(2);
    expect(activeTick(placed([-900, -40, 600]), 0, 600, true)).toBe(1);
  });
  it("skips messages that are not on the page", () => {
    expect(activeTick(placed([-300, undefined, 700]), 0, 600, false)).toBe(0);
  });
  it("marks the first message in view when the view is above them all", () => {
    expect(activeTick(placed([350, 900]), 0, 600, false)).toBe(0);
    expect(activeTick(placed([700, 900]), 0, 600, false)).toBe(-1);
    expect(activeTick([], 0, 600, false)).toBe(-1);
  });
});

describe("railKey", () => {
  it("moves one tick with Up and Down and stops at either end", () => {
    expect(railKey("ArrowUp", 2, 5)).toBe(1);
    expect(railKey("ArrowDown", 2, 5)).toBe(3);
    expect(railKey("ArrowUp", 0, 5)).toBe(0);
    expect(railKey("ArrowDown", 4, 5)).toBe(4);
  });
  it("jumps to the first and last with Home and End", () => {
    expect(railKey("Home", 3, 5)).toBe(0);
    expect(railKey("End", 1, 5)).toBe(4);
  });
  it("recovers from a tab stop that is no longer on the rail", () => {
    expect(railKey("ArrowDown", -1, 5)).toBe(0);
    expect(railKey("ArrowUp", 9, 5)).toBe(4);
  });
  it("leaves other keys, and an empty rail, alone", () => {
    expect(railKey("Enter", 2, 5)).toBeUndefined();
    expect(railKey("ArrowLeft", 2, 5)).toBeUndefined();
    expect(railKey("End", 0, 0)).toBeUndefined();
  });
});
