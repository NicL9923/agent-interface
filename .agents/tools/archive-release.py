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
top = {"package.json", "package-lock.json", "tsconfig.json", ".node-version", ".env.example"}
dirs = ("src/", "scripts/", "tests/", "public/", ".agents/tools/")
# The host build type-checks everything tsconfig.json includes, so each of those paths ships
# without editing this list. A directory added there and left out here broke the host build twice.
for entry in json.loads((root / "tsconfig.json").read_text())["include"]:
    if (root / entry).is_dir():
        dirs += (entry.rstrip("/") + "/",)
    else:
        top.add(entry)
# Every top-level HTML file is a Vite entry, so a new entry ships without editing this list.
files = sorted({name for name in names if name in top or ("/" not in name and name.endswith(".html")) or name.startswith(dirs)})
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
