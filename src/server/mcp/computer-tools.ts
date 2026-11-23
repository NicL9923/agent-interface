import { z } from "zod";
import { terminalCommandPattern } from "../../shared/computer.js";
import {
  screenshotResult,
  toolDefinition,
  toolFailure,
  toolResult,
  type McpToolContext,
  type McpToolProvider,
} from "./mac-tools.js";

class ComputerLeaseError extends Error {
  constructor(
    readonly code: "timed_out" | "handoff_active" | "control_changed",
    message: string,
  ) {
    super(message);
  }
}

type Operation<T> = (signal: AbortSignal) => Promise<T>;

/** One instance per shared computer. Operations settle only after the host can safely accept new input. */
export class ComputerLeaseLock {
  private tail = Promise.resolve();
  private handoffActive = false;
  private handoffEpoch = 0;
  private readonly leaseTtlMs: number;
  private readonly handoffTtlMs: number;

  constructor({ leaseTtlMs = 60_000, handoffTtlMs = 600_000 } = {}) {
    for (const ttl of [leaseTtlMs, handoffTtlMs]) {
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 2_147_483_647)
        throw new RangeError(
          "Computer lease timeouts must be whole milliseconds from 1 to 2147483647.",
        );
    }
    this.leaseTtlMs = leaseTtlMs;
    this.handoffTtlMs = handoffTtlMs;
  }

  run<T>(operation: Operation<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue(operation, this.leaseTtlMs, "The computer action timed out.", signal);
  }

  runHandoff<T>(operation: Operation<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue(
      async (lease) => {
        this.handoffActive = true;
        this.handoffEpoch++;
        try {
          return await operation(lease);
        } finally {
          this.handoffActive = false;
        }
      },
      this.handoffTtlMs,
      "The computer handoff timed out.",
      signal,
    );
  }

  private async enqueue<T>(
    operation: Operation<T>,
    ttl: number,
    timeoutMessage: string,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.handoffActive)
      throw new ComputerLeaseError(
        "handoff_active",
        "The household computer is waiting for a person to hand back control.",
      );
    const epoch = this.handoffEpoch;
    const deadline = new AbortController();
    const lease = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const job = this.tail.then(async () => {
      lease.throwIfAborted();
      if (epoch !== this.handoffEpoch)
        throw new ComputerLeaseError(
          "control_changed",
          "Computer control changed. Take a fresh screenshot or page snapshot before acting.",
        );
      const timer = setTimeout(
        () => deadline.abort(new ComputerLeaseError("timed_out", timeoutMessage)),
        ttl,
      );
      try {
        const result = await operation(lease);
        lease.throwIfAborted();
        return result;
      } finally {
        clearTimeout(timer);
      }
    });
    // Tell the caller about expiry immediately, but wait for the backend to stop before passing the lease on.
    this.tail = job.then(
      () => {},
      () => {},
    );
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(lease.reason);
      lease.addEventListener("abort", abort, { once: true });
      void job.then(resolve, reject).finally(() => lease.removeEventListener("abort", abort));
    });
  }
}

const empty = z.strictObject({});
const coordinate = z.number().int().min(0);
const computerActions = {
  computer_status: {
    description: "Check the household computer and browser status.",
    schema: empty,
  },
  computer_screenshot: {
    description: "Capture the household computer's current screen.",
    schema: empty,
  },
  computer_click: {
    description:
      "Click a point on the household computer. Use coordinates from a fresh screenshot.",
    schema: z.strictObject({
      x: coordinate,
      y: coordinate,
      button: z.enum(["left", "middle", "right"]).optional(),
    }),
  },
  computer_type: {
    description: "Type text into the focused application.",
    schema: z.strictObject({ text: z.string() }),
  },
  computer_key: {
    description: "Press a key or shortcut on the household computer.",
    schema: z.strictObject({ key: z.string().min(1) }),
  },
  computer_scroll: {
    description: "Scroll the household computer by signed horizontal and vertical pixel deltas.",
    schema: z.strictObject({ deltaX: z.number().int().optional(), deltaY: z.number().int() }),
  },
  browser_navigate: {
    description: "Open an HTTP or HTTPS URL in the household browser.",
    schema: z.strictObject({ url: z.url({ protocol: /^https?$/ }) }),
  },
  browser_snapshot: {
    description: "Read a structured snapshot of the current browser page.",
    schema: empty,
  },
};

type ActionName = keyof typeof computerActions;
export type ComputerAction = {
  [Name in ActionName]: { name: Name; args: z.infer<(typeof computerActions)[Name]["schema"]> };
}[ActionName];

/** Adapter for the configured shared desktop or browser. It owns the host's admission and URL policy. */
export interface ComputerBackend {
  /**
   * Honor aborts and settle only once the operation can no longer change the host. For remote
   * actions, that means confirmed cancellation or recovery, even if the client socket is gone.
   * Screenshots return pngBase64 and may include width and height.
   */
  execute(
    action: ComputerAction,
    ctx: McpToolContext,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export type ComputerHandoffOutcome =
  | "handed_back"
  | "declined"
  | "cancelled"
  | "timed_out"
  | "no_person"
  | "computer_unavailable"
  | "user_replied_in_chat";
export type ComputerHandoffRequest = (
  ctx: McpToolContext,
  card: { reason: string; whatToDo: string },
  signal: AbortSignal,
) => Promise<ComputerHandoffOutcome>;

const handoffName = "computer_request_handoff";
const cardText = (limit: number) =>
  z
    .string()
    .overwrite((value) => value.trim().replace(/\s+/g, " "))
    .min(1)
    .max(limit)
    .regex(terminalCommandPattern, "Use visible characters.");
const handoffSchema = z.strictObject({ reason: cardText(200), what_to_do: cardText(300) });
const handoffDefinition = toolDefinition(
  handoffName,
  "Ask a person in WildBots to take over the household computer. Wait for them to hand it back or decline. Ask them to enter passwords or codes on the computer itself.",
  handoffSchema,
);
const definitions = Object.entries(computerActions).map(([name, { description, schema }]) =>
  toolDefinition(name, description, schema),
);
const configuredDefinitions = [...definitions, handoffDefinition];
const sharedComputerLock = new ComputerLeaseLock();

const handoffMessages = {
  declined: "The person chose Not now. Continue without this step or tell them what it blocks.",
  cancelled: "The handoff closed. Do not continue the step that needed a person.",
  timed_out: "Nobody took over the household computer before the handoff timed out.",
  no_person: "Nobody is waiting in this WildBots conversation to take over.",
  computer_unavailable: "The household computer cannot be taken over right now.",
  user_replied_in_chat: "The person replied in chat. Read their message before continuing.",
};

export function createComputerMcpTools({
  backend,
  lock = sharedComputerLock,
  onHandoffRequest,
}: {
  backend: ComputerBackend;
  lock?: ComputerLeaseLock;
  /** Check that a person can see the card. Settle only when they no longer hold control. */
  onHandoffRequest?: ComputerHandoffRequest;
}): McpToolProvider {
  return {
    listTools: () => (onHandoffRequest ? configuredDefinitions : definitions),
    async callTool(ctx, name, args, signal) {
      try {
        if (name === handoffName) {
          if (!onHandoffRequest)
            return toolFailure("computer_unavailable", handoffMessages.computer_unavailable);
          if (ctx.scheduled === true || !ctx.sessionKey)
            return toolFailure("no_person", handoffMessages.no_person);
          const card = handoffSchema.safeParse(args);
          if (!card.success) return toolFailure("invalid_arguments", card.error.issues[0].message);
          const outcome = await lock.runHandoff(
            (lease) =>
              onHandoffRequest(
                ctx,
                {
                  reason: card.data.reason,
                  whatToDo: card.data.what_to_do,
                },
                lease,
              ),
            signal,
          );
          return outcome === "handed_back"
            ? toolResult({
                success: true,
                status: outcome,
                next: "Take a fresh screenshot or page snapshot, then check whether the step is done.",
              })
            : toolFailure(outcome, handoffMessages[outcome]);
        }
        if (!Object.hasOwn(computerActions, name))
          return toolFailure("unknown_tool", "Unknown computer tool.");
        const action = computerActions[name as ActionName];
        const parsed = action.schema.safeParse(args === undefined ? {} : args);
        if (!parsed.success)
          return toolFailure("invalid_arguments", parsed.error.issues[0].message);
        // The matching schema validates the arguments for each action name.
        const command = { name, args: parsed.data } as ComputerAction;
        const value = await lock.run((lease) => backend.execute(command, ctx, lease), signal);
        return name === "computer_screenshot"
          ? screenshotResult(value)
          : toolResult({ ok: true, value });
      } catch (error) {
        if (signal?.aborted) return toolFailure("cancelled", "The computer action was cancelled.");
        if (error instanceof ComputerLeaseError) return toolFailure(error.code, error.message);
        return toolFailure(
          "failed",
          error instanceof Error ? error.message : "The computer action failed.",
        );
      }
    },
  };
}
