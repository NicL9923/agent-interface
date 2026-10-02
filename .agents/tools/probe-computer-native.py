#!/usr/bin/env python3
"""Run the shared computer native probe in a disposable remote home."""
import argparse
import base64
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--host", default="home-hermes-vps")
parser.add_argument("--python", required=True, help="Absolute path to a previously qualified disposable native interpreter")
parser.add_argument("--real-resource-home", help="Explicitly authorized idle shared resource for real browser acceptance")
parser.add_argument("--cdp-url", help="Fixed loopback CDP origin for that real resource")
args = parser.parse_args()
if not Path(args.python).is_absolute():
    parser.error("The qualified native interpreter must have an absolute path")
if bool(args.real_resource_home) != bool(args.cdp_url):
    parser.error("Real acceptance requires both --real-resource-home and --cdp-url")
if args.real_resource_home and not Path(args.real_resource_home).is_absolute():
    parser.error("The selected real resource must have an absolute owner home")
root = Path(__file__).resolve().parents[2]
probe = "scripts/spike/computer_acceptance.py" if args.real_resource_home else "scripts/spike/computer_probe.py"
payload = {"python": args.python, "probe": probe, "resource": args.real_resource_home, "endpoint": args.cdp_url,
    "files": {name: base64.b64encode((root / name).read_bytes()).decode() for name in ("src/hermes/computer.py", probe)}}
remote = '''import base64,json,os,pathlib,subprocess,tempfile
payload=json.loads(%r)
stage=pathlib.Path(tempfile.mkdtemp(prefix="agent-interface-computer-probe-"))
stage.chmod(0o700)
for name,data in payload["files"].items():
    path=stage/name
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(base64.b64decode(data))
home=stage/"home"
home.mkdir(mode=0o700)
(home/".agent-interface-isolated").write_text("agent-interface-disposable-spike")
(home/"config.yaml").write_text("plugins:\\n  enabled: []\\n")
env={k:v for k,v in os.environ.items() if k in ("PATH","HOME","LANG","LC_ALL")}
env.update(HERMES_HOME=str(home),HERMES_DISABLE_LAZY_INSTALLS="1",PYTHONDONTWRITEBYTECODE="1")
if payload["resource"]:
    env.update(HERMES_COMPUTER_ACCEPTANCE_HOME=payload["resource"],HERMES_COMPUTER_ACCEPTANCE_CDP_URL=payload["endpoint"])
print("Disposable probe stage:",stage,flush=True)
result=subprocess.run([payload["python"],str(stage/payload["probe"])],env=env,cwd=stage)
raise SystemExit(result.returncode)
''' % json.dumps(payload)
result = subprocess.run(["ssh", args.host, "python3", "-"], input=remote, text=True)
raise SystemExit(result.returncode)
