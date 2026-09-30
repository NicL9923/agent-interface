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
import urllib.request
from pathlib import Path
from guard import verify_target

REVISION = "b9cb268deffc97946ec11645aa622a7353dd0591"
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


def main():
    if sys.version_info[:2] != (3, 14):
        raise SystemExit("The pinned Hermes revision requires Python 3.14 for its core dependency markers.")
    parser = argparse.ArgumentParser()
    parser.add_argument("--reuse", type=Path, help="Reuse only an existing marked disposable spike dependency environment")
    parser.add_argument("--app-only", action="store_true", help="Rerun only authenticated app acceptance against a fresh isolated gateway")
    args = parser.parse_args()
    root = args.reuse.resolve() if args.reuse else Path(tempfile.mkdtemp(prefix="agent-interface-spike-"))
    source, home, venv, workspace = (root / name for name in ("source", "home", "venv", "workspace"))
    if args.reuse and (not (home / ".agent-interface-isolated").is_file() or (home / ".agent-interface-isolated").read_text() != "agent-interface-disposable-spike"):
        raise SystemExit("Reuse requires an already marked disposable home")
    if args.reuse:
        home = root / ("home-run-" + secrets.token_hex(4))
        workspace = root / ("workspace-run-" + secrets.token_hex(4))
    home.mkdir(mode=0o700, exist_ok=True); workspace.mkdir(exist_ok=True)
    (home / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
    python = venv / "bin" / "python"
    if not args.reuse:
        subprocess.run(["git", "clone", "--filter=blob:none", "https://github.com/NousResearch/hermes-agent.git", str(source)], check=True)
        subprocess.run(["git", "-C", str(source), "checkout", "--detach", REVISION], check=True)
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        subprocess.run([str(python), "-m", "pip", "install", "--constraint", str(REPO / "scripts/spike/requirements.lock.txt"), "-e", str(source)], check=True)
    if subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() != REVISION:
        raise SystemExit("Unexpected source revision")
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
    env = {**os.environ, "HERMES_HOME": str(home), "HERMES_SPIKE_PROVIDER_PORT": str(provider_port), "HERMES_SPIKE_PROVIDER_LOG": str(root / "provider-executions.jsonl"), "HERMES_SPIKE_URL": f"http://127.0.0.1:{gateway_port}", "HERMES_SPIKE_TOKEN": token, "HERMES_DASHBOARD_SESSION_TOKEN": token, "HERMES_SERVE_HEADLESS": "1", "HERMES_SKIP_UPDATE_CHECK": "1"}
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
    try:
        if args.app_only:
            gateway = start(extension=True)
        else:
            gateway = start()
            subprocess.run([str(python), str(REPO / "scripts/spike/probe.py")], cwd=REPO, env=env, check=True)
            stop(gateway)
            gateway = start(extension=True)
            subprocess.run([str(python), str(REPO / "scripts/spike/extension_probe.py"), "--pid", str(gateway.pid)], cwd=REPO, env=env, check=True)
            # The probe deliberately kills the executor while work is active. Restart, never replay.
            gateway.wait(timeout=15)
            gateway = start(extension=True)
            subprocess.run([str(python), str(REPO / "scripts/spike/extension_probe.py"), "--verify-restart"], cwd=REPO, env=env, check=True)
            subprocess.run([str(python), str(REPO / "scripts/spike/routine_probe.py")], cwd=REPO, env=env, check=True)
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
        evidence = REPO / "docs/evidence/hermes-environment.json"
        freeze = subprocess.check_output([str(python), "-m", "pip", "freeze"], text=True)
        evidence.write_text(json.dumps({"revision": REVISION, "python": sys.version.split()[0], "dependencies": [line for line in freeze.splitlines() if not line.startswith(("#", "-e"))], "provider": "deterministic fixture", "production_access": False}, indent=2) + "\n")
        print("Native and add-on spike passed. Evidence saved under docs/evidence. Disposable private logs: " + str(root))
    finally:
        if gateway: stop(gateway)
        stop(provider)


if __name__ == "__main__":
    main()
