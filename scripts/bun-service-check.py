#!/usr/bin/env python3
"""Check the pinned Bun and its staged server bundle before systemd starts WildBots."""

import argparse
import subprocess
from pathlib import Path

VERSION = "1.4.5"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bun", type=Path, help="absolute path to the pinned Bun binary")
    args = parser.parse_args()
    if not args.bun.is_absolute():
        parser.error("provide the absolute path to Bun")

    try:
        version = subprocess.check_output(
            [str(args.bun), "--version"], text=True, timeout=5
        ).strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f"Cannot run Bun at {args.bun}: {error}") from None
    if version != VERSION:
        raise SystemExit(f"Expected Bun {VERSION} at {args.bun}, found {version}.")

    bundle = Path(__file__).resolve().parents[1] / "dist" / "server"
    for name in ("index.js", "index.js.map", "terminal-host.py"):
        if not (bundle / name).is_file():
            raise SystemExit(f"Missing {bundle / name}. Run npm run build:server:bun.")
    print(f"Bun {VERSION} and the WildBots server bundle are ready.")


if __name__ == "__main__":
    main()
