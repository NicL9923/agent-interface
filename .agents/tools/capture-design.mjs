#!/usr/bin/env node
/** Run the shared design capture in an existing Playwright CLI session. */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const screens = readdirSync(join(repo, ".agents", "fixtures"))
  .filter((name) => name.endsWith("-design.json"))
  .map((name) => name.slice(0, -"-design.json".length))
  .sort();

function fail(message) {
  console.error(message);
  process.exit(2);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    root: { type: "string" },
    origin: { type: "string" },
    session: { type: "string" },
    fixture: { type: "string" },
    "work-case": { type: "string", default: "all" },
    "task-gate": { type: "string" },
    report: { type: "string" },
    "context-tag": { type: "string" },
  },
});

const [screen, stage] = positionals;
if (!screen || !screens.includes(screen)) {
  fail(`screen must be one of: ${screens.join(", ")}`);
}
if (!stage || !["before", "after"].includes(stage)) {
  fail("stage must be before or after");
}
if (!values.root || !values.origin || !values.session) {
  fail("--root, --origin, and --session are required");
}
const workCase = values["work-case"] ?? "all";
if (!["all", "clear-confirmation", "tasks", "triggers"].includes(workCase)) {
  fail(`Invalid --work-case: ${workCase}`);
}
const taskGate = values["task-gate"];
if (taskGate && !["a", "b"].includes(taskGate)) {
  fail(`Invalid --task-gate: ${taskGate}`);
}
const contextTag = values["context-tag"];
const validTags = [
  "wildbots-design-work-triggers-after-w2-capture",
  "wildbots-design-work-triggers-after-w3-capture",
  "wildbots-design-work-triggers-after-w4-capture",
];
if (contextTag && !validTags.includes(contextTag)) {
  fail(`Invalid --context-tag: ${contextTag}`);
}
if (contextTag && (screen !== "work" || stage !== "after" || workCase !== "triggers")) {
  fail("--context-tag requires work after --work-case triggers");
}
if (workCase === "clear-confirmation" && (screen !== "work" || stage !== "after")) {
  fail("A scoped Work recheck requires work after");
}
if (workCase === "tasks" && screen !== "work") fail("The task capture requires work");
if (workCase === "triggers" && screen !== "work") fail("The trigger capture requires work");
if (taskGate && (screen !== "work" || workCase !== "tasks" || stage !== "after")) {
  fail("--task-gate requires work after --work-case tasks");
}
if (workCase === "tasks" && stage === "after" && !taskGate) {
  fail("Work tasks AFTER requires an explicit --task-gate a or b");
}

let originUrl;
try {
  originUrl = new URL(values.origin);
} catch {
  fail("Origin must name an HTTP loopback fixture without a path, query or credentials");
}
if (
  originUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(originUrl.hostname) ||
  !["", "/"].includes(originUrl.pathname) ||
  originUrl.search ||
  originUrl.hash ||
  originUrl.username ||
  originUrl.password
) {
  fail("Origin must name an HTTP loopback fixture without a path, query or credentials");
}

const rootDir = values.root;
if (!isAbsolute(rootDir) || !existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
  fail("Root must be an existing absolute artifact directory");
}

const name =
  values.report ||
  (workCase === "triggers"
    ? `work-triggers-${stage}`
    : taskGate
      ? `work-tasks-${taskGate}-after`
      : workCase === "tasks"
        ? `work-tasks-${stage}`
        : `${screen}-${stage}`);
if (workCase === "triggers" && !name.startsWith("work-triggers-")) {
  fail("Trigger reports must start with work-triggers-");
}
if (workCase === "tasks" && !name.startsWith("work-tasks-")) {
  fail("Task reports must start with work-tasks- to preserve W1 reports");
}
if (taskGate && !name.startsWith(`work-tasks-${taskGate}-`)) {
  fail("Task AFTER reports must name their selected gate");
}
if (basename(name) !== name || name === "." || name === "..") {
  fail("Report must be a basename");
}

const fixturePath =
  values.fixture ||
  join(
    repo,
    ".agents",
    "fixtures",
    workCase === "triggers"
      ? "work-triggers.json"
      : workCase === "tasks"
        ? "work-tasks.json"
        : `${screen}-design.json`,
  );
const payload = JSON.parse(readFileSync(fixturePath, "utf8"));
if (!payload || typeof payload !== "object" || !Array.isArray(payload.bots)) {
  fail("The fixture must be an object with a bots array");
}
const gate = payload.workFixture?.gate;
if (workCase === "tasks" && gate !== "W2-tasks") {
  fail("The task capture requires the W2-tasks fixture");
}
if (workCase === "triggers" && gate !== "W3-triggers") {
  fail("The trigger capture requires the W3-triggers fixture");
}
if (!["tasks", "triggers"].includes(workCase) && gate != null) {
  fail("A gated fixture cannot be used for this capture");
}
if ("conversation" in payload) {
  const conv = payload.conversation;
  for (const field of ["messages", "approvals", "attention", "files"]) {
    if (!conv || typeof conv !== "object" || !Array.isArray(conv[field])) {
      fail(`The fixture conversation must include a ${field} array`);
    }
  }
}

const isolatedOutput = Boolean(taskGate) || workCase === "triggers";
const outputDir = isolatedOutput ? join(rootDir, name) : join(rootDir, stage);
if (
  isolatedOutput &&
  [
    outputDir,
    join(rootDir, `${name}.json`),
    join(rootDir, `${name}-capture.js`),
    join(rootDir, `${name}.failed.log`),
  ].some((p) => existsSync(p))
) {
  fail(
    workCase === "triggers"
      ? "Trigger capture output already exists; choose a new --report basename"
      : "Task AFTER output already exists; choose a new --report basename",
  );
}
if (isolatedOutput) mkdirSync(outputDir);

const options = {
  outputDir,
  prefix: "web",
  screen,
  stage,
  fixture: payload,
  workCase,
  taskGate: taskGate ?? null,
};
if (contextTag) options.contextTag = contextTag;

const source = readFileSync(join(here, "capture-design.js"), "utf8");
const wrapper = join(rootDir, `${name}-capture.js`);
let optionsSource = JSON.stringify(options);
if (workCase === "triggers") {
  const triggerSource = readFileSync(
    join(here, stage === "after" ? "capture-work-triggers-after.js" : "capture-work-triggers.js"),
    "utf8",
  );
  optionsSource = `{...${optionsSource}, captureTriggers: (${triggerSource})}`;
}
writeFileSync(
  wrapper,
  `async page => { await page.goto(${JSON.stringify(values.origin)}); return (${source})(page, ${optionsSource}); }`,
);

const report = join(rootDir, `${name}.json`);
const which = spawnSync("which", ["playwright-cli"], { encoding: "utf8" });
const command =
  which.status === 0 && which.stdout.trim()
    ? [which.stdout.trim()]
    : ["pnpm", "dlx", "--package=@playwright/cli@0.1.22", "playwright-cli"];

const temp = join(rootDir, `.${name}-${randomBytes(6).toString("hex")}.json`);
try {
  const res = spawnSync(
    command[0],
    [...command.slice(1), `-s=${values.session}`, "--raw", "run-code", `--filename=${wrapper}`],
    { cwd: repo, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    writeFileSync(temp, res.stdout ?? "");
    throw new Error(res.stderr || `playwright-cli exited ${res.status}`);
  }
  writeFileSync(temp, res.stdout ?? "");
  const result = JSON.parse(res.stdout);
  const summary = {
    report,
    screenshots: result.paths.length,
    overflow: result.geometry.filter((item) => item.overflow).map((item) => item.name),
  };
  renameSync(temp, report);
  rmSync(join(rootDir, `${name}.failed.log`), { force: true });
  console.log(JSON.stringify(summary));
} catch (error) {
  if (existsSync(temp)) {
    renameSync(temp, join(rootDir, `${name}.failed.log`));
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
