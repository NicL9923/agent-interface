#!/usr/bin/env python3
"""Discover and run every Python test file, one subprocess per file.

Test files are standalone scripts (some have hyphenated names that cannot be
imported), so each runs as `python <file>` from the repository root. With no
arguments this runs every discovered file; pass file paths to run a subset.
A test-looking file outside the discovery globs is an error, so a new test
cannot silently never run.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GLOBS = ("tests/*_test.py", "scripts/*-test.py", "scripts/spike/*_test.py")
TEST_NAMES = ("*_test.py", "*-test.py", "test_*.py")
SKIP_DIRS = {".git", "node_modules", "build", "dist", "ios", "__pycache__", ".venv", "venv"}


def discover():
    return sorted({path for pattern in GLOBS for path in ROOT.glob(pattern)})


def stray_tests(found):
    known = set(found)
    strays = []
    for directory, names, files in os.walk(ROOT):
        names[:] = [name for name in names if name not in SKIP_DIRS]
        for file in files:
            path = Path(directory) / file
            if path not in known and any(path.match(name) for name in TEST_NAMES):
                strays.append(path)
    return sorted(strays)


def run(path):
    started = time.monotonic()
    result = subprocess.run([sys.executable, str(path)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return result.returncode, time.monotonic() - started, result.stdout


def main(argv):
    found = discover()
    if argv:
        selected = [(Path(arg) if Path(arg).is_absolute() else Path.cwd() / arg).resolve() for arg in argv]
        missing = [path for path in selected if path not in found]
        if missing:
            print("Not a discovered Python test file:", *(str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path) for path in missing), sep="\n  ")
            return 2
    else:
        selected = found
        strays = stray_tests(found)
        if strays:
            print("Test files outside the discovery globs would never run:", *(str(path.relative_to(ROOT)) for path in strays), sep="\n  ")
            print("Move them under " + ", ".join(GLOBS) + " or update GLOBS in " + Path(__file__).name + ".")
            return 2
    if not selected:
        print("No Python test files found.")
        return 2
    failures = []
    started = time.monotonic()
    for path in selected:
        name = str(path.relative_to(ROOT))
        code, seconds, output = run(path)
        print(f"{'PASS' if code == 0 else 'FAIL'} {name} ({seconds:.1f}s)", flush=True)
        if code != 0:
            failures.append(name)
            print(output.rstrip(), flush=True)
    print(f"\n{len(selected) - len(failures)} passed, {len(failures)} failed in {time.monotonic() - started:.1f}s (Python {sys.version.split()[0]})")
    if failures:
        print("Failed:", *failures, sep="\n  ")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
