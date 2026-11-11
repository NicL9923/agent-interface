// @vitest-environment jsdom
import { Profiler, createElement, createRef } from "react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bootstrap, Message, ToolCall } from "../src/shared/types";
import type { SavedConversation } from "../src/app/storage";
import { mountRoot, reducedMotionOnly, renderedProps, stubMatchMedia } from "./ui-harness";
import type { Mount } from "./ui-harness";

import { Conversation } from "../src/app/Conversation";

type Props = ComponentProps<typeof Conversation>;
const boot = {
  user: { id: "nic", name: "Nic" },
  preferences: { presentation: "simple" },
  capabilities: { chat: { supported: true }, idempotency: { supported: true }, approvals: { supported: true }, botConfiguration: { supported: true } },
  connection: { detail: "" },
} as unknown as Bootstrap;
const bot = { id: "bot", name: "Ranger", description: "", model: "m", activity: "idle" } as unknown as Props["selected"];

// Each message has its own timestamp, so a count of one stamp is a count of one message's header.
let clock = 0;
const message = (id: string, role: Message["role"], text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role, text, createdAt: new Date(Date.UTC(2026, 9, 25, 10, 0, ++clock)).toISOString(), ...(role === "user" ? { sender: { id: "nic", name: "Nic" } } : {}), ...extra });
const call: ToolCall = { id: "call-1", name: "terminal", status: "running", startedAt: "2026-10-25T10:00:30Z" };
const base: Message[] = [
  message("u1", "user", "first question"),
  message("t1", "assistant", "", { toolCall: call }),
  message("a1", "assistant", "first answer"),
  message("u2", "user", "second question"),
  message("a2", "assistant", "second answer", { reasoning: "thinking about it" }),
  message("u3", "user", "third question"),
  message("a3-inflight", "assistant", "Starting"),
];
const stamps = base.map(item => item.createdAt!);
const finishedStamps = stamps.slice(0, 5);
const replies = ["a1", "a2"];
const live = "a3-inflight";
const page = (messages: Message[], extra: Partial<SavedConversation> = {}) => ({
  botId: "bot", sessionId: "s", messages, toolCalls: [call], approvals: [], attention: [],
  activity: { state: "working" }, ...extra,
}) as unknown as SavedConversation;
const tick = (text: string) => page([...base.slice(0, -1), { ...base.at(-1)!, text }]);

// Counts how often each message's pieces render, from the real components. React keeps the props it last rendered onto each element,
// and that object is new whenever the element's component renders again, so every commit compares them to the last commit's. A Profiler
// takes the sample after each commit, not after each view(), so a turn that renders twice for one update counts twice. A turn that
// bails out renders none of its pieces. A message's row is the element its turn renders for it, so it counts the turn's renders even
// where the memoized Markdown inside it would skip. The ReplyActions this file once replaced no longer exists, so its counts were
// always 0; `.message-meta` is the row that holds a message's time and actions.
const renders = { rows: new Map<string, number>(), actions: new Map<string, number>(), when: new Map<string, number>() };
const seen = new Map<Element, unknown>();
const pieces: [keyof typeof renders, string, (element: Element) => string | undefined][] = [
  ["rows", "article[data-message-id]", element => element.getAttribute("data-message-id") ?? undefined],
  ["actions", "[data-message-id] .message-meta", element => element.closest("[data-message-id]")?.getAttribute("data-message-id") ?? undefined],
  ["when", "time[datetime]", element => element.getAttribute("datetime") ?? undefined],
];
function observe() {
  for (const [kind, selector, key] of pieces) {
    for (const element of mount.container.querySelectorAll(selector)) {
      const id = key(element), props = renderedProps(element);
      if (id !== undefined && seen.get(element) !== props) renders[kind].set(id, (renders[kind].get(id) ?? 0) + 1);
      seen.set(element, props);
    }
  }
}

let mount: Mount;
beforeEach(() => {
  for (const map of Object.values(renders)) map.clear();
  seen.clear();
  // Reduced motion shows a live reply as it arrives, so a streamed update is one render, not a paced run of them.
  stubMatchMedia(reducedMotionOnly);
  mount = mountRoot();
});
const refs = { scroll: createRef<HTMLDivElement>(), endSpace: createRef<HTMLDivElement>() };
async function view(conversation: SavedConversation, props: Partial<Props> = {}) {
  await mount.render(createElement(Profiler, { id: "transcript", onRender: observe }, createElement(Conversation, {
    boot, selected: bot, botId: "bot", conversation, canonical: conversation, ownRows: new Set<string>(), echo: null, state: "working", showActivity: true, avatarState: "working",
    connectionLost: false, offline: false, appUnavailable: false, checkingConnection: false, reconnect: async () => {}, error: "", setError: () => {},
    notifications: { prompt: false } as Props["notifications"], scroll: refs.scroll, endSpace: refs.endSpace,
    content: () => {}, history: { earlier: false, complete: false, atLatest: true } as Props["history"],
    reply: null, onScroll: () => {}, onCreate: () => {}, onDraft: () => 0, ...props,
  } as Props)));
}
const snapshot = () => ({ rows: new Map(renders.rows), actions: new Map(renders.actions), when: new Map(renders.when) });
type Counts = ReturnType<typeof snapshot>;
/** How many more times each of these rendered since `before`. */
const grew = (before: Counts, map: keyof Counts, ids: string[]) => ids.map(id => (renders[map].get(id) ?? 0) - (before[map].get(id) ?? 0));
const unchanged = (ids: string[]) => ids.map(() => 0);
async function mounted(props?: Partial<Props>) {
  await view(page(base), props);
  return snapshot();
}

describe("transcript re-rendering", () => {
  it("re-renders only the live turn while a reply streams", async () => {
    const before = await mounted();
    expect(before.rows.get(live)).toBe(1);
    // Older messages keep their objects, as use-conversation's inflight patches leave them.
    await view(tick("Starting to"));
    await view(tick("Starting to answer"));
    expect(mount.container.textContent).toContain("Starting to answer");
    expect(grew(before, "rows", replies)).toEqual([0, 0]);
    expect(grew(before, "actions", replies)).toEqual([0, 0]);
    expect(grew(before, "when", finishedStamps)).toEqual(unchanged(finishedStamps));
    expect(grew(before, "rows", [live])).toEqual([2]);
  });

  it("re-renders nothing when a full reload returns identical content", async () => {
    const before = await mounted();
    await view(page(structuredClone(base)));
    expect(grew(before, "rows", [...replies, live])).toEqual([0, 0, 0]);
    expect(grew(before, "actions", replies)).toEqual([0, 0]);
    expect(grew(before, "when", stamps)).toEqual(unchanged(stamps));
  });

  it("re-renders a finished turn when what it shows changes", async () => {
    const before = await mounted();
    const edited = structuredClone(base);
    edited[2]!.text = "first answer, corrected";
    await view(page(edited));
    expect(mount.container.textContent).toContain("first answer, corrected");
    expect(grew(before, "rows", replies)).toEqual([1, 0]);
    expect(grew(before, "rows", [live])).toEqual([0]);
  });

  it("re-renders a finished turn when a saved line turns out to be a progress line", async () => {
    const before = await mounted();
    const marked = structuredClone(base);
    marked[2]!.interim = true;
    await view(page(marked));
    expect(mount.container.querySelector(`[data-message-id="a1"]`)!.classList.contains("message-interim")).toBe(true);
    expect(grew(before, "rows", replies)).toEqual([1, 0]);
  });

  it("re-renders the turn whose tool call settles, and no other", async () => {
    const before = await mounted();
    const done: ToolCall = { ...call, status: "completed", completedAt: "2026-10-25T10:01:00Z" };
    const messages = structuredClone(base);
    messages[1]!.toolCall = done;
    await view(page(messages, { toolCalls: [done] }));
    expect(grew(before, "rows", replies)).toEqual([1, 0]);
    expect(grew(before, "rows", [live])).toEqual([0]);
  });

  it("re-renders the latest turn when its run ends", async () => {
    const before = await mounted();
    await view(page(base, { activity: { state: "done" } as SavedConversation["activity"] }), { state: "done", showActivity: false });
    expect(grew(before, "rows", [...replies, live])).toEqual([0, 0, 1]);
  });

  it("re-renders only the turn that holds the message still on its way", async () => {
    const before = await mounted();
    const echo = { request: { requestId: "u3" }, status: "sending" } as unknown as Props["echo"];
    await view(page(base), { echo });
    expect(mount.container.textContent).toContain("Sending…");
    expect(grew(before, "rows", [...replies, live])).toEqual([0, 0, 1]);
  });
});

describe("composer prompt recall during a stream", () => {
  it("keeps one prompts list while only the streaming reply changes", async () => {
    const { useOwnPrompts } = await import("../src/app/Composer");
    const seen: string[][] = [];
    const Probe = ({ messages }: { messages: Message[] }) => { seen.push(useOwnPrompts(messages, "nic") as string[]); return null; };
    await mount.render(createElement(Probe, { messages: base }));
    await mount.render(createElement(Probe, { messages: [...base.slice(0, -1), { ...base.at(-1)!, text: "Starting to answer" }] }));
    expect(seen.at(-1)).toEqual(["third question", "second question", "first question"]);
    expect(seen.at(-1)).toBe(seen[0]);
    await mount.render(createElement(Probe, { messages: [...base, message("u4", "user", "fourth question")] }));
    expect(seen.at(-1)![0]).toBe("fourth question");
  });
});
