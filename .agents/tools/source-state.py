#!/usr/bin/env python3
"""Identify the source state, including uncommitted files, for validation evidence."""

import hashlib
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parents[2]
paths = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    cwd=root,
).split(b"\0")
digest = hashlib.sha256()
count = 0
for relative in sorted(set(paths)):
    if not relative or relative == b"docs/ValidationLedger.md":
        continue
    path = root / relative.decode()
    if not path.is_file():
        continue
    data = path.read_bytes()
    digest.update(relative + b"\0" + str(len(data)).encode() + b"\0" + data)
    count += 1
print(f"sha256:{digest.hexdigest()} ({count} source files)")
