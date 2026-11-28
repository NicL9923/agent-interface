import { once } from "node:events";
import { mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAntigravityDriver } from "../src/server/harness/antigravity-driver.js";
import type {
  HarnessDriver,
  HarnessDriverId,
  HarnessEvent,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTurnInput,
} from "../src/server/harness/driver.js";
import { spawnHarnessProcess } from "../src/server/harness/process-spawn.js";
import { createHarnessRuntime } from "../src/server/harness/runtime.js";
import { fileSigner } from "../src/server/file-signer.js";
import { Store } from "../src/server/store.js";
import type { Submission } from "../src/shared/types.js";
import { MAX_UPLOAD_BYTES } from "../src/shared/uploads.js";

class FakeSession implements HarnessSession {
  private listener?: (event: HarnessEvent) => void;
  readonly providerSessionId: string;
  readonly turns: HarnessTurnInput[] = [];
  readonly steers: HarnessTurnInput[] = [];
  readonly answers: { requestId: string; answers: Record<string, string> }[] = [];
  readonly interrupts: (string | undefined)[] = [];
  closed = false;
  beforeInterrupt?: () => Promise<void>;

  constructor(
    readonly id: string,
    supportsSteering: boolean,
  ) {
    this.providerSessionId = `provider-${id}`;
    if (supportsSteering) {
      this.steer = async (input) => {
        this.steers.push(input);
      };
    }
  }

  steer?: HarnessSession["steer"];

  events(listener: (event: HarnessEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: HarnessEvent) {
    if (!this.listener) throw new Error("No harness event listener.");
    this.listener(event);
  }

  async startTurn(input: HarnessTurnInput) {
    this.turns.push(input);
    this.emit({ type: "turn.started", turnId: input.turnId });
  }

  async answerQuestion(requestId: string, answers: Record<string, string>) {
    this.answers.push({ requestId, answers });
  }

  async interrupt(turnId?: string) {
    this.interrupts.push(turnId);
    await this.beforeInterrupt?.();
  }

  async close() {
    this.closed = true;
  }
}

class FakeDriver implements HarnessDriver {
  readonly displayName: string;
  readonly capabilities;
  readonly opened: { spec: HarnessSessionSpec; session: FakeSession }[] = [];
  probeFailure = false;
  beforeOpen?: () => Promise<void>;

  constructor(
    readonly id: HarnessDriverId,
    nativeSteering: boolean,
  ) {
    this.displayName = id;
    this.capabilities = {
      nativeSteering,
      resumable: true,
      supportsMcp: true,
      supportsImages: true,
      supportsReasoning: true,
      supportsSpeed: nativeSteering,
    };
  }

  async probe() {
    if (this.probeFailure) throw new Error("Probe crashed");
    return { available: true };
  }

  async listModels() {
    return [
      {
        id: this.id,
        name: this.displayName,
        authenticated: true,
        models: [{ id: "model-1", name: "Model One", available: true }],
      },
    ];
  }

  async openSession(spec: HarnessSessionSpec) {
    await this.beforeOpen?.();
    const session = new FakeSession(spec.sessionKey, this.capabilities.nativeSteering);
    this.opened.push({ spec, session });
    return session;
  }
}

const owner = userInfo().username;
const botInput = {
  name: "Planner",
  instructions: "Plan the work.",
  model: "model-1",
  shared: false,
};
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

async function setup({ disk = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  const dbPath = disk ? join(directory, "store.sqlite") : ":memory:";
  const store = new Store(dbPath);
  const codex = new FakeDriver("codex", true);
  const claude = new FakeDriver("claude-code", false);
  const options = {
    drivers: { codex, "claude-code": claude },
    workspaceRoot: join(directory, "sandbox"),
  };
  const files = fileSigner(store.fileKeys(), undefined);
  store.user({ id: "sam", name: "Sam", email: "sam@example.net" });
  for (const [id, harness, vendor] of [
    ["codex-subscription", "codex", "openai"],
    ["claude-subscription", "claude-code", "anthropic"],
  ] as const) {
    store.managedBots.upsertCredential({
      id,
      label: id,
      kind: "subscription",
      vendor,
      ownerId: "sam",
      osUser: owner,
      allowedHarnesses: [harness],
    });
  }

  const runtime = createHarnessRuntime({ ...options, store, files });
  cleanups.push(async () => {
    try {
      await runtime.close();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const planner = await runtime.saveBot({
    ...botInput,
    harness: "codex",
    ownerId: "sam",
    credentialId: "codex-subscription",
  });
  const writer = await runtime.saveBot({
    ...botInput,
    name: "Writer",
    harness: "claude-code",
    ownerId: "sam",
    credentialId: "claude-subscription",
  });
  return { runtime, store, files, codex, claude, planner, writer, options, dbPath };
}

const submission = (botId: string, requestId: string, text = requestId): Submission => ({
  botId,
  requestId,
  text,
  attachments: [],
  senderId: "sam",
});

function nextSession(driver: FakeDriver, turnId: string | undefined) {
  return vi.waitFor(
    () => {
      const session = driver.opened.find(({ session }) =>
        session.turns.some((turn) => turn.turnId === turnId),
      )?.session;
      expect(session, `No session started turn ${turnId}`).toBeDefined();
      return session!;
    },
    { interval: 5 },
  );
}

describe("native harness runtime", () => {
  it("streams text, reasoning, and tools through watchers and persists the reply", async () => {
    const { runtime, store, planner, codex } = await setup();
    const notices: (string | undefined)[] = [];
    const frames: string[] = [];
    const roster = vi.fn();
    const unwatch = runtime.watch(planner.id, (notice) => notices.push(notice));
    const offRoster = runtime.watchRoster(roster);
    runtime.watchTurns({
      frame: (_id, event) => frames.push(event),
      run: () => {},
      disconnected: () => {},
    });
    const sent = await runtime.submit(submission(planner.id, "first", "Build a plan"));
    const session = await nextSession(codex, sent.runId);
    const turnId = sent.runId!;
    session.emit({ type: "reasoning.delta", turnId, delta: "Considering scope" });
    session.emit({ type: "text.delta", turnId, delta: "Here is " });
    session.emit({ type: "tool.started", turnId, callId: "call", name: "read", arguments: "{}" });
    expect(runtime.inflight(planner.id)).toMatchObject({
      message: { runId: turnId, reasoning: "Considering scope", text: "Here is " },
      activity: { state: "working", runId: turnId },
      toolCalls: [{ id: "call", arguments: "{}", status: "running" }],
    });
    session.emit({ type: "tool.completed", turnId, callId: "call", name: "read", output: "scope" });
    session.emit({ type: "text.delta", turnId, delta: "the plan." });
    expect(runtime.turn(planner.id)).toMatchObject({
      turn: {
        after: null,
        messages: [
          { id: sent.messageId, role: "user", sender: { id: "sam", name: "Sam" } },
          {
            role: "tool",
            runId: turnId,
            toolCall: { id: "call", result: "scope", status: "completed" },
          },
        ],
      },
      message: { text: "Here is the plan." },
    });
    session.emit({ type: "turn.completed", turnId });
    expect(runtime.inflight(planner.id)).toBeUndefined();
    expect(await runtime.conversation(planner.id)).toMatchObject({
      activity: { state: "idle" },
      messages: [
        { text: "Build a plan" },
        { text: "scope" },
        { text: "Here is the plan.", reasoning: "Considering scope" },
      ],
    });
    expect(store.transcripts.syncState(planner.id)?.canonicalSource).toBe("local");
    expect(store.events.runOutcome(planner.id, turnId)).toBe("completed");
    expect(notices).toContain("inflight");
    expect(frames).toEqual(["start", "text", "text", "text", "end"]);
    expect(roster).toHaveBeenCalled();
    unwatch();
    offRoster();
  });

  it("joins an active native turn and deduplicates its steering receipt", async () => {
    const { runtime, planner, codex } = await setup();
    const start = await runtime.submit(submission(planner.id, "starting"));
    const session = await nextSession(codex, start.runId);
    const input = submission(planner.id, "steer", "Use SQLite");
    const [first, second] = await Promise.all([runtime.steer(input), runtime.steer(input)]);
    expect(first).toMatchObject({ status: "accepted", steered: true, runId: start.runId });
    expect(second).toEqual(first);
    expect(await runtime.lookupSubmission(input.requestId, planner.id)).toEqual(first);
    expect(session.steers).toEqual([
      { turnId: start.runId, senderName: "Sam", text: "Use SQLite", attachments: [] },
    ]);
    expect(runtime.turn(planner.id)?.turn.messages.at(-1)).toMatchObject({
      id: first.messageId,
      role: "user",
      steered: true,
      text: "Use SQLite",
    });
    await expect(runtime.steer({ ...input, text: "Use Postgres" })).rejects.toMatchObject({
      code: "submission_conflict",
    });
    session.emit({ type: "turn.completed", turnId: start.runId! });
    await expect(runtime.steer(submission(planner.id, "idle"))).rejects.toMatchObject({
      code: "nothing_to_stop",
    });
  });

  it("drains the durable queue in its edited order and never dispatches cancelled messages", async () => {
    const { runtime, store, writer, claude } = await setup();
    expect((await runtime.capabilities(writer.id)).steering).toEqual({ supported: false });
    expect((await runtime.capabilities(writer.id)).queueManagement).toEqual({ supported: true });
    const initial = await runtime.submit(submission(writer.id, "initial"));
    const session = await nextSession(claude, initial.runId);
    const receipts = await Promise.all(
      ["second", "third", "cancel-me", "fourth"].map((id) =>
        runtime.submit(submission(writer.id, id)),
      ),
    );
    expect(receipts.map(({ turn }) => turn)).toEqual(["queued", "queued", "queued", "queued"]);
    await expect(runtime.steer(submission(writer.id, "steer"))).rejects.toMatchObject({
      statusCode: 409,
      message: "This harness does not support steering.",
    });
    const [, second, third, cancelled] = store.queue.list(writer.id);
    store.queue.edit(writer.id, third.id, "sam", "updated third");
    store.queue.reorder(writer.id, third.id, second.id);
    store.queue.cancel(writer.id, cancelled.id);
    expect((await runtime.conversation(writer.id)).messages.map(({ text }) => text)).toEqual([
      "initial",
    ]);
    session.emit({ type: "turn.completed", turnId: initial.runId! });
    for (const text of ["updated third", "second", "fourth"]) {
      const next = await vi.waitFor(
        () => {
          const turn = session.turns.at(-1);
          expect(turn?.text).toBe(text);
          return turn!;
        },
        { interval: 5 },
      );
      session.emit({ type: "turn.completed", turnId: next.turnId, text: `Reply to ${text}` });
    }
    expect(session.turns.map(({ text }) => text)).toEqual([
      "initial",
      "updated third",
      "second",
      "fourth",
    ]);
    expect(await runtime.lookupSubmission("cancel-me")).toMatchObject({
      status: "rejected",
      message: "The queued message was cancelled.",
    });
    expect(store.queue.list(writer.id)).toEqual([]);
    const latest = await runtime.conversation(writer.id, { window: { turns: 1 } });
    expect(latest).toMatchObject({
      messages: [{ text: "fourth" }, { text: "Reply to fourth" }],
      window: { earlier: 5 },
    });
    expect(
      await runtime.conversation(writer.id, {
        window: { before: latest.messages[0].id, turns: 1 },
      }),
    ).toMatchObject({
      messages: [{ text: "second" }, { text: "Reply to second" }],
      activity: { state: "idle" },
      window: { earlier: 3 },
    });
  });

  it("deduplicates submit across concurrent callers and rejects stale conversation versions", async () => {
    const { runtime, planner, writer, codex } = await setup();
    const { version } = await runtime.conversation(planner.id, { history: false });
    const a = submission(planner.id, "one");
    const [first, replay] = await Promise.all([
      runtime.submit({ ...a, conversationVersion: version }),
      runtime.submit({ ...a, conversationVersion: version }),
    ]);
    expect(first).toEqual(replay);
    const session = await nextSession(codex, first.runId);
    expect(await runtime.lookupSubmission(a.requestId, planner.id)).toMatchObject({
      runId: first.runId,
      messageId: first.messageId,
      status: "accepted",
    });
    expect(await runtime.lookupSubmission(a.requestId, writer.id)).toBeNull();
    await expect(runtime.submit({ ...a, botId: writer.id })).rejects.toMatchObject({
      code: "submission_conflict",
    });
    await expect(
      runtime.submit({ ...submission(planner.id, "stale"), conversationVersion: version }),
    ).rejects.toMatchObject({ code: "conversation_changed" });
    expect(await runtime.lookupSubmission("stale")).toBeNull();
    expect(session.turns.map(({ text }) => text)).toEqual(["one"]);
  });

  it("answers only a pending question for the requested bot and keeps that turn open until the answer", async () => {
    const { runtime, planner, writer, codex } = await setup();
    const start = await runtime.submit(submission(planner.id, "question"));
    const session = await nextSession(codex, start.runId);
    const turnId = start.runId!;
    session.emit({
      type: "question.asked",
      turnId,
      requestId: "provider-request",
      prompt: "Choose a size",
      questions: [{ id: "size", question: "What size?", options: ["small", "large"] }],
    });
    const waiting = await runtime.conversation(planner.id, { history: false });
    const [question] = waiting.attention!;
    expect(waiting.activity).toMatchObject({ state: "waiting", runId: turnId });
    expect(question).toMatchObject({
      kind: "clarify",
      detail: "Choose a size",
      questions: [{ id: "size", prompt: "What size?" }],
    });
    await expect(
      runtime.answerRequest(writer.id, question.id, { size: "small" }),
    ).rejects.toMatchObject({ code: "request_not_pending" });
    await expect(
      runtime.answerRequest(planner.id, "unknown", { size: "small" }),
    ).rejects.toMatchObject({ code: "request_not_pending" });
    session.emit({ type: "turn.completed", turnId, text: "Selected" });
    expect(runtime.inflight(planner.id)?.activity.state).toBe("waiting");
    await runtime.answerRequest(planner.id, question.id, { size: "small" });
    expect(session.answers).toEqual([
      { requestId: "provider-request", answers: { size: "small" } },
    ]);
    await expect(
      runtime.answerRequest(planner.id, question.id, { size: "large" }),
    ).rejects.toMatchObject({ code: "request_not_pending" });
    expect((await runtime.conversation(planner.id)).messages.at(-1)).toMatchObject({
      text: "Selected",
    });
  });

  it("stops only the current run and refuses stale and idle stop requests", async () => {
    const { runtime, planner, codex, store } = await setup();
    await expect(runtime.stop(planner.id)).rejects.toMatchObject({
      statusCode: 409,
      code: "nothing_to_stop",
    });
    const start = await runtime.submit(submission(planner.id, "stoppable"));
    const session = await nextSession(codex, start.runId);
    await expect(runtime.stop(planner.id, "other-run")).rejects.toMatchObject({
      statusCode: 409,
      code: "run_changed",
    });
    expect(session.interrupts).toEqual([]);
    await runtime.stop(planner.id, start.runId);
    expect(session.interrupts).toEqual([start.runId]);
    expect(session.closed).toBe(true);
    expect(store.events.runOutcome(planner.id, start.runId!)).toBe("interrupted");
    await expect(runtime.stop(planner.id, start.runId)).rejects.toMatchObject({
      statusCode: 409,
      code: "nothing_to_stop",
    });
  });

  it("keeps a replacement turn open when a stop of the crashed session returns late", async () => {
    const { runtime, planner, codex } = await setup();
    const first = await runtime.submit(submission(planner.id, "first"));
    const crashed = await nextSession(codex, first.runId);
    let finishInterrupt!: () => void;
    const interrupt = new Promise<void>((resolve) => {
      finishInterrupt = resolve;
    });
    crashed.beforeInterrupt = () => interrupt;

    const stopping = runtime.stop(planner.id, first.runId);
    try {
      crashed.emit({ type: "session.closed", unexpected: true });
      const second = await runtime.submit({
        ...submission(planner.id, "second"),
        reviewedInterruption: true,
      });
      const replacement = await nextSession(codex, second.runId);
      finishInterrupt();
      await stopping;
      expect(replacement.closed).toBe(false);
      expect(runtime.inflight(planner.id)?.activity.runId).toBe(second.runId);
    } finally {
      finishInterrupt();
      await stopping;
    }
  });

  it("persists a driver crash, leaves the queue paused, and dispatches only unsent work after review", async () => {
    const { runtime, store, planner, codex } = await setup();
    const first = await runtime.submit(submission(planner.id, "lost"));
    const session = await nextSession(codex, first.runId);
    await runtime.submit(submission(planner.id, "queued"));
    session.emit({ type: "text.delta", turnId: first.runId!, delta: "partial" });
    session.emit({ type: "session.closed", unexpected: true, reason: "process exited" });
    expect(await runtime.lookupSubmission("lost")).toMatchObject({
      status: "interrupted",
      runId: first.runId,
    });
    expect(
      store.queue.list(planner.id, { includeSettled: true }).map(({ status }) => status),
    ).toEqual(["interrupted", "queued"]);
    expect(await runtime.conversation(planner.id)).toMatchObject({
      activity: { state: "interrupted", runId: first.runId },
      messages: [{ text: "lost" }, { text: "partial" }],
    });
    const page = await runtime.discoverEvents("");
    expect(page.events).toEqual([
      expect.objectContaining({ kind: "interrupted", botId: planner.id, runId: first.runId }),
    ]);
    expect((await runtime.discoverEvents(page.cursor)).events).toEqual([]);
    await expect(runtime.submit(submission(planner.id, "next"))).rejects.toMatchObject({
      code: "interruption_pending",
    });
    expect(codex.opened.map(({ session }) => session.turns.map(({ text }) => text))).toEqual([
      ["lost"],
    ]);
    await runtime.submit({ ...submission(planner.id, "next"), reviewedInterruption: true });
    const queued = await runtime.lookupSubmission("queued");
    const newSession = await nextSession(codex, queued?.runId);
    expect(newSession.turns.map(({ text }) => text)).toEqual(["queued"]);
    expect(newSession.id).not.toBe(session.id);
  });

  it("recovers a previously claimed row after restart and exposes its interruption through durable discovery", async () => {
    const { runtime, store, planner, options, dbPath } = await setup({ disk: true });
    await runtime.close();
    for (const requestId of ["previously-claimed", "unsent"]) {
      store.queue.enqueue({
        botId: planner.id,
        requestId,
        senderId: "sam",
        senderName: "Sam",
        text: requestId,
      });
    }
    store.queue.claimNext(planner.id, "orphaned-run");
    const reopened = new Store(dbPath);
    const driver = new FakeDriver("codex", true);
    const restarted = createHarnessRuntime({
      ...options,
      drivers: { codex: driver },
      store: reopened,
      files: fileSigner(reopened.fileKeys(), undefined),
    });
    cleanups.push(async () => {
      try {
        await restarted.close();
      } finally {
        reopened.close();
      }
    });
    expect(await restarted.lookupSubmission("previously-claimed")).toMatchObject({
      status: "interrupted",
      runId: "orphaned-run",
    });
    expect((await restarted.discoverEvents("")).events).toEqual([
      expect.objectContaining({ kind: "interrupted", runId: "orphaned-run" }),
    ]);
    expect(reopened.queue.list(planner.id)).toMatchObject([
      { requestId: "unsent", status: "queued" },
    ]);
    expect(driver.opened).toEqual([]);
  });

  it("rotates for context usage and changed configuration only at a task boundary", async () => {
    const { runtime, codex, planner, store } = await setup();
    const first = await runtime.submit(submission(planner.id, "first", "Original prompt"));
    const session = await nextSession(codex, first.runId);
    const turnId = first.runId!;
    session.emit({ type: "usage.reported", turnId, contextTokens: 76, contextWindow: 100 });
    session.emit({
      type: "question.asked",
      turnId,
      requestId: "blocking",
      prompt: "Ready?",
      questions: [],
    });
    await runtime.submit(submission(planner.id, "second", "Next task"));
    session.emit({ type: "turn.completed", turnId, text: "Original reply" });
    expect(codex.opened).toHaveLength(1);
    const question = (await runtime.conversation(planner.id)).attention![0];
    await runtime.answerRequest(planner.id, question.id, {});
    const second = await runtime.lookupSubmission("second");
    const next = await nextSession(codex, second?.runId);
    expect(next.id).not.toBe(session.id);
    expect(session.closed).toBe(true);
    expect(codex.opened[1].spec.systemPrompt).toContain("Original reply");
    expect(codex.opened[1].spec.systemPrompt).toContain("Original prompt");
    expect(codex.opened[1].spec.systemPrompt).not.toContain("Next task");
    const secondId = second!.runId!;
    next.emit({ type: "usage.reported", turnId: secondId, contextTokens: 75, contextWindow: 100 });
    await runtime.submit(submission(planner.id, "third"));
    next.emit({ type: "turn.completed", turnId: secondId });
    const third = await vi.waitFor(
      async () => {
        const receipt = await runtime.lookupSubmission("third");
        expect(receipt?.runId).toBeDefined();
        return receipt!;
      },
      { interval: 5 },
    );
    expect(await nextSession(codex, third?.runId)).toBe(next);
    await runtime.saveBot(
      { ...botInput, instructions: "New instructions", model: "model-2" },
      planner.id,
    );
    expect(codex.opened).toHaveLength(2);
    expect(store.managedBots.getManagedBot(planner.id)?.model).toBe("model-2");
    next.emit({ type: "turn.completed", turnId: third!.runId! });
    const fourth = await runtime.submit(submission(planner.id, "fourth"));
    await nextSession(codex, fourth.runId);
    expect(codex.opened[2].spec).toMatchObject({
      model: "model-2",
      systemPrompt: expect.stringContaining("New instructions"),
    });
  });

  it("switches harness and credential for the next task under the same owner", async () => {
    const { runtime, claude, codex, planner } = await setup();
    const first = await runtime.submit(submission(planner.id, "first", "Before switching"));
    const old = await nextSession(codex, first.runId);
    await runtime.saveBot(
      {
        ...botInput,
        harness: "claude",
        credentialId: "claude-subscription",
      },
      planner.id,
    );
    expect(old.closed).toBe(false);
    expect(claude.opened).toEqual([]);
    old.emit({ type: "turn.completed", turnId: first.runId!, text: "End of old session" });
    const second = await runtime.submit(submission(planner.id, "second"));
    await nextSession(claude, second.runId);
    expect(old.closed).toBe(true);
    expect(claude.opened[0].spec.systemPrompt).toContain("End of old session");
  });

  it("passes only the selected API key to a shared bot", async () => {
    const { runtime, store, codex, planner } = await setup();
    vi.stubEnv("OPENAI_BILLING_KEY", "selected-key");
    vi.stubEnv("OPENAI_API_KEY", "other-key");
    vi.stubEnv("VAPID_PRIVATE_KEY", "server-secret");
    store.managedBots.upsertCredential({
      id: "api",
      label: "Shared API access",
      vendor: "openai",
      kind: "api_key",
      envVar: "OPENAI_BILLING_KEY",
      allowedHarnesses: ["codex"],
    });
    const bot = await runtime.saveBot({
      ...botInput,
      name: "Shared bot",
      shared: true,
      credentialId: "api",
    });
    await expect(
      runtime.submit({ ...submission(bot.id, "unknown"), senderId: "friend" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "This sender is not registered.",
    });
    expect(store.queue.list(bot.id)).toEqual([]);
    store.user({ id: "friend", name: "Friend", email: "friend@example.net" });
    const start = await runtime.submit({ ...submission(bot.id, "shared"), senderId: "friend" });
    await nextSession(codex, start.runId);
    expect(codex.opened[0].spec.env).toEqual({ OPENAI_API_KEY: "selected-key" });
    await expect(
      runtime.submit({ ...submission(planner.id, "private"), senderId: "friend" }),
    ).rejects.toMatchObject({
      code: "assistant_not_found",
    });
    store.managedBots.upsertCredential({
      id: "api",
      label: "Shared API access",
      vendor: "openai",
      kind: "api_key",
      envVar: "VAPID_PRIVATE_KEY",
      allowedHarnesses: ["codex"],
    });
    await expect(runtime.submit(submission(bot.id, "reserved"))).rejects.toMatchObject({
      statusCode: 400,
      message: "Choose a vendor API-key environment variable.",
    });
  });

  it("retires a session that opens after its reserved turn was stopped", async () => {
    const { runtime, planner, codex } = await setup();
    let allowOpen!: () => void;
    let signalOpening!: () => void;
    const opening = new Promise<void>((resolve) => {
      allowOpen = resolve;
    });
    const openingStarted = new Promise<void>((resolve) => {
      signalOpening = resolve;
    });
    codex.beforeOpen = async () => {
      signalOpening();
      await opening;
    };
    const sent = await runtime.submit(submission(planner.id, "stopped-before-open"));
    await openingStarted;
    const stopping = runtime.stop(planner.id, sent.runId);
    allowOpen();
    await stopping;
    expect(codex.opened[0].session.closed).toBe(true);
    expect(codex.opened[0].session.turns).toEqual([]);
    expect(await runtime.lookupSubmission(sent.requestId)).toMatchObject({ status: "interrupted" });
  });

  it("keeps bot configuration in the registry and reports each registered driver's capabilities", async () => {
    const { runtime, store, writer, claude } = await setup();
    claude.probeFailure = true;
    expect(await runtime.status()).toMatchObject({ connected: true, code: "ready" });
    expect(await runtime.harnessOptions()).toContainEqual({
      id: "claude-code",
      available: false,
      reason: "The harness probe failed.",
    });
    expect(store.managedBots.getManagedBot(writer.id)?.harness).toBe("claude-code");
    expect(await runtime.botDetail(writer.id)).toMatchObject({
      harness: "claude-code",
      ownerId: "sam",
    });
    expect(await runtime.modelOptions(writer.id)).toMatchObject({
      model: "model-1",
      providers: [{ id: "claude-code" }],
    });
    expect(await runtime.inferenceSettings(writer.id, { reasoning: "high" })).toEqual({
      reasoning: "high",
      speed: "normal",
    });
    await expect(runtime.inferenceSettings(writer.id, { speed: "fast" })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(runtime.saveBot({ ...botInput, shared: true }, writer.id)).resolves.toMatchObject({
      shared: true,
    });
    await runtime.deleteBot(writer.id);
    await expect(runtime.botDetail(writer.id)).rejects.toMatchObject({
      code: "assistant_not_found",
    });
    expect((await runtime.listBots()).map(({ id }) => id)).toEqual(["planner"]);
  });

  it("signs uploads, checks size and ownership on each path, and refuses symlinks", async () => {
    const { runtime, files, planner, writer, codex } = await setup();
    const file = await runtime.upload(planner.id, {
      name: "notes.txt",
      mime: "text/plain",
      data: Buffer.from("notes"),
    });
    expect(runtime.fileBotId(file.id)).toBe(planner.id);
    const badId = `${file.id.slice(0, -1)}${file.id.endsWith("A") ? "B" : "A"}`;
    expect(runtime.fileBotId(badId)).toBeUndefined();
    await expect(runtime.download(badId, 5)).rejects.toMatchObject({ code: "file_not_found" });
    await expect(runtime.download(file.id, 5, writer.id)).rejects.toMatchObject({
      code: "file_not_found",
    });
    await expect(
      runtime.submit({ ...submission(writer.id, "cross"), attachments: [file] }),
    ).rejects.toMatchObject({ code: "file_not_found" });
    await expect(runtime.download(file.id, 4, planner.id)).rejects.toMatchObject({
      code: "file_too_large",
    });
    await expect(
      runtime.upload(planner.id, {
        name: "large.txt",
        mime: "text/plain",
        data: Buffer.alloc(MAX_UPLOAD_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: "file_too_large" });
    const downloaded = await runtime.download(file.id, 5, planner.id);
    expect(downloaded).toMatchObject({ size: 5, mime: "text/plain", name: "notes.txt" });
    expect(await new Response(downloaded.body).text()).toBe("notes");
    const sent = await runtime.submit({
      ...submission(planner.id, "attached"),
      attachments: [{ ...file, name: "untrusted.html" }],
    });
    const session = await nextSession(codex, sent.runId);
    const path = files.fileValue(file.id).path;
    expect(session.turns[0].attachments).toEqual([
      { id: file.id, path, name: "notes.txt", mime: "text/plain" },
    ]);
    await unlink(path);
    await writeFile(`${path}.secret`, "secret");
    await symlink(`${path}.secret`, path);
    await expect(runtime.download(file.id, 20, planner.id)).rejects.toMatchObject({
      code: "file_not_found",
    });
  });

  it("manages native routines and injects active memory and skills into session prompts", async () => {
    const { runtime, store, planner, codex } = await setup();
    expect((await runtime.capabilities(planner.id)).routines.supported).toBe(true);
    const created = await runtime.saveRoutine({
      botId: planner.id,
      name: "Daily check",
      prompt: "Summarize status.",
      schedule: "0 9 * * *",
      enabled: true,
    });
    expect(created).toMatchObject({
      botId: planner.id,
      name: "Daily check",
      schedule: "0 9 * * *",
      enabled: true,
    });
    expect(await runtime.routines(planner.id)).toMatchObject([{ id: created.id, enabled: true }]);
    await runtime.setRoutineEnabled(planner.id, created.id, false);
    expect(await runtime.routines(planner.id)).toMatchObject([{ id: created.id, enabled: false }]);
    await runtime.deleteRoutine(created.id, planner.id);
    expect(await runtime.routines(planner.id)).toEqual([]);

    store.memory.importItems(planner.id, {
      entries: [
        {
          kind: "user",
          key: "pref",
          content: "Nicolas prefers concise updates.",
          reason: "imported",
        },
      ],
      skills: [
        {
          slug: "ops-check",
          title: "Ops Check",
          description: "Check VPS health",
          body: "# Ops",
          reason: "imported",
        },
      ],
    });
    const sent = await runtime.submit(submission(planner.id, "with-memory", "hi"));
    await nextSession(codex, sent.runId);
    expect(codex.opened.at(-1)?.spec.systemPrompt).toContain("Nicolas prefers concise updates.");
    expect(codex.opened.at(-1)?.spec.systemPrompt).toContain("ops-check: Ops Check.");

    // Creating and switching harnesses on a personal bot auto-selects the owner's subscription credential.
    const autoBot = await runtime.saveBot({
      ...botInput,
      name: "Auto Sub",
      harness: "claude-code",
      ownerId: "sam",
      shared: false,
    });
    expect(store.managedBots.getManagedBot(autoBot.id)).toMatchObject({
      harness: "claude-code",
      credentialId: "claude-subscription",
      provider: "anthropic",
    });
    await runtime.saveBot(
      { ...botInput, name: "Auto Sub", harness: "codex", ownerId: "sam", shared: false },
      autoBot.id,
    );
    expect(store.managedBots.getManagedBot(autoBot.id)).toMatchObject({
      harness: "codex",
      credentialId: "codex-subscription",
      provider: "openai",
    });
  });

  it("prefers household subscriptions over API keys when creating shared bots", async () => {
    const { runtime, store } = await setup();
    store.managedBots.upsertCredential({
      id: "shared-openai-key",
      label: "Shared OpenAI key",
      kind: "api_key",
      vendor: "openai",
      envVar: "OPENAI_API_KEY",
      allowedHarnesses: ["codex"],
    });
    const sharedBot = await runtime.saveBot({
      ...botInput,
      name: "Shared Sub",
      harness: "codex",
      shared: true,
    });
    expect(store.managedBots.getManagedBot(sharedBot.id)).toMatchObject({
      harness: "codex",
      shared: true,
      credentialId: "codex-subscription",
      ownerOsUser: owner,
    });
  });

  it("falls back to OpenRouter DeepSeek V4.1 Flash when the primary harness fails before streaming and cools down after quota errors", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-openrouter-key");
    const directory = await mkdtemp(join(tmpdir(), "harness-fallback-"));
    const store = new Store(":memory:");
    const files = fileSigner(store.fileKeys(), undefined);
    store.user({ id: "sam", name: "Sam", email: "sam@example.net" });
    store.managedBots.upsertCredential({
      id: "agy-sub",
      label: "Antigravity sub",
      kind: "subscription",
      vendor: "google",
      ownerId: "sam",
      osUser: owner,
      allowedHarnesses: ["antigravity"],
    });
    store.managedBots.upsertCredential({
      id: "household-openrouter-key",
      label: "OpenRouter key",
      kind: "api_key",
      vendor: "openrouter",
      envVar: "OPENROUTER_API_KEY",
      allowedHarnesses: ["pi"],
    });
    let clock = 10_000;
    const antigravity = new FakeDriver("antigravity", false);
    const pi = new FakeDriver("pi", false);
    const runtime = createHarnessRuntime({
      store,
      files,
      workspaceRoot: join(directory, "sandbox"),
      drivers: { antigravity, pi },
      now: () => clock,
      fallbackCooldownMs: 60_000,
      fallback: {
        harness: "pi",
        model: "deepseek/deepseek-v4.1-flash",
        provider: "openrouter",
        credentialId: "household-openrouter-key",
      },
    });
    cleanups.push(async () => {
      await runtime.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });

    const bot = await runtime.saveBot({
      ...botInput,
      name: "Neon Bot",
      harness: "antigravity",
      model: "gemini-4-neon",
      shared: true,
    });

    // 1. Non-quota openSession error → falls back seamlessly without triggering quota cooldown.
    antigravity.beforeOpen = async () => {
      throw new Error("socket closed unexpectedly");
    };
    const first = await runtime.submit(submission(bot.id, "fb-open", "Check weather"));
    const fallbackSession1 = await nextSession(pi, first.runId);
    expect(pi.opened.at(-1)?.spec).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      provider: "openrouter",
      env: { OPENROUTER_API_KEY: "synthetic-openrouter-key" },
    });
    fallbackSession1.emit({
      type: "text.delta",
      turnId: first.runId!,
      delta: "Sunny via fallback",
    });
    fallbackSession1.emit({
      type: "turn.completed",
      turnId: first.runId!,
      text: "Sunny via fallback",
      stopReason: "end_turn",
    });
    await vi.waitFor(async () => {
      const convo = await runtime.conversation(bot.id);
      expect(convo.messages.at(-1)?.text).toBe("Sunny via fallback");
    });

    // 2. Primary opens cleanly but emits a 429 quota turn.failed before streaming → falls back & enters cooldown.
    antigravity.beforeOpen = undefined;
    const second = await runtime.submit(submission(bot.id, "fb-fail", "Second check"));
    const primarySession = await nextSession(antigravity, second.runId);
    primarySession.emit({
      type: "reasoning.delta",
      turnId: second.runId!,
      delta: "aborted primary thought",
    });
    primarySession.emit({
      type: "turn.failed",
      turnId: second.runId!,
      message: "RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).",
      recoverable: true,
    });
    const fallbackSession2 = await nextSession(pi, second.runId);
    fallbackSession2.emit({
      type: "text.delta",
      turnId: second.runId!,
      delta: "Recovered via DeepSeek",
    });
    fallbackSession2.emit({
      type: "turn.completed",
      turnId: second.runId!,
      text: "Recovered via DeepSeek",
      stopReason: "end_turn",
    });
    await vi.waitFor(async () => {
      const convo = await runtime.conversation(bot.id);
      const last = convo.messages.at(-1);
      expect(last?.text).toBe("Recovered via DeepSeek");
      expect(last?.reasoning).toBeUndefined();
    });

    // 3. During cooldown, the next turn routes directly to the warm fallback without retrying Antigravity,
    //    while another bot sharing the same credential still tries Antigravity normally.
    const otherBot = await runtime.saveBot({
      ...botInput,
      name: "Other Neon",
      harness: "antigravity",
      model: "gemini-4-neon",
      shared: true,
    });
    const openedBeforeCooldown = antigravity.opened.length;
    clock += 10_000;
    const otherTurn = await runtime.submit(submission(otherBot.id, "fb-other", "Other check"));
    const otherPrimary = await nextSession(antigravity, otherTurn.runId);
    expect(antigravity.opened.length).toBe(openedBeforeCooldown + 1);
    otherPrimary.emit({
      type: "turn.completed",
      turnId: otherTurn.runId!,
      text: "Other bot stayed on Antigravity",
      stopReason: "end_turn",
    });

    const third = await runtime.submit(submission(bot.id, "fb-cooldown", "Third check"));
    const fallbackSession3 = await nextSession(pi, third.runId);
    expect(antigravity.opened.length).toBe(openedBeforeCooldown + 1);
    expect(fallbackSession3).toBe(fallbackSession2);
    fallbackSession3.emit({
      type: "turn.completed",
      turnId: third.runId!,
      text: "Direct via warm fallback",
      stopReason: "end_turn",
    });
    await vi.waitFor(async () => {
      const convo = await runtime.conversation(bot.id);
      expect(convo.messages.at(-1)?.text).toBe("Direct via warm fallback");
    });

    // 4. Once cooldown expires, the runtime tries Antigravity again automatically.
    clock += 60_000;
    const fourth = await runtime.submit(submission(bot.id, "fb-recover", "Fourth check"));
    const recoveredPrimary = await nextSession(antigravity, fourth.runId);
    expect(antigravity.opened.length).toBe(openedBeforeCooldown + 2);
    recoveredPrimary.emit({
      type: "turn.completed",
      turnId: fourth.runId!,
      text: "Back on Antigravity",
      stopReason: "end_turn",
    });
    await vi.waitFor(async () => {
      const convo = await runtime.conversation(bot.id);
      expect(convo.messages.at(-1)?.text).toBe("Back on Antigravity");
    });
  });

  it("falls back automatically when real Antigravity ACP returns an inline ⚠ RESOURCE_EXHAUSTED banner", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-openrouter-key");
    const directory = await mkdtemp(join(tmpdir(), "harness-agy-inline-fb-"));
    const store = new Store(":memory:");
    const files = fileSigner(store.fileKeys(), undefined);
    store.user({ id: "kim", name: "Kim", email: "kim@example.net" });
    store.user({ id: "nic", name: "Nic", email: "nic@example.net" });
    store.managedBots.upsertCredential({
      id: "nic-agy-sub",
      label: "Antigravity sub",
      kind: "subscription",
      vendor: "google",
      ownerId: "nic",
      osUser: owner,
      allowedHarnesses: ["antigravity"],
    });
    store.managedBots.upsertCredential({
      id: "household-openrouter-key",
      label: "OpenRouter key",
      kind: "api_key",
      vendor: "openrouter",
      envVar: "OPENROUTER_API_KEY",
      allowedHarnesses: ["pi"],
    });
    const antigravity = createAntigravityDriver({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./fixtures/harness/antigravity-mock-acp.mjs", import.meta.url)),
      ],
      geminiDir: join(directory, "gemini"),
    });
    const pi = new FakeDriver("pi", false);
    const runtime = createHarnessRuntime({
      store,
      files,
      workspaceRoot: join(directory, "sandbox"),
      drivers: { antigravity, pi },
      fallback: {
        harness: "pi",
        model: "deepseek/deepseek-v4.1-flash",
        provider: "openrouter",
        credentialId: "household-openrouter-key",
      },
    });
    cleanups.push(async () => {
      await runtime.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });

    const bot = await runtime.saveBot({
      ...botInput,
      name: "Kim Thunder",
      harness: "antigravity",
      model: "gemini-4-neon",
      shared: true,
    });

    const sent = await runtime.submit({
      ...submission(bot.id, "kim-429", "InlineQuotaError"),
      senderId: "kim",
    });
    const fallbackSession = await nextSession(pi, sent.runId);
    fallbackSession.emit({
      type: "text.delta",
      turnId: sent.runId!,
      delta: "Here is the comparison.",
    });
    fallbackSession.emit({
      type: "turn.completed",
      turnId: sent.runId!,
      text: "Here is the comparison.",
      stopReason: "end_turn",
    });
    await vi.waitFor(async () => {
      const convo = await runtime.conversation(bot.id);
      expect(convo.messages.at(-1)?.text).toBe("Here is the comparison.");
      expect(convo.messages.some((msg) => msg.text.includes("RESOURCE_EXHAUSTED"))).toBe(false);
    });
  });

  it("exposes liveVoice, realtimeSession, transcribeVoice, and synthesizeVoice when a voice delegate is wired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-voice-"));
    const store = new Store(":memory:");
    const files = fileSigner(store.fileKeys(), undefined);
    store.user({ id: "sam", name: "Sam", email: "sam@example.net" });
    store.managedBots.upsertCredential({
      id: "codex-sub",
      label: "Codex sub",
      kind: "subscription",
      vendor: "openai",
      ownerId: "sam",
      osUser: owner,
      allowedHarnesses: ["codex"],
    });
    const codex = new FakeDriver("codex", true);
    const runtime = createHarnessRuntime({
      store,
      files,
      workspaceRoot: join(directory, "sandbox"),
      drivers: { codex },
      voice: {
        liveVoice: async () => ({ supported: true }),
        realtimeSession: async (input) => ({
          clientSecret: "ek_test_secret_123",
          expiresAt: 1_900_000_000,
          model: "gpt-realtime-2.1",
          voice: input.voice,
        }),
        transcribeVoice: async () => ({ text: "hello voice", provider: "openai" }),
        synthesizeVoice: async (_botId, _text, chosen) => ({
          data: Buffer.from(`audio:${chosen ?? "default"}`),
          mime: "audio/mpeg",
          provider: "openai",
        }),
      },
    });
    cleanups.push(async () => {
      await runtime.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });

    const bot = await runtime.saveBot({
      ...botInput,
      name: "Voice Bot",
      harness: "codex",
      shared: true,
    });
    store.saveVoice(bot.id, "cedar");
    expect((await runtime.capabilities(bot.id)).liveVoice).toEqual({ supported: true });
    expect(
      await runtime.realtimeSession!({ voice: "cedar", instructions: "Speak", tools: [] }),
    ).toMatchObject({ clientSecret: "ek_test_secret_123", voice: "cedar" });
    expect(
      await runtime.transcribeVoice!(bot.id, { mime: "audio/webm", data: Buffer.from("abc") }),
    ).toEqual({ text: "hello voice", provider: "openai" });
    expect(await runtime.synthesizeVoice!(bot.id, "Hi there")).toMatchObject({
      mime: "audio/mpeg",
      data: Buffer.from("audio:cedar"),
    });
  });

  it("notifies followTurns on turn start, tools, and steer, and gates canonicalSubmit on idle steering-capable bots", async () => {
    const { runtime, planner, writer, codex } = await setup();
    // Idle steering-capable bot returns true; non-steering bot always returns false.
    expect(await runtime.canonicalSubmit(planner.id)).toBe(true);
    expect(await runtime.canonicalSubmit(writer.id)).toBe(false);
    expect(await runtime.canonicalSubmit("missing-bot")).toBe(false);
    expect(await runtime.canonicalSubmit()).toBe(false);

    const restored = vi.fn();
    const unfollow = runtime.followTurns(planner.id, restored);

    const sent = await runtime.submit(submission(planner.id, "follow-1", "Run tools"));
    // Turn start notified followers immediately.
    expect(restored).toHaveBeenCalledTimes(1);
    // While busy, canonicalSubmit returns false so conversation-routes steers through runtime.steer.
    expect(await runtime.canonicalSubmit(planner.id)).toBe(false);

    const session = await nextSession(codex, sent.runId);
    const turnId = sent.runId!;

    // Streaming text deltas do not fire followTurns (they use watch "inflight").
    session.emit({ type: "text.delta", turnId, delta: "Working..." });
    expect(restored).toHaveBeenCalledTimes(1);

    // tool.started and tool.completed fire followTurns immediately.
    session.emit({ type: "tool.started", turnId, callId: "t1", name: "lookup", arguments: "{}" });
    expect(restored).toHaveBeenCalledTimes(2);
    session.emit({ type: "tool.completed", turnId, callId: "t1", name: "lookup", output: "ok" });
    expect(restored).toHaveBeenCalledTimes(3);

    // Steering fires followTurns immediately.
    await runtime.steer(submission(planner.id, "follow-steer", "Also check fences"));
    expect(restored).toHaveBeenCalledTimes(4);

    // question.asked intentionally forces a conversation refetch without firing followTurns.
    session.emit({
      type: "question.asked",
      turnId,
      requestId: "q1",
      prompt: "Proceed?",
      questions: [],
    });
    expect(restored).toHaveBeenCalledTimes(4);

    const question = (await runtime.conversation(planner.id, { history: false })).attention![0];
    await runtime.answerRequest(planner.id, question.id, {});
    session.emit({ type: "turn.completed", turnId, text: "Done" });
    expect(await runtime.canonicalSubmit(planner.id)).toBe(true);

    unfollow();
    await runtime.submit(submission(planner.id, "follow-2", "After unfollow"));
    expect(restored).toHaveBeenCalledTimes(4);
  });

  it("reaps idle sessions by TTL, enforces maxIdleSessions LRU without touching active turns, and supports warmSession", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-lifecycle-"));
    const store = new Store(":memory:");
    const files = fileSigner(store.fileKeys(), undefined);
    store.user({ id: "sam", name: "Sam", email: "sam@example.net" });
    store.managedBots.upsertCredential({
      id: "codex-sub",
      label: "Codex sub",
      kind: "subscription",
      vendor: "openai",
      ownerId: "sam",
      osUser: owner,
      allowedHarnesses: ["codex"],
    });
    let clock = 10_000;
    const codex = new FakeDriver("codex", true);
    const runtime = createHarnessRuntime({
      store,
      files,
      workspaceRoot: join(directory, "sandbox"),
      drivers: { codex },
      idleSessionTtlMs: 80,
      maxIdleSessions: 2,
      now: () => clock,
    });
    cleanups.push(async () => {
      await runtime.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });

    const mkBot = (name: string) =>
      runtime.saveBot({
        ...botInput,
        name,
        harness: "codex",
        ownerId: "sam",
        credentialId: "codex-sub",
      });
    const botA = await mkBot("Alpha");
    const botB = await mkBot("Beta");
    const botC = await mkBot("Gamma");

    // warmSession pre-warms botA so the first turn reuses the already-open session.
    await runtime.warmSession(botA.id);
    expect(codex.opened).toHaveLength(1);
    const warmedA = codex.opened[0].session;
    const turnA = await runtime.submit(submission(botA.id, "warm-a", "Hi A"));
    const sessionA = await nextSession(codex, turnA.runId);
    expect(sessionA).toBe(warmedA);

    // warmSession on an active turn must not disturb or replace it.
    await runtime.warmSession(botA.id);
    expect(codex.opened).toHaveLength(1);
    expect(sessionA.closed).toBe(false);

    // Finish botA (idle at t=10_000), then warm botB (idle at t=10_010) and botC (idle at t=10_020).
    // With maxIdleSessions=2, botA (oldest idle) is evicted while botB and botC remain warm.
    sessionA.emit({ type: "turn.completed", turnId: turnA.runId! });
    clock += 10;
    await runtime.warmSession(botB.id);
    const sessionB = codex.opened[1].session;
    clock += 10;
    await runtime.warmSession(botC.id);
    const sessionC = codex.opened[2].session;
    await vi.waitFor(() => expect(sessionA.closed).toBe(true));
    expect(sessionB.closed).toBe(false);
    expect(sessionC.closed).toBe(false);

    // Start an active turn on botB, then advance clock past idleSessionTtlMs and wait for the reaper timer.
    // Active botB must NOT be reaped; idle botC MUST be reaped.
    const turnB = await runtime.submit(submission(botB.id, "active-b", "Stay alive"));
    await nextSession(codex, turnB.runId);
    clock += 100;
    await vi.waitFor(() => expect(sessionC.closed).toBe(true), { timeout: 1_000 });
    expect(sessionB.closed).toBe(false);
    sessionB.emit({ type: "turn.completed", turnId: turnB.runId! });
  });

  it("memoizes setfacl grants per workspace cwd/user and clears them on deleteBot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-acl-"));
    const store = new Store(":memory:");
    const files = fileSigner(store.fileKeys(), undefined);
    store.user({ id: "sam", name: "Sam", email: "sam@example.net" });
    const otherUser = owner === "alice" ? "bob" : "alice";
    store.managedBots.upsertCredential({
      id: "other-sub",
      label: "Other sub",
      kind: "subscription",
      vendor: "openai",
      ownerId: "sam",
      osUser: otherUser,
      allowedHarnesses: ["codex"],
    });
    const aclCalls: { path: string; user: string; permissions: string }[] = [];
    const codex = new FakeDriver("codex", true);
    const runtime = createHarnessRuntime({
      store,
      files,
      workspaceRoot: join(directory, "sandbox"),
      drivers: { codex },
      grantAcl: async (path, user, permissions) => {
        aclCalls.push({ path, user, permissions });
      },
    });
    cleanups.push(async () => {
      await runtime.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });

    const bot = await runtime.saveBot({
      ...botInput,
      name: "Isolated",
      harness: "codex",
      ownerId: "sam",
      ownerOsUser: otherUser,
      credentialId: "other-sub",
    });

    const first = await runtime.submit(submission(bot.id, "acl-1", "First"));
    const session = await nextSession(codex, first.runId);
    expect(aclCalls).toHaveLength(4);
    session.emit({ type: "turn.completed", turnId: first.runId! });

    // Second turn on the same bot reuses the memoized ACL grant without calling setfacl again.
    const second = await runtime.submit(submission(bot.id, "acl-2", "Second"));
    await vi.waitFor(() => expect(session.turns).toHaveLength(2));
    expect(aclCalls).toHaveLength(4);
    session.emit({ type: "turn.completed", turnId: second.runId! });

    // Deleting and recreating the bot clears the memoized ACL so setfacl runs again on the fresh directory.
    await runtime.deleteBot(bot.id);
    const recreated = await runtime.saveBot({
      ...botInput,
      name: "Isolated",
      harness: "codex",
      ownerId: "sam",
      ownerOsUser: otherUser,
      credentialId: "other-sub",
    });
    const third = await runtime.submit(submission(recreated.id, "acl-3", "Third"));
    const recreatedSession = await nextSession(codex, third.runId);
    expect(aclCalls).toHaveLength(8);
    recreatedSession.emit({ type: "turn.completed", turnId: third.runId! });

    // Deleting and recreating the workspace directory outside deleteBot changes its inode, so setfacl re-runs.
    const botCwd = join(directory, "sandbox", "workspaces", recreated.id, `owner-${otherUser}`);
    await rename(botCwd, `${botCwd}.old`);
    const fourth = await runtime.submit(submission(recreated.id, "acl-4", "Fourth"));
    await vi.waitFor(() => expect(recreatedSession.turns).toHaveLength(2));
    expect(aclCalls).toHaveLength(12);
    recreatedSession.emit({ type: "turn.completed", turnId: fourth.runId! });
  });

  it("isolates pooled group sessions per room, falls back cleanly on concurrent turns, and closes all room slots on deleteBot", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-openrouter-key");
    const directory = await mkdtemp(join(tmpdir(), "harness-group-rooms-"));
    const store = new Store(":memory:");
    const files = fileSigner(store.fileKeys(), undefined);
    store.user({ id: "sam", name: "Sam", email: "sam@example.net" });
    store.managedBots.upsertCredential({
      id: "codex-sub",
      label: "Codex sub",
      kind: "subscription",
      vendor: "openai",
      ownerId: "sam",
      osUser: owner,
      allowedHarnesses: ["codex"],
    });
    store.managedBots.upsertCredential({
      id: "openrouter-key",
      label: "OpenRouter key",
      kind: "api_key",
      vendor: "openrouter",
      envVar: "OPENROUTER_API_KEY",
      allowedHarnesses: ["pi"],
    });
    const codex = new FakeDriver("codex", true);
    const pi = new FakeDriver("pi", false);
    const runtime = createHarnessRuntime({
      store,
      files,
      workspaceRoot: join(directory, "sandbox"),
      drivers: { codex, pi },
      groupSessionIdleTtlMs: 60_000,
      fallback: {
        harness: "pi",
        model: "deepseek/deepseek-v4.1-flash",
        provider: "openrouter",
        credentialId: "openrouter-key",
      },
    });
    cleanups.push(async () => {
      await runtime.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });

    const alpha = await runtime.saveBot({
      ...botInput,
      name: "Alpha",
      harness: "codex",
      shared: true,
      ownerId: "sam",
      credentialId: "codex-sub",
    });
    const beta = await runtime.saveBot({
      ...botInput,
      name: "Beta",
      harness: "codex",
      shared: true,
      ownerId: "sam",
      credentialId: "codex-sub",
    });
    const members = [
      { member_id: alpha.id, profile: alpha.id, handle: alpha.id, display_name: alpha.name },
      { member_id: beta.id, profile: beta.id, handle: beta.id, display_name: beta.name },
    ];
    for (const [roomId, name] of [
      ["room-a", "Room A"],
      ["room-b", "Room B"],
    ] as const) {
      await runtime.groupRequest({
        operation: "create",
        roomId,
        name,
        actorId: "sam",
        members,
      });
    }

    const completeTurn = async (
      session: FakeSession,
      index: number,
      text: string,
      roomId: string,
    ) => {
      await vi.waitFor(() => expect(session.turns.length).toBeGreaterThan(index));
      session.emit({
        type: "turn.completed",
        turnId: session.turns[index]!.turnId,
        text,
        stopReason: "end_turn",
      });
      await vi.waitFor(async () => {
        const state = await runtime.groupRequest({ operation: "state", roomId });
        expect("driver_status" in state && state.driver_status?.running).toBe(false);
      });
    };

    // 1. Alpha taking turns in Room A and Room B opens separate sessions (no cross-room bleed).
    await runtime.groupRequest({
      operation: "send",
      roomId: "room-a",
      requestId: "room-a-1",
      threadId: "thread-a-1",
      text: "Hello room A",
      actorId: "sam",
      actorName: "Sam",
    });
    await vi.waitFor(() => expect(codex.opened).toHaveLength(1));
    const roomAAlpha = codex.opened[0]!.session;
    await completeTurn(roomAAlpha, 0, "Reply A1", "room-a");

    await runtime.groupRequest({
      operation: "send",
      roomId: "room-b",
      requestId: "room-b-1",
      threadId: "thread-b-1",
      text: "Hello room B",
      actorId: "sam",
      actorName: "Sam",
    });
    await vi.waitFor(() => expect(codex.opened).toHaveLength(2));
    const roomBAlpha = codex.opened[1]!.session;
    expect(roomBAlpha).not.toBe(roomAAlpha);
    await completeTurn(roomBAlpha, 0, "Reply B1", "room-b");

    // Consecutive turns in Room A reuse Room A's warm session.
    await runtime.groupRequest({
      operation: "send",
      roomId: "room-a",
      requestId: "room-a-2",
      threadId: "thread-a-2",
      text: "Follow up in A",
      actorId: "sam",
      actorName: "Sam",
    });
    await completeTurn(roomAAlpha, 1, "Reply A2", "room-a");
    expect(codex.opened).toHaveLength(2);

    // Beta also opens its own pooled slot in Room A so we can prove deleteBot(alpha) leaves beta open.
    await runtime.groupRequest({
      operation: "send",
      roomId: "room-a",
      requestId: "room-a-beta",
      threadId: "thread-a-beta",
      text: "@beta check status",
      actorId: "sam",
      actorName: "Sam",
    });
    await vi.waitFor(() => expect(codex.opened).toHaveLength(3));
    const roomABeta = codex.opened[2]!.session;
    await completeTurn(roomABeta, 0, "Beta ready", "room-a");

    // 2. Concurrent turn on the same roomId + botId falls back cleanly to one-shot on primary driver
    //    without throwing or triggering the fallback harness.
    let releaseFirstOpen!: () => void;
    let firstOpenStarted!: () => void;
    const firstOpenGate = new Promise<void>((resolve) => {
      releaseFirstOpen = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstOpenStarted = resolve;
    });
    let blockedOnce = false;
    // Force a fresh open in room-c so the pooled slot is actively opening while a second turn arrives.
    await runtime.groupRequest({
      operation: "create",
      roomId: "room-c",
      name: "Room C",
      actorId: "sam",
      members,
    });
    codex.beforeOpen = async () => {
      if (!blockedOnce) {
        blockedOnce = true;
        firstOpenStarted();
        await firstOpenGate;
      }
    };
    await runtime.groupRequest({
      operation: "send",
      roomId: "room-c",
      requestId: "room-c-1",
      threadId: "thread-c-1",
      text: "First in C",
      actorId: "sam",
      actorName: "Sam",
    });
    await started;
    // Stop Room C so GroupCoordinator accepts a new turn while Turn 1 still holds group:room-c:alpha.
    await runtime.groupRequest({
      operation: "stop",
      roomId: "room-c",
      requestId: "room-c-stop",
    });
    await runtime.groupRequest({
      operation: "send",
      roomId: "room-c",
      requestId: "room-c-2",
      threadId: "thread-c-2",
      text: "Concurrent in C",
      actorId: "sam",
      actorName: "Sam",
    });
    // Turn 2 runs one-shot on primary codex (not fallback pi!) and closes its one-shot session on completion.
    await vi.waitFor(() => expect(codex.opened).toHaveLength(4));
    const oneShotSession = codex.opened[3]!.session;
    expect(pi.opened).toHaveLength(0);
    await completeTurn(oneShotSession, 0, "One-shot reply", "room-c");
    expect(oneShotSession.closed).toBe(true);
    expect(pi.opened).toHaveLength(0);
    // Unblock Turn 1 so it retires cleanly.
    releaseFirstOpen();
    codex.beforeOpen = undefined;
    await vi.waitFor(() => expect(codex.opened).toHaveLength(5));
    await vi.waitFor(() => expect(codex.opened[4]!.session.closed).toBe(true));

    // 3. deleteBot(alpha.id) closes ALL pooled group slots for alpha across rooms, leaving beta open.
    expect(roomAAlpha.closed).toBe(false);
    expect(roomBAlpha.closed).toBe(false);
    expect(roomABeta.closed).toBe(false);
    await runtime.deleteBot(alpha.id);
    expect(roomAAlpha.closed).toBe(true);
    expect(roomBAlpha.closed).toBe(true);
    expect(roomABeta.closed).toBe(false);
  });

  it("reuses pooled group sessions across rounds and retires them on stop or deleteBot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-group-pool-"));
    const store = new Store(":memory:");
    const files = fileSigner(store.fileKeys(), undefined);
    store.user({ id: "sam", name: "Sam", email: "sam@example.net" });
    store.managedBots.upsertCredential({
      id: "codex-sub",
      label: "Codex sub",
      kind: "subscription",
      vendor: "openai",
      ownerId: "sam",
      osUser: owner,
      allowedHarnesses: ["codex"],
    });
    const codex = new FakeDriver("codex", true);
    const runtime = createHarnessRuntime({
      store,
      files,
      workspaceRoot: join(directory, "sandbox"),
      drivers: { codex },
      groupSessionIdleTtlMs: 60_000,
    });
    cleanups.push(async () => {
      await runtime.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });

    const alpha = await runtime.saveBot({
      ...botInput,
      name: "Alpha",
      harness: "codex",
      shared: true,
      ownerId: "sam",
      credentialId: "codex-sub",
    });
    const beta = await runtime.saveBot({
      ...botInput,
      name: "Beta",
      harness: "codex",
      shared: true,
      ownerId: "sam",
      credentialId: "codex-sub",
    });

    await runtime.groupRequest({
      operation: "create",
      roomId: "ranch-room",
      name: "Ranch Room",
      actorId: "sam",
      members: [
        { member_id: alpha.id, profile: alpha.id, handle: alpha.id, display_name: alpha.name },
        { member_id: beta.id, profile: beta.id, handle: beta.id, display_name: beta.name },
      ],
    });

    // Round 1 opens a pooled group session for alpha.
    await runtime.groupRequest({
      operation: "send",
      roomId: "ranch-room",
      requestId: "grp-1",
      threadId: "thread-1",
      text: "Check the barn",
      actorId: "sam",
      actorName: "Sam",
    });
    await vi.waitFor(() => expect(codex.opened).toHaveLength(1));
    const pooled = codex.opened[0].session;
    await vi.waitFor(() => expect(pooled.turns).toHaveLength(1));
    pooled.emit({
      type: "turn.completed",
      turnId: pooled.turns[0].turnId,
      text: "Barn looks fine.",
      stopReason: "end_turn",
    });
    await vi.waitFor(async () => {
      const state = await runtime.groupRequest({ operation: "state", roomId: "ranch-room" });
      expect("driver_status" in state && state.driver_status?.running).toBe(false);
    });
    expect(pooled.closed).toBe(false);

    // Round 2 reuses the exact same pooled group session without spawning a second process.
    await runtime.groupRequest({
      operation: "send",
      roomId: "ranch-room",
      requestId: "grp-2",
      threadId: "thread-2",
      text: "Check the fence",
      actorId: "sam",
      actorName: "Sam",
    });
    await vi.waitFor(() => expect(pooled.turns).toHaveLength(2));
    expect(codex.opened).toHaveLength(1);

    // Stopping the room interrupts and retires the pooled group session cleanly.
    await runtime.groupRequest({
      operation: "stop",
      roomId: "ranch-room",
      requestId: "grp-stop",
    });
    await vi.waitFor(() => expect(pooled.closed).toBe(true));
    expect(pooled.interrupts).toHaveLength(1);
  });
});

describe("harness process spawning", () => {
  it("rejects invalid Unix usernames before starting a command", () => {
    for (const osUser of ["", "-root", "root;id", "root\n", "nested/user", "a".repeat(33)]) {
      expect(() =>
        spawnHarnessProcess(process.execPath, ["--version"], {
          cwd: process.cwd(),
          osUser,
        }),
      ).toThrow("Invalid Unix user for a harness process.");
    }
  });

  it("passes only session-scoped secrets and escalates teardown when TERM is ignored", async () => {
    vi.stubEnv("WILDBOTS_ADMIN_TOKEN", "server-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "different-owner-key");
    expect(() =>
      spawnHarnessProcess(process.execPath, [], {
        cwd: process.cwd(),
        env: { WILDBOTS_ADMIN_TOKEN: "explicit-secret" },
      }),
    ).toThrow("Invalid harness environment override");
    const { child, close } = spawnHarnessProcess(
      process.execPath,
      [
        "-e",
        `
      process.on("SIGTERM", () => {});
      console.log(JSON.stringify({
        key: process.env.OPENAI_API_KEY,
        serverSecret: process.env.WILDBOTS_ADMIN_TOKEN,
        otherOwner: process.env.ANTHROPIC_API_KEY,
        home: process.env.HOME,
      }));
      setInterval(() => {}, 1000);
    `,
      ],
      { cwd: process.cwd(), osUser: owner, env: { OPENAI_API_KEY: "selected-key" } },
    );
    try {
      const [data] = await once(child.stdout, "data");
      expect(JSON.parse(data.toString())).toEqual({
        key: "selected-key",
        home: userInfo().homedir,
      });
      const exited = once(child, "exit");
      await close();
      expect(await exited).toEqual([null, "SIGKILL"]);
    } finally {
      await close();
    }
  });
});
