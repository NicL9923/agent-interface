#!/usr/bin/env python3
"""Format and lint staged Python with the same Ruff pin as check-all."""

from pathlib import Path
import subprocess
import sys

from check_all import Refusal, cache_dir, find_ruff

root = Path(__file__).resolve().parents[2]
try:
    if sys.argv[1:]:
        ruff = find_ruff(root, cache_dir())
        for mode in ("format", "check"):
            subprocess.run(
                [ruff, mode, "--config", str(root / "ruff.toml"), *sys.argv[1:]],
                check=True,
            )
except (Refusal, OSError, subprocess.CalledProcessError) as error:
    print(error, file=sys.stderr)
    sys.exit(1)
