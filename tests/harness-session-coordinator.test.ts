import { afterEach, describe, expect, it } from "vitest";
import type {
  HarnessDriver,
  HarnessEvent,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTurnInput,
} from "../src/server/harness/driver.js";
import { HarnessSessionCoordinator } from "../src/server/harness/session-coordinator.js";
import { Store } from "../src/server/store.js";

class FakeSession implements HarnessSession {
  private listener?: (event: HarnessEvent) => void;
  readonly providerSessionId: string;
  closed = false;
  closeError?: Error;
  beforeClose?: () => Promise<void>;

  constructor(readonly id: string) {
    this.providerSessionId = `provider-${id}`;
  }

  events(listener: (event: HarnessEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: HarnessEvent) {
    this.listener?.(event);
  }

  async startTurn(_input: HarnessTurnInput) {}
  async answerQuestion() {}
  async interrupt() {}

  async close() {
    await this.beforeClose?.();
    this.closed = true;
    if (this.closeError) throw this.closeError;
  }
}

class FakeDriver implements HarnessDriver {
  readonly id = "codex" as const;
  readonly displayName = "codex";
  readonly capabilities = {
    nativeSteering: true,
    resumable: true,
    supportsMcp: true,
    supportsImages: true,
    supportsReasoning: true,
    supportsSpeed: true,
  };
  readonly opened: FakeSession[] = [];
  nextOpen?: (spec: HarnessSessionSpec) => Promise<FakeSession>;

  async probe() {
    return { available: true };
  }

  async listModels() {
    return [];
  }

  async openSession(spec: HarnessSessionSpec) {
    if (this.nextOpen) {
      const fn = this.nextOpen;
      this.nextOpen = undefined;
      return fn(spec);
    }
    const session = new FakeSession(spec.sessionKey);
    this.opened.push(session);
    return session;
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  const store = new Store(":memory:");
  let clock = 1_000;
  const coordinator = new HarnessSessionCoordinator<{ runId: string; promptSeq: number }>(
    store.transcripts,
    0.75,
    { idleTtlMs: 60_000, now: () => clock },
  );
  const driver = new FakeDriver();
  cleanups.push(async () => {
    await coordinator.close().catch(() => {});
    store.close();
  });
  const spec = (botId: string): Omit<HarnessSessionSpec, "sessionKey"> => ({
    botId,
    cwd: "/tmp",
    model: "model-1",
    fullPermissions: true,
  });
  return {
    coordinator,
    driver,
    spec,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("HarnessSessionCoordinator", () => {
  it("recovers cleanly in open() when an in-flight speculative warm() rejects", async () => {
    const { coordinator, driver, spec } = setup();
    let rejectWarm!: (error: Error) => void;
    let warmStarted!: () => void;
    const warmGate = new Promise<FakeSession>((_resolve, reject) => {
      rejectWarm = reject;
    });
    const started = new Promise<void>((resolve) => {
      warmStarted = resolve;
    });
    driver.nextOpen = async () => {
      warmStarted();
      return warmGate;
    };

    const warming = coordinator.warm("alpha", driver, spec("alpha"), () => {});
    await started;

    const turn = { runId: "run-1", promptSeq: 1 };
    coordinator.reserve("alpha", turn);
    const opening = coordinator.open("alpha", turn, driver, spec("alpha"), () => {});

    rejectWarm(new Error("speculative warm failed"));
    await expect(warming).rejects.toThrow("speculative warm failed");

    const session = await opening;
    expect(session).toBeDefined();
    expect(driver.opened).toHaveLength(1);
    expect(coordinator.session("alpha")).toBe(session);
    coordinator.release("alpha", turn);
  });

  it("recovers cleanly in open() when an in-flight background dispose() rejects", async () => {
    const { coordinator, driver, spec, advance } = setup();
    const initial = await coordinator.warm("alpha", driver, spec("alpha"), () => {});
    expect(initial).toBeDefined();
    const fakeInitial = driver.opened[0]!;
    let releaseClose!: () => void;
    let closeStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    fakeInitial.beforeClose = async () => {
      closeStarted();
      await closeGate;
    };
    fakeInitial.closeError = new Error("stale process failed to exit");

    advance(60_001);
    const reaping = coordinator.reapIdle();
    await started;

    const turn = { runId: "run-2", promptSeq: 1 };
    coordinator.reserve("alpha", turn);
    const opening = coordinator.open("alpha", turn, driver, spec("alpha"), () => {});

    releaseClose();
    await reaping;

    const fresh = await opening;
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(fakeInitial);
    expect(driver.opened).toHaveLength(2);
    expect(coordinator.session("alpha")).toBe(fresh);
    coordinator.release("alpha", turn);
  });

  it("closes only slots matching the predicate in closeMatching()", async () => {
    const { coordinator, driver, spec } = setup();
    await coordinator.warm("group:room-a:alpha", driver, spec("alpha"), () => {});
    await coordinator.warm("group:room-b:alpha", driver, spec("alpha"), () => {});
    await coordinator.warm("group:room-a:beta", driver, spec("beta"), () => {});
    const [alphaRoomA, alphaRoomB, betaRoomA] = driver.opened;

    await coordinator.closeMatching((key) => key.endsWith(":alpha"));

    expect(alphaRoomA?.closed).toBe(true);
    expect(alphaRoomB?.closed).toBe(true);
    expect(betaRoomA?.closed).toBe(false);
    expect(coordinator.session("group:room-a:alpha")).toBeUndefined();
    expect(coordinator.session("group:room-b:alpha")).toBeUndefined();
    expect(coordinator.session("group:room-a:beta")).toBe(betaRoomA);
  });
});
