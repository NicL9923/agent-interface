#!/usr/bin/env python3
"""Deploy WildBots to a Linux host with atomic release swap and automatic rollback."""

from __future__ import annotations

import argparse
import datetime as dt
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_HOST = "hermes-prod"
DEFAULT_REMOTE_ROOT = "/home/nicolas/.local/share/agent-interface"
DEFAULT_SERVICE = "agent-interface.service"
DEFAULT_HEALTH_URL = "http://127.0.0.1:3000/api/health/ready"


def run(
    argv: list[str],
    *,
    cwd: Path | None = None,
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=capture,
        check=check,
    )


def resolve_commit(ref: str, repo: Path) -> tuple[str, str]:
    sha = run(
        ["git", "rev-parse", "--verify", f"{ref}^{{commit}}"],
        cwd=repo,
        capture=True,
    ).stdout.strip()
    return sha, sha[:8]


def create_archive(sha: str, repo: Path, dest: Path) -> None:
    run(["git", "archive", "--format=tar.gz", "-o", str(dest), sha], cwd=repo)


def build_remote_script(
    *,
    remote_root: str,
    release_name: str,
    tarball_remote: str,
    service: str,
    health_url: str,
    skip_backup: bool,
    keep_releases: int,
) -> str:
    q_root = shlex.quote(remote_root)
    q_rel = shlex.quote(release_name)
    q_tar = shlex.quote(tarball_remote)
    q_svc = shlex.quote(service)
    q_url = shlex.quote(health_url)
    backup_flag = "1" if skip_backup else "0"

    return f"""set -euo pipefail
ROOT={q_root}
for candidate in $(ls -1d "$ROOT"/runtime/node-v24*/bin "$ROOT"/runtime/node-v26*/bin "$ROOT"/runtime/bun-v* 2>/dev/null | sort -V); do
  if [ -d "$candidate" ]; then
    PATH="$candidate:$PATH"
  fi
done
export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
REL_NAME={q_rel}
REL_DIR="$ROOT/releases/$REL_NAME"
TARBALL={q_tar}
SERVICE={q_svc}
HEALTH_URL={q_url}
SKIP_BACKUP={backup_flag}
KEEP={keep_releases}

mkdir -p "$ROOT/releases" "$REL_DIR"
PREV=""
if [ -L "$ROOT/current" ]; then
  PREV="$(readlink -f "$ROOT/current" || true)"
fi

tar -xzf "$TARBALL" -C "$REL_DIR"
rm -f "$TARBALL"

cd "$REL_DIR"
npm ci --no-audit --no-fund
npm run build
npm run build:server:bun

if [ -n "$PREV" ] && [ -d "$PREV/dist/client/assets" ]; then
  python3 -c 'import json, sys; print(json.dumps({{"assets": sys.argv[1]}}))' "$PREV/dist/client/assets" > "$REL_DIR/dist/previous-release.json"
fi

if [ "$SKIP_BACKUP" = "0" ] && [ -n "$PREV" ] && [ -f "$PREV/.agents/tools/backup-app.mjs" ] && [ -f "$ROOT/shared/app.env" ]; then
  (set -a; source "$ROOT/shared/app.env"; set +a; if [ -n "${{APP_DATABASE:-}}" ] && [ -n "${{APP_BACKUP_DIR:-}}" ]; then node "$PREV/.agents/tools/backup-app.mjs" "$APP_DATABASE" "$APP_BACKUP_DIR"; fi) || echo "Warning: pre-deploy backup returned non-zero; continuing." >&2
fi

rollback() {{
  echo "Deploy verification failed; rolling back to $PREV" >&2
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    ln -sfn "$PREV" "$ROOT/current.rollback"
    mv -Tf "$ROOT/current.rollback" "$ROOT/current"
    systemctl --user restart "$SERVICE"
  fi
  exit 1
}}

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
python3 - "$ROOT/releases" "$REL_DIR" "$PREV" "$KEEP" <<'PY'
import os, shutil, sys
releases_dir, current, prev, keep = sys.argv[1], os.path.realpath(sys.argv[2]), os.path.realpath(sys.argv[3]) if sys.argv[3] else "", int(sys.argv[4])
entries = sorted(
    (os.path.join(releases_dir, name) for name in os.listdir(releases_dir)),
    key=lambda p: os.path.getmtime(p),
    reverse=True,
)
keep_set = {{current}}
if prev:
    keep_set.add(prev)
for path in entries[:keep]:
    keep_set.add(os.path.realpath(path))
for path in entries:
    real = os.path.realpath(path)
    if real not in keep_set and os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
PY

echo "Deployed $REL_NAME"
"""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deploy WildBots to a remote host.")
    parser.add_argument(
        "--host", default=DEFAULT_HOST, help=f"SSH host (default: {DEFAULT_HOST})"
    )
    parser.add_argument(
        "--ref", default="HEAD", help="Git ref to deploy (default: HEAD)"
    )
    parser.add_argument(
        "--remote-root",
        default=DEFAULT_REMOTE_ROOT,
        help=f"Remote install root (default: {DEFAULT_REMOTE_ROOT})",
    )
    parser.add_argument(
        "--service",
        default=DEFAULT_SERVICE,
        help=f"Systemd user unit (default: {DEFAULT_SERVICE})",
    )
    parser.add_argument(
        "--health-url",
        default=DEFAULT_HEALTH_URL,
        help=f"Remote readiness URL (default: {DEFAULT_HEALTH_URL})",
    )
    parser.add_argument(
        "--skip-backup", action="store_true", help="Skip pre-deploy backup"
    )
    parser.add_argument(
        "--keep-releases",
        type=int,
        default=5,
        help="Number of recent releases to keep on the host (default: 5)",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Print plan without modifying host"
    )
    parser.add_argument(
        "--repo", default=".", help="Path to git repository (default: .)"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.keep_releases < 2:
        print("--keep-releases must be at least 2.", file=sys.stderr)
        return 2
    repo = Path(args.repo).resolve()
    sha, short = resolve_commit(args.ref, repo)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    release_name = f"release-{short}-{stamp}"
    tarball_remote = f"/tmp/wildbots-{release_name}.tar.gz"

    if args.dry_run:
        print(
            f"Dry run: would deploy {sha} as {release_name} to {args.host}:{args.remote_root}"
        )
        return 0

    with tempfile.TemporaryDirectory(prefix="wildbots-deploy-") as tmp:
        tarball_local = Path(tmp) / f"{release_name}.tar.gz"
        create_archive(sha, repo, tarball_local)
        run(["scp", "-q", str(tarball_local), f"{args.host}:{tarball_remote}"])

    remote_script = build_remote_script(
        remote_root=args.remote_root,
        release_name=release_name,
        tarball_remote=tarball_remote,
        service=args.service,
        health_url=args.health_url,
        skip_backup=args.skip_backup,
        keep_releases=args.keep_releases,
    )
    result = subprocess.run(
        ["ssh", args.host, "bash", "-s"],
        input=remote_script,
        text=True,
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
