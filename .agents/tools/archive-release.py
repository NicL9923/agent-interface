#!/usr/bin/env python3
"""Archive public server/build inputs without ignored secrets or macOS metadata."""
import hashlib
import json
import subprocess
import sys
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 .agents/tools/archive-release.py OUTPUT.tar.gz")
output = Path(sys.argv[1]).resolve()
names = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root
).decode().split("\0")
top = {"package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "vitest.config.ts", "index.html", ".node-version", ".env.example"}
files = sorted({name for name in names if name in top or name.startswith(
    ("src/", "scripts/", "tests/", "public/", ".agents/tools/")
)})
output.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(output, "w:gz", format=tarfile.PAX_FORMAT) as archive:
    for name in files:
        path = root / name
        if path.is_symlink():
            raise SystemExit(f"Release inputs must be regular files: {name}")
        if not path.is_file():
            continue
        info = archive.gettarinfo(str(path), arcname=name)
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        with path.open("rb") as source:
            archive.addfile(info, source)
print(json.dumps({"archive": str(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "files": len(files)}))
