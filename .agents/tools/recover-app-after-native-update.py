#!/usr/bin/env python3
"""Restore the current app's qualified hooks after an external native update.

Requires a fresh full qualification for the unchanged current release. Changes
only its qualification receipt, an owned maintenance lease, and update status.
Interrupted recovery is held for review; this command never retries a cutover.
"""
import argparse
import ast
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import time
import uuid
from urllib.parse import urlsplit

UNITS = ("agent-interface.service", "hermes-dashboard.service", "hermes-gateway.service")
UNTOUCHED_UNITS = ("hermes-computer.service", "agent-interface-terminal.service")


def fingerprint(path):
    path = Path(path)
    if path.is_symlink():
        return "link:" + os.readlink(path)
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private_file(path):
    path = Path(path)
    info = path.lstat()
    assert path.is_absolute() and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
    return path


def qualified_input(path, release, revision, repair):
    data = private_file(path).read_bytes()
    reader = runpy.run_path(str(release / "src/hermes/qualification.py"))["read_receipt"]
    receipt = reader(path, release)
    assert json.loads(data) == receipt
    assert (receipt["revision"], receipt["trackedPatchSha256"]) == (revision, repair)
    return data


def validate_environment_paths(base, target, lease, state_dir):
    assert state_dir.is_absolute()
    for path, key in ((base / "shared/hermes-service.env", "HERMES_AGENT_INTERFACE_QUALIFICATION_FILE"),
                      (base / "shared/app.env", "HERMES_QUALIFICATION_FILE")):
        values = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
        assert values[key] == str(target)
        if path.name == "hermes-service.env":
            assert values["HERMES_AGENT_INTERFACE_MAINTENANCE_FILE"] == str(lease)
        else:
            assert values["HERMES_UPGRADE_ENABLED"] == "true"
            assert values["HERMES_UPGRADE_CONFIG"] == str(base / "shared/hermes-worker.json")
            assert values["HERMES_UPGRADE_STATE_DIR"] == str(state_dir)


def idle_record(record, *, process, revision, home, maintenance, now, after=None, state="draining"):
    """Bind a fresh drain acknowledgment to the runtime that actually owns it."""
    updated = datetime.datetime.fromisoformat(record["updated_at"]).timestamp()
    guard = record.get("agent_interface_gateway_guard", {})
    return (record.get("pid") == process and record.get("code_sha") == revision
            and record.get("hermes_home") == str(home) and record.get("gateway_state") == state
            and type(record.get("active_agents")) is int and record["active_agents"] == 0
            and "active_work" in record and record["active_work"] in (None, [])
            and guard == {"schemaVersion": 1, "maintenanceFile": str(maintenance), "pendingIngress": 0}
            and type(guard.get("schemaVersion")) is int and type(guard.get("pendingIngress")) is int
            and 0 <= now - updated <= 10 and (after is None or updated > after))


class Recovery:
    """Bounded recovery sequence; methods are seams for disposable host tests."""
    def __init__(self, config, functions, claim, ops):
        self.c, self.f, self.claim, self.ops = config, functions, claim, ops
        self.base = Path(config["appBase"])
        self.release = Path(config["release"])
        self.home = Path(config["hermesHome"])
        self.source = Path(config["source"])
        self.lease = Path(config["maintenanceFile"])
        self.drain = self.home / ".drain_request.json"
        self.target = Path(config["qualificationReceipt"])
        self.receipt_input = Path(config["newQualificationReceipt"])
        self.status_path = Path(config["upgradeStateDir"]) / "status.json"
        self.operation = config["operationId"]
        self.opened = False

    def call(self, name, *args, **kwargs):
        return self.f[name](*args, **kwargs)

    def pid(self, unit):
        return int(self.call("pid", unit))

    def system(self, action, *units):
        return self.call("system", action, *units)

    def atomic(self, path, value):
        self.claim.validate()
        self.call("atomic", path, value)

    def write_json(self, path, value):
        self.atomic(path, (json.dumps(value, indent=2) + "\n").encode())

    def source_state(self):
        revision = self.call("run", ["git", "-C", str(self.source), "rev-parse", "HEAD"]).strip()
        patch = subprocess.check_output(["git", "-C", str(self.source), "diff", "HEAD", "--binary"], timeout=30)
        return revision, hashlib.sha256(patch).hexdigest()

    def assert_fences(self):
        self.claim.validate()
        assert (self.base / "current").is_symlink() and (self.base / "current").resolve(strict=True) == self.release
        assert self.source_state() == (self.c["hermesRevision"], self.c["repairSha256"])
        assert {p: fingerprint(p) for p in self.c["profileHashes"]} == self.c["profileHashes"]
        assert {p: fingerprint(p) for p in self.c["preservedFiles"]} == self.c["preservedFiles"]
        assert fingerprint(self.receipt_input) == self.receipt_sha
        qualified_input(self.receipt_input, self.release, self.c["hermesRevision"], self.c["repairSha256"])
        assert hashlib.sha256(self.system("cat", *UNITS).encode()).hexdigest() == self.unit_hash
        assert all(self.pid(unit) == process for unit, process in self.untouched.items())

    def preflight(self):
        self.receipt_bytes = qualified_input(self.receipt_input, self.release, self.c["hermesRevision"], self.c["repairSha256"])
        self.receipt_sha = hashlib.sha256(self.receipt_bytes).hexdigest()
        private_file(self.target)
        self.untouched = {unit: self.pid(unit) for unit in UNTOUCHED_UNITS}
        assert all(self.untouched.values())
        self.unit_hash = hashlib.sha256(self.system("cat", *UNITS).encode()).hexdigest()
        self.assert_fences()
        assert not self.lease.exists() and not self.lease.is_symlink()
        assert not self.drain.exists() and not self.drain.is_symlink()
        self.old_state = json.loads(self.status_path.read_text())
        assert self.old_state.get("maintenance") is False
        assert self.old_state.get("phase") in ("idle", "succeeded", "rolled_back", "cancelled", "blocked", "failed")
        self.check_requests()
        self.old_dashboard = self.pid(UNITS[1])
        self.old_gateway = self.pid(UNITS[2])
        assert self.old_dashboard and self.old_gateway and self.pid(UNITS[0])
        record = self.call("gateway_state")
        self.old_code = record["code_sha"]
        assert re.fullmatch(r"[0-9a-f]{40}", self.old_code)
        assert idle_record(record, process=self.old_gateway, revision=self.old_code,
                           home=self.home, maintenance=self.lease, now=time.time(), state="running")
        status = self.call("get_status")
        assert status["active_agents"] == status["active_sessions"] == 0 and not status["gateway_busy"]
        assert status["auth_required"] and status["auth_providers"] == ["google-family"]
        self.call("google")
        assert self.call("app_ready")
        self.assert_old_owners()
        self.write_json(self.ops / "baseline.json", {
            "release": str(self.release), "receiptSha256": self.receipt_sha,
            "oldGatewayPid": self.old_gateway, "oldGatewayCodeSha": self.old_code,
            "oldDashboardPid": self.old_dashboard, "profileHashes": self.c["profileHashes"],
            "preservedFiles": self.c["preservedFiles"], "systemdUnitsSha256": self.unit_hash, "untouchedUnits": self.untouched})
        self.atomic(self.ops / "previous-status.json", self.status_path.read_bytes())
        self.atomic(self.ops / "previous-qualification.json", self.target.read_bytes())

    def check_requests(self):
        assert all(json.loads(p.read_text()).get("status") == "complete"
                   for p in (self.status_path.parent / "requests").glob("*.json"))

    def assert_old_owners(self):
        assert self.pid(UNITS[1]) == self.old_dashboard and self.pid(UNITS[2]) == self.old_gateway

    def block(self):
        state = {**self.old_state, "phase": "blocked", "maintenance": True,
                 "operationId": self.operation, "message": "Restoring verified Hermes integration after a native update.",
                 "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        self.write_json(self.status_path, state)

    def phase(self, name):
        self.call("journal", name)

    def request_drain(self):
        assert not self.drain.exists() and not self.drain.is_symlink()
        value = json.loads(self.call("native", "import json; from pathlib import Path; from gateway.drain_control import write_drain_request; "
            "print(json.dumps(write_drain_request(principal=" + repr(self.operation) + ",suppress_notification=True,home=Path(" + repr(str(self.home)) + "))))"))
        assert value["principal"] == self.operation
        assert json.loads(self.drain.read_text())["principal"] == self.operation
        return datetime.datetime.fromisoformat(value["requested_at"]).timestamp()

    def drained(self, after):
        self.assert_old_owners()
        return idle_record(self.call("gateway_state"), process=self.old_gateway, revision=self.old_code,
                           home=self.home, maintenance=self.lease, now=time.time(), after=after)

    def retire(self, action, token=None):
        self.assert_old_owners()
        value = self.call("retire", action, token)
        self.assert_old_owners()
        return value

    def verify_stopped(self, stopped_at):
        assert all(self.pid(unit) == 0 for unit in UNITS)
        for unit in UNITS:
            verdict = dict(line.split("=", 1) for line in self.system("show", unit,
                           "--property=Result,ExecMainCode,ExecMainStatus").splitlines())
            clean_exit = {"Result": "success", "ExecMainCode": "1", "ExecMainStatus": "0"}
            # Native web_server gracefully closes, then re-raises SIGTERM.
            normal_dashboard_stop = {"Result": "success", "ExecMainCode": "2", "ExecMainStatus": "15"}
            assert verdict == clean_exit or unit == UNITS[1] and verdict == normal_dashboard_stop
        assert (self.home / ".clean_shutdown").stat().st_mtime >= stopped_at
        record = self.call("gateway_state")
        assert record["pid"] == self.old_gateway and record["code_sha"] == self.old_code
        assert record["hermes_home"] == str(self.home) and record["gateway_state"] == "stopped"
        assert datetime.datetime.fromisoformat(record["updated_at"]).timestamp() >= stopped_at
        assert type(record.get("active_agents")) is int and record["active_agents"] == 0
        assert "active_work" in record and record["active_work"] in (None, [])

    def continue_stopped(self):
        self.install()
        self.phase("matching-receipt-installed")
        self.system("start", UNITS[1], UNITS[2], UNITS[0])
        self.verify_guarded()
        self.phase("guarded-verification-passed")
        self.open_admission()
        return self.complete()

    def resume_stopped(self):
        """Consume one narrowly proved stopped operation, without repeating retirement."""
        marker = self.ops / "resume-attempt.json"
        assert not marker.exists() and not marker.is_symlink()
        phase = json.loads(private_file(self.ops / "phase.json").read_text())
        assert phase["operationId"] == self.operation and phase["phase"] == "recovery-blocked-needs-review"
        state = json.loads(private_file(self.status_path).read_text())
        assert state["phase"] == "blocked" and state["maintenance"] is True and state["operationId"] == self.operation
        baseline = json.loads(private_file(self.ops / "baseline.json").read_text())
        assert baseline["release"] == str(self.release)
        assert baseline["profileHashes"] == self.c["profileHashes"] and baseline["preservedFiles"] == self.c["preservedFiles"]
        self.unit_hash, self.untouched = baseline["systemdUnitsSha256"], baseline["untouchedUnits"]
        assert set(self.untouched) == set(UNTOUCHED_UNITS) and all(type(p) is int and p > 0 for p in self.untouched.values())
        self.old_dashboard, self.old_gateway, self.old_code = baseline["oldDashboardPid"], baseline["oldGatewayPid"], baseline["oldGatewayCodeSha"]
        assert type(self.old_dashboard) is int and self.old_dashboard > 0 and type(self.old_gateway) is int and self.old_gateway > 0
        assert re.fullmatch(r"[0-9a-f]{40}", self.old_code)
        self.old_state = json.loads(private_file(self.ops / "previous-status.json").read_text())
        assert self.old_state["maintenance"] is False
        self.receipt_bytes = qualified_input(self.receipt_input, self.release, self.c["hermesRevision"], self.c["repairSha256"])
        self.receipt_sha = hashlib.sha256(self.receipt_bytes).hexdigest()
        assert self.receipt_sha == baseline["receiptSha256"]
        previous = private_file(self.ops / "previous-qualification.json").read_bytes()
        assert private_file(self.target).read_bytes() == previous
        assert not self.lease.exists() and not self.lease.is_symlink()
        drain = json.loads(private_file(self.drain).read_text())
        assert drain["principal"] == self.operation and drain["action"] == "drain" and drain["suppress_notification"] is True
        requested_at = datetime.datetime.fromisoformat(drain["requested_at"]).timestamp()
        self.assert_fences()
        self.check_requests()
        self.verify_stopped(requested_at)
        for unit, process in ((UNITS[1], self.old_dashboard), (UNITS[2], self.old_gateway)):
            assert int(self.system("show", unit, "--property=ExecMainPID", "--value").strip()) == process
        record = self.call("gateway_state")
        stopped_at = datetime.datetime.fromisoformat(record["updated_at"]).timestamp()
        # A stopped owner cannot heartbeat. Validate its historical snapshot
        # against the owned drain and failure journal, keeping running checks fresh.
        assert idle_record(record, process=self.old_gateway, revision=self.old_code, home=self.home,
                           maintenance=self.lease, now=stopped_at, after=requested_at, state="stopped")
        assert stopped_at <= datetime.datetime.fromisoformat(phase["updatedAt"]).timestamp()
        self.claim.validate()
        # Exclusive creation consumes this resume even if the process dies before
        # writing its body. Never replace or remove an existing attempt marker.
        with marker.open("xb") as output:
            output.write((json.dumps({"operationId": self.operation, "phase": "stopped-resume-consumed",
                "previousReceiptSha256": hashlib.sha256(previous).hexdigest(),
                "baselineSha256": fingerprint(self.ops / "baseline.json"),
                "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}) + "\n").encode())
            output.flush()
            os.fsync(output.fileno())
        directory = os.open(self.ops, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        try:
            self.phase("stopped-resume-consumed")
            return self.continue_stopped()
        except BaseException:
            self.phase("admission-needs-review" if self.opened else "recovery-blocked-needs-review")
            raise

    def install(self):
        self.assert_fences()
        assert all(self.pid(unit) == 0 for unit in UNITS)
        assert not self.lease.exists() and not self.lease.is_symlink()
        assert json.loads(self.drain.read_text())["principal"] == self.operation
        # The gate precedes the receipt; no runtime is allowed to see the new
        # matching receipt without this persistent admission boundary.
        self.write_json(self.lease, {"operationId": self.operation})
        self.atomic(self.target, self.receipt_bytes)
        assert fingerprint(self.target) == self.receipt_sha
        self.assert_fences()
        assert all(self.pid(unit) == 0 for unit in UNITS)

    def rpc(self, action):
        code = "import os; os.environ['HERMES_HOME']=" + repr(str(self.home)) + "; import runpy; m=runpy.run_path(" + repr(str(self.release / "scripts/hermes-upgrade-linux.py")) + "); exec(m['NATIVE'])"
        env = self.base / "shared/hermes-service.env"
        secret = dict(line.split("=", 1) for line in env.read_text().splitlines() if "=" in line)["HERMES_AGENT_INTERFACE_TOKEN"]
        payload = {"action": "rpc", "source": str(self.source), "origin": "http://127.0.0.1:9119",
                   "key": secret, "operation": self.operation, "method": action}
        return json.loads(self.call("run", [self.c["managedPython"], "-I", "-c", code],
                                    input=json.dumps(payload), timeout=45))

    def verify_guarded(self):
        self.call("wait", lambda: self.call("ready_gateway", "draining") and idle_record(
            self.call("gateway_state"), process=self.pid(UNITS[2]), revision=self.c["hermesRevision"],
            home=self.home, maintenance=self.lease, now=time.time()))
        self.call("google")
        self.call("wait", self.f["app_ready"])
        gate = self.rpc("status")
        assert gate["active"] is True and gate["operationId"] == self.operation and gate["busy"] == []
        assert json.loads(self.lease.read_text()) == {"operationId": self.operation}
        assert fingerprint(self.target) == self.receipt_sha
        self.assert_fences()
        self.call("run", [self.c["node"], "--env-file=" + str(self.base / "shared/app.env"),
                  "--import", "tsx", "scripts/setup.ts", "--check"], cwd=self.release)

    def open_admission(self):
        # Even a lost reply can mean work was admitted. Never stop/restart or
        # replay this release after setting this flag.
        self.opened = True
        assert self.rpc("release")["active"] is False
        assert json.loads(self.drain.read_text())["principal"] == self.operation
        self.call("native", "import json; from pathlib import Path; "
                  "assert json.loads(Path(" + repr(str(self.drain)) + ").read_text())['principal']==" + repr(self.operation) + "; "
                  "from gateway.drain_control import clear_drain_request; assert clear_drain_request(home=Path(" + repr(str(self.home)) + "))")
        self.call("wait", lambda: self.call("ready_gateway", "running"))
        self.call("google")
        assert self.call("app_ready")
        gate = self.rpc("status")
        assert gate["active"] is False
        assert not self.lease.exists() and not self.drain.exists()
        self.assert_fences()

    def complete(self):
        revision = self.c["hermesRevision"]
        self.write_json(self.status_path, {"phase": "idle", "maintenance": False, "checks": [],
            "current": {"revision": revision, "version": revision[:12],
                        "notesUrl": "https://github.com/NousResearch/hermes-agent/commit/" + revision},
            "message": "Check for a Hermes update when you're ready.",
            "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        result = {"currentReleaseUnchanged": True, "hermesRevision": revision, "webBuild": self.c["webBuild"],
                  "repairPreserved": True, "profileSettingsPreserved": True, "guardsAndEnvironmentPreserved": True,
                  "originalGoogleHttpAndFreshWebsocket": True, "bothDiscordConnected": True,
                  "actualInstallerMaintenanceRpc": True, "maintenanceCleared": True}
        self.write_json(self.ops / "result.json", result)
        self.phase("complete")
        return result

    def execute(self, check=False):
        self.preflight()
        if check:
            return {"currentReleaseQualificationVerified": True, "originalGoogleVerified": True, "noServiceChanges": True}
        try:
            self.block()
            self.system("stop", UNITS[0])
            assert self.pid(UNITS[0]) == 0
            self.check_requests()
            self.block()
            self.phase("old-runtime-draining")
            self.assert_old_owners()
            requested_at = self.request_drain()
            self.call("wait", lambda: self.drained(requested_at), 30)
            permit = self.retire("prepare")
            assert permit.get("ok") is True and permit.get("idle") is True
            self.phase("retirement-committing")
            assert self.retire("commit", permit["token"]).get("ok") is True
            self.phase("retirement-committed")
            assert self.drained(requested_at)
            self.assert_fences()
            stopped_at = time.time()
            self.system("stop", *UNITS)
            self.verify_stopped(stopped_at)
            return self.continue_stopped()
        except BaseException:
            self.phase("admission-needs-review" if self.opened else "recovery-blocked-needs-review")
            raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check", action="store_true", help="Read-only live preflight; never change services or admission")
    modes.add_argument("--resume-stopped", action="store_true", help="Consume a proved stopped operation once, using the same config and operation")
    args = parser.parse_args(argv)
    os.umask(0o077)
    info = args.config.lstat()
    assert args.config.is_absolute() and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
    c = json.loads(args.config.read_text())
    base, release, source, home, lease = [Path(c[key]) for key in ("appBase", "release", "source", "hermesHome", "maintenanceFile")]
    assert all(p.is_absolute() for p in (base, release, source, home, lease))
    current = base / "current"
    assert current.is_symlink() and current.resolve(strict=True) == release == Path(c["expectedRelease"])
    assert release.parent == base / "releases" and release.is_dir() and not release.is_symlink()
    assert c["webBuild"] in (release / "dist/client/sw.js").read_text()
    assert str(uuid.UUID(c["operationId"])) == c["operationId"]
    origin = urlsplit(c["appOrigin"])
    assert origin.scheme == "https" and origin.netloc and not origin.username and not origin.password
    assert not origin.path and not origin.query and not origin.fragment
    assert re.fullmatch(r"[0-9a-f]{40}", c["hermesRevision"]) and re.fullmatch(r"[0-9a-f]{64}", c["repairSha256"])
    target = Path(c["qualificationReceipt"])
    incoming = Path(c["newQualificationReceipt"])
    private_file(target)
    assert incoming.is_absolute() and incoming != target
    worker = base / "shared/hermes-worker.json"
    worker_config = json.loads(private_file(worker).read_text())
    assert worker_config["appRoot"] == str(release) and worker_config["qualificationReceipt"] == str(target)
    required = [base / "shared/app.env", base / "shared/hermes-service.env", worker,
                Path.home() / ".config/systemd/user/hermes-gateway.service.d/90-agent-interface.conf",
                source / "agent_interface_gateway.py", source / "agent_interface_dashboard.py"]
    assert set(map(str, required)) <= set(c["preservedFiles"])
    assert (source / "agent_interface_gateway.py").resolve() == release / "src/hermes/gateway_guard.py"
    assert (source / "agent_interface_dashboard.py").resolve() == release / "src/hermes/dashboard.py"
    assert str(target) not in c["preservedFiles"]
    private_file(base / "shared/app.env")
    private_file(base / "shared/hermes-service.env")
    validate_environment_paths(base, target, lease, Path(c["upgradeStateDir"]))
    assert isinstance(c["discordConnections"], list) and len(set(c["discordConnections"])) == 2
    functions_path = Path(__file__).with_name("deploy-app-release.py")
    assert fingerprint(functions_path) == c["deployFunctionsSha256"]
    operation = c["operationId"]
    audit_name = "native-recovery-check-" + operation + "-" + str(uuid.uuid4()) if args.check else "native-recovery-" + operation
    ops = base / "operations" / audit_name
    if args.resume_stopped:
        info = ops.lstat()
        assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
    else:
        ops.mkdir(mode=0o700)  # A repeated invocation cannot replay an uncertain recovery.
    with (ops / "commands.log").open("a") as log:
        lock_path = Path(c["upgradeStateDir"]) / "worker.lock"
        with os.fdopen(os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "w") as worker_lock:
            lock_info = os.fstat(worker_lock.fileno())
            assert stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == os.getuid() and not lock_info.st_mode & 0o077
            fcntl.flock(worker_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            claim_type = runpy.run_path(str(release / "scripts/hermes-upgrade-worker.py"))["NativeUpdateClaim"]
            with claim_type(source, home) as claim:
                os.environ["HERMES_UPDATE_HANDOFF_PID"] = str(claim.owner_pid)
                functions = dict(c=c, base=base, release=release, current=current, source=source, home=home,
                    lease=lease, operation=operation, ops=ops, log=log, claim=claim, origin=c["appOrigin"],
                    service_env=base / "shared/hermes-service.env")
                module = ast.parse(functions_path.read_text())
                module.body = [x for x in module.body if isinstance(x, (ast.Import, ast.ImportFrom, ast.FunctionDef))]
                exec(compile(module, "reviewed-deployment-functions", "exec"), functions)
                def native(code):
                    # Set the native root before bootstrap can latch process identity.
                    prefix = "import os; os.environ['HERMES_HOME']=" + repr(str(home)) + "; import sys; sys.path.insert(0," + repr(str(source)) + "); import hermes_bootstrap; "
                    return functions["run"]([c["managedPython"], "-I", "-c", prefix + code])
                functions["native"] = native
                recovery = Recovery(c, functions, claim, ops)
                try:
                    print(json.dumps(recovery.resume_stopped() if args.resume_stopped else recovery.execute(args.check)))
                except BaseException:
                    import traceback
                    traceback.print_exc(file=log)
                    log.flush()
                    print("Recovery stopped for review. Private phase retained; native owners and admission were not replayed.")
                    return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
