/** Tests for .agents/tools/ios-validation-state.mjs and .agents/tools/validate-ios.sh. */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TOOLS = join(ROOT, ".agents", "tools");

function makeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

describe("ios-validation-state.mjs", () => {
  let tmp: string;
  let repo: string;
  let bin: string;
  let baseEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ios-val-state-"));
    repo = join(tmp, "repo");
    bin = join(tmp, "bin");
    mkdirSync(join(repo, ".agents", "tools"), { recursive: true });
    mkdirSync(join(repo, ".agents", "fixtures"), { recursive: true });
    mkdirSync(join(repo, "ios", "AgentInterface"), { recursive: true });
    mkdirSync(bin, { recursive: true });

    for (const file of [
      "ios-validation-state.mjs",
      "patch-xctestrun.mjs",
      "source-state.mjs",
      "validate-ios.sh",
    ]) {
      copyFileSync(join(TOOLS, file), join(repo, ".agents", "tools", file));
    }
    writeFileSync(join(repo, "ios", "AgentInterface", "App.swift"), "struct App {}\n", "utf8");
    writeFileSync(join(repo, ".agents", "fixtures", "home-design.json"), '{"bots":[]}\n', "utf8");

    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    };
    execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv });
    execFileSync("git", ["add", "."], { cwd: repo, env: gitEnv });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, env: gitEnv });

    makeExecutable(
      join(bin, "xcrun"),
      `#!/usr/bin/env bash
case "$1 $2 $3" in
  "simctl list devices")
    echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-0":[{"udid":"SIM-1","name":"iPhone 18","state":"Shutdown","deviceTypeIdentifier":"iPhone"}]}}'
    ;;
  "simctl list runtimes")
    echo '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-0","version":"26.0","buildversion":"26A1"}]}'
    ;;
  "--sdk iphonesimulator --show-sdk-build-version")
    echo "26A1"
    ;;
  "xcresulttool get test-results")
    echo '{"result":"Passed","passedTests":42,"failedTests":0,"skippedTests":1,"expectedFailures":0,"testFailures":[]}'
    ;;
  *) exit 1 ;;
esac
`,
    );
    makeExecutable(join(bin, "xcodebuild"), "#!/usr/bin/env bash\necho 'Xcode 27.0'\n");
    makeExecutable(
      join(bin, "xcode-select"),
      "#!/usr/bin/env bash\necho '/Applications/Xcode.app'\n",
    );
    makeExecutable(join(bin, "sw_vers"), "#!/usr/bin/env bash\necho '26A1'\n");

    const sanitizedEnv: NodeJS.ProcessEnv = { ...gitEnv };
    for (const key of Object.keys(sanitizedEnv)) {
      if (
        ["AGENT_INTERFACE_", "TEST_RUNNER_", "SIMCTL_CHILD_", "SWIFT_", "XCODE_", "DYLD_"].some(
          (prefix) => key.startsWith(prefix),
        ) ||
        [
          "MAC_HEAVY_LOCK_OWNER",
          "IOS_VALIDATION_FRESH",
          "DEVELOPER_DIR",
          "SDKROOT",
          "CFLAGS",
          "CXXFLAGS",
          "LDFLAGS",
        ].includes(key)
      ) {
        delete sanitizedEnv[key];
      }
    }
    baseEnv = { ...sanitizedEnv, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runState(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    return spawnSync(
      process.execPath,
      [join(repo, ".agents/tools/ios-validation-state.mjs"), ...args],
      {
        cwd: repo,
        env: { ...baseEnv, ...extraEnv },
        encoding: "utf8",
      },
    );
  }

  it("fingerprints iOS inputs, checks eligibility, records receipts, and returns full-run evidence", () => {
    const src1 = runState(["source"]);
    expect(src1.status, src1.stderr).toBe(0);
    const sourceHash = src1.stdout.trim();
    expect(sourceHash).toMatch(/^[0-9a-f]{64}$/);

    // Markdown changes do not alter the iOS source hash.
    writeFileSync(join(repo, "ios", "README.md"), "# docs\n", "utf8");
    expect(runState(["source"]).stdout.trim()).toBe(sourceHash);

    // Eligibility checks.
    expect(runState(["eligible", "test"]).status).toBe(0);
    expect(runState(["eligible", "build"]).status).toBe(1);
    expect(runState(["eligible", "test"], { AGENT_INTERFACE_UI_PROGRESS: "1" }).status).toBe(1);
    expect(runState(["eligible", "test", "-only-testing:@file"]).status).toBe(1);

    // Key generation and full-run cache lifecycle.
    const keyRes = runState(["key", "test", "SIM-1"]);
    expect(keyRes.status, keyRes.stderr).toBe(0);
    const key = keyRes.stdout.trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(runState(["lookup", key]).status).toBe(1);
    expect(runState(["full-run"]).status).toBe(1);

    const resultDir = join(repo, ".private", "r.xcresult");
    const summaryFile = join(repo, ".private", "r.txt");
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(summaryFile, "summary\n", "utf8");

    // Partial run does not satisfy full-run.
    const recPartial = runState([
      "record",
      key,
      sourceHash,
      resultDir,
      summaryFile,
      "-scheme",
      "AgentInterface",
      "build-for-testing",
      "--test-invocation--",
      "test-without-building",
      "-only-testing:AgentInterfaceTests/One",
    ]);
    expect(recPartial.status, recPartial.stderr).toBe(0);
    expect(runState(["lookup", key]).status).toBe(0);
    const partialFull = runState(["full-run"]);
    expect(partialFull.status).toBe(1);
    expect(partialFull.stderr).toContain("Only a partial run");

    // Full run satisfies full-run.
    const recFull = runState([
      "record",
      key,
      sourceHash,
      resultDir,
      summaryFile,
      "-scheme",
      "AgentInterface",
      "build-for-testing",
      "--test-invocation--",
      "test-without-building",
    ]);
    expect(recFull.status, recFull.stderr).toBe(0);
    const full = runState(["full-run"]);
    expect(full.status, full.stderr).toBe(0);
    expect(JSON.parse(full.stdout)).toMatchObject({
      source: sourceHash,
      key,
      tests: { passed: 42, failed: 0, skipped: 1, expectedFailures: 0 },
    });

    // Editing Swift code invalidates full-run for the new source state.
    writeFileSync(join(repo, "ios", "AgentInterface", "App.swift"), "struct App { let x = 1 }\n");
    expect(runState(["full-run"]).status).toBe(1);
    expect(readFileSync(join(repo, ".agents/tools/validate-ios.sh"), "utf8")).not.toContain(
      "python3",
    );
  });
});
