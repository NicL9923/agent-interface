import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHermesRuntime } from "../src/server/hermes.js";
import { turnRows } from "../src/server/hermes-mapping.js";
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
  it("reads the turn itself after a structural frame, once for every follower, from the turn's first message", async () => {
    midTurn();
    await runtime.conversation("shared", { window: { turns: 20 } });
    const one = vi.fn(), two = vi.fn();
    runtime.followTurns!("shared", one);
    runtime.followTurns!("shared", two);
    hermes.frame("message.delta", { text: "Looking. " });
    saveSegment(4, "Looking.");
    hermes.frame("tool.start", { tool_id: "t1", name: "terminal" });
    hermes.frame("tool.complete", { tool_id: "t1", name: "terminal", result: "ok" });
    expect(runtime.turn!("shared")).toBeUndefined();
    await vi.waitFor(() => expect(one).toHaveBeenCalledOnce());
    expect(two).toHaveBeenCalledOnce();
    expect(opens()).toEqual([{ turns: 20 }, { start: "req-2" }]);
    hermes.frame("message.delta", { text: "Found it." });
    const live = runtime.turn!("shared")!;
    // The saved segment is a row of the turn, so the live reply leaves it out.
    expect(live.turn).toEqual({ messages: [expect.objectContaining({ id: "req-2" }), expect.objectContaining({ id: "4", text: "Looking." })] });
    expect(live.message.text).toBe("Found it.");
    expect(live.toolCalls).toEqual([expect.objectContaining({ id: "t1", status: "completed" })]);
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
    expect(notices.mock.calls).toEqual([[undefined], ["inflight"]]);
    await runtime.conversation("shared", { window: { turns: 20 } });
    expect(runtime.inflight!("shared")!.message.text).toBe("Looking. Found it.");
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

