// @vitest-environment jsdom
import { Profiler, StrictMode, act, createElement } from "react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { clearResponseCache } from "../src/client-api";
import { ChatHeader } from "../src/app/ChatHeader";
import { defaultPreferences, type Bootstrap, type Conversation, type Inflight, type Message } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot, stubMatchMedia, typeInto } from "./ui-harness";
import type { Mount } from "./ui-harness";

// How much work a keystroke or a streamed delta costs the open chat. The app runs whole, through the real client
// API against a fake server at fetch and a fake event stream, as in live-reply-ui.test.ts.
const headerAvatars = vi.hoisted(() => ({ renders: 0 }));
vi.mock("../src/components/Avatar", async original => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  // Only the chat header draws its avatar at this size, so each render of it is a render of the header.
  Avatar: (props: { size?: number }) => { if (props.size === 42) headerAvatars.renders++; return null; },
}));

const NOW = Date.UTC(2026, 10, 10, 15);
const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: { ...defaultPreferences, startPage: "assistant", defaultBotId: "home" },
  bots: [{ id: "home", name: "Home", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries(["chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration", "tools", "skills",
    "routines", "durableEvents", "idempotency", "stop"].map(key => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "csrf",
};
// Each saved message has a time of its own, so a parse of one is a scan that reached that message.
const asked = "2026-11-10T14:59:00Z", answered = "2026-11-10T14:59:30Z", delivered = "2026-11-10T14:59:55Z";
const question: Message = { id: "u1", role: "user", text: "Is the north gate latched?", sender: { id: "one", name: "One" }, createdAt: asked };
const answer: Message = { id: "a1", role: "assistant", text: "Checking the gate log.", runId: "run-0", createdAt: answered };
const running = { state: "working", runId: "run-1" } as const;
const run = { id: "r1", routineId: "gate", routineName: "Gate check", startedAt: "2026-11-10T14:59:40Z", finishedAt: "2026-11-10T14:59:50Z",
  status: "succeeded", previewOnly: false };
let server: Conversation;
let generation: number;
let unexpected: string[];
let mount: Mount;
let parsed: Map<string, number>;
const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  clearResponseCache();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia(false);
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  // jsdom has no modal dialogs.
  for (const [name, open] of [["showModal", true], ["close", false]] as const) {
    Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value(this: HTMLDialogElement) { this.open = open; } });
  }
  unexpected = [];
  generation = 1;
  headerAvatars.renders = 0;
  server = { botId: "home", messages: [question, answer], approvals: [], files: [], activity: running, version: `boot:0:${generation}` };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, location.origin);
    const call = `${init.method ?? "GET"} ${url.pathname.replace(/^\/api/, "")}`;
    if (call === "GET /bootstrap") return respond(bootstrap);
    if (call === "GET /bots/home/conversation") return respond(server);
    const empty: Record<string, unknown> = {
      "GET /auth/config": { localDevAuth: true },
      "GET /groups": { supported: false, canSend: false, rooms: [], reason: "Not in this test." },
      "GET /usage/accounts": { accounts: [], unavailableBots: [] },
      "GET /mac/devices": { available: false, reason: "Not in this test.", devices: [] },
      "GET /bots/home/draft": null,
      "GET /bots/home/routine-runs": { runs: [run], unavailable: [] },
    };
    if (call in empty) return respond(empty[call]);
    if (/^PUT \/(bots\/[^/]+\/(presence|read-position)|devices\/activity)$/.test(call)) return respond({});
    unexpected.push(call);
    throw new TypeError(`Unexpected request ${call}`);
  }));
  // Counts what each scan of the transcript reads: both the newest-message time and the delivered-run match parse each
  // saved message's time. The call still goes through.
  parsed = new Map();
  const real = Date.parse;
  vi.spyOn(Date, "parse").mockImplementation(value => { parsed.set(value, (parsed.get(value) ?? 0) + 1); return real(value); });
  mount = mountRoot();
});
afterEach(() => { expect(unexpected).toEqual([]); });

const stream = () => [...FakeEventSource.streams].find(item => item.url.startsWith("/api/bots/home/events"))!;
let commits = 0;
const app = () => createElement(Profiler, { id: "app", onRender: () => { commits++; } }, createElement(App));
async function open(strict = false) {
  history.replaceState(null, "", "/?bot=home");
  await act(async () => mount.root.render(strict ? createElement(StrictMode, null, app()) : app()));
  await advance(0);
  await act(async () => stream().connect());
  await advance(0);
}
const live = (text: string): Inflight => ({ botId: "home", message: { id: "s1-inflight", role: "assistant", text }, activity: running, toolCalls: [] });
const delta = (text: string) => act(async () => stream().emit("inflight", JSON.stringify(live(text))));
// The answer opens no turn, so placing the runs among the turns does not parse it: only the two scans do.
const scans = () => parsed.get(answered) ?? 0;
const composer = () => mount.container.querySelector<HTMLTextAreaElement>("textarea")!;

describe("work per keystroke in the open chat", () => {
  const keys = ["g", "ga", "gat", "gate", "gate?"];
  it("does not render the chat header again", async () => {
    await open();
    expect(headerAvatars.renders).toBeGreaterThan(0);
    const header = headerAvatars.renders;
    commits = 0;
    for (const text of keys) await typeInto(composer(), text);
    expect(composer().value).toBe("gate?");
    // One commit for each keystroke: nothing it renders sets state in turn.
    expect(commits).toBe(keys.length);
    // The draft is App's state, so each keystroke renders App; the header's props did not change.
    expect(headerAvatars.renders - header).toBe(0);
  });

  it("does not scan the saved messages again", async () => {
    await open();
    await advance(60);
    const before = scans();
    for (const text of keys) await typeInto(composer(), text);
    expect(scans() - before).toBe(0);
  });

  it("still opens the assistant's details from the header after the draft changed", async () => {
    await open();
    await typeInto(composer(), "gate?");
    await act(async () => mount.container.querySelector<HTMLButtonElement>(".chat-header .chat-identity")!.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    await advance(50);
    // The sheet for this assistant opened, and the draft is still in the composer under it.
    expect(document.querySelector("dialog.bot-details[open]")).not.toBeNull();
    expect(composer().value).toBe("gate?");
  });
});

describe("work per streamed delta in the open chat", () => {
  it("does not scan the saved messages again for a delta that changes only the live reply", async () => {
    await open();
    await delta("The north gate");
    const before = scans();
    for (const text of ["The north gate is", "The north gate is latched", "The north gate is latched, and the chain is through"]) await delta(text);
    expect(scans() - before).toBe(0);
  });

  it("scans again when a message is saved, and the delivered run leaves the transcript with it", async () => {
    await open();
    await advance(60);
    expect(mount.container.querySelector('[data-run-id="r1"]')).not.toBeNull();
    await delta("The north gate");
    const before = scans();
    // The brief's own delivery lands in the chat, so its run is no longer drawn on its own.
    generation++;
    server = { ...server, version: `boot:0:${generation}`, messages: [question, answer,
      { id: "d1", role: "user", text: "[Cron delivery: Gate check]\nAll latched.", createdAt: delivered }] };
    await act(async () => stream().emit("message", "change"));
    await advance(60);
    expect(scans() - before).toBeGreaterThan(0);
    expect(mount.container.querySelector('[data-run-id="r1"]')).toBeNull();
    expect(mount.container.querySelector('[data-message-id="d1"]')).not.toBeNull();
  });

  it("does the same under StrictMode, which renders and runs effects twice", async () => {
    await open(true);
    await delta("The north gate");
    const before = scans();
    await delta("The north gate is latched");
    expect(scans() - before).toBe(0);
  });
});

describe("the chat header's renders", () => {
  const props = (extra: Partial<ComponentProps<typeof ChatHeader>> = {}): ComponentProps<typeof ChatHeader> => ({
    view: "conversation", boot: { preferences: { presentation: "simple" } } as Bootstrap, selected: bootstrap.bots[0], avatarState: "idle",
    railOpen: false, onOpenRail: () => {}, onDetails: () => {}, onModelSaved: () => {}, ...extra,
  });
  const stable = props();
  const draw = (next: ComponentProps<typeof ChatHeader>) => mount.render(createElement(ChatHeader, next));

  it("does not render again for a parent render with the same props", async () => {
    await draw(stable);
    expect(headerAvatars.renders).toBe(1);
    await draw({ ...stable });
    await draw({ ...stable });
    expect(headerAvatars.renders).toBe(1);
  });

  it.each<[string, Partial<ComponentProps<typeof ChatHeader>>]>([
    ["the assistant is working", { avatarState: "working" }],
    ["the rail opens", { railOpen: true }],
    ["a callback is replaced", { onDetails: () => {} }],
  ])("renders again when %s", async (_, change) => {
    await draw(stable);
    await draw({ ...stable, ...change });
    expect(headerAvatars.renders).toBe(2);
  });
});
