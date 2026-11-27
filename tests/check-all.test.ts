/** Tests for .agents/tools/check-all.mjs using temp directories and fake executables on PATH. */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM tool script without .d.ts
import * as checkAll from "../.agents/tools/check-all.mjs";

function lockYaml(packages: Record<string, { optional?: boolean }>): string {
  const lines = ["lockfileVersion: '9.0'", "", "packages:"];
  const optional: string[] = [];
  for (const [key, meta] of Object.entries(packages)) {
    const quoted = key.startsWith("@") ? `'${key}'` : key;
    lines.push(`  ${quoted}:`, "    resolution: {integrity: sha512-test}");
    if (meta.optional) optional.push(quoted);
  }
  if (optional.length) {
    lines.push("", "snapshots:");
    for (const quoted of optional) lines.push(`  ${quoted}:`, "    optional: true");
  }
  return `${lines.join("\n")}\n`;
}

function writeScript(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o700);
}

describe("check-all.mjs lockfile & install checks", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "check-all-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeCheckout(
    options: {
      lock?: Record<string, { optional?: boolean }> | string;
      installed?: Record<string, { optional?: boolean }> | string | false;
      link?: boolean;
    } = {},
  ) {
    const root = mkdtempSync(join(tmp, "checkout-"));
    const lockText =
      typeof options.lock === "string" ? options.lock : lockYaml(options.lock ?? { "a@1.0.0": {} });
    writeFileSync(join(root, "pnpm-lock.yaml"), lockText, "utf8");
    if (options.installed !== false) {
      const home = options.link ? mkdtempSync(join(tmp, "shared-")) : root;
      mkdirSync(join(home, "node_modules", ".pnpm"), { recursive: true });
      const installedText =
        options.installed === undefined
          ? lockText
          : typeof options.installed === "string"
            ? options.installed
            : lockYaml(options.installed);
      writeFileSync(join(home, "node_modules", ".pnpm", "lock.yaml"), installedText, "utf8");
      if (options.link) symlinkSync(join(home, "node_modules"), join(root, "node_modules"));
    }
    return root;
  }

  it("computes lockfile drift while tolerating missing cross-platform optional packages", () => {
    const wanted = checkAll.parsePnpmLock(
      lockYaml({ "a@1.0.0": {}, "@tsrs/darwin-arm64@2.0.0": { optional: true } }),
    );
    expect(checkAll.lockDrift(wanted, checkAll.parsePnpmLock(lockYaml({ "a@1.0.0": {} })))).toEqual(
      [],
    );
    expect(checkAll.lockDrift(wanted, checkAll.parsePnpmLock(lockYaml({ "a@0.9.0": {} })))).toEqual(
      ["a is 0.9.0 but pnpm-lock.yaml has 1.0.0"],
    );
    expect(
      checkAll.lockDrift(
        checkAll.parsePnpmLock(lockYaml({ "a@1.0.0": {}, "b@1.0.0": {} })),
        checkAll.parsePnpmLock(lockYaml({ "a@1.0.0": {} })),
      ),
    ).toEqual(["b@1.0.0 is in pnpm-lock.yaml but not installed"]);
    expect(
      checkAll.lockDrift(
        checkAll.parsePnpmLock(lockYaml({})),
        checkAll.parsePnpmLock(lockYaml({ "a@1.0.0": {} })),
      ),
    ).toEqual(["a@1.0.0 is installed but not in pnpm-lock.yaml"]);
  });

  it("refuses missing, non-pnpm, stale, or unreadable installs and warns on symlinks", () => {
    expect(() => checkAll.checkInstall(makeCheckout({ installed: false }))).toThrow(
      /node_modules is missing.*pnpm install --frozen-lockfile/,
    );

    const noHidden = makeCheckout();
    unlinkSync(join(noHidden, "node_modules", ".pnpm", "lock.yaml"));
    expect(() => checkAll.checkInstall(noHidden)).toThrow("did not install it");

    expect(() => checkAll.checkInstall(makeCheckout({ installed: { "a@0.9.0": {} } }))).toThrow(
      /pnpm-lock\.yaml changed.*a is 0\.9\.0.*pnpm install --frozen-lockfile/,
    );

    const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}@1.0.0`, {}]));
    expect(() => checkAll.checkInstall(makeCheckout({ lock: {}, installed: many }))).toThrow(
      "and 3 more",
    );

    expect(() => checkAll.checkInstall(makeCheckout({ lock: "not a pnpm lockfile" }))).toThrow(
      "Could not read the lockfiles",
    );

    expect(checkAll.checkInstall(makeCheckout())).toEqual([]);

    const linked = makeCheckout({ link: true });
    const warnings = checkAll.checkInstall(linked);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("symlink");
  });
});

describe("check-all.mjs locks, ports, counts, and battery", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "check-all-battery-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reclaims locks left behind by dead PIDs or 0-byte legacy lockfiles and rejects live contention", async () => {
    const locks = join(tmp, "locks");
    const staleLock = join(locks, "heavy-0.lock");
    mkdirSync(locks, { recursive: true });
    writeFileSync(staleLock, "", "utf8");
    const { held: fromEmpty } = await checkAll.acquireSlot(locks, 1, { check: "legacy" }, 1);
    fromEmpty.release();
    writeFileSync(staleLock, JSON.stringify({ pid: 999999999, check: "dead" }), "utf8");
    const { held } = await checkAll.acquireSlot(locks, 1, { check: "test" }, 1);
    expect(held).toBeTruthy();
    await expect(checkAll.acquireSlot(locks, 1, { check: "second" }, 0.2)).rejects.toThrow(
      checkAll.LockTimeout,
    );
    held.release();
    const { held: second } = await checkAll.acquireSlot(locks, 1, { check: "second" }, 1);
    second.release();
  });

  it("picks free app+control port pairs and refuses busy or locked ports", async () => {
    const locks = join(tmp, "locks");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const busyPort = (server.address() as { port: number }).port;
    try {
      await expect(checkAll.pickE2ePort(locks, "w", { requested: busyPort })).rejects.toThrow(
        `port ${busyPort} is in use`,
      );
      const lease = await checkAll.pickE2ePort(locks, "w", { base: 34200, pairs: 20 });
      await expect(checkAll.pickE2ePort(locks, "w2", { requested: lease.port })).rejects.toThrow(
        "locked by another check-all",
      );
      lease.release();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("parses counts and formats summaries for test, build, and e2e", () => {
    expect(
      checkAll.formatCounts(
        "test",
        checkAll.parseCounts("test", " Test Files  3 passed (3)\n      Tests  12 passed (12)\n"),
      ),
    ).toBe("3 files, 12 tests");
    expect(
      checkAll.formatCounts("build", checkAll.parseCounts("build", "✓ 912 modules transformed.\n")),
    ).toBe("912 modules");
    expect(
      checkAll.formatCounts(
        "e2e:webkit",
        checkAll.parseCounts("e2e:webkit", "  4 passed (2s)\n  1 skipped\n"),
      ),
    ).toBe("5 tests, 1 skipped");
  });

  it("runs battery with fake pnpm and falls back to podman for WebKit when host WebKit fails", async () => {
    const root = join(tmp, "repo");
    const cache = join(tmp, "cache");
    const bin = join(tmp, "bin");
    const callsLog = join(tmp, "calls.log");
    mkdirSync(join(root, "node_modules", ".pnpm"), { recursive: true });
    mkdirSync(join(root, "node_modules", "@playwright", "test"), { recursive: true });
    mkdirSync(join(root, "dist", "client"), { recursive: true });
    mkdirSync(bin, { recursive: true });

    const lock = lockYaml({ "a@1.0.0": {} });
    writeFileSync(join(root, "pnpm-lock.yaml"), lock, "utf8");
    writeFileSync(join(root, "node_modules", ".pnpm", "lock.yaml"), lock, "utf8");
    writeFileSync(
      join(root, "node_modules", "@playwright", "test", "package.json"),
      '{"version":"1.65.0"}',
      "utf8",
    );
    writeFileSync(join(root, "dist", "client", "index.html"), "<html>", "utf8");

    writeScript(
      join(bin, "node"),
      `#!/usr/bin/env bash
if [[ "$*" == *"satisfiesEngine"* ]]; then
  echo '{"ok":true,"version":"v24.22.2","range":"^24.22.2"}'
  exit 0
fi
if [[ "$*" == *"webkit.launch"* ]]; then
  echo '{"ok":false,"message":"Host system is missing dependencies to run browsers."}'
  exit 0
fi
exit 97
`,
    );
    writeScript(
      join(bin, "pnpm"),
      `#!/usr/bin/env bash
echo "pnpm $*" >> ${JSON.stringify(callsLog)}
echo "  3 passed (2s)"
`,
    );
    writeScript(
      join(bin, "podman"),
      `#!/usr/bin/env bash
echo "podman $*" >> ${JSON.stringify(callsLog)}
if [[ "$1" == "run" ]]; then echo "  2 passed (2s)"; fi
`,
    );

    const env = { ...process.env, PATH: `${bin}${delimiter}/usr/bin:/bin` };
    const { results } = await checkAll.runBattery(
      root,
      { only: "e2e", keepGoing: false, verbose: false, lockTimeout: 10, checkTimeout: 30 },
      cache,
      () => {},
      env,
    );
    expect(results.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([
      ["e2e:chromium", "pass"],
      ["e2e:webkit (podman)", "pass"],
    ]);
    const logged = readFileSync(callsLog, "utf8");
    expect(logged).toContain("pnpm run test:e2e --project=chromium");
    expect(logged).toContain("./node_modules/.bin/playwright test --project=webkit");
    expect(logged).toContain("podman rm --force --ignore --time 5 check-all-webkit-");
  });
});
