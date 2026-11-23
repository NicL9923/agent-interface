import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  HarnessDriver,
  HarnessDriverCapabilities,
  HarnessEvent,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTurnInput,
} from "../src/server/harness/driver.js";
import {
  CONTRACT_QUESTION,
  CONTRACT_REPLY,
  CONTRACT_TOOL,
  assertWellFormed,
  describeHarnessDriverContract,
  harnessDriverChecks,
  runHarnessDriverCheck,
  type HarnessDriverContractFactory,
  type HarnessScript,
  type ScriptedHarness,
} from "./helpers/harness-driver-contract.js";

/**
 * Defects the reference driver can carry, one per contract rule, so each check is shown to fail on the
 * driver bug it exists to catch.
 */
type Bug =
  | "legacy-claude-id"
  | "probe-installed-unavailable"
  | "probe-throws-missing"
  | "ready-before-return"
  | "steer-mismatch"
  | "removed-listener-hears"
  | "completes-before-text"
  | "tool-callid-mismatch"
  | "accepts-unknown-answer"
  | "stale-answer-accepted"
  | "interrupt-ends-normally"
  | "crash-silent"
  | "crash-expected"
  | "crash-hangs-turn"
  | "close-twice-throws"
  | "close-leaks-process"
  | "close-leaks-listener";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** An in-memory stand-in for a harness CLI. A turn with no script queued throws. */
class FakeHarness implements ScriptedHarness {
  private scripts: HarnessScript[] = [];
  readonly children = new Set<FakeChild>();
  script(next: HarnessScript) {
    this.scripts.push(next);
  }
  take() {
    const next = this.scripts.shift();
    if (!next) throw new Error("FakeHarness: no script was queued for this turn.");
    return next;
  }
  kill() {
    for (const child of [...this.children]) child.exit(true);
  }
  live() {
    return this.children.size;
  }
  spawn() {
    const child = new FakeChild(this.children);
    this.children.add(child);
    return child;
  }
}

class FakeChild {
  onExit?: (unexpected: boolean) => void;
  constructor(private readonly children: Set<FakeChild>) {}
  exit(unexpected: boolean) {
    if (!this.children.delete(this)) return;
    this.onExit?.(unexpected);
  }
}

class ReferenceSession implements HarnessSession {
  readonly id = randomUUID();
  providerSessionId: string | undefined;
  steer?: (input: HarnessTurnInput) => Promise<void>;
  private listeners = new Set<(event: HarnessEvent) => void>();
  private closed = false;
  private closing?: Promise<void>;
  private running?: { turnId: string; stop: (interrupted: boolean) => void };
  private questions = new Map<string, (answers: Record<string, string>) => void>();
  private answered = new Set<string>();
  // Real drivers reap their child when Node exits; the contract checks the hook is released.
  private readonly reap = () => this.child.exit(false);

  constructor(
    private readonly harness: FakeHarness,
    private readonly child: FakeChild,
    private readonly spec: HarnessSessionSpec,
    private readonly bug: Bug | undefined,
  ) {
    child.onExit = (unexpected) => {
      if (unexpected) this.crashed();
    };
    process.on("exit", this.reap);
  }

  ready() {
    this.providerSessionId = this.spec.resumeSessionId ?? `thread-${this.id}`;
    this.emit({ type: "session.ready", providerSessionId: this.providerSessionId });
  }

  private emit(event: HarnessEvent) {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener(event);
  }

  events(listener: (event: HarnessEvent) => void) {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      if (this.bug !== "removed-listener-hears") this.listeners.delete(listener);
    };
  }

  startTurn(input: HarnessTurnInput) {
    if (this.closed) return Promise.reject(new Error("The session is closed."));
    if (this.running) return Promise.reject(new Error("A turn is already running."));
    const script = this.harness.take();
    const finished = this.play(input.turnId, script);
    return this.bug === "crash-hangs-turn" ? finished : Promise.resolve();
  }

  /** Resolves only when the turn finishes normally. */
  private play(turnId: string, script: HarnessScript) {
    let wake: (interrupted: boolean) => void = () => undefined;
    const stopped = new Promise<boolean>((resolve) => (wake = resolve));
    this.running = { turnId, stop: wake };
    this.emit({ type: "turn.started", turnId });
    const say = async (delta: string) => {
      await tick();
      this.emit({ type: "text.delta", turnId, delta });
    };
    const complete = (stopReason: "end_turn" | "interrupted", text?: string) => {
      this.running = undefined;
      this.emit({ type: "turn.completed", turnId, stopReason, ...(text ? { text } : {}) });
    };
    return new Promise<void>((resolve) => {
      void (async () => {
        if (script === "text") {
          await say("contract ");
          if (this.bug === "completes-before-text") complete("end_turn", "contract ");
          await say("reply");
          if (this.bug !== "completes-before-text") complete("end_turn", CONTRACT_REPLY);
        } else if (script === "tool") {
          await tick();
          this.emit({ type: "tool.started", turnId, callId: "call-1", name: CONTRACT_TOOL });
          await tick();
          const callId = this.bug === "tool-callid-mismatch" ? "call-2" : "call-1";
          this.emit({ type: "tool.completed", turnId, callId, name: CONTRACT_TOOL, output: "ok" });
          await say(CONTRACT_REPLY);
          complete("end_turn");
        } else if (script === "question") {
          const requestId = `question-${turnId}`;
          const answer = new Promise<Record<string, string>>((resolve) =>
            this.questions.set(requestId, resolve),
          );
          await tick();
          this.emit({
            type: "question.asked",
            turnId,
            requestId,
            prompt: CONTRACT_QUESTION.question,
            questions: [{ ...CONTRACT_QUESTION, options: [...CONTRACT_QUESTION.options] }],
          });
          const answers = await Promise.race([answer, stopped.then(() => undefined)]);
          if (!answers) return;
          await say(`answered ${answers[CONTRACT_QUESTION.id]}`);
          complete("end_turn");
        } else {
          await say("working");
          await stopped;
          complete(this.bug === "interrupt-ends-normally" ? "end_turn" : "interrupted");
        }
        if (!this.closed) resolve();
      })();
    });
  }

  answerQuestion(requestId: string, answers: Record<string, string>) {
    const pending = this.questions.get(requestId);
    if (!pending) {
      if (this.bug === "accepts-unknown-answer" && !this.answered.has(requestId))
        return Promise.resolve();
      if (this.bug === "stale-answer-accepted" && this.answered.has(requestId))
        return Promise.resolve();
      return Promise.reject(new Error(`No question is waiting under ${requestId}.`));
    }
    this.questions.delete(requestId);
    this.answered.add(requestId);
    pending(answers);
    return Promise.resolve();
  }

  async interrupt(turnId?: string) {
    if (!this.running || (turnId !== undefined && this.running.turnId !== turnId)) return;
    this.running.stop(true);
  }

  private crashed() {
    if (this.closed) return;
    const turn = this.running;
    if (turn)
      this.emit({ type: "turn.failed", turnId: turn.turnId, message: "The harness exited." });
    if (this.bug !== "crash-silent")
      this.emit({
        type: "session.closed",
        reason: "The harness exited.",
        unexpected: this.bug !== "crash-expected",
      });
    this.shutDown();
    turn?.stop(false);
  }

  private shutDown() {
    this.closed = true;
    this.running = undefined;
    this.listeners.clear();
    this.questions.clear();
    if (this.bug !== "close-leaks-listener") process.off("exit", this.reap);
  }

  close() {
    if (this.bug === "close-twice-throws" && this.closing)
      return Promise.reject(new Error("The session was already closed."));
    this.closing ??= (async () => {
      await tick();
      if (this.closed) return;
      const turn = this.running;
      this.emit({ type: "session.closed", unexpected: false });
      this.shutDown();
      turn?.stop(false);
      if (this.bug !== "close-leaks-process") this.child.exit(false);
    })();
    return this.closing;
  }
}

class ReferenceDriver implements HarnessDriver {
  readonly id: HarnessDriver["id"];
  readonly displayName = "Reference harness";
  readonly capabilities: HarnessDriverCapabilities;
  constructor(
    private readonly harness: FakeHarness | undefined,
    private readonly bug: Bug | undefined,
  ) {
    // "claude" is the registry's spelling in src/shared/harness.ts; drivers must use "claude-code".
    this.id = (bug === "legacy-claude-id" ? "claude" : "pi") as HarnessDriver["id"];
    this.capabilities = {
      nativeSteering: bug === "steer-mismatch",
      resumable: true,
      supportsMcp: false,
      supportsImages: false,
      supportsReasoning: false,
      supportsSpeed: false,
    };
  }
  async probe() {
    if (this.harness && this.bug === "probe-installed-unavailable")
      return { available: false, reason: "Not signed in." };
    if (this.harness) return { available: true, version: "1.0.0" };
    if (this.bug === "probe-throws-missing") throw new Error("spawn reference ENOENT");
    return { available: false, reason: "The reference harness is not installed." };
  }
  async listModels() {
    return [];
  }
  async openSession(spec: HarnessSessionSpec) {
    if (!this.harness) throw new Error("spawn reference ENOENT");
    const session = new ReferenceSession(this.harness, this.harness.spawn(), spec, this.bug);
    if (this.bug === "ready-before-return") session.ready();
    else setTimeout(() => session.ready(), 0);
    return session;
  }
}

function referenceFactory(bug?: Bug): HarnessDriverContractFactory {
  return {
    // A broken driver hangs where a correct one answers in a few ticks.
    timeoutMs: bug ? 250 : 2000,
    installed: () => {
      const harness = new FakeHarness();
      return { driver: new ReferenceDriver(harness, bug), harness };
    },
    missing: () => ({ driver: new ReferenceDriver(undefined, bug) }),
  };
}

describeHarnessDriverContract("reference", referenceFactory());

describe("harness driver contract checks", () => {
  const check = (start: string) => {
    const found = harnessDriverChecks.find((entry) => entry.name.startsWith(start));
    if (!found) throw new Error(`No check starts with ${start}`);
    return found.name;
  };

  it.each<{ bug: Bug; check: string; reason: RegExp }>([
    {
      bug: "legacy-claude-id",
      check: check("identifies itself"),
      reason: /driver\.id "claude" is not a HarnessDriverId/,
    },
    {
      bug: "probe-installed-unavailable",
      check: check("probe reports an installed"),
      reason: /probe reported an installed harness unavailable: Not signed in/,
    },
    {
      bug: "probe-throws-missing",
      check: check("probe reports a missing"),
      reason: /probe threw for a missing binary/,
    },
    {
      bug: "ready-before-return",
      check: check("openSession emits"),
      reason: /Waiting for session\.ready did not settle/,
    },
    {
      bug: "steer-mismatch",
      check: check("openSession emits"),
      reason: /steer is absent but capabilities\.nativeSteering is true/,
    },
    {
      bug: "removed-listener-hears",
      check: check("streams a turn"),
      reason: /a removed listener still received turn\.started/,
    },
    {
      bug: "completes-before-text",
      check: check("streams a turn"),
      reason: /text deltas joined to "contract "/,
    },
    {
      bug: "tool-callid-mismatch",
      check: check("reports a tool call"),
      reason: /no tool\.completed matched callId call-1/,
    },
    {
      bug: "accepts-unknown-answer",
      check: check("resolves a question"),
      reason: /unknown requestId resolved; it must reject/,
    },
    {
      bug: "stale-answer-accepted",
      check: check("resolves a question"),
      reason: /already answered requestId resolved; it must reject/,
    },
    {
      bug: "interrupt-ends-normally",
      check: check("interrupt stops"),
      reason: /ended with turn\.completed \(end_turn\), not turn\.completed \(interrupted\)/,
    },
    {
      bug: "crash-silent",
      check: check("a harness crash"),
      reason: /Waiting for session\.closed after the harness crashed did not settle/,
    },
    {
      bug: "crash-expected",
      check: check("a harness crash"),
      reason: /did not say unexpected: true/,
    },
    {
      bug: "crash-hangs-turn",
      check: check("a harness crash"),
      reason: /the in-flight startTurn after a crash did not settle/,
    },
    {
      bug: "close-twice-throws",
      check: check("close is idempotent"),
      reason: /The session was already closed/,
    },
    {
      bug: "close-leaks-process",
      check: check("close is idempotent"),
      reason: /1 harness processes are still running after close\(\)/,
    },
    {
      bug: "close-leaks-listener",
      check: check("close is idempotent"),
      reason: /process "exit" listeners went from \d+ to \d+/,
    },
  ])("$check fails a driver with $bug", async ({ bug, check: name, reason }) => {
    const exitListeners = process.listeners("exit");
    try {
      await expect(runHarnessDriverCheck(name, referenceFactory(bug))).rejects.toThrow(reason);
    } finally {
      // The leaking variant leaves its hook on this shared worker's process.
      for (const listener of process.listeners("exit"))
        if (!exitListeners.includes(listener)) process.off("exit", listener);
    }
  });

  it("refuses a check name that does not exist", () => {
    expect(() => runHarnessDriverCheck("streams a turn in order", referenceFactory())).toThrow(
      /No harness driver check is named "streams a turn in order"/,
    );
  });
});

describe("assertWellFormed", () => {
  const ready: HarnessEvent = { type: "session.ready", providerSessionId: "p" };
  const started: HarnessEvent = { type: "turn.started", turnId: "t" };
  const done: HarnessEvent = { type: "turn.completed", turnId: "t" };
  const delta: HarnessEvent = { type: "text.delta", turnId: "t", delta: "x" };
  const tool: HarnessEvent = { type: "tool.started", turnId: "t", callId: "c", name: "n" };
  const closed: HarnessEvent = { type: "session.closed", unexpected: false };

  it("accepts a session with a finished turn", () => {
    expect(() => assertWellFormed([ready, started, delta, done, closed])).not.toThrow();
  });

  it.each<{ case: string; events: HarnessEvent[]; reason: RegExp }>([
    { case: "a second ready", events: [ready, ready], reason: /more than once/ },
    { case: "ready after a turn", events: [started, ready], reason: /session\.ready came after/ },
    { case: "events after close", events: [closed, started], reason: /after session\.closed/ },
    { case: "a turn started twice", events: [started, started], reason: /turn\.started repeated/ },
    { case: "a delta before its turn", events: [delta], reason: /before its turn\.started/ },
    {
      case: "a delta after the turn ended",
      events: [started, done, delta],
      reason: /after the turn ended/,
    },
    { case: "two terminal events", events: [started, done, done], reason: /after the turn ended/ },
    {
      case: "a tool started twice",
      events: [started, tool, tool],
      reason: /tool\.started repeated/,
    },
    {
      case: "a tool completed without starting",
      events: [started, { type: "tool.completed", turnId: "t", callId: "c", name: "n" }],
      reason: /has no open tool\.started/,
    },
    {
      case: "a turn finished with an open tool",
      events: [started, tool, done],
      reason: /still open/,
    },
  ])("refuses $case", ({ events, reason }) => {
    expect(() => assertWellFormed(events)).toThrow(reason);
  });
});
