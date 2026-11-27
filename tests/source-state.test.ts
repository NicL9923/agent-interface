/** Tests for .agents/tools/source-state.mjs against a throwaway git repository. */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_TOOL = join(ROOT, ".agents", "tools", "source-state.mjs");
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

describe("source-state.mjs", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "source-state-"));
    execFileSync("git", ["init", "--quiet"], { cwd: repo, env: GIT_ENV });
    mkdirSync(join(repo, ".agents", "tools"), { recursive: true });
    copyFileSync(SOURCE_TOOL, join(repo, ".agents", "tools", "source-state.mjs"));
    write(join(repo, "src", "app.ts"), "export {};\n");
    write(join(repo, "docs", "ValidationLedger.md"), "# Validation ledger\n");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function fingerprint(...prefixes: string[]): [string, string] {
    const out = execFileSync(process.execPath, [".agents/tools/source-state.mjs", ...prefixes], {
      cwd: repo,
      env: GIT_ENV,
      encoding: "utf8",
    }).trim();
    const match = /^(sha256:[0-9a-f]{64}) \((\d+) source files\)$/.exec(out);
    expect(match).not.toBeNull();
    return [match![1], match![2]];
  }

  it("excludes docs/ValidationLedger.md and docs/ledger/ from the fingerprint", () => {
    const before = fingerprint();
    write(join(repo, "docs", "ValidationLedger.md"), "# Validation ledger\n\n## More\n");
    write(join(repo, "docs", "ledger", "20261021T190417Z-app-release-f257cc09.md"), "# Entry\n");
    write(join(repo, "docs", "ledger", "README.md"), "# Entries\n");
    execFileSync("git", ["add", "docs/ledger"], { cwd: repo, env: GIT_ENV });
    expect(fingerprint()).toEqual(before);
  });

  it("changes when source or non-ledger docs change and supports prefix filtering", () => {
    const [before, count] = fingerprint();
    write(join(repo, "docs", "ledgers.md"), "not the ledger directory\n");
    const [afterDoc, countAfterDoc] = fingerprint();
    expect(countAfterDoc).toBe(String(Number(count) + 1));
    expect(afterDoc).not.toBe(before);
    write(join(repo, "src", "app.ts"), "export const changed = 1;\n");
    expect(fingerprint()[0]).not.toBe(afterDoc);
    expect(fingerprint("src/")[1]).toBe("1");
  });
});
