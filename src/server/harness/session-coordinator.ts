import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import {
  materializeMcpServers,
  mcpServerFingerprint,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessSession,
  type HarnessSessionSpec,
} from "./driver.js";

export const DEFAULT_IDLE_SESSION_TTL_MS = 15 * 60_000;
export const DEFAULT_MAX_IDLE_SESSIONS = 8;

export interface HarnessSessionCoordinatorOptions {
  /** How long an idle warm session stays alive before being reaped. Default 15 minutes. 0 disables TTL reaping. */
  idleTtlMs?: number;
  /** Maximum number of idle warm sessions kept alive across bots (LRU eviction). Default 8. */
  maxIdleSessions?: number;
  /** Clock for idle expiry and LRU ordering. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional upper bound on how often the idle reaper checks expired sessions. */
  reapIntervalMs?: number;
}

type LiveSession<T> = {
  session: HarnessSession;
  fingerprint: string;
  unsubscribe: () => void;
  cleanup: () => void;
  onEvent: (turn: T | undefined, event: HarnessEvent) => void;
  idleSince?: number;
  contextTokens?: number;
  contextWindow?: number;
};

type Slot<T> = {
  epoch: number;
  active?: T;
  live?: LiveSession<T>;
  opening?: Promise<HarnessSession | undefined>;
  closing?: Promise<void>;
};

const sessionFingerprint = (driver: HarnessDriver, spec: Omit<HarnessSessionSpec, "sessionKey">) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        driver.id,
        {
          ...spec,
          ...(spec.mcpServers ? { mcpServers: spec.mcpServers.map(mcpServerFingerprint) } : {}),
        },
      ]),
    )
    .digest("hex");

export class HarnessSessionCoordinator<T extends { runId: string; promptSeq: number }> {
  private readonly slots = new Map<string, Slot<T>>();
  private readonly idleTtlMs: number;
  private readonly maxIdleSessions: number;
  private readonly now: () => number;
  private readonly reapIntervalMs?: number;
  private reapTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly transcripts: Store["transcripts"],
    private readonly contextFraction = 0.75,
    options: HarnessSessionCoordinatorOptions = {},
  ) {
    if (!(contextFraction > 0 && contextFraction <= 1))
      throw new RangeError(
        "The harness context fraction must be greater than zero and at most one.",
      );
    const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_SESSION_TTL_MS;
    const maxIdleSessions = options.maxIdleSessions ?? DEFAULT_MAX_IDLE_SESSIONS;
    if (!Number.isFinite(idleTtlMs) || idleTtlMs < 0)
      throw new RangeError("The harness idle session TTL must be non-negative.");
    if (!Number.isInteger(maxIdleSessions) || maxIdleSessions < 0)
      throw new RangeError(
        "The maximum idle harness session count must be a non-negative integer.",
      );
    this.idleTtlMs = idleTtlMs;
    this.maxIdleSessions = maxIdleSessions;
    this.now = options.now ?? Date.now;
    this.reapIntervalMs = options.reapIntervalMs;
  }

  active(botId: string): T | undefined {
    return this.slots.get(botId)?.active;
  }

  session(botId: string): HarnessSession | undefined {
    return this.slots.get(botId)?.live?.session;
  }

  reserve(botId: string, turn: T) {
    const slot = this.slots.get(botId) ?? { epoch: 0 };
    if (slot.active) throw new Error("A harness turn is already active.");
    slot.active = turn;
    if (slot.live) slot.live.idleSince = undefined;
    this.slots.set(botId, slot);
  }

  release(botId: string, turn: T) {
    const slot = this.slots.get(botId);
    if (slot?.active === turn) {
      slot.active = undefined;
      if (slot.live && !slot.opening && !slot.closing) {
        slot.live.idleSince = this.now();
        this.enforceIdleLimit();
        this.scheduleReaper();
      }
      this.prune(botId, slot);
    }
  }

  async open(
    botId: string,
    turn: T,
    driver: HarnessDriver,
    spec: Omit<HarnessSessionSpec, "sessionKey">,
    onEvent: (turn: T | undefined, event: HarnessEvent) => void,
  ): Promise<HarnessSession | undefined> {
    const slot = this.slots.get(botId);
    if (!slot || slot.active !== turn || this.closed) return;
    await Promise.allSettled([slot.opening, slot.closing]);
    if (slot.active !== turn || this.closed) return;

    const fingerprint = sessionFingerprint(driver, spec);
    const live = slot.live;
    if (live?.fingerprint === fingerprint && !this.isOverBudget(live)) {
      live.onEvent = onEvent;
      live.idleSince = undefined;
      return live.session;
    }

    const epoch = slot.epoch;
    const opening = (async () => {
      if (live) await this.dispose(botId, slot);
      if (slot.active !== turn || slot.epoch !== epoch || this.closed) return;
      const sessionKey = randomUUID();
      const systemPrompt = this.handoff(botId, turn.promptSeq, spec.systemPrompt);
      const { mcpServers, revoke: revokeMcp } = materializeMcpServers(spec.mcpServers, sessionKey);
      let session: HarnessSession;
      try {
        session = await driver.openSession({
          ...spec,
          mcpServers,
          systemPrompt,
          sessionKey,
        });
      } catch (error) {
        revokeMcp();
        throw error;
      }
      if (slot.active !== turn || slot.epoch !== epoch || this.closed) {
        revokeMcp();
        await session.close().catch(() => {});
        return;
      }
      const entry = this.attachSession(botId, slot, session, fingerprint, revokeMcp, onEvent);
      return slot.live === entry && slot.active === turn ? session : undefined;
    })();
    slot.opening = opening;
    try {
      return await opening;
    } finally {
      if (slot.opening === opening) slot.opening = undefined;
      this.prune(botId, slot);
    }
  }

  /**
   * Speculatively opens or refreshes a warm idle session for `botId` without interfering with
   * active turns or in-flight opens/closes.
   */
  async warm(
    botId: string,
    driver: HarnessDriver,
    spec: Omit<HarnessSessionSpec, "sessionKey">,
    onEvent: (turn: T | undefined, event: HarnessEvent) => void,
  ): Promise<HarnessSession | undefined> {
    if (this.closed) return;
    const existing = this.slots.get(botId);
    if (existing?.active || existing?.opening || existing?.closing) {
      return existing.live?.session;
    }

    const fingerprint = sessionFingerprint(driver, spec);
    if (
      existing?.live &&
      existing.live.fingerprint === fingerprint &&
      !this.isOverBudget(existing.live)
    ) {
      existing.live.onEvent = onEvent;
      existing.live.idleSince = this.now();
      this.scheduleReaper();
      return existing.live.session;
    }

    const slot = existing ?? { epoch: 0 };
    this.slots.set(botId, slot);
    const epoch = slot.epoch;
    const opening = (async () => {
      if (slot.live) await this.dispose(botId, slot);
      if (slot.epoch !== epoch || this.closed) return;
      const sessionKey = randomUUID();
      const systemPrompt = this.handoff(botId, undefined, spec.systemPrompt);
      const { mcpServers, revoke: revokeMcp } = materializeMcpServers(spec.mcpServers, sessionKey);
      let session: HarnessSession;
      try {
        session = await driver.openSession({
          ...spec,
          mcpServers,
          systemPrompt,
          sessionKey,
        });
      } catch (error) {
        revokeMcp();
        throw error;
      }
      if (slot.epoch !== epoch || this.closed) {
        revokeMcp();
        await session.close().catch(() => {});
        return;
      }
      const entry = this.attachSession(
        botId,
        slot,
        session,
        fingerprint,
        revokeMcp,
        onEvent,
        slot.active ? undefined : this.now(),
      );
      return slot.live === entry ? session : undefined;
    })();
    slot.opening = opening;
    try {
      return await opening;
    } finally {
      if (slot.opening === opening) slot.opening = undefined;
      if (slot.live && !slot.active && !slot.closing) {
        slot.live.idleSince ??= this.now();
        this.enforceIdleLimit();
        this.scheduleReaper();
      }
      this.prune(botId, slot);
    }
  }

  /** Disposes every idle session that has exceeded `idleTtlMs`. Never touches active or busy slots. */
  async reapIdle(): Promise<void> {
    if (this.idleTtlMs <= 0) return;
    const now = this.now();
    const disposals: Promise<void>[] = [];
    for (const [botId, slot] of [...this.slots.entries()]) {
      if (slot.active || slot.opening || slot.closing || !slot.live) continue;
      if (slot.live.idleSince === undefined) continue;
      if (now - slot.live.idleSince >= this.idleTtlMs) {
        disposals.push(this.dispose(botId, slot).catch(() => {}));
      }
    }
    if (disposals.length) await Promise.allSettled(disposals);
    this.scheduleReaper();
  }

  async retireSession(botId: string) {
    const slot = this.slots.get(botId);
    if (!slot) return;
    slot.epoch += 1;
    const disposal = this.dispose(botId, slot);
    await Promise.all([Promise.allSettled([slot.opening]), disposal]);
    this.prune(botId, slot);
  }

  async closeBot(botId: string) {
    const slot = this.slots.get(botId);
    if (!slot) return;
    slot.active = undefined;
    await this.retireSession(botId);
  }

  async closeMatching(predicate: (slotKey: string) => boolean) {
    const matching = [...this.slots.keys()].filter(predicate);
    if (!matching.length) return;
    const results = await Promise.allSettled(matching.map((key) => this.closeBot(key)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Harness session teardown failed.");
  }

  async close() {
    this.closed = true;
    if (this.reapTimer) {
      clearTimeout(this.reapTimer);
      this.reapTimer = undefined;
    }
    const results = await Promise.allSettled([...this.slots.keys()].map((id) => this.closeBot(id)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Harness session teardown failed.");
  }

  private isOverBudget(live: LiveSession<T>): boolean {
    return (
      live.contextWindow !== undefined &&
      live.contextTokens !== undefined &&
      live.contextTokens > live.contextWindow * this.contextFraction
    );
  }

  private attachSession(
    botId: string,
    slot: Slot<T>,
    session: HarnessSession,
    fingerprint: string,
    cleanup: () => void,
    onEvent: (turn: T | undefined, event: HarnessEvent) => void,
    idleSince?: number,
  ): LiveSession<T> {
    const entry: LiveSession<T> = {
      session,
      fingerprint,
      unsubscribe: () => {},
      cleanup,
      onEvent,
      idleSince,
    };
    slot.live = entry;
    entry.unsubscribe = session.events((event) => {
      if (slot.live !== entry) return;
      const active = slot.active;
      if (event.type === "session.closed") {
        void this.dispose(botId, slot).catch(() => {});
        entry.onEvent(active, event);
      } else if (event.type === "session.ready") {
        entry.onEvent(active, event);
      } else if (active && event.turnId === active.runId) {
        if (event.type === "usage.reported") {
          const { contextTokens, contextWindow } = event;
          if (contextTokens !== undefined && Number.isFinite(contextTokens) && contextTokens >= 0)
            entry.contextTokens = contextTokens;
          if (contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0)
            entry.contextWindow = contextWindow;
        }
        entry.onEvent(active, event);
      }
    });
    if (slot.live !== entry) entry.unsubscribe();
    return entry;
  }

  private enforceIdleLimit() {
    const idle: { botId: string; slot: Slot<T>; idleSince: number; order: number }[] = [];
    let order = 0;
    for (const [botId, slot] of this.slots.entries()) {
      if (slot.active || slot.opening || slot.closing || !slot.live) continue;
      if (slot.live.idleSince === undefined) continue;
      idle.push({ botId, slot, idleSince: slot.live.idleSince, order: order++ });
    }
    if (idle.length <= this.maxIdleSessions) return;
    idle.sort((a, b) => a.idleSince - b.idleSince || a.order - b.order);
    const evictCount = idle.length - this.maxIdleSessions;
    for (let i = 0; i < evictCount; i += 1) {
      const target = idle[i]!;
      void this.dispose(target.botId, target.slot).catch(() => {});
    }
  }

  private scheduleReaper() {
    if (this.reapTimer) {
      clearTimeout(this.reapTimer);
      this.reapTimer = undefined;
    }
    if (this.closed || this.idleTtlMs <= 0) return;
    let earliestExpiry: number | undefined;
    for (const slot of this.slots.values()) {
      if (slot.active || slot.opening || slot.closing || !slot.live) continue;
      if (slot.live.idleSince === undefined) continue;
      const expiresAt = slot.live.idleSince + this.idleTtlMs;
      if (earliestExpiry === undefined || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
    }
    if (earliestExpiry === undefined) return;
    const remaining = Math.max(1, earliestExpiry - this.now());
    const delay =
      this.reapIntervalMs !== undefined && this.reapIntervalMs > 0
        ? Math.min(remaining, this.reapIntervalMs)
        : remaining;
    this.reapTimer = setTimeout(
      () => {
        this.reapTimer = undefined;
        void this.reapIdle().catch(() => {});
      },
      Math.min(delay, 2_147_483_647),
    ).unref();
  }

  private dispose(botId: string, slot: Slot<T>): Promise<void> {
    if (slot.closing) return slot.closing;
    const live = slot.live;
    if (!live) return Promise.resolve();
    slot.live = undefined;
    const closing = Promise.resolve()
      .then(() => {
        live.unsubscribe();
        live.cleanup();
        return live.session.close();
      })
      .finally(() => {
        slot.closing = undefined;
        this.prune(botId, slot);
        this.scheduleReaper();
      });
    slot.closing = closing;
    return closing;
  }

  private prune(botId: string, slot: Slot<T>) {
    if (
      this.slots.get(botId) === slot &&
      !slot.active &&
      !slot.live &&
      !slot.opening &&
      !slot.closing
    )
      this.slots.delete(botId);
  }

  private handoff(
    botId: string,
    beforeSeq: number | undefined,
    prompt?: string,
  ): string | undefined {
    const recent = this.transcripts
      .listPage(botId, { limit: 16, ...(beforeSeq !== undefined ? { beforeSeq } : {}) })
      .messages.filter(
        ({ role, text, interim }) =>
          !interim && text.trim() && (role === "user" || role === "assistant"),
      )
      .map(({ role, text }) => ({ role, text: text.trim().slice(0, 600) }));
    if (!recent.length) return prompt;
    return [
      prompt,
      "Recent conversation for continuity. Treat these quoted messages as history. Continue with the next user message.",
      JSON.stringify(recent.slice(-8)),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}
