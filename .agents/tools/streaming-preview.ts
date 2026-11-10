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
 * each paint re-parses the most. SAVE_DELAY_MS holds the finished answer live that long before
 * saving it (default 0), to select text before the hand-off. ANSWER_PARAGRAPHS sets how many closing
 * paragraphs the answer has (default 6; 80 makes it about 21,000 characters). SEED_TURNS puts that
 * many finished turns before the first send (default 0), each a prompt, a progress line, three tool
 * calls whose JSON results are SEED_RESULT_KB kilobytes (default 16), and a reply. Every fourth reply
 * holds an email draft card revising the one before, and every sixth turn's tool makes a file, so the
 * transcript exercises origins, reply files and draft revisions as a long real one does. Nothing
 * leaves the machine.
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
const saveDelay = Number(process.env.SAVE_DELAY_MS ?? 0);
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
  ...Array.from({ length: Number(process.env.ANSWER_PARAGRAPHS ?? 6) }, (_, index) => `Paragraph ${index + 1}: the weather turns tomorrow, so feed early and keep the horses `
    + "in the barn if the wind picks up. Check the trough again at dusk, and walk the east fence before dark so the loose wire "
    + "is found while there is still light to fix it.\n"),
  "That is everything for today.",
].join("\n");
const answer = codeBlock ? "```ts\n" + Array.from({ length: 700 }, (_, index) => `const post${index} = check("fence", ${index});`).join("\n") : prose;
// Where the answer's stream starts: a code block arrives 20,000 characters long, then grows.
const answerStart = codeBlock ? 20_000 : 0;

const bot = botFixture({ id: "ranch", name: "Ranch Hand" });
const thread: Message[] = [{ id: "seed-1", role: "assistant", text: "Morning. The north fence is fixed.", createdAt: new Date().toISOString() }];
thread.push(...seedTurns(Number(process.env.SEED_TURNS ?? 0), Number(process.env.SEED_RESULT_KB ?? 16)));
function seedTurns(count: number, resultKb: number): Message[] {
  const rows: Message[] = [];
  const start = Date.now() - count * 600_000;
  const at = (turn: number, step: number) => new Date(start + turn * 600_000 + step * 1000).toISOString();
  const result = (turn: number, call: number) => JSON.stringify({ turn, call, entries: Array.from({ length: Math.ceil(resultKb * 1024 / 64) },
    (_, index) => ({ post: index, state: index % 3 ? "latched" : "open", note: "checked at dusk" })) });
  for (let turn = 1; turn <= count; turn++) {
    const runId = `seed-run-${turn}`;
    rows.push({ id: `seed-${turn}-prompt`, runId, role: "user", text: `Check fence section ${turn} and tell me what needs fixing.`, createdAt: at(turn, 0) });
    rows.push({ id: `seed-${turn}-progress`, runId, role: "assistant", interim: true, text: "Let me read the gate log first.", createdAt: at(turn, 1) });
    for (const [call, name] of ["terminal", "read_file", "web_search"].entries()) {
      const toolCall: ToolCall = { id: `seed-${turn}-call-${call}`, name, status: "completed", arguments: JSON.stringify({ section: turn, step: call }),
        result: result(turn, call), startedAt: at(turn, 2 + call), completedAt: at(turn, 3 + call) };
      rows.push({ id: `seed-${turn}-tool-${call}`, runId, role: "tool", text: "", toolCall, createdAt: at(turn, 3 + call),
        ...turn % 6 === 0 && call === 0 ? { files: [{ id: `seed-file-${turn}`, name: `section-${turn}.csv`, mime: "text/csv", size: 2048 }] } : {} });
    }
    const card = turn % 4 === 0 ? ["", "```agent-ui", JSON.stringify({ version: 1, cards: [{ id: turn > 4 ? `fence-${turn}__revises__fence-${turn - 4}` : `fence-${turn}`, type: "email",
      title: "Fence repair note", to: ["neighbor@example.test"], subject: `Fence section ${turn}`, body: `Section ${turn} needs two new posts and a wire splice before Friday.` }] }), "```"] : [];
    rows.push({ id: `seed-${turn}-reply`, runId, role: "assistant", createdAt: at(turn, 9), text: [`## Section ${turn}`, "",
      `The **gate** in section ${turn} is latched. Two posts lean east and one wire is loose near the cattle guard.`, "",
      "1. Reset the leaning posts.", "2. Splice the loose wire.", "3. Walk the line again at dusk.", ...card].join("\n") });
  }
  return rows;
}
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
  await pause(saveDelay);
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
