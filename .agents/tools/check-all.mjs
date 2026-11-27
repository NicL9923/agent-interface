#!/usr/bin/env node
/**
 * Run this repository's full check battery the same way in every worktree.
 *
 * The command is `.agents/tools/check-all`. It runs typecheck, lint, test, build and e2e in that order,
 * stops at the first failure unless told to keep going, and prints one summary table.
 *
 * Around the checks it handles:
 * - A browser-suite port that another worktree holds: picks a free app+control port pair (24100+) and
 *   holds an atomic lock file on the pair while the suite runs (with stale-PID recovery if a prior run
 *   was SIGKILLed).
 * - Heavy suites timing out under each other: at most `--heavy-slots` of test and e2e share the machine.
 * - A node_modules that is missing, or older than pnpm-lock.yaml: refuses to run and prints the fix.
 * - WebKit on Linux hosts without WebKit system libraries (e.g. Fedora): runs Chromium on the host and
 *   WebKit in Playwright's noble container under podman, refusing if podman is absent.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CHECKS = ["typecheck", "lint", "test", "build", "e2e"];
export const HEAVY = new Set(["test", "e2e"]);
export const NEEDS = { e2e: "build" };
export const COUNTED = new Set(["test", "build", "e2e"]);
export const PORT_BASE = 24100;
export const PORT_PAIRS = 400;
export const EXIT_USAGE = 2;
export const EXIT_LOCK_TIMEOUT = 75;
export const WEBKIT_LAUNCH_TIMEOUT = 45;
const ANSI = new RegExp(String.raw`\x1b\[[0-9;?]*[ -/]*[@-~]`, "g");

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

export class LockTimeout extends Refusal {
  constructor(message) {
    super(message);
    this.name = "LockTimeout";
  }
}

export function stripAnsi(text) {
  return text.replace(ANSI, "");
}

export function cacheDir(env = process.env, home = homedir()) {
  if (env.CHECK_ALL_HOME) return resolve(env.CHECK_ALL_HOME);
  if (process.platform === "darwin") {
    return join(home, "Library/Caches/agent-interface/check-all");
  }
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "agent-interface/check-all");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function readLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

export function tryLock(lockPath, owner = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...owner,
  });
  const tmpPath = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, payload, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmpPath, lockPath);
        let released = false;
        return {
          path: lockPath,
          release() {
            if (released) return;
            released = true;
            try {
              const current = readLockOwner(lockPath);
              if (!current || current.pid === process.pid) rmSync(lockPath, { force: true });
            } catch {
              /* Best-effort cleanup. */
            }
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = readLockOwner(lockPath);
        const deadOrLegacy =
          existing === null || (Number.isInteger(existing.pid) && !pidAlive(existing.pid));
        if (deadOrLegacy) {
          rmSync(lockPath, { force: true });
          continue;
        }
        return null;
      }
    }
    return null;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

export async function acquireSlot(locksDir, slots, owner, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let waited = false;
  while (true) {
    for (let i = 0; i < slots; i++) {
      const held = tryLock(join(locksDir, `heavy-${i}.lock`), owner);
      if (held) return { held, waited };
    }
    if (Date.now() >= deadline) {
      const holders = [];
      for (let i = 0; i < slots; i++) {
        const info = readLockOwner(join(locksDir, `heavy-${i}.lock`));
        if (info) holders.push(`slot ${i}: pid ${info.pid} (${info.check ?? "?"})`);
      }
      throw new LockTimeout(
        `Timed out after ${timeoutSeconds}s waiting for a heavy check slot (${holders.join(", ") || "busy"}).`,
      );
    }
    waited = true;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function canBind(port) {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once("error", () => resolveBind(false));
    server.once("listening", () => {
      server.close(() => resolveBind(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function pickE2ePort(
  locksDir,
  worktree,
  { requested = null, base = PORT_BASE, pairs = PORT_PAIRS } = {},
) {
  const tryPair = async (appPort, strict) => {
    const controlPort = appPort + 1;
    const first = tryLock(join(locksDir, `e2e-port-${appPort}.lock`), {
      worktree,
      port: appPort,
    });
    if (!first) {
      if (strict) {
        const info = readLockOwner(join(locksDir, `e2e-port-${appPort}.lock`));
        throw new Refusal(
          `E2E_PORT=${appPort} is locked by another check-all run (pid ${info?.pid ?? "?"}).`,
        );
      }
      return null;
    }
    const second = tryLock(join(locksDir, `e2e-port-${controlPort}.lock`), {
      worktree,
      port: controlPort,
    });
    if (!second) {
      first.release();
      if (strict) {
        const info = readLockOwner(join(locksDir, `e2e-port-${controlPort}.lock`));
        throw new Refusal(
          `E2E_PORT=${appPort} control port ${controlPort} is locked by another check-all run (pid ${info?.pid ?? "?"}).`,
        );
      }
      return null;
    }
    const [okApp, okCtrl] = await Promise.all([canBind(appPort), canBind(controlPort)]);
    if (!okApp || !okCtrl) {
      first.release();
      second.release();
      if (strict) {
        const busy = !okApp ? appPort : controlPort;
        throw new Refusal(`E2E_PORT=${appPort} is not usable: port ${busy} is in use.`);
      }
      return null;
    }
    return {
      port: appPort,
      release() {
        second.release();
        first.release();
      },
    };
  };

  if (requested !== null) return tryPair(requested, true);
  for (let i = 0; i < pairs; i++) {
    const candidate = base + i * 2;
    const lease = await tryPair(candidate, false);
    if (lease) return lease;
  }
  throw new Refusal(`No free app and control port pair in ${base}-${base + 2 * pairs - 1}.`);
}

// ---------------------------------------------------------------------------------------------------------------
// pnpm-lock.yaml vs node_modules/.pnpm/lock.yaml verification.

function unquoteYamlKey(raw) {
  const key = raw.trim();
  if (key.length >= 2 && key[0] === key[key.length - 1] && (key[0] === "'" || key[0] === '"')) {
    return key.slice(1, -1);
  }
  return key;
}

function splitPkgKey(key) {
  const base = key.split("(", 1)[0];
  const at = base.lastIndexOf("@");
  if (at <= 0) return [base, ""];
  return [base.slice(0, at), base.slice(at + 1)];
}

export function parsePnpmLock(text) {
  let hasVersion = false;
  let section = null;
  let currentPkg = null;
  let currentSnap = null;
  const packages = {};
  const optionalSnaps = new Set();

  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const stripped = line.trim();
    if (indent === 0) {
      if (stripped.startsWith("lockfileVersion:")) {
        const value = stripped.slice("lockfileVersion:".length).trim();
        if (!value) throw new Error("empty lockfileVersion");
        hasVersion = true;
        section = null;
      } else if (stripped.endsWith(":")) {
        section = stripped.slice(0, -1);
      } else {
        section = null;
      }
      currentPkg = null;
      currentSnap = null;
      continue;
    }
    if (section === "packages") {
      if (indent === 2 && stripped.endsWith(":")) {
        currentPkg = unquoteYamlKey(stripped.slice(0, -1));
        packages[currentPkg] = { optional: false };
      } else if (indent === 4 && currentPkg !== null) {
        if (
          stripped.startsWith("os:") ||
          stripped.startsWith("cpu:") ||
          stripped.startsWith("libc:")
        ) {
          packages[currentPkg].optional = true;
        }
      }
    } else if (section === "snapshots") {
      if (indent === 2 && stripped.endsWith(":")) {
        currentSnap = unquoteYamlKey(stripped.slice(0, -1)).split("(", 1)[0];
      } else if (indent === 4 && currentSnap !== null && stripped === "optional: true") {
        optionalSnaps.add(currentSnap);
      }
    }
  }
  if (!hasVersion) throw new Error("not a pnpm lockfile (missing lockfileVersion)");
  for (const key of optionalSnaps) {
    if (key in packages) packages[key].optional = true;
  }
  return { packages };
}

export function lockDrift(lock, installed) {
  const wanted = lock.packages ?? {};
  const present = installed.packages ?? {};
  const wantedByName = new Map();
  for (const key of Object.keys(wanted)) {
    const [name, version] = splitPkgKey(key);
    if (!wantedByName.has(name)) wantedByName.set(name, new Set());
    wantedByName.get(name).add(version);
  }
  const problems = [];
  const reportedNames = new Set();
  for (const key of Object.keys(present)) {
    if (!(key in wanted)) {
      const [name, version] = splitPkgKey(key);
      const wantedVersions = wantedByName.get(name);
      if (wantedVersions && wantedVersions.size === 1) {
        problems.push(`${name} is ${version} but pnpm-lock.yaml has ${[...wantedVersions][0]}`);
        reportedNames.add(name);
      } else {
        problems.push(`${key} is installed but not in pnpm-lock.yaml`);
      }
    }
  }
  for (const [key, entry] of Object.entries(wanted)) {
    const [name] = splitPkgKey(key);
    if (!(key in present) && !entry.optional && !reportedNames.has(name)) {
      problems.push(`${key} is in pnpm-lock.yaml but not installed`);
    }
  }
  return problems;
}

export function checkInstall(root) {
  const modules = join(root, "node_modules");
  const fix = "Fix: pnpm install --frozen-lockfile";
  let isSymlink = false;
  try {
    isSymlink = lstatSync(modules).isSymbolicLink();
  } catch {
    isSymlink = false;
  }
  if (!existsSync(modules)) {
    const where = isSymlink ? ` (a symlink to ${readlinkSync(modules)}, which does not exist)` : "";
    throw new Refusal(`node_modules is missing${where}. ${fix}`);
  }
  const installedPath = join(modules, ".pnpm/lock.yaml");
  if (!existsSync(installedPath) || !statSync(installedPath).isFile()) {
    throw new Refusal(`node_modules has no .pnpm/lock.yaml, so pnpm did not install it. ${fix}`);
  }
  let lock, installed;
  try {
    lock = parsePnpmLock(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
    installed = parsePnpmLock(readFileSync(installedPath, "utf8"));
  } catch (error) {
    throw new Refusal(
      `Could not read the lockfiles to compare them (${error instanceof Error ? error.message : String(error)}). ${fix}`,
    );
  }
  const drift = lockDrift(lock, installed);
  if (drift.length) {
    const shown =
      drift.slice(0, 3).join("; ") + (drift.length > 3 ? `; and ${drift.length - 3} more` : "");
    throw new Refusal(`pnpm-lock.yaml changed since node_modules was installed: ${shown}. ${fix}`);
  }
  if (isSymlink) {
    return [
      `node_modules is a symlink to ${readlinkSync(modules)}. It matches pnpm-lock.yaml, but a shared install lets the other checkout change what this one tests; run pnpm install --frozen-lockfile here to own one.`,
    ];
  }
  return [];
}

export function checkNode(root, env = process.env) {
  const script =
    "import { readFileSync } from 'node:fs'; import { satisfiesEngine } from './scripts/node-engine.mjs';" +
    "const range = JSON.parse(readFileSync('package.json', 'utf8')).engines.node;" +
    "console.log(JSON.stringify({ ok: satisfiesEngine(process.version, range), version: process.version, range }));";
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    throw new Refusal(
      'node is not on PATH. Fix: export PATH="$HOME/.local/share/fnm:$PATH"; eval "$(fnm env)"',
    );
  }
  if (result.status !== 0) {
    throw new Refusal(
      `node could not read scripts/node-engine.mjs: ${(result.stderr ?? "").trim().slice(-300)}`,
    );
  }
  const info = JSON.parse(result.stdout);
  if (!info.ok) {
    const wantedPath = join(root, ".node-version");
    const wanted = existsSync(wantedPath) ? readFileSync(wantedPath, "utf8").trim() : "";
    throw new Refusal(
      `node ${info.version} is outside package.json engines.node (${info.range}).` +
        (wanted ? ` Fix: fnm use ${wanted}` : ""),
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// WebKit host probe + podman fallback.

export const WEBKIT_PROBE = `
import { webkit } from '@playwright/test';
try {
  const browser = await webkit.launch({ timeout: ${WEBKIT_LAUNCH_TIMEOUT * 1000} });
  await browser.close();
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error?.message ?? String(error) }));
  process.exit(0);
}
`;

function firstSentence(text) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/Host system is missing dependencies[^.]*\./);
  if (match) return match[0];
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^[╔═╗║╚╝─]+$/.test(l));
  return (line ?? cleaned).slice(0, 200);
}

export function webkitFailure(root, env = process.env, timeoutMs = 60_000) {
  const result = spawnSync("node", ["--input-type=module", "-e", WEBKIT_PROBE], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error?.code === "ETIMEDOUT") return `it did not start within ${timeoutMs / 1000}s`;
  const lines = (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  try {
    const info = JSON.parse(lines[lines.length - 1]);
    return info.ok ? null : firstSentence(String(info.message));
  } catch {
    const tail = ((result.stderr || result.stdout) ?? "").trim().slice(-300);
    return `the launch check failed: ${tail}`;
  }
}

export function playwrightImage(root) {
  const pkgPath = join(root, "node_modules/@playwright/test/package.json");
  try {
    const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    if (!version) throw new Error("missing version");
    return `mcr.microsoft.com/playwright:v${version}-noble`;
  } catch (error) {
    throw new Refusal(
      `Could not read the @playwright/test version from ${pkgPath} (${error instanceof Error ? error.message : String(error)}). Fix: pnpm install --frozen-lockfile`,
    );
  }
}

export function findPodman(env = process.env) {
  const res = spawnSync("which", ["podman"], { env, encoding: "utf8" });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

export function containerCommand(podman, root, image, name, timeoutSec, argv) {
  return [
    podman,
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    `--timeout=${Math.trunc(timeoutSec) + 60}`,
    "--userns=keep-id",
    "--security-opt",
    "label=disable",
    "--ipc=host",
    "-v",
    `${root}:${root}`,
    "-w",
    root,
    "-e",
    "HOME=/tmp",
    "-e",
    "E2E_PORT",
    "-e",
    "NO_COLOR",
    image,
    ...argv,
  ];
}

export function removeContainer(podman, name) {
  const res = spawnSync(podman, ["rm", "--force", "--ignore", "--time", "5", name], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.error) return `podman rm could not run: ${res.error.message}`;
  if (res.status !== 0) {
    return `podman rm exited ${res.status}: ${(res.stderr || res.stdout || "").trim().slice(-300)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Output count parsing & formatting.

function numbers(line) {
  const out = {};
  for (const match of line.matchAll(
    /(\d+) (passed|failed|skipped|todo|flaky|interrupted|did not run)/g,
  )) {
    out[match[2]] = Number(match[1]);
  }
  return out;
}

export function parseCounts(check, output) {
  const text = stripAnsi(output);
  const counts = {};
  if (check === "test") {
    for (const [key, label] of [
      ["files", "Test Files"],
      ["tests", "Tests"],
    ]) {
      const match = text.match(new RegExp(`^\\s*${label}\\s+(.+)$`, "m"));
      if (match) {
        const parts = numbers(match[1]);
        const total = match[1].match(/\((\d+)\)/);
        counts[key] = total ? Number(total[1]) : Object.values(parts).reduce((a, b) => a + b, 0);
        counts[`${key}_failed`] = parts.failed ?? 0;
      }
    }
  } else if (check === "build") {
    const match = text.match(/✓\s+(\d+)\s+modules transformed\./);
    if (match) counts.modules = Number(match[1]);
  } else if (check.startsWith("e2e")) {
    const summary = {};
    for (const line of text.split(/\r?\n/)) {
      if (/^\s+\d+\s+(?:passed|failed|skipped|flaky|interrupted|did not run)\b/.test(line)) {
        for (const [k, v] of Object.entries(numbers(line))) {
          summary[k] = (summary[k] ?? 0) + v;
        }
      }
    }
    if (Object.keys(summary).length) {
      counts.tests = Object.values(summary).reduce((a, b) => a + b, 0);
      if (summary.failed) counts.failed = summary.failed;
      if (summary.skipped) counts.skipped = summary.skipped;
    }
  }
  return counts;
}

export function formatCounts(check, counts) {
  if (!Object.keys(counts).length) return COUNTED.has(check.split(":")[0]) ? "(no counts)" : "-";
  if (check === "test") {
    const parts = [];
    if ("files" in counts) parts.push(`${counts.files} files`);
    if ("tests" in counts) parts.push(`${counts.tests} tests`);
    if (counts.tests_failed) parts.push(`${counts.tests_failed} failed`);
    return parts.join(", ");
  }
  if (check === "build") return `${counts.modules} modules`;
  if (check.startsWith("e2e")) {
    const parts = [`${counts.tests} tests`];
    if (counts.failed) parts.push(`${counts.failed} failed`);
    if (counts.skipped) parts.push(`${counts.skipped} skipped`);
    return parts.join(", ");
  }
  return "-";
}

export function formatSeconds(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------------------------------------------
// Process runner & battery execution.

function stopGroup(pid, graceMs = 10_000) {
  return new Promise((resolveStop) => {
    try {
      process.kill(-pid, "SIGINT");
    } catch {
      resolveStop();
      return;
    }
    const deadline = Date.now() + graceMs;
    const poll = setInterval(() => {
      if (!pidAlive(pid)) {
        clearInterval(poll);
        resolveStop();
      } else if (Date.now() >= deadline) {
        clearInterval(poll);
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
        resolveStop();
      }
    }, 100);
  });
}

export function runProcess(argv, cwd, env, logFile, timeoutSeconds, verbose) {
  mkdirSync(dirname(logFile), { recursive: true });
  return new Promise((resolveRun) => {
    const chunks = [];
    let timedOut = false;
    let interrupted = false;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const onData = (buf) => {
      chunks.push(buf);
      if (verbose) process.stderr.write(buf);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void stopGroup(child.pid);
    }, timeoutSeconds * 1000);

    const onSignal = () => {
      interrupted = true;
      if (child.pid) void stopGroup(child.pid);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    const finish = (code) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      const output = Buffer.concat(chunks).toString("utf8");
      writeFileSync(logFile, output, "utf8");
      resolveRun({
        code: code ?? 1,
        output,
        timedOut,
        interrupted,
      });
    };

    child.once("error", (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
      finish(1);
    });
    child.once("close", (code) => finish(code));
  });
}

export function selectChecks({ only, skip } = {}) {
  const parseList = (raw) =>
    raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const onlyList = parseList(only);
  const skipList = parseList(skip);
  for (const name of [...onlyList, ...skipList]) {
    if (!CHECKS.includes(name)) {
      throw new Refusal(
        `Unknown check ${JSON.stringify(name)}. Choose from: ${CHECKS.join(", ")}.`,
      );
    }
  }
  const base = onlyList.length ? CHECKS.filter((c) => onlyList.includes(c)) : [...CHECKS];
  return base.filter((c) => !skipList.includes(c));
}

function pruneLogs(directory, keep, current) {
  if (!existsSync(directory)) return;
  const dirs = readdirSync(directory)
    .map((name) => join(directory, name))
    .filter((p) => p !== current && statSync(p).isDirectory())
    .sort();
  for (const old of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    rmSync(old, { recursive: true, force: true });
  }
}

export function planE2e(root, env, checkTimeout, log) {
  const failure = webkitFailure(root, env);
  if (failure === null) {
    return [{ name: "e2e", check: "e2e", argv: ["pnpm", "run", "test:e2e"], container: null }];
  }
  const podman = findPodman(env);
  if (!podman) {
    throw new Refusal(
      `WebKit cannot start on this host: ${failure.replace(/\.$/, "")}. podman is not on PATH to run it in Playwright's container, and check-all does not skip WebKit. Fix: install podman (on Fedora, sudo dnf install podman), or give the host what WebKit needs (pnpm exec playwright install webkit, and on Debian or Ubuntu sudo pnpm exec playwright install-deps webkit).`,
    );
  }
  const image = playwrightImage(root);
  const container = `check-all-webkit-${process.pid}`;
  log(
    `e2e: WebKit cannot start on this host: ${failure.replace(/\.$/, "")}. Chromium runs here and WebKit in ${image} under podman.`,
  );
  return [
    {
      name: "e2e:chromium",
      check: "e2e",
      argv: ["pnpm", "run", "test:e2e", "--project=chromium"],
      container: null,
    },
    {
      name: "e2e:webkit (podman)",
      check: "e2e",
      argv: containerCommand(podman, root, image, container, checkTimeout, [
        "./node_modules/.bin/playwright",
        "test",
        "--project=webkit",
      ]),
      container: [podman, container],
    },
  ];
}

export async function runBattery(
  root,
  options,
  cache,
  log = (msg) => console.error(`check-all: ${msg}`),
  env = process.env,
) {
  const names = selectChecks(options);
  if (!names.length) throw new Refusal("Nothing to run after --only and --skip.");

  const rawSlots = options.heavySlots ?? env.CHECK_ALL_HEAVY_SLOTS ?? "1";
  const slots = Number(rawSlots);
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Refusal(
      `Heavy slot count must be a whole number >= 1, got ${JSON.stringify(rawSlots)}.`,
    );
  }

  checkNode(root, env);
  const warnings = checkInstall(root);
  for (const warning of warnings) log(`warning: ${warning}`);

  if (
    names.includes("e2e") &&
    !names.includes("build") &&
    !existsSync(join(root, "dist/client/index.html"))
  ) {
    throw new Refusal(
      "e2e serves dist/client, which is not built. Fix: pnpm run build, or do not --skip build.",
    );
  }

  let requestedPort = null;
  if (names.includes("e2e") && env.E2E_PORT) {
    const parsed = Number(env.E2E_PORT);
    if (!/^\d+$/.test(env.E2E_PORT) || parsed < 1024 || parsed > 65534) {
      throw new Refusal(
        `E2E_PORT=${JSON.stringify(env.E2E_PORT)} must be a whole number from 1024 to 65534.`,
      );
    }
    requestedPort = parsed;
  }

  const e2eSteps = names.includes("e2e") ? planE2e(root, env, options.checkTimeout, log) : [];

  const commands = {
    typecheck: ["pnpm", "run", "typecheck"],
    lint: ["pnpm", "run", "lint"],
    test: ["pnpm", "test"],
    build: ["pnpm", "run", "build"],
  };
  const stepMap = Object.fromEntries(
    Object.entries(commands).map(([name, argv]) => [
      name,
      [{ name, check: name, argv, container: null }],
    ]),
  );
  stepMap.e2e = e2eSteps;

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "");
  const logsDir = join(cache, "logs", `${stamp}-${process.pid}-${root.split("/").pop()}`);
  pruneLogs(join(cache, "logs"), 30, logsDir);

  const locksDir = join(cache, "locks");
  const childEnv = { ...env, NO_COLOR: "1" };
  const results = [];
  const failed = new Set();

  for (let idx = 0; idx < names.length; idx++) {
    const check = names[idx];
    const dep = NEEDS[check];
    if (dep && failed.has(dep)) {
      results.push({
        name: check,
        check,
        status: "skipped",
        queued: 0,
        seconds: 0,
        counts: {},
        detail: `skipped because ${dep} failed`,
      });
      continue;
    }

    log(`[${idx + 1}/${names.length}] ${check}`);
    let slotLease = null;
    let portLease = null;
    let queuedSec = 0;

    try {
      if (HEAVY.has(check)) {
        const qStart = Date.now();
        const { held } = await acquireSlot(
          locksDir,
          slots,
          { check, worktree: root },
          options.lockTimeout,
        );
        slotLease = held;
        queuedSec = (Date.now() - qStart) / 1000;
      }

      const stepEnv = { ...childEnv };
      if (check === "e2e") {
        portLease = await pickE2ePort(locksDir, root, { requested: requestedPort });
        stepEnv.E2E_PORT = String(portLease.port);
        log(`e2e: app port ${portLease.port}, control port ${portLease.port + 1}`);
      }

      for (const step of stepMap[check]) {
        if (stepMap[check].length > 1) log(`${step.name}: started`);
        const safeName = step.name.replace(/[^a-z0-9-]+/gi, "-").replace(/-+$/, "");
        const logFile = join(logsDir, `${safeName}.log`);
        const started = Date.now();
        let outcome;
        try {
          outcome = await runProcess(
            step.argv,
            root,
            stepEnv,
            logFile,
            options.checkTimeout,
            options.verbose,
          );
        } finally {
          if (step.container) {
            const [podmanBin, containerName] = /** @type {[string, string]} */ (step.container);
            const rmErr = removeContainer(podmanBin, containerName);
            if (rmErr) {
              warnings.push(
                `could not remove the container ${containerName} (${rmErr}). Remove it with: ${podmanBin} rm --force ${containerName}`,
              );
            }
          }
        }
        const seconds = (Date.now() - started) / 1000;
        const status = outcome.interrupted
          ? "interrupted"
          : outcome.timedOut
            ? "timeout"
            : outcome.code === 0
              ? "pass"
              : "fail";
        const counts = parseCounts(step.name, outcome.output);
        const tailLines = stripAnsi(outcome.output).trim().split(/\r?\n/).slice(-25).join("\n");
        results.push({
          name: step.name,
          check,
          status,
          queued: queuedSec,
          seconds,
          counts,
          log: logFile,
          detail: status === "pass" ? "" : tailLines,
        });
        queuedSec = 0;
        log(`${step.name}: ${status} in ${formatSeconds(seconds)}`);
        if (status !== "pass") {
          failed.add(check);
          if (tailLines) {
            console.error(
              `\n--- ${step.name}: last lines (full output: ${logFile}) ---\n${tailLines}\n`,
            );
          }
          if (status === "interrupted") return { results, warnings, interrupted: true };
        }
      }
      if (failed.has(check) && !options.keepGoing) break;
    } finally {
      portLease?.release();
      slotLease?.release();
    }
  }

  return { results, warnings, interrupted: false };
}

export function renderSummary(results, warnings) {
  const lines = [];
  const header = ["check", "result", "queued", "run", "counts"];
  const rows = results.map((r) => [
    r.name,
    r.status.toUpperCase() === "PASS" ? "pass" : r.status.toUpperCase(),
    r.queued >= 0.05 ? formatSeconds(r.queued) : "-",
    r.seconds > 0 ? formatSeconds(r.seconds) : "-",
    formatCounts(r.name, r.counts),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const fmt = (cols) =>
    cols
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  lines.push(fmt(header));
  for (const row of rows) lines.push(fmt(row));
  lines.push("");
  const totalSec = results.reduce((acc, r) => acc + r.seconds, 0);
  const totalQueued = results.reduce((acc, r) => acc + r.queued, 0);
  const failed = results.filter((r) => r.status !== "pass");
  if (!failed.length) {
    lines.push(
      `All ${results.length} checks passed (${formatSeconds(totalSec)} total, ${formatSeconds(totalQueued)} of it queued for heavy slots)`,
    );
  } else {
    lines.push(
      `FAILED: ${failed.map((r) => r.name).join(", ")} (${formatSeconds(totalSec)} total)`,
    );
  }
  for (const w of warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), { root = ROOT, cache = cacheDir() } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        only: { type: "string" },
        skip: { type: "string" },
        "keep-going": { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        "heavy-slots": { type: "string" },
        "lock-timeout": { type: "string", default: "1800" },
        "check-timeout": { type: "string", default: "1800" },
      },
    }));
  } catch (error) {
    console.error(`check-all: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }

  try {
    const { results, warnings, interrupted } = await runBattery(
      root,
      {
        only: values.only,
        skip: values.skip,
        keepGoing: Boolean(values["keep-going"]),
        verbose: Boolean(values.verbose),
        heavySlots: values["heavy-slots"],
        lockTimeout: Number(values["lock-timeout"]),
        checkTimeout: Number(values["check-timeout"]),
      },
      cache,
    );
    console.log("\n" + renderSummary(results, warnings));
    if (interrupted) return 130;
    return results.every((r) => r.status === "pass") ? 0 : 1;
  } catch (error) {
    if (error instanceof LockTimeout) {
      console.error(`check-all: ${error.message}`);
      return EXIT_LOCK_TIMEOUT;
    }
    if (error instanceof Refusal) {
      console.error(`check-all: ${error.message}`);
      return EXIT_USAGE;
    }
    console.error(`check-all: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => process.exit(code));
}
