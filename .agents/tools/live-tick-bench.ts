/**
 * Measures what a streaming reply costs the server per event stream: timer wakeups, bytes written and CPU,
 * for each `?inflight=` mode, with the tick the checked-out code has. A child process runs the real app over a
 * scripted runtime that grows each streaming reply by 4 characters every 25 ms (160 a second, a fast model's
 * token rate) and notices each growth as Hermes's frames do. Each tick builds the reply with the runtime's own
 * `inflightMessage` over a turn of five saved rows. This process opens the streams over raw sockets
 * and counts what arrives. Nothing leaves the machine.
 *
 *   npx tsx .agents/tools/live-tick-bench.ts [--seconds 10] [--repeats 3] [--label name]
 *
 * Cases, each run for `--seconds` in every mode:
 * - idle: 10 streams open on 5 assistants, nothing streaming. Shows whether any tick runs with nothing to send.
 * - one: 1 stream, 1 reply growing from empty.
 * - household: 10 streams on 5 assistants, 3 replies growing, each watched by 2 streams, 4 streams idle.
 * - long: 10 streams as above, each reply growing from 20,000 characters.
 * Prints one JSON line per run and a table. CPU is the server process's user and system time, less a baseline
 * run of the same replies with no stream open, so it is the streams' share; the median of `--repeats` runs.
 * Each window starts after a second of growth, so a delta stream's opening whole reply is not counted.
 */
import { fork } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };

type Case = { name: string; streams: number; streaming: number; from: number };
const CASES: Case[] = [
  { name: "idle", streams: 10, streaming: 0, from: 0 },
  { name: "one", streams: 1, streaming: 1, from: 0 },
  { name: "household", streams: 10, streaming: 3, from: 0 },
  { name: "long", streams: 10, streaming: 3, from: 20_000 },
];
const BOTS = 5;
type Report = { cpuMs: number; wakeups: number; seconds: number };

if (args[0] === "--serve") await serve();
else await drive();

async function serve() {
  // Counts every timer callback the app runs. The scripted replies grow on node:timers' own setInterval,
  // which this does not wrap, so their 40 wakeups a second are not counted.
  let wakeups = 0;
  const wrap = <F extends (callback: (...a: unknown[]) => void, ...rest: unknown[]) => unknown>(original: F) =>
    ((callback: (...a: unknown[]) => void, ...rest: unknown[]) => original((...a: unknown[]) => { wakeups++; callback(...a); }, ...rest)) as unknown as F;
  globalThis.setTimeout = wrap(globalThis.setTimeout);
  globalThis.setInterval = wrap(globalThis.setInterval);
  const { setInterval: grow, clearInterval: stopGrowing } = await import("node:timers");
  const { createApp } = await import("../../src/server/app.js");
  const { loadConfig } = await import("../../src/server/config.js");
  const { botFixture, capabilitiesFixture, conversationFixture } = await import("../../tests/helpers/runtime-fixtures.js");
  const { inflightMessage } = await import("../../src/server/hermes-mapping.js");
  type Message = import("../../src/shared/types.js").Message;
  type Runtime = import("../../src/shared/types.js").Runtime;
  type Inflight = import("../../src/shared/types.js").Inflight;

  const bots = Array.from({ length: BOTS }, (_, index) => botFixture({ id: `bot${index}`, name: `Bot ${index}`, shared: true }));
  const filler = "The north gate is latched and the chain runs through the second post where the mare cannot reach it. ";
  const replies = new Map<string, string>();
  const watchers = new Map<string, Set<(kind?: "inflight") => void>>();
  // Each tick builds the live reply as the Hermes runtime does, from a turn snapshot: the prompt, a progress
  // line and three tool rows with 16 KB results, as .agents/tools/streaming-preview.ts seeds them.
  const result = JSON.stringify({ entries: Array.from({ length: 256 }, (_, index) => ({ post: index, state: "latched", note: "checked at dusk" })) });
  const rows = (botId: string): Message[] => [
    { id: `${botId}-prompt`, runId: `${botId}-run`, role: "user", text: "Check the fences and tell me what needs fixing." },
    { id: `${botId}-progress`, runId: `${botId}-run`, role: "assistant", interim: true, text: "Let me read the gate log first." },
    ...["terminal", "read_file", "web_search"].map((name, call): Message => ({ id: `${botId}-tool-${call}`, runId: `${botId}-run`, role: "tool", text: "",
      toolCall: { id: `${botId}-call-${call}`, name, status: "completed", arguments: "{}", result } })),
  ];
  const turns = new Map(bots.map(bot => [bot.id, rows(bot.id)]));
  const live = (botId: string): Inflight | undefined => {
    const text = replies.get(botId);
    if (text === undefined) return undefined;
    const value = { session_id: botId, app_run_id: `${botId}-run`, info: { running: true }, inflight: { user: "Check the fences and tell me what needs fixing.", assistant: text } };
    return { botId, message: inflightMessage(value, turns.get(botId)!, undefined), activity: { state: "thinking", runId: `${botId}-run` }, toolCalls: [] };
  };
  // Optional methods the app probes for are left out; anything else the bench did not script fails by name.
  const unscripted = (name: string) => async (): Promise<never> => { throw new Error(`The bench does not script ${name}.`); };
  const runtime = {
    ...Object.fromEntries(["saveBot", "deleteBot", "stop", "generatePortrait", "steer", "answerRequest", "approve", "upload", "download", "tools",
      "setTools", "skills", "setSkills", "saveRoutine", "deleteRoutine", "submit", "lookupSubmission"].map(name => [name, unscripted(name)])),
    status: async () => ({ connected: true, code: "ready" }),
    capabilities: async () => capabilitiesFixture({ chat: { supported: true }, durableEvents: { supported: true } }),
    listBots: async () => bots,
    botDetail: async (botId: string) => bots.find(bot => bot.id === botId)!,
    conversation: async (botId: string) => conversationFixture({ botId }),
    inflight: live,
    turn: (botId: string) => { const value = live(botId); return value && { ...value, version: "bench:0:1", turn: { messages: turns.get(botId)!, after: null } }; },
    followTurns: () => () => {},
    routines: async () => [],
    discoverEvents: async (cursor: string) => ({ cursor, events: [] }),
    watch(botId: string, changed: (kind?: "inflight") => void) {
      const set = watchers.get(botId) ?? new Set();
      watchers.set(botId, set.add(changed));
      return () => { set.delete(changed); };
    },
    close: async () => {},
  } as unknown as Runtime;
  const { app } = await createApp(loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", HOST: "127.0.0.1", LOG_LEVEL: "warn" }), runtime, { background: false });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  process.send!({ base });
  // "start" grows the replies, "measure" reports the next window's cost, "stop" ends the replies.
  let growing: ReturnType<typeof grow> | undefined;
  process.on("message", async (message: { start?: { streaming: number; from: number }; measure?: number; stop?: true }) => {
    if (message.start) {
      const { streaming, from } = message.start;
      for (let index = 0; index < streaming; index++) replies.set(`bot${index}`, filler.repeat(Math.ceil(from / filler.length) + 1).slice(0, from));
      growing = grow(() => {
        for (const [botId, text] of replies) {
          const at = text.length % filler.length;
          replies.set(botId, text + (filler + filler).slice(at, at + 4));
          for (const changed of watchers.get(botId) ?? []) changed("inflight");
        }
      }, 25);
    }
    if (message.measure) {
      const cpu = process.cpuUsage(), startWakeups = wakeups;
      await sleep(message.measure * 1000);
      const used = process.cpuUsage(cpu);
      const report: Report = { cpuMs: (used.user + used.system) / 1000, wakeups: wakeups - startWakeups, seconds: message.measure };
      process.send!({ report });
    }
    if (message.stop) { stopGrowing(growing); replies.clear(); process.send!({ stopped: true }); }
  });
}

async function drive() {
  const seconds = Number(flag("--seconds", "10")), label = flag("--label", "checkout");
  const child = fork(fileURLToPath(import.meta.url), ["--serve"], { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const next = <T,>(key: string) => new Promise<T>(resolve => {
    const listener = (message: Record<string, T>) => { if (key in message) { child.off("message", listener); resolve(message[key]); } };
    child.on("message", listener);
  });
  const base = await next<string>("base");
  const signIn = await fetch(`${base}/api/auth/local`, { method: "POST", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify({ member: "one" }) });
  const cookie = signIn.headers.getSetCookie()[0].split(";")[0];
  const url = new URL(base);
  const open = (botId: string, mode: string) => new Promise<{ bytes: () => number; events: () => number; close: () => void }>((resolve, reject) => {
    let bytes = 0, events = 0, counting = false;
    const req = request({ host: url.hostname, port: url.port, path: `/api/bots/${botId}/events?inflight=${mode}`, headers: { cookie } }, response => {
      response.on("data", (chunk: Buffer) => {
        if (!counting) { counting = true; resolve({ bytes: () => bytes, events: () => events, close: () => req.destroy() }); return; }
        bytes += chunk.length;
        events += chunk.toString().split("\n\n").length - 1;
      });
    });
    req.on("error", error => { if (!counting) reject(error); });
    req.end();
  });
  const run = async (streams: number, streaming: number, from: number, mode: string) => {
    // Streams on bots 0..streaming-1 watch a growing reply, two each; the rest watch idle assistants.
    const targets = Array.from({ length: streams }, (_, index) => streams === 1 ? "bot0"
      : index < streaming * 2 ? `bot${index % streaming}` : `bot${streaming + index % (BOTS - streaming)}`);
    const opened = await Promise.all(targets.map(botId => open(botId, mode)));
    child.send({ start: { streaming, from } });
    // A second of growth first, so a delta stream's opening whole reply is not counted.
    await sleep(1000);
    const before = opened.map(stream => [stream.bytes(), stream.events()]);
    child.send({ measure: seconds });
    const report = await next<Report>("report");
    const counts = opened.map((stream, index) => [stream.bytes() - before[index][0], stream.events() - before[index][1]]);
    child.send({ stop: true });
    await next("stopped");
    for (const stream of opened) stream.close();
    await sleep(300);
    return { report, counts };
  };
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const repeats = Number(flag("--repeats", "3"));
  const rows: Record<string, unknown>[] = [];
  for (const scenario of CASES) {
    for (const mode of ["1", "2", "3"]) {
      const cpu: number[] = [];
      let last!: Awaited<ReturnType<typeof run>>;
      for (let repeat = 0; repeat < repeats; repeat++) {
        // The same replies with no stream open: what growing them costs, which every mode pays.
        const baseline = scenario.streaming ? (await run(0, scenario.streaming, scenario.from, mode)).report.cpuMs : 0;
        last = await run(scenario.streams, scenario.streaming, scenario.from, mode);
        cpu.push(last.report.cpuMs - baseline);
      }
      const { report, counts } = last;
      const active = counts.filter(([bytes]) => bytes > 0);
      const row = { label, case: scenario.name, mode, streams: scenario.streams, streaming: scenario.streaming,
        wakeupsPerSecond: +(report.wakeups / seconds).toFixed(1),
        eventsPerActiveStreamPerSecond: active.length ? +(active.reduce((sum, [, events]) => sum + events, 0) / active.length / seconds).toFixed(1) : 0,
        bytesPerActiveStreamPerSecond: active.length ? Math.round(active.reduce((sum, [bytes]) => sum + bytes, 0) / active.length / seconds) : 0,
        bytesPerSecondAllStreams: Math.round(counts.reduce((sum, [bytes]) => sum + bytes, 0) / seconds),
        streamCpuMsPerSecond: +(median(cpu) / seconds).toFixed(2) };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  console.table(rows.map(({ label: _label, ...row }) => row));
  child.kill();
}
