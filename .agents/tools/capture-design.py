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
parser.add_argument("--work-case", choices=["all", "clear-confirmation", "tasks", "triggers"], default="all", help="Capture only a scoped Work recheck")
parser.add_argument("--task-gate", choices=["a", "b"], help="W2 AFTER: a for board/actions, b for task editors")
parser.add_argument("--report", help="Report basename, without an extension")
parser.add_argument("--context-tag", choices=["wildbots-design-work-triggers-after-w2-capture", "wildbots-design-work-triggers-after-w3-capture", "wildbots-design-work-triggers-after-w4-capture"], help="Explicit owned W3 AFTER context")
args = parser.parse_args()
if args.context_tag and (args.screen != "work" or args.stage != "after" or args.work_case != "triggers"):
    parser.error("--context-tag requires work after --work-case triggers")
if args.work_case == "clear-confirmation" and (args.screen != "work" or args.stage != "after"):
    parser.error("A scoped Work recheck requires work after")
if args.work_case == "tasks" and args.screen != "work":
    parser.error("The task capture requires work")
if args.work_case == "triggers" and args.screen != "work":
    parser.error("The trigger capture requires work")
if args.task_gate and (args.screen != "work" or args.work_case != "tasks" or args.stage != "after"):
    parser.error("--task-gate requires work after --work-case tasks")
if args.work_case == "tasks" and args.stage == "after" and not args.task_gate:
    parser.error("Work tasks AFTER requires an explicit --task-gate a or b")
origin = urlparse(args.origin)
if origin.scheme != "http" or origin.hostname not in {"127.0.0.1", "localhost"} or origin.path not in {"", "/"} or origin.query or origin.fragment or origin.username is not None or origin.password is not None:
    parser.error("Origin must name an HTTP loopback fixture without a path, query or credentials")
if not args.root.is_absolute() or not args.root.is_dir():
    parser.error("Root must be an existing absolute artifact directory")
name = args.report or (f"work-triggers-{args.stage}" if args.work_case == "triggers" else f"work-tasks-{args.task_gate}-after" if args.task_gate else f"work-tasks-{args.stage}" if args.work_case == "tasks" else f"{args.screen}-{args.stage}")
if args.work_case == "triggers" and not name.startswith("work-triggers-"):
    parser.error("Trigger reports must start with work-triggers-")
if args.work_case == "tasks" and not name.startswith("work-tasks-"):
    parser.error("Task reports must start with work-tasks- to preserve W1 reports")
if args.task_gate and not name.startswith(f"work-tasks-{args.task_gate}-"):
    parser.error("Task AFTER reports must name their selected gate")
if Path(name).name != name or name in {".", ".."}:
    parser.error("Report must be a basename")
fixture = args.fixture or repo / ".agents" / "fixtures" / ("work-triggers.json" if args.work_case == "triggers" else "work-tasks.json" if args.work_case == "tasks" else f"{args.screen}-design.json")
payload = json.loads(fixture.read_text())
if not isinstance(payload, dict) or not isinstance(payload.get("bots"), list):
    parser.error("The fixture must be an object with a bots array")
gate = payload.get("workFixture", {}).get("gate")
if args.work_case == "tasks" and gate != "W2-tasks":
    parser.error("The task capture requires the W2-tasks fixture")
if args.work_case == "triggers" and gate != "W3-triggers":
    parser.error("The trigger capture requires the W3-triggers fixture")
if args.work_case not in {"tasks", "triggers"} and gate is not None:
    parser.error("A gated fixture cannot be used for this capture")
if "conversation" in payload:
    conversation = payload["conversation"]
    for field in ("messages", "approvals", "attention", "files"):
        if not isinstance(conversation, dict) or not isinstance(conversation.get(field), list):
            parser.error(f"The fixture conversation must include a {field} array")
isolated_output = args.task_gate or args.work_case == "triggers"
output_dir = args.root / name if isolated_output else args.root / args.stage
if isolated_output and (output_dir.exists() or (args.root / f"{name}.json").exists() or (args.root / f"{name}-capture.js").exists() or (args.root / f"{name}.failed.log").exists()):
    parser.error("Trigger capture output already exists; choose a new --report basename" if args.work_case == "triggers" else "Task AFTER output already exists; choose a new --report basename")
if isolated_output:
    output_dir.mkdir()
options = {"outputDir": str(output_dir), "prefix": "web", "screen": args.screen, "stage": args.stage,
           "fixture": payload, "workCase": args.work_case, "taskGate": args.task_gate}
if args.context_tag:
    options["contextTag"] = args.context_tag
source = Path(__file__).with_suffix(".js").read_text()
wrapper = args.root / f"{name}-capture.js"
options_source = json.dumps(options)
if args.work_case == "triggers":
    trigger_source = Path(__file__).with_name("capture-work-triggers-after.js" if args.stage == "after" else "capture-work-triggers.js").read_text()
    options_source = "{..." + options_source + ", captureTriggers: (" + trigger_source + ")}"
wrapper.write_text(f"async page => {{ await page.goto({json.dumps(args.origin)}); return ({source})(page, {options_source}); }}")
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
