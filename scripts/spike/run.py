"""Reproduce the real Hermes spike in a new disposable home. Requires Python 3.14/git.

python3 scripts/spike/run.py
All provider output is deterministic. No real credentials or installed Hermes are used.
"""
import json
import argparse
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import hashlib
import importlib.util
import re
import signal
import shutil
import urllib.request
from pathlib import Path
from guard import verify_target

REVISION = "b9cb268deffc97946ec11645aa622a7353dd0591"
QUALIFIED_REVISIONS = [REVISION, "d23cc6b06455b8551fb6f61d3cad040a0e82f5b6"]
REPO = Path(__file__).resolve().parents[2]


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait()


def native_gateway_command(source, python):
    """Production's guarded gateway entry, loading the guard from the add-on under test."""
    path = REPO / "src/hermes/gateway_guard.py"
    spec = importlib.util.spec_from_file_location("spike_gateway_guard", path)
    guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
    return guard.native_command(source, python, [], guard=path)


def process_start_time(pid):
    """Linux start time in clock ticks, the PID-reuse guard Hermes records in gateway.pid."""
    try:
        return int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def stop_home_gateway(home):
    """Stop a gateway still owning this disposable home, including one Hermes started itself.

    Only the exact process Hermes recorded as this home's gateway is signalled. The
    suite runs on the Linux qualification host; elsewhere this finds nothing.
    """
    try:
        record = json.loads((home / "gateway.pid").read_text())
    except (OSError, ValueError):
        return None
    pid, started = record.get("pid"), record.get("start_time")
    if (not isinstance(pid, int) or record.get("kind") != "hermes-gateway" or started is None
            or Path(str(record.get("hermes_home") or "/")).resolve() != home.resolve()):
        return None
    def recorded():
        return process_start_time(pid) == started
    if not recorded():
        return None
    os.kill(pid, signal.SIGTERM)
    for _ in range(150):
        if not recorded():
            return pid
        time.sleep(0.1)
    os.kill(pid, signal.SIGKILL)
    return pid


def run_computer_probes(python, env):
    """Keep native coordination coverage mandatory; record optional Chrome coverage."""
    subprocess.run([str(python), str(REPO / "scripts/spike/computer_probe.py")], cwd=REPO, env=env, check=True)
    browser = (env.get("HERMES_COMPUTER_PROBE_BROWSER") or env.get("AGENT_BROWSER_EXECUTABLE_PATH")
               or next((path for name in ("google-chrome", "chromium", "chromium-browser")
                        if (path := shutil.which(name, path=env.get("PATH")))), None))
    evidence = Path(env["HERMES_SPIKE_EVIDENCE_DIR"]) / "hermes-computer-local-network-probe.json"
    if not browser or not os.access(browser, os.X_OK):
        evidence.write_text(json.dumps({"status": "skipped", "checks": {},
            "reason": "No executable Chrome available; set HERMES_COMPUTER_PROBE_BROWSER",
            "revision": env["HERMES_SPIKE_REVISION"]}, indent=2) + "\n")
        return
    # The browser probe writes synthetic profile configs. Never share the home
    # used by the running fixture gateways and other qualification probes.
    home = Path(env["HERMES_HOME"]) / "local-network-probe"
    home.mkdir(mode=0o700)
    (home / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
    probe_env = {**env, "HOME": str(home), "HERMES_HOME": str(home),
                 "HERMES_COMPUTER_PROBE_BROWSER": browser}
    subprocess.run([str(python), str(REPO / "scripts/spike/computer_local_network_probe.py")],
        cwd=REPO, env=probe_env, check=True)
    evidence.write_bytes((home / "computer-local-network-probe.json").read_bytes())


def main():
    if sys.version_info[:2] != (3, 14):
        raise SystemExit("The pinned Hermes revision requires Python 3.14 for its core dependency markers.")
    parser = argparse.ArgumentParser()
    parser.add_argument("--reuse", type=Path, help="Reuse only an existing marked disposable spike dependency environment")
    parser.add_argument("--app-only", action="store_true", help="Rerun only authenticated app acceptance against a fresh isolated gateway")
    parser.add_argument("--revision", default=REVISION)
    parser.add_argument("--qualification", action="store_true", help="Probe an exact staged candidate in a marked disposable home; never changes production qualification")
    parser.add_argument("--source", type=Path, help="Use a separate detached local qualification checkout without changing it")
    parser.add_argument("--python", type=Path, help="Reuse an existing constrained dependency interpreter with --source; source imports are explicitly isolated")
    parser.add_argument("--source-patch-sha256", help="Required exact git diff HEAD hash for a locally repaired qualification checkout")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise SystemExit("Qualification requires an exact Git revision.")
    if args.revision not in QUALIFIED_REVISIONS and not args.qualification:
        raise SystemExit("Unknown source revision requires explicit isolated --qualification.")
    if args.qualification and (not args.source or not args.python or args.reuse or args.app_only):
        raise SystemExit("Full candidate qualification requires a separate --source and --python; never app-only or reuse.")
    root = args.reuse.resolve() if args.reuse else Path(tempfile.mkdtemp(prefix="agent-interface-spike-"))
    source, home, venv, workspace = (root / name for name in ("source", "home", "venv", "workspace"))
    if args.source:
        if args.reuse: raise SystemExit("Use either --source or --reuse, never both")
        source = args.source.resolve()
    if args.python and not args.source: raise SystemExit("--python requires a separate --source checkout")
    if args.reuse and (not (home / ".agent-interface-isolated").is_file() or (home / ".agent-interface-isolated").read_text() != "agent-interface-disposable-spike"):
        raise SystemExit("Reuse requires an already marked disposable home")
    if args.reuse:
        home = root / ("home-run-" + secrets.token_hex(4))
        workspace = root / ("workspace-run-" + secrets.token_hex(4))
    home.mkdir(mode=0o700, exist_ok=True); workspace.mkdir(exist_ok=True)
    (home / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
    # Preserve the venv launcher symlink; resolving it selects the base interpreter and loses dependencies.
    python = args.python.absolute() if args.python else venv / "bin" / "python"
    if not args.reuse:
        if not args.source:
            subprocess.run(["git", "clone", "--filter=blob:none", "https://github.com/NousResearch/hermes-agent.git", str(source)], check=True)
            subprocess.run(["git", "-C", str(source), "checkout", "--detach", args.revision], check=True)
        if not args.python:
            subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
            subprocess.run([str(python), "-m", "pip", "install", "--constraint", str(REPO / "scripts/spike/requirements.lock.txt"), "-e", str(source)], check=True)
    if subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() != args.revision:
        raise SystemExit("Unexpected source revision")
    patch = subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", str(source), "diff", "HEAD"])
    patch_hash = hashlib.sha256(patch).hexdigest() if patch else None
    if patch_hash != args.source_patch_sha256:
        raise SystemExit("Qualification checkout repair hash differs from --source-patch-sha256")
    if (home / ".agent-interface-isolated").read_text() != "agent-interface-disposable-spike":
        raise SystemExit("Not an isolated spike root")
    provider_port, gateway_port = port(), port()
    token = secrets.token_urlsafe(32)
    config = f"""model:
  default: spike-model
  provider: spike-fixture
  base_url: http://127.0.0.1:{provider_port}/v1
providers:
  spike-fixture:
    base_url: http://127.0.0.1:{provider_port}/v1
    api_key: isolated-fixture
    models: [spike-model]
terminal:
  backend: local
  cwd: {workspace}
agent:
  max_turns: 5
approvals:
  mode: manual
"""
    (home / "config.yaml").write_text(config)
    (home / ".env").write_text("OPENAI_API_KEY=isolated-fixture\n")
    (home / ".env").chmod(0o600)
    base_environment = {key: os.environ[key] for key in ("PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "AGENT_BROWSER_EXECUTABLE_PATH", "HERMES_COMPUTER_PROBE_BROWSER") if key in os.environ}
    env = {**base_environment, "HERMES_HOME": str(home), "HERMES_SPIKE_PROVIDER_PORT": str(provider_port), "HERMES_SPIKE_PROVIDER_LOG": str(root / "provider-executions.jsonl"), "HERMES_SPIKE_URL": f"http://127.0.0.1:{gateway_port}", "HERMES_SPIKE_TOKEN": token, "HERMES_DASHBOARD_SESSION_TOKEN": token, "HERMES_SERVE_HEADLESS": "1", "HERMES_SKIP_UPDATE_CHECK": "1"}
    evidence_root = root / "evidence"
    evidence_root.mkdir(exist_ok=True)
    env["HERMES_SPIKE_EVIDENCE_DIR"] = str(evidence_root)
    env["PYTHONPATH"] = str(source)
    env["HERMES_SPIKE_REVISION"] = args.revision
    env["HERMES_SPIKE_PATCH_SHA256"] = patch_hash or ""
    if args.qualification:
        env["HERMES_AGENT_INTERFACE_QUALIFICATION_REVISION"] = args.revision
    else:
        env.pop("HERMES_AGENT_INTERFACE_QUALIFICATION_REVISION", None)
    env.pop("HERMES_AGENT_INTERFACE_QUALIFICATION_FILE", None)
    env["HERMES_AGENT_INTERFACE_TOKEN"] = token
    env["HERMES_AGENT_INTERFACE_MAINTENANCE_FILE"] = str(home / "runtime" / "agent-interface-maintenance.json")
    # Keep production API secrets out of this process and every tool it can spawn.
    for key in list(env):
        if any(word in key for word in ("API_KEY", "ACCESS_TOKEN", "SECRET")) and key != "HERMES_SPIKE_TOKEN":
            env.pop(key, None)
    access = root / "access.json"
    access.write_text(json.dumps({"url": env["HERMES_SPIKE_URL"], "token": token, "isolatedHome": str(home), "marker": "agent-interface-disposable-spike", "provider": "deterministic fixture"}))
    access.chmod(0o600)
    provider = subprocess.Popen([str(python), str(REPO / "scripts/spike/provider.py")], env=env, stdout=(root / "provider.log").open("w"), stderr=subprocess.STDOUT)
    gateway = None
    def start(extension=False):
        command = [str(python), str(REPO / "src/hermes/extension.py"), "--port", str(gateway_port)] if extension else [str(python), "-c", "from hermes_cli.web_server import start_server; start_server(host=\"127.0.0.1\",port=" + str(gateway_port) + ",open_browser=False,headless=True,isolated=True)"]
        process = subprocess.Popen(command, env=env, cwd=source, stdout=(root / ("extension.log" if extension else "native.log")).open("w"), stderr=subprocess.STDOUT)
        for _ in range(300):
            if process.poll() is not None:
                raise RuntimeError("Isolated Hermes exited; inspect the private startup log.")
            try:
                request = urllib.request.Request(env["HERMES_SPIKE_URL"] + "/api/profiles", headers={"X-Hermes-Session-Token": token})
                urllib.request.urlopen(request, timeout=1).close()
                verify_target(home, env["HERMES_SPIKE_URL"], token)
                return process
            except Exception:
                time.sleep(0.1)
        stop(process); raise RuntimeError("Isolated Hermes startup timed out.")
    native_gateway = None
    def start_native_gateway():
        # Production runs the guarded native gateway beside the dashboard. It fires and
        # delivers routines, so qualification must exercise that path, not the
        # unguarded idle-exit gateway Hermes starts for itself when none is running.
        process = subprocess.Popen(native_gateway_command(source, python), env=env, cwd=home,
                                   stdout=(root / "native-gateway.log").open("w"), stderr=subprocess.STDOUT)
        for _ in range(1200):
            if process.poll() is not None:
                raise RuntimeError("Isolated native gateway exited; inspect its private startup log.")
            try:
                state = json.loads((home / "gateway_state.json").read_text())
            except (OSError, ValueError):
                state = {}
            if state.get("pid") == process.pid and state.get("gateway_state") == "running":
                return process
            time.sleep(0.1)
        stop(process); raise RuntimeError("Isolated native gateway startup timed out.")
    try:
        if args.app_only:
            native_gateway = start_native_gateway()
            gateway = start(extension=True)
        else:
            gateway = start()
            subprocess.run([str(python), str(REPO / "scripts/spike/probe.py")], cwd=REPO, env=env, check=True)
            stop(gateway)
            native_gateway = start_native_gateway()
            gateway = start(extension=True)
            subprocess.run([str(python), str(REPO / "scripts/spike/extension_probe.py"), "--pid", str(gateway.pid)], cwd=REPO, env=env, check=True)
            # The probe deliberately kills the executor while work is active. Restart, never replay.
            gateway.wait(timeout=15)
            gateway = start(extension=True)
            subprocess.run([str(python), str(REPO / "scripts/spike/extension_probe.py"), "--verify-restart"], cwd=REPO, env=env, check=True)
            subprocess.run([str(python), str(REPO / "scripts/spike/routine_probe.py")], cwd=REPO, env=env, check=True)
            subprocess.run([str(python), str(REPO / "scripts/spike/experience_probe.py")], cwd=REPO, env=env, check=True)
            subprocess.run([str(python), str(REPO / "scripts/spike/integrations_probe.py")], cwd=REPO, env=env, check=True)
            subprocess.run([str(python), str(REPO / "scripts/spike/service_probe.py")], cwd=REPO, env=env, check=True)
            run_computer_probes(python, env)
            subprocess.run([str(python), str(REPO / "scripts/spike/maintenance_guard_probe.py"), "--source", str(source)], cwd=REPO, env=env, check=True)
        control = root / "app-control"
        control.mkdir(exist_ok=True)
        (control / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
        for filename in ("restart.request.json", "restart.complete.json"):
            (control / filename).unlink(missing_ok=True)
        app_env = {**env, "HERMES_SPIKE_ACCESS": str(access), "HERMES_SPIKE_CONTROL_DIR": str(control)}
        app = subprocess.Popen(["node", "--import", "tsx", "scripts/spike/app-probe.mjs"], cwd=REPO, env=app_env)
        handled = None
        while app.poll() is None:
            request = control / "restart.request.json"
            if request.exists():
                message = json.loads(request.read_text())
                if message.get("nonce") != handled:
                    gateway.kill(); gateway.wait(timeout=15)
                    gateway = start(extension=True)
                    handled = message["nonce"]
                    acknowledgement = control / "restart.complete.tmp"
                    acknowledgement.write_text(json.dumps({"nonce": handled}))
                    acknowledgement.replace(control / "restart.complete.json")
            time.sleep(0.1)
        if app.returncode:
            raise RuntimeError("Real application probe failed")
        evidence = evidence_root / "hermes-environment.json"
        # Native PM generations activate libraries without installing pip into
        # their base interpreter. Inventory the actual activated distributions.
        freeze = subprocess.check_output([str(python), "-c", "import importlib.metadata as m; print('\\n'.join(sorted({str(d.metadata.get('Name', 'unknown')) + '==' + d.version for d in m.distributions()})))"], text=True)
        evidence.write_text(json.dumps({"revision": args.revision, "tracked_patch_sha256": patch_hash, "python": sys.version.split()[0], "dependencies": [line for line in freeze.splitlines() if not line.startswith(("#", "-e"))], "provider": "deterministic fixture", "production_access": False}, indent=2) + "\n")
        print("Native and add-on spike passed. Evidence: " + str(evidence_root) + ". Disposable private logs: " + str(root))
    finally:
        if gateway: stop(gateway)
        if native_gateway: stop(native_gateway)
        leaked = stop_home_gateway(home)
        if leaked:
            print(f"Stopped gateway {leaked} that outlived the isolated suite.", file=sys.stderr)
        stop(provider)


if __name__ == "__main__":
    main()
