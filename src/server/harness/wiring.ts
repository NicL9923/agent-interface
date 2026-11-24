import { InvalidInput } from "../../shared/errors.js";
import type { BotInput, HarnessOption, Runtime } from "../../shared/types.js";
import type { FileSigner } from "../hermes-files.js";
import { createRuntimeRouter, hermesRuntimeId } from "../runtime-router.js";
import type { Store } from "../store.js";
import { asksForNativeHarness } from "../../shared/harness.js";
import type { HarnessDriver, HarnessDriverId } from "./driver.js";
import {
  createHarnessRuntime,
  type HarnessRuntime,
  type HarnessRuntimeOptions,
} from "./runtime.js";

/** The router ID native harness bots run under. `ManagedBotRepository.runtimeIdForBot` returns it. */
export const harnessRuntimeId = "harness";

/**
 * For a server running only Hermes: refuses a new assistant that asks for a native harness, which Hermes would
 * otherwise create as one of its own profiles.
 */
export const hermesOnlyForNew = (input: BotInput): undefined => {
  if (asksForNativeHarness(input.harness))
    throw new InvalidInput("This server runs only Hermes assistants.");
  return undefined;
};

/** How long one round of harness probes answers `/api/bootstrap` before the binaries run again. */
export const HARNESS_PROBE_TTL_MS = 30_000;

export interface CompositeRuntimeOptions {
  store: Store;
  hermes: Runtime;
  drivers: Partial<Record<HarnessDriverId, HarnessDriver>>;
  workspaceRoot: string;
  files: FileSigner;
  defaultMcpServers?: HarnessRuntimeOptions["defaultMcpServers"];
  /** Overrides `HARNESS_PROBE_TTL_MS`. */
  probeTtlMs?: number;
  /** The clock the probe cache reads. */
  now?: () => number;
}

export interface CompositeRuntime {
  /** Hermes and the native harnesses behind one `Runtime`, routed per assistant. Its `close()` closes both. */
  runtime: Runtime;
  harnessRuntime: HarnessRuntime;
  /**
   * Every registered native harness and whether it can run now, for `/api/bootstrap`'s `harnesses`. A bound function,
   * so it can be handed to a route on its own.
   */
  probeHarnesses: () => Promise<HarnessOption[]>;
  /** Running queue rows no runtime recovered at startup and the sweep marked interrupted. */
  sweptQueueItems: number;
}

/**
 * Composes the server's runtime: Hermes stays the default, and every assistant whose managed record names a native
 * harness runs on `HarnessRuntime`. `index.ts` replaces its single-runtime router with `composite.runtime` and hands
 * `composite.probeHarnesses` to the bootstrap route.
 */
export function createCompositeRuntime({
  store,
  hermes,
  drivers,
  workspaceRoot,
  files,
  defaultMcpServers,
  probeTtlMs = HARNESS_PROBE_TTL_MS,
  now = Date.now,
}: CompositeRuntimeOptions): CompositeRuntime {
  // Construction recovers each native assistant's claimed row from its recorded outcome, synchronously.
  const harnessRuntime = createHarnessRuntime({
    store,
    drivers,
    workspaceRoot,
    files,
    defaultMcpServers,
  });
  // Whatever is still running belongs to no live dispatcher: an archived assistant, one moved to Hermes, or a row
  // from before a crash that nothing else reads. Each would hold its assistant's queue shut forever, because a claim
  // waits for no running row. This runs before the drains the runtime queued as microtasks, so it never touches a
  // row claimed in this process.
  const sweptQueueItems = store.queue.markRunningInterrupted();

  const runtime = createRuntimeRouter({
    runtimes: { [hermesRuntimeId]: hermes, [harnessRuntimeId]: harnessRuntime },
    defaultRuntime: hermesRuntimeId,
    runtimeOf: (botId) => store.managedBots.runtimeIdForBot(botId),
    // An unknown harness goes to HarnessRuntime too, which refuses it, so it never becomes a Hermes profile.
    runtimeForNew: (input) => (asksForNativeHarness(input.harness) ? harnessRuntimeId : undefined),
  });

  let cached: { at: number; options: HarnessOption[] } | undefined;
  let pending: Promise<HarnessOption[]> | undefined;

  return {
    runtime,
    harnessRuntime,
    sweptQueueItems,
    probeHarnesses: () => {
      if (cached && now() - cached.at < probeTtlMs) return Promise.resolve(cached.options);
      // Concurrent page loads share one round. A probe that throws comes back as unavailable with a
      // reason (`HarnessRuntime.harnessOptions`), so a broken binary is cached like any answer.
      pending ??= harnessRuntime
        .harnessOptions()
        .then((options) => {
          cached = { at: now(), options };
          return options;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
