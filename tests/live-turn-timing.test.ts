import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as realDelay } from "node:timers/promises";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { createHermesRuntime } from "../src/server/hermes.js";
import { fakeHermes, HERMES_URL, row, type FakeHermes } from "./helpers/fake-hermes.js";

/**
 * How long live text stalls after each change to a turn's structure, end to end: the real app and Hermes
 * runtime, a fake Hermes socket whose opens take HERMES_MS of virtual time, and a client that reads the
 * conversation on each change notice, one read at a time, as the web client does. Time is virtual, so
 * throttles and reads cost their stated time; sockets stay real, and each step waits for them to settle.
 * Set MEASURE=1 to print the table.
 */
const HERMES_MS = 60;
const STEP_MS = 5;
const origin = "http://127.0.0.1:3000";
const apps: { close(): Promise<unknown>; server: { closeAllConnections(): void } }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) { app.server.closeAllConnections(); await app.close(); }
  vi.unstubAllGlobals();
});

async function client(hermes: FakeHermes, mode: string) {
  const runtime = createHermesRuntime({ url: HERMES_URL, token: "isolated-contract-token" });
  const { app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  apps.push(app);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const signIn = await fetch(`${base}/api/auth/local`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ member: "one" }) });
  const cookie = signIn.headers.getSetCookie()[0].split(";")[0];
  const { csrfToken } = await signIn.json() as { csrfToken: string };
  // A send, whose own change notice goes as it is answered, as for any conversation write.
  const send = async (text: string) => {
    const response = await fetch(`${base}/api/bots/shared/messages`, { method: "POST",
      headers: { cookie, origin, "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ requestId: crypto.randomUUID(), text }) });
    expect(response.status).toBe(200);
  };
  let pending = 0, again = false;
  // Each time text reached the client, in virtual time, from a live event or a read.
  const arrivals: { at: number; text: string }[] = [];
  const read = async (): Promise<void> => {
    if (pending) { again = true; return; }
    pending++;
    try {
      const { messages } = await (await fetch(`${base}/api/bots/shared/conversation?turns=20`, { headers: { cookie } })).json() as { messages: { id: string; text: string }[] };
      // A read shows the text too, saved or as its own live tail, which is how a growth stream's client
      // sees text after a tool.
      arrivals.push({ at: Date.now(), text: messages.map(message => message.text).join(" ") });
    } finally { pending--; }
    if (again) { again = false; return read(); }
  };
  await read();
  const response = await fetch(`${base}/api/bots/shared/events?inflight=${mode}`, { headers: { cookie } });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += chunk.value;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: change")) void read();
        const [event, data] = frame.split("\n");
        if (!event.startsWith("event: ") || !data?.startsWith("data: ")) continue;
        const value = JSON.parse(data.slice(6));
        const text = event === "event: inflight-delta" ? value.appendText ?? "" : value.message?.text ?? "";
        if (["event: inflight", "event: inflight-delta", "event: turn"].includes(event)) arrivals.push({ at: Date.now(), text });
      }
    }
  })().catch(() => {});
  return { arrivals, send, pending: () => pending, close: () => reader.cancel() };
}

/**
 * A turn of text, then `tools` tools each followed by more text, then the turn ends. Opens are counted from the
 * send through the client's reads after the turn ended.
 */
async function measure(mode: string, tools: number) {
  const hermes = fakeHermes();
  hermes.history = [row(1, "user", "Fence?"), row(2, "assistant", "Fixed.")];
  const watching = await client(hermes, mode);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  hermes.openDelay = HERMES_MS;
  const start = Date.now();
  const now = () => Date.now() - start;
  // Steps virtual time, letting sockets deliver and the client's read finish before time moves on,
  // except while that read waits on Hermes, whose answer is itself a timer.
  const until = async (at: number) => {
    while (now() < at) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
      for (let spin = 0; spin < 200; spin++) {
        await realDelay(1);
        if (!watching.pending() || hermes.delayed) break;
      }
    }
  };
  const opensBefore = hermes.opens().length;
  const structural: { name: string; at: number; token: string }[] = [];
  let reply = "", t = 0;
  /** A structural frame, and the token that follows it at once; the stall is until that token shows. */
  const after = async (name: string, frame: () => void, token: string) => {
    await until(t);
    frame();
    structural.push({ name, at: Date.now(), token });
    hermes.frame("message.delta", { text: token });
    reply += token;
  };
  const tokens = async (words: string[]) => {
    for (const word of words) { t += 50; await until(t); hermes.frame("message.delta", { text: word }); reply += word; }
  };
  // The send is answered, then its turn starts a moment later.
  Object.assign(hermes, { runId: "run-2" });
  let answered = false;
  const sent = watching.send("Walk the line").finally(() => { answered = true; });
  for (let step = 0; !answered; step++) {
    if (step > 400) throw new Error("The send was never answered.");
    await until(now() + STEP_MS);
  }
  await sent;
  const sentAt = now();
  Object.assign(hermes, { running: true, inflight: { user: "Walk the line", assistant: "" } });
  t = sentAt + 20;
  await after("message.start", () => {
    hermes.history.push(row(3, "user", "Walk the line", { app_request_id: "req-2", app_run_id: "run-2" }));
    hermes.frame("message.start");
  }, "Walking ");
  await tokens(["the ", "north ", "line. "]);
  for (let tool = 1; tool <= tools; tool++) {
    t += 50;
    await until(t);
    hermes.history.push(row(10 + tool * 2, "assistant", reply.trim(), { app_run_id: "run-2" }));
    reply = "";
    hermes.frame("tool.start", { tool_id: `t${tool}`, name: "terminal" });
    t += 400;
    await after(`tool.complete ${tool}`, () => hermes.frame("tool.complete", { tool_id: `t${tool}`, name: "terminal" }), `Post${tool} `);
    await tokens(["checked ", "post ", `${tool}. `, "Next ", "one. "]);
  }
  t += 50;
  await until(t);
  hermes.history.push(row(100, "assistant", reply.trim(), { app_run_id: "run-2" }));
  Object.assign(hermes, { running: false, runId: undefined, inflight: {} });
  hermes.frame("message.complete", { status: "complete" });
  await until(t + 2500);
  if (watching.pending() || hermes.delayed) throw new Error("A read was still on its way when opens were counted.");
  const gaps = structural.map(({ name, at, token }) => {
    const shown = watching.arrivals.find(arrival => arrival.at >= at && arrival.text.includes(token));
    return { name, ms: shown ? shown.at - at : Infinity };
  });
  const opens = hermes.opens().length - opensBefore;
  if (process.env.MEASURE_DEBUG) console.info(mode, JSON.stringify(structural.map(s => [s.name, s.at - start])), JSON.stringify(watching.arrivals.map(a => [a.at - start, a.text])), JSON.stringify(hermes.opens().map(o => o.params.window)));
  await watching.close();
  return { gaps, opens };
}

describe("live text after a change to the turn's structure", () => {
  it("resumes within one Hermes read on a turn stream, where a growth stream waits for the client's read, for one more open per frame", { timeout: 60_000 }, async () => {
    const modes = (process.env.MEASURE_MODES ?? "2,3").split(",");
    const results = new Map<string, Awaited<ReturnType<typeof measure>>>();
    for (const mode of modes) {
      results.set(mode, await measure(mode, 2));
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
    const ten = new Map<string, number>();
    for (const mode of modes) {
      ten.set(mode, (await measure(mode, 10)).opens);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
    if (process.env.MEASURE) {
      for (const [mode, { gaps, opens }] of results)
        console.info(`?inflight=${mode}: ${gaps.map(gap => `${gap.name} ${gap.ms} ms`).join(", ")}; Hermes opens ${opens}; ten-tool turn opens ${ten.get(mode)}`);
    }
    // The ledger and the PR quote these figures, so a change that moves them fails here until they are updated.
    // ?inflight=2 is the baseline origin/main measured the same: after each tool its text waits for a throttled
    // change notice and the client's read. On ?inflight=3 the token right after each frame shows once the server's
    // own read lands, one Hermes read and a measuring step later, for one more open per structural frame, less the
    // client's own read after a tool or a start, which the turn event covers and its change notice no longer asks for
    // (10 and 26 before that, 10 and 18 now: the two-tool turn is too short for the notice throttle to have sent more).
    const expected: Record<string, { ms: number[]; opens: number; ten: number }> = {
      "2": { ms: [105, 445, 745], opens: 6, ten: 14 },
      "3": { ms: [61, 61, 61], opens: 10, ten: 18 },
    };
    for (const mode of modes) {
      const { gaps, opens } = results.get(mode)!;
      expect({ ms: gaps.map(gap => gap.ms), opens, ten: ten.get(mode) }, `?inflight=${mode}`).toEqual(expected[mode]);
    }
    for (const gap of results.get("3")?.gaps ?? []) expect(gap.ms, gap.name).toBeLessThanOrEqual(HERMES_MS + 3 * STEP_MS);
  });
});
