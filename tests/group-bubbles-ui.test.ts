// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/client-api";
import { GroupRoomView } from "../src/components/GroupChats";
import { defaultPreferences, type Bootstrap, type Preferences } from "../src/shared/types";
import type { GroupState } from "../src/shared/collaboration";
import { click, mountRoot } from "./ui-harness";
vi.mock("../src/client-api", async (original) =>
  (await import("./helpers/request-mock")).withRequest({
    ...(await original<typeof import("../src/client-api")>()),
    api: vi.fn(),
    write: vi.fn(),
  }),
);

// A group chat's rows in each chat style. Classic keeps the log layout; Bubbles lays out every message as a chat with
// one assistant lays out a reply, and the person's own messages sit at the trailing edge.
let root: Root, container: HTMLDivElement;
const room = {
  room_id: "room",
  name: "Weekend plans",
  members: [
    { member_id: "ranch", profile: "ranch", handle: "ranch", display_name: "Ranch hand" },
    { member_id: "planner", profile: "planner", handle: "planner", display_name: "Planner" },
  ],
};
const state: GroupState = { room };
const events = [
  {
    event_id: "own",
    seq: 1,
    kind: "message.user",
    actor: { kind: "user", id: "one" },
    payload: { text: "Who fixes the gate? @ranch", thread_id: "t" },
    created_at: 1,
  },
  {
    event_id: "r1",
    seq: 2,
    kind: "message.member",
    actor: { kind: "member", id: "ranch" },
    payload: {
      member_id: "ranch",
      text: "I will.\n\n| Post | State |\n| --- | --- |\n| 2 | Loose |\n\nDone by noon.",
      thread_id: "t",
    },
    created_at: 2,
  },
  {
    event_id: "r2",
    seq: 3,
    kind: "message.member",
    actor: { kind: "member", id: "ranch" },
    payload: { member_id: "ranch", text: "Spare battery is in the barn.", thread_id: "t" },
    created_at: 3,
  },
  {
    event_id: "a",
    seq: 4,
    kind: "room.assignment",
    actor: { kind: "gateway", id: "g" },
    payload: { lead_member_id: "planner", member_ids: ["ranch"], thread_id: "t" },
    created_at: 4,
  },
  {
    event_id: "p",
    seq: 5,
    kind: "message.member",
    actor: { kind: "member", id: "planner" },
    payload: { member_id: "planner", text: "Separate topic: the feed order.", thread_id: "u" },
    created_at: 5,
  },
  {
    event_id: "other",
    seq: 6,
    kind: "message.user",
    actor: { kind: "user", id: "two" },
    sender: { id: "two", name: "Casey" },
    payload: { text: "I can help.", thread_id: "t" },
    created_at: 6,
  },
  {
    event_id: "brief",
    seq: 7,
    kind: "message.user",
    actor: { kind: "user", id: "cron:job-1", display_name: "[bot:ranch] Morning brief" },
    payload: { text: "Gate is shut.", thread_id: "cron-1" },
    created_at: 7,
  },
];
const render = (chatStyle?: Preferences["chatStyle"]) =>
  act(async () =>
    root.render(
      createElement(GroupRoomView, {
        bootstrap: {
          user: { id: "one" },
          bots: [
            { id: "ranch", name: "Ranch hand" },
            { id: "planner", name: "Planner" },
          ],
          preferences: { ...defaultPreferences, chatStyle },
          connection: { connected: true },
        } as Bootstrap,
        roomId: "room",
        canSend: true,
        onChanged: vi.fn(),
      }),
    ),
  );
const rows = () => [...container.querySelectorAll<HTMLElement>(".group-message")];
const row = (text: string) => rows().find((element) => element.textContent!.includes(text))!;
/** What each row shows, in order: its speaker line, then each piece of its message, bubble or block. */
const layout = () =>
  rows().map((element) => [
    element.querySelector(".group-speaker")!.textContent,
    ...[...element.querySelector(".message-markdown")!.children].map((piece) =>
      piece.classList.contains("reply-bubble") ? `bubble: ${piece.textContent}` : piece.tagName,
    ),
  ]);
beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.useFakeTimers();
  ({ container, root } = mountRoot());
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes("/log") ? { events, cursor: events.length, has_more: false } : state,
  );
});

it("lays out every message in bubbles by default, each under its own speaker line", async () => {
  await render();
  expect(container.querySelector(".group-panel")!.classList).toContain("group-bubbles");
  expect(layout()).toEqual([
    ["You", "bubble: Who fixes the gate? @ranch"],
    // The table keeps the column's width between the prose on either side of it.
    ["Ranch hand", "bubble: I will.", "DIV", "bubble: Done by noon."],
    // A second message from the same speaker keeps its line, as it does in Classic.
    ["Ranch hand", "bubble: Spare battery is in the barn."],
    ["Planner", "bubble: Separate topic: the feed order."],
    ["Casey", "bubble: I can help."],
    ["Morning briefRoutine", "bubble: Gate is shut."],
  ]);
  expect(rows().map((element) => element.classList.contains("own"))).toEqual([
    true,
    false,
    false,
    false,
    false,
    false,
  ]);
  // The table is the reply's table, whole, with its own actions.
  expect(row("I will.").querySelector(".markdown-table-scroll table")).not.toBeNull();
  // What sits between and around the messages stays as it was.
  expect(container.querySelector(".group-assignment")!.textContent).toBe(
    "Planner gave this to Ranch hand.",
  );
  expect(row("I can help.").querySelector(".group-thread-context")!.textContent).toBe(
    "In thread with You: Who fixes the gate? @ranch",
  );
  await click("Reply in thread", row("Spare battery"));
  expect(row("Spare battery").classList).toContain("selected");
  expect(container.querySelector(".group-thread strong")!.textContent).toBe("Replying in thread");
});

it("keeps the log layout in Classic, with every message flat", async () => {
  await render("classic");
  expect(container.querySelector(".group-panel")!.classList).not.toContain("group-bubbles");
  expect(container.querySelector(".reply-bubble")).toBeNull();
  expect(layout()).toEqual([
    ["You", "P"],
    ["Ranch hand", "P", "DIV", "P"],
    ["Ranch hand", "P"],
    ["Planner", "P"],
    ["Casey", "P"],
    ["Morning briefRoutine", "P"],
  ]);
  expect(row("Who fixes the gate").classList).toContain("own");
});
