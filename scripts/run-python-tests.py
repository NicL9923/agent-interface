#!/usr/bin/env python3
"""Discover and run every Python test file, one subprocess per file.

Test files are standalone scripts (some have hyphenated names that cannot be
imported), so each runs as `python <file>` from the repository root. With no
arguments this runs every discovered file; pass file paths to run a subset.
A test-looking file outside the discovery globs is an error, so a new test
cannot silently never run.

Test files must use unittest. A file passes only if its unittest summary shows
at least one test ran, so an empty file or a bare script that exits 0 fails. A
file whose every test was skipped shows SKIP, which passes locally (for example
no tmux) and fails when CI=true, so a runner missing a tool cannot go green.
"""
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GLOBS = ("tests/*_test.py", "scripts/*-test.py", "scripts/spike/*_test.py")
TEST_NAMES = ("*_test.py", "*-test.py", "test_*.py")


def discover():
    return sorted({path for pattern in GLOBS for path in ROOT.glob(pattern)})


def stray_tests(found, root=ROOT):
    """Test-looking files that git tracks or would add, so ignored output is skipped."""
    listing = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root, check=True, stdout=subprocess.PIPE, text=True).stdout
    known = set(found)
    paths = (root / name for name in listing.split("\0") if name)
    return sorted(path for path in paths if path not in known and path.is_file() and any(path.match(pattern) for pattern in TEST_NAMES))


def classify(returncode, summary, ci):
    """Return (status, note) from the exit code and the unittest summary on stderr.

    The last "Ran N tests" line and the outcome line right after it are read as
    one unit, so output from a nested unittest run earlier in the stream cannot
    contribute a skip count or an OK. Skips reported through subTest are not
    counted; the worst case is a loud false SKIP (a CI failure), never a
    silent pass.
    """
    if returncode != 0:
        return "FAIL", ""
    final = re.findall(r"^Ran (\d+) tests? in [^\n]*(?:\n+([^\n]*))?", summary, re.MULTILINE)
    if not final:
        return "FAIL", "no unittest tests ran; test files must define unittest tests"
    ran, outcome = int(final[-1][0]), final[-1][1].strip()
    if ran == 0:
        return "FAIL", "no unittest tests ran; test files must define unittest tests"
    match = re.fullmatch(r"OK(?: \((.*)\))?", outcome)
    if not match:
        return "FAIL", f"unittest did not report OK: {outcome or 'no outcome line'}"
    skipped = re.search(r"skipped=(\d+)", match.group(1) or "")
    skips = int(skipped.group(1)) if skipped else 0
    if skips >= ran:
        return ("FAIL", f"all {ran} tests skipped under CI") if ci else ("SKIP", f"all {ran} tests skipped")
    return "PASS", f"{skips} skipped" if skips else ""


def run(path):
    started = time.monotonic()
    result = subprocess.run([sys.executable, str(path)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return result.returncode, time.monotonic() - started, result.stdout, result.stderr


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
    ci = os.environ.get("CI") == "true"
    failures = []
    counts = {}
    started = time.monotonic()
    for path in selected:
        name = str(path.relative_to(ROOT))
        code, seconds, stdout, stderr = run(path)
        status, note = classify(code, stderr, ci)
        counts[status] = counts.get(status, 0) + 1
        print(f"{status} {name} ({seconds:.1f}s){' ' + note if note else ''}", flush=True)
        if status == "FAIL":
            failures.append(name)
            print((stdout + stderr).rstrip(), flush=True)
    print(f"\n{counts.get('PASS', 0)} passed, {counts.get('SKIP', 0)} skipped, {len(failures)} failed in {time.monotonic() - started:.1f}s (Python {sys.version.split()[0]})")
    if failures:
        print("Failed:", *failures, sep="\n  ")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
