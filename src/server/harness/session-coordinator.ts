import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { HarnessDriver, HarnessEvent, HarnessSession, HarnessSessionSpec } from "./driver.js";

type LiveSession = {
  session: HarnessSession;
  fingerprint: string;
  unsubscribe: () => void;
  contextTokens?: number;
  contextWindow?: number;
};

type Slot<T> = {
  active?: T;
  live?: LiveSession;
  opening?: Promise<HarnessSession | undefined>;
  closing?: Promise<void>;
};

const sessionFingerprint = (driver: HarnessDriver, spec: Omit<HarnessSessionSpec, "sessionKey">) =>
  createHash("sha256")
    .update(JSON.stringify([driver.id, spec]))
    .digest("hex");

export class HarnessSessionCoordinator<T extends { runId: string; promptSeq: number }> {
  private readonly slots = new Map<string, Slot<T>>();

  constructor(
    private readonly transcripts: Store["transcripts"],
    private readonly contextFraction = 0.75,
  ) {
    if (!(contextFraction > 0 && contextFraction <= 1))
      throw new RangeError(
        "The harness context fraction must be greater than zero and at most one.",
      );
  }

  active(botId: string): T | undefined {
    return this.slots.get(botId)?.active;
  }

  session(botId: string): HarnessSession | undefined {
    return this.slots.get(botId)?.live?.session;
  }

  reserve(botId: string, turn: T) {
    const slot = this.slots.get(botId) ?? {};
    if (slot.active) throw new Error("A harness turn is already active.");
    slot.active = turn;
    this.slots.set(botId, slot);
  }

  release(botId: string, turn: T) {
    const slot = this.slots.get(botId);
    if (slot?.active === turn) {
      slot.active = undefined;
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
    if (!slot || slot.active !== turn) return;
    await Promise.all([slot.opening, slot.closing]);
    if (slot.active !== turn) return;

    const fingerprint = sessionFingerprint(driver, spec);
    const live = slot.live;
    const overBudget =
      live?.contextWindow !== undefined &&
      live.contextTokens !== undefined &&
      live.contextTokens > live.contextWindow * this.contextFraction;
    if (live?.fingerprint === fingerprint && !overBudget) return live.session;

    const opening = (async () => {
      if (live) await this.dispose(botId, slot);
      if (slot.active !== turn) return;
      const systemPrompt = this.handoff(botId, turn.promptSeq, spec.systemPrompt);
      const session = await driver.openSession({
        ...spec,
        systemPrompt,
        sessionKey: randomUUID(),
      });
      if (slot.active !== turn) {
        await session.close();
        return;
      }
      const entry: LiveSession = { session, fingerprint, unsubscribe: () => {} };
      slot.live = entry;
      entry.unsubscribe = session.events((event) => {
        if (slot.live !== entry) return;
        const active = slot.active;
        if (event.type === "session.closed") {
          void this.dispose(botId, slot).catch(() => {});
          onEvent(active, event);
        } else if (event.type === "session.ready") {
          onEvent(active, event);
        } else if (active && event.turnId === active.runId) {
          if (event.type === "usage.reported") {
            const { contextTokens, contextWindow } = event;
            if (contextTokens !== undefined && Number.isFinite(contextTokens) && contextTokens >= 0)
              entry.contextTokens = contextTokens;
            if (contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0)
              entry.contextWindow = contextWindow;
          }
          onEvent(active, event);
        }
      });
      if (slot.live !== entry) entry.unsubscribe();
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

  async retireSession(botId: string) {
    const slot = this.slots.get(botId);
    if (!slot) return;
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

  async close() {
    const results = await Promise.allSettled([...this.slots.keys()].map((id) => this.closeBot(id)));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Harness session teardown failed.");
  }

  private dispose(botId: string, slot: Slot<T>): Promise<void> {
    if (slot.closing) return slot.closing;
    const live = slot.live;
    if (!live) return Promise.resolve();
    slot.live = undefined;
    const closing = Promise.resolve()
      .then(() => {
        live.unsubscribe();
        return live.session.close();
      })
      .finally(() => {
        slot.closing = undefined;
        this.prune(botId, slot);
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

  private handoff(botId: string, beforeSeq: number, prompt?: string): string | undefined {
    const recent = this.transcripts
      .listPage(botId, { limit: 16, beforeSeq })
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
