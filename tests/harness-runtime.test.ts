import { once } from "node:events";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { fileSigner } from "../src/server/hermes-files.js";
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
    const bot = await runtime.saveBot({ ...botInput, name: "Shared bot", shared: true });
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
    await expect(runtime.saveBot({ ...botInput, shared: true }, writer.id)).rejects.toMatchObject({
      message: "Use an API key credential for a shared bot.",
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
