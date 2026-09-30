"""Qualify the production wrapper with the fleet's exported PM runtime command.

Read-only access to installed Hermes source. Only a new disposable remote home,
wrapper directory and process are written; the existing owner is never stopped.
"""
import base64
import argparse
import json
import shlex
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REMOTE = r'''
import json, os, secrets, signal, socket, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
payload = json.load(sys.stdin)
files = payload["files"]
installed_home = Path(payload["hermesHome"]).expanduser()
launcher = Path(payload["launcher"]).expanduser()
source = Path(payload["source"]).expanduser()
root = Path(tempfile.mkdtemp(prefix="agent-interface-dashboard-qualification-"))
home = root / "home"; home.mkdir()
(home / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
wrapper = root / "wrapper"; wrapper.mkdir()
for name, content in files.items():
    import base64
    (wrapper / name).write_bytes(base64.b64decode(content))
(wrapper / "agent_interface_dashboard.py").symlink_to(wrapper / "dashboard.py")
runtime = json.loads(subprocess.check_output([str(launcher), "--print-runtime-command"]))
assert runtime[1:3] == ["-I", "-c"]
assert "runpy.run_module('hermes_cli.main'" in runtime[3]
runtime[3] = runtime[3].replace("runpy.run_module('hermes_cli.main'", "os.environ['HERMES_HOME']=" + repr(str(home)) + ";os.environ['TMPDIR']=" + repr(str(home / 'cache/scratch')) + ";sys.path.insert(0," + repr(str(wrapper)) + ");runpy.run_module('agent_interface_dashboard'")
with socket.socket() as reserved:
    reserved.bind(("127.0.0.1", 0)); port = reserved.getsockname()[1]
secret = secrets.token_urlsafe(32)
env = dict(os.environ, HERMES_HOME=str(installed_home), HERMES_AGENT_INTERFACE_TOKEN=secret, HERMES_SKIP_UPDATE_CHECK="1",
    HERMES_DISABLE_LAZY_INSTALLS="1", HERMES_RUNTIME_DIR=str(installed_home / "tools"))
env.pop("HERMES_SERVE_HEADLESS", None)
env.pop("HERMES_DASHBOARD_SESSION_TOKEN", None)
log_path = root / "dashboard.log"
with log_path.open("wb") as log:
    process = subprocess.Popen(runtime + ["dashboard", "--host", "127.0.0.1", "--port", str(port), "--no-open"], env=env, cwd=root, stdout=log, stderr=log, start_new_session=True)
    try:
        def request(path, method="GET", authenticated=False):
            headers = {"Authorization": "Bearer " + secret} if authenticated else {}
            return urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:" + str(port) + path, method=method, headers=headers), timeout=2)
        for attempt in range(90):
            if process.poll() is not None: raise AssertionError("Wrapper exited before ready; inspect private log " + str(log_path))
            try:
                with request("/api/agent-interface/service/profiles", authenticated=True) as response:
                    profiles = json.load(response)["profiles"]
                break
            except (OSError, urllib.error.URLError): time.sleep(0.5)
        else: raise AssertionError("Wrapper readiness timed out; inspect private log " + str(log_path))
        assert Path(next(row for row in profiles if row["name"] == "default")["path"]).resolve() == home.resolve()
        with request("/api/agent-interface/service-ticket", "POST", True) as response:
            assert response.headers["Cache-Control"] == "no-store"
            assert len(json.load(response)["ticket"]) == 43
        with request("/") as response:
            html = response.read().decode()
            assert response.status == 200 and "<html" in html.lower() and "<script" in html.lower()
        revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"]).decode().strip()
        import hashlib
        patch = hashlib.sha256(subprocess.check_output(["git", "-C", str(source), "diff", "HEAD"])).hexdigest()
        result = {"revision": revision, "trackedPatchSha256": patch, "checks": {"managed_runtime_bootstrap": True, "original_dashboard_cli_startup": True, "fresh_home_native_profiles": True, "private_service_ticket": True, "dashboard_html_preserved": True}}
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)
        assert process.poll() is not None
result["checks"]["only_probe_process_stopped"] = True
print(json.dumps(result))
'''

files = {name: base64.b64encode((REPO / "src/hermes" / name).read_bytes()).decode() for name in ("dashboard.py", "extension.py", "service_auth.py")}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--ssh-host", required=True)
parser.add_argument("--launcher", default="~/.local/bin/hermes")
parser.add_argument("--hermes-home", default="~/.hermes")
parser.add_argument("--source", default="~/.hermes/hermes-agent")
args = parser.parse_args()
payload = {"files": files, "hermesHome": args.hermes_home, "launcher": args.launcher, "source": args.source}
result = subprocess.run(["ssh", args.ssh_host, "python3 -c " + shlex.quote(REMOTE)], input=json.dumps(payload), text=True, capture_output=True)
if result.returncode:
    raise SystemExit(result.stderr)
evidence = json.loads(result.stdout)
(REPO / "docs/evidence/hermes-dashboard-managed-probe.json").write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps(evidence, indent=2))
