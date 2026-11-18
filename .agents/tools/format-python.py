#!/usr/bin/env python3
"""Run the pinned Ruff formatter over every Python file, the same set and config as the pre-commit hook.

`--write` rewrites files, `--check` fails on drift. Files listed under [format] exclude in ruff.toml are skipped.
"""

from pathlib import Path
import subprocess
import sys

from check_all import Refusal, cache_dir, find_ruff

root = Path(__file__).resolve().parents[2]
mode = sys.argv[1:] or ["--check"]
if mode not in (["--check"], ["--write"]):
    sys.exit("usage: format-python.py --write | --check")
try:
    ruff = find_ruff(root, cache_dir())
    argv = [ruff, "format", "--config", str(root / "ruff.toml"), "--force-exclude"]
    if mode == ["--check"]:
        argv.append("--check")
    tracked = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--", "*.py"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split("\0")
    sys.exit(
        subprocess.run(
            [*argv, *[str(root / name) for name in tracked if name]], check=False
        ).returncode
    )
except (Refusal, OSError, subprocess.CalledProcessError) as error:
    print(error, file=sys.stderr)
    sys.exit(1)
