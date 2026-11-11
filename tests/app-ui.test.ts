// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { preloadBotMenu } from "../src/app/BotMenu";
import { api, ApiError, uploadFile, write } from "../src/client-api";
import { useChatPresence } from "../src/app/use-chat-presence";
import { defaultPreferences } from "../src/shared/types";
import type { Bootstrap, Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { clearDecline } from "../src/app/decline-handoff";
import { contentHash } from "../src/app/draft-merge";
import { DISCONNECT_GRACE_MS } from "../src/app/use-conversation";
import { advance, mountRoot, stubMatchMedia, typeInto } from "./ui-harness";

vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest(await (async (original) => ({
  ...await original<typeof import("../src/client-api")>(),
  api: vi.fn(),
  write: vi.fn().mockResolvedValue({}),
  uploadFile: vi.fn(),
  clearResponseCache: vi.fn(),
}))(original)));
const renders = vi.hoisted(() => ({ avatar: 0, markdown: 0 }));
// SVG geometry and animation are browser concerns, not part of these state regressions.
// Presence heartbeats would interleave with the writes these tests count; they have their own tests.
vi.mock("../src/app/use-chat-presence", () => ({ useChatPresence: vi.fn() }));
// Covered by device-activity-ui.test.ts; here its heartbeats would interleave with the writes under test.
vi.mock("../src/app/use-device-activity", () => ({ useDeviceActivity: vi.fn() }));
vi.mock("../src/components/Avatar", async (original) => ({
  ...await original<typeof import("../src/components/Avatar")>(),
  Avatar: (props: { state?: string; size?: number; prop?: string; reducedMotion?: boolean }) => (renders.avatar++, createElement("span", {
    "data-avatar-state": props.state, "data-avatar-size": props.size, "data-avatar-prop": props.prop, "data-avatar-still": props.reducedMotion ? "" : undefined,
  })),
}));
// Unmemoized on purpose, so the count shows whether the transcript re-renders.
vi.mock("../src/components/MessageMarkdown", () => {
  const markdown = (props: { text: string }) => (renders.markdown++, createElement("div", { className: "message-markdown" }, props.text));
  return { MessageMarkdown: markdown, ReplyMarkdown: markdown };
});

const bootstrap: Bootstrap = {
  user: { id: "one", name: "One", email: "one@example.test" },
  household: [],
  preferences: {...defaultPreferences,startPage:"assistant"},
  bots: [{ id: "shared", name: "Shared", shared: true, model: "test", activity: "idle" }],
  capabilities: Object.fromEntries([
    "chat", "steering", "approvals", "uploads", "generatedFiles", "botConfiguration",
    "tools", "skills", "routines", "durableEvents", "idempotency", "imageGeneration",
    "stop", "portraitGeneration", "avatarMetadata",
  ].map((key) => [key, { supported: true }])) as Bootstrap["capabilities"],
  connection: { connected: true },
  csrfToken: "test",
};
const savedDraft = { text: "My saved server draft", attachments: [] };
let conversation: Conversation;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // A decline in one test would otherwise still be waiting for the next message in the next.
  clearDecline("shared");
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  stubMatchMedia();
  history.replaceState(null, "", "/");
  conversation = {
    botId: "shared", messages: [], approvals: [], files: [],
    activity: { state: "interrupted", runId: "old-run" },
  };
  vi.mocked(api).mockImplementation(async <T>(path: string) => {
    const result = path === "/bootstrap?roster=lean" ? bootstrap
      : path === "/bots/shared/draft" ? savedDraft
      : path.startsWith("/bots/shared/conversation?") ? conversation
      : null;
    return result as T;
  });
  ({ container, root } = mountRoot());
});

async function render() {
  await act(async () => root.render(createElement(App)));
}

/** The server reports a change, as Hermes frames or a write would. */
async function changed() {
  await act(async () => FakeEventSource.notifyAll());
  await advance(1500);
}

// Screens such as preferences load on first use.
async function loaded() {
  await act(async () => { await vi.dynamicImportSettled(); });
}

const reviewCheckbox = () => container.querySelector<HTMLInputElement>(".interruption-review input")!;
const sendButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;

describe("conversation state", () => {
  it("sends a custom answer to a question with suggestions and keeps it after a failure", async () => {
    conversation.attention = [{ id: "ask", kind: "clarify", title: "Pick a plan", detail: "Choose or write a plan.", questions: [
      { id: "plan", prompt: "Which plan?", options: ["First", "Write my own answer"] },
      { id: "note", prompt: "Any details?" },
    ] }];
    await render();
    const options = () => [...container.querySelectorAll<HTMLInputElement>('.approval-card [data-question="0"] input[type="radio"]')];
    const submit = container.querySelector<HTMLButtonElement>('.approval-card button[type="submit"]')!;
    expect(container.querySelector(".approval-card")?.getAttribute("data-attention-id")).toBe("ask");
    expect(options().map(option => option.closest("label")?.querySelector(".option-label")?.textContent)).toEqual(["First", "Write my own answer", "Write my own answer"]);
    expect(submit.disabled).toBe(true);
    await act(async () => options()[2].click());
    const custom = container.querySelector<HTMLInputElement>('[aria-label="Your answer: Which plan?"]')!;
    await typeInto(custom, "   ");
    await typeInto(container.querySelector<HTMLInputElement>('[aria-label="Any details?"]')!, "Keep the draft");
    expect(submit.disabled).toBe(true);
    await typeInto(custom, "A different plan");
    vi.mocked(write).mockRejectedValueOnce(new Error("Try again"));
    await act(async () => submit.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/requests/ask", { answers: { plan: "A different plan", note: "Keep the draft" }, answerFormat: "json" });
    expect(custom.value).toBe("A different plan");
    // An option that happens to read "Write my own answer" is still an option, not the field.
    await act(async () => options()[1].click());
    expect(container.querySelector('[aria-label="Your answer: Which plan?"]')).toBeNull();
    await act(async () => submit.click());
    expect(write).toHaveBeenLastCalledWith("/bots/shared/requests/ask", { answers: { plan: "Write my own answer", note: "Keep the draft" }, answerFormat: "json" });
  });

  it("reopens a refused household stream at the fallback interval", async () => {
    await render();
    const stream=[...FakeEventSource.streams].find(stream=>stream.url==="/api/events?ping=10")!;
    await act(async()=>stream.fail());
    await advance(45_000);
    expect(FakeEventSource.created.filter(url=>url==="/api/events?ping=10")).toHaveLength(2);
  });
  it("refreshes bootstrap on a household roster notice", async () => {
    await render();
    const reads=()=>vi.mocked(api).mock.calls.filter(([path])=>path==="/bootstrap?roster=lean").length;
    const before=reads();
    await act(async()=>{for(const stream of FakeEventSource.streams)if(stream.url==="/api/events?ping=10")stream.emit("roster","roster");});
    expect(reads()).toBe(before+1);
  });
  it("patches an inflight reply without fetching the transcript", async () => {
    conversation = {...conversation, activity:{state:"thinking",runId:"run"},messages:[{id:"u",role:"user",text:"Hello"}]};
    await render();
    const reads = vi.mocked(api).mock.calls.length;
    await act(async () => {
      for (const stream of FakeEventSource.streams) if (stream.url.includes("inflight=3")) stream.emit("inflight", JSON.stringify({botId:"shared",message:{id:"sid-inflight",role:"assistant",text:"Growing reply"},activity:{state:"thinking",runId:"run"},toolCalls:[]}));
    });
    expect(container.textContent).toContain("Growing reply");
    expect(vi.mocked(api).mock.calls).toHaveLength(reads);
  });
  describe("inflight growth notices", () => {
    const run = { state: "thinking" as const, runId: "run" };
    const open = () => [...FakeEventSource.streams].find(stream => stream.url.includes("inflight=3"))!;
    const reads = () => vi.mocked(api).mock.calls.filter(([path]) => String(path).startsWith("/bots/shared/conversation?")).length;
    const whole = (text: string) => JSON.stringify({ botId: "shared", message: { id: "sid-inflight", role: "assistant", text }, activity: run, toolCalls: [] });
    const growth = (changes: object) => JSON.stringify({ botId: "shared", messageId: "sid-inflight", baseTextLength: 7, baseReasoningLength: 0, activity: run, ...changes });
    it("opts in to growth notices and applies one that continues the reply it holds", async () => {
      conversation = { ...conversation, activity: run, messages: [{ id: "u", role: "user", text: "Hello" }] };
      await render();
      expect(FakeEventSource.created).toContain("/api/bots/shared/events?inflight=3&drafts=1&ping=10");
      await act(async () => open().emit("inflight", whole("Growing")));
      const before = vi.mocked(api).mock.calls.length;
      await act(async () => open().emit("inflight-delta", growth({ appendText: " reply" })));
      expect(container.textContent).toContain("Growing reply");
      await act(async () => open().emit("inflight-delta", growth({ baseTextLength: 13, appendText: " grows" })));
      expect(container.textContent).toContain("Growing reply grows");
      expect(vi.mocked(api).mock.calls).toHaveLength(before);
    });
    it.each([
      ["another message", { messageId: "other-inflight", appendText: "!" }],
      ["a base it does not hold", { baseTextLength: 3, appendText: "!" }],
    ])("reloads and reconnects instead of applying growth of %s", async (_name, change) => {
      conversation = { ...conversation, activity: run, messages: [{ id: "u", role: "user", text: "Hello" }] };
      await render();
      await act(async () => open().emit("inflight", whole("Growing")));
      const before = reads(), streams = FakeEventSource.created.length;
      await act(async () => open().emit("inflight-delta", growth(change)));
      await advance(0);
      expect(container.textContent).not.toContain("Growing!");
      expect(reads()).toBeGreaterThan(before);
      // A new stream starts the server again from a whole event.
      expect(FakeEventSource.created.length).toBe(streams + 1);
    });
    it("reloads when there is no reply held to grow", async () => {
      conversation = { ...conversation, activity: run, messages: [{ id: "u", role: "user", text: "Hello" }] };
      await render();
      const before = reads();
      await act(async () => open().emit("inflight-delta", growth({ appendText: " reply" })));
      await advance(0);
      expect(reads()).toBeGreaterThan(before);
    });
  });
  describe("turn events", () => {
    const run = { state: "thinking" as const, runId: "run-2" };
    const open = () => [...FakeEventSource.streams].find(stream => stream.url.includes("inflight=3"))!;
    const reads = () => vi.mocked(api).mock.calls.filter(([path]) => String(path).startsWith("/bots/shared/conversation?")).length;
    const prompt = { id: "req-2", role: "user" as const, text: "Check the barn" };
    const earlier = [{ id: "u1", role: "user" as const, text: "Fence?" }, { id: "a1", role: "assistant" as const, text: "Fixed." }];
    const saved = { id: "4", role: "assistant" as const, text: "Looking in the barn." };
    const turn = (version: string, messages: object[], text: string, extra: object = {}) => JSON.stringify({ botId: "shared", version, messages,
      message: { id: "sid-inflight", role: "assistant", text }, activity: run, toolCalls: [], ...extra });
    const growth = (base: number, appendText: string) => JSON.stringify({ botId: "shared", messageId: "sid-inflight", baseTextLength: base, baseReasoningLength: 0, appendText, activity: run });
    const count = (text: string) => container.textContent!.split(text).length - 1;
    async function opened() {
      conversation = { ...conversation, activity: run, messages: [...earlier, prompt], version: "b:1:5" };
      await render();
      await act(async () => open().emit("turn", turn("b:1:6", [prompt, saved], "Found")));
    }
    it("shows a saved segment and the live reply from one event, without a read, and grows the reply", async () => {
      await opened();
      const before = reads();
      expect(count("Looking in the barn.")).toBe(1);
      expect(container.textContent).toContain("Found");
      await act(async () => open().emit("inflight-delta", growth(5, " it.")));
      expect(container.textContent).toContain("Found it.");
      expect(reads()).toBe(before);
    });
    it("puts the turn back on top of a read that set out before it", async () => {
      await opened();
      // The read began before Hermes saved the segment: it still holds that text as its own live tail.
      conversation = { ...conversation, version: "b:1:5", messages: [...earlier, prompt, { id: "sid-inflight", role: "assistant", text: "Looking in the barn. Fou" }] };
      await changed();
      // Once: the read's own live tail, which repeats the saved segment, is not shown beside the turn.
      expect(count("Looking in the barn.")).toBe(1);
      expect(container.textContent).toContain("Found");
    });
    it("lets a newer read stand, and shows no live reply built on an older one until its own turn arrives", async () => {
      await opened();
      conversation = { ...conversation, version: "b:1:7", messages: [...earlier, prompt, saved, { id: "5", role: "assistant", text: "Found the leak." },
        { id: "sid-inflight", role: "assistant", text: "Checking the gate" }] };
      await changed();
      await act(async () => open().emit("inflight-delta", growth(5, " stale")));
      expect(container.textContent).toContain("Found the leak.");
      expect(container.textContent).toContain("Checking the gate");
      expect(container.textContent).not.toContain("Found stale");
      await act(async () => open().emit("turn", turn("b:1:7", [prompt, saved, { id: "5", role: "assistant", text: "Found the leak." }], "Checking the gate and fence")));
      expect(container.textContent).toContain("Checking the gate and fence");
      expect(count("Found the leak.")).toBe(1);
    });
    it("never brings back a reply a newer read already finished", async () => {
      await opened();
      conversation = { ...conversation, activity: { state: "done", runId: "run-2" }, version: "b:1:9", messages: [...earlier, prompt, saved, { id: "5", role: "assistant", text: "All done." }] };
      await changed();
      await act(async () => open().emit("turn", turn("b:1:8", [prompt, saved], "stale tail")));
      expect(container.textContent).toContain("All done.");
      expect(container.textContent).not.toContain("stale tail");
    });
    it("reads the conversation for a turn it cannot place", async () => {
      await opened();
      const before = reads();
      await act(async () => open().emit("turn", turn("b:1:7", [{ id: "u9", role: "user", text: "Elsewhere" }], "Lost")));
      await advance(0);
      expect(reads()).toBeGreaterThan(before);
      expect(container.textContent).not.toContain("Lost");
    });
    describe("across a server restart", () => {
      // Boot "a" served the transcript on screen; the server restarted as boot "z".
      const tail = { id: "sid-inflight", role: "assistant" as const, text: "Looking in the barn. Fou" };
      const bootA = (): Conversation => ({ ...conversation, activity: run, version: "a:1:5", messages: [...earlier, prompt, tail] });
      const at = (version: string, text: string, extra: Partial<Conversation> = {}): Conversation =>
        ({ ...conversation, activity: run, version, messages: [...earlier, prompt, saved, { id: "sid-inflight", role: "assistant", text }], ...extra });
      /** Holds the next conversation read until the test answers it, as a slow read begun before the restart. */
      function holdNextRead() {
        let answer!: (value: Conversation) => void;
        const serve = vi.mocked(api).getMockImplementation()!;
        let held = false;
        vi.mocked(api).mockImplementation(async <T,>(path: string, ...rest: unknown[]) => {
          if (held || !path.startsWith("/bots/shared/conversation?")) return (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest);
          held = true;
          return await new Promise<Conversation>(resolve => { answer = resolve; }) as T;
        });
        return async (value: Conversation) => { await act(async () => answer(value)); await advance(0); };
      }
      /** Fails the next conversation read, as a server between processes does. */
      function failNextRead() {
        const serve = vi.mocked(api).getMockImplementation()!;
        let failed = false;
        vi.mocked(api).mockImplementation(async <T,>(path: string, ...rest: unknown[]) => {
          if (failed || !path.startsWith("/bots/shared/conversation?")) return (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest);
          failed = true;
          throw new Error("Hermes is restarting.");
        });
      }
      /** Answers at most `limit` more conversation reads and holds the rest, so a read loop shows as a count instead of hanging. */
      function limitReads(limit: number) {
        const serve = vi.mocked(api).getMockImplementation()!;
        let left = limit;
        vi.mocked(api).mockImplementation(async <T,>(path: string, ...rest: unknown[]) => {
          if (!path.startsWith("/bots/shared/conversation?")) return (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest);
          if (left-- <= 0) return await new Promise<T>(() => {});
          return (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest);
        });
      }
      // A read loop shows as a count against this limit instead of exhausting the worker.
      beforeEach(() => limitReads(60));
      async function restartedMidRead() {
        conversation = bootA();
        await render();
        const answer = holdNextRead();
        await act(async () => FakeEventSource.notifyAll());
        await advance(0);
        return answer;
      }
      const stop = () => container.querySelector('[aria-label="Stop response"]');
      // Round 1's first order: a read the old boot answered lands after the new boot's turn.
      it("keeps the newer boot's saved segment and growth when a read from the old boot lands after its turn", async () => {
        const answer = await restartedMidRead();
        await act(async () => open().emit("turn", turn("z:1:2", [prompt, saved], "Found")));
        // Never put on the old boot's transcript: it waits for a read from its own boot.
        expect(container.textContent).not.toContain("Found");
        conversation = at("z:1:2", "Found");
        await answer(bootA());
        await act(async () => open().emit("inflight-delta", growth(5, " it.")));
        expect(count("Looking in the barn.")).toBe(1);
        expect(container.textContent).not.toContain("barn. Fou");
        expect(container.textContent).toContain("Found it.");
        // A turn from another boot than the view's never decides it: one read does, here answered by "z".
        conversation = at("z:1:2", "Found it.");
        const before = reads();
        await act(async () => open().emit("turn", turn("a:1:9", [prompt], "Old boot")));
        await advance(0);
        expect(reads()).toBe(before + 1);
        expect(container.textContent).not.toContain("Old boot");
        expect(container.textContent).toContain("Found it.");
      });
      // Round 1's second order: the new boot finished the reply before the old boot's read landed.
      it("never returns a reply the newer boot finished to thinking when a read from the old boot lands after it", async () => {
        const answer = await restartedMidRead();
        const finished = { id: "5", role: "assistant" as const, text: "All done." };
        const done = { state: "done" as const, runId: "run-2" };
        await act(async () => open().emit("turn", turn("z:1:3", [prompt, saved, finished], "", { activity: done })));
        conversation = { ...conversation, version: "z:1:3", activity: done, messages: [...earlier, prompt, saved, finished] };
        await answer(bootA());
        expect(container.textContent).toContain("All done.");
        expect(container.textContent).not.toContain("barn. Fou");
        expect(stop()).toBeNull();
      });
      it("drops the first read when a newer boot's turn asked for another before it was answered", async () => {
        const answer = holdNextRead();
        conversation = bootA();
        await render();
        await act(async () => open().emit("turn", turn("z:1:2", [prompt, saved], "Found")));
        conversation = at("z:1:2", "Found");
        await answer(bootA());
        expect(count("Looking in the barn.")).toBe(1);
        expect(container.textContent).not.toContain("barn. Fou");
        expect(container.textContent).toContain("Found");
      });
      it("takes the newest read as it is, whichever boot answers it, with one read for each change", async () => {
        conversation = bootA();
        await render();
        conversation = at("z:1:1", "Found");
        const before = reads();
        await changed();
        expect(reads()).toBe(before + 1);
        expect(container.textContent).toContain("Found");
        expect(container.textContent).not.toContain("barn. Fou");
        // Answered by "a" again, as by a second process behind one address: still the newest read asked, so it shows.
        conversation = bootA();
        await changed();
        expect(reads()).toBe(before + 2);
        expect(container.textContent).toContain("barn. Fou");
      });
      // The reviewer's order: the view follows "a", boot "b" opens the stream, a read from boot "c" lands, then b's first turn.
      it("keeps the boot of the newest read when an earlier boot's buffered turn arrives after it, and goes on reading it once per change", async () => {
        conversation = bootA();
        await render();
        conversation = at("c:1:4", "Found");
        await changed();
        const before = reads();
        await act(async () => open().emit("turn", turn("b:1:2", [prompt], "From b")));
        await advance(0);
        expect(reads()).toBe(before + 1);
        expect(container.textContent).not.toContain("From b");
        expect(container.textContent).toContain("Found");
        // Boot "c" goes on: its turn events and reads are taken, each read once.
        await act(async () => open().emit("turn", turn("c:1:5", [prompt, saved], "Found it")));
        expect(container.textContent).toContain("Found it");
        conversation = at("c:1:6", "Checking the gate", { messages: [...earlier, prompt, saved, { id: "5", role: "assistant", text: "Found the leak." },
          { id: "sid-inflight", role: "assistant", text: "Checking the gate" }] });
        await changed();
        expect(container.textContent).toContain("Found the leak.");
        await act(async () => open().emit("turn", turn("c:1:7", [prompt, saved, { id: "5", role: "assistant", text: "Found the leak." }], "Checking the gate and fence")));
        expect(container.textContent).toContain("Checking the gate and fence");
        expect(reads()).toBe(before + 2);
      });
      it("reads once per change and once per other-boot turn while two boots answer in turn, for ten rounds", async () => {
        conversation = bootA();
        await render();
        const before = reads();
        for (let round = 0; round < 10; round++) {
          const [answering, streaming] = round % 2 ? ["a", "z"] : ["z", "a"];
          conversation = at(`${answering}:1:${10 + round}`, `Round ${round}`);
          await changed();
          expect(container.textContent).toContain(`Round ${round}`);
          // The other process's stream delivers a turn: it asks one read, which the first process answers, so the turn is dropped.
          await act(async () => open().emit("turn", turn(`${streaming}:1:${30 + round}`, [prompt, saved], `Turn ${round}`)));
          await advance(0);
          expect(container.textContent).not.toContain(`Turn ${round}`);
        }
        await advance(5000);
        expect(reads()).toBe(before + 20);
      });
      it("keeps a turn whose read failed for the next read, without reading again for it", async () => {
        conversation = bootA();
        await render();
        failNextRead();
        const before = reads();
        await act(async () => open().emit("turn", turn("z:1:2", [prompt, saved], "Found")));
        await advance(0);
        // Another turn from that boot shares the read already asked.
        await act(async () => open().emit("turn", turn("z:1:3", [prompt, saved], "Found it")));
        await advance(5000);
        expect(reads()).toBe(before + 1);
        expect(container.textContent).not.toContain("Found");
        expect(container.textContent).toContain("barn. Fou");
        // The next read, from the turn's boot and older than it, takes the turn on top.
        conversation = at("z:1:1", "Looking in the");
        await changed();
        expect(reads()).toBe(before + 2);
        expect(count("Looking in the barn.")).toBe(1);
        expect(container.textContent).toContain("Found it");
      });
      /** Holds every conversation read from now on; each call answers the oldest one still held. */
      function holdReads() {
        const waiting: ((value: Conversation) => void)[] = [];
        const serve = vi.mocked(api).getMockImplementation()!;
        vi.mocked(api).mockImplementation(async <T,>(path: string, ...rest: unknown[]) => !path.startsWith("/bots/shared/conversation?")
          ? (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest)
          : await new Promise<Conversation>(resolve => waiting.push(resolve)) as T);
        return { held: () => waiting.length, answer: async (value: Conversation) => { await act(async () => waiting.shift()!(value)); await advance(0); } };
      }
      it("takes an older read from the view's boot, and drops one from another boot once a newer read is asked", async () => {
        conversation = at("z:1:4", "Found");
        await render();
        const reads = holdReads();
        await act(async () => FakeEventSource.notifyAll());
        await advance(0);
        // A second change while the first read is on its way: one more read, asked.
        await changed();
        expect(reads.held()).toBe(1);
        await reads.answer(at("z:1:5", "Found it"));
        expect(container.textContent).toContain("Found it");
        expect(reads.held()).toBe(1);
        await changed();
        // Another process answered the older read: dropped, and the read asked since is the one that decides.
        await reads.answer(bootA());
        expect(container.textContent).not.toContain("barn. Fou");
        expect(container.textContent).toContain("Found it");
        expect(reads.held()).toBe(1);
        await reads.answer(at("z:1:6", "Found it."));
        expect(container.textContent).toContain("Found it.");
        expect(reads.held()).toBe(0);
      });
      it("puts a new boot's turn on the first read of its boot asked after it, even when an older read lands first", async () => {
        conversation = bootA();
        await render();
        const reads = holdReads();
        await act(async () => FakeEventSource.notifyAll());
        await advance(0);
        await act(async () => open().emit("turn", turn("z:1:3", [prompt, saved], "Found it")));
        // The read asked before the turn, answered by the view's own boot: taken, and the turn still waits.
        await reads.answer(bootA());
        expect(container.textContent).toContain("barn. Fou");
        expect(container.textContent).not.toContain("Found it");
        // Its own read, from its boot and older than it: the turn goes on top.
        await reads.answer(at("z:1:2", "Found"));
        expect(count("Looking in the barn.")).toBe(1);
        expect(container.textContent).toContain("Found it");
        expect(reads.held()).toBe(0);
      });
      // A turn from another boot waits for a read while a turn from the view's boot arrives and shows. Resolving the waiting
      // turn never replaces or drops a held turn from the boot the read confirms, and the live reply follows that boot.
      it.each([
        // The reviewer's order: the read confirms the view's boot, whose newer turn already shows.
        { name: "the read confirms the view's boot", first: "b", read: "a", shows: "A current", gone: ["B current", "A old"] },
        // The mirror: the read confirms the other boot, whose waiting turn goes on top with its own live reply.
        { name: "the read confirms the waiting turn's boot", first: "b", read: "b", shows: "B current", gone: ["A current", "A old"] },
        // The view's turn arrived first, so the last live reply heard is the waiting turn's.
        { name: "the view's turn came first and the read confirms its boot", first: "a", read: "a", shows: "A current", gone: ["B current", "A old"] },
      ])("keeps the turn of the boot a read confirms when $name", async ({ first, read, shows, gone }) => {
        conversation = at("a:1:9", "A old");
        await render();
        const answer = holdNextRead();
        const events = { a: turn("a:1:10", [prompt, saved], "A current"), b: turn("b:1:10", [prompt, saved], "B current") };
        for (const boot of first === "b" ? ["b", "a"] as const : ["a", "b"] as const) {
          await act(async () => open().emit("turn", events[boot]));
          await advance(0);
        }
        expect(container.textContent).toContain("A current");
        const before = reads();
        await answer(read === "a" ? at("a:1:9", "A old") : at("b:1:9", "B old"));
        expect(container.textContent).toContain(shows);
        for (const text of gone) expect(container.textContent).not.toContain(text);
        // Growth of the turn shown goes on showing, with no read for it.
        await act(async () => open().emit("inflight-delta", growth(shows.length, " and more")));
        expect(container.textContent).toContain(`${shows} and more`);
        await advance(5000);
        expect(reads()).toBe(before);
      });
      // Growth extends the turn it continues wherever that turn is kept, held or waiting, so settling restores the grown reply.
      it.each([
        // The reviewer's order: the view's turn grew before the other boot's turn arrived, and the read confirms the view's boot.
        { name: "a held turn grew and the read confirms its boot", order: ["a", "grow", "b"], read: "a", shows: "A current and more", gone: "B current" },
        // The mirror: the waiting turn grew before the view's turn arrived, and the read confirms the waiting turn's boot.
        { name: "a waiting turn grew and the read confirms its boot", order: ["b", "grow", "a"], read: "b", shows: "B current and more", gone: "A current" },
        // Growth after both arrived extends only the last turn heard, never the other one kept beside it.
        { name: "the waiting turn grew last and the read confirms the held turn's boot", order: ["a", "b", "grow"], read: "a", shows: "A current", gone: "and more" },
        { name: "the held turn grew last and the read confirms the waiting turn's boot", order: ["b", "a", "grow"], read: "b", shows: "B current", gone: "and more" },
      ])("keeps each turn's own growth when $name", async ({ order, read, shows, gone }) => {
        conversation = at("a:1:9", "A old");
        await render();
        const answer = holdNextRead();
        const events = { a: turn("a:1:10", [prompt, saved], "A current"), b: turn("b:1:10", [prompt, saved], "B current") };
        for (const step of order) {
          await act(async () => open().emit(step === "grow" ? "inflight-delta" : "turn", step === "grow" ? growth(9, " and more") : events[step as "a" | "b"]));
          await advance(0);
        }
        const before = reads();
        await answer(read === "a" ? at("a:1:9", "A old") : at("b:1:9", "B old"));
        expect(container.textContent).toContain(shows);
        expect(container.textContent).not.toContain(gone);
        // Further growth continues the restored reply, with no read for it.
        await act(async () => open().emit("inflight-delta", growth(shows.length, ", still")));
        expect(container.textContent).toContain(`${shows}, still`);
        await advance(5000);
        expect(reads()).toBe(before);
      });
      // The read asked for a turn from another boot can be older than the turn and hold neither its first message nor `after`,
      // as when it joins the first page's prefetch that set out before. One more read, asked after the turn, places it.
      it("reads once more for another boot's turn that the first read of its boot cannot place", async () => {
        conversation = bootA();
        await render();
        const answer = holdNextRead();
        const before = reads();
        const gate = { id: "u9", role: "user" as const, text: "And the gate" };
        await act(async () => open().emit("turn", turn("z:1:3", [gate], "Gate shut")));
        await advance(0);
        conversation = { ...at("z:1:4", "Gate shut."), messages: [...earlier, prompt, saved, gate, { id: "sid-inflight", role: "assistant", text: "Gate shut." }] };
        await answer(at("z:1:2", "Found"));
        expect(reads()).toBe(before + 2);
        expect(container.textContent).toContain("Gate shut.");
        await advance(5000);
        expect(reads()).toBe(before + 2);
      });
      it("leaves a held turn behind when the person switches chats", async () => {
        const other = { ...bootstrap.bots[0], id: "other", name: "Other" };
        bootstrap.bots.push(other);
        try {
          const serve = vi.mocked(api).getMockImplementation()!;
          vi.mocked(api).mockImplementation(async <T,>(path: string, ...rest: unknown[]) => path.startsWith("/bots/other/conversation?")
            ? { ...conversation, botId: "other", activity: { state: "idle" }, version: "z:1:9", messages: [{ id: "o1", role: "assistant", text: "Other chat" }] } as T
            : (serve as (path: string, ...rest: unknown[]) => Promise<T>)(path, ...rest));
          conversation = bootA();
          await render();
          const answer = holdNextRead();
          await act(async () => open().emit("turn", turn("z:1:2", [prompt, saved], "Found")));
          await advance(0);
          await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes("Other"))!.click());
          await advance(0);
          conversation = at("z:1:1", "Looking in the");
          await answer(conversation);
          expect(container.textContent).toContain("Other chat");
          expect(container.textContent).not.toContain("Found");
          // Back in the first chat, its own read shows as it is: the turn held before the switch is gone with that view.
          const before = reads();
          await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes("Shared"))!.click());
          await advance(0);
          expect(reads()).toBe(before + 1);
          expect(container.textContent).toContain("Looking in the");
          expect(container.textContent).not.toContain("Found");
        } finally { bootstrap.bots.pop(); }
      });
    });
  });
  it.each(["done", "new-run"])("does not reapply an old live tail over a %s fetch", async mode => {
    conversation = { ...conversation, activity: { state: "thinking", runId: "run" }, messages: [] };
    await render();
    await act(async () => {
      for (const stream of FakeEventSource.streams) if (stream.url.includes("inflight=3")) stream.emit("inflight", JSON.stringify({ botId: "shared", message: { id: "sid-inflight", role: "assistant", text: "Old tail" }, activity: { state: "thinking", runId: "run" }, toolCalls: [] }));
    });
    expect(container.textContent).toContain("Old tail");
    conversation = { ...conversation, activity: { state: mode === "done" ? "done" : "thinking", runId: mode === "done" ? "run" : "next-run" }, messages: [{ id: "saved", role: "assistant", text: "Persisted reply" }] };
    await act(async () => FakeEventSource.notifyAll());
    await advance(1500);
    expect(container.textContent).not.toContain("Old tail");
    expect(container.textContent).toContain("Persisted reply");
  });
  it("preserves a pending secure form across polling while keeping credentials out of the chat draft", async () => {
    const secure = { method: "vault.save_login" as const, epoch: "current", sessionId: "session", origin: "https://example.invalid", site: "Example" };
    conversation = { ...conversation, attention: [{ id: "login-request", kind: "secure", title: "Save login", detail: "Native request", secure }] };
    await render();
    const password = container.querySelector<HTMLInputElement>('.secure-request input[type="password"]')!;
    await typeInto(password, "synthetic-pending-secret");
    conversation = { ...conversation, attention: [{ ...conversation.attention![0], secure: { ...secure } }] };
    await advance(8000);
    expect(container.querySelector<HTMLInputElement>('.secure-request input[type="password"]')!.value).toBe("synthetic-pending-secret");
    expect(container.querySelector("textarea")!.value).toBe(savedDraft.text);
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.values(localStorage))).not.toContain("synthetic-pending-secret");
    conversation = { ...conversation, attention: [{ ...conversation.attention![0], secure: { ...secure, sessionId: "replacement" } }] };
    await changed();
    expect(container.querySelector<HTMLInputElement>('.secure-request input[type="password"]')!.value).toBe("");
  });

  it("removes this device's push registration and browser subscription before signing out", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    const order: string[] = [];
    const endpoint = "https://push.example.invalid/this-device";
    vi.stubGlobal("navigator", { onLine: true, serviceWorker: {
      getRegistration: vi.fn(async () => ({ pushManager: { getSubscription: vi.fn(async () => ({ endpoint,
        unsubscribe: vi.fn(async () => { order.push("unsubscribe"); return true; }),
      })) } })), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } });
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/auth/config" ? { localDevAuth: true } as T : original(path) as Promise<T>);
    vi.mocked(write).mockImplementation(async <T>(path: string) => { order.push(path); return {} as T; });
    await render();
    // The avatar opens the profile menu; Settings is one of its items.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === "Settings")!.click());
    await loaded();
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Sign out")!.click());
    expect(order).toEqual([]);
    await act(async () => document.querySelector<HTMLButtonElement>('[role="alertdialog"] button.danger')!.click());
    expect(write).toHaveBeenCalledWith("/push/subscriptions", { endpoint }, "DELETE");
    expect(order).toEqual(["/push/subscriptions", "unsubscribe", "/auth/logout"]);
    expect(container.querySelector(".sign-in")).not.toBeNull();
    vi.mocked(write).mockReset().mockResolvedValue({});
  });

  it("asks before signing out from the profile menu, and opens Usage from it", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/usage/accounts" ? { accounts: [], unavailableBots: [] } as T : original(path) as Promise<T>);
    await render();
    const item = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(row => row.textContent?.startsWith(text))!;
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
    await act(async () => item("Sign out").click());
    await loaded();
    // The menu goes straight to the question; nothing is signed out until it is answered.
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Sign out");
    expect(write).not.toHaveBeenCalledWith("/auth/logout", {});
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => !button.classList.contains("danger"))!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
    await act(async () => item("Usage").click());
    await loaded();
    expect(container.querySelector("#usage-title")?.textContent).toBe("Usage");
  });

  it("keeps one integrations dialog across repeated household refreshes", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path.startsWith("/integrations") ? { profile: "shared", canManage: true, connections: [] } as T : original(path) as Promise<T>);
    await render();
    // The avatar opens the profile menu; Settings is one of its items.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === "Settings")!.click());
    await loaded();
    expect(container.querySelectorAll(".hermes-upgrade-panel")).toHaveLength(0);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".settings-row")].find(button => button.textContent?.startsWith("Integrations"))!.click());
    await loaded();
    await advance(30_000);
    expect(container.querySelectorAll(".integrations-panel")).toHaveLength(1);
    // Rarely used screens stay unloaded until opened, and an opened one stays mounted.
    expect(container.querySelectorAll(".hermes-upgrade-panel")).toHaveLength(0);
  });

  it("loads the Hermes updates panel when first opened and keeps it mounted for its running status", async () => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
    await render();
    // The avatar opens the profile menu; Settings is one of its items.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Account"]')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === "Settings")!.click());
    await loaded();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".settings-row")].find(button => button.textContent?.startsWith("Hermes and updates"))!.click());
    await loaded();
    expect(container.querySelector<HTMLDialogElement>(".hermes-upgrade-panel")?.open).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Hermes updates"]')!.click());
    expect(container.querySelector<HTMLDialogElement>(".hermes-upgrade-panel")?.open).toBe(false);
  });

  it("does not re-render the app when bootstrap and conversation reads find nothing new", async () => {
    await render();
    // Live streams: each greets as it connects and is up once it pings again 10 seconds later.
    await act(async () => { for (const stream of FakeEventSource.streams) { stream.connect(); stream.emit("ping", "10"); } });
    await advance(10_000);
    await act(async () => { for (const stream of FakeEventSource.streams) stream.emit("ping", "10"); });
    await advance(2000);
    const settled = renders.avatar;
    expect(settled).toBeGreaterThan(0);
    const bootstraps = () => vi.mocked(api).mock.calls.filter(([path]) => path === "/bootstrap?roster=lean").length;
    const before = bootstraps();
    // Six minutes of live streams, as a server that pings every 10 seconds keeps them: the bootstrap
    // fallback reads once, and a change notice reads the conversation.
    for (let tick = 0; tick < 36; tick++) {
      await act(async () => { for (const stream of FakeEventSource.streams) stream.emit("ping", "10"); });
      await advance(10_000);
    }
    await act(async () => FakeEventSource.notifyAll());
    await advance(1500);
    expect(bootstraps()).toBeGreaterThan(before);
    expect(renders.avatar).toBe(settled);
  });

  it("shows current work inline in the transcript and stops claiming work during a disconnect", async () => {
    conversation = { ...conversation, activity: { state: "working", detail: "Running terminal" },
      toolCalls: [{ id: "shell", name: "terminal", status: "running" }] };
    await render();
    expect(container.querySelector('.transcript .conversation-activity [data-avatar-size="52"]')?.getAttribute("data-avatar-state")).toBe("working");
    expect(container.querySelector('.conversation-activity [data-avatar-size="52"]')?.getAttribute("data-avatar-prop")).toBe("computer");
    // The inline work indicator, the header avatar and pinned assistants animate; the home list stays still.
    expect(container.querySelector(".conversation-activity [data-avatar-state]")?.hasAttribute("data-avatar-still")).toBe(false);
    expect(container.querySelector(".chat-header [data-avatar-state]")?.hasAttribute("data-avatar-still")).toBe(false);
    expect([...container.querySelectorAll(".home-pinned [data-avatar-state]")].every(item => !item.hasAttribute("data-avatar-still"))).toBe(true);
    expect([...container.querySelectorAll(".home-list [data-avatar-state]")].every(item => item.hasAttribute("data-avatar-still"))).toBe(true);
    expect(container.querySelector(".activity-copy")?.textContent).toContain("Shared is running terminal...");
    // The sweeping highlight is a visual copy of the text, so assistive technology must hear the line once.
    const highlight = container.querySelector(".activity-shimmer .shimmer-band");
    expect(highlight?.getAttribute("aria-hidden")).toBe("true");
    expect(highlight?.textContent).toBe("Shared is running terminal...");
    const textarea = container.querySelector("textarea")!;
    await typeInto(textarea, "");
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!;
    await act(async () => stop.click());
    expect(write).toHaveBeenCalledWith("/bots/shared/stop", {});
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path.startsWith("/bots/shared/conversation?")) throw new Error("Disconnected");
      return (path === "/bootstrap?roster=lean" ? bootstrap : savedDraft) as T;
    });
    await changed();
    // One failed read that may be a blip shows once no read has succeeded for the grace period.
    await advance(DISCONNECT_GRACE_MS);
    expect(container.querySelector('.conversation-activity [data-avatar-size="52"]')?.getAttribute("data-avatar-state")).toBe("disconnected");
    expect(container.querySelector('.conversation-activity [data-avatar-size="52"]')?.hasAttribute("data-avatar-prop")).toBe(false);
    expect(container.querySelector(".activity-copy")?.textContent).not.toContain("Shared is running terminal...");
  });

  it("hides empty tool-call replies and the assistant's own name, keeping one timestamp under the last part of a reply", async () => {
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "question", role: "user", text: "Check the NAS", sender: { id: "one", name: "One" }, createdAt: "2026-10-07T12:00:00Z" },
      { id: "call-row", role: "assistant", text: "", createdAt: "2026-10-07T12:00:05Z", toolCall: { id: "ssh", name: "terminal", status: "completed" } },
      { id: "first", role: "assistant", text: "Tailscale is installed.", createdAt: "2026-10-07T12:00:09Z" },
      { id: "second", role: "assistant", text: "It is connected." },
      { id: "other", role: "user", text: "Thanks from the kitchen", sender: { id: "two", name: "Two" }, createdAt: "2026-10-07T12:01:00Z" },
    ] };
    await render();
    const replies = [...container.querySelectorAll(".message-assistant")];
    expect(replies.map(reply => reply.getAttribute("data-message-id"))).toEqual(["first", "second"]);
    // The time sits under the last part, taken from the earlier part when the last has none.
    expect(replies.map(reply => reply.querySelectorAll(".message-meta time").length)).toEqual([0, 1]);
    expect(replies.every(reply => !reply.querySelector(".message-attribution"))).toBe(true);
    const [mine, theirs] = [...container.querySelectorAll(".message-user")];
    // The person's own message needs no name, and another member's does. Both have their time under the bubble.
    expect(mine.querySelector(".message-attribution")).toBeNull();
    expect(theirs.querySelector(".message-attribution")?.textContent).toBe("Two");
    expect(mine.querySelector(".message-bubble + .message-meta-own time")).not.toBeNull();
    expect([...mine.querySelectorAll(".message-meta button")].map(button => button.getAttribute("aria-label"))).toEqual(["Copy message"]);
    expect(container.querySelector(".tool-count")?.textContent).toBe("1");
  });

  // A native Hermes client writes user rows that carry no sender. Only a chat nobody else can write in may call them the viewer's.
  it.each([
    ["a shared assistant", { shared: true }, "Household member"],
    ["a personal assistant with no recorded owner, which the household can use", { shared: false }, "Household member"],
    ["the viewer's own personal assistant", { shared: false, ownerId: "one" }, ""],
  ])("labels a message with no sender in %s as %j", async (_chat, presentation, label) => {
    const original = bootstrap.bots[0];
    bootstrap.bots[0] = { ...original, ...presentation };
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "mine", role: "user", text: "Sent from this app", sender: { id: "one", name: "One" } },
      { id: "native", role: "user", text: "Sent from a Hermes desktop", createdAt: "2026-10-07T12:01:00Z" },
      { id: "theirs", role: "user", text: "Sent by Two", sender: { id: "two", name: "Two" } },
    ] };
    try {
      await render();
      const rows = [...container.querySelectorAll(".message-user")];
      expect(rows.map(row => row.getAttribute("data-message-id"))).toEqual(["mine", "native", "theirs"]);
      expect(rows.map(row => row.querySelector(".message-attribution")?.textContent ?? "")).toEqual(["", label, "Two"]);
    } finally { bootstrap.bots[0] = original; }
  });

  // Hermes saves a steer and a queued send without their sender, so once the sent echo leaves, the row must still read as the viewer's own.
  describe("the viewer's own sends in a shared chat", () => {
    const words = "My saved server draft";
    // A running chat offers guidance, which Hermes steers into the work or queues.
    const guidanceButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Send guidance"]')!;
    const labels = () => [...container.querySelectorAll(".message-user")].map(row =>
      `${row.getAttribute("data-message-id")}:${row.querySelector(".message-attribution")?.textContent ?? ""}`);
    /** Sends the draft while the chat works, and answers its receipt. */
    const sendWith = async (receipt: Record<string, unknown>) => {
      let finish!: (answer: unknown) => void;
      vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
        ? await new Promise<T>(resolve => { finish = answer => resolve(answer as T); }) : {} as T);
      await render();
      await act(async () => guidanceButton().click());
      const requestId = (vi.mocked(write).mock.calls.find(([path]) => path === "/bots/shared/messages")![1] as { requestId: string }).requestId;
      await act(async () => finish({ requestId, status: "accepted", ...receipt }));
      return requestId;
    };
    const working = (...messages: Conversation["messages"]) => {
      conversation = { ...conversation, activity: { state: "working", runId: "run" }, messages: [{ id: "earlier", role: "assistant", text: "On it" }, ...messages] };
    };
    afterEach(() => { vi.mocked(write).mockReset().mockResolvedValue({}); });

    it("keeps a steer unlabeled when Hermes's copy replaces its echo, and labels another member's same words", async () => {
      working();
      const requestId = await sendWith({ steered: true });
      expect(labels()).toEqual([`${requestId}:`]);
      expect(container.querySelector(".message-steered")?.textContent).toBe("Added to the current task");
      // Hermes saves the steer, with no sender, at its next tool batch; the echo gives way to this row.
      working({ id: "steer-row", role: "user", text: words });
      await changed();
      expect(labels()).toEqual(["steer-row:"]);
      // Another member's identical words are a second row, and no send of the viewer's stands behind it.
      working({ id: "steer-row", role: "user", text: words }, { id: "kim-row", role: "user", text: words });
      await changed();
      expect(labels()).toEqual(["steer-row:", "kim-row:Household member"]);
    });

    it("keeps a queued send unlabeled in the row Hermes saved when its turn starts", async () => {
      working();
      const requestId = await sendWith({ turn: "queued" });
      expect(labels()).toEqual([`${requestId}:`]);
      conversation = { ...conversation, activity: { state: "done" }, messages: [
        { id: "earlier", role: "assistant", text: "Done" },
        { id: "queued-row", role: "user", text: words },
        { id: "reply", role: "assistant", text: "Next" },
      ] };
      await changed();
      expect(labels()).toEqual(["queued-row:"]);
    });

    it("labels a row with the same words that was saved before the viewer sent theirs", async () => {
      working({ id: "older-row", role: "user", text: words });
      await sendWith({ steered: true });
      working({ id: "older-row", role: "user", text: words }, { id: "steer-row", role: "user", text: words });
      await changed();
      expect(labels()).toEqual(["older-row:Household member", "steer-row:"]);
    });

    it("reads a copy that arrived before Hermes answered as the viewer's once it accepts the send", async () => {
      let finish!: (answer: unknown) => void;
      vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
        ? await new Promise<T>(resolve => { finish = answer => resolve(answer as T); }) : {} as T);
      working();
      await render();
      await act(async () => guidanceButton().click());
      const requestId = (vi.mocked(write).mock.calls.find(([path]) => path === "/bots/shared/messages")![1] as { requestId: string }).requestId;
      // The reply after it keeps the row's own turn unchanged when the claim arrives.
      working({ id: "steer-row", role: "user", text: words }, { id: "reply", role: "assistant", text: "Understood" });
      conversation = { ...conversation, activity: { state: "done" } };
      await changed();
      expect(labels()).toEqual(["steer-row:Household member", `${requestId}:`]);
      await act(async () => finish({ requestId, status: "accepted", steered: true }));
      expect(labels()).toEqual(["steer-row:"]);
    });

    it("follows an assistant that becomes the viewer's personal one while its chat is open", async () => {
      conversation = { ...conversation, activity: { state: "done" }, messages: [{ id: "native", role: "user", text: "From a Hermes desktop" }] };
      let sharing = true;
      vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/bootstrap?roster=lean"
        ? { ...bootstrap, bots: [sharing ? bootstrap.bots[0] : { ...bootstrap.bots[0], shared: false, ownerId: "one" }] } as T
        : path.startsWith("/bots/shared/conversation?") ? conversation as T : path === "/bots/shared/draft" ? savedDraft as T : null as T);
      const refreshed = async () => { await act(async () => { window.dispatchEvent(new Event("online")); }); await advance(1500); };
      await render();
      expect(labels()).toEqual(["native:Household member"]);
      sharing = false;
      await refreshed();
      expect(labels()).toEqual(["native:"]);
      sharing = true;
      await refreshed();
      expect(labels()).toEqual(["native:Household member"]);
    });
  });

  it("loads transcript images lazily and reserves the space of one that has been seen", async () => {
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "chart-message", role: "assistant", text: "Here is the chart.", files: [{ id: "chart-file", name: "chart.png", mime: "image/png" }] },
    ] };
    await render();
    const image = () => container.querySelector<HTMLImageElement>(".file-link img")!;
    expect(image().getAttribute("loading")).toBe("lazy");
    expect(image().getAttribute("decoding")).toBe("async");
    const frame = () => container.querySelector<HTMLElement>(".file-frame")!;
    expect(frame().style.aspectRatio).toBe("");
    Object.defineProperty(image(), "naturalWidth", { value: 800 });
    Object.defineProperty(image(), "naturalHeight", { value: 600 });
    await act(async () => image().dispatchEvent(new Event("load")));
    await act(async () => root.unmount());
    await render();
    expect(frame().style.aspectRatio).toBe("800 / 600");
  });

  it("keeps the transcript from re-rendering while typing", async () => {
    conversation = { ...conversation, activity: { state: "idle" }, messages: [{ id: "answer", role: "assistant", text: "Ready when you are." }] };
    await render();
    const settled = renders.markdown;
    expect(settled).toBeGreaterThan(0);
    const textarea = container.querySelector("textarea")!;
    for (const text of ["H", "He", "Hey"]) await typeInto(textarea, text);
    expect(textarea.value).toBe("Hey");
    expect(renders.markdown).toBe(settled);
  });

  it("spins Send without a status bar until a send ends without a receipt", async () => {
    conversation = { ...conversation, activity: { state: "idle" } };
    let finish!: (receipt: { requestId: string; status: "uncertain" }) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string, value?: unknown) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = receipt => resolve(receipt as T); void value; }) : {} as T);
    try {
      await render();
      await act(async () => sendButton().click());
      expect(sendButton().disabled).toBe(true);
      expect(sendButton().getAttribute("aria-busy")).toBe("true");
      expect(sendButton().querySelector(".spin")).not.toBeNull();
      expect(container.querySelector(".composer-area .notice")).toBeNull();
      const requestId = (vi.mocked(write).mock.calls.find(([path]) => path === "/bots/shared/messages")![1] as { requestId: string }).requestId;
      await act(async () => finish({ requestId, status: "uncertain" }));
      expect(container.querySelector(".composer-area .notice")?.textContent).toContain("Retry this saved message");
      expect(sendButton().disabled).toBe(true);
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("shows a sent message at once and hands its place to Hermes's copy", async () => {
    conversation = { ...conversation, activity: { state: "idle" } };
    let finish!: (receipt: { requestId: string; status: "accepted" }) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = receipt => resolve(receipt as T); }) : {} as T);
    const sent = () => [...container.querySelectorAll<HTMLElement>(".message-user")];
    try {
      await render();
      await act(async () => sendButton().click());
      expect(sent()).toHaveLength(1);
      expect(sent()[0].textContent).toContain("My saved server draft");
      expect(sent()[0].classList.contains("message-sending")).toBe(true);
      expect(sent()[0].querySelector(".message-meta .message-delivery")?.textContent).toBe("Sending…");
      expect(container.querySelector("textarea")!.value).toBe("");
      expect(sendButton().getAttribute("aria-busy")).toBe("true");
      const requestId = (vi.mocked(write).mock.calls.find(([path]) => path === "/bots/shared/messages")![1] as { requestId: string }).requestId;
      // Accepted before the transcript has it: the echo stays, as an ordinary message.
      await act(async () => finish({ requestId, status: "accepted" }));
      expect(sent()).toHaveLength(1);
      expect(sent()[0].classList.contains("message-outgoing")).toBe(false);
      expect(sendButton().getAttribute("aria-busy")).toBe("false");
      conversation = { ...conversation, activity: { state: "thinking", runId: "run" },
        messages: [{ id: requestId, role: "user", text: "My saved server draft", sender: { id: "one", name: "One" } }] };
      await changed();
      expect(sent()).toHaveLength(1);
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  // The server clears the draft when it accepts a send; draft reads then return this.
  const serveClearedDraft = () => {
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string, init?: RequestInit) => path === "/bots/shared/draft"
      ? { text: "", attachments: [], revision: 1, reason: "sent", sentRevision: 1 } as T : await original(path, init) as T);
  };
  const type = async (text: string) => {
    const textarea = container.querySelector("textarea")!;
    await typeInto(textarea, text);
  };

  it("keeps the same words typed again right after Hermes accepts them", async () => {
    conversation = { ...conversation, activity: { state: "idle" } };
    try {
      vi.mocked(write).mockImplementation(async <T>(path: string, value?: unknown) => path === "/bots/shared/messages"
        ? { requestId: (value as { requestId: string }).requestId, status: "accepted" } as T : {} as T);
      await render();
      await act(async () => sendButton().click());
      serveClearedDraft();
      await type("My saved server draft");
      await advance(3000);
      expect(container.querySelector("textarea")!.value).toBe("My saved server draft");
      expect(vi.mocked(write).mock.calls.some(([path, value, method]) => path === "/bots/shared/draft" && method === "PUT"
        && (value as { text: string }).text === "My saved server draft")).toBe(true);
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("frees the composer when the server clears the draft before the receipt, and keeps what is typed", async () => {
    conversation = { ...conversation, activity: { state: "idle" } };
    let finish!: (receipt: { requestId: string; status: "accepted" }) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = receipt => resolve(receipt as T); }) : {} as T);
    try {
      await render();
      await act(async () => sendButton().click());
      expect(container.querySelector("textarea")!.readOnly).toBe(true);
      serveClearedDraft();
      // The chat's stream announces the cleared draft's revision.
      await act(async () => { for (const stream of FakeEventSource.streams) if (stream.url.startsWith("/api/bots/shared/events")) stream.emit("draft", "1"); });
      await advance(0);
      expect(container.querySelector("textarea")!.readOnly).toBe(false);
      await type("My saved server draft");
      expect(container.querySelector("textarea")!.value).toBe("My saved server draft");
      const requestId = (vi.mocked(write).mock.calls.find(([path]) => path === "/bots/shared/messages")![1] as { requestId: string }).requestId;
      await act(async () => finish({ requestId, status: "accepted" }));
      await advance(3000);
      expect(container.querySelector("textarea")!.value).toBe("My saved server draft");
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("still knows a reloaded copy as the sent copy once the server clears it", async () => {
    conversation = { ...conversation, activity: { state: "idle" } };
    const text = "My saved server draft";
    localStorage.setItem("agent-interface:draft:one:shared", JSON.stringify({ text, attachments: [], botId: "shared", userId: "one",
      dirty: true, baseRevision: 0, seq: 5, sentHash: contentHash({ text, attachments: [] }), sentBase: 0, sentSeq: 5 }));
    localStorage.setItem("agent-interface:submission:one:shared", JSON.stringify({ requestId: "saved-request", botId: "shared",
      text, attachments: [], reviewedInterruption: false, draftBaseRevision: 0 }));
    serveClearedDraft();
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string, init?: RequestInit) => path === "/submissions/saved-request"
      ? { requestId: "saved-request", status: "accepted" } as T : await original(path, init) as T);
    await render();
    await advance(3000);
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(vi.mocked(write).mock.calls.some(([path, value]) => path === "/bots/shared/draft" && (value as { text: string }).text === text)).toBe(false);
  });

  it("holds the composer read-only while a message sends, and gives a refused one back", async () => {
    conversation = { ...conversation, activity: { state: "idle" } };
    let refuse!: () => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>((_, reject) => { refuse = () => reject(new ApiError("Too large", 413)); }) : {} as T);
    try {
      await render();
      await act(async () => sendButton().click());
      const textarea = container.querySelector("textarea")!;
      expect(textarea.readOnly).toBe(true);
      expect(textarea.placeholder).toBe("Sending…");
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Attach images, PDFs, or text"]')!.disabled).toBe(true);
      await act(async () => refuse());
      expect(textarea.readOnly).toBe(false);
      expect(textarea.value).toBe("My saved server draft");
      expect(container.querySelector(".message-user")).toBeNull();
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("keeps guidance submission feedback when the draft is cleared mid-send", async () => {
    conversation = { ...conversation, activity: { state: "working" } };
    let finish!: (receipt: { requestId: string; status: "accepted" }) => void;
    vi.mocked(write).mockImplementation(async <T>(path: string) => path === "/bots/shared/messages"
      ? await new Promise<T>(resolve => { finish = receipt => resolve(receipt as T); }) : {} as T);
    try {
      await render();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send guidance"]')!.click());
      const textarea = container.querySelector("textarea")!;
      await typeInto(textarea, "");
      expect(container.querySelector('[aria-label="Stop response"]')).toBeNull();
      expect(container.querySelector('[aria-label="Send guidance"]')?.getAttribute("aria-busy")).toBe("true");
      const requestId = (vi.mocked(write).mock.calls.find(([path]) => path === "/bots/shared/messages")![1] as { requestId: string }).requestId;
      await act(async () => finish({ requestId, status: "accepted" }));
      expect(container.querySelector('[aria-label="Stop response"]')).not.toBeNull();
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("opens the file picker from a real Attach button", async () => {
    conversation = { ...conversation, activity: { state: "idle" } };
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    try {
      await render();
      const attach = container.querySelector<HTMLButtonElement>('button[aria-label="Attach images, PDFs, or text"]')!;
      await act(async () => attach.click());
      expect(click).toHaveBeenCalledOnce();
      expect((click.mock.contexts[0] as HTMLInputElement).type).toBe("file");
      expect((click.mock.contexts[0] as HTMLInputElement).hidden).toBe(true);
    } finally { click.mockRestore(); }
  });

  describe("attachments", () => {
    type Upload = { file: File; progress(sent: number): void; signal: AbortSignal; finish(value: unknown): void; fail(error: Error): void };
    let uploads: Upload[];
    beforeEach(() => {
      conversation = { ...conversation, activity: { state: "idle" } };
      uploads = [];
      vi.mocked(uploadFile).mockImplementation((_path, file, options) => new Promise((resolve, reject) => uploads.push({
        file, progress: sent => options!.onProgress!(sent), signal: options!.signal!, finish: resolve as (value: unknown) => void, fail: reject,
      })));
      Object.assign(URL, { createObjectURL: vi.fn(() => "blob:local-preview"), revokeObjectURL: vi.fn() });
    });
    const image = (name = "image.png") => new File(["pixels"], name, { type: "image/png" });
    const transfer = (files: File[], text = "") => ({ files, types: ["Files"], getData: () => text, dropEffect: "none" });
    const dispatch = (target: Element, type: string, key: "clipboardData" | "dataTransfer", value: unknown) => act(async () => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, key, { value });
      target.dispatchEvent(event);
    });
    const chips = () => [...container.querySelectorAll<HTMLElement>(".attachment")];

    it("uploads a pasted screenshot with visible progress and keeps it in the saved draft", async () => {
      await render();
      await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image()]));
      expect(container.querySelector("textarea")!.value).toBe(savedDraft.text);
      expect(uploads[0]!.file.name).toMatch(/^Pasted image \d\d\.\d\d\.\d\d\.png$/);
      await act(async () => uploads[0]!.progress(0.4));
      expect(chips()[0]!.className).toContain("attachment-uploading");
      expect(chips()[0]!.textContent).toContain("Uploading 40%");
      expect(sendButton().disabled).toBe(true);
      await act(async () => uploads[0]!.finish({ id: "stored", name: uploads[0]!.file.name, mime: "image/png", size: 6 }));
      expect(chips()).toHaveLength(1);
      expect(chips()[0]!.className).not.toContain("attachment-uploading");
      expect(chips()[0]!.querySelector("img")!.getAttribute("src")).toBe("blob:local-preview");
      expect(sendButton().disabled).toBe(false);
      await advance(400);
      expect(write).toHaveBeenCalledWith("/bots/shared/draft", expect.objectContaining({ attachments: [expect.objectContaining({ id: "stored" })] }), "PUT");
    });

    it("explains refused drops and offers Retry when an upload fails", async () => {
      await render();
      const panel = container.querySelector(".conversation-panel")!;
      const dropped = transfer([new File(["x"], "letter.docx", { type: "application/msword" }), image("trail.png")]);
      await dispatch(panel, "dragenter", "dataTransfer", dropped);
      expect(container.querySelector(".drop-overlay")?.textContent).toContain("Drop to attach for Shared");
      await dispatch(panel, "drop", "dataTransfer", dropped);
      expect(container.querySelector(".drop-overlay")).toBeNull();
      expect(container.querySelector(".attachment-notice")?.textContent).toContain("letter.docx can't be attached");
      expect(uploads.map(upload => upload.file.name)).toEqual(["trail.png"]);
      await act(async () => uploads[0]!.fail(new Error("Hermes is restarting.")));
      expect(chips()[0]!.className).toContain("attachment-failed");
      expect(container.querySelector(".attachment-error")?.textContent).toContain("trail.png didn't upload. Hermes is restarting. Retry or remove it to send.");
      expect(sendButton().disabled).toBe(true);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Retry uploading trail.png"]')!.click());
      expect(uploads).toHaveLength(2);
      await act(async () => uploads[1]!.finish({ id: "trail", name: "trail.png", mime: "image/png" }));
      expect(container.querySelector(".attachment-error")).toBeNull();
      expect(chips()).toHaveLength(1);
      expect(sendButton().disabled).toBe(false);
    });

    it("closes an image preview once its attachment leaves the draft", async () => {
      await render();
      await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image("map.png")]));
      await act(async () => uploads[0]!.finish({ id: "map", name: "map.png", mime: "image/png" }));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Preview map.png"]')!.click());
      expect(container.querySelector(".attachment-preview img")?.getAttribute("src")).toBe("blob:local-preview");
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove map.png"]')!.click());
      vi.mocked(URL.createObjectURL).mockReturnValue("blob:next-preview");
      await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image("gate.png")]));
      expect(chips()).toHaveLength(1);
      expect(container.querySelector(".attachment-preview")).toBeNull();
    });

    it("adds a finished upload to its own assistant after switching away and back", async () => {
      bootstrap.bots.push({ ...bootstrap.bots[0]!, id: "other", name: "Other" });
      const original = vi.mocked(api).getMockImplementation()!;
      try {
        await render();
        await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image("map.png")]));
        const open = (name: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes(name))!.click());
        await open("Other");
        // Without a cached copy, the upload must load the saved draft before adding to it.
        localStorage.removeItem("agent-interface:draft:one:shared");
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/bots/shared/draft" ? gate.then(() => savedDraft as T) : original(path) as Promise<T>);
        await act(async () => uploads[0]!.finish({ id: "map", name: "map.png", mime: "image/png" }));
        await open("Shared");
        await act(async () => release());
        await advance(300);
        expect(container.querySelector("textarea")!.value).toBe(savedDraft.text);
        expect(chips().map(chip => chip.title.split("\n")[0])).toEqual(["map.png"]);
      } finally { bootstrap.bots.pop(); }
    });

    it("cancels an upload removed before it finishes", async () => {
      await render();
      await dispatch(container.querySelector("textarea")!, "paste", "clipboardData", transfer([image("map.png")]));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Cancel uploading map.png"]')!.click());
      expect(uploads[0]!.signal.aborted).toBe(true);
      expect(chips()).toHaveLength(0);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-preview");
    });
  });

  it("stops marking a chat unread once it has been on screen", async () => {
    const other = { ...bootstrap.bots[0], id: "other", name: "Other", unread: true, lastMessage: { text: "Pot roast tonight.", at: new Date(Date.now() - 1000).toISOString() } };
    const home = { ...bootstrap, bots: [...bootstrap.bots, other] };
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/bootstrap?roster=lean" ? home as T : original(path) as Promise<T>);
    await render();
    const marked = () => [...container.querySelectorAll(".bot-row.unread strong")].map(item => item.textContent);
    expect(marked()).toEqual(["Other"]);
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".home-list .bot-row")];
    await act(async () => rows().find(row => row.textContent?.includes("Other"))!.click());
    await loaded();
    expect(marked()).toEqual([]);
    // Back in another chat, the server has not caught up yet, but the read is remembered here.
    await act(async () => rows().find(row => !row.textContent?.includes("Other"))!.click());
    await loaded();
    expect(marked()).toEqual([]);
  });

  it("pins assistants to the top of home and shows everyone else's latest message", async () => {
    const other = { ...bootstrap.bots[0], id: "other", name: "Other", lastMessage: { text: "Pot roast tonight.", at: new Date().toISOString() } };
    const home = { ...bootstrap, bots: [...bootstrap.bots, other], preferences: { ...bootstrap.preferences, favorites: ["shared"] } };
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path === "/bootstrap?roster=lean" ? home as T : original(path) as Promise<T>);
    vi.mocked(write).mockImplementation(async <T>(path: string, value?: unknown) => (path === "/preferences" ? value : {}) as T);
    try {
      await render();
      const pinned = () => [...container.querySelectorAll(".home-pinned .pinned-name")].map(item => item.textContent);
      expect(pinned()).toEqual(["Shared"]);
      await act(async () => { await preloadBotMenu(); });
      const row = container.querySelector<HTMLButtonElement>(".home-list .bot-row")!;
      expect(row.textContent).toContain("Pot roast tonight.");
      expect(row.querySelector("time")?.getAttribute("dateTime")).toBe(other.lastMessage.at);
      await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 })));
      await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('.bot-menu [role="menuitem"]')].find(item => item.textContent === "Pin to top")!.click());
      expect(write).toHaveBeenCalledWith("/preferences", expect.objectContaining({ favorites: ["shared", "other"] }), "PATCH");
      expect(pinned()).toEqual(["Shared", "Other"]);
      expect(document.body.querySelector(".bot-menu")).toBeNull();
      // Pinning also lives in the assistant's details, opened from the header.
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
      await act(async () => container.querySelector<HTMLButtonElement>(".chat-header .chat-identity")!.click());
      await loaded();
      const toggle = container.querySelector<HTMLButtonElement>('.bot-details [aria-pressed="true"]')!;
      expect(toggle.textContent).toBe("Unpin");
      await act(async () => toggle.click());
      expect(pinned()).toEqual(["Other"]);
      expect(container.querySelector('.bot-details [aria-pressed="false"]')?.textContent).toBe("Pin");
    } finally { vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("opens the pin menu on a held touch but not while the list scrolls", async () => {
    await render();
    await act(async () => { await preloadBotMenu(); });
    const row = container.querySelector<HTMLButtonElement>(".bot-row")!;
    const touch = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] });
      return act(async () => row.dispatchEvent(event));
    };
    await touch("touchstart", 20, 20);
    for (let y = 22; y <= 60; y += 2) await touch("touchmove", 20, y);
    await advance(600);
    expect(document.body.querySelector(".bot-menu")).toBeNull();
    await touch("touchend", 20, 60);
    await touch("touchstart", 20, 20);
    await advance(600);
    expect(document.body.querySelector(".bot-menu")).not.toBeNull();
  });

  it("does not save the switch-time scroll clamp as the next assistant's reading position", async () => {
    const other = { ...bootstrap.bots[0], id: "other", name: "Other" };
    bootstrap.bots.push(other);
    try {
      conversation = { ...conversation, activity: { state: "idle" }, messages: [{ id: "answer", role: "assistant", text: "Earlier" }] };
      let finish!: () => void;
      const original = vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation(async <T>(path: string) => path.startsWith("/bots/other/conversation?")
        ? await new Promise<T>(resolve => { finish = () => resolve({ ...conversation, botId: "other", messages: [{ id: "latest", role: "assistant", text: "Latest" }] } as T); })
        : original(path) as Promise<T>);
      await render(); await advance(20);
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes("Other"))!.click());
      const transcript = container.querySelector<HTMLElement>(".transcript")!;
      Object.defineProperties(transcript, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 300, configurable: true } });
      transcript.scrollTop = 0;
      await act(async () => transcript.dispatchEvent(new Event("scroll")));
      await advance(310);
      expect(vi.mocked(write).mock.calls.some(([path]) => path === "/bots/other/read-position")).toBe(false);
      // The response is placed at the latest message before paint, leaving no gap for a clamp.
      await act(async () => finish());
      expect(transcript.scrollTop).toBe(2000);
    } finally { bootstrap.bots.pop(); }
  });

  it("opens phones on home, pushes into a chat and returns with Back", async () => {
    stubMatchMedia(query => query === "(max-width: 620px)");
    conversation = { ...conversation, activity: { state: "idle" } };
    await render();
    const rail = () => container.querySelector(".bot-rail")!;
    expect(rail().classList.contains("open")).toBe(true);
    expect(container.querySelector("main")!.hasAttribute("inert")).toBe(true);
    // Only the chat on screen counts as being read.
    expect(useChatPresence).toHaveBeenLastCalledWith(undefined, bootstrap.user.id);
    await act(async () => container.querySelector<HTMLButtonElement>(".bot-row")!.click());
    expect(rail().classList.contains("open")).toBe(false);
    expect(container.querySelector("main")!.hasAttribute("inert")).toBe(false);
    expect(useChatPresence).toHaveBeenLastCalledWith("shared", bootstrap.user.id);
    const back = container.querySelector<HTMLButtonElement>('[aria-label="Back to assistants"]')!;
    expect(document.activeElement).toBe(back);
    await act(async () => back.click());
    expect(rail().classList.contains("open")).toBe(true);
    expect(useChatPresence).toHaveBeenLastCalledWith(undefined, bootstrap.user.id);
    expect(document.activeElement).toBe(container.querySelector(".bot-rail [aria-current='page']"));
  });

  it.each([false, true])("leaves an assistant that becomes someone else's personal one, on a phone: %s", async (phone) => {
    stubMatchMedia(query => phone && query === "(max-width: 620px)");
    const books = { ...bootstrap.bots[0], id: "books", name: "Ranch books" };
    let hidden = false, reads = 0;
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path === "/bootstrap?roster=lean") return { ...bootstrap, bots: hidden ? bootstrap.bots : [books, ...bootstrap.bots] } as T;
      if (path.startsWith("/bots/books/conversation?")) {
        reads++;
        if (hidden) throw new ApiError("Assistant not found", 404, "assistant_not_found");
        return { ...conversation, botId: "books", activity: { state: "idle" } } as T;
      }
      return original(path) as Promise<T>;
    });
    history.replaceState(null, "", "/?bot=books");
    await render();
    if (phone) await act(async () => container.querySelector<HTMLButtonElement>(".bot-row")!.click());
    expect(container.querySelector(".bot-rail")!.classList.contains("open")).toBe(false);
    hidden = true;
    // The change stream says the conversation changed; reading it now answers 404.
    await act(async () => FakeEventSource.notifyAll());
    expect(container.textContent).toContain("That assistant is no longer available to you.");
    expect(new URLSearchParams(location.search).get("bot")).toBe("shared");
    expect(container.querySelector(".bot-rail")!.classList.contains("open")).toBe(phone);
    const settled = reads;
    await act(async () => FakeEventSource.notifyAll());
    await advance(31_000);
    expect(reads, "no request loop for the missing assistant").toBe(settled);
  });

  it("calls an ownerless personal assistant visible to the household, not yours", async () => {
    const original = bootstrap.bots[0];
    bootstrap.bots[0] = { ...original, shared: false };
    try {
      await render();
      expect(container.querySelector(".chat-title")?.textContent).toContain("Personal, visible to the household");
      expect(container.textContent).not.toContain("Your personal assistant");
    } finally { bootstrap.bots[0] = original; }
  });

  it("collects a turn's reasoning into one accordion between the prompt and the reply", async () => {
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "question", role: "user", text: "Join the NAS" },
      { id: "plan", role: "assistant", text: "", reasoning: "Plan the SSH steps." },
      { id: "call", role: "assistant", text: "", reasoning: "Check the status.", toolCall: { id: "ssh", name: "terminal", status: "completed" } },
      { id: "answer", role: "assistant", text: "Tailscale is up." },
    ] };
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean"
      ? { ...bootstrap, preferences: { ...defaultPreferences, startPage: "assistant", presentation: "advanced" } }
      : path.startsWith("/bots/shared/conversation?") ? conversation : savedDraft) as T);
    await render();
    const accordions = container.querySelectorAll(".reasoning-calls");
    expect(accordions).toHaveLength(1);
    expect(accordions[0].querySelector(".tool-count")?.textContent).toBe("2");
    expect([...accordions[0].querySelectorAll(".reasoning-part")].map(part => part.textContent)).toEqual(["Plan the SSH steps.", "Check the status."]);
    // Reasoning and tools share the turn's one fold between the prompt and the reply.
    const fold = accordions[0].closest(".turn-work")!;
    expect(fold.previousElementSibling?.getAttribute("data-message-id")).toBe("question");
    expect(accordions[0].nextElementSibling?.classList.contains("tool-calls")).toBe(true);
    expect(fold.nextElementSibling?.getAttribute("data-message-id")).toBe("answer");
  });

  it("switches Stop back to Send while drafting guidance", async () => {
    conversation = { ...conversation, activity: { state: "working" } };
    await render();
    const textarea = container.querySelector("textarea")!;
    const type = (text: string) => typeInto(textarea, text);
    expect(container.querySelector('[aria-label="Send guidance"]')).not.toBeNull();
    await type(""); expect(container.querySelector('[aria-label="Stop response"]')).not.toBeNull();
    await type("Try the other file"); expect(container.querySelector('[aria-label="Send guidance"]')).not.toBeNull();
    await type(" "); expect(container.querySelector('[aria-label="Stop response"]')).not.toBeNull();
  });

  it("collapses coordination by source and keeps the scheduled answer and decisions visible", async () => {
    conversation = { ...conversation, messages: [
      { id: "cron", role: "user", text: '[Cronjob "Bunny care" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\nHay and water.' },
      { id: "reminder", role: "assistant", text: "Start with the bunnies." },
      { id: "dm", role: "user", text: "Message from 🤖 Planner (@planner): Check the gate." },
      { id: "bot-reply", role: "assistant", text: "I will check it." },
      { id: "human", role: "user", text: "Hello from Desktop" },
      { id: "handoff", role: "tool", text: "", toolCall: { id: "worker", name: "delegate_task", status: "running" } },
    ], approvals: [{ id: "decision", title: "Open the gate?", detail: "Your decision needed", status: "pending" }] };
    await render();
    const bubbles = [...container.querySelectorAll(".message[data-message-id]")];
    expect(bubbles.map(row => row.getAttribute("data-message-id"))).toEqual(["reminder", "human"]);
    expect(bubbles[0].querySelector(".message-attribution")?.textContent).toBe("Scheduled");
    expect(bubbles[1].textContent).toContain("Hello from Desktop");
    const groups = [...container.querySelectorAll(".tool-calls")];
    expect(groups.map(group => group.querySelector("summary")?.textContent)).toEqual(["Scheduled jobs1", "Bot messages2", "Subagents1Running"]);
    expect(groups.every(group => !group.hasAttribute("open"))).toBe(true);
    expect(container.querySelector(".approval-card")?.textContent).toContain("Open the gate?");
    await act(async () => { groups[0].setAttribute("open", ""); });
    expect(groups[0].textContent).toContain("Hay and water.");
  });

  it.each(["completed", "running"] as const)("orders saved tool activity before the final reply after calls are %s", async status => {
    const call = { id: "reused", name: "terminal", status, result: "Result" };
    conversation = { ...conversation, activity: { state: status === "running" ? "working" : "done" }, messages: [
      { id: "question", role: "user", text: "Check both" },
      { id: "commentary", role: "assistant", text: "Checking both reports." },
      { id: "first-tool", role: "tool", text: "First result", toolCall: call },
      { id: "second-tool", role: "tool", text: "Second result", toolCall: call },
      { id: "answer", role: "assistant", text: "Both reports are ready." },
      { id: "answer-part-two", role: "assistant", text: "The figures match." },
    ], toolCalls: [call] };
    await render();
    const order = [...container.querySelectorAll('.conversation-turn > .message, .conversation-turn > .turn-work')]
      .map(row => row.getAttribute("data-message-id") ?? "tools");
    expect(order).toEqual(status === "running"
      ? ["question", "commentary", "answer", "answer-part-two", "tools"]
      : ["question", "commentary", "tools", "answer", "answer-part-two"]);
  });

  it("keeps tool-call commentary above activity and puts an attachment-only final reply below it", async () => {
    const call = { id: "lookup", name: "terminal", status: "completed" as const, result: "Report ready" };
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "question", role: "user", text: "Make a report" },
      { id: "commentary", role: "assistant", text: "Preparing the report.", toolCall: call },
      { id: "answer", role: "assistant", text: "", files: [{ id: "report", name: "report.txt", mime: "text/plain" }] },
    ] };
    await render();
    const order = [...container.querySelectorAll('.conversation-turn > .message, .conversation-turn > .turn-work')]
      .map(row => row.getAttribute("data-message-id") ?? "tools");
    expect(order).toEqual(["question", "commentary", "tools", "answer"]);
    expect(container.querySelector('[data-message-id="answer"] a')?.textContent).toContain("report.txt");
  });

  it("keeps expanded tool details and scroll position when completion moves them above the reply", async () => {
    const running = { id: "lookup", name: "terminal", status: "running" as const, result: "Partial result" };
    conversation = { ...conversation, activity: { state: "working" }, messages: [
      { id: "question", role: "user", text: "Check it" },
      { id: "tool-row", role: "tool", text: "", toolCall: running },
      { id: "answer", role: "assistant", text: "Checking." },
    ] };
    await render();
    const fold = container.querySelector<HTMLDetailsElement>(".turn-work")!;
    const group = container.querySelector<HTMLDetailsElement>(".tool-calls")!;
    const receipt = group.querySelector<HTMLDetailsElement>(".action-receipt")!;
    const output = receipt.querySelector("pre")!;
    fold.open = group.open = receipt.open = true; output.scrollTop = 120;
    conversation = { ...conversation, activity: { state: "done" }, messages: conversation.messages.map(message =>
      message.toolCall ? { ...message, toolCall: { ...running, status: "completed" as const } } : message) };
    await changed();
    expect(container.querySelector(".turn-work")).toBe(fold);
    expect(container.querySelector(".tool-calls")).toBe(group);
    expect(fold.open).toBe(true); expect(group.open).toBe(true); expect(receipt.open).toBe(true);
    expect(output.scrollTop).toBe(120);
    expect(output.getAttribute("role")).toBe("region");
    expect(output.getAttribute("aria-label")).toBe("Result from terminal");
    expect(group.compareDocumentPosition(container.querySelector('[data-message-id="answer"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("counts history and live tools once and groups delegated work separately", async () => {
    const call = { id: "lookup", name: "web", status: "completed" as const, result: "Found it" };
    conversation = { ...conversation, activity: { state: "working" }, messages: [
      { id: "question", role: "user", text: "Find it" },
      { id: "tool-row", role: "tool", text: "Found it", toolCall: call },
      { id: "handoff", role: "tool", text: "Done", toolCall: { id: "worker", name: "delegate_task", status: "completed", result: "Done" } },
    ], toolCalls: [call, { id: "second", name: "terminal", status: "running" }] };
    await render();
    const groups = [...container.querySelectorAll<HTMLDetailsElement>(".tool-calls")];
    expect(groups.map(group => group.querySelector("summary")?.textContent)).toEqual(["Tool calls2Running", "Subagents1"]);
    expect(groups.every(group => !group.open)).toBe(true);
    expect(container.querySelectorAll('.tool-call-detail, .action-receipt')).toHaveLength(3);
    expect(container.textContent).toContain("Found it");
  });

  it("preserves separate historical tool results and files when Hermes reuses a call ID", async () => {
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "question", role: "user", text: "Get both reports" },
      { id: "first-row", role: "tool", text: "First", toolCall: { id: "reused", name: "terminal", status: "completed", result: "First result" } },
      { id: "second-row", role: "tool", text: "Second", toolCall: { id: "reused", name: "terminal", status: "completed", result: "Second result" }, files: [{ id: "report", name: "report.txt", mime: "text/plain" }] },
    ] };
    await render();
    expect(container.querySelector(".tool-count")?.textContent).toBe("2");
    expect(container.textContent).toContain("First result"); expect(container.textContent).toContain("Second result");
    expect(container.querySelector('.tool-calls a')?.textContent).toContain("report.txt");
  });

  it("shows Send for an attachment-only draft while the assistant works", async () => {
    conversation = { ...conversation, activity: { state: "working" } };
    const original = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path: string) => path.endsWith("/draft")
      ? { text: "", attachments: [{ id: "document", name: "report.txt", mime: "text/plain" }] } as T : original(path) as Promise<T>);
    await render();
    expect(container.querySelector('[aria-label="Send guidance"]')).not.toBeNull();
  });

  it("keeps an unanswered Stop isolated when switching assistants", async () => {
    const other = { ...bootstrap.bots[0], id: "other", name: "Other" };
    bootstrap.bots.push(other);
    try {
      conversation = { ...conversation, activity: { state: "working" } };
      const original = vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation(async <T>(path: string) => path.endsWith("/draft") ? { text: "", attachments: [] } as T
        : path.startsWith("/bots/other/conversation?") ? { ...conversation, botId: "other" } as T : original(path) as Promise<T>);
      let reject!: (error: Error) => void;
      vi.mocked(write).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
      await render(); await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click());
      expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.disabled).toBe(true);
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes("Other"))!.click());
      expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.disabled).toBe(false);
      await act(async () => reject(new Error("Previous assistant failed")));
      expect(container.textContent).not.toContain("Previous assistant failed");
    } finally { bootstrap.bots.pop(); vi.mocked(write).mockReset().mockResolvedValue({}); }
  });

  it("shows approval submission immediately, blocks duplicate decisions and allows retry after failure", async () => {
    conversation = { ...conversation, approvals: [{ id: "approval", title: "Run action?", detail: "Details", status: "pending" }] };
    let reject!: (error: Error) => void;
    vi.mocked(write).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await render();
    const [approve, decline] = [...container.querySelectorAll<HTMLButtonElement>(".approval-card button")];
    await act(async () => approve.click());
    expect(approve.textContent).toBe("Approving…"); expect(approve.querySelector(".spin")).not.toBeNull();
    expect(approve.disabled).toBe(true); expect(decline.disabled).toBe(true);
    await act(async () => decline.click()); expect(write).toHaveBeenCalledOnce();
    await act(async () => reject(new ApiError("Could not send decision", 400)));
    expect(approve.disabled).toBe(false); expect(decline.disabled).toBe(false);
    expect(container.textContent).toContain("Could not send decision");
    vi.mocked(write).mockResolvedValueOnce({}); await act(async () => decline.click());
    // Declined, the card folds to one line and the message box asks what to do instead.
    expect(container.querySelector(".approval-card")?.textContent).toBe("Declined. Shared stopped that step.");
    expect(container.querySelector(".approval-card button")).toBeNull();
    await act(async () => { vi.advanceTimersToNextFrame(); });
    const message = container.querySelector<HTMLTextAreaElement>("#message")!;
    expect([message.placeholder, document.activeElement]).toEqual(["Tell Shared what to do instead", message]);
    vi.mocked(write).mockReset().mockResolvedValue({});
  });

  it("replaces inline thinking with the final reply when work completes", async () => {
    conversation = { ...conversation, activity: { state: "thinking" }, messages: [
      { id: "question", role: "user", text: "Where is the file?" },
    ] };
    await render();
    const activity = container.querySelector(".message-activity")!;
    expect(activity.previousElementSibling?.querySelector("[data-message-id]")?.getAttribute("data-message-id")).toBe("question");
    expect(activity.querySelector("[data-avatar-state]")?.getAttribute("data-avatar-state")).toBe("thinking");
    conversation = { ...conversation, activity: { state: "done", detail: "Finished finding the file." }, messages: [
      ...conversation.messages,
      { id: "answer", role: "assistant", text: "The file is in your Documents folder." },
    ] };
    await changed();
    expect(container.querySelector(".transcript-content")?.lastElementChild?.textContent).toContain("The file is in your Documents folder.");
    expect(container.querySelector(".conversation-activity")).toBeNull();
    expect(container.querySelector(".chat-header [data-avatar-state]")?.getAttribute("data-avatar-state")).toBe("idle");
  });

  it("keeps Simple readable and exposes real reasoning and deduplicated tool details in Advanced", async () => {
    const call = { id: "call-1", name: "terminal", arguments: '{"command":"pwd"}', status: "completed" as const,
      result: "/home/hermes", startedAt: "2026-09-30T12:00:00Z", completedAt: "2026-09-30T12:00:01Z" };
    conversation = { ...conversation, activity: { state: "done" }, messages: [
      { id: "reply", role: "assistant", text: "Found it.", reasoning: "Checking the working directory." },
      { id: "tool-result", role: "tool", text: "/home/hermes", toolName: "terminal", toolCall: call },
    ], toolCalls: [call, { id: "call-2", name: "read_file", status: "failed", error: "File is missing." }] };
    await render();
    expect(container.querySelectorAll(".tool-call-detail")).toHaveLength(0);
    expect(container.querySelector(".transcript")!.textContent).not.toContain("Checking the working directory.");
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean"
      ? { ...bootstrap, preferences: {...defaultPreferences, startPage:"assistant", presentation: "advanced" } }
      : path.startsWith("/bots/shared/conversation?") ? conversation : savedDraft) as T);
    await act(async()=>{ for(const stream of FakeEventSource.streams)if(stream.url==="/api/events?ping=10")stream.emit("roster","roster"); });
    expect(container.querySelectorAll('[data-tool-call-id="call-1"]')).toHaveLength(1);
    expect(container.querySelectorAll(".tool-call-detail")).toHaveLength(2);
    const completed = container.querySelector<HTMLDetailsElement>('[data-tool-call-id="call-1"]')!;
    expect(completed.open).toBe(false);
    expect(completed.textContent).toContain("Completed");
    expect(completed.textContent).toContain('{"command":"pwd"}');
    expect(completed.textContent).toContain("/home/hermes");
    expect(completed.querySelectorAll("time")).toHaveLength(2);
    expect(container.querySelector('[data-tool-call-id="call-2"]')?.textContent).toContain("File is missing.");
    expect(container.querySelector(".transcript")!.textContent).toContain("Checking the working directory.");
  });

  it("labels a running tool as last observed while disconnected", async () => {
    conversation = { ...conversation, activity: { state: "working", detail: "Running terminal" },
      toolCalls: [{ id: "live-call", name: "terminal", status: "running", arguments: "pwd" }] };
    vi.mocked(api).mockImplementation(async <T>(path: string) => (path === "/bootstrap?roster=lean"
      ? { ...bootstrap, preferences: { ...defaultPreferences, startPage:"assistant", presentation: "advanced" } }
      : path.startsWith("/bots/shared/conversation?") ? conversation : savedDraft) as T);
    await render();
    expect(container.querySelector('[data-tool-call-id="live-call"] summary')?.textContent).toContain("Running");
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path.startsWith("/bots/shared/conversation?")) throw new Error("Disconnected");
      return (path === "/bootstrap?roster=lean" ? { ...bootstrap, preferences: { ...defaultPreferences, startPage:"assistant", presentation: "advanced" } } : savedDraft) as T;
    });
    await changed();
    await advance(DISCONNECT_GRACE_MS);
    expect(container.querySelector('[data-tool-call-id="live-call"] summary')?.textContent).toContain("Last seen running");
  });

  it("loads a saved server draft while Hermes is down and never overwrites it with an empty draft", async () => {
    let resolveDraft!: (value: typeof savedDraft) => void;
    const draftResponse = new Promise<typeof savedDraft>((resolve) => { resolveDraft = resolve; });
    vi.mocked(api).mockImplementation(async <T>(path: string) => {
      if (path.startsWith("/bots/shared/conversation?")) throw new Error("Hermes is unavailable");
      return (path === "/bootstrap?roster=lean" ? bootstrap : await draftResponse) as T;
    });
    await render();
    const textarea = container.querySelector("textarea")!;
    expect(textarea.disabled).toBe(true);
    await advance(400);
    expect(write).not.toHaveBeenCalled();
    await act(async () => resolveDraft(savedDraft));
    expect(textarea.value).toBe(savedDraft.text);
    expect(textarea.disabled).toBe(false);
    expect(sendButton().disabled).toBe(true);
    await advance(400);
    expect(write).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("agent-interface:draft:one:shared")!).text).toBe(savedDraft.text);
  });

  it("requires a fresh review after an interrupted run resumes or a different run is interrupted", async () => {
    await render();
    expect(reviewCheckbox().checked).toBe(false);
    expect(sendButton().disabled).toBe(true);
    await act(async () => reviewCheckbox().click());
    expect(reviewCheckbox().checked).toBe(true);
    expect(sendButton().disabled).toBe(false);

    conversation = { ...conversation, activity: { state: "working", runId: "old-run" } };
    await changed();
    expect(reviewCheckbox()).toBeNull();
    conversation = { ...conversation, activity: { state: "interrupted", runId: "new-run" } };
    await changed();
    expect(reviewCheckbox().checked).toBe(false);
    expect(sendButton().disabled).toBe(true);

    await act(async () => reviewCheckbox().click());
    expect(sendButton().disabled).toBe(false);
    conversation = { ...conversation, activity: { state: "interrupted", runId: "another-run" } };
    await changed();
    expect(reviewCheckbox().checked).toBe(false);
    expect(sendButton().disabled).toBe(true);
  });
});

describe("reply announcements", () => {
  const message = (id: string, role: "user" | "assistant", text: string) => ({ id, role, text });
  const settled = [message("u1", "user", "Hello"), message("a1", "assistant", "Hi, I'm here.")];
  const announcement = () => container.querySelector('.transcript-frame > [role="status"]')!.textContent;
  const hold = (messages: typeof settled, state: Conversation["activity"]["state"] = "done") => {
    conversation = { ...conversation, messages, activity: { state, runId: "run" } };
  };

  it("labels the transcript as a region without making it announce everything", async () => {
    await render();
    const transcript = container.querySelector(".transcript")!;
    expect(transcript.getAttribute("role")).toBe("region");
    expect(transcript.getAttribute("aria-label")).toBe("Conversation");
    expect(transcript.hasAttribute("aria-live")).toBe(false);
  });

  it("stays quiet for the reply already in the conversation when it opens", async () => {
    hold(settled);
    await render();
    await changed();
    expect(announcement()).toBe("");
  });

  it("reads a new reply once, as plain words", async () => {
    hold(settled);
    await render();
    hold([...settled, message("u2", "user", "Status?"),
      message("a2", "assistant", "## Done\n**The report** is [ready](https://example.invalid).\n```\nnpm test\n```")]);
    await changed();
    expect(announcement()).toBe("Shared replied: Done The report is ready.");
  });

  it("waits for the assistant to stop working and reads the finished text, not each stage", async () => {
    hold(settled);
    await render();
    hold([...settled, message("u2", "user", "Status?"), message("a2", "assistant", "Checking")], "working");
    await changed();
    expect(announcement()).toBe("");
    hold([...settled, message("u2", "user", "Status?"), message("a2", "assistant", "Checking. All clear.")], "working");
    await changed();
    expect(announcement()).toBe("");
    hold([...settled, message("u2", "user", "Status?"), message("a2", "assistant", "Checking. All clear.")], "done");
    await changed();
    expect(announcement()).toBe("Shared replied: Checking. All clear.");
  });

  it("reads the finished reply when Hermes swaps its in-flight row for saved rows with new IDs", async () => {
    hold(settled);
    await render();
    const prompt = message("u2", "user", "Status?");
    hold([...settled, prompt, message("session-inflight", "assistant", "Checking")], "working");
    await changed();
    expect(announcement()).toBe("");
    hold([...settled, prompt, message("row-41", "assistant", "Checking. All clear.")], "done");
    await changed();
    expect(announcement()).toBe("Shared replied: Checking. All clear.");
  });

  it("reads an unsaved reply once, not again when saved rows replace it", async () => {
    hold(settled);
    await render();
    const prompt = message("u2", "user", "Status?");
    hold([...settled, prompt, message("session-inflight", "assistant", "All clear.")], "done");
    await changed();
    expect(announcement()).toBe("Shared replied: All clear.");
    const first = container.querySelector('.transcript-frame > [role="status"] > span');
    hold([...settled, prompt, message("row-41", "assistant", "All clear.")], "done");
    await advance(3000);
    expect(container.querySelector('.transcript-frame > [role="status"] > span')).toBe(first);
  });

  it("reads an identical reply in the next turn even as the previous one is being replaced", async () => {
    hold(settled);
    await render();
    const first = message("u2", "user", "Status?");
    hold([...settled, first, message("session-inflight", "assistant", "Done.")], "done");
    await changed();
    const node = container.querySelector('.transcript-frame > [role="status"] > span');
    const saved = [...settled, first, message("row-41", "assistant", "Done.")];
    const second = message("u3", "user", "And now?");
    hold([...saved, second, message("session-inflight", "assistant", "Done.")], "done");
    await changed();
    const next = container.querySelector('.transcript-frame > [role="status"] > span');
    expect(announcement()).toBe("Shared replied: Done.");
    expect(next).not.toBe(node);
    hold([...saved, second, message("row-50", "assistant", "Done.")], "done");
    await changed();
    expect(container.querySelector('.transcript-frame > [role="status"] > span')).toBe(next);
  });

  it("stays quiet for a finished unsaved reply on load, and for the rows that later save it", async () => {
    const prompt = message("u2", "user", "Status?");
    hold([...settled, prompt, message("session-inflight", "assistant", "Old news.")], "done");
    await render();
    await changed();
    expect(announcement()).toBe("");
    hold([...settled, prompt, message("row-41", "assistant", "Old news.")], "done");
    await changed();
    expect(announcement()).toBe("");
  });

  it("reads a second identical reply as a new announcement", async () => {
    hold(settled);
    await render();
    hold([...settled, message("a2", "assistant", "Done.")]);
    await changed();
    const first = container.querySelector('.transcript-frame > [role="status"] > span');
    expect(announcement()).toBe("Shared replied: Done.");
    hold([...settled, message("a2", "assistant", "Done."), message("a3", "assistant", "Done.")]);
    await changed();
    expect(announcement()).toBe("Shared replied: Done.");
    expect(container.querySelector('.transcript-frame > [role="status"] > span')).not.toBe(first);
  });

  it("never pairs the previous assistant's reply with the newly opened assistant's name", async () => {
    const other = { ...bootstrap.bots[0], id: "other", name: "Other" };
    bootstrap.bots.push(other);
    const written: string[] = [];
    const nodeValue = Object.getOwnPropertyDescriptor(Node.prototype, "nodeValue")!;
    Object.defineProperty(Node.prototype, "nodeValue", { configurable: true, get: nodeValue.get, set(value: string) {
      if (this.parentElement?.closest('.transcript-frame > [role="status"]')) written.push(String(value));
      nodeValue.set!.call(this, value);
    } });
    try {
      const original = vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation(async <T>(path: string) => path.startsWith("/bots/other/conversation?")
        ? { ...conversation, botId: "other", messages: [] } as T : original(path) as Promise<T>);
      hold(settled);
      await render();
      hold([...settled, message("a2", "assistant", "Done.")]);
      await changed();
      expect(announcement()).toBe("Shared replied: Done.");
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".bot-item")].find(button => button.textContent?.includes("Other"))!.click());
      expect(written.filter(text => text.startsWith("Other"))).toEqual([]);
      expect(announcement()).toBe("");
    } finally {
      Object.defineProperty(Node.prototype, "nodeValue", nodeValue);
      bootstrap.bots.pop();
    }
  });

  it("keeps the first 200 characters of a long reply", async () => {
    hold(settled);
    await render();
    hold([...settled, message("a2", "assistant", "word ".repeat(100))]);
    await changed();
    expect(announcement()).toBe(`Shared replied: ${"word ".repeat(40).trim()}…`);
  });

  it("stays quiet when older history is loaded above the conversation", async () => {
    hold(settled);
    await render();
    hold([message("u0", "user", "Earlier"), message("a0", "assistant", "An older answer"), ...settled]);
    await changed();
    expect(announcement()).toBe("");
  });

  it("ignores a new user message", async () => {
    hold(settled);
    await render();
    hold([...settled, message("u2", "user", "More please")]);
    await changed();
    expect(announcement()).toBe("");
  });
});
