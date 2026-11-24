// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeDriver } from "../src/server/harness/claude-driver.js";
import { createCodexDriver } from "../src/server/harness/codex-driver.js";
import type { HarnessDriver } from "../src/server/harness/driver.js";
import { createGrokDriver } from "../src/server/harness/grok-driver.js";
import { createPiDriver } from "../src/server/harness/pi-driver.js";
import {
  describeHarnessDriverContract,
  type HarnessDriverContractFactory,
  type HarnessScript,
  type ScriptedHarness,
} from "./helpers/harness-driver-contract.js";

/**
 * Runs the shared HarnessDriver contract against all four Wave 2 drivers, each talking to its stdio mock
 * in `tests/fixtures/harness/`. Setting `HARNESS_CONTRACT_DIR` switches a mock into contract mode: it
 * plays the `HarnessScript` named by the turn text (`contract text`, `contract tool`, ...) and records
 * each long-lived process as `<pid>.pid` in that directory, which is how `live()` and `kill()` find it.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/harness/${name}`, import.meta.url));
const missingBinary = join(tmpdir(), "wildbots-contract-missing-harness");

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The stdio mocks speak each harness's real protocol; this tracks their processes from outside. */
class StdioMockHarness implements ScriptedHarness {
  readonly scripts: HarnessScript[] = [];
  constructor(readonly dir: string) {}
  script(next: HarnessScript) {
    // The contract also sends the script as the turn text, which is what the mock reads.
    this.scripts.push(next);
  }
  private pids() {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".pid"))
      .map((name) => Number.parseInt(name, 10));
  }
  kill() {
    for (const pid of this.pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  live() {
    return this.pids().filter(alive).length;
  }
}

interface MockSetup {
  /** A driver wired to the mock, with the contract directory in its environment. */
  installed(env: Record<string, string>, dir: string): HarnessDriver;
  missing(): HarnessDriver;
  /** A model the mock serves, when it rejects the contract's placeholder. */
  model?: string;
}

function stdioFactory(setup: MockSetup): HarnessDriverContractFactory {
  return {
    timeoutMs: 8_000,
    installed() {
      const dir = mkdtempSync(join(tmpdir(), "wildbots-contract-"));
      const harness = new StdioMockHarness(dir);
      return {
        driver: setup.installed({ HARNESS_CONTRACT_DIR: dir }, dir),
        harness,
        spec: { cwd: dir, ...(setup.model ? { model: setup.model } : {}) },
        cleanup: () => {
          harness.kill();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
    missing: () => ({ driver: setup.missing() }),
  };
}

describeHarnessDriverContract(
  "codex",
  stdioFactory({
    installed: (env) =>
      createCodexDriver({
        command: process.execPath,
        args: [fixture("codex-mock-server.mjs"), "app-server"],
        versionArgs: [fixture("codex-mock-server.mjs"), "--version"],
        requestTimeoutMs: 4_000,
        env: { ...env, CODEX_MOCK_SCENARIO: "contract" },
      }),
    missing: () => createCodexDriver({ command: missingBinary }),
  }),
);

describeHarnessDriverContract(
  "claude-code",
  stdioFactory({
    installed: (env) =>
      createClaudeDriver({
        command: process.execPath,
        args: [fixture("claude-mock-cli.mjs")],
        env,
        closeGraceMs: 2_000,
        killGraceMs: 2_000,
      }),
    missing: () => createClaudeDriver({ command: missingBinary }),
  }),
);

describeHarnessDriverContract(
  "grok",
  stdioFactory({
    installed: (env, dir) =>
      createGrokDriver({
        command: process.execPath,
        args: [fixture("grok-mock-acp.mjs")],
        env: { ...env, GROK_FIXTURE_LOG: join(dir, "wire.ndjson") },
      }),
    missing: () => createGrokDriver({ command: missingBinary }),
    model: "grok-4.6",
  }),
);

describeHarnessDriverContract(
  "pi",
  stdioFactory({
    installed: (env, dir) =>
      createPiDriver({
        command: process.execPath,
        args: [fixture("pi-mock-rpc.mjs")],
        env: { ...env, PI_MOCK_SESSION_DIR: dir },
        tempDir: dir,
      }),
    missing: () => createPiDriver({ command: missingBinary }),
  }),
);
