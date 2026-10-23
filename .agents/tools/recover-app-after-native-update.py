#!/usr/bin/env python3
"""Restore the current app's qualified hooks after an external native update.

Requires a fresh full qualification for the unchanged current release. Changes
only its qualification receipt, an owned maintenance lease, and update status.
Interrupted recovery is held for review; this command never retries a cutover.
"""
import argparse
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
import sys
import time
import uuid
from urllib.parse import urlsplit

sys.dont_write_bytecode = True  # Keep the release tree exactly as archived.
import deploy_common
from deploy_common import fence, tripped

UNITS = ("agent-interface.service", "hermes-dashboard.service", "hermes-gateway.service")
UNTOUCHED_UNITS = ("hermes-computer.service", "agent-interface-terminal.service")
# The shared host steps this helper runs; its checked configuration pins their SHA256.
SHARED_FUNCTIONS = "deploy_common.py"
QUALIFIED_DOCTOR = """
let runtime, ready = false;
try {
  const {loadConfig} = await import(process.argv[1]);
  const {createHermesRuntime} = await import(process.argv[2]);
  const config = loadConfig(process.env);
  runtime = createHermesRuntime({url: config.hermesUrl, token: config.hermesToken,
    authMode: config.hermesAuthMode, qualificationFile: config.hermesQualificationFile});
  const status = await runtime.status();
  ready = status.connected === true && (!status.code || status.code === 'ready');
} catch { ready = false; }
finally { try { await runtime?.close(); } catch { ready = false; } }
if (ready) console.log(JSON.stringify({qualifiedRuntimeReady: true}));
else { console.error('Qualified Hermes runtime verification failed.'); process.exitCode = 1; }
"""


def doctor_command(config, release):
    return [config["node"], "--env-file=" + str(Path(config["appBase"]) / "shared/app.env"),
            "--import", "tsx", "--input-type=module", "-e", QUALIFIED_DOCTOR,
            (release / "src/server/config.ts").as_uri(), (release / "src/server/hermes.ts").as_uri()]


def fingerprint(path):
    path = Path(path)
    if path.is_symlink():
        return "link:" + os.readlink(path)
    info = path.lstat()
    fence(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(), "fingerprinted file is a regular file owned by this user")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private_file(path):
    # Not private_fs.owner_private: stage-recovery-tools.py stages this helper without src/hermes.
    path = Path(path)
    info = path.lstat()
    fence(path.is_absolute() and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, "private file is absolute, regular, owner-only and owned by this user")
    return path


def qualified_input(path, release, revision, repair):
    data = private_file(path).read_bytes()
    reader = runpy.run_path(str(release / "src/hermes/qualification.py"))["read_receipt"]
    receipt = reader(path, release)
    fence(json.loads(data) == receipt, "qualification receipt bytes match the parsed receipt")
    fence((receipt["revision"], receipt["trackedPatchSha256"]) == (revision, repair), "qualification receipt binds the installed Hermes revision and repair")
    return data


def validate_environment_paths(base, target, lease, state_dir):
    fence(state_dir.is_absolute(), "upgrade state directory is absolute")
    for path, key in ((base / "shared/hermes-service.env", "HERMES_AGENT_INTERFACE_QUALIFICATION_FILE"),
                      (base / "shared/app.env", "HERMES_QUALIFICATION_FILE")):
        values = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
        fence(values[key] == str(target), "environment names the qualification receipt")
        if path.name == "hermes-service.env":
            fence(values["HERMES_AGENT_INTERFACE_MAINTENANCE_FILE"] == str(lease), "service environment names the maintenance lease")
        else:
            fence(values["HERMES_UPGRADE_ENABLED"] == "true", "app environment enables upgrades")
            fence(values["HERMES_UPGRADE_CONFIG"] == str(base / "shared/hermes-worker.json"), "app environment names the worker configuration")
            fence(values["HERMES_UPGRADE_STATE_DIR"] == str(state_dir), "app environment names the upgrade state directory")


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
        return getattr(self.f, name)(*args, **kwargs)

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
        patch = subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", str(self.source), "diff", "HEAD", "--binary"], timeout=30)
        return revision, hashlib.sha256(patch).hexdigest()

    def assert_fences(self):
        self.claim.validate()
        fence((self.base / "current").is_symlink() and (self.base / "current").resolve(strict=True) == self.release, "current release link still points at the recovered release")
        fence(self.source_state() == (self.c["hermesRevision"], self.c["repairSha256"]), "Hermes source revision and repair unchanged")
        fence({p: fingerprint(p) for p in self.c["profileHashes"]} == self.c["profileHashes"], "household profile settings unchanged")
        fence({p: fingerprint(p) for p in self.c["preservedFiles"]} == self.c["preservedFiles"], "preserved guards and environment unchanged")
        fence(fingerprint(self.receipt_input) == self.receipt_sha, "incoming receipt unchanged")
        qualified_input(self.receipt_input, self.release, self.c["hermesRevision"], self.c["repairSha256"])
        fence(hashlib.sha256(self.system("cat", *UNITS).encode()).hexdigest() == self.unit_hash, "systemd units unchanged")
        fence(all(self.pid(unit) == process for unit, process in self.untouched.items()), "computer and terminal supervisors unchanged")

    def preflight(self):
        self.receipt_bytes = qualified_input(self.receipt_input, self.release, self.c["hermesRevision"], self.c["repairSha256"])
        self.receipt_sha = hashlib.sha256(self.receipt_bytes).hexdigest()
        private_file(self.target)
        self.untouched = {unit: self.pid(unit) for unit in UNTOUCHED_UNITS}
        fence(all(self.untouched.values()), "computer and terminal supervisors running")
        self.unit_hash = hashlib.sha256(self.system("cat", *UNITS).encode()).hexdigest()
        self.assert_fences()
        fence(not self.lease.exists() and not self.lease.is_symlink(), "preflight: no maintenance lease exists")
        fence(not self.drain.exists() and not self.drain.is_symlink(), "preflight: no drain request exists")
        self.old_state = json.loads(self.status_path.read_text())
        fence(self.old_state.get("maintenance") is False, "preflight: update status is not in maintenance")
        fence(self.old_state.get("phase") in ("idle", "succeeded", "rolled_back", "cancelled", "blocked", "failed"), "preflight: update status is settled")
        self.check_requests()
        self.old_dashboard = self.pid(UNITS[1])
        self.old_gateway = self.pid(UNITS[2])
        fence(self.old_dashboard and self.old_gateway and self.pid(UNITS[0]), "preflight: app, dashboard and gateway running")
        record = self.call("gateway_state")
        self.old_code = record["code_sha"]
        fence(re.fullmatch(r"[0-9a-f]{40}", self.old_code), "preflight: gateway reports a full code SHA")
        fence(idle_record(record, process=self.old_gateway, revision=self.old_code,
                           home=self.home, maintenance=self.lease, now=time.time(), state="running"), "preflight: running gateway is fresh, idle and guarded")
        status = self.call("get_status")
        fence(status["active_agents"] == status["active_sessions"] == 0 and not status["gateway_busy"], "preflight: no active agents, sessions or gateway work")
        fence(status["auth_required"] and status["auth_providers"] == ["google-family"], "preflight: dashboard requires Google sign-in")
        self.call("google")
        fence(self.call("app_ready"), "preflight: app ready and signed-out requests refused")
        self.assert_old_owners()
        self.write_json(self.ops / "baseline.json", {
            "release": str(self.release), "receiptSha256": self.receipt_sha,
            "oldGatewayPid": self.old_gateway, "oldGatewayCodeSha": self.old_code,
            "oldDashboardPid": self.old_dashboard, "profileHashes": self.c["profileHashes"],
            "preservedFiles": self.c["preservedFiles"], "systemdUnitsSha256": self.unit_hash, "untouchedUnits": self.untouched})
        self.atomic(self.ops / "previous-status.json", self.status_path.read_bytes())
        self.atomic(self.ops / "previous-qualification.json", self.target.read_bytes())

    def check_requests(self):
        fence(all(json.loads(p.read_text()).get("status") == "complete"
                   for p in (self.status_path.parent / "requests").glob("*.json")), "pending update requests are complete")

    def assert_old_owners(self):
        fence(self.pid(UNITS[1]) == self.old_dashboard and self.pid(UNITS[2]) == self.old_gateway, "original dashboard and gateway still own their units")

    def block(self):
        state = {**self.old_state, "phase": "blocked", "maintenance": True,
                 "operationId": self.operation, "message": "Restoring verified Hermes integration after a native update.",
                 "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        self.write_json(self.status_path, state)

    def phase(self, name):
        self.call("journal", name)

    def request_drain(self):
        fence(not self.drain.exists() and not self.drain.is_symlink(), "drain request: none exists yet")
        value = json.loads(self.call("native", "import json; from pathlib import Path; from gateway.drain_control import write_drain_request; "
            "print(json.dumps(write_drain_request(principal=" + repr(self.operation) + ",suppress_notification=True,home=Path(" + repr(str(self.home)) + "))))"))
        fence(value["principal"] == self.operation, "drain request: reply names this operation")
        fence(json.loads(self.drain.read_text())["principal"] == self.operation, "drain request: file names this operation")
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
        fence(all(self.pid(unit) == 0 for unit in UNITS), "stopped: app, dashboard and gateway have no process")
        for unit in UNITS:
            verdict = dict(line.split("=", 1) for line in self.system("show", unit,
                           "--property=Result,ExecMainCode,ExecMainStatus").splitlines())
            clean_exit = {"Result": "success", "ExecMainCode": "1", "ExecMainStatus": "0"}
            # Native web_server gracefully closes, then re-raises SIGTERM.
            normal_dashboard_stop = {"Result": "success", "ExecMainCode": "2", "ExecMainStatus": "15"}
            fence(verdict == clean_exit or unit == UNITS[1] and verdict == normal_dashboard_stop, "stopped: every unit exited cleanly")
        fence((self.home / ".clean_shutdown").stat().st_mtime >= stopped_at, "stopped: gateway wrote a clean shutdown marker")
        record = self.call("gateway_state")
        fence(record["pid"] == self.old_gateway and record["code_sha"] == self.old_code, "stopped: gateway record is the drained process and code")
        fence(record["hermes_home"] == str(self.home) and record["gateway_state"] == "stopped", "stopped: gateway record names this home and the stopped state")
        fence(datetime.datetime.fromisoformat(record["updated_at"]).timestamp() >= stopped_at, "stopped: gateway record updated after the stop")
        fence(type(record.get("active_agents")) is int and record["active_agents"] == 0, "stopped: gateway record reports zero active agents")
        fence("active_work" in record and record["active_work"] in (None, []), "stopped: gateway record reports no active work")

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
        fence(not marker.exists() and not marker.is_symlink(), "resume: not attempted before")
        phase = json.loads(private_file(self.ops / "phase.json").read_text())
        fence(phase["operationId"] == self.operation and phase["phase"] == "recovery-blocked-needs-review", "resume: phase journal holds this blocked operation")
        state = json.loads(private_file(self.status_path).read_text())
        fence(state["phase"] == "blocked" and state["maintenance"] is True and state["operationId"] == self.operation, "resume: update status blocked by this operation")
        baseline = json.loads(private_file(self.ops / "baseline.json").read_text())
        fence(baseline["release"] == str(self.release), "resume: baseline names this release")
        fence(baseline["profileHashes"] == self.c["profileHashes"] and baseline["preservedFiles"] == self.c["preservedFiles"], "resume: baseline settings match the configuration")
        self.unit_hash, self.untouched = baseline["systemdUnitsSha256"], baseline["untouchedUnits"]
        fence(set(self.untouched) == set(UNTOUCHED_UNITS) and all(type(p) is int and p > 0 for p in self.untouched.values()), "resume: baseline supervisors are recorded processes")
        self.old_dashboard, self.old_gateway, self.old_code = baseline["oldDashboardPid"], baseline["oldGatewayPid"], baseline["oldGatewayCodeSha"]
        fence(type(self.old_dashboard) is int and self.old_dashboard > 0 and type(self.old_gateway) is int and self.old_gateway > 0, "resume: baseline dashboard and gateway are recorded processes")
        fence(re.fullmatch(r"[0-9a-f]{40}", self.old_code), "resume: baseline gateway code is a full SHA")
        self.old_state = json.loads(private_file(self.ops / "previous-status.json").read_text())
        fence(self.old_state["maintenance"] is False, "resume: previous status was not in maintenance")
        self.receipt_bytes = qualified_input(self.receipt_input, self.release, self.c["hermesRevision"], self.c["repairSha256"])
        self.receipt_sha = hashlib.sha256(self.receipt_bytes).hexdigest()
        fence(self.receipt_sha == baseline["receiptSha256"], "resume: incoming receipt matches the baseline")
        previous = private_file(self.ops / "previous-qualification.json").read_bytes()
        fence(private_file(self.target).read_bytes() == previous, "resume: installed receipt is still the previous one")
        fence(not self.lease.exists() and not self.lease.is_symlink(), "resume: no maintenance lease exists")
        drain = json.loads(private_file(self.drain).read_text())
        fence(drain["principal"] == self.operation and drain["action"] == "drain" and drain["suppress_notification"] is True, "resume: drain request is this operation's silent drain")
        requested_at = datetime.datetime.fromisoformat(drain["requested_at"]).timestamp()
        self.assert_fences()
        self.check_requests()
        self.verify_stopped(requested_at)
        for unit, process in ((UNITS[1], self.old_dashboard), (UNITS[2], self.old_gateway)):
            fence(int(self.system("show", unit, "--property=ExecMainPID", "--value").strip()) == process, "resume: units last ran the recorded processes")
        record = self.call("gateway_state")
        stopped_at = datetime.datetime.fromisoformat(record["updated_at"]).timestamp()
        # A stopped owner cannot heartbeat. Validate its historical snapshot
        # against the owned drain and failure journal, keeping running checks fresh.
        fence(idle_record(record, process=self.old_gateway, revision=self.old_code, home=self.home,
                           maintenance=self.lease, now=stopped_at, after=requested_at, state="stopped"), "resume: stopped gateway record is idle, guarded and after the drain")
        fence(stopped_at <= datetime.datetime.fromisoformat(phase["updatedAt"]).timestamp(), "resume: gateway stopped before the failure was journaled")
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
        fence(all(self.pid(unit) == 0 for unit in UNITS), "install: app, dashboard and gateway stopped")
        fence(not self.lease.exists() and not self.lease.is_symlink(), "install: no maintenance lease exists")
        fence(json.loads(self.drain.read_text())["principal"] == self.operation, "install: drain request names this operation")
        # The gate precedes the receipt; no runtime is allowed to see the new
        # matching receipt without this persistent admission boundary.
        self.write_json(self.lease, {"operationId": self.operation})
        self.atomic(self.target, self.receipt_bytes)
        fence(fingerprint(self.target) == self.receipt_sha, "install: installed receipt matches the incoming receipt")
        self.assert_fences()
        fence(all(self.pid(unit) == 0 for unit in UNITS), "install: services still stopped after the receipt swap")

    def rpc(self, action):
        code = "import os; os.environ['HERMES_HOME']=" + repr(str(self.home)) + "; import runpy; m=runpy.run_path(" + repr(str(self.release / "scripts/hermes-upgrade-linux.py")) + "); exec(m['NATIVE'])"
        env = self.base / "shared/hermes-service.env"
        secret = dict(line.split("=", 1) for line in env.read_text().splitlines() if "=" in line)["HERMES_AGENT_INTERFACE_TOKEN"]
        payload = {"action": "rpc", "source": str(self.source), "origin": "http://127.0.0.1:9119",
                   "key": secret, "operation": self.operation, "method": action}
        return json.loads(self.call("run", [self.c["managedPython"], "-I", "-c", code],
                                    input=json.dumps(payload), timeout=45))

    def verify_guarded(self):
        running = {unit: self.pid(unit) for unit in UNITS}
        fence(all(running.values()), "guarded: app, dashboard and gateway running")
        def same_owners():
            fence(all(self.pid(unit) == process for unit, process in running.items()), "guarded: services kept their started processes")
        same_owners()
        self.call("wait", lambda: self.call("ready_gateway", "draining") and idle_record(
            self.call("gateway_state"), process=self.pid(UNITS[2]), revision=self.c["hermesRevision"],
            home=self.home, maintenance=self.lease, now=time.time()))
        self.call("google")
        same_owners()
        self.call("wait", self.f.app_ready)
        gate = self.rpc("status")
        fence(gate["active"] is True and gate["operationId"] == self.operation and gate["busy"] == [], "guarded: maintenance held by this operation with no busy work")
        same_owners()
        fence(json.loads(self.lease.read_text()) == {"operationId": self.operation}, "guarded: maintenance lease names this operation")
        fence(fingerprint(self.target) == self.receipt_sha, "guarded: installed receipt unchanged")
        self.assert_fences()
        self.call("run", doctor_command(self.c, self.release), cwd=self.release, timeout=45)
        same_owners()
        self.guarded_owners = running

    def finish_guarded(self):
        """Consume one already restarted, still sealed operation without replay."""
        marker = self.ops / "finish-attempt.json"
        fence(not marker.exists() and not marker.is_symlink(), "finish: not attempted before")
        phase = json.loads(private_file(self.ops / "phase.json").read_text())
        fence(phase["operationId"] == self.operation and phase["phase"] == "recovery-blocked-needs-review", "finish: phase journal holds this blocked operation")
        state = json.loads(private_file(self.status_path).read_text())
        fence(state["phase"] == "blocked" and state["maintenance"] is True and state["operationId"] == self.operation, "finish: update status blocked by this operation")
        baseline = json.loads(private_file(self.ops / "baseline.json").read_text())
        attempt = json.loads(private_file(self.ops / "resume-attempt.json").read_text())
        fence(attempt["operationId"] == self.operation and attempt["phase"] == "stopped-resume-consumed", "finish: stopped resume consumed by this operation")
        fence(attempt["baselineSha256"] == fingerprint(self.ops / "baseline.json"), "finish: baseline unchanged since resume")
        fence(attempt["previousReceiptSha256"] == fingerprint(self.ops / "previous-qualification.json"), "finish: previous receipt unchanged since resume")
        fence(baseline["release"] == str(self.release), "finish: baseline names this release")
        fence(baseline["profileHashes"] == self.c["profileHashes"] and baseline["preservedFiles"] == self.c["preservedFiles"], "finish: baseline settings match the configuration")
        self.unit_hash, self.untouched = baseline["systemdUnitsSha256"], baseline["untouchedUnits"]
        fence(set(self.untouched) == set(UNTOUCHED_UNITS) and all(type(p) is int and p > 0 for p in self.untouched.values()), "finish: baseline supervisors are recorded processes")
        self.receipt_bytes = qualified_input(self.receipt_input, self.release, self.c["hermesRevision"], self.c["repairSha256"])
        self.receipt_sha = hashlib.sha256(self.receipt_bytes).hexdigest()
        fence(self.receipt_sha == baseline["receiptSha256"] and private_file(self.target).read_bytes() == self.receipt_bytes, "finish: installed receipt matches the incoming receipt")
        fence(json.loads(private_file(self.lease).read_text()) == {"operationId": self.operation}, "finish: maintenance lease names this operation")
        drain = json.loads(private_file(self.drain).read_text())
        fence(drain["principal"] == self.operation and drain["action"] == "drain" and drain["suppress_notification"] is True, "finish: drain request is this operation's silent drain")
        self.assert_fences()
        self.check_requests()
        self.verify_guarded()
        self.claim.validate()
        with marker.open("xb") as output:
            output.write((json.dumps({"operationId": self.operation, "phase": "guarded-finish-consumed",
                "baselineSha256": fingerprint(self.ops / "baseline.json"), "receiptSha256": self.receipt_sha,
                "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}) + "\n").encode())
            output.flush()
            os.fsync(output.fileno())
        directory = os.open(self.ops, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        try:
            self.phase("guarded-finish-consumed")
            self.open_admission()
            return self.complete()
        except BaseException:
            self.phase("admission-needs-review" if self.opened else "recovery-blocked-needs-review")
            raise

    def open_admission(self):
        fence(all(self.pid(unit) == process for unit, process in self.guarded_owners.items()), "admission: guarded services kept their processes")
        # Even a lost reply can mean work was admitted. Never stop/restart or
        # replay this release after setting this flag.
        self.opened = True
        fence(self.rpc("release")["active"] is False, "admission: maintenance released")
        fence(json.loads(self.drain.read_text())["principal"] == self.operation, "admission: drain request still names this operation")
        self.call("native", "import json; from pathlib import Path; "
                  "assert json.loads(Path(" + repr(str(self.drain)) + ").read_text())['principal']==" + repr(self.operation) + "; "
                  "from gateway.drain_control import clear_drain_request; assert clear_drain_request(home=Path(" + repr(str(self.home)) + "))")
        self.call("wait", lambda: self.call("ready_gateway", "running"))
        self.call("google")
        fence(self.call("app_ready"), "admission: app ready after release")
        gate = self.rpc("status")
        fence(gate["active"] is False, "admission: maintenance gate inactive")
        fence(not self.lease.exists() and not self.drain.exists(), "admission: lease and drain request removed")
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
            fence(self.pid(UNITS[0]) == 0, "recovery: app stopped")
            self.check_requests()
            self.block()
            self.phase("old-runtime-draining")
            self.assert_old_owners()
            requested_at = self.request_drain()
            self.call("wait", lambda: self.drained(requested_at), 30)
            permit = self.retire("prepare")
            fence(permit.get("ok") is True and permit.get("idle") is True, "recovery: retirement permit proves idle")
            self.phase("retirement-committing")
            fence(self.retire("commit", permit["token"]).get("ok") is True, "recovery: retirement committed")
            self.phase("retirement-committed")
            fence(self.drained(requested_at), "recovery: gateway still drained after retirement")
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
    modes.add_argument("--finish-guarded", action="store_true", help="Consume a proved running operation once, under its original maintenance gate")
    args = parser.parse_args(argv)
    os.umask(0o077)
    info = args.config.lstat()
    fence(args.config.is_absolute() and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, "config file is private and owned by this user")
    c = json.loads(args.config.read_text())
    base, release, source, home, lease = [Path(c[key]) for key in ("appBase", "release", "source", "hermesHome", "maintenanceFile")]
    fence(all(p.is_absolute() for p in (base, release, source, home, lease)), "configured paths are absolute")
    current = base / "current"
    fence(current.is_symlink() and current.resolve(strict=True) == release == Path(c["expectedRelease"]), "current release is the configured release")
    fence(release.parent == base / "releases" and release.is_dir() and not release.is_symlink(), "release is a real directory under releases")
    fence(c["webBuild"] in (release / "dist/client/sw.js").read_text(), "release serves the configured web build")
    fence(str(uuid.UUID(c["operationId"])) == c["operationId"], "operation ID is a UUID")
    origin = urlsplit(c["appOrigin"])
    fence(origin.scheme == "https" and origin.netloc and not origin.username and not origin.password, "app origin is plain HTTPS")
    fence(not origin.path and not origin.query and not origin.fragment, "app origin has no path, query or fragment")
    fence(re.fullmatch(r"[0-9a-f]{40}", c["hermesRevision"]) and re.fullmatch(r"[0-9a-f]{64}", c["repairSha256"]), "Hermes revision and repair are full hashes")
    target = Path(c["qualificationReceipt"])
    incoming = Path(c["newQualificationReceipt"])
    private_file(target)
    fence(incoming.is_absolute() and incoming != target, "incoming receipt is absolute and separate from the installed one")
    worker = base / "shared/hermes-worker.json"
    worker_config = json.loads(private_file(worker).read_text())
    fence(worker_config["appRoot"] == str(release) and worker_config["qualificationReceipt"] == str(target), "worker configuration names this release and receipt")
    required = [base / "shared/app.env", base / "shared/hermes-service.env", worker,
                Path.home() / ".config/systemd/user/hermes-gateway.service.d/90-agent-interface.conf",
                source / "agent_interface_gateway.py", source / "agent_interface_dashboard.py"]
    fence(set(map(str, required)) <= set(c["preservedFiles"]), "preserved files cover every guard and environment file")
    fence((source / "agent_interface_gateway.py").resolve() == release / "src/hermes/gateway_guard.py", "gateway wrapper links to this release")
    fence((source / "agent_interface_dashboard.py").resolve() == release / "src/hermes/dashboard.py", "dashboard wrapper links to this release")
    fence(str(target) not in c["preservedFiles"], "installed receipt is not a preserved file")
    private_file(base / "shared/app.env")
    private_file(base / "shared/hermes-service.env")
    validate_environment_paths(base, target, lease, Path(c["upgradeStateDir"]))
    fence(isinstance(c["discordConnections"], list) and len(set(c["discordConnections"])) == 2, "exactly two distinct Discord connections")
    functions_path = Path(deploy_common.__file__)
    fence(functions_path.resolve() == Path(__file__).resolve().with_name(SHARED_FUNCTIONS), "shared deploy steps load from beside this helper")
    fence(fingerprint(functions_path) == c["deployFunctionsSha256"], "shared deploy steps match the checked configuration")
    operation = c["operationId"]
    audit_name = "native-recovery-check-" + operation + "-" + str(uuid.uuid4()) if args.check else "native-recovery-" + operation
    ops = base / "operations" / audit_name
    if args.resume_stopped or args.finish_guarded:
        info = ops.lstat()
        fence(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, "audit directory is private and owned by this user")
    else:
        ops.mkdir(mode=0o700)  # A repeated invocation cannot replay an uncertain recovery.
    with (ops / "commands.log").open("a") as log:
        lock_path = Path(c["upgradeStateDir"]) / "worker.lock"
        with os.fdopen(os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "w") as worker_lock:
            lock_info = os.fstat(worker_lock.fileno())
            fence(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == os.getuid() and not lock_info.st_mode & 0o077, "worker lock is private and owned by this user")
            fcntl.flock(worker_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            claim_type = runpy.run_path(str(release / "scripts/hermes-upgrade-worker.py"))["NativeUpdateClaim"]
            with claim_type(source, home) as claim:
                os.environ["HERMES_UPDATE_HANDOFF_PID"] = str(claim.owner_pid)
                functions = deploy_common.Deployment(c, operation=operation, ops=ops, log=log, claim=claim)
                recovery = Recovery(c, functions, claim, ops)
                try:
                    result = recovery.finish_guarded() if args.finish_guarded else recovery.resume_stopped() if args.resume_stopped else recovery.execute(args.check)
                    print(json.dumps(result))
                except BaseException:
                    import traceback
                    traceback.print_exc(file=log)
                    log.flush()
                    print("Recovery stopped for review. Private phase retained; native owners and admission were not replayed."
                          + tripped(sys.exc_info()[1]))
                    return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
