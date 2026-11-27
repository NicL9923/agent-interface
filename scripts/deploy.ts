#!/usr/bin/env tsx
/** Deploy WildBots to a Linux host with atomic release swap and automatic rollback. */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_HOST = "hermes-prod";
export const DEFAULT_REMOTE_ROOT = "/home/nicolas/.local/share/agent-interface";
export const DEFAULT_SERVICE = "agent-interface.service";
export const DEFAULT_HEALTH_URL = "http://127.0.0.1:3000/api/health/ready";

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveCommit(ref: string, repo: string): { sha: string; short: string } {
  const sha = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  return { sha, short: sha.slice(0, 8) };
}

export function createArchive(sha: string, repo: string, dest: string): void {
  execFileSync("git", ["archive", "--format=tar.gz", "-o", dest, sha], { cwd: repo });
}

export function buildRemoteScript(options: {
  remoteRoot: string;
  releaseName: string;
  tarballRemote: string;
  service: string;
  healthUrl: string;
  skipBackup: boolean;
  keepReleases: number;
}): string {
  const qRoot = shQuote(options.remoteRoot);
  const qRel = shQuote(options.releaseName);
  const qTar = shQuote(options.tarballRemote);
  const qSvc = shQuote(options.service);
  const qUrl = shQuote(options.healthUrl);
  const backupFlag = options.skipBackup ? "1" : "0";

  return `set -euo pipefail
ROOT=${qRoot}
for candidate in $(ls -1d "$ROOT"/runtime/node-v24*/bin "$ROOT"/runtime/node-v26*/bin "$ROOT"/runtime/bun-v* 2>/dev/null | sort -V); do
  if [ -d "$candidate" ]; then
    PATH="$candidate:$PATH"
  fi
done
export PATH="$PATH:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
REL_NAME=${qRel}
REL_DIR="$ROOT/releases/$REL_NAME"
TARBALL=${qTar}
SERVICE=${qSvc}
HEALTH_URL=${qUrl}
SKIP_BACKUP=${backupFlag}
KEEP=${options.keepReleases}

mkdir -p "$ROOT/releases" "$REL_DIR"
PREV=""
if [ -L "$ROOT/current" ]; then
  PREV="$(readlink -f "$ROOT/current" || true)"
fi

tar -xzf "$TARBALL" -C "$REL_DIR"
rm -f "$TARBALL"

cd "$REL_DIR"
pnpm install --frozen-lockfile
pnpm run build
pnpm run build:server:bun

if [ -n "$PREV" ] && [ -d "$PREV/dist/client/assets" ]; then
  node -e 'console.log(JSON.stringify({ assets: process.argv[1] }))' "$PREV/dist/client/assets" > "$REL_DIR/dist/previous-release.json"
fi

if [ "$SKIP_BACKUP" = "0" ] && [ -n "$PREV" ] && [ -f "$PREV/.agents/tools/backup-app.mjs" ] && [ -f "$ROOT/shared/app.env" ]; then
  (set -a; source "$ROOT/shared/app.env"; set +a; if [ -n "\${APP_DATABASE:-}" ] && [ -n "\${APP_BACKUP_DIR:-}" ]; then node "$PREV/.agents/tools/backup-app.mjs" "$APP_DATABASE" "$APP_BACKUP_DIR"; fi) || echo "Warning: pre-deploy backup returned non-zero; continuing." >&2
fi

rollback() {
  echo "Deploy verification failed; rolling back to $PREV" >&2
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    ln -sfn "$PREV" "$ROOT/current.rollback"
    mv -Tf "$ROOT/current.rollback" "$ROOT/current"
    systemctl --user restart "$SERVICE"
  fi
  exit 1
}

ln -sfn "$REL_DIR" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
systemctl --user restart "$SERVICE"

OK=0
for _ in $(seq 1 30); do
  BODY="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null || true)"
  if printf '%s' "$BODY" | grep -q '"ok":true'; then
    OK=1
    echo "Health check passed: $BODY"
    break
  fi
  sleep 1
done

if [ "$OK" != "1" ]; then
  rollback
fi

# Prune old releases, always keeping current, previous, and the newest KEEP releases.
node - "$ROOT/releases" "$REL_DIR" "$PREV" "$KEEP" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [releasesDir, currentArg, prevArg, keepArg] = process.argv.slice(2);
const current = fs.realpathSync(currentArg);
const prev = prevArg ? fs.realpathSync(prevArg) : "";
const keep = Number(keepArg);
const entries = fs
  .readdirSync(releasesDir)
  .map((name) => path.join(releasesDir, name))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const keepSet = new Set([current]);
if (prev) keepSet.add(prev);
for (const entry of entries.slice(0, keep)) keepSet.add(fs.realpathSync(entry));
for (const entry of entries) {
  const real = fs.realpathSync(entry);
  if (!keepSet.has(real) && fs.statSync(entry).isDirectory()) {
    fs.rmSync(entry, { recursive: true, force: true });
  }
}
NODE

echo "Deployed $REL_NAME"
`;
}

export function main(argv = process.argv.slice(2)): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      host: { type: "string", default: DEFAULT_HOST },
      ref: { type: "string", default: "HEAD" },
      "remote-root": { type: "string", default: DEFAULT_REMOTE_ROOT },
      service: { type: "string", default: DEFAULT_SERVICE },
      "health-url": { type: "string", default: DEFAULT_HEALTH_URL },
      "skip-backup": { type: "boolean", default: false },
      "keep-releases": { type: "string", default: "5" },
      "dry-run": { type: "boolean", default: false },
      repo: { type: "string", default: "." },
    },
  });

  const keepReleases = Number(values["keep-releases"]);
  if (!Number.isInteger(keepReleases) || keepReleases < 2) {
    console.error("--keep-releases must be at least 2.");
    return 2;
  }

  const repo = resolve(values.repo);
  const { sha, short } = resolveCommit(values.ref, repo);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const releaseName = `release-${short}-${stamp}`;
  const tarballRemote = `/tmp/wildbots-${releaseName}.tar.gz`;

  if (values["dry-run"]) {
    console.log(
      `Dry run: would deploy ${sha} as ${releaseName} to ${values.host}:${values["remote-root"]}`,
    );
    return 0;
  }

  const tmp = mkdtempSync(join(tmpdir(), "wildbots-deploy-"));
  try {
    const tarballLocal = join(tmp, `${releaseName}.tar.gz`);
    createArchive(sha, repo, tarballLocal);
    execFileSync("scp", ["-q", tarballLocal, `${values.host}:${tarballRemote}`], {
      stdio: "inherit",
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const remoteScript = buildRemoteScript({
    remoteRoot: values["remote-root"],
    releaseName,
    tarballRemote,
    service: values.service,
    healthUrl: values["health-url"],
    skipBackup: Boolean(values["skip-backup"]),
    keepReleases,
  });
  const result = spawnSync("ssh", [values.host, "bash", "-s"], {
    input: remoteScript,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
