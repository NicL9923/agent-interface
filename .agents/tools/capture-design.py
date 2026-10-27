#!/usr/bin/env python3
"""Run the shared design capture in an existing Playwright CLI session."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlparse

repo = Path(__file__).resolve().parents[2]
screens = sorted(path.name.removesuffix("-design.json") for path in (repo / ".agents" / "fixtures").glob("*-design.json"))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("screen", choices=screens)
parser.add_argument("stage", choices=["before", "after"])
parser.add_argument("--root", type=Path, required=True, help="Existing task artifact directory")
parser.add_argument("--origin", required=True, help="Loopback fixture origin")
parser.add_argument("--session", required=True, help="Existing, task-owned Playwright CLI session")
parser.add_argument("--fixture", type=Path)
parser.add_argument("--report", help="Report basename, without an extension")
args = parser.parse_args()
origin = urlparse(args.origin)
if origin.scheme != "http" or origin.hostname not in {"127.0.0.1", "localhost"} or origin.path not in {"", "/"} or origin.query or origin.fragment or origin.username is not None or origin.password is not None:
    parser.error("Origin must name an HTTP loopback fixture without a path, query or credentials")
if not args.root.is_absolute() or not args.root.is_dir():
    parser.error("Root must be an existing absolute artifact directory")
name = args.report or f"{args.screen}-{args.stage}"
if Path(name).name != name or name in {".", ".."}:
    parser.error("Report must be a basename")
fixture = args.fixture or repo / ".agents" / "fixtures" / f"{args.screen}-design.json"
payload = json.loads(fixture.read_text())
if not isinstance(payload, dict) or not isinstance(payload.get("bots"), list):
    parser.error("The fixture must be an object with a bots array")
if "conversation" in payload:
    conversation = payload["conversation"]
    for field in ("messages", "approvals", "attention", "files"):
        if not isinstance(conversation, dict) or not isinstance(conversation.get(field), list):
            parser.error(f"The fixture conversation must include a {field} array")
options = {"outputDir": str(args.root / args.stage), "prefix": "web", "screen": args.screen, "stage": args.stage,
           "fixture": payload}
source = Path(__file__).with_suffix(".js").read_text()
wrapper = args.root / f"{name}-capture.js"
wrapper.write_text(f"async page => {{ await page.goto({json.dumps(args.origin)}); return ({source})(page, {json.dumps(options)}); }}")
report = args.root / f"{name}.json"
installed = shutil.which("playwright-cli")
command = [installed] if installed else ["npm", "exec", "--yes", "--package=@playwright/cli@0.1.22", "--", "playwright-cli"]
temporary = None
try:
    with tempfile.NamedTemporaryFile(mode="w", dir=args.root, prefix=f".{name}-", suffix=".json", delete=False) as output:
        temporary = Path(output.name)
        subprocess.run([*command, f"-s={args.session}", "--raw", "run-code", f"--filename={wrapper}"],
                       cwd=repo, stdout=output, check=True)
    result = json.loads(temporary.read_text())
    summary = {"report": str(report), "screenshots": len(result["paths"]),
               "overflow": [item["name"] for item in result["geometry"] if item["overflow"]]}
    temporary.replace(report)
    (args.root / f"{name}.failed.log").unlink(missing_ok=True)
except Exception as error:
    if temporary is not None and temporary.exists():
        failed = args.root / f"{name}.failed.log"
        temporary.replace(failed)
        raise RuntimeError(f"Capture failed. The last good report is unchanged; output is in {failed}") from error
    raise
print(json.dumps(summary))
