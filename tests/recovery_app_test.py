"""Receipt-only native recovery, using disposable files and fake service owners."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("recover_app", ROOT / ".agents/tools/recover-app-after-native-update.py")
recover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recover)
qualification = __import__("runpy").run_path(str(ROOT / "src/hermes/qualification.py"))


def record(process=101, revision="d" * 40, **changes):
    value = {"pid": process, "code_sha": revision, "hermes_home": "/fixture/home",
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "gateway_state": "draining", "active_agents": 0, "active_work": [], **changes}
    value.setdefault("agent_interface_gateway_guard", {"schemaVersion": 1,
        "maintenanceFile": str(Path(value["hermes_home"]) / "maintenance.json"), "pendingIngress": 0})
    return value


class ReceiptTests(unittest.TestCase):
    def test_qualified_doctor_imports_bound_release_passes_receipt_and_redacts_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_module = root / "config.mjs"
            runtime_module = root / "hermes.mjs"
            config_module.write_text("export const loadConfig = () => ({hermesUrl:'url',hermesToken:'token',hermesAuthMode:'service',hermesQualificationFile:'/qualified'});")
            runtime_module.write_text("export const createHermesRuntime = o => {if(o.qualificationFile!=='/qualified'||o.token!=='token'||o.authMode!=='service'||o.url!=='url')throw Error('private-secret');return {status:async()=>({connected:true,code:'ready'}),close:async()=>{}};};")
            command = ["node", "--input-type=module", "-e", recover.QUALIFIED_DOCTOR, config_module.as_uri(), runtime_module.as_uri()]
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"qualifiedRuntimeReady": True})
            runtime_module.write_text("export const createHermesRuntime = () => ({status:async()=>{throw Error('private-secret');},close:async()=>{}});")
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("private-secret", result.stdout+result.stderr)
            self.assertEqual(result.stderr.strip(), "Qualified Hermes runtime verification failed.")
            argv = recover.doctor_command({"node":"node","appBase":str(root)}, root)
            self.assertEqual(argv[-2:], [(root / "src/server/config.ts").as_uri(), (root / "src/server/hermes.ts").as_uri()])
            self.assertNotIn("scripts/setup.ts", argv)

    def test_receipt_binds_current_app_and_exact_new_native_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "qualification.json"
            receipt = {"schemaVersion": 1, "revision": "5" * 40, "trackedPatchSha256": "a" * 64,
                       "integrationDigest": qualification["integration_digest"](ROOT),
                       "checks": {"realIntegration": True, "hostRegressions": True}, "qualifiedAt": "now"}
            path.write_text(json.dumps(receipt))
            path.chmod(0o600)
            self.assertEqual(json.loads(recover.qualified_input(path, ROOT, "5" * 40, "a" * 64)), receipt)
            with self.assertRaises(AssertionError):
                recover.qualified_input(path, ROOT, "d" * 40, "a" * 64)
            with self.assertRaises(AssertionError):
                recover.qualified_input(path, ROOT, "5" * 40, "b" * 64)
            path.write_text(json.dumps({**receipt, "integrationDigest": "b" * 64}))
            with self.assertRaises(ValueError):
                recover.qualified_input(path, ROOT, "5" * 40, "a" * 64)
            path.chmod(0o644)
            with self.assertRaises(AssertionError):
                recover.qualified_input(path, ROOT, "5" * 40, "a" * 64)
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(AssertionError):
                recover.private_file(link)

    def test_old_runtime_drain_does_not_assume_new_disk_revision(self):
        values = dict(process=101, revision="d" * 40, home=Path("/fixture/home"),
                      maintenance=Path("/fixture/home/maintenance.json"), now=time.time()+0.01)
        self.assertTrue(recover.idle_record(record(), **values))
        for bad in (record(revision="5" * 40), record(process=102), record(hermes_home="/wrong"),
                    record(active_agents=1), record(active_agents=False), record(active_work=["busy"]),
                    record(updated_at=datetime.datetime.fromtimestamp(time.time()-20, datetime.timezone.utc).isoformat())):
            self.assertFalse(recover.idle_record(bad, **values))
        self.assertFalse(recover.idle_record(record(), **values, after=time.time()+1))

    def test_gateway_guard_and_environment_must_bind_exact_persistent_gate(self):
        values = dict(process=101, revision="d" * 40, home=Path("/fixture/home"),
                      maintenance=Path("/fixture/home/maintenance.json"), now=time.time()+0.01)
        for guard in ({}, {"schemaVersion": 1, "maintenanceFile": "/wrong", "pendingIngress": 0},
                      {"schemaVersion": 1, "maintenanceFile": "/fixture/home/maintenance.json", "pendingIngress": 1},
                      {"schemaVersion": 1, "maintenanceFile": "/fixture/home/maintenance.json", "pendingIngress": False}):
            self.assertFalse(recover.idle_record(record(agent_interface_gateway_guard=guard), **values))
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "shared").mkdir()
            service = base / "shared/hermes-service.env"
            service.write_text("HERMES_AGENT_INTERFACE_QUALIFICATION_FILE=/receipt\nHERMES_AGENT_INTERFACE_MAINTENANCE_FILE=/gate\n")
            app = base / "shared/app.env"
            environment = {"HERMES_QUALIFICATION_FILE": "/receipt", "HERMES_UPGRADE_ENABLED": "true",
                           "HERMES_UPGRADE_CONFIG": str(base / "shared/hermes-worker.json"),
                           "HERMES_UPGRADE_STATE_DIR": "/state"}
            app.write_text("\n".join(key + "=" + value for key, value in environment.items()))
            recover.validate_environment_paths(base, Path("/receipt"), Path("/gate"), Path("/state"))
            with self.assertRaises(AssertionError):
                recover.validate_environment_paths(base, Path("/receipt"), Path("/wrong"), Path("/state"))
            with self.assertRaises(AssertionError):
                recover.validate_environment_paths(base, Path("/receipt"), Path("/gate"), Path("/wrong-state"))
            for key, value in (("HERMES_UPGRADE_ENABLED", "false"), ("HERMES_UPGRADE_CONFIG", "/wrong-worker.json")):
                app.write_text("\n".join(k + "=" + v for k, v in {**environment, key: value}.items()))
                with self.assertRaises(AssertionError):
                    recover.validate_environment_paths(base, Path("/receipt"), Path("/gate"), Path("/state"))


class FakeRecovery(recover.Recovery):
    def __init__(self, root, fail=None):
        for name in ("releases/current", "home", "operations", "state"):
            (root / name).mkdir(parents=True, exist_ok=True)
        config = {"appBase": str(root), "release": str(root / "releases/current"), "hermesHome": str(root / "home"),
                  "source": str(root / "source"), "maintenanceFile": str(root / "home/maintenance.json"),
                  "qualificationReceipt": str(root / "receipt.json"), "newQualificationReceipt": str(root / "incoming.json"),
                  "upgradeStateDir": str(root / "state"), "operationId": "owned-operation", "webBuild": "build",
                  "hermesRevision": "5" * 40, "repairSha256": "a" * 64, "node": "node", "profileHashes": {}, "preservedFiles": {}}
        self.events = []
        self.fail = fail
        self.pids = dict(zip(recover.UNITS, (100, 102, 101)))
        self.fenced = True
        claim = type("Claim", (), {"validate": lambda _: None})()
        super().__init__(config, {}, claim, root / "operations")
        self.target.write_bytes(b"old-receipt")
        self.receipt_input.write_bytes(b"new-receipt")
        self.native_record = record(hermes_home=str(self.home), gateway_state="running")
        self.f = {"wait": lambda fn, *args: self.wait_once(fn), "journal": lambda phase: self.note(phase),
                  "gateway_state": lambda: self.native_record,
                  "ready_gateway": lambda state: self.ready(state), "google": lambda: self.note("google"),
                  "app_ready": lambda: True, "run": lambda *a, **k: self.note("doctor"),
                  "native": lambda code: self.clear_drain(code)}

    def note(self, event):
        self.events.append(event)
        if self.fail == event:
            raise RuntimeError("injected failure")

    def wait_once(self, fn):
        assert fn()

    def preflight(self):
        self.old_dashboard, self.old_gateway, self.old_code = 102, 101, "d" * 40
        self.old_state = {"phase": "idle", "maintenance": False}
        self.receipt_bytes = self.receipt_input.read_bytes()
        self.receipt_sha = hashlib.sha256(self.receipt_bytes).hexdigest()
        self.note("preflight")

    def pid(self, unit):
        return self.pids[unit]

    def assert_fences(self):
        self.note("fence")
        assert self.fenced

    def atomic(self, path, value):
        Path(path).write_bytes(value)
        Path(path).chmod(0o600)

    def check_requests(self):
        self.note("pending-requests-clear")

    def system(self, action, *units):
        if action == "show":
            if "--property=ExecMainPID" in units:
                return str(102 if units[0] == recover.UNITS[1] else 101)
            return "Result=success\nExecMainCode=1\nExecMainStatus=0"
        self.note(action + ":" + ",".join(units))
        if action == "stop":
            for unit in units:
                self.pids[unit] = 0
            if recover.UNITS[2] in units:
                stopped = time.time()+0.01
                self.native_record = record(hermes_home=str(self.home), gateway_state="stopped",
                    updated_at=datetime.datetime.fromtimestamp(stopped, datetime.timezone.utc).isoformat())
                marker = self.home / ".clean_shutdown"
                marker.touch()
                os.utime(marker, (stopped, stopped))
        else:
            assert self.target.read_bytes() == b"new-receipt" and self.lease.exists()
            assert self.pids[recover.UNITS[1]] == self.pids[recover.UNITS[2]] == 0
            for unit in units:
                self.pids[unit] = 200 + recover.UNITS.index(unit)
            self.native_record = record(process=202, revision="5" * 40, hermes_home=str(self.home), gateway_state="draining")

    def request_drain(self):
        self.note("request-drain")
        at = time.time()-0.1
        self.write_json(self.drain, {"principal": self.operation})
        self.native_record = record(hermes_home=str(self.home))
        return at

    def call(self, name, *args, **kwargs):
        if name == "retire":
            self.note("retire:" + args[0])
            if self.fail == "replace-dashboard":
                self.pids[recover.UNITS[1]] = 999
            return {"ok": True, "idle": True, "token": "one-token"}
        return super().call(name, *args, **kwargs)

    def rpc(self, action):
        self.note("rpc:" + action)
        if action == "release":
            self.lease.unlink()
            return {"active": False}
        return {"active": self.lease.exists(), "operationId": self.operation, "busy": []}

    def ready(self, state):
        return self.native_record["gateway_state"] == state and self.native_record["code_sha"] == "5" * 40

    def clear_drain(self, code):
        self.note("clear-drain")
        assert "home=Path(" in code
        self.drain.unlink()
        self.native_record["gateway_state"] = "running"


class RecoverySequenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_success_seals_old_owners_before_swap_and_verifies_before_release(self):
        host = FakeRecovery(self.root)
        result = host.execute()
        self.assertTrue(result["currentReleaseUnchanged"] and result["maintenanceCleared"])
        events = host.events
        self.assertLess(events.index("retire:commit"), events.index("matching-receipt-installed"))
        self.assertLess(events.index("doctor"), events.index("rpc:release"))
        self.assertEqual(host.old_code, "d" * 40)
        self.assertEqual(host.native_record["code_sha"], "5" * 40)
        self.assertEqual(json.loads(host.status_path.read_text())["phase"], "idle")
        self.assertEqual(host.target.read_bytes(), b"new-receipt")
        self.assertFalse(host.lease.exists() or host.drain.exists())

    def test_preflight_check_never_stops_or_changes_admission(self):
        host = FakeRecovery(self.root)
        self.assertTrue(host.execute(check=True)["noServiceChanges"])
        self.assertEqual(host.events, ["preflight"])
        self.assertEqual(host.target.read_bytes(), b"old-receipt")

    def test_dashboard_replacement_after_prepare_never_commits_or_stops_new_owner(self):
        host = FakeRecovery(self.root, "replace-dashboard")
        with self.assertRaises(AssertionError):
            host.execute()
        self.assertNotIn("retire:commit", host.events)
        self.assertEqual(host.pids[recover.UNITS[1]], 999)
        self.assertEqual(host.target.read_bytes(), b"old-receipt")
        self.assertEqual(host.events[-1], "recovery-blocked-needs-review")

    def test_unknown_commit_keeps_native_owners_and_old_receipt_without_retry(self):
        host = FakeRecovery(self.root, "retire:commit")
        with self.assertRaises(RuntimeError):
            host.execute()
        self.assertEqual(host.events.count("retire:commit"), 1)
        self.assertEqual((host.pids[recover.UNITS[1]], host.pids[recover.UNITS[2]]), (102, 101))
        self.assertEqual(host.target.read_bytes(), b"old-receipt")
        self.assertTrue(json.loads(host.status_path.read_text())["maintenance"])

    def test_changed_fence_or_unclean_shutdown_cannot_install_receipt(self):
        for failure in ("fence", "unclean"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                host = FakeRecovery(Path(directory), failure if failure == "fence" else None)
                if failure == "unclean":
                    host.verify_stopped = lambda at: (_ for _ in ()).throw(AssertionError("unclean"))
                with self.assertRaises((AssertionError, RuntimeError)):
                    host.execute()
                self.assertEqual(host.target.read_bytes(), b"old-receipt")
                self.assertFalse(any(e.startswith("start:") for e in host.events))

    def test_verification_failure_keeps_owned_gate_and_never_rolls_back_or_releases(self):
        host = FakeRecovery(self.root, "doctor")
        with self.assertRaises(RuntimeError):
            host.execute()
        self.assertEqual(host.target.read_bytes(), b"new-receipt")
        self.assertEqual(json.loads(host.lease.read_text()), {"operationId": host.operation})
        self.assertNotIn("rpc:release", host.events)
        self.assertEqual(sum(e.startswith("start:") for e in host.events), 1)
        self.assertEqual(host.events[-1], "recovery-blocked-needs-review")

    def test_uncertain_release_never_stops_or_replays_and_marks_admission_uncertain(self):
        host = FakeRecovery(self.root, "rpc:release")
        with self.assertRaises(RuntimeError):
            host.execute()
        release_at = host.events.index("rpc:release")
        self.assertFalse(any(e.startswith(("stop:", "start:")) for e in host.events[release_at+1:]))
        self.assertEqual(host.events.count("rpc:release"), 1)
        self.assertTrue(host.opened)
        self.assertEqual(host.events[-1], "admission-needs-review")

    def test_new_work_after_admission_release_does_not_fail_recovery(self):
        host = FakeRecovery(self.root)
        native_rpc = host.rpc
        def rpc(action):
            value = native_rpc(action)
            if action == "status" and not host.lease.exists():
                value["busy"] = ["newly-admitted-work"]
            return value
        host.rpc = rpc
        self.assertTrue(host.execute()["maintenanceCleared"])
        self.assertEqual(host.events[-1], "complete")

    def test_running_owner_or_unclean_dashboard_prevents_stopped_receipt_swap(self):
        host = FakeRecovery(self.root)
        host.preflight()
        host.write_json(host.drain, {"principal": host.operation})
        with self.assertRaises(AssertionError):
            host.install()
        self.assertEqual(host.target.read_bytes(), b"old-receipt")
        self.assertFalse(host.lease.exists())
        original_system = host.system
        def system(action, *units):
            if action == "show" and units[0] == recover.UNITS[1]:
                return "Result=timeout\nExecMainCode=2\nExecMainStatus=9"
            return original_system(action, *units)
        host.system = system
        stopped_at = time.time()
        host.system("stop", *recover.UNITS)
        with self.assertRaises(AssertionError):
            host.verify_stopped(stopped_at)
        self.assertEqual(host.target.read_bytes(), b"old-receipt")


class StoppedResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.host = self.stopped(Path(self.temp.name))

    def stopped(self, root):
        host = FakeRecovery(root)
        host.preflight()
        baseline = {"release": str(host.release), "receiptSha256": host.receipt_sha,
            "oldGatewayPid": host.old_gateway, "oldGatewayCodeSha": host.old_code,
            "oldDashboardPid": host.old_dashboard, "profileHashes": {}, "preservedFiles": {},
            "systemdUnitsSha256": "unit-hash", "untouchedUnits": dict(zip(recover.UNTOUCHED_UNITS, (301, 302)))}
        host.write_json(host.ops / "baseline.json", baseline)
        host.write_json(host.ops / "previous-status.json", host.old_state)
        host.atomic(host.ops / "previous-qualification.json", b"old-receipt")
        host.target.chmod(0o600)
        host.block()
        requested = time.time()-0.1
        host.write_json(host.drain, {"action": "drain", "principal": host.operation, "suppress_notification": True,
            "requested_at": datetime.datetime.fromtimestamp(requested, datetime.timezone.utc).isoformat()})
        host.system("stop", *recover.UNITS)
        host.write_json(host.ops / "phase.json", {"operationId": host.operation, "phase": "recovery-blocked-needs-review",
            "updatedAt": datetime.datetime.fromtimestamp(time.time()+0.1, datetime.timezone.utc).isoformat()})
        host.events.clear()
        return host

    def resume(self, host):
        with mock.patch.object(recover, "qualified_input", return_value=b"new-receipt"):
            return host.resume_stopped()

    def test_resume_uses_stopped_audit_and_never_repeats_retirement_drain_or_stop(self):
        self.assertTrue(self.resume(self.host)["maintenanceCleared"])
        self.assertTrue((self.host.ops / "resume-attempt.json").is_file())
        self.assertFalse(any(e.startswith(("retire:", "stop:", "request-drain")) for e in self.host.events))
        self.assertEqual(sum(e.startswith("start:") for e in self.host.events), 1)
        self.assertEqual(self.host.old_gateway, 101)
        self.assertEqual(self.host.old_dashboard, 102)

    def test_normal_dashboard_sigterm_is_clean_but_other_owners_are_strict(self):
        host = self.host
        original = host.system
        def dashboard_term(action, *units):
            if action == "show" and units[0] == recover.UNITS[1] and "--property=ExecMainPID" not in units:
                return "Result=success\nExecMainCode=2\nExecMainStatus=15"
            return original(action, *units)
        host.system = dashboard_term
        host.verify_stopped(time.time()-1)
        for bad_unit in (recover.UNITS[0], recover.UNITS[2]):
            def other_term(action, *units):
                if action == "show" and units[0] == bad_unit:
                    return "Result=success\nExecMainCode=2\nExecMainStatus=15"
                return original(action, *units)
            host.system = other_term
            with self.assertRaises(AssertionError):
                host.verify_stopped(time.time()-1)

    def test_foreign_state_changed_receipt_lease_or_stopped_owner_refuses_before_consumption(self):
        for bad in ("state", "receipt", "lease", "drain", "record", "running", "baseline", "phase", "exec-pid"):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as directory:
                host = self.stopped(Path(directory))
                if bad == "state":
                    host.write_json(host.status_path, {"phase": "blocked", "maintenance": True, "operationId": "foreign"})
                elif bad == "receipt":
                    host.atomic(host.target, b"changed")
                elif bad == "lease":
                    host.write_json(host.lease, {"operationId": host.operation})
                elif bad == "drain":
                    value = json.loads(host.drain.read_text()); value["principal"] = "foreign"; host.write_json(host.drain, value)
                elif bad == "record":
                    host.native_record["code_sha"] = "5" * 40
                elif bad == "running":
                    host.pids[recover.UNITS[1]] = 999
                elif bad == "baseline":
                    value = json.loads((host.ops / "baseline.json").read_text()); value["receiptSha256"] = "wrong"; host.write_json(host.ops / "baseline.json", value)
                elif bad == "phase":
                    host.write_json(host.ops / "phase.json", {"operationId": host.operation, "phase": "admission-needs-review"})
                else:
                    original = host.system
                    host.system = lambda action, *units: "999" if "--property=ExecMainPID" in units else original(action, *units)
                with self.assertRaises(AssertionError):
                    self.resume(host)
                self.assertFalse((host.ops / "resume-attempt.json").exists())
                self.assertFalse(any(e.startswith("start:") for e in host.events))

    def test_failed_resume_consumes_attempt_and_cannot_replay(self):
        self.host.fail = "doctor"
        with self.assertRaises(RuntimeError):
            self.resume(self.host)
        self.assertTrue((self.host.ops / "resume-attempt.json").exists())
        events = list(self.host.events)
        with self.assertRaises(AssertionError):
            self.resume(self.host)
        self.assertEqual(self.host.events, events)


class GuardedFinishTests(unittest.TestCase):
    setUp = StoppedResumeTests.setUp
    stopped = StoppedResumeTests.stopped
    resume = StoppedResumeTests.resume

    def running(self):
        host = self.host
        host.fail = "doctor"
        with self.assertRaises(RuntimeError):
            self.resume(host)
        (host.ops / "resume-attempt.json").chmod(0o600)
        host.write_json(host.ops / "phase.json", {"operationId": host.operation,
            "phase": "recovery-blocked-needs-review", "updatedAt": "now"})
        host.fail = None
        host.events.clear()
        return host

    def finish(self, host):
        with mock.patch.object(recover, "qualified_input", return_value=b"new-receipt"):
            return host.finish_guarded()

    def test_finish_verifies_running_owners_and_opens_without_service_or_receipt_replay(self):
        host = self.running()
        self.assertTrue(self.finish(host)["maintenanceCleared"])
        self.assertTrue((host.ops / "finish-attempt.json").exists())
        self.assertFalse(any(e.startswith(("start:", "stop:", "retire:", "request-drain")) for e in host.events))
        self.assertLess(host.events.index("doctor"), host.events.index("guarded-finish-consumed"))
        self.assertLess(host.events.index("guarded-finish-consumed"), host.events.index("rpc:release"))
        self.assertEqual(host.target.read_bytes(), b"new-receipt")

    def test_wrong_gate_changed_receipt_and_uncertain_phase_refuse_before_finish_marker(self):
        for bad in ("gate", "receipt", "phase", "pid"):
            with self.subTest(bad=bad):
                host = self.running()
                if bad == "gate":
                    host.write_json(host.lease, {"operationId": "foreign"})
                elif bad == "receipt":
                    host.atomic(host.target, b"changed")
                elif bad == "phase":
                    host.write_json(host.ops / "phase.json", {"operationId": host.operation, "phase": "admission-needs-review"})
                else:
                    host.pids[recover.UNITS[1]] = 0
                with self.assertRaises(AssertionError):
                    self.finish(host)
                self.assertFalse((host.ops / "finish-attempt.json").exists())
                self.assertNotIn("rpc:release", host.events)
                # Each mismatch is a separate already-guarded fixture.
                self.temp.cleanup()
                self.temp = tempfile.TemporaryDirectory()
                self.addCleanup(self.temp.cleanup)
                self.host = self.stopped(Path(self.temp.name))

    def test_pid_replacement_during_doctor_refuses_release_before_marker(self):
        host = self.running()
        original = host.f["run"]
        def run(*args, **kwargs):
            original(*args, **kwargs)
            host.pids[recover.UNITS[1]] = 999
        host.f["run"] = run
        with self.assertRaises(AssertionError):
            self.finish(host)
        self.assertFalse((host.ops / "finish-attempt.json").exists())
        self.assertNotIn("rpc:release", host.events)

    def test_unknown_release_consumes_finish_marker_and_refuses_replay(self):
        host = self.running()
        host.fail = "rpc:release"
        with self.assertRaises(RuntimeError):
            self.finish(host)
        self.assertTrue((host.ops / "finish-attempt.json").exists())
        events = list(host.events)
        with self.assertRaises(AssertionError):
            self.finish(host)
        self.assertEqual(host.events, events)
        self.assertEqual(host.events[-1], "admission-needs-review")


if __name__ == "__main__":
    unittest.main()
