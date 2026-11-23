import { createClaudeDriver, type ClaudeDriverOptions } from "./claude-driver.js";
import { createCodexDriver, type CodexDriverOptions } from "./codex-driver.js";
import type { HarnessDriver, HarnessDriverId } from "./driver.js";
import { createGrokDriver, type GrokDriverOptions } from "./grok-driver.js";
import { createPiDriver, type PiDriverOptions } from "./pi-driver.js";

export * from "./driver.js";
export { createClaudeDriver, type ClaudeDriverOptions } from "./claude-driver.js";
export { createCodexDriver, type CodexDriverOptions } from "./codex-driver.js";
export { createGrokDriver, type GrokDriverOptions } from "./grok-driver.js";
export { createPiDriver, type PiDriverOptions } from "./pi-driver.js";
export { createHarnessRuntime, type HarnessRuntimeOptions } from "./runtime.js";
export * from "./session-coordinator.js";
export * from "./process-spawn.js";

export interface DefaultHarnessDriverOptions {
  codex?: CodexDriverOptions | false;
  claude?: ClaudeDriverOptions | false;
  grok?: GrokDriverOptions | false;
  pi?: PiDriverOptions | false;
}

/** Instantiates all four native harness drivers (Codex, Claude Code, Grok, Pi). */
export function createDefaultHarnessDrivers(
  options: DefaultHarnessDriverOptions = {},
): Partial<Record<HarnessDriverId, HarnessDriver>> {
  const drivers: Partial<Record<HarnessDriverId, HarnessDriver>> = {};
  if (options.codex !== false) drivers.codex = createCodexDriver(options.codex);
  if (options.claude !== false) drivers["claude-code"] = createClaudeDriver(options.claude);
  if (options.grok !== false) drivers.grok = createGrokDriver(options.grok);
  if (options.pi !== false) drivers.pi = createPiDriver(options.pi);
  return drivers;
}
