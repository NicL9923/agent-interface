import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
const PLAYWRIGHT_IMAGE = /^mcr\.microsoft\.com\/playwright:v([\w.-]+)-noble@sha256:[0-9a-f]{64}$/;

/**
 * Every `runs-on`, `uses` and container `image` value in a workflow. The guard reads only the plain one-line block
 * form (`runs-on: label`, `- uses: owner/action@sha`, `image: name@digest` under a bare `container:`), and fails
 * closed on any other appearance of those keys or of `services`, such as a flow mapping (`{runs-on: ...}`), a value
 * wrapped onto the next line, or a one-line `container: image`.
 */
function workflowRefs(text: string) {
  const runners: string[] = [],
    actions: string[] = [],
    images: string[] = [],
    unreadable: string[] = [];
  for (const line of text.split("\n")) {
    if (
      !/(^|[\s{,'"-])(runs-on|uses|container|image|services)['"]?\s*:/.test(
        line.replace(/#.*$/, ""),
      )
    )
      continue;
    const runner = /^\s*runs-on:\s*([^\s#{}[\],]+)\s*(#.*)?$/.exec(line);
    const action = /^\s*(?:-\s+)?uses:\s*([^\s#{}[\],]+)\s*(#.*)?$/.exec(line);
    const image = /^\s*image:\s*([^\s#{}[\],]+)\s*(#.*)?$/.exec(line);
    if (runner) runners.push(runner[1]!);
    else if (action) actions.push(action[1]!);
    else if (image) images.push(image[1]!);
    else if (!/^\s*container:\s*(#.*)?$/.test(line)) unreadable.push(line.trim());
  }
  return { runners, actions, images, unreadable };
}

/** Why a workflow breaks the free-runner rule, or undefined when it does not. */
function workflowProblem(text: string, playwright = playwrightVersion): string | undefined {
  const { runners, actions, images, unreadable } = workflowRefs(text);
  if (unreadable.length)
    return `has a runs-on or uses this guard cannot read: ${unreadable[0]}. Write it on one line in block style`;
  if (!runners.length) return "names no runs-on";
  for (const runner of runners)
    if (!FREE_RUNNERS.has(runner))
      return `runs on ${runner || "an empty label"}, which is not a free GitHub-hosted runner`;
  for (const action of actions) {
    // The repository allows only GitHub-owned actions, pinned to a full commit SHA.
    if (!/^(actions|github)\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/.test(action))
      return `uses ${action}, which is not a GitHub-owned action pinned to a commit SHA`;
  }
  for (const image of images) {
    const version = PLAYWRIGHT_IMAGE.exec(image)?.[1];
    if (!version)
      return `runs in ${image}, which is not Playwright's noble image pinned to a sha256 digest`;
    if (version !== playwright)
      return `runs in Playwright's v${version} image, but the installed @playwright/test is ${playwright}. Change the tag and the digest together`;
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

  it.each([
    [
      "a larger runner",
      "jobs:\n  a:\n    runs-on: ubuntu-latest-4-cores\n",
      "runs on ubuntu-latest-4-cores",
    ],
    [
      "a self-hosted runner",
      "jobs:\n  a:\n    runs-on: [self-hosted, linux]\n",
      "cannot read: runs-on: [self-hosted, linux]",
    ],
    [
      "a flow-style job beside an allowed one",
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n  costly: {runs-on: ubuntu-latest-4-cores, steps: [{run: echo hi}]}\n",
      "cannot read: costly: {runs-on",
    ],
    [
      "an action wrapped onto the next line",
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses:\n          someone/action@0123456789abcdef0123456789abcdef01234567\n",
      "cannot read: - uses:",
    ],
    ["no runner", "jobs:\n  a:\n    steps: []\n", "names no runs-on"],
    [
      "a third-party action",
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: someone/action@0123456789abcdef0123456789abcdef01234567\n",
      "uses someone/action@",
    ],
    [
      "an action pinned to a tag",
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n",
      "uses actions/checkout@v7",
    ],
    [
      "another container image",
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      image: node:24@sha256:" +
        "0".repeat(64) +
        "\n",
      "runs in node:24@sha256:",
    ],
    [
      "the Playwright image by tag alone",
      `jobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      image: mcr.microsoft.com/playwright:v${playwrightVersion}-noble\n`,
      "not Playwright's noble image pinned to a sha256 digest",
    ],
    [
      "a container named on one line",
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    container: node:24\n",
      "cannot read: container: node:24",
    ],
    [
      "a service container",
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: postgres\n",
      "cannot read: services:",
    ],
  ])("refuses %s", (_, text, reason) => {
    expect(workflowProblem(text)).toContain(reason);
  });

  it("refuses a Playwright image whose version is not the installed @playwright/test", () => {
    const image = `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:${"0".repeat(64)}`;
    const text = `jobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      image: ${image} # v1.64.1\n`;
    expect(workflowProblem(text, "1.65.0")).toContain(
      "v1.64.1 image, but the installed @playwright/test is 1.65.0",
    );
    expect(workflowProblem(text, "1.64.1")).toBeUndefined();
  });

  it("accepts a standard runner with a pinned GitHub action", () => {
    expect(
      workflowProblem(
        "jobs:\n  a:\n    runs-on: macos-26\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n",
      ),
    ).toBeUndefined();
  });
});
