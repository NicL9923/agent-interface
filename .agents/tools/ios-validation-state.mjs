#!/usr/bin/env node
/** Key and reuse successful local iOS test evidence. Live/capture runs stay fresh. */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function command(cmd, ...args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function designFixtures() {
  const dir = join(ROOT, ".agents", "fixtures");
  let names = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      /* Ignore unreadable entries. */
    }
  }
  return files;
}

export function sourceState() {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8" },
  ).split("\0");
  // The runner exports every default JSON fixture, including locally ignored files.
  for (const fixture of designFixtures()) {
    listed.push(relative(ROOT, fixture));
  }
  const unique = [...new Set(listed.filter(Boolean))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = [];
  const toolFiles = new Set([
    ".agents/tools/validate-ios.sh",
    ".agents/tools/ios-validation-state.mjs",
    ".agents/tools/source-state.mjs",
    ".agents/tools/patch-xctestrun.mjs",
  ]);

  for (const rel of unique) {
    if (!(rel.startsWith("ios/") || rel.startsWith(".agents/fixtures/") || toolFiles.has(rel))) {
      continue;
    }
    if (rel.endsWith(".md") || rel.startsWith("ios/evidence/")) continue;
    const full = join(ROOT, rel);
    let lst;
    try {
      lst = lstatSync(full);
    } catch {
      entries.push([rel, "missing"]);
      continue;
    }
    // Missing tracked files and symlink targets are part of the fingerprint.
    if (lst.isSymbolicLink()) {
      const target = readlinkSync(full);
      let fileHash = null;
      try {
        if (statSync(full).isFile()) {
          fileHash = createHash("sha256").update(readFileSync(full)).digest("hex");
        }
      } catch {
        fileHash = null;
      }
      entries.push([rel, "symlink", target, fileHash]);
    } else if (lst.isFile()) {
      entries.push([
        rel,
        "file",
        lst.mode & 0o111,
        createHash("sha256").update(readFileSync(full)).digest("hex"),
      ]);
    } else {
      entries.push([rel, "missing"]);
    }
  }
  if (!entries.some((row) => row[0].startsWith("ios/"))) {
    throw new Error("No iOS source inputs found");
  }
  return digest(entries);
}

export function cacheable(operation, options) {
  if (operation !== "test") return false;
  // The runner exports the repository's default design fixtures on every run.
  // Their contents are fingerprinted above. Custom files, capture switches and
  // variant selections must still run fresh and cannot certify the default suite.
  const fixtures = new Map();
  for (const full of designFixtures()) {
    const stem = basename(full, ".json")
      .replace(/-design$/, "")
      .toUpperCase()
      .replaceAll("-", "_");
    const envName = `TEST_RUNNER_AGENT_INTERFACE_DESIGN_${stem}_PATH`;
    if (!fixtures.has(envName)) fixtures.set(envName, full);
  }
  const blockedPrefixes = [
    "AGENT_INTERFACE_",
    "TEST_RUNNER_",
    "SIMCTL_CHILD_",
    "DYLD_",
    "SWIFT_",
    "XCODE_",
  ];
  const blockedExact = new Set(["CFLAGS", "CXXFLAGS", "LDFLAGS"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (fixtures.has(key)) {
      try {
        if (
          !value ||
          !isAbsolute(value) ||
          realpathSync(value) !== realpathSync(fixtures.get(key))
        ) {
          return false;
        }
      } catch {
        return false;
      }
    } else if (
      value &&
      (blockedPrefixes.some((prefix) => key.startsWith(prefix)) || blockedExact.has(key))
    ) {
      return false;
    }
  }
  const scalarOptions = new Set([
    "-only-testing",
    "-skip-testing",
    "-parallel-testing-enabled",
    "-parallel-testing-worker-count",
    "-maximum-parallel-testing-workers",
    "-maximum-concurrent-test-simulator-destinations",
    "-maximum-concurrent-test-device-destinations",
    "-test-timeouts-enabled",
    "-default-test-execution-time-allowance",
    "-maximum-test-execution-time-allowance",
    "-collect-test-diagnostics",
  ]);
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (option.startsWith("-only-testing:@") || option.startsWith("-skip-testing:@")) return false;
    if (option.startsWith("-only-testing:") || option.startsWith("-skip-testing:")) continue;
    if (!scalarOptions.has(option)) return false;
    const value = options[++i];
    if (value === undefined || value.startsWith("@")) return false;
  }
  return true;
}

export function identity(operation, simulator, options) {
  const devices = JSON.parse(
    command("xcrun", "simctl", "list", "devices", "available", "--json"),
  ).devices;
  const matches = [];
  for (const [runtimeId, group] of Object.entries(devices)) {
    for (const device of group) {
      if (device.udid === simulator) matches.push([runtimeId, device]);
    }
  }
  if (matches.length !== 1) throw new Error("Choose exactly one available simulator UUID");
  const [runtimeId, device] = matches[0];
  const runtimes = JSON.parse(command("xcrun", "simctl", "list", "runtimes", "--json")).runtimes;
  const runtime = runtimes.find((r) => r.identifier === runtimeId);
  if (!runtime) throw new Error("Simulator runtime metadata is unavailable");

  const envExact = new Set([
    "LANG",
    "LC_ALL",
    "TZ",
    "DEVELOPER_DIR",
    "SDKROOT",
    "CFLAGS",
    "CXXFLAGS",
    "LDFLAGS",
  ]);
  const envPrefixes = [
    "LC_",
    "SWIFT_",
    "XCODE_",
    "DYLD_",
    "AGENT_INTERFACE_",
    "TEST_RUNNER_",
    "SIMCTL_CHILD_",
  ];
  const environment = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (envExact.has(k) || envPrefixes.some((p) => k.startsWith(p)))) {
      environment[k] = v;
    }
  }

  return digest({
    schema: 1,
    source: sourceState(),
    operation,
    options,
    xcode: command("xcodebuild", "-version"),
    developer: command("xcode-select", "-p"),
    sdk: command("xcrun", "--sdk", "iphonesimulator", "--show-sdk-build-version"),
    host: command("sw_vers", "-buildVersion"),
    architecture: arch(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    simulator,
    device_type: device.deviceTypeIdentifier ?? null,
    runtime: {
      identifier: runtime.identifier ?? null,
      version: runtime.version ?? null,
      buildversion: runtime.buildversion ?? null,
    },
    environment,
  });
}

function cacheDir() {
  let common = command("git", "rev-parse", "--git-common-dir");
  if (!isAbsolute(common)) common = join(ROOT, common);
  return join(dirname(realpathSync(common)), ".private", "ios-validation-cache");
}

function cachePath(key) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid validation key");
  return join(cacheDir(), `${key}.json`);
}

function evidenceCounts(result) {
  const evidence = JSON.parse(
    command(
      "xcrun",
      "xcresulttool",
      "get",
      "test-results",
      "summary",
      "--path",
      String(result),
      "--compact",
    ),
  );
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    evidence.result !== "Passed" ||
    evidence.failedTests !== 0 ||
    !Number.isInteger(evidence.passedTests) ||
    evidence.passedTests <= 0 ||
    (Array.isArray(evidence.testFailures)
      ? evidence.testFailures.length > 0
      : Boolean(evidence.testFailures))
  ) {
    throw new Error("Only completed, passing, nonempty test results can be reused");
  }
  const counts = {
    passed: evidence.passedTests,
    failed: evidence.failedTests,
    skipped: evidence.skippedTests,
    expectedFailures: evidence.expectedFailures,
  };
  if (Object.values(counts).some((v) => !Number.isInteger(v) || v < 0)) {
    throw new Error("Invalid test counts");
  }
  return counts;
}

function partial(options) {
  // A filter runs part of the scheme. The scheme's whole suite is what a release needs.
  return options.some(
    (option) => option.startsWith("-only-testing") || option.startsWith("-skip-testing"),
  );
}

function validReceipt(value) {
  try {
    const args = value?.arguments;
    if (
      !(
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.schema === 2 &&
        value.exit === 0 &&
        typeof value.source === "string" &&
        Array.isArray(args) &&
        args.every((a) => typeof a === "string") &&
        args.filter((a) => a === "--test-invocation--").length === 1 &&
        args.filter((a) => a === "-scheme").length === 1 &&
        args[args.indexOf("-scheme") + 1] === "AgentInterface" &&
        args.includes("build-for-testing") &&
        args.includes("test-without-building") &&
        value.full === !partial(args) &&
        statSync(value.result).isDirectory() &&
        statSync(value.summary).isFile()
      )
    ) {
      return false;
    }
    const counts = evidenceCounts(value.result);
    return stableStringify(value.tests) === stableStringify(counts);
  } catch {
    return false;
  }
}

function lookup(key) {
  try {
    const record = JSON.parse(readFileSync(cachePath(key), "utf8"));
    if (validReceipt(record) && record.key === key) {
      console.log(`Reused successful iOS validation: ${record.summary}`);
      console.log(`Validated inputs: ${key}`);
      console.log(`Result bundle: ${record.result}`);
      return 0;
    }
  } catch {
    /* Cache miss or invalid receipt. */
  }
  return 1;
}

function record(key, source, resultArg, summaryArg, ...args) {
  const result = resolve(resultArg);
  const summary = resolve(summaryArg);
  const counts = evidenceCounts(result);
  if (sourceState() !== source) throw new Error("iOS inputs changed while validation ran");
  const value = {
    schema: 2,
    key,
    exit: 0,
    result,
    summary,
    source,
    full: !partial(args),
    tests: counts,
    arguments: args,
  };
  if (!validReceipt(value)) throw new Error("Invalid validation receipt");
  if (sourceState() !== source) throw new Error("iOS inputs changed while validation ran");
  const target = cachePath(key);
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.receipt-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temp, stableStringify(value), "utf8");
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

function fullRun() {
  const source = sourceState();
  const dir = cacheDir();
  let files = [];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(dir, name));
  } catch {
    files = [];
  }
  const matching = [];
  let partialRuns = 0;
  for (const file of files) {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (!validReceipt(value) || value.source !== source) continue;
      if (value.full !== true) {
        partialRuns += 1;
      } else if (
        value.tests &&
        typeof value.tests === "object" &&
        value.tests.failed === 0 &&
        value.tests.passed > 0
      ) {
        matching.push([statSync(file).mtimeMs, value]);
      }
    } catch {
      continue;
    }
  }
  if (!matching.length) {
    const reason = partialRuns
      ? "Only a partial run (-only-testing or -skip-testing) passed"
      : "No passing iOS validation exists";
    console.error(`${reason} for the current iOS inputs (${source}).`);
    return 1;
  }
  matching.sort((a, b) => b[0] - a[0]);
  const value = matching[0][1];
  console.log(
    JSON.stringify({
      source,
      key: value.key,
      summary: value.summary,
      result: value.result,
      tests: value.tests,
    }),
  );
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (action === "key") {
    const [operation, simulator, ...options] = args;
    console.log(identity(operation, simulator, options));
  } else if (action === "source") {
    console.log(sourceState());
  } else if (action === "eligible") {
    const [operation, ...options] = args;
    return cacheable(operation, options) ? 0 : 1;
  } else if (action === "lookup") {
    return lookup(args[0]);
  } else if (action === "invalidate") {
    rmSync(cachePath(args[0]), { force: true });
  } else if (action === "record") {
    record(args[0], args[1], args[2], args[3], ...args.slice(4));
  } else if (action === "full-run") {
    return fullRun();
  } else {
    throw new Error("Unknown validation-state action");
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(
      "iOS validation evidence:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(2);
  }
}
