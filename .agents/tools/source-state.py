#!/usr/bin/env python3
"""Identify the source state, including uncommitted files, for validation evidence."""

import hashlib
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
paths = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    cwd=root,
).split(b"\0")
prefixes = tuple(prefix.encode() for prefix in sys.argv[1:])
digest = hashlib.sha256()
count = 0
for relative in sorted(set(paths)):
    if not relative or relative == b"docs/ValidationLedger.md":
        continue
    if prefixes and not relative.startswith(prefixes):
        continue
    path = root / relative.decode()
    if not path.is_file():
        continue
    data = path.read_bytes()
    digest.update(relative + b"\0" + str(len(data)).encode() + b"\0" + data)
    count += 1
if prefixes and count == 0:
    raise SystemExit("No source files matched the supplied path prefixes.")
print(f"sha256:{digest.hexdigest()} ({count} source files)")
