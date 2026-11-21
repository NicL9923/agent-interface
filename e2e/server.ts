import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { httpError } from "../src/server/http-error.js";
import { testFiles } from "../tests/helpers/file-signer.js";
import {
  automationOverviewFixture,
  automationRequester,
  automationTaskFixture,
  botFixture,
  capabilitiesFixture,
  conversationFixture,
  experienceRequester,
  routineFixture,
  subscriptionFixture,
} from "../tests/helpers/runtime-fixtures.js";
import type { AutomationRequest, AutomationRequester } from "../src/shared/automation.js";
import type { RoutineResult } from "../src/shared/collaboration.js";
import type {
  Activity,
  Bot,
  LiveTurn,
  Message,
  ModelCatalog,
  Routine,
  Runtime,
  ToolCall,
} from "../src/shared/types.js";
import { defaultPreferences } from "../src/shared/types.js";
import { controlPort, port } from "./ports.js";

/**
 * The real app server for the browser suite: real routes, session handling, CSP, event stream and built client,
 * over a scripted assistant runtime so nothing leaves this machine. Another loopback port reports what the
 * browser told /api/csp-report, because the app only logs those, and resets the conversations between tests.
 */
if (!existsSync("dist/client/index.html"))
  throw new Error("Run `npm run build` first: the suite serves dist/client.");

/** What the browser uploaded through POST /bots/:id/uploads, bytes included, until the next test starts. */
const uploads: { name: string; mime: string; base64: string }[] = [];
const bots = [
  botFixture({ id: "ranch", name: "Ranch Hand", lastMessage: { text: "Fence check is done." } }),
  botFixture({ id: "trail", name: "Trail Cook" }),
];
// Roster rows as a test left them with POST /activity, put back by DELETE like everything else.
const initialBots = bots.map((bot) => ({ ...bot }));
const seedMessages = () =>
  new Map<string, Message[]>([
    [
      "ranch",
      [
        {
          id: "seed-1",
          role: "assistant",
          text: "Morning. The north fence is fixed.",
          createdAt: "2026-11-05T14:00:00Z",
        },
      ],
    ],
    ["trail", []],
  ]);
// Replaced between tests, so no test sees what another sent. A reply still pending from before holds its old thread.
let messages = seedMessages();
const watchers = new Map<string, Set<(kind?: "inflight", turnVersion?: string) => void>>();
const notify = (botId: string, kind?: "inflight", turnVersion?: string) => {
  for (const changed of watchers.get(botId) ?? []) changed(kind, turnVersion);
};

/**
 * The Trail Cook streams its reply through a tool call, as Hermes does: words arrive as live growth, the reply so
 * far is saved as a segment before the tool, and after each change to the turn's structure a read must land
 * before live text resumes. A read is a client's conversation read or, for `?inflight=3` streams, the server's
 * own turn read, which takes TURN_READ_MS. The real runtime's turn reads are covered in tests/live-turn-*.test.ts.
 */
const STREAMING = "trail",
  TURN_READ_MS = 60;
type Running = {
  thread: Message[];
  prompt: number;
  runId: string;
  tail: string;
  tools: ToolCall[];
  done: boolean;
  holdChat: boolean;
  finished: Promise<void>;
  finish: () => void;
};
let running: Running | undefined,
  generation = 0,
  readAt = -1;
const followers = new Set<() => void>();
const activityOf = (turn: Running): Activity => ({
  runId: turn.runId,
  state: turn.done
    ? "done"
    : turn.tools.some((tool) => tool.status === "running")
      ? "working"
      : "thinking",
});
/** `covered`: the change is one a turn event carries whole, as a tool finishing is, so its notice names the version that event reaches. */
function structural(botId: string, covered = false) {
  const asked = ++generation;
  notify(botId, undefined, covered ? `e2e:0:${asked}` : undefined);
  if (followers.size)
    setTimeout(() => {
      if (generation !== asked) return;
      readAt = asked;
      for (const follower of [...followers]) follower();
    }, TURN_READ_MS);
}
function streamReply(thread: Message[], runId: string, prompt: string) {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const turn: Running = (running = {
    thread,
    prompt: thread.length - 1,
    runId,
    tail: "",
    tools: [],
    done: false,
    holdChat: prompt === "Walk the fence line",
    finished,
    finish,
  });
  structural(STREAMING);
  const steps: (() => void)[] = [];
  const words = (text: string) => {
    for (const word of text.split(/(?<= )/))
      steps.push(() => {
        turn.tail += word;
        notify(STREAMING, "inflight");
      });
  };
  const save = () => {
    thread.push({
      id: randomUUID(),
      runId,
      role: "assistant",
      text: turn.tail.trim(),
      createdAt: new Date().toISOString(),
    });
    turn.tail = "";
  };
  // "Echo: …" streams the rest back and leaves the turn running, so a test can measure the live row as it stands.
  const echo = /^Echo: ([\s\S]*)$/.exec(prompt)?.[1];
  if (echo !== undefined) words(echo);
  else {
    words("Looking at the north fence.");
    // The tool starts and ends within a second, so the change notice for its end waits out the stream's
    // one-a-second throttle, and the chat reads again only after several more words. Only a turn read brings
    // the first of them.
    steps.push(() => {
      save();
      turn.tools = [{ id: "t1", name: "terminal", status: "running" }];
      structural(STREAMING);
    });
    steps.push(() => {
      turn.tools = [{ id: "t1", name: "terminal", status: "completed" }];
      structural(STREAMING, true);
    });
    words("Post two is loose, so I tightened the wire and checked the gate.");
    steps.push(() => {
      save();
      turn.done = true;
      structural(STREAMING);
    });
  }
  let step = 0;
  const next = () => {
    if (running !== turn) return;
    steps[step++]();
    if (step < steps.length) setTimeout(next, 200);
  };
  setTimeout(next, 300);
}

// Both assistants run on one ChatGPT account with a used-up session; the Ranch Hand falls back to OpenRouter.
const chatgpt = "c".repeat(32),
  openrouter = "b".repeat(32);
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const experienceRequest = experienceRequester({
  accounts: (input) => ({
    accounts: [
      { key: chatgpt, provider: "openai-codex", role: "main" as const },
      ...(input.profile === "ranch"
        ? [{ key: openrouter, provider: "openrouter", role: "fallback" as const }]
        : []),
    ],
  }),
  account_usage: (input) =>
    input.key === chatgpt
      ? {
          key: chatgpt,
          provider: "openai-codex",
          plan: "Pro",
          title: "Account limits",
          fetchedAt: new Date().toISOString(),
          details: ["Credits balance: $4.00"],
          windows: [
            {
              label: "Session",
              usedPercent: 100,
              resetsAt: inHours(3.4),
              detail: null,
              scope: "account" as const,
            },
            {
              label: "Weekly",
              usedPercent: 64,
              resetsAt: inHours(70),
              detail: null,
              scope: "account" as const,
            },
          ],
          unavailableReason: null,
          bankedResets: 2,
          identity: null,
        }
      : {
          key: openrouter,
          provider: "openrouter",
          plan: null,
          title: "Account limits",
          fetchedAt: new Date().toISOString(),
          details: ["Credits balance: $12.40"],
          windows: [
            {
              label: "API key quota",
              usedPercent: 22,
              resetsAt: null,
              detail: "$15.60 of $20.00 remaining",
              scope: "account" as const,
            },
          ],
          unavailableReason: null,
          bankedResets: 0,
          identity: null,
        },
});

/**
 * After POST /full-hermes on the control port, until the next test starts, the runtime answers as a Hermes with the
 * add-on's settings, routines and live voice: the Ranch Hand has a model, a description, routines that ran, a goal,
 * tasks and a trigger. Off, every route answers as it did before the switch existed: the routines are empty, the
 * capabilities unsupported, and the members in `fullHermesMembers` absent.
 */
let fullHermes = false;
/** After POST /upload-failure, Hermes refuses every upload, as one that ran out of space would, until the next test starts. */
let uploadsFail = false;
const fullBot = (bot: Bot): Bot =>
  bot.id === "ranch"
    ? {
        ...bot,
        provider: "openai-codex",
        model: "gpt-5.5",
        modelName: "GPT-5.5",
        description: "Keeps the fences, tanks and gates in order.",
        instructions: "Keep the gates latched.",
      }
    : bot;
const routines: Routine[] = [
  routineFixture({
    id: "feed",
    botId: "ranch",
    name: "Feed inventory",
    prompt: "Count the feed bags and say what to order.",
    lastStatus: "ok",
    nextRunAt: "2026-11-06T13:00:00Z",
  }),
  routineFixture({
    id: "fence",
    botId: "ranch",
    name: "Fence check",
    prompt: "Walk the fence line report.",
    schedule: "0 17 * * 5",
    enabled: false,
    lastStatus: "error",
    lastError: "The gate camera did not answer.",
  }),
  routineFixture({
    id: "tanks",
    botId: "ranch",
    name: "Water tanks",
    prompt: "Read the tank floats.",
    schedule: "*/30 * * * *",
  }),
];
// One of each status the cards draw, timed after the seeded reply so they sit at the end of the chat.
const routineRuns: Record<string, RoutineResult[]> = {
  feed: [
    {
      id: "feed-1",
      title: "Feed inventory",
      status: "succeeded",
      startedAt: "2026-11-05T14:10:00Z",
      finishedAt: "2026-11-05T14:11:00Z",
      preview: "Twelve bags left. Order **eight** more by Friday.",
      previewOnly: false,
    },
  ],
  fence: [
    {
      id: "fence-1",
      title: "Fence check",
      status: "failed",
      startedAt: "2026-11-05T14:20:00Z",
      finishedAt: "2026-11-05T14:21:00Z",
      error: "The gate camera did not answer.",
      previewOnly: false,
    },
    {
      id: "fence-2",
      title: "Fence check",
      status: "succeeded",
      deliveryFailed: true,
      startedAt: "2026-11-05T14:25:00Z",
      finishedAt: "2026-11-05T14:26:00Z",
      preview: "All posts stand.",
      previewOnly: false,
    },
  ],
  tanks: [
    {
      id: "tanks-1",
      title: "Water tanks",
      status: "running",
      startedAt: "2026-11-05T14:30:00Z",
      preview: "Reading the east float.",
      previewOnly: false,
    },
  ],
};
const modelCatalog: ModelCatalog = {
  provider: "openai-codex",
  model: "gpt-5.5",
  providers: [
    {
      id: "openai-codex",
      name: "ChatGPT",
      authenticated: true,
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", available: true },
        { id: "gpt-5.5-mini", name: "GPT-5.5 mini", available: true },
        { id: "gpt-4.1", name: "GPT-4.1", available: false },
      ],
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      authenticated: true,
      warning: "Credits are running low.",
      models: [{ id: "llama-4", name: "Llama 4", available: true }],
    },
    { id: "anthropic", name: "Anthropic", authenticated: false, models: [] },
  ],
};
const scriptedAutomation = automationRequester({
  overview: (input) =>
    automationOverviewFixture({
      botId: input.profile,
      canManageTriggers: true,
      canManageLearningPolicy: true,
      goals: {
        supported: true,
        goal: {
          title: "Get the herd ready for winter",
          status: "active",
          turnsUsed: 6,
          maxTurns: 20,
        },
      },
      tasks: {
        supported: true,
        items: [
          automationTaskFixture({
            id: "t_gate",
            title: "Fix the north gate",
            body: "The latch sticks after rain.",
            blockedReason: "Waiting on a new latch.",
          }),
          automationTaskFixture({
            id: "t_hay",
            title: "Order hay",
            status: "running",
            priority: 2,
          }),
          automationTaskFixture({
            id: "t_tank",
            title: "Clean the east tank",
            status: "todo",
            dependencies: ["t_gate"],
          }),
          automationTaskFixture({ id: "t_salt", title: "Put out salt licks", status: "done" }),
        ],
      },
      triggers: {
        supported: true,
        platformEnabled: true,
        items: [subscriptionFixture({ routineId: "fence", enabled: true })],
      },
      skills: {
        supported: true,
        approvalRequired: true,
        lockSupported: true,
        installed: [
          { name: "fence-report", description: "Writes the fence report.", locked: true },
        ],
        pending: [
          {
            id: "p_feed",
            summary: "Count feed from photos",
            origin: "Feed inventory",
            revision: "c".repeat(64),
          },
        ],
      },
    }),
});

// Members the suite does not script fail at their name, as tests/helpers/server.ts does for the unit tests.
const unscripted = (name: string) => async (): Promise<never> => {
  throw new Error(`The e2e runtime double does not script ${name}.`);
};
const runtime: Runtime = {
  saveBot: unscripted("saveBot"),
  deleteBot: unscripted("deleteBot"),
  stop: unscripted("stop"),
  generatePortrait: unscripted("generatePortrait"),
  steer: unscripted("steer"),
  answerRequest: unscripted("answerRequest"),
  approve: unscripted("approve"),
  download: unscripted("download"),
  tools: unscripted("tools"),
  setTools: unscripted("setTools"),
  skills: unscripted("skills"),
  setSkills: unscripted("setSkills"),
  saveRoutine: unscripted("saveRoutine"),

  deleteRoutine: unscripted("deleteRoutine"),
  // Keeps what the browser uploaded, for GET /uploads on the control port to report.
  // The identifier is signed by the real file signer, so it has the shape the draft routes accept and the server
  // would hand out: a bare id is refused at `attachments[].id`, and a saved draft would never hold the photo.
  upload: async (botId, { name, mime, data }) => {
    if (uploadsFail) throw httpError(507, "Hermes has no room for this file.", { expose: true });
    uploads.push({ name, mime, base64: data.toString("base64") });
    return {
      ...testFiles().signFile({
        path: `/e2e/uploads/${randomUUID()}`,
        name,
        mime,
        botId,
        kind: "upload",
        version: 1,
      }),
      size: data.length,
    };
  },
  status: async () => ({ connected: true, code: "ready" }),
  capabilities: async () =>
    capabilitiesFixture({
      chat: { supported: true },
      durableEvents: { supported: true },
      idempotency: { supported: true },
      uploads: { supported: true },
      ...(fullHermes && {
        botConfiguration: { supported: true },
        routines: { supported: true },
        liveVoice: { supported: true },
      }),
    }),
  listBots: async () => (fullHermes ? bots.map(fullBot) : bots),
  experienceRequest,
  botDetail: async (botId) => {
    const bot = bots.find((row) => row.id === botId)!;
    return fullHermes ? fullBot(bot) : bot;
  },
  conversation: async (botId) => {
    const turn =
      botId === STREAMING && running?.thread === messages.get(botId) ? running : undefined;
    // Keep post-tool chat reads behind the turn; only the turn stream can restore live text.
    if (turn?.holdChat && turn.tools.some((tool) => tool.status === "completed"))
      await turn.finished;
    const thread = [...(messages.get(botId) ?? [])];
    if (!turn) return conversationFixture({ botId, messages: thread });
    readAt = generation;
    return conversationFixture({
      botId,
      version: `e2e:0:${generation}`,
      activity: activityOf(turn),
      toolCalls: turn.tools,
      messages: [
        ...thread,
        ...(turn.tail
          ? [{ id: `${botId}-inflight`, role: "assistant" as const, text: turn.tail }]
          : []),
      ],
    });
  },
  routines: async (botId) =>
    fullHermes ? routines.filter((routine) => !botId || routine.botId === botId) : [],
  discoverEvents: async (cursor) => ({ cursor, events: [] }),
  lookupSubmission: async () => null,
  // The user's message lands at once. The reply lands a beat later, each announced the way Hermes announces it.
  // POST /admission-delay?ms=N on the control port holds each admission that long first, as a slow Hermes would.
  submit: async (input) => {
    if (admissionDelay) await new Promise((resolve) => setTimeout(resolve, admissionDelay));
    const thread = messages.get(input.botId)!,
      runId = randomUUID();
    thread.push({
      id: randomUUID(),
      runId,
      role: "user",
      text: input.text,
      createdAt: new Date().toISOString(),
      sender: { id: input.senderId, name: input.senderId },
    });
    if (input.botId === STREAMING) {
      streamReply(thread, runId, input.text);
      return { requestId: input.requestId, status: "accepted", runId };
    }
    notify(input.botId);
    setTimeout(() => {
      thread.push({
        id: randomUUID(),
        runId,
        role: "assistant",
        text: `Howdy, partner. You said: ${input.text}`,
        createdAt: new Date().toISOString(),
      });
      notify(input.botId);
    }, 150);
    return { requestId: input.requestId, status: "accepted", runId };
  },
  turn(botId): LiveTurn | undefined {
    const turn =
      botId === STREAMING && running?.thread === messages.get(botId) ? running : undefined;
    if (!turn || readAt !== generation) return undefined;
    const saved = turn.thread.slice(turn.prompt);
    return {
      botId,
      version: `e2e:0:${generation}`,
      message: { id: `${botId}-inflight`, role: "assistant", text: turn.tail },
      activity: activityOf(turn),
      toolCalls: turn.tools,
      turn: { messages: saved, after: turn.thread[turn.prompt - 1]?.id ?? null },
    };
  },
  followTurns(_botId, restored) {
    const follower = () => restored();
    followers.add(follower);
    return () => {
      followers.delete(follower);
    };
  },
  watch(botId, changed) {
    const set = watchers.get(botId) ?? new Set();
    watchers.set(botId, set.add(changed));
    return () => {
      set.delete(changed);
    };
  },
  close: async () => {},
};

/**
 * Runtime members only a full Hermes has. The app checks each one's presence, so with the switch off they are absent,
 * and every route answers as it does on a Hermes without them.
 */
const fullHermesMembers = {
  automationRequest: ((input: AutomationRequest) => {
    // As an add-on without approval settings refuses them; the server reads this code as unsupported.
    if (input.operation.startsWith("approval_"))
      throw httpError(409, "This Hermes add-on can't list always-allowed commands.", {
        code: "approval_settings_unsupported",
      });
    return scriptedAutomation(input);
  }) as AutomationRequester,
  modelOptions: async () => modelCatalog,
  inferenceSettings: async () => ({ reasoning: "medium" as const, speed: "normal" as const }),
  realtimeSession: async ({ voice }) => ({
    clientSecret: "ek_e2e",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    model: "gpt-realtime",
    voice,
  }),
  routineResults: async (_botId, routineId) => routineRuns[routineId] ?? [],
  routineOutput: async (_botId, routineId, resultId) => ({
    previewOnly: false,
    messages: [
      {
        id: `${resultId}-output`,
        role: "assistant",
        text: routineRuns[routineId]?.find((run) => run.id === resultId)?.preview ?? "",
      },
    ],
  }),
} satisfies Partial<Runtime>;
for (const [name, member] of Object.entries(fullHermesMembers))
  Object.defineProperty(runtime, name, { get: () => (fullHermes ? member : undefined) });

const violations: unknown[] = [];
const { app, store, snapshot } = await createApp(
  loadConfig({
    LOCAL_DEV_AUTH: "true",
    APP_DATABASE: ":memory:",
    HOST: "127.0.0.1",
    PORT: String(port),
    LOG_LEVEL: "warn",
  }),
  runtime,
  {
    background: false,
    logStream: {
      write(line) {
        try {
          const entry = JSON.parse(line);
          if (entry.csp) violations.push(entry.csp);
        } catch {
          /* Not a JSON log line. */
        }
      },
    },
  },
);
// A replacement that matches nothing would leave the served worker unchanged and the test meaningless.
function replaceOnce(source: string, pattern: string | RegExp, replacement: string) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`sw.js has nothing matching ${pattern}`);
  return next;
}

// After POST /next-release on the control port, the server answers as the next build would: sw.js
// names another cache, and the shell carries a release mark, so the two releases' shells differ.
// Everything the worker installs is this build's files, so the release it stands for is complete.
// With ?install=fail its worker cannot install, as when a deploy is missing a file.
let nextRelease: "none" | "ready" | "broken" = "none";
let admissionDelay = 0;
let groupCatalog = false;
const NEXT_MARK = '<meta name="release" content="next">';
app.addHook("onRequest", async (req, reply) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (groupCatalog && path === "/api/groups" && req.method === "GET")
    return reply.send({ supported: true, canSend: true, rooms: [] });
  if (path === "/sw.js") {
    let source = readFileSync("dist/client/sw.js", "utf8");
    if (nextRelease !== "none")
      source = replaceOnce(
        source,
        /const CACHE = (['"])agent-interface-/,
        "const CACHE = $1agent-interface-next-",
      );
    source += `\nself.addEventListener("message", event => {
      if (event.data?.type === "TEST_OPEN_CHAT") event.waitUntil(openChat({ data: { url: event.data.url } }).then(() => event.ports[0].postMessage(true)));
    });`;
    // A file the release lists but the server lacks: the server answers it with the shell, which install refuses.
    if (nextRelease === "broken")
      source = replaceOnce(
        source,
        "const INSTALL_FILES = [",
        'const INSTALL_FILES = ["/assets/missing-AAAAAAAA.js",',
      );
    return reply.header("Cache-Control", "no-cache").type("text/javascript").send(source);
  }
  if (nextRelease !== "none" && req.method === "GET" && (path === "/" || path === "/index.html")) {
    const shell = readFileSync("dist/client/index.html", "utf8").replace(
      "<head>",
      `<head>${NEXT_MARK}`,
    );
    return reply.header("Cache-Control", "no-cache").type("text/html").send(shell);
  }
});
await app.listen({ host: "127.0.0.1", port });

// GET reads the violations. DELETE starts the next test from a clean slate. POST /next-release deploys a new worker.
// GET /uploads reads the files the browser uploaded. POST /full-hermes and POST /upload-failure are described above.
// POST /admission-delay?ms=N slows each send's admission. POST /activity?bot=ID&state=STATE gives that assistant
// the roster activity from the next bootstrap on, such as "waiting", which the app badge counts.
const control = createServer((req, res) => {
  if (req.method === "DELETE") {
    running?.finish();
    violations.length = 0;
    uploads.length = 0;
    messages = seedMessages();
    running = undefined;
    nextRelease = "none";
    admissionDelay = 0;
    groupCatalog = false;
    // Every member starts from the default preferences, so a theme, a pin or a chat style one test saved never
    // reaches the next.
    for (const user of store.users())
      store.savePreferences(user.id, structuredClone(defaultPreferences));
    fullHermes = false;
    uploadsFail = false;
    bots.splice(0, bots.length, ...initialBots.map((bot) => ({ ...bot })));
    // A saved draft outlives the browser that wrote it, so the next test must not open on a photo the last one attached.
    for (const bot of bots)
      if (store.draft("local-one", bot.id))
        store.saveDraft("local-one", bot.id, { text: "", attachments: [] });
  }
  if (req.method === "POST" && req.url === "/group-catalog") groupCatalog = true;
  if (req.method === "POST" && req.url === "/full-hermes") fullHermes = true;
  if (req.method === "POST" && req.url === "/upload-failure") uploadsFail = true;
  if (req.method === "POST" && req.url === "/release-chat") running?.finish();
  if (req.method === "POST" && req.url?.startsWith("/activity")) {
    const query = new URL(req.url, "http://localhost").searchParams,
      at = bots.findIndex((bot) => bot.id === query.get("bot"));
    if (at >= 0) bots[at] = { ...bots[at]!, activity: query.get("state") as Bot["activity"] };
  }
  if (req.method === "POST" && req.url?.startsWith("/admission-delay"))
    admissionDelay = Number(new URL(req.url, "http://localhost").searchParams.get("ms")) || 0;
  if (req.method === "POST" && req.url?.startsWith("/next-release"))
    nextRelease = req.url.endsWith("?install=fail") ? "broken" : "ready";
  // Bootstrap reuses the runtime's roster and capabilities for 1.5 s. Each switch changes what the runtime answers,
  // so the next bootstrap reads it again instead of serving what it read before.
  if (req.method !== "GET") snapshot.invalidate();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.method === "GET" && req.url === "/uploads" ? uploads : violations));
});
control.listen(controlPort, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    control.close();
    void app.close().then(() => process.exit(0));
  });
