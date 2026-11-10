import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { botFixture, capabilitiesFixture, conversationFixture, experienceRequester } from "../tests/helpers/runtime-fixtures.js";
import type { Activity, LiveTurn, Message, Runtime, ToolCall } from "../src/shared/types.js";
import { controlPort, port } from "./ports.js";

/**
 * The real app server for the browser suite: real routes, session handling, CSP, event stream and built client,
 * over a scripted assistant runtime so nothing leaves this machine. Another loopback port reports what the
 * browser told /api/csp-report, because the app only logs those, and resets the conversations between tests.
 */
if (!existsSync("dist/client/index.html")) throw new Error("Run `npm run build` first: the suite serves dist/client.");

const bots = [
  botFixture({ id: "ranch", name: "Ranch Hand", lastMessage: { text: "Fence check is done." } }),
  botFixture({ id: "trail", name: "Trail Cook" }),
];
const seedMessages = () => new Map<string, Message[]>([
  ["ranch", [{ id: "seed-1", role: "assistant", text: "Morning. The north fence is fixed.", createdAt: "2026-11-05T14:00:00Z" }]],
  ["trail", []],
]);
// Replaced between tests, so no test sees what another sent. A reply still pending from before holds its old thread.
let messages = seedMessages();
const watchers = new Map<string, Set<(kind?: "inflight") => void>>();
const notify = (botId: string, kind?: "inflight") => { for (const changed of watchers.get(botId) ?? []) changed(kind); };

/**
 * The Trail Cook streams its reply through a tool call, as Hermes does: words arrive as live growth, the reply so
 * far is saved as a segment before the tool, and after each change to the turn's structure a read must land
 * before live text resumes. A read is a client's conversation read or, for `?inflight=3` streams, the server's
 * own turn read, which takes TURN_READ_MS. The real runtime's turn reads are covered in tests/live-turn-*.test.ts.
 */
const STREAMING = "trail", TURN_READ_MS = 60;
type Running = { thread: Message[]; prompt: number; runId: string; tail: string; tools: ToolCall[]; done: boolean };
let running: Running | undefined, generation = 0, readAt = -1;
const followers = new Set<() => void>();
const activityOf = (turn: Running): Activity => ({ runId: turn.runId,
  state: turn.done ? "done" : turn.tools.some(tool => tool.status === "running") ? "working" : "thinking" });
function structural(botId: string) {
  const asked = ++generation;
  notify(botId);
  if (followers.size) setTimeout(() => {
    if (generation !== asked) return;
    readAt = asked;
    for (const follower of [...followers]) follower();
  }, TURN_READ_MS);
}
function streamReply(thread: Message[], runId: string) {
  const turn: Running = running = { thread, prompt: thread.length - 1, runId, tail: "", tools: [], done: false };
  structural(STREAMING);
  const steps: (() => void)[] = [];
  const words = (text: string) => { for (const word of text.split(/(?<= )/)) steps.push(() => { turn.tail += word; notify(STREAMING, "inflight"); }); };
  const save = () => { thread.push({ id: randomUUID(), runId, role: "assistant", text: turn.tail.trim(), createdAt: new Date().toISOString() }); turn.tail = ""; };
  words("Looking at the north fence.");
  // The tool starts and ends within a second, so the change notice for its end waits out the stream's
  // one-a-second throttle, and the chat reads again only after several more words. Only a turn read brings
  // the first of them.
  steps.push(() => { save(); turn.tools = [{ id: "t1", name: "terminal", status: "running" }]; structural(STREAMING); });
  steps.push(() => { turn.tools = [{ id: "t1", name: "terminal", status: "completed" }]; structural(STREAMING); });
  words("Post two is loose, so I tightened the wire and checked the gate.");
  steps.push(() => { save(); turn.done = true; structural(STREAMING); });
  let step = 0;
  const next = () => {
    if (running !== turn) return;
    steps[step++]();
    if (step < steps.length) setTimeout(next, 200);
  };
  setTimeout(next, 300);
}

// Both assistants run on one ChatGPT account with a used-up session; the Ranch Hand falls back to OpenRouter.
const chatgpt = "c".repeat(32), openrouter = "b".repeat(32);
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const experienceRequest = experienceRequester({
  accounts: input => ({ accounts: [{ key: chatgpt, provider: "openai-codex", role: "main" as const },
    ...input.profile === "ranch" ? [{ key: openrouter, provider: "openrouter", role: "fallback" as const }] : []] }),
  account_usage: input => input.key === chatgpt
    ? { key: chatgpt, provider: "openai-codex", plan: "Pro", title: "Account limits", fetchedAt: new Date().toISOString(), details: ["Credits balance: $4.00"],
      windows: [{ label: "Session", usedPercent: 100, resetsAt: inHours(3.4), detail: null, scope: "account" as const },
        { label: "Weekly", usedPercent: 64, resetsAt: inHours(70), detail: null, scope: "account" as const }],
      unavailableReason: null, bankedResets: 2, identity: null }
    : { key: openrouter, provider: "openrouter", plan: null, title: "Account limits", fetchedAt: new Date().toISOString(), details: ["Credits balance: $12.40"],
      windows: [{ label: "API key quota", usedPercent: 22, resetsAt: null, detail: "$15.60 of $20.00 remaining", scope: "account" as const }],
      unavailableReason: null, bankedResets: 0, identity: null },
});

// Members the suite does not script fail at their name, as tests/helpers/server.ts does for the unit tests.
const unscripted = (name: string) => async (): Promise<never> => { throw new Error(`The e2e runtime double does not script ${name}.`); };
const runtime: Runtime = {
  saveBot: unscripted("saveBot"), deleteBot: unscripted("deleteBot"), stop: unscripted("stop"),
  generatePortrait: unscripted("generatePortrait"), steer: unscripted("steer"), answerRequest: unscripted("answerRequest"),
  approve: unscripted("approve"), upload: unscripted("upload"), download: unscripted("download"), tools: unscripted("tools"),
  setTools: unscripted("setTools"), skills: unscripted("skills"), setSkills: unscripted("setSkills"),
  saveRoutine: unscripted("saveRoutine"), deleteRoutine: unscripted("deleteRoutine"),
  status: async () => ({ connected: true, code: "ready" }),
  capabilities: async () => capabilitiesFixture({ chat: { supported: true }, durableEvents: { supported: true }, idempotency: { supported: true } }),
  listBots: async () => bots,
  experienceRequest,
  botDetail: async botId => bots.find(bot => bot.id === botId)!,
  conversation: async botId => {
    const thread = [...messages.get(botId) ?? []];
    const turn = botId === STREAMING && running?.thread === messages.get(botId) ? running : undefined;
    if (!turn) return conversationFixture({ botId, messages: thread });
    readAt = generation;
    return conversationFixture({ botId, version: `e2e:0:${generation}`, activity: activityOf(turn), toolCalls: turn.tools,
      messages: [...thread, ...turn.tail ? [{ id: `${botId}-inflight`, role: "assistant" as const, text: turn.tail }] : []] });
  },
  routines: async () => [],
  discoverEvents: async cursor => ({ cursor, events: [] }),
  lookupSubmission: async () => null,
  // The user's message lands at once. The reply lands a beat later, each announced the way Hermes announces it.
  submit: async input => {
    const thread = messages.get(input.botId)!, runId = randomUUID();
    thread.push({ id: randomUUID(), runId, role: "user", text: input.text, createdAt: new Date().toISOString(), sender: { id: input.senderId, name: input.senderId } });
    if (input.botId === STREAMING) { streamReply(thread, runId); return { requestId: input.requestId, status: "accepted", runId }; }
    notify(input.botId);
    setTimeout(() => {
      thread.push({ id: randomUUID(), runId, role: "assistant", text: `Howdy, partner. You said: ${input.text}`, createdAt: new Date().toISOString() });
      notify(input.botId);
    }, 150);
    return { requestId: input.requestId, status: "accepted", runId };
  },
  turn(botId): LiveTurn | undefined {
    const turn = botId === STREAMING && running?.thread === messages.get(botId) ? running : undefined;
    if (!turn || readAt !== generation) return undefined;
    const saved = turn.thread.slice(turn.prompt);
    return { botId, version: `e2e:0:${generation}`, message: { id: `${botId}-inflight`, role: "assistant", text: turn.tail },
      activity: activityOf(turn), toolCalls: turn.tools, turn: { messages: saved, after: turn.thread[turn.prompt - 1]?.id ?? null } };
  },
  followTurns(_botId, restored) {
    const follower = () => restored();
    followers.add(follower);
    return () => { followers.delete(follower); };
  },
  watch(botId, changed) {
    const set = watchers.get(botId) ?? new Set();
    watchers.set(botId, set.add(changed));
    return () => { set.delete(changed); };
  },
  close: async () => {},
};

const violations: unknown[] = [];
const { app } = await createApp(
  loadConfig({ LOCAL_DEV_AUTH: "true", APP_DATABASE: ":memory:", HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "warn" }),
  runtime,
  { background: false, logStream: { write(line) {
    try { const entry = JSON.parse(line); if (entry.csp) violations.push(entry.csp); } catch { /* Not a JSON log line. */ }
  } } },
);
// After POST /next-release on the control port, the server answers as the next build would: sw.js
// names another cache, and the shell carries a release mark, so the two releases' shells differ.
// Everything the worker installs is this build's files, so the release it stands for is complete.
// With ?install=fail its worker cannot install, as when a deploy is missing a file.
let nextRelease: "none" | "ready" | "broken" = "none";
const NEXT_MARK = '<meta name="release" content="next">';
app.addHook("onRequest", async (req, reply) => {
  if (nextRelease === "none") return;
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/sw.js") {
    let source = readFileSync("dist/client/sw.js", "utf8").replace("const CACHE = 'agent-interface-", "const CACHE = 'agent-interface-next-");
    // A file the release lists but the server lacks: the server answers it with the shell, which install refuses.
    if (nextRelease === "broken") source = source.replace("const INSTALL_FILES = [", 'const INSTALL_FILES = ["/assets/missing-AAAAAAAA.js",');
    return reply.header("Cache-Control", "no-cache").type("text/javascript").send(source);
  }
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    const shell = readFileSync("dist/client/index.html", "utf8").replace("<head>", `<head>${NEXT_MARK}`);
    return reply.header("Cache-Control", "no-cache").type("text/html").send(shell);
  }
});
await app.listen({ host: "127.0.0.1", port });

// GET reads the violations. DELETE starts the next test from a clean slate. POST /next-release deploys a new worker.
const control = createServer((req, res) => {
  if (req.method === "DELETE") { violations.length = 0; messages = seedMessages(); running = undefined; nextRelease = "none"; }
  if (req.method === "POST" && req.url?.startsWith("/next-release")) nextRelease = req.url.endsWith("?install=fail") ? "broken" : "ready";
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(violations));
});
control.listen(controlPort, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => { control.close(); void app.close().then(() => process.exit(0)); });
