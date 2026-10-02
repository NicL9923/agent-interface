"""Receipt-only native recovery, using disposable files and fake service owners."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

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
                  "hermesRevision": "5" * 40, "repairSha256": "a" * 64, "node": "node"}
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

    def check_requests(self):
        self.note("pending-requests-clear")

    def system(self, action, *units):
        if action == "show":
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


if __name__ == "__main__":
    unittest.main()
