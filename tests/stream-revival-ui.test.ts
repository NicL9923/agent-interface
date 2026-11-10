// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, write } from "../src/client-api";
import { useConversation } from "../src/app/use-conversation";
import type { Conversation } from "../src/shared/types";
import { FakeEventSource } from "./fake-event-source";
import { advance, mountRoot } from "./ui-harness";

// The browser's `online` event and a manual retry tell a chat's stream that its failures are stale. The
// first in an outage connects at once; repeated ones must not each start a connection, or a flapping
// network interface, or a person pressing Retry, hammers a server that keeps refusing.

// Only the network is replaced; changeStream and the conversation hook run for real. Every request a
// test did not list fails loudly, and the hook swallows some, so `unexpected` is checked after each test.
vi.mock("../src/client-api", async original => (await import("./helpers/request-mock")).withRequest({
  ...await original<typeof import("../src/client-api")>(), api: vi.fn(), write: vi.fn(),
}));

const START = Date.parse("2026-11-10T12:00:00Z");
let unexpected: string[];
const conversation: Conversation = { botId: "shared", messages: [{ id: "one", role: "assistant", text: "Howdy" }], approvals: [], files: [], activity: { state: "idle" } };

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  // The jitter's random source: the middle of every range, so a forced gap is 3 seconds and the first
  // retry 1.5.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  unexpected = [];
  vi.mocked(api).mockReset().mockImplementation(async <T>(path: string) => {
    if (path.startsWith("/bots/shared/conversation?")) return conversation as T;
    unexpected.push(`GET ${path}`);
    throw new Error(`This test serves no GET ${path}`);
  });
  vi.mocked(write).mockReset().mockImplementation(async (path: string, _body: unknown, method = "POST") => {
    unexpected.push(`${method} ${path}`);
    throw new Error(`This test serves no ${method} ${path}`);
  });
});
afterEach(() => {
  expect(unexpected).toEqual([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const Chat = () => { useConversation("shared", "one"); return null; };
const attempts = () => FakeEventSource.created.length;
const live = () => [...FakeEventSource.streams].at(-1);
/** Mounts the chat and refuses its first stream, so the chat is in an outage with one failure. */
async function refused() {
  await mountRoot().render(createElement(Chat));
  await advance(0);
  expect(attempts()).toBe(1);
  await act(async () => live()!.fail());
}
const signal = (type: "online" | "agent-interface:reconnect") => act(async () => { window.dispatchEvent(new Event(type)); });
/** Seconds after `from` of each attempt since `seen`, to a tenth. */
const times = (from: number, seen: number) => FakeEventSource.opened.slice(seen).map(source => Math.round((source.at - from) / 100) / 10);

describe("signals that a chat stream's failures are stale", () => {
  it("connects at once on the first and coalesces 100 more into none while the clock stands still", async () => {
    await refused();
    await signal("online");
    expect(attempts(), "the first signal connects at once").toBe(2);
    await act(async () => live()!.fail());
    for (let event = 1; event < 100; event++) {
      await signal("online");
      // A server that refuses at once, between one signal and the next.
      const source = live();
      if (source) await act(async () => source.fail());
    }
    expect(attempts(), "the opening and the first signal's attempt, nothing more").toBe(2);
  });

  it("starts 5 attempts in 10 seconds for 100 signals a tenth of a second apart, against a server that refuses", async () => {
    await refused();
    const from = Date.now(), seen = attempts();
    // The server refuses each attempt a millisecond after it starts.
    FakeEventSource.serve = source => source.fail();
    for (let event = 0; event < 100; event++) {
      await advance(100);
      await signal("online");
    }
    FakeEventSource.serve = undefined;
    // 0.1 forced at once; 1.6 the first retry, sooner than the gap; then one forced attempt per 3 s gap,
    // each sooner than the ordinary retry, which by then waits 3, 6 and 12 seconds.
    expect(times(from, seen)).toEqual([0.1, 1.6, 3.1, 6.1, 9.1]);
  });

  it("answers a manual retry inside the gap with the pending attempt, and never later than the ordinary retry", async () => {
    await refused();
    const from = Date.now(), seen = attempts();
    await signal("online");
    await act(async () => live()!.fail());
    // The ordinary retry, 1.5 s away, is sooner than the gap's end at 3 s: a manual retry keeps it.
    await advance(500);
    await signal("agent-interface:reconnect");
    await advance(999);
    expect(attempts() - seen).toBe(1);
    await advance(1);
    expect(times(from, seen)).toEqual([0, 1.5]);
    await act(async () => live()!.fail());
    // Now the ordinary retry waits 3 s, to 4.5, and a press at 2 s is answered when the gap ends at 3.
    await advance(500);
    await signal("agent-interface:reconnect");
    await signal("agent-interface:reconnect");
    await advance(999);
    expect(attempts() - seen, "nothing before the gap ends").toBe(2);
    await advance(1);
    expect(times(from, seen)).toEqual([0, 1.5, 3]);
    // That attempt replaced the retry; it is not made as well.
    await advance(1_500);
    expect(attempts() - seen).toBe(3);
    // Refused again, the ordinary retry waits 6 s, to 9. A press after the gap has ended connects at once.
    await act(async () => live()!.fail());
    await advance(1_500);
    await signal("agent-interface:reconnect");
    expect(times(from, seen)).toEqual([0, 1.5, 3, 6]);
  });

  it("connects at once again after the forced attempt's stream proved itself, by the rule that resets the backoff", async () => {
    await refused();
    await signal("online");
    // A server may name any interval from 1 to 60 seconds. At 2, a ping a second after the headers proves
    // the stream, well inside the 3-second gap that began with this attempt.
    const proved = live()!;
    await act(async () => { proved.connect(); proved.emit("ping", "2"); });
    await advance(1_000);
    await act(async () => proved.emit("ping", "2"));
    await act(async () => proved.fail());
    const after = attempts();
    await signal("online");
    expect(attempts(), "a new outage's first signal connects at once").toBe(after + 1);
  });

  it("keeps the gap after a stream that only greeted, which proves nothing", async () => {
    await refused();
    await signal("online");
    const greeted = live()!;
    await act(async () => { greeted.connect(); greeted.emit("ping", "10"); });
    await act(async () => greeted.fail());
    const after = attempts();
    await signal("online");
    expect(attempts()).toBe(after);
  });
});
