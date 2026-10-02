#!/usr/bin/env python3
"""Fetch and sanitize one completed staged qualification's native receipts."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("name", help="Staged release name used for qualification")
parser.add_argument("destination", type=Path)
args = parser.parse_args()
if Path(args.name).name != args.name:
    parser.error("Use a release name, not a path")
root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release_app", Path(__file__).with_name("release-app.py"))
release_app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_app)
manifest = release_app.load_manifest(args.name)
result = json.loads((release_app.MANIFESTS / (args.name + "-qualification.json")).read_text())
if result.get("qualificationComplete") is not True:
    parser.error("A successful completed qualification is required")
receipt = Path(result["receipt"])
if receipt.name != "qualification.json" or receipt.parent.parent != Path(manifest["operationDir"]):
    parser.error("Qualification receipt does not belong to this release operation")
program = r'''
stage = Path(PAYLOAD["stage"])
assert json.loads((stage / "qualification.json").read_text())["checks"] == {"realIntegration": True, "hostRegressions": True}
assert (stage / ".agent-interface-isolated").read_text() == "agent-interface-disposable-spike"
matches = list(stage.glob("pm-home/cache/scratch/agent-interface-spike-*/evidence"))
assert len(matches) == 1 and (matches[0] / "app-probe.json").is_file()
finish({"evidence": str(matches[0])})
'''
found = release_app.remote(manifest["host"], program, {"stage": str(receipt.parent)})
os.umask(0o077)
parent = root / ".private/qualification-archives" / args.name / receipt.parent.name
parent.mkdir(parents=True, exist_ok=True)
# Always fetch into a fresh directory. Optional receipts from an earlier run
# must never survive a later fetch and become mixed qualification evidence.
raw = Path(tempfile.mkdtemp(prefix="fetch-", dir=parent))
subprocess.run(["scp", "-q", "-r", manifest["host"] + ":" + shlex.quote(found["evidence"]) + "/.", str(raw)], check=True)
subprocess.run([sys.executable, str(Path(__file__).with_name("archive-spike-evidence.py")), str(raw), str(args.destination),
                "--isolated-host-home", str(receipt.parent)], check=True)
