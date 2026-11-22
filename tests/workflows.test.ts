import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

// This repository is public, so GitHub's standard hosted runners cost nothing. Larger runners
// (labels such as `ubuntu-latest-4-cores` or `macos-26-xlarge`) and self-hosted or third-party
// runners are billed or outside the household's control, so a workflow may name only these.
const FREE_RUNNERS = new Set([
  "ubuntu-latest",
  "ubuntu-24.04",
  "ubuntu-22.04",
  "ubuntu-24.04-arm",
  "ubuntu-22.04-arm",
  "macos-latest",
  "macos-26",
  "macos-15",
  "macos-14",
  "windows-latest",
  "windows-2025",
  "windows-2022",
]);

const root = join(import.meta.dirname, "..");
const directory = join(root, ".github", "workflows");
// Playwright starts only the browser builds of its own version, so the one container image a job may run in is
// Playwright's for the installed @playwright/test. check_all.py reads the version from the same file.
const playwrightVersion = (
  JSON.parse(
    readFileSync(join(root, "node_modules", "@playwright", "test", "package.json"), "utf8"),
  ) as { version: string }
).version;
// A tag can move, so a job names the image by digest too. This file is the one record of each version's digest,
// so a Playwright upgrade cannot keep the old version's digest: it has to add the new version's.
const DIGESTS_FILE = ".github/playwright-image-digests.json";
const recordedDigests = JSON.parse(readFileSync(join(root, DIGESTS_FILE), "utf8")) as Record<
  string,
  string
>;
const PLAYWRIGHT_IMAGE = /^mcr\.microsoft\.com\/playwright:v([\w.-]+)-noble@(sha256:[0-9a-f]{64})$/;
// An offline test cannot ask the registry, so a wrong digest copied into both this record and the workflow passes
// here. The browser jobs catch it: an image from another Playwright version carries other browser builds, so they
// fail at launch on the first push to main. Look the digest up with this command rather than copying one.
const lookUp = (version: string) =>
  `skopeo inspect --format '{{.Digest}}' docker://mcr.microsoft.com/playwright:v${version}-noble`;

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every key in the workflow at any depth, with its value and where it is. */
function* keys(value: unknown, path = ""): Generator<[string, unknown, string]> {
  if (Array.isArray(value))
    for (const [index, item] of value.entries()) yield* keys(item, `${path}[${index}]`);
  else if (isMapping(value))
    for (const [key, item] of Object.entries(value)) {
      const where = path ? `${path}.${key}` : key;
      yield [key, item, where];
      yield* keys(item, where);
    }
}

const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * Why a workflow breaks the free-runner rule, or undefined when it does not. The workflow is read with a YAML parser,
 * so quoting, escapes, flow style, values on the next line and anchors all reach the checks as GitHub reads them,
 * and every `runs-on`, `uses`, `container` and `services` key is checked wherever it sits.
 */
function workflowProblem(
  text: string,
  playwright = playwrightVersion,
  digests = recordedDigests,
): string | undefined {
  let workflow: unknown;
  try {
    const document = parseDocument(text, { prettyErrors: false });
    if (document.errors.length)
      return `is not YAML this guard can read: ${document.errors[0]!.message}`;
    workflow = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return `is not YAML this guard can read: ${(error as Error).message}`;
  }
  const jobs = isMapping(workflow) ? workflow.jobs : undefined;
  if (!isMapping(jobs) || !Object.keys(jobs).length) return "names no jobs";
  for (const [id, job] of Object.entries(jobs))
    if (!isMapping(job) || !("runs-on" in job)) return `job ${id} names no runs-on`;
  for (const [key, value, where] of keys(workflow)) {
    if (key === "runs-on" && !(typeof value === "string" && FREE_RUNNERS.has(value)))
      return `runs on ${shown(value) || "an empty label"} (${where}), which is not a free GitHub-hosted runner`;
    // The repository allows only GitHub-owned actions, pinned to a full commit SHA.
    if (
      key === "uses" &&
      !(
        typeof value === "string" &&
        /^(actions|github)\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/.test(value)
      )
    )
      return `uses ${shown(value)} (${where}), which is not a GitHub-owned action pinned to a commit SHA`;
    if (key === "services")
      return `starts service containers (${where}), which no workflow here may`;
    if (key !== "container") continue;
    const image = isMapping(value) ? value.image : undefined;
    if (typeof image !== "string")
      return `has container ${shown(value)} (${where}); write it as a mapping whose image is Playwright's`;
    const [, version, digest] = PLAYWRIGHT_IMAGE.exec(image) ?? [];
    if (!version)
      return `runs in ${image}, which is not Playwright's noble image pinned to a sha256 digest`;
    if (version !== playwright)
      return `runs in Playwright's v${version} image, but the installed @playwright/test is ${playwright}. Change the tag and the digest together`;
    if (!digests[version])
      return `runs in Playwright's v${version} image, which has no digest in ${DIGESTS_FILE}. Look it up with ${lookUp(version)} and add it`;
    if (digest !== digests[version])
      return `runs in Playwright's v${version} image with digest ${digest}, but ${DIGESTS_FILE} records ${digests[version]} for it`;
  }
  return undefined;
}

describe("GitHub workflows", () => {
  it("run only on free GitHub-hosted runners with pinned GitHub-owned actions", () => {
    const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    const problems = files.flatMap((name) => {
      const problem = workflowProblem(readFileSync(join(directory, name), "utf8"));
      return problem ? [`${name}: ${problem}`] : [];
    });
    expect(problems).toEqual([]);
  });

  it("records the image digest for the installed @playwright/test", () => {
    // On a Playwright upgrade this fails until the new version's digest is added, with the command that finds it.
    expect(
      recordedDigests[playwrightVersion],
      `${DIGESTS_FILE} has no digest for @playwright/test ${playwrightVersion}. Look it up with ${lookUp(playwrightVersion)}`,
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  const job = (body: string) => `jobs:\n  a:\n    runs-on: ubuntu-latest\n${body}`;
  const playwrightImage = `mcr.microsoft.com/playwright:v${playwrightVersion}-noble@${recordedDigests[playwrightVersion]}`;

  it.each([
    [
      "a larger runner",
      "jobs:\n  a:\n    runs-on: ubuntu-latest-4-cores\n",
      "runs on ubuntu-latest-4-cores",
    ],
    [
      "a self-hosted runner",
      "jobs:\n  a:\n    runs-on: [self-hosted, linux]\n",
      'runs on ["self-hosted","linux"]',
    ],
    [
      "a flow-style job beside an allowed one",
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n  costly: {runs-on: ubuntu-latest-4-cores, steps: [{run: echo hi}]}\n",
      "runs on ubuntu-latest-4-cores (jobs.costly.runs-on)",
    ],
    [
      "an action wrapped onto the next line",
      job(
        "    steps:\n      - uses:\n          someone/action@0123456789abcdef0123456789abcdef01234567\n",
      ),
      "uses someone/action@",
    ],
    ["no runner", "jobs:\n  a:\n    steps: []\n", "job a names no runs-on"],
    [
      "a third-party action",
      job("    steps:\n      - uses: someone/action@0123456789abcdef0123456789abcdef01234567\n"),
      "uses someone/action@",
    ],
    [
      "an action pinned to a tag",
      job("    steps:\n      - uses: actions/checkout@v7\n"),
      "uses actions/checkout@v7",
    ],
    [
      "an action under a double-quoted key with an escape",
      job('    steps:\n      - "\\u0075ses": docker://node:24\n'),
      "uses docker://node:24 (jobs.a.steps[0].uses)",
    ],
    [
      "another container image",
      job(`    container:\n      image: node:24@sha256:${"0".repeat(64)}\n`),
      "runs in node:24@sha256:",
    ],
    [
      "the Playwright image by tag alone",
      job(
        `    container:\n      image: mcr.microsoft.com/playwright:v${playwrightVersion}-noble\n`,
      ),
      "not Playwright's noble image pinned to a sha256 digest",
    ],
    [
      "the installed version's tag with another digest",
      job(
        `    container:\n      image: mcr.microsoft.com/playwright:v${playwrightVersion}-noble@sha256:${"1".repeat(64)}\n`,
      ),
      `records ${recordedDigests[playwrightVersion]} for it`,
    ],
    [
      "a container named on one line",
      job("    container: node:24\n"),
      "has container node:24 (jobs.a.container)",
    ],
    [
      "a container named on the next line",
      job("    container:\n      node:24\n"),
      "has container node:24 (jobs.a.container)",
    ],
    [
      "a service container",
      job("    services:\n      db:\n        image: postgres\n"),
      "starts service containers (jobs.a.services)",
    ],
    [
      "a service container under double-quoted keys with escapes",
      job(`    "\\x73ervices":\n      db:\n        "\\x69mage": ${playwrightImage}\n`),
      "starts service containers (jobs.a.services)",
    ],
    ["text that is not YAML", "jobs: [\n", "is not YAML this guard can read"],
  ])("refuses %s", (_, text, reason) => {
    expect(workflowProblem(text)).toContain(reason);
  });

  it("refuses a Playwright image whose version is not the installed @playwright/test", () => {
    const digest = `sha256:${"0".repeat(64)}`;
    const text = job(
      `    container:\n      image: mcr.microsoft.com/playwright:v1.64.1-noble@${digest} # v1.64.1\n`,
    );
    expect(workflowProblem(text, "1.65.0", { "1.64.1": digest })).toContain(
      "v1.64.1 image, but the installed @playwright/test is 1.65.0",
    );
    expect(workflowProblem(text, "1.64.1", {})).toContain(
      `has no digest in ${DIGESTS_FILE}. Look it up with skopeo inspect`,
    );
    expect(workflowProblem(text, "1.64.1", { "1.64.1": digest })).toBeUndefined();
  });

  it("accepts the Playwright image at the installed version and its recorded digest", () => {
    expect(
      workflowProblem(job(`    container:\n      image: ${playwrightImage}\n`)),
    ).toBeUndefined();
  });

  it("accepts a standard runner with a pinned GitHub action", () => {
    expect(
      workflowProblem(
        "jobs:\n  a:\n    runs-on: macos-26\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n",
      ),
    ).toBeUndefined();
  });
});
