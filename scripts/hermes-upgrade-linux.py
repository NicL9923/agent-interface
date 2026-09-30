"""Installer-owned Linux/systemd upgrade hooks; no client commands or paths.

Run with a private --config JSON and one fixed action. Cold recovery archives
contain credentials and must never be published. Rollback restores source and
managed dependency state, never old rotating OAuth grants from the home archive.
"""
import argparse
import base64
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import uuid

ACTIONS = ("regressions", "quiescence", "backup", "install", "verify", "rollback", "finish")


def private(path, directory=False):
    path = Path(path)
    info = path.lstat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077 or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise RuntimeError("Expected installer-owned private configuration or operation record")
    return path


def atomic(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(value, output); output.write("\n"); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, path)


def digest(path):
    hash = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""): hash.update(block)
    return hash.hexdigest()


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


# The subprocess runs in the current native PM-selected interpreter, activates
# its managed dependency generation, and reads credentials only from stdin.
NATIVE = r'''
import json,sys
from pathlib import Path
v=json.load(sys.stdin)
sys.path.insert(0,v['source'])
import hermes_bootstrap
if v['action']=='drain':
    from gateway.drain_control import write_drain_request
    print(json.dumps(write_drain_request(principal=v['principal'],suppress_notification=True,home=Path(v['home']))))
elif v['action']=='runtime':
    from pm.environments import project_python
    print(json.dumps({'python':str(project_python(Path(v['source'])))}))
elif v['action']=='rpc':
    import urllib.request
    from websockets.sync.client import connect
    req=urllib.request.Request(v['origin']+'/api/agent-interface/service-ticket',data=b'{}',headers={'Authorization':'Bearer '+v['key'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=10) as r: ticket=json.load(r)['ticket']
    with connect(v['origin'].replace('http://','ws://',1)+'/ws?ticket='+ticket,open_timeout=10,close_timeout=5) as ws:
        ws.send(json.dumps({'jsonrpc':'2.0','id':1,'method':'agent-interface.maintenance','params':{'action':v['method'],'operation_id':v['operation'],'service_key':v['key']}}))
        for _ in range(100):
            result=json.loads(ws.recv(timeout=15))
            if result.get('id')==1:
                if 'error' in result: raise RuntimeError('Native maintenance request rejected')
                print(json.dumps(result['result'])); break
        else: raise RuntimeError('Native maintenance result unavailable')
'''


class ActiveWork(RuntimeError):
    """A known active or unreadable aggregate must abort, never wait it away."""


class Platform:
    def __init__(self, config, environment=None):
        self.config = json.loads(private(config).read_text())
        self.env = dict(os.environ if environment is None else environment)
        for key in ("source", "hermesHome", "managedLauncher", "managedPython", "serviceEnvFile", "qualificationReceipt", "maintenanceFile", "stageRoot", "systemctl"):
            if not isinstance(self.config.get(key), str) or not Path(self.config[key]).is_absolute(): raise RuntimeError("Installer paths must be fixed and absolute: " + key)
        self.source, self.home = Path(self.config["source"]), Path(self.config["hermesHome"])
        if self.source.is_symlink() or self.home.is_symlink(): raise RuntimeError("Source and Hermes home must be real directories")
        if not self.source.is_relative_to(self.home): raise RuntimeError("Managed source must be inside the shared Hermes home")
        if Path(self.config["stageRoot"]).is_relative_to(self.home): raise RuntimeError("Staging and backups must be outside the live Hermes home")
        if self.config.get("dashboardOrigin") != "http://127.0.0.1:" + str(self.config.get("dashboardPort")): raise RuntimeError("Only the fixed direct loopback dashboard is supported")
        for name in ("dashboardUnit", "gatewayUnit", "appUnit"):
            if not re.fullmatch(r"[A-Za-z0-9_.@-]+\.service", self.config.get(name, "")): raise RuntimeError("Invalid fixed user service")
        if len({self.config[k] for k in ("dashboardUnit", "gatewayUnit", "appUnit")}) != 3: raise RuntimeError("User service names must be distinct")
        commands = self.config.get("regressionCommands", {})
        regression_python = self.config.get("regressionPython", self.config["managedPython"])
        if not isinstance(regression_python, str) or not Path(regression_python).is_absolute(): raise RuntimeError("Regression Python must be fixed")
        for name in ("sharedOAuth", "googleAuth"):
            self.command(commands.get(name))
            if Path(commands[name][0]).absolute() != Path(regression_python).absolute(): raise RuntimeError("Regression commands must use the fixed Python interpreter")
        self.command(self.config.get("googleVerificationCommand"))
        if not isinstance(self.config.get("discordConnections"), list) or len(self.config["discordConnections"]) != 2 or len(set(self.config["discordConnections"])) != 2:
            raise RuntimeError("Exactly two native Discord connection keys must be configured")
        self.operation = self.env.get("HERMES_UPGRADE_OPERATION_ID", "")
        uuid.UUID(self.operation)
        if self.env.get("HERMES_UPGRADE_SOURCE") != str(self.source): raise RuntimeError("Worker source differs from fixed host configuration")
        self.stage = Path(self.env["HERMES_UPGRADE_STAGE_HOME"])
        private(self.stage, directory=True)
        if self.stage.parent.resolve() != Path(self.config["stageRoot"]).resolve(): raise RuntimeError("Operation escaped the configured staging directory")
        self.target = Path(self.env["HERMES_UPGRADE_STAGE_SOURCE"])
        if self.target != self.stage / "source" or self.target.is_symlink(): raise RuntimeError("Unexpected staged source")
        self.backup_dir = Path(self.env["HERMES_UPGRADE_BACKUP_DIR"])
        if self.backup_dir != self.stage / "backup": raise RuntimeError("Unexpected backup directory")
        if self.env.get("HERMES_UPGRADE_RECEIPT") != str(self.stage / "qualification.json"): raise RuntimeError("Unexpected qualification receipt")
        self.record = self.stage / "platform.json"
        self.candidate = self.env.get("HERMES_UPGRADE_CANDIDATE", "")
        if not re.fullmatch(r"[a-f0-9]{40}", self.candidate): raise RuntimeError("The candidate must be an exact qualified commit")
        self.child_env = {"PATH": self.env.get("PATH", "/usr/bin:/bin"), "HOME": self.env["HOME"], "LANG": "C.UTF-8", "HERMES_HOME": str(self.home)}
        self.child_env.update({k: v for k, v in self.env.items() if k.startswith("HERMES_UPGRADE_")})
        if "HERMES_UPDATE_HANDOFF_PID" in self.env:
            self.child_env["HERMES_UPDATE_HANDOFF_PID"] = self.env["HERMES_UPDATE_HANDOFF_PID"]

    @staticmethod
    def command(argv):
        if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) and "\0" not in arg for arg in argv) or not Path(argv[0]).is_absolute(): raise RuntimeError("Expected a fixed installer-owned argv")

    def run(self, argv, capture=False, input=None, env=None, timeout=1800):
        return subprocess.run(argv, cwd=self.source, env=env or self.child_env, input=input, text=True,
            stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None, check=True, timeout=timeout).stdout

    def git(self, path, *args):
        return self.run(["git", "-C", str(path), *args], capture=True)

    def source_state(self, path=None):
        path = path or self.source
        return self.git(path, "rev-parse", "HEAD").strip(), hashlib.sha256(self.git(path, "diff", "HEAD", "--binary").encode()).hexdigest()

    def load(self):
        value = json.loads(private(self.record).read_text())
        if value.get("operationId") != self.operation: raise RuntimeError("Platform record belongs to another operation")
        return value

    def save(self, value):
        atomic(self.record, dict(value, operationId=self.operation))

    def unit(self, name):
        output = self.run([self.config["systemctl"], "--user", "show", self.config[name], "--property=ActiveState,SubState,MainPID,FragmentPath,ControlGroup"], capture=True, timeout=15)
        value = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        if value.get("ActiveState") != "active" or not value.get("MainPID", "").isdigit() or int(value["MainPID"]) < 1: raise RuntimeError("Required native/app user service is not active")
        fragment = Path(value["FragmentPath"])
        value["fragmentSha256"] = digest(fragment)
        return value

    def settings(self):
        paths = [self.home / "config.yaml", self.home / ".env", Path(self.config["serviceEnvFile"])]
        profiles = self.home / "profiles"
        if profiles.exists():
            for profile in sorted(profiles.iterdir()):
                if profile.is_symlink(): raise RuntimeError("Profile symlinks require installer review")
                if profile.is_dir(): paths.extend([profile / "config.yaml", profile / ".env"])
        plugins = self.home / "plugins"
        if plugins.exists(): paths.extend(path for path in plugins.rglob("*") if path.is_file() and path.suffix in (".py", ".yaml", ".toml"))
        return {str(path): digest(path) for path in paths if path.exists()}

    def store_python(self):
        command = json.loads(self.run([self.config["managedLauncher"], "--print-runtime-command", "--module", "hermes_cli.venv_sync", "--", "--project-root", str(self.source), "--check", "--json"], capture=True, timeout=30))
        if not isinstance(command, list) or not command or not isinstance(command[0], str) or not Path(command[0]).is_absolute(): raise RuntimeError("Native managed launcher did not export its interpreter")
        current = self.source_state()[0]
        if current == self.env.get("HERMES_UPGRADE_CURRENT"):
            if Path(command[0]).absolute() != Path(self.config["managedPython"]).absolute(): raise RuntimeError("Baseline managed interpreter selection changed")
        elif current != self.candidate or not Path(command[0]).absolute().is_relative_to(self.home / "tools"):
            raise RuntimeError("The updated managed interpreter escaped the native tool store")
        return command[0]

    def native(self, action, **values):
        payload = dict(values, action=action, source=str(self.source), home=str(self.home))
        return json.loads(self.run([self.store_python(), "-I", "-c", NATIVE], input=json.dumps(payload), capture=True, timeout=45))

    def key(self):
        text = private(self.config["serviceEnvFile"]).read_text()
        matches = re.findall(r"^HERMES_AGENT_INTERFACE_TOKEN=([A-Za-z0-9_-]{43})$", text, re.M)
        gates = re.findall(r"^HERMES_AGENT_INTERFACE_MAINTENANCE_FILE=(/[^\n]+)$", text, re.M)
        if gates != [self.config["maintenanceFile"]]: raise RuntimeError("Native maintenance file differs from the fixed host configuration")
        if len(matches) != 1: raise RuntimeError("Private service key is missing or ambiguous")
        return matches[0]

    def rpc(self, method):
        return self.native("rpc", origin=self.config["dashboardOrigin"], key=self.key(), method=method, operation=self.operation)

    def gateway(self, draining=False, after=None):
        record = json.loads((self.home / "gateway_state.json").read_text())
        if type(record.get("pid")) is not int or str(record["pid"]) != self.unit("gatewayUnit")["MainPID"]: raise RuntimeError("Gateway record is not from the active native process")
        age = time.time() - timestamp(record.get("updated_at", ""))
        if age < -5 or age > (10 if draining else 120): raise RuntimeError("Gateway work status is stale")
        guard = record.get("agent_interface_gateway_guard")
        if (not isinstance(guard, dict) or guard.get("schemaVersion") != 1 or guard.get("maintenanceFile") != self.config["maintenanceFile"]
                or type(guard.get("pendingIngress")) is not int or guard["pendingIngress"] < 0): raise RuntimeError("Gateway supervisor has not loaded the persistent maintenance guard")
        if record.get("hermes_home") != str(self.home) or record.get("code_sha") != self.source_state()[0]: raise RuntimeError("Gateway process has not loaded this exact source and home")
        if after is not None and timestamp(record["updated_at"]) <= after: raise RuntimeError("Gateway has not acknowledged this drain")
        if record.get("gateway_state") != ("draining" if draining else "running"): raise RuntimeError("Gateway state is not confirmed")
        if draining and (guard["pendingIngress"] != 0 or type(record.get("active_agents")) is not int or record["active_agents"] != 0 or "active_work" not in record or record["active_work"] not in (None, [])):
            raise ActiveWork("Gateway has active or unknown chat, cron, API or deferred work")
        return record

    def runtime(self, expected=None):
        if self.env.get("HERMES_UPGRADE_RUNTIME_DESCRIPTOR"):
            utility = Path(__file__).with_name("hermes-qualified-python.py")
            value = json.loads(self.run([self.store_python(), "-I", str(utility), "fingerprint", "--source", str(self.source), "--home", str(self.home)], capture=True, timeout=180))
        else:
            tested = self.env.get("HERMES_UPGRADE_QUALIFICATION_PYTHON")
            if not tested or not Path(tested).is_absolute(): raise RuntimeError("The tested managed interpreter must be fixed")
            selected = self.native("runtime")["python"]
            if Path(selected).absolute() != Path(tested).absolute(): raise RuntimeError("Managed dependency selection differs from the qualified interpreter")
            spec = importlib.util.spec_from_file_location("upgrade_worker", Path(__file__).with_name("hermes-upgrade-worker.py"))
            worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
            value = worker.runtime_fingerprint(selected)
        if expected is not None and value != expected: raise RuntimeError("Managed interpreter or dependencies differ from the qualified runtime")
        return value

    def sync(self):
        # Avoid the launcher's automatic update tail and its plugin-eviction
        # policy. The native PM transaction runs directly, without bootstrap.
        code = r"""
import contextlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]); sys.path.insert(0,str(root))
with contextlib.redirect_stdout(sys.stderr):
    from pm.client import ensure_tools_for_sync
    from hermes_cli.venv_sync import publish_launchers
    from hermes_cli.update_lock import UpdateLock
    import pm
    lock=UpdateLock()
    if not lock.acquire(): raise RuntimeError('A native updater already owns Hermes')
    try:
        ensure_tools_for_sync()
        pm.sync_venv(explicit=True,project_root=root,evict_incompatible_plugins=False)
        publish_launchers(root)
    finally: lock.release()
print(json.dumps({'ok':True,'state':'synced'}))
"""
        return json.loads(self.run([self.config["managedPython"], "-I", "-c", code, str(self.source)], capture=True))

    def google(self):
        value = json.loads(self.run(self.config["googleVerificationCommand"], capture=True, timeout=60))
        if value != {"authenticatedHttp": True, "freshWebsocket": True}: raise RuntimeError("Original Google HTTP and fresh WebSocket authentication were not verified")
        return value

    def anonymous_rejection(self):
        for path in ("/api/config", "/api/profiles"):
            try:
                urllib.request.urlopen(self.config["dashboardOrigin"] + path, timeout=10).close()
            except urllib.error.HTTPError as error:
                if error.code in (401, 403): continue
            raise RuntimeError("Original Google authentication gate did not reject anonymous access")

    def baseline(self):
        units = {name: self.unit(name) for name in ("gatewayUnit", "dashboardUnit", "appUnit")}
        gateway = self.gateway()
        if any(gateway.get("platforms", {}).get(key, {}).get("state") != "connected" for key in self.config["discordConnections"]): raise RuntimeError("Both baseline Discord connections must be connected")
        self.anonymous_rejection(); self.google()
        runtime = self.runtime()
        return {"runtime": runtime, "source": self.source_state(), "settings": self.settings(), "units": units, "discordConnections": self.config["discordConnections"]}

    def regressions(self):
        environment = dict(self.child_env, HERMES_HOME=str(self.stage / "regression-home"), PYTHONPATH=str(self.target))
        Path(environment["HERMES_HOME"]).mkdir(mode=0o700, exist_ok=True)
        python = self.env.get("HERMES_UPGRADE_QUALIFICATION_PYTHON")
        if not python or not Path(python).is_absolute(): raise RuntimeError("Regression checks require the qualified candidate interpreter")
        for argv in self.config["regressionCommands"].values(): self.run([python, *argv[1:]], env=environment)

    def clear_drain(self):
        marker = self.home / ".drain_request.json"
        if not marker.exists(): return
        if json.loads(marker.read_text()).get("principal") != "agent-interface:" + self.operation: raise RuntimeError("Refusing to release another owner's gateway drain")
        marker.unlink()

    def wait_gateway(self, draining=False, after=None):
        deadline = time.monotonic() + self.config.get("drainAcknowledgeSeconds", 15)
        while True:
            try: return self.gateway(draining=draining, after=after)
            except ActiveWork: raise
            except Exception:
                if time.monotonic() >= deadline: raise
                time.sleep(.25)

    def quiescence(self):
        baseline = self.baseline()
        if baseline["source"][0] != self.env.get("HERMES_UPGRADE_CURRENT"): raise RuntimeError("The original source changed before maintenance")
        self.save({"baseline": baseline, "phase": "acquiring"})
        marker = self.home / ".drain_request.json"
        if marker.exists(): raise RuntimeError("An existing native drain requires installer review")
        try:
            gate = self.rpc("acquire")
            if gate.get("active") is not True or gate.get("operationId") != self.operation or gate.get("busy") != []: raise RuntimeError("The native dashboard gate was not acquired without active work")
            drain = self.native("drain", principal="agent-interface:" + self.operation)
            self.wait_gateway(draining=True, after=timestamp(drain["requested_at"]))
            if self.source_state() != tuple(baseline["source"]) or self.settings() != baseline["settings"]: raise RuntimeError("Host inputs changed while acquiring maintenance")
            self.save({"baseline": baseline, "phase": "quiescent"})
        except Exception:
            # 75 is a proven harmless rejection; all cleanup uncertainty fails closed.
            self.clear_drain()
            release = self.rpc("release")
            if release.get("active") is not False: raise RuntimeError("Maintenance release was not confirmed")
            self.wait_gateway()
            if self.source_state() != tuple(baseline["source"]) or self.settings() != baseline["settings"] or any(self.unit(name)["MainPID"] != unit["MainPID"] for name, unit in baseline["units"].items()): raise RuntimeError("Quiescence refusal changed live host state")
            self.save({"baseline": baseline, "phase": "rejected"})
            raise SystemExit(75)

    def control(self, verb):
        # The app unit is deliberately never stopped: it owns the detached worker
        # and its durable UI maintenance record, while Hermes's own gate is closed.
        order = ("gatewayUnit", "dashboardUnit") if verb == "stop" else ("dashboardUnit", "gatewayUnit")
        for name in order: self.run([self.config["systemctl"], "--user", verb, self.config[name]], timeout=90)
        if verb == "stop":
            for name in order:
                state = self.run([self.config["systemctl"], "--user", "show", self.config[name], "--property=ActiveState,MainPID"], capture=True, timeout=15)
                if "ActiveState=inactive" not in state or "MainPID=0" not in state: raise RuntimeError("Native service did not stop cleanly")

    def archive(self, path, source, excluded=None):
        with tarfile.open(path, "w:gz", dereference=False) as archive:
            archive.add(source, arcname=source.name, filter=lambda entry: None if excluded and (entry.name == excluded or entry.name.startswith(excluded + "/")) else entry)
        path.chmod(0o600)
        with tarfile.open(path) as archive: archive.getmembers()
        return digest(path)

    def backup(self):
        record = self.load()
        if record["phase"] != "quiescent": raise RuntimeError("Cold backup requires verified quiescence")
        self.gateway(draining=True)
        self.control("stop")
        self.save(dict(record, phase="stopped"))
        try:
            self.backup_dir.mkdir(mode=0o700)
            hashes = {"source.tar.gz": self.archive(self.backup_dir / "source.tar.gz", self.source),
                "home.tar.gz": self.archive(self.backup_dir / "home.tar.gz", self.home, str(self.source.relative_to(self.home.parent)))}
            protected = {}
            for filename, expected in record["baseline"]["settings"].items():
                path = Path(filename)
                if path.is_symlink() or not stat.S_ISREG(path.lstat().st_mode) or digest(path) != expected: raise RuntimeError("Protected configuration changed during cold backup")
                protected[filename] = {"content": base64.b64encode(path.read_bytes()).decode(), "mode": stat.S_IMODE(path.stat().st_mode), "sha256": expected}
            atomic(self.backup_dir / "protected.json", protected)
            hashes["protected.json"] = digest(self.backup_dir / "protected.json")
            self.save(dict(record, phase="backed_up", archives=hashes))
        except Exception:
            self.control("start")
            self.wait_gateway(draining=True)
            self.save(dict(record, phase="quiescent"))
            raise

    def install(self):
        record = self.load()
        if record["phase"] != "backed_up": raise RuntimeError("Installation requires a cold recovery backup")
        receipt = json.loads(private(self.env["HERMES_UPGRADE_RECEIPT"]).read_text())
        candidate, patch = self.source_state(self.target)
        if candidate != self.candidate or receipt["revision"] != candidate or (receipt.get("trackedPatchSha256") or hashlib.sha256(b"").hexdigest()) != patch: raise RuntimeError("Staged source is not the exact qualified source and repair")
        if not self.env.get("HERMES_UPGRADE_RUNTIME_DESCRIPTOR"):
            for name in ("uv.lock", "pyproject.toml", "pm/lock.json"):
                before, target = self.source / name, self.target / name
                if before.exists() != target.exists() or before.exists() and digest(before) != digest(target): raise RuntimeError("Dependency changes require isolated managed-runtime preparation by the installer")
        preserved = self.git(self.target, "diff", "HEAD", "--binary")
        # No fetch, pull or stash: checkout exactly the already-qualified object.
        self.git(self.source, "reset", "--hard", candidate)
        if preserved: self.run(["git", "-C", str(self.source), "apply", "--index", "--binary", "-"], input=preserved)
        result = self.sync()
        if result.get("ok") is not True or result.get("state") not in ("current", "synced"): raise RuntimeError("Native managed dependency sync did not finish")
        if self.source_state() != (candidate, patch) or self.settings() != record["baseline"]["settings"]: raise RuntimeError("Native installation changed protected source repair or household settings")
        expected_runtime = json.loads(self.env["HERMES_UPGRADE_RUNTIME_FINGERPRINT"])
        self.runtime(expected_runtime)
        self.save(dict(record, phase="installed"))
        self.control("start")

    def verify(self):
        record = self.load()
        baseline = record["baseline"]
        expected = baseline["source"][0] if self.env.get("HERMES_UPGRADE_ROLLBACK") == "1" else self.candidate
        if self.source_state()[0] != expected or self.settings() != baseline["settings"]: raise RuntimeError("Source or protected household settings changed")
        for name, original in baseline["units"].items():
            current = self.unit(name)
            if current["FragmentPath"] != original["FragmentPath"] or current["fragmentSha256"] != original["fragmentSha256"]: raise RuntimeError("A native/app unit changed")
        deadline = time.monotonic() + self.config.get("verificationSeconds", 120)
        while True:
            gateway = self.wait_gateway(draining=True)
            if all(gateway.get("platforms", {}).get(key, {}).get("state") == "connected" for key in baseline["discordConnections"]): break
            if time.monotonic() >= deadline: raise RuntimeError("Both original Discord connections were not restored")
            time.sleep(.5)
        gate = self.rpc("status")
        if gate.get("active") is not True or gate.get("operationId") != self.operation: raise RuntimeError("Native maintenance gate ownership was lost")
        self.anonymous_rejection(); self.google()
        expected_runtime = baseline["runtime"] if self.env.get("HERMES_UPGRADE_ROLLBACK") == "1" else json.loads(self.env["HERMES_UPGRADE_RUNTIME_FINGERPRINT"])
        self.runtime(expected_runtime)
        self.save(dict(record, phase="verified", verifiedRevision=expected))

    def extract(self, name, destination, prefix=None):
        record = self.load()
        file = private(self.backup_dir / name)
        if digest(file) != record["archives"][name]: raise RuntimeError("Cold archive integrity failed")
        with tarfile.open(file) as archive:
            members = archive.getmembers()
            if prefix: members = [item for item in members if item.name == prefix or item.name.startswith(prefix + "/")]
            # Only our just-created, hash-checked private archives are trusted.
            archive.extractall(destination, members=members, filter="fully_trusted")

    def rollback(self):
        record = self.load()
        for name, expected in record["archives"].items():
            if digest(private(self.backup_dir / name)) != expected: raise RuntimeError("Cold recovery archive integrity failed before restoring")
        self.control("stop")
        shutil.rmtree(self.source)
        self.extract("source.tar.gz", self.source.parent)
        # Restore managed generations/selections and tool binaries only. Never
        # restore .env, auth.json, profile OAuth files or sessions from home.tar.gz.
        for name in ("installs", "tools"):
            path = self.home / name
            if path.exists(): shutil.rmtree(path)
            self.extract("home.tar.gz", self.home.parent, self.home.name + "/" + name)
        protected = json.loads(private(self.backup_dir / "protected.json").read_text())
        if set(protected) != set(record["baseline"]["settings"]): raise RuntimeError("Protected backup paths differ from the original host snapshot")
        for filename, saved in protected.items():
            content = base64.b64decode(saved["content"], validate=True)
            if hashlib.sha256(content).hexdigest() != record["baseline"]["settings"][filename]: raise RuntimeError("Protected backup content changed")
            path = Path(filename)
            if path.is_symlink(): raise RuntimeError("Protected configuration became a symlink")
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".restore")
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, saved["mode"]), "wb") as output:
                output.write(content); output.flush(); os.fsync(output.fileno())
            os.replace(temporary, path)
        if self.source_state() != tuple(record["baseline"]["source"]): raise RuntimeError("Rollback source or repair does not match the cold snapshot")
        self.save(dict(record, phase="restored"))
        self.control("start")

    def finish(self):
        record = self.load()
        # Backup failures can leave the old source untouched; verify its live
        # gate, service identity and auth before allowing admission again.
        if record["phase"] == "quiescent":
            self.env["HERMES_UPGRADE_ROLLBACK"] = "1"
            self.verify(); record = self.load()
        if record["phase"] != "verified" or record["verifiedRevision"] != self.source_state()[0]: raise RuntimeError("Release requires verified live source and services")
        self.clear_drain()
        released = self.rpc("release")
        if released.get("active") is not False: raise RuntimeError("Native gate release was not confirmed")
        self.wait_gateway()
        self.save(dict(record, phase="finished"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("action", choices=ACTIONS)
    args = parser.parse_args()
    os.umask(0o077)
    try: getattr(Platform(args.config), args.action)()
    except SystemExit: raise
    except Exception as error:
        # Private worker logs record only the fixed failure class, never source
        # command output which could contain credentials or native session keys.
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        raise SystemExit("Linux upgrade hook failed: " + detail + ". Maintenance remains closed for installer review")


if __name__ == "__main__": main()
