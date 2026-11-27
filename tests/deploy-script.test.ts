/** Tests for scripts/deploy.ts using temp directories and fake executables on PATH. */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEPLOY_SCRIPT = join(REPO_ROOT, "scripts", "deploy.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

function makeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

describe("scripts/deploy.ts", () => {
  let tmp: string;
  let binDir: string;
  let repo: string;
  let remoteRoot: string;
  let logFile: string;
  let prevRelease: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "wildbots-deploy-test-"));
    binDir = join(tmp, "bin");
    repo = join(tmp, "repo");
    remoteRoot = join(tmp, "remote");
    logFile = join(tmp, "calls.log");
    mkdirSync(binDir);
    mkdirSync(repo);
    mkdirSync(remoteRoot);

    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "package.json"), '{"name":"wildbots"}\n', "utf8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });

    prevRelease = join(remoteRoot, "releases", "release-prev");
    mkdirSync(join(prevRelease, "dist", "client", "assets"), { recursive: true });
    symlinkSync(prevRelease, join(remoteRoot, "current"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function installFakes(healthBody = '{"ok":true}'): NodeJS.ProcessEnv {
    makeExecutable(
      join(binDir, "scp"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const src = args[args.length - 2];
const dst = args[args.length - 1];
const remotePath = dst.slice(dst.indexOf(":") + 1);
fs.copyFileSync(src, remotePath);
`,
    );
    makeExecutable(
      join(binDir, "ssh"),
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const script = fs.readFileSync(0, "utf8");
const env = { ...process.env, PATH: ${JSON.stringify(binDir)} + ${JSON.stringify(delimiter)} + process.env.PATH };
const proc = spawnSync("bash", ["-s"], { input: script, encoding: "utf8", env, stdio: ["pipe", "inherit", "inherit"] });
process.exit(proc.status ?? 1);
`,
    );
    makeExecutable(
      join(binDir, "pnpm"),
      `#!/usr/bin/env bash
echo "pnpm $*" >> ${JSON.stringify(logFile)}
mkdir -p dist/client/assets
`,
    );
    makeExecutable(
      join(binDir, "systemctl"),
      `#!/usr/bin/env bash
echo "systemctl $*" >> ${JSON.stringify(logFile)}
`,
    );
    makeExecutable(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
printf '%s' ${JSON.stringify(healthBody)}
`,
    );
    return { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` };
  }

  it("resolves commit in --dry-run without touching host", () => {
    const result = spawnSync(
      TSX_BIN,
      [DEPLOY_SCRIPT, "--repo", repo, "--remote-root", remoteRoot, "--dry-run"],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Dry run: would deploy");
    expect(readlinkSync(join(remoteRoot, "current"))).toBe(prevRelease);
  });

  it("deploys release, writes previous-release.json, and flips symlink", () => {
    const env = installFakes('{"ok":true}');
    const result = spawnSync(
      TSX_BIN,
      [
        DEPLOY_SCRIPT,
        "--repo",
        repo,
        "--host",
        "fake-host",
        "--remote-root",
        remoteRoot,
        "--skip-backup",
      ],
      { env, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const current = readlinkSync(join(remoteRoot, "current"));
    expect(current).not.toBe(prevRelease);
    expect(existsSync(join(current, "package.json"))).toBe(true);
    const prevJson = JSON.parse(
      readFileSync(join(current, "dist", "previous-release.json"), "utf8"),
    );
    expect(prevJson).toEqual({ assets: join(prevRelease, "dist", "client", "assets") });
    const calls = readFileSync(logFile, "utf8");
    expect(calls).toContain("pnpm install --frozen-lockfile");
    expect(calls).toContain("pnpm run build:server:bun");
    expect(calls).toContain("systemctl --user restart agent-interface.service");
  });

  it("rolls back automatically when health check fails", () => {
    const env = installFakes('{"ok":false}');
    makeExecutable(join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    const result = spawnSync(
      TSX_BIN,
      [
        DEPLOY_SCRIPT,
        "--repo",
        repo,
        "--host",
        "fake-host",
        "--remote-root",
        remoteRoot,
        "--skip-backup",
      ],
      { env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("rolling back");
    expect(realpathSync(join(remoteRoot, "current"))).toBe(realpathSync(prevRelease));
    const restarts = readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("systemctl --user restart"));
    expect(restarts).toHaveLength(2);
  });

  it("rejects --keep-releases below two", () => {
    const result = spawnSync(TSX_BIN, [DEPLOY_SCRIPT, "--keep-releases", "1"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
  });
});
