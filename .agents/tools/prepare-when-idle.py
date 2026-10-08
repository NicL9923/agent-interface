#!/usr/bin/env python3
"""Run release-app.py prepare until the household's assistants are idle.

The guarded preflight refuses while Hermes is busy. This retries only that
refusal, discarding each refused stage, and stops on any other failure.
"""
import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

TOOL = Path(__file__).with_name("release-app.py")
BUSY = re.compile(r'gate\["busy"\]')
DISCARD = re.compile(r"Discard with: release-app\.py discard (release-[\w-]+)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit")
    parser.add_argument("--host", required=True)
    parser.add_argument("--app-base", required=True)
    parser.add_argument("--qualification")
    parser.add_argument("--minutes", type=float, default=40, help="give up after this long (default 40)")
    parser.add_argument("--interval", type=float, default=120, help="seconds between attempts (default 120)")
    args = parser.parse_args()
    command = [sys.executable, str(TOOL), "prepare", args.commit, "--host", args.host, "--app-base", args.app_base]
    if args.qualification:
        command += ["--qualification", args.qualification]
    deadline = time.monotonic() + args.minutes * 60
    attempt = 0
    while True:
        attempt += 1
        result = subprocess.run(command, capture_output=True, text=True)
        output = result.stdout + result.stderr
        prepared = re.search(r"^Prepared .*$", output, re.M)
        if prepared:
            print(prepared.group(0))
            return 0
        stage = DISCARD.search(output)
        if not BUSY.search(output):
            print(output, end="", file=sys.stderr)
            print(f"Attempt {attempt} failed for a reason other than busy assistants; not retrying.", file=sys.stderr)
            return 1
        if stage:
            subprocess.run([sys.executable, str(TOOL), "discard", stage.group(1), "--host", args.host], capture_output=True, check=True)
        print(f"Attempt {attempt}: assistants busy, discarded {stage.group(1) if stage else 'nothing'}.", flush=True)
        if time.monotonic() + args.interval > deadline:
            print("Gave up waiting for idle assistants.", file=sys.stderr)
            return 2
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
