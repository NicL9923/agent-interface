import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHermesRuntime } from "../src/server/hermes.js";
import { nativeStartedAt, promptSaved, turnRows, turnStart, withSeams } from "../src/server/hermes-mapping.js";
import { compareVersions } from "../src/shared/inflight.js";
import type { Message, Runtime } from "../src/shared/types.js";
import { fakeHermes, HERMES_URL, row, type FakeHermes } from "./helpers/fake-hermes.js";

// The real Hermes runtime over a fake socket: how it reads a running turn for `?inflight=3` streams.
let hermes: FakeHermes, runtime: Runtime;
beforeEach(() => {
  hermes = fakeHermes();
  runtime = createHermesRuntime({ url: HERMES_URL, token: "isolated-contract-token" });
});
afterEach(async () => { await runtime.close(); vi.unstubAllGlobals(); });

const opens = () => hermes.opens().map(call => call.params.omit_messages ? "light" : call.params.window ?? "whole");
/** A settled first turn and a second one running, whose prompt the app sent as req-2. */
function midTurn() {
  hermes.history = [row(1, "user", "Fence?", { app_run_id: "run-1" }), row(2, "assistant", "Fixed.", { app_run_id: "run-1" }),
    row(3, "user", "Check the barn", { app_request_id: "req-2", app_run_id: "run-2" })];
  Object.assign(hermes, { running: true, runId: "run-2", inflight: { user: "Check the barn", assistant: "" } });
}
/** Hermes saves the reply so far as a segment before a tool, as it does before each tool call. */
function saveSegment(id: number, text: string, run = "run-2") {
  hermes.history.push(row(id, "assistant", text, { app_run_id: run }));
}
async function released(count: number) {
  await vi.waitFor(() => expect(hermes.held).toHaveLength(count));
  return hermes.held.at(-1)!;
}

describe("turn reads for streams that follow turns", () => {
  // A routine's or an auto-continue's prompt is hidden, so the turn's first saved message is a reply. The add-on cuts the
  // turn read there, keeping the prompt before it for origins, instead of answering the whole history.
  it("reads a turn whose prompt is hidden from its first reply, as a cut window", async () => {
    hermes.history = [row(1, "user", "Fence?", { app_run_id: "run-1", timestamp: 100 }), row(2, "assistant", "Fixed.", { app_run_id: "run-1", timestamp: 101 }),
      row(3, "user", "Check the herd.", { display_kind: "hidden", app_run_id: "run-2", timestamp: 200 })];
    // Hermes says when the turn started, so its first saved message is the reply, not the last shown prompt.
    Object.assign(hermes, { running: true, runId: "run-2", inflight: { user: "Check the herd.", assistant: "", started_at: 200 } });
    await runtime.conversation("shared", { window: { turns: 20 } });
    const followed = vi.fn();
    runtime.followTurns!("shared", followed);
    hermes.history.push(row(4, "assistant", "Counting.", { app_run_id: "run-2", timestamp: 201 }));
    hermes.frame("tool.start", { tool_id: "t1", name: "terminal" });
    hermes.frame("tool.complete", { tool_id: "t1", name: "terminal", result: "ok" });
    await vi.waitFor(() => expect(followed).toHaveBeenCalledTimes(1));
    // That read found the reply; the next tool's read starts there.
    hermes.frame("tool.start", { tool_id: "t2", name: "terminal" });
    hermes.frame("tool.complete", { tool_id: "t2", name: "terminal", result: "ok" });
    await vi.waitFor(() => expect(followed).toHaveBeenCalledTimes(2));
    expect(hermes.opens().at(-1)!.params.window).toEqual({ start: "4" });
    // A cut window holds no message just before the turn, so the event names none; a client that does not hold the
    // reply yet reads once to place it, as for any turn that starts its window.
    expect(runtime.turn!("shared")!.turn).toEqual({ messages: [expect.objectContaining({ id: "4", text: "Counting." })] });
  });

  it("reads the turn itself after a structural frame, once for every follower, from the turn's first message", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    const one = vi.fn(), two = vi.fn();
    runtime.followTurns!("shared", one);
    runtime.followTurns!("shared", two);
    hermes.frame("message.delta", { text: "Looking. " });
    saveSegment(4, "Looking.");
    hermes.frame("tool.start", { tool_id: "t1", name: "terminal" });
    const before = runtime.turn!("shared")!;
    hermes.frame("tool.complete", { tool_id: "t1", name: "terminal", result: "ok" });
    // Until the turn read lands, the reply goes on growing at the last read's version, which has no row for the segment
    // saved before the tool, so the segment stays in the live reply and what follows the tool starts a paragraph.
    hermes.frame("message.delta", { text: "Found" });
    expect(runtime.turn!("shared")).toMatchObject({ version: before.version, turn: before.turn, message: { text: "Looking. \n\nFound" },
      toolCalls: [expect.objectContaining({ id: "t1", status: "completed" })] });
    await vi.waitFor(() => expect(one).toHaveBeenCalledOnce());
    expect(two).toHaveBeenCalledOnce();
    expect(opens()).toEqual([{ turns: 20 }, { start: "req-2" }]);
    hermes.frame("message.delta", { text: " it." });
    const live = runtime.turn!("shared")!;
    expect(compareVersions(live.version, before.version)).toBeGreaterThan(0);
    // The saved segment is a row of the turn, so the live reply leaves it out.
    expect(live.turn).toEqual({ messages: [expect.objectContaining({ id: "req-2" }), expect.objectContaining({ id: "4", text: "Looking." })] });
    expect(live.message.text).toBe("Found it.");
    expect(live.toolCalls).toEqual([expect.objectContaining({ id: "t1", status: "completed" })]);
  });

  // A tool finishing or a progress line saved changes only what a turn event carries; anything else may change what only a read does.
  it.each<[string, () => void]>([
    ["the turn ending", () => hermes.frame("message.complete", { status: "complete" })],
    ["an approval asked", () => hermes.request("approval", "ap-1", { command: "ls" })],
    ["a frame the runtime does not know", () => hermes.frame("session.info", {})],
  ])("keeps no live reply on the last read's version past %s, even after a tool finished", async (_, send) => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    hermes.frame("message.delta", { text: "Looking." });
    hermes.frame("tool.complete", { tool_id: "t1", name: "terminal" });
    hermes.frame("message.interim", {});
    expect(runtime.turn!("shared")!.message.text).toBe("Looking.");
    send();
    expect(runtime.turn!("shared")).toBeUndefined();
  });

  it("reads nothing for an assistant no stream follows, or once the last one stops", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    hermes.frame("tool.complete", { tool_id: "t1" });
    const stop = runtime.followTurns!("shared", () => {});
    stop();
    stop();
    hermes.frame("message.interim", {});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(opens()).toEqual([{ turns: 20 }]);
  });

  it("keeps one turn read on its way and one queued through a burst of frames", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    hermes.frame("tool.complete", { tool_id: "a" });
    const first = await released(1);
    for (const id of ["b", "c", "d"]) hermes.frame("tool.complete", { tool_id: id });
    first.release();
    // The burst superseded the first answer, so the one queued read asks once more, and that one stands.
    (await released(2)).release();
    await vi.waitFor(() => expect(runtime.turn!("shared")).toBeDefined());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(opens()).toEqual([{ turns: 20 }, { start: "req-2" }, { start: "req-2" }]);
  });

  it("keeps reading while frames supersede each read, however many in a row", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    hermes.frame("tool.complete", { tool_id: "a" });
    for (let read = 1; read <= 4; read++) {
      const open = await released(read);
      if (read < 4) hermes.frame("tool.complete", { tool_id: `burst-${read}` });
      open.release();
    }
    await vi.waitFor(() => expect(runtime.turn!("shared")).toBeDefined());
    expect(opens()).toHaveLength(5);
  });

  it("reads again, twice at most, when another open answered first supersedes a turn read with nothing queued", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    hermes.frame("tool.complete", { tool_id: "a" });
    const turn = await released(1);
    // A send's own light open, asked after the turn read's and answered before it.
    const sent = runtime.submit({ requestId: "req-9", botId: "shared", senderId: "one", text: "Also the gate", attachments: [] });
    (await released(2)).release();
    await sent;
    turn.release();
    (await released(3)).release();
    await vi.waitFor(() => expect(runtime.turn!("shared")).toBeDefined());
    expect(opens().filter(window => window !== "light")).toEqual([{ turns: 20 }, { start: "req-2" }, { start: "req-2" }]);
  });

  it("never orders versions from another runtime, whose generations restart", async () => {
    midTurn();
    const first = await runtime.conversation("shared", { history: false });
    const other = createHermesRuntime({ url: HERMES_URL, token: "isolated-contract-token" });
    try { expect(compareVersions((await other.conversation("shared", { history: false })).version, first.version)).toBeUndefined(); }
    finally { await other.close(); }
  });

  it("reads again each time a tool start supersedes a turn read, however many in a row", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    hermes.frame("tool.complete", { tool_id: "a" });
    for (let read = 1; read <= 4; read++) {
      const open = await released(read);
      // A tool start leaves the snapshot alone but supersedes the read on its way.
      if (read < 4) hermes.frame("tool.start", { tool_id: `t${read}`, name: "search" });
      open.release();
    }
    await vi.waitFor(() => expect(runtime.turn!("shared")?.toolCalls).toContainEqual(expect.objectContaining({ id: "t3", status: "running" })));
    expect(opens()).toEqual([{ turns: 20 }, ...Array(4).fill({ start: "req-2" })]);
  });

  it("never delays or supersedes a client's read with a turn read, whichever is answered first", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    hermes.frame("tool.complete", { tool_id: "a" });
    const turn = await released(1);
    const client = runtime.conversation("shared", { window: { start: "1" } });
    // The client's read opens at once, beside the turn read, and is answered after it without being asked again.
    const own = await released(2);
    turn.release();
    await vi.waitFor(() => expect(runtime.turn!("shared")).toBeDefined());
    own.release();
    expect((await client).messages.map(message => message.id)).toEqual(["1", "2", "req-2"]);
    expect(runtime.inflight!("shared")).toBeDefined();
    expect(opens()).toEqual([{ turns: 20 }, { start: "req-2" }, { start: "1" }]);
  });

  it("stores nothing ?inflight=1 and ?inflight=2 build on, and tells only the streams that follow turns", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    hermes.frame("message.delta", { text: "Looking." });
    const notices = vi.fn(), followed = vi.fn();
    runtime.watch!("shared", notices);
    runtime.followTurns!("shared", followed);
    hermes.frame("tool.complete", { tool_id: "a" });
    hermes.frame("message.delta", { text: " Found it." });
    await vi.waitFor(() => expect(followed).toHaveBeenCalledOnce());
    expect(runtime.turn!("shared")!.message.text).toBe("Looking. Found it.");
    // Only a client's read brings the reply back for the others, and no watcher heard the turn read.
    expect(runtime.inflight!("shared")).toBeUndefined();
    // The tool's finish is a change the turn event carries, so the notice names the version that event reaches.
    expect(notices.mock.calls).toEqual([[undefined, expect.stringMatching(/^[0-9a-f]{8}:\d+:\d+$/)], ["inflight"]]);
    await runtime.conversation("shared", { window: { turns: 20 } });
    expect(runtime.inflight!("shared")!.message.text).toBe("Looking. Found it.");
  });

  // A watcher is told which structural frames a turn event carries whole, and the version that event reaches, so a stream
  // that sends turn events can wait for it. Everything else, approvals and requests above all, only a read carries.
  describe("tells watchers which changes a turn event covers", () => {
    const frames: [string, () => void, boolean][] = [
      ["a turn starting, whose prompt a native turn may save later", () => hermes.frame("message.start", {}), false],
      ["a tool finishing", () => hermes.frame("tool.complete", { tool_id: "t1", name: "terminal" }), true],
      ["a progress line saved", () => hermes.frame("message.interim", { text: "Checking." }), true],
      ["the turn ending", () => hermes.frame("message.complete", { status: "complete" }), false],
      ["an error", () => hermes.frame("error", { message: "boom" }), false],
      ["a request cancelled", () => hermes.frame("request.cancel", { id: "ap-1" }), false],
      ["an approval asked", () => hermes.request("approval", "ap-1", { command: "ls" }), false],
      ["a frame the runtime does not know", () => hermes.frame("session.info", {}), false],
    ];
    it.each(frames)("%s", async (_, send, covered) => {
      midTurn();
      await runtime.conversation("shared", { window: { turns: 20 } });
      const notices = vi.fn(), followed = vi.fn();
      runtime.watch!("shared", notices);
      runtime.followTurns!("shared", followed);
      send();
      expect(notices).toHaveBeenCalledTimes(1);
      const [kind, version] = notices.mock.calls[0];
      expect(kind).toBeUndefined();
      // A change nothing carries is announced as ever, with the one argument.
      if (!covered) { expect(notices.mock.calls[0]).toEqual([undefined]); return; }
      await vi.waitFor(() => expect(followed).toHaveBeenCalled());
      hermes.frame("message.delta", { text: "Found it." });
      // The turn read after the frame reaches the version the notice named, so the event it sends covers the change.
      expect(compareVersions(runtime.turn!("shared")!.version, version)).toBeGreaterThanOrEqual(0);
    });

    it("never names a version on a growth notice, nor for a watcher of another assistant", async () => {
      midTurn();
      await runtime.conversation("shared", { window: { turns: 20 } });
      const own = vi.fn(), other = vi.fn();
      runtime.watch!("shared", own);
      runtime.watch!("hidden", other);
      hermes.frame("message.delta", { text: "Looking." });
      hermes.frame("tool.start", { tool_id: "t1", name: "terminal" });
      expect(own.mock.calls).toEqual([["inflight"], ["inflight"]]);
      expect(other).not.toHaveBeenCalled();
    });
  });

  it("leaves live state to clients' reads, so the roster shows what it did before the turn read", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    const followed = vi.fn();
    runtime.followTurns!("shared", followed);
    // Hermes asks for an approval, which someone answers elsewhere before the turn read's open.
    hermes.request("approval", "ap-1", { command: "ls" });
    await vi.waitFor(() => expect(followed).toHaveBeenCalledOnce());
    expect((await runtime.listBots()).find(bot => bot.id === "shared")!.activity).toBe("waiting");
  });

  it("never takes another session's frames for this assistant's while a turn read is on its way", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    hermes.frame("tool.complete", { tool_id: "a" });
    await released(1);
    const notices = vi.fn();
    runtime.watch!("shared", notices);
    hermes.sockets.at(-1)!.receive({ method: "event", params: { session_id: "another", type: "message.complete", payload: {} } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(notices).not.toHaveBeenCalled();
  });

  it("leaves settling a turn Hermes still reports running to clients' reads, so watchers get no extra change notice", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    const notices = vi.fn(), followed = vi.fn();
    runtime.watch!("shared", notices);
    runtime.followTurns!("shared", followed);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      hermes.frame("message.complete", { status: "complete" });
      await vi.waitFor(() => expect(followed).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(1500);
      expect(notices.mock.calls).toEqual([[undefined]]);
    } finally { vi.useRealTimers(); }
  });

  it("waits for a client's read asked since the last change, whose snapshot leaves the queued turn read nothing to read", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    const followed = vi.fn();
    runtime.followTurns!("shared", followed);
    hermes.holdOpens = true;
    hermes.frame("tool.complete", { tool_id: "a" });
    const first = await released(1);
    hermes.frame("message.interim", {});
    const client = runtime.conversation("shared", { window: { start: "1" } });
    first.release();
    (await released(2)).release();
    await client;
    await vi.waitFor(() => expect(followed).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(opens()).toEqual([{ turns: 20 }, { start: "req-2" }, { start: "1" }]);
  });

  it("does not wait for a client's read asked before the change, which is asked again after the turn read's open", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    const client = runtime.conversation("shared", { window: { start: "1" } });
    const stale = await released(1);
    hermes.frame("tool.complete", { tool_id: "a" });
    // The turn read opens at once, beside the client's superseded one.
    const turn = await released(2);
    expect(turn.params.window).toEqual({ start: "req-2" });
    stale.release();
    const retry = await released(3);
    expect(retry.params.window).toEqual({ start: "1" });
    // Answered out of order: the client's later open first. The turn read's answer is then superseded,
    // but the client's read stored the snapshot, so nothing is asked again.
    retry.release();
    await client;
    turn.release();
    await vi.waitFor(() => expect(runtime.turn!("shared")).toBeDefined());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(hermes.held).toHaveLength(3);
  });

  it("never brings back a reply that ended while its turn read was on its way", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.frame("message.delta", { text: "Looking." });
    hermes.holdOpens = true;
    saveSegment(4, "Looking.");
    hermes.frame("tool.complete", { tool_id: "a" });
    const stale = await released(1);
    saveSegment(5, "The barn is fine.");
    Object.assign(hermes, { running: false, runId: undefined, inflight: {} });
    hermes.frame("message.complete", { status: "complete" });
    stale.release();
    (await released(2)).release();
    await vi.waitFor(() => expect(runtime.turn!("shared")?.activity.state).toBe("done"));
    const live = runtime.turn!("shared")!;
    expect(live.message.text).toBe("");
    expect(live.turn!.messages.map(message => message.text)).toEqual(["Check the barn", "Looking.", "The barn is fine."]);
  });

  it("names the message before a turn that started while the last turn's read was on its way", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    saveSegment(4, "Barn is fine.");
    hermes.frame("tool.complete", { tool_id: "a" });
    const stale = await released(1);
    Object.assign(hermes, { runId: "run-3", inflight: { user: "And the gate?", assistant: "" } });
    hermes.frame("message.complete", { status: "complete" });
    hermes.history.push(row(5, "user", "And the gate?", { app_request_id: "req-3", app_run_id: "run-3" }));
    hermes.frame("message.start", {});
    stale.release();
    (await released(2)).release();
    await vi.waitFor(() => expect(runtime.turn!("shared")?.activity.runId).toBe("run-3"));
    // The window starts at the last turn the runtime knew, so the message before the new prompt is in it.
    expect(opens().at(-1)).toEqual({ start: "req-2" });
    expect(runtime.turn!("shared")!.turn).toEqual({ after: "4", messages: [expect.objectContaining({ id: "req-3" })] });
  });

  it("drops a turn read when Hermes disconnects, and versions after the reconnect are newer", async () => {
    midTurn();
    const before = await runtime.conversation("shared", { window: { turns: 20 } });
    runtime.followTurns!("shared", () => {});
    hermes.holdOpens = true;
    hermes.frame("tool.complete", { tool_id: "a" });
    await released(1);
    hermes.drop();
    await vi.waitFor(() => expect(runtime.turn!("shared")).toBeUndefined());
    hermes.holdOpens = false;
    // The transport reconnects after its backoff; the clients' change notices read again then.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    const after = await runtime.conversation("shared", { window: { turns: 20 } });
    vi.useRealTimers();
    expect(compareVersions(after.version, before.version)).toBeGreaterThan(0);
    // The dropped read is gone, not queued behind the reconnect.
    expect(opens()).toEqual([{ turns: 20 }, { start: "req-2" }, { turns: 20 }]);
  });

  it("versions each read by when it began, so a read a frame superseded never claims the newer version", async () => {
    midTurn();
    const first = await runtime.conversation("shared", { history: false });
    hermes.frame("tool.complete", { tool_id: "a" });
    const second = await runtime.conversation("shared", { history: false });
    expect(compareVersions(second.version, first.version)).toBeGreaterThan(0);
    hermes.holdOpens = true;
    const read = runtime.conversation("shared", { history: false });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const open = await released(attempt);
      hermes.frame("tool.complete", { tool_id: `burst-${attempt}` });
      open.release();
    }
    const superseded = await read;
    const now = await (hermes.holdOpens = false, runtime.conversation("shared", { history: false }));
    expect(compareVersions(superseded.version, second.version)).toBeGreaterThan(0);
    expect(compareVersions(superseded.version, now.version)).toBeLessThan(0);
  });
});

describe("an earlier page", () => {
  /** Ten settled turns, rows 1 to 20, before what `midTurn` adds. */
  const settled = () => Array.from({ length: 10 }, (_, turn) => [row(turn * 2 + 1, "user", `Post ${turn}?`), row(turn * 2 + 2, "assistant", `Post ${turn} set.`)]).flat();

  it("ends just before the message the client holds, with no live reply, and stores nothing live replies are built on", async () => {
    midTurn();
    hermes.history = [...settled(), ...hermes.history.map((saved, index) => ({ ...saved, row_id: 21 + index }))];
    hermes.inflight.assistant = "Looking";
    const page = await runtime.conversation("shared", { window: { before: "13", turns: 2 } });
    expect(page.messages.map(message => message.id)).toEqual(["9", "10", "11", "12"]);
    expect(page.window).toMatchObject({ earlier: 8, before: "13" });
    // An older add-on, which knows no `before`, still cuts from the same place.
    expect(hermes.opens().at(-1)!.params.window).toEqual({ before: "13", start: "13", turns: 2 });
    runtime.followTurns!("shared", () => {});
    hermes.frame("message.delta", { text: " in the barn" });
    expect(runtime.turn!("shared")).toBeUndefined();
    expect(runtime.inflight!("shared")).toBeUndefined();
    // The page names no turn start, so the next turn read reads the latest page.
    hermes.frame("tool.complete", { tool_id: "t1" });
    await vi.waitFor(() => expect(runtime.turn!("shared")).toBeDefined());
    expect(hermes.opens().at(-1)!.params.window).toEqual({ turns: 1 });
  });

  it("is never shared with a later read from its first message, which must reach the newest", async () => {
    hermes.history = settled();
    // Connecting and the first open change the conversation, so sharing starts after.
    await runtime.conversation("shared", { window: { turns: 20 } });
    // A read from a message is shared with the read that started there, until something changes.
    const latest = await runtime.conversation("shared", { window: { turns: 2 } });
    await runtime.conversation("shared", { window: { start: latest.messages[0].id } });
    expect(hermes.opens()).toHaveLength(2);
    const page = await runtime.conversation("shared", { window: { before: "13", turns: 2 } });
    const from = await runtime.conversation("shared", { window: { start: page.messages[0].id } });
    expect(from.messages.map(message => message.id)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 9)));
    expect(hermes.opens()).toHaveLength(4);
  });
});

describe("the live reply's saved text", () => {
  // Hermes names the native turn's prompt before it saved it. No saved row matches, so the boundary falls back to the last
  // prompt, as on main, and the earlier native turn's "Checked." under the same app run is stripped from this turn's live
  // text, which starts with the same words. Main strips it too. It clears once Hermes saves the prompt.
  it("falls back to the last prompt while the native turn's prompt is not saved", async () => {
    midTurn();
    saveSegment(4, "Checked.");
    Object.assign(hermes, { inflight: { user: "Check the loft", assistant: "Checked. Loft" } });
    const read = await runtime.conversation("shared", { window: { turns: 20 } });
    expect(read.messages.at(-1)).toMatchObject({ id: "live-one-inflight", text: "Loft" });
  });
  // The fallback is the last shown prompt, not the app run's first: queued guidance started a native turn of its own under the
  // same run, and the earlier turn's "Barn is dry." would stop stripping before either "Checked.".
  it("falls back to the last shown prompt for a hidden one, so the turn before it in the same run is not stripped", async () => {
    midTurn();
    saveSegment(4, "Barn is dry.");
    hermes.history.push(row(5, "user", "Check the loft", { app_request_id: "steer-2", app_run_id: "run-2", app_steering: true }));
    saveSegment(6, "Checked.");
    hermes.history.push(row(7, "user", "Continue toward the goal.", { display_kind: "hidden", app_run_id: "run-2" }));
    saveSegment(8, "Checked.");
    Object.assign(hermes, { inflight: { user: "Continue toward the goal.", assistant: "Checked. Loft dry." } });
    const read = await runtime.conversation("shared", { window: { turns: 20 } });
    expect(read.messages.at(-1)).toMatchObject({ id: "live-one-inflight", text: "Loft dry." });
  });
  // How the add-on saves a prompt's text and how Hermes reports it differ by form. Guidance steered in place after a saved
  // segment makes the match matter: the last prompt is the guidance, so only the turn's own prompt strips "Read it.".
  const pdf = { path: "/uploads/a.pdf", name: "a.pdf", mime: "application/pdf" };
  const other = { path: "/uploads/b two.pdf", name: "b two.pdf", mime: "application/pdf" };
  const photo = { path: "/uploads/c.png", name: "c.png", mime: "image/png" };
  it.each([
    // The app sends text, a newline and the references; the add-on saves the text, and Hermes strips the whole prompt.
    ["a file sent alone", '\n@file:"/uploads/a.pdf"', "", [pdf], '@file:"/uploads/a.pdf"'],
    ["text with spaces around it and two files", ' Read these \n@file:"/uploads/a.pdf"\n@file:"/uploads/b two.pdf"', " Read these ", [pdf, other],
      'Read these \n@file:"/uploads/a.pdf"\n@file:"/uploads/b two.pdf"'],
    // Images are staged, never referenced in the text, so an image sent alone is an empty prompt, not a missing one.
    ["an image sent alone", "@image:/uploads/c.png", "", [photo], ""],
  ])("finds the native turn's prompt for %s, so a segment saved before a steer shows once", async (_name, text, display, files, reported) => {
    midTurn();
    hermes.history[2] = row(3, "user", text, { app_request_id: "req-2", app_run_id: "run-2", app_display_text: display, app_attachments: files });
    saveSegment(4, "Read it.");
    hermes.history.push(row(5, "user", "Summarize it", { app_request_id: "steer-2", app_run_id: "run-2", app_steering: true }));
    Object.assign(hermes, { inflight: { user: reported, assistant: "Read it. Two pages." } });
    const read = await runtime.conversation("shared", { window: { turns: 20 } });
    expect(read.messages.at(-1)).toMatchObject({ id: "live-one-inflight", text: "Two pages." });
  });
});

describe("withSeams", () => {
  it("starts a paragraph at each seam text follows, unless a blank line is already there", () => {
    expect(withSeams("Looking.Found it.", [8])).toBe("Looking.\n\nFound it.");
    expect(withSeams("A. B. C.", [2, 5])).toBe("A.\n\n B.\n\n C.");
    expect(withSeams("Looking.\n\nFound.", [8])).toBe("Looking.\n\nFound.");
    expect(withSeams("Looking.\n \nFound.", [9])).toBe("Looking.\n \nFound.");
    // One newline is not a paragraph in Markdown.
    expect(withSeams("Looking.\nFound.", [9])).toBe("Looking.\n\n\nFound.");
  });

  it("adds nothing at a seam no text follows yet, nor at one outside the text or repeated", () => {
    expect(withSeams("Looking.", [8])).toBe("Looking.");
    expect(withSeams("Looking.", [0, 20])).toBe("Looking.");
    expect(withSeams("AB", [1, 1])).toBe("A\n\nB");
  });
});

describe("turnRows", () => {
  const message = (id: string, role: Message["role"], extra: Partial<Message> = {}): Message => ({ id, role, text: id, ...extra });
  const shown = [message("u1", "user"), message("a1", "assistant"), message("u2", "user"), message("p0", "assistant", { interim: true }),
    message("a2", "assistant"), message("s1", "user", { steered: true, sender: { id: "two", name: "Two" } }), message("live-inflight", "assistant")];
  // Hermes names the native turn's prompt. Steered in place, guidance leaves it as the turn's own; queued, the guidance is the prompt.
  it.each([
    ["guidance steered into it", "u2", { after: "a1", messages: shown.slice(2, 6) }],
    ["guidance Hermes queued as a native turn of its own", "s1", { after: "a2", messages: shown.slice(5, 6) }],
    // Between native turns Hermes names none, and the live text has been cleared.
    ["no prompt reported", undefined, { after: "a2", messages: shown.slice(5, 6) }],
    // Before Hermes saved the prompt, or for a hidden one, the last prompt, as on main.
    ["a prompt not saved yet", "u3", { after: "a2", messages: shown.slice(5, 6) }],
    // Only steered guidance follows a running turn's prompt, so a match before the last prompt that is not guidance is an
    // earlier turn's, never this one's.
    ["a prompt only a turn before the last one has", "u1", { after: "a2", messages: shown.slice(5, 6) }],
  ])("starts at the native turn's prompt with %s, keeps progress lines, and leaves out the live reply", (_name, prompt, rows) => {
    expect(turnRows(shown, prompt, "live-inflight", 0, false)).toEqual(rows);
  });
  it("starts at the last prompt with the native turn's text when an earlier one says the same", () => {
    const again = [message("u1", "user", { text: "Check" }), message("a1", "assistant"), message("u2", "user", { text: " Check " })];
    expect(turnRows(again, "Check", "x-inflight", 0, false)).toEqual({ after: "a1", messages: again.slice(2) });
  });
  it("says the turn starts the history only for an uncut read, and never starts it among a window's earlier context", () => {
    const shown = [message("u1", "user", { files: [] }), message("u2", "user"), message("a2", "assistant")];
    expect(turnRows(shown.slice(1), "u2", "x-inflight", 0, false)).toEqual({ after: null, messages: shown.slice(1) });
    expect(turnRows(shown, "u1", "x-inflight", 1, true)).toEqual({ messages: shown.slice(1) });
    expect(turnRows([], "", "x-inflight", 0, false)).toEqual({ after: null, messages: [] });
  });
});


describe("the native turn's start, as the add-on reports it", () => {
  const stamp = (seconds: number) => new Date(seconds * 1000).toISOString();
  const message = (id: string, role: Message["role"], seconds?: number, extra: Partial<Message> = {}): Message =>
    ({ id, role, text: id, ...(seconds === undefined ? {} : { createdAt: stamp(seconds) }), ...extra });
  // An earlier turn at 100 and 101, a native turn from 200 whose guidance was steered in at 202.
  const rows = [message("u1", "user", 100), message("a1", "assistant", 101), message("u2", "user", 200), message("a2", "assistant", 201),
    message("s1", "user", 202, { steered: true })];
  const start = (startedAt: unknown, prompt?: string, from = 0, shown = rows) => turnStart(shown, prompt, from, nativeStartedAt({ started_at: startedAt }));

  it.each([
    ["missing", undefined], ["null", null], ["a string", "1790779733"], ["not a number", NaN], ["infinite", Infinity], ["zero", 0], ["negative", -5],
  ])("reports no start for a started_at that is %s, so the words decide", (_name, value) => {
    expect(nativeStartedAt({ started_at: value })).toBeUndefined();
    expect(nativeStartedAt(undefined)).toBeUndefined();
    expect(start(value, "u2")).toBe(2);
    // With no usable start the last prompt is the fallback, as on main.
    expect(start(value, "none")).toBe(4);
  });

  it("starts at the first row Hermes saved at or after the start, on both sides of the boundary", () => {
    expect(start(200)).toBe(2);
    expect(start(199.999)).toBe(2);
    expect(start(200.001)).toBe(3);
    expect(start(201.5)).toBe(4);
  });
  it("starts after the last row when the turn has saved nothing yet, wherever its prompt's words point", () => {
    expect(start(300, "u2")).toBe(rows.length);
    expect(start(300, "s1")).toBe(rows.length);
  });
  it("takes the start over the prompt's words, so guidance worded like the prompt is not the start", () => {
    expect(start(199, "s1")).toBe(2);
    expect(turnStart(rows, "s1")).toBe(4);
  });
  it("reads a row's time as whole milliseconds, as a row's createdAt is, so a row saved at the start is never before it", () => {
    const at = 1790779733.179978;
    const saved = [message("u1", "user", at - 60), message("u2", "user", at)];
    expect(Date.parse(saved[1].createdAt!)).toBe(1790779733179);
    expect(nativeStartedAt({ started_at: at })).toBe(1790779733179);
    expect(turnStart(saved, undefined, 0, nativeStartedAt({ started_at: at }))).toBe(1);
  });
  it("never reaches back past the window's earlier context", () => {
    expect(start(100, undefined, 2)).toBe(2);
    expect(start(300, undefined, 2)).toBe(rows.length);
  });
  it("falls back to the words when a message after the start has no time, since where the start falls cannot be said", () => {
    const untimed = [message("u1", "user", 100), message("a1", "assistant", 101), message("u2", "user"), message("a2", "assistant", 201)];
    expect(start(200, "u2", 0, untimed)).toBe(2);
    expect(start(200, "none", 0, untimed)).toBe(2);
    expect(start(200, undefined, 0, [message("u1", "user", 100), message("a1", "assistant", 101), message("u2", "user", 200), message("a2", "assistant")])).toBe(2);
    // An untimed message before the first one the start rules out is never looked at.
    expect(start(200, "none", 0, [message("u0", "user"), ...rows])).toBe(3);
  });
  it("says the turn's prompt is saved when the turn's first saved message is a prompt, and by its words without a start", () => {
    const saved = (startedAt: number | undefined, prompt: string | undefined, shown = rows) => promptSaved(shown, prompt, nativeStartedAt({ started_at: startedAt }));
    // The turn from 200 starts with a prompt row, whatever words Hermes reports.
    expect(saved(200, "other words")).toBe(true);
    // The turn's first saved message is a segment, as for a hidden prompt, or nothing has been saved yet.
    expect(saved(200.5, "u2")).toBe(false);
    expect(saved(300, "u2")).toBe(false);
    // An older add-on: the words decide, among the trailing prompts.
    expect(saved(undefined, "u2")).toBe(true);
    expect(saved(undefined, "s1")).toBe(true);
    expect(saved(undefined, "u1")).toBe(false);
    // A message with no time leaves the words to decide.
    expect(saved(200, "s1", [message("u2", "user"), message("a2", "assistant", 201), message("s1", "user", 202, { steered: true })])).toBe(true);
    expect(saved(200, "other words", [message("u2", "user"), message("a2", "assistant", 201)])).toBe(false);
  });
  it("starts the turn with its own rows through turnRows, and with none when it has saved nothing", () => {
    const shown = [...rows, message("live-inflight", "assistant")];
    expect(turnRows(shown, "s1", "live-inflight", 0, false, nativeStartedAt({ started_at: 200 }))).toEqual({ after: "a1", messages: rows.slice(2) });
    expect(turnRows(shown, "s1", "live-inflight", 0, false, nativeStartedAt({ started_at: 300 }))).toEqual({ after: "s1", messages: [] });
  });
});
