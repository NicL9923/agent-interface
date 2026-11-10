/**
 * A loopback preview whose assistant streams its reply the way Hermes does, for watching a live reply
 * in a browser. Each send streams a short first segment, runs a tool for a moment, which saves that
 * segment and starts a new live reply, then streams a long Markdown answer and saves it.
 *
 *   npm run build && npx tsx .agents/tools/streaming-preview.ts [port]
 *
 * Open http://127.0.0.1:4190, choose "Enter local workspace" and then Ranch Hand. STREAM_CHARS
 * sets how many characters arrive every 40 ms (default 6, about 150 a second). With CODE_BLOCK=1 the
 * answer is one open code block that starts at 20,000 characters and keeps growing, the case where
 * each paint re-parses the most. Nothing leaves the machine.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { botFixture, capabilitiesFixture, conversationFixture } from "../../tests/helpers/runtime-fixtures.js";
import type { Activity, Inflight, LiveTurn, Message, Runtime, ToolCall } from "../../src/shared/types.js";

if (!existsSync("dist/client/index.html")) throw new Error("Run `npm run build` first: the preview serves dist/client.");
const port = Number(process.argv[2] ?? 4190);
const step = Number(process.env.STREAM_CHARS ?? 6);
const first = "Let me check the gate log before I answer.";
const codeBlock = process.env.CODE_BLOCK === "1";
const prose = [
  "## North pasture", "",
  "The north gate is **latched**, and the chain runs through the second post where the mare cannot reach it. "
    + "I checked the [gate log](https://example.test/gates) and the last entry is from this morning.", "",
  "A few things to watch this week:", "",
  "1. The *water trough* float sticks when it freezes overnight.",
  "2. The east fence has a loose wire near the cattle guard.",
  "3. Hay in the lean-to is dry, but the tarp has a tear on the west side.", "",
  "```sh", "gate-log --pasture north --since today", "# 06:12 latched by Nic", "# 18:40 checked by Ranch Hand", "```", "",
  "| Gate | State | Checked |", "| --- | --- | --- |", "| North | Latched | 6:12 pm |", "| East | Open | 2:05 pm |", "",
  ...Array.from({ length: 6 }, (_, index) => `Paragraph ${index + 1}: the weather turns tomorrow, so feed early and keep the horses `
    + "in the barn if the wind picks up. Check the trough again at dusk, and walk the east fence before dark so the loose wire "
    + "is found while there is still light to fix it.\n"),
  "That is everything for today.",
].join("\n");
const answer = codeBlock ? "```ts\n" + Array.from({ length: 700 }, (_, index) => `const post${index} = check("fence", ${index});`).join("\n") : prose;
// Where the answer's stream starts: a code block arrives 20,000 characters long, then grows.
const answerStart = codeBlock ? 20_000 : 0;

const bot = botFixture({ id: "ranch", name: "Ranch Hand" });
const thread: Message[] = [{ id: "seed-1", role: "assistant", text: "Morning. The north fence is fixed.", createdAt: new Date().toISOString() }];
let turn: { runId: string; prompt: number; live: string; calls: ToolCall[]; done: boolean } | undefined;
const watchers = new Set<(kind?: "inflight") => void>();
const notify = (kind?: "inflight") => { for (const changed of watchers) changed(kind); };
const liveMessage = (): Message => ({ id: "session-inflight", role: "assistant", text: turn!.live });
const activity = (): Activity => ({ runId: turn!.runId, state: turn!.done ? "done" : turn!.calls.some(call => call.status === "running") ? "working" : "thinking" });
// Each change to the turn's structure has a new version. `?inflight=3` streams get the turn whole from
// the server's own read, 60 ms later, as e2e/server.ts and Hermes do.
let generation = 0, readAt = -1;
const version = () => `preview:0:${generation}`;
const followers = new Set<() => void>();
function structural() {
  const asked = ++generation;
  notify();
  if (followers.size) setTimeout(() => {
    if (generation !== asked) return;
    readAt = asked;
    for (const follower of [...followers]) follower();
  }, 60);
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function stream(text: string, from = 0) {
  for (let at = from; at < text.length; at += step) {
    turn!.live = text.slice(0, at + step);
    notify("inflight");
    await pause(40);
  }
}
async function run(runId: string) {
  turn = { runId, prompt: thread.length - 1, live: "", calls: [], done: false };
  structural();
  await pause(400);
  await stream(first);
  // A tool call saves the segment before it, as Hermes does, and the next live reply starts empty.
  const call: ToolCall = { id: randomUUID(), name: "terminal", status: "running", startedAt: new Date().toISOString() };
  thread.push({ id: randomUUID(), runId, role: "assistant", text: first, createdAt: new Date().toISOString() });
  turn.live = "";
  turn.calls = [call];
  structural();
  await pause(1200);
  turn.calls = [{ ...call, status: "completed", completedAt: new Date().toISOString() }];
  thread.push({ id: randomUUID(), runId, role: "tool", text: "", toolCall: turn.calls[0], createdAt: new Date().toISOString() });
  structural();
  await stream(answer, answerStart);
  thread.push({ id: randomUUID(), runId, role: "assistant", text: answer, createdAt: new Date().toISOString() });
  turn.live = "";
  turn.done = true;
  structural();
}

const unscripted = (name: string) => async (): Promise<never> => { throw new Error(`The streaming preview does not script ${name}.`); };
const runtime: Runtime = {
  saveBot: unscripted("saveBot"), deleteBot: unscripted("deleteBot"), stop: unscripted("stop"),
  generatePortrait: unscripted("generatePortrait"), steer: unscripted("steer"), answerRequest: unscripted("answerRequest"),
  approve: unscripted("approve"), upload: unscripted("upload"), download: unscripted("download"), tools: unscripted("tools"),
  setTools: unscripted("setTools"), skills: unscripted("skills"), setSkills: unscripted("setSkills"),
  saveRoutine: unscripted("saveRoutine"), deleteRoutine: unscripted("deleteRoutine"),
  status: async () => ({ connected: true, code: "ready" }),
  capabilities: async () => capabilitiesFixture({ chat: { supported: true }, durableEvents: { supported: true }, idempotency: { supported: true } }),
  listBots: async () => [bot],
  botDetail: async () => bot,
  conversation: async () => conversationFixture({
    botId: "ranch",
    messages: [...thread, ...turn?.live ? [liveMessage()] : []],
    version: version(),
    ...turn ? { activity: activity(), toolCalls: turn.calls } : {},
  }),
  inflight: (): Inflight | undefined => turn && { botId: "ranch", message: liveMessage(), activity: activity(), toolCalls: turn.calls },
  turn: (): LiveTurn | undefined => turn && readAt === generation ? {
    botId: "ranch", version: version(), message: liveMessage(), activity: activity(), toolCalls: turn.calls,
    turn: { messages: thread.slice(turn.prompt), after: thread[turn.prompt - 1]?.id ?? null },
  } : undefined,
  followTurns(_botId, restored) {
    const follower = () => restored();
    followers.add(follower);
    return () => { followers.delete(follower); };
  },
  routines: async () => [],
  discoverEvents: async cursor => ({ cursor, events: [] }),
  lookupSubmission: async () => null,
  submit: async input => {
    const runId = randomUUID();
    thread.push({ id: randomUUID(), runId, role: "user", text: input.text, createdAt: new Date().toISOString(), sender: { id: input.senderId, name: input.senderId } });
    void run(runId);
    return { requestId: input.requestId, status: "accepted", runId };
  },
  watch(_botId, changed) {
    watchers.add(changed);
    return () => { watchers.delete(changed); };
  },
  close: async () => {},
};

const { app } = await createApp(
  loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "warn" }),
  runtime, { background: false },
);
await app.listen({ host: "127.0.0.1", port });
console.log(`Streaming preview at http://127.0.0.1:${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
