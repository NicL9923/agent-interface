import { afterAll, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { createHermesRuntime } from "../../src/server/hermes.js";
import type { InflightDelta, TurnEvent } from "../../src/shared/types.js";
import { fakeHermes, HERMES_URL, row } from "../../tests/helpers/fake-hermes.js";

/**
 * How long a web client's live text stops after a tool finishes while the server's turn read is slow. The real
 * app and Hermes runtime, with only Hermes's socket faked, on real time: one word every WORD_MS, two tool calls,
 * and every open (the server's turn read and the client's own reads) answered after READ_MS. The client reads on
 * each change notice, as the app does. Prints, per word, how long after Hermes streamed it the stream carried it.
 */
const READ_MS = Number(process.env.READ_MS ?? 2800), WORD_MS = Number(process.env.WORD_MS ?? 50);
const TOOLS = [1000, 5000], TOOL_RUN_MS = 300, END_MS = 9000;
const origin = "http://127.0.0.1:3000";
let close: (() => Promise<unknown>) | undefined;
afterAll(async () => { await close?.(); vi.unstubAllGlobals(); });

it("measures the live text freeze after each tool", async () => {
  const hermes = fakeHermes();
  const runtime = createHermesRuntime({ url: HERMES_URL, token: "isolated-contract-token" });
  const { app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:" }), runtime, { background: false });
  close = async () => { app.server.closeAllConnections(); await app.close(); };
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const cookie = (await fetch(`${base}/api/auth/local`, { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ member: "one" }) })).headers.getSetCookie()[0].split(";")[0];
  hermes.history = [row(1, "user", "Fence?", { app_run_id: "run-1" }), row(2, "assistant", "Fixed.", { app_run_id: "run-1" }),
    row(3, "user", "Check the barn", { app_request_id: "req-2", app_run_id: "run-2" })];
  Object.assign(hermes, { running: true, runId: "run-2", inflight: { user: "Check the barn", assistant: "" } });
  const read = async () => { await (await fetch(`${base}/api/bots/shared/conversation?turns=20`, { headers: { cookie } })).arrayBuffer(); };

  const started = performance.now(), now = () => performance.now() - started;
  // When the stream first carried each word, and when Hermes streamed it.
  const carried = new Map<number, number>(), streamed = new Map<number, number>();
  const notes: string[] = [];
  const response = await fetch(`${base}/api/bots/shared/events?inflight=3`, { headers: { cookie } });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", reads = 0;
  const pump = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += chunk.value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const at = now();
        if (frame.startsWith("data: change")) { notes.push(`${at.toFixed(0)} change notice, client reads`); reads++; void read(); continue; }
        const [event, data] = frame.split("\n");
        let text = "";
        if (event === "event: inflight-delta") text = (JSON.parse(data.slice(6)) as InflightDelta).appendText ?? "";
        else if (event === "event: turn") {
          const turn = JSON.parse(data.slice(6)) as TurnEvent;
          text = turn.message.text;
          notes.push(`${at.toFixed(0)} turn event, ${turn.messages.length} saved, live ${JSON.stringify(turn.message.text.slice(0, 24))}`);
        } else continue;
        for (const match of text.matchAll(/w(\d+)/g)) if (!carried.has(Number(match[1]))) carried.set(Number(match[1]), at);
      }
    }
  })().catch(() => {});
  await read();
  hermes.openDelay = READ_MS;

  let word = 0, segment = "", nextRow = 4;
  const frame = (type: string, payload = {}) => { hermes.frame(type, payload); };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const completes: number[] = [];
  for (let at = 0; at < END_MS; at += WORD_MS) {
    const tool = TOOLS.find(start => at >= start && at < start + TOOL_RUN_MS);
    if (TOOLS.includes(at)) {
      // Hermes saves the segment before the tool that follows it.
      hermes.history.push(row(nextRow++, "assistant", segment, { app_run_id: "run-2" }));
      segment = "";
      frame("tool.start", { tool_id: `t${at}`, name: "terminal" });
    } else if (TOOLS.includes(at - TOOL_RUN_MS)) {
      frame("tool.complete", { tool_id: `t${at - TOOL_RUN_MS}`, name: "terminal" });
      completes.push(now());
      notes.push(`${now().toFixed(0)} tool.complete`);
    }
    if (!tool) {
      const text = `w${++word} `;
      segment += text;
      streamed.set(word, now());
      frame("message.delta", { text });
    }
    await wait(Math.max(0, at + WORD_MS - now()));
  }
  await wait(READ_MS + 500);
  await reader.cancel();
  await pump;

  const lines = [`READ_MS=${READ_MS} WORD_MS=${WORD_MS}, client reads on change notices: ${reads}`];
  for (const [index, complete] of completes.entries()) {
    const after = [...streamed].filter(([, at]) => at >= complete && at < complete + READ_MS + 1000);
    const delays = after.map(([n, at]) => (carried.get(n) ?? Infinity) - at).sort((a, b) => a - b);
    const pick = (q: number) => delays[Math.min(delays.length - 1, Math.floor(q * delays.length))];
    lines.push(`tool ${index + 1}: ${after.length} words in the ${READ_MS + 1000} ms after it finished; word delay p50 ${pick(0.5).toFixed(0)} ms, ` +
      `p95 ${pick(0.95).toFixed(0)} ms, max ${delays.at(-1)!.toFixed(0)} ms`);
  }
  const steady = [...streamed].filter(([, at]) => at < TOOLS[0] - 100).map(([n, at]) => (carried.get(n) ?? Infinity) - at).sort((a, b) => a - b);
  lines.push(`before any tool: word delay p50 ${steady[Math.floor(steady.length / 2)].toFixed(0)} ms, max ${steady.at(-1)!.toFixed(0)} ms`);
  console.log([...lines, ...notes].join("\n"));
  expect(carried.size).toBeGreaterThan(0);
});
