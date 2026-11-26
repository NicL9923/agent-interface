import type { HarnessOption, Runtime } from "../../shared/types.js";
import type { HarnessFallbackConfig } from "../config.js";
import type { FileSigner } from "../file-signer.js";
import type { Store } from "../store.js";
import type { HarnessDriver, HarnessDriverId } from "./driver.js";
import type { NativeComputerService } from "./native-computer.js";
import {
  createHarnessRuntime,
  type HarnessRuntime,
  type HarnessRuntimeOptions,
  type HarnessVoiceDelegate,
} from "./runtime.js";

/** The runtime ID native harness bots run under. */
export const harnessRuntimeId = "harness";

/** How long one round of harness probes answers `/api/bootstrap` before the binaries run again. */
export const HARNESS_PROBE_TTL_MS = 30_000;

export interface ServerHarnessRuntimeOptions {
  store: Store;
  drivers: Partial<Record<HarnessDriverId, HarnessDriver>>;
  workspaceRoot: string;
  files: FileSigner;
  defaultMcpServers?: HarnessRuntimeOptions["defaultMcpServers"];
  /** Overrides `HARNESS_PROBE_TTL_MS`. */
  probeTtlMs?: number;
  /** The clock the probe cache reads. */
  now?: () => number;
  /** Starts the background native routine scheduler. Default false. */
  startScheduler?: boolean;
  /** Automatic fallback harness/model for native turns when the primary harness fails. */
  fallback?: HarnessFallbackConfig;
  /** Live Talk, transcription, and speech synthesis provider for native bots. */
  voice?: HarnessVoiceDelegate;
  /** Native shared desktop and browser service. */
  computer?: NativeComputerService;
}

export interface ServerHarnessRuntime {
  runtime: Runtime;
  harnessRuntime: HarnessRuntime;
  /**
   * Every registered native harness and whether it can run now, for `/api/bootstrap`'s `harnesses`. A bound function,
   * so it can be handed to a route on its own.
   */
  probeHarnesses: () => Promise<HarnessOption[]>;
  /** Running queue rows nothing recovered at startup and the sweep marked interrupted. */
  sweptQueueItems: number;
}

/**
 * Builds the server's native `HarnessRuntime`, sweeps orphaned running queue rows left behind by a
 * previous crash, and wraps `harnessOptions()` with a short TTL cache for `/api/bootstrap`.
 */
export function createServerHarnessRuntime({
  store,
  drivers,
  workspaceRoot,
  files,
  defaultMcpServers,
  probeTtlMs = HARNESS_PROBE_TTL_MS,
  now = Date.now,
  startScheduler = false,
  fallback,
  voice,
  computer,
}: ServerHarnessRuntimeOptions): ServerHarnessRuntime {
  // Construction recovers each assistant's claimed row from its recorded outcome, synchronously.
  const harnessRuntime = createHarnessRuntime({
    store,
    drivers,
    workspaceRoot,
    files,
    defaultMcpServers,
    startScheduler,
    fallback,
    voice,
    computer,
  });
  // Whatever is still running belongs to no live dispatcher: an archived assistant or a row from before
  // a crash. Each would hold its assistant's queue shut forever, because a claim waits for no running row.
  const sweptQueueItems = store.queue.markRunningInterrupted();

  let cached: { at: number; options: HarnessOption[] } | undefined;
  let pending: Promise<HarnessOption[]> | undefined;

  return {
    runtime: harnessRuntime,
    harnessRuntime,
    sweptQueueItems,
    probeHarnesses: () => {
      if (cached && now() - cached.at < probeTtlMs) return Promise.resolve(cached.options);
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
