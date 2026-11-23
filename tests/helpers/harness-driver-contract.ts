import { describe, expect, it } from "vitest";
import {
  HARNESS_DRIVER_IDS,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessSession,
  type HarnessSessionSpec,
} from "../../src/server/harness/driver.js";

/**
 * The shared contract every `HarnessDriver` keeps (`src/server/harness/driver.ts`). A Wave 2 driver
 * test points the driver at a scripted stand-in for its CLI and calls `describeHarnessDriverContract`:
 *
 *   describeHarnessDriverContract("codex", {
 *     installed: async () => { const harness = await fakeCodexAppServer(); return { driver: codexDriver({ bin: harness.bin }), harness }; },
 *     missing: () => ({ driver: codexDriver({ bin: "/nonexistent/codex" }) }),
 *   });
 *
 * The stand-in speaks the driver's real wire protocol and plays one `HarnessScript` per turn. Every
 * check also runs `assertWellFormed` over the whole event log, so an ordering slip in any scenario fails.
 *
 * Two rules here are stricter than the interface's types, on purpose:
 * - A listener attached as soon as `openSession` resolves receives `session.ready`. A driver that emits it
 *   before returning the session loses it, so it must defer or replay it.
 * - Every session ends with exactly one `session.closed`: `unexpected: false` after `close()`, true after
 *   the harness dies on its own. Consumers end spinners and free state on it.
 */

/** What the scripted harness does on the next turn. Unscripted turns should throw in the stand-in. */
export type HarnessScript =
  /** `CONTRACT_REPLY` in at least two text deltas, then a normal completion. */
  | "text"
  /** One tool call named `CONTRACT_TOOL`, started and completed, then `CONTRACT_REPLY` as text. */
  | "tool"
  /** Asks `CONTRACT_QUESTION`, waits for the answer, then replies with text that contains the chosen option. */
  | "question"
  /** Streams some text, then waits until it is interrupted or the process dies. */
  | "hang";

export const CONTRACT_REPLY = "contract reply";
export const CONTRACT_TOOL = "contract_tool";
export const CONTRACT_QUESTION = {
  id: "contract-choice",
  question: "Proceed with the contract check?",
  options: ["yes", "no"],
} as const;
/** The option the contract answers with; the harness's follow-up text must contain it. */
export const CONTRACT_ANSWER = "yes";

/** Control over the scripted harness a fixture's driver talks to. */
export interface ScriptedHarness {
  /** Queues what the harness does on its next turn. */
  script(next: HarnessScript): void;
  /** Ends every running harness process abruptly, as a crash or OOM kill would. */
  kill(): void | Promise<void>;
  /** Harness processes or connections still running. Must reach 0 after `close()` or a crash. */
  live(): number;
}

export interface HarnessDriverFixture {
  /** A driver whose binary is installed and signed in, wired to `harness`. */
  driver: HarnessDriver;
  harness: ScriptedHarness;
  /** Overrides for the session spec, such as a temporary `cwd`. */
  spec?: Partial<HarnessSessionSpec>;
  /** Removes temporary directories and fake binaries. Runs after every check. */
  cleanup?(): void | Promise<void>;
}

export interface HarnessDriverContractFactory {
  installed(): HarnessDriverFixture | Promise<HarnessDriverFixture>;
  /** The same driver configured with a binary path that does not exist. */
  missing():
    | { driver: HarnessDriver; cleanup?(): void | Promise<void> }
    | Promise<{ driver: HarnessDriver; cleanup?(): void | Promise<void> }>;
  /** How long any single wait may take before the check fails as hung. Defaults to 5 seconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
/** Process-wide signals a driver may hook to reap its children; each must be released on close. */
const PROCESS_EVENTS = ["exit", "SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"];

/** Rejects with a message naming `label` when `promise` does not settle in time, so a hang fails fast. */
export function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Whether `promise` rejects within `ms`. A resolve or a hang both fail with `label`. */
async function expectRejects(promise: Promise<unknown>, ms: number, label: string) {
  let outcome: "resolved" | "rejected";
  try {
    await within(promise, ms, label);
    outcome = "resolved";
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} did not settle`)) throw error;
    outcome = "rejected";
  }
  if (outcome === "resolved") throw new Error(`${label} resolved; it must reject`);
}

const turnIdOf = (event: HarnessEvent) => ("turnId" in event ? event.turnId : undefined);
const isTerminal = (event: HarnessEvent) =>
  event.type === "turn.completed" || event.type === "turn.failed";

/** Every event a session emitted, from the moment it was returned, with waits on what comes next. */
export class HarnessEventLog {
  readonly events: HarnessEvent[] = [];
  private waiters: {
    test: (event: HarnessEvent) => boolean;
    resolve: (e: HarnessEvent) => void;
  }[] = [];
  readonly stop: () => void;

  constructor(
    session: HarnessSession,
    private readonly timeoutMs: number,
  ) {
    this.stop = session.events((event) => {
      this.events.push(event);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.test(event)) return true;
        waiter.resolve(event);
        return false;
      });
    });
  }

  /** The first event, already emitted or still to come, that passes `test`. */
  wait<T extends HarnessEvent>(
    test: (event: HarnessEvent) => event is T,
    label: string,
  ): Promise<T>;
  wait(test: (event: HarnessEvent) => boolean, label: string): Promise<HarnessEvent>;
  wait(test: (event: HarnessEvent) => boolean, label: string) {
    const seen = this.events.find(test);
    if (seen) return Promise.resolve(seen);
    return within(
      new Promise<HarnessEvent>((resolve) => this.waiters.push({ test, resolve })),
      this.timeoutMs,
      `Waiting for ${label}`,
    );
  }

  /** The terminal event of `turnId`. */
  terminal(turnId: string) {
    return this.wait(
      (event) => isTerminal(event) && turnIdOf(event) === turnId,
      `the end of turn ${turnId}`,
    );
  }

  turn(turnId: string) {
    return this.events.filter((event) => turnIdOf(event) === turnId);
  }

  count(type: HarnessEvent["type"]) {
    return this.events.filter((event) => event.type === type).length;
  }
}

/**
 * The ordering rules every event log keeps, whatever the scenario: `session.ready` once and first, each turn
 * opened by `turn.started` and ended by at most one terminal event with nothing after it, each tool call
 * started before it completes, and nothing at all after one `session.closed`.
 */
export function assertWellFormed(events: readonly HarnessEvent[]) {
  const readies = events.flatMap((event, index) => (event.type === "session.ready" ? [index] : []));
  if (readies.length > 1) throw new Error("session.ready was emitted more than once");
  if (readies.length === 1 && readies[0] !== 0)
    throw new Error(`session.ready came after ${events[0]!.type}`);
  const closed = events.findIndex((event) => event.type === "session.closed");
  if (closed !== -1 && closed !== events.length - 1)
    throw new Error(`${events[closed + 1]!.type} was emitted after session.closed`);

  const turns = new Map<string, { ended: boolean; tools: Map<string, boolean> }>();
  for (const event of events) {
    const turnId = turnIdOf(event);
    if (turnId === undefined) continue;
    if (event.type === "turn.started") {
      if (turns.has(turnId)) throw new Error(`turn.started repeated for ${turnId}`);
      turns.set(turnId, { ended: false, tools: new Map() });
      continue;
    }
    const turn = turns.get(turnId);
    if (!turn) throw new Error(`${event.type} for ${turnId} came before its turn.started`);
    if (turn.ended) throw new Error(`${event.type} for ${turnId} came after the turn ended`);
    if (event.type === "tool.started") {
      if (turn.tools.has(event.callId))
        throw new Error(`tool.started repeated for call ${event.callId}`);
      turn.tools.set(event.callId, false);
    } else if (event.type === "tool.completed") {
      if (turn.tools.get(event.callId) !== false)
        throw new Error(`tool.completed for call ${event.callId} has no open tool.started`);
      turn.tools.set(event.callId, true);
    } else if (isTerminal(event)) {
      const open = [...turn.tools].find(([, done]) => !done);
      if (open && event.type === "turn.completed" && event.stopReason !== "interrupted")
        throw new Error(`turn ${turnId} completed with tool call ${open[0]} still open`);
      turn.ended = true;
    }
  }
}

function processListenerCounts() {
  return Object.fromEntries(PROCESS_EVENTS.map((name) => [name, process.listenerCount(name)]));
}

interface SessionContext {
  fixture: HarnessDriverFixture;
  session: HarnessSession;
  log: HarnessEventLog;
  timeoutMs: number;
  /** Starts `turnId` with `script` queued on the harness. */
  start: (turnId: string, script: HarnessScript) => Promise<void>;
}

let specCount = 0;
function sessionSpec(fixture: HarnessDriverFixture): HarnessSessionSpec {
  specCount += 1;
  return {
    botId: "contract-bot",
    sessionKey: `contract-session-${specCount}`,
    cwd: process.cwd(),
    model: "contract-model",
    fullPermissions: false,
    ...fixture.spec,
  };
}

/**
 * Opens a session on a fresh fixture, records its events from the first tick, runs `body`, then checks the
 * whole log with `assertWellFormed`. The session is closed and the fixture cleaned up even when `body` fails.
 */
async function withSession(
  factory: HarnessDriverContractFactory,
  body: (context: SessionContext) => Promise<void>,
) {
  const timeoutMs = factory.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fixture = await factory.installed();
  let session: HarnessSession | undefined;
  // A cleanup failure must not replace the check's own failure, which names the broken invariant.
  let failure: { error: unknown } | undefined;
  try {
    session = await within(
      fixture.driver.openSession(sessionSpec(fixture)),
      timeoutMs,
      "openSession",
    );
    const log = new HarnessEventLog(session, timeoutMs);
    const opened = session;
    // Callers start turns only once the session is ready, as the app will.
    await log.wait((event) => event.type === "session.ready", "session.ready");
    await body({
      fixture,
      session: opened,
      log,
      timeoutMs,
      start: (turnId, script) => {
        fixture.harness.script(script);
        return within(
          opened.startTurn({ turnId, text: `contract ${script}` }),
          timeoutMs,
          `startTurn ${turnId}`,
        );
      },
    });
    assertWellFormed(log.events);
  } catch (error) {
    failure = { error };
  }
  try {
    if (session) await within(session.close(), timeoutMs, "close() during cleanup");
  } catch (error) {
    failure ??= { error };
  }
  await fixture.cleanup?.();
  if (failure) throw failure.error;
}

export interface HarnessDriverCheck {
  name: string;
  run(factory: HarnessDriverContractFactory): Promise<void>;
}

/** Each invariant of `HarnessDriver`, runnable alone so a driver's test can show which one it breaks. */
export const harnessDriverChecks: HarnessDriverCheck[] = [
  {
    name: "identifies itself and lists models",
    async run(factory) {
      const fixture = await factory.installed();
      try {
        const { driver } = fixture;
        if (!(HARNESS_DRIVER_IDS as readonly string[]).includes(driver.id))
          throw new Error(`driver.id ${JSON.stringify(driver.id)} is not a HarnessDriverId`);
        if (!driver.displayName.trim()) throw new Error("driver.displayName is empty");
        const models = await within(
          driver.listModels(),
          factory.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          "listModels",
        );
        if (!Array.isArray(models)) throw new Error("listModels did not resolve to an array");
      } finally {
        await fixture.cleanup?.();
      }
    },
  },
  {
    name: "probe reports an installed harness as available",
    async run(factory) {
      const fixture = await factory.installed();
      try {
        const result = await within(
          fixture.driver.probe(),
          factory.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          "probe",
        );
        if (result.available !== true)
          throw new Error(`probe reported an installed harness unavailable: ${result.reason}`);
        if (result.version !== undefined && !result.version.trim())
          throw new Error("probe reported an empty version");
      } finally {
        await fixture.cleanup?.();
      }
    },
  },
  {
    name: "probe reports a missing binary as unavailable without throwing, and openSession refuses",
    async run(factory) {
      const timeoutMs = factory.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const missing = await factory.missing();
      try {
        let result;
        try {
          result = await within(missing.driver.probe(), timeoutMs, "probe of a missing binary");
        } catch (error) {
          throw new Error(`probe threw for a missing binary: ${(error as Error).message}`);
        }
        if (result.available !== false)
          throw new Error("probe reported a missing binary as available");
        if (!result.reason?.trim()) throw new Error("probe gave no reason for a missing binary");
        await expectRejects(
          missing.driver.openSession(sessionSpec({} as HarnessDriverFixture)),
          timeoutMs,
          "openSession with a missing binary",
        );
      } finally {
        await missing.cleanup?.();
      }
    },
  },
  {
    name: "openSession emits session.ready with the provider session ID",
    run: (factory) =>
      withSession(factory, async ({ fixture, session, log }) => {
        if (!session.id.trim()) throw new Error("session.id is empty");
        const ready = await log.wait(
          (event): event is Extract<HarnessEvent, { type: "session.ready" }> =>
            event.type === "session.ready",
          "session.ready",
        );
        if (!ready.providerSessionId.trim())
          throw new Error("session.ready carried an empty providerSessionId");
        if (session.providerSessionId !== ready.providerSessionId)
          throw new Error(
            `session.providerSessionId ${String(session.providerSessionId)} differs from session.ready's ${ready.providerSessionId}`,
          );
        const steers = typeof session.steer === "function";
        if (steers !== fixture.driver.capabilities.nativeSteering)
          throw new Error(
            `steer is ${steers ? "present" : "absent"} but capabilities.nativeSteering is ${fixture.driver.capabilities.nativeSteering}`,
          );
      }),
  },
  {
    name: "streams a turn as turn.started, text.delta, turn.completed",
    run: (factory) =>
      withSession(factory, async ({ session, log, start }) => {
        await log.wait((event) => event.type === "session.ready", "session.ready");
        // A listener removed before the turn must hear none of it.
        const removed: HarnessEvent[] = [];
        session.events((event) => removed.push(event))();
        await start("turn-text", "text");
        const end = await log.terminal("turn-text");
        if (end.type !== "turn.completed")
          throw new Error(`turn ended with ${end.type}: ${"message" in end ? end.message : ""}`);
        if (end.stopReason !== undefined && end.stopReason !== "end_turn")
          throw new Error(`a finished turn stopped with ${end.stopReason}`);
        const turn = log.turn("turn-text");
        const types = turn.map((event) => event.type);
        if (types[0] !== "turn.started") throw new Error(`turn began with ${types[0]}`);
        const firstDelta = types.indexOf("text.delta");
        if (firstDelta === -1) throw new Error("turn streamed no text.delta");
        const text = turn
          .flatMap((event) => (event.type === "text.delta" ? [event.delta] : []))
          .join("");
        if (text !== CONTRACT_REPLY)
          throw new Error(
            `text deltas joined to ${JSON.stringify(text)}, not ${JSON.stringify(CONTRACT_REPLY)}`,
          );
        if (end.text !== undefined && end.text !== text)
          throw new Error(
            `turn.completed text ${JSON.stringify(end.text)} differs from its deltas`,
          );
        const stray = removed.filter((event) => event.type !== "session.ready");
        if (stray.length)
          throw new Error(
            `a removed listener still received ${stray.map((e) => e.type).join(", ")}`,
          );
      }),
  },
  {
    name: "reports a tool call as tool.started then tool.completed with the same callId",
    run: (factory) =>
      withSession(factory, async ({ log, start }) => {
        await start("turn-tool", "tool");
        const end = await log.terminal("turn-tool");
        if (end.type !== "turn.completed") throw new Error(`tool turn ended with ${end.type}`);
        const turn = log.turn("turn-tool");
        const started = turn.findIndex((event) => event.type === "tool.started");
        if (started === -1) throw new Error("tool turn emitted no tool.started");
        const call = turn[started] as Extract<HarnessEvent, { type: "tool.started" }>;
        if (!call.callId.trim()) throw new Error("tool.started carried an empty callId");
        if (call.name !== CONTRACT_TOOL)
          throw new Error(`tool.started named ${call.name}, not ${CONTRACT_TOOL}`);
        const completed = turn.findIndex(
          (event) => event.type === "tool.completed" && event.callId === call.callId,
        );
        if (completed === -1) throw new Error(`no tool.completed matched callId ${call.callId}`);
        if (completed < started) throw new Error("tool.completed came before tool.started");
        const done = turn[completed] as Extract<HarnessEvent, { type: "tool.completed" }>;
        if (done.name !== call.name)
          throw new Error(`tool.completed named ${done.name}, but it started as ${call.name}`);
      }),
  },
  {
    name: "resolves a question through answerQuestion and refuses unknown or stale request IDs",
    run: (factory) =>
      withSession(factory, async ({ session, log, start, timeoutMs }) => {
        await start("turn-question", "question");
        const asked = await log.wait(
          (event): event is Extract<HarnessEvent, { type: "question.asked" }> =>
            event.type === "question.asked",
          "question.asked",
        );
        if (asked.turnId !== "turn-question")
          throw new Error(`question.asked named turn ${asked.turnId}`);
        if (!asked.requestId.trim()) throw new Error("question.asked carried an empty requestId");
        const question = asked.questions.find((entry) => entry.id === CONTRACT_QUESTION.id);
        if (!question)
          throw new Error(`question.asked did not include question ${CONTRACT_QUESTION.id}`);

        await expectRejects(
          session.answerQuestion(`${asked.requestId}-unknown`, {
            [CONTRACT_QUESTION.id]: CONTRACT_ANSWER,
          }),
          timeoutMs,
          "answerQuestion with an unknown requestId",
        );
        if (log.turn("turn-question").some(isTerminal))
          throw new Error("a refused answer ended the turn");

        await within(
          session.answerQuestion(asked.requestId, { [CONTRACT_QUESTION.id]: CONTRACT_ANSWER }),
          timeoutMs,
          "answerQuestion",
        );
        const end = await log.terminal("turn-question");
        if (end.type !== "turn.completed") throw new Error(`answered turn ended with ${end.type}`);
        const text = log
          .turn("turn-question")
          .flatMap((event) => (event.type === "text.delta" ? [event.delta] : []))
          .join("");
        if (!text.includes(CONTRACT_ANSWER))
          throw new Error(
            `the harness never received the answer; it replied ${JSON.stringify(text)}`,
          );

        await expectRejects(
          session.answerQuestion(asked.requestId, { [CONTRACT_QUESTION.id]: CONTRACT_ANSWER }),
          timeoutMs,
          "answerQuestion for an already answered requestId",
        );
      }),
  },
  {
    name: "interrupt stops an in-flight turn and the session keeps working",
    run: (factory) =>
      withSession(factory, async ({ session, log, start, timeoutMs }) => {
        // Nothing is running yet, so this is a no-op, never an error.
        await within(session.interrupt(), timeoutMs, "interrupt with no turn running");
        await start("turn-hang", "hang");
        await log.wait(
          (event) => event.type === "text.delta" && event.turnId === "turn-hang",
          "the hanging turn's first text.delta",
        );
        await within(session.interrupt("turn-hang"), timeoutMs, "interrupt");
        const end = await log.terminal("turn-hang");
        if (end.type !== "turn.completed" || end.stopReason !== "interrupted")
          throw new Error(
            `an interrupted turn ended with ${end.type}${end.type === "turn.completed" ? ` (${end.stopReason})` : ""}, not turn.completed (interrupted)`,
          );
        if (log.count("session.closed")) throw new Error("interrupt closed the session");

        await start("turn-after-interrupt", "text");
        const next = await log.terminal("turn-after-interrupt");
        if (next.type !== "turn.completed")
          throw new Error(`the turn after an interrupt ended with ${next.type}`);
      }),
  },
  {
    name: "a harness crash mid-turn emits session.closed unexpected and settles every pending call",
    run: (factory) =>
      withSession(factory, async ({ fixture, session, log, timeoutMs }) => {
        fixture.harness.script("hang");
        // Held, not awaited: whether it resolves on acceptance or completion, it must settle.
        const turn = session.startTurn({ turnId: "turn-crash", text: "contract hang" });
        turn.catch(() => undefined);
        await log.wait(
          (event) => event.type === "text.delta" && event.turnId === "turn-crash",
          "the crashing turn's first text.delta",
        );
        await fixture.harness.kill();
        const closed = await log.wait(
          (event): event is Extract<HarnessEvent, { type: "session.closed" }> =>
            event.type === "session.closed",
          "session.closed after the harness crashed",
        );
        if (closed.unexpected !== true)
          throw new Error("session.closed after a crash did not say unexpected: true");
        await within(
          turn.then(
            () => undefined,
            () => undefined,
          ),
          timeoutMs,
          "the in-flight startTurn after a crash",
        );
        await expectRejects(
          session.startTurn({ turnId: "turn-after-crash", text: "contract text" }),
          timeoutMs,
          "startTurn on a crashed session",
        );
        await within(session.close(), timeoutMs, "close() after a crash");
        if (log.count("session.closed") !== 1)
          throw new Error(`session.closed was emitted ${log.count("session.closed")} times`);
        if (fixture.harness.live() !== 0)
          throw new Error(`${fixture.harness.live()} harness processes outlived the crash`);
      }),
  },
  {
    name: "close is idempotent and leaves no processes or listeners behind",
    async run(factory) {
      const before = processListenerCounts();
      let live = -1;
      await withSession(factory, async ({ fixture, session, log, start, timeoutMs }) => {
        await start("turn-before-close", "text");
        await log.terminal("turn-before-close");
        await within(
          Promise.all([session.close(), session.close()]),
          timeoutMs,
          "two concurrent close() calls",
        );
        await within(session.close(), timeoutMs, "a third close()");
        const closed = log.events.filter((event) => event.type === "session.closed");
        if (closed.length !== 1)
          throw new Error(`close() emitted session.closed ${closed.length} times, not once`);
        if (closed[0]!.type === "session.closed" && closed[0]!.unexpected !== false)
          throw new Error("session.closed after close() said unexpected: true");
        live = fixture.harness.live();
        const late: HarnessEvent[] = [];
        const stop = session.events((event) => late.push(event));
        if (typeof stop !== "function")
          throw new Error("events() after close returned no unsubscribe");
        await expectRejects(
          session.startTurn({ turnId: "turn-after-close", text: "contract text" }),
          timeoutMs,
          "startTurn after close()",
        );
        stop();
        if (late.length)
          throw new Error(
            `a listener added after close received ${late.map((e) => e.type).join(", ")}`,
          );
        if (fixture.driver.close) {
          await within(fixture.driver.close(), timeoutMs, "driver.close()");
          await within(fixture.driver.close(), timeoutMs, "a second driver.close()");
        }
      });
      if (live !== 0) throw new Error(`${live} harness processes are still running after close()`);
      const after = processListenerCounts();
      for (const name of PROCESS_EVENTS)
        if (after[name] !== before[name])
          throw new Error(
            `process "${name}" listeners went from ${before[name]} to ${after[name]} across a session`,
          );
    },
  },
];

/** Runs one named check. Throws when the name is not a check, so a typo cannot pass. */
export function runHarnessDriverCheck(name: string, factory: HarnessDriverContractFactory) {
  const check = harnessDriverChecks.find((entry) => entry.name === name);
  if (!check) throw new Error(`No harness driver check is named ${JSON.stringify(name)}`);
  return check.run(factory);
}

/** Registers every check as a Vitest case for one driver. */
export function describeHarnessDriverContract(name: string, factory: HarnessDriverContractFactory) {
  describe(`${name} HarnessDriver contract`, () => {
    for (const check of harnessDriverChecks)
      it(check.name, async () => {
        await expect(check.run(factory)).resolves.toBeUndefined();
      });
  });
}
