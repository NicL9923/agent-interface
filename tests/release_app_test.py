"""Release wrapper rules and host programs, against temporary directories only."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_app", ROOT / ".agents/tools/release-app.py")
release_app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_app)


def run_remote(program, payload):
    """Execute a host program locally, exactly as the wrapper sends it over SSH."""
    source = release_app.REMOTE_PRELUDE + f"PAYLOAD = json.loads({json.dumps(json.dumps(payload))})\n" + program
    done = subprocess.run(["python3", "-"], input=source, capture_output=True, text=True)
    return done.returncode, done.stdout.strip().splitlines()[-1] if done.stdout.strip() else "", done.stderr


class Host:
    """A minimal application directory shaped like the production layout."""

    def __init__(self, root):
        self.base = root / "app"
        self.home = root / "hermes"
        for path in ("operations", "releases/release-live", "shared/upgrade-state"):
            (self.base / path).mkdir(parents=True)
        self.home.mkdir()
        (self.base / "current").symlink_to(self.base / "releases/release-live")
        self.source = root / "source"
        self.source.mkdir()
        git = lambda *args: subprocess.run(["git", "-C", str(self.source), *args], check=True, capture_output=True)
        git("init", "-q"); (self.source / "auth.py").write_text("original\n"); git("add", ".")
        git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "base")
        (self.source / "auth.py").write_text("repaired\n")
        self.profile = self.home / "config.yaml"
        self.profile.write_text("model: default\n")
        (self.base / "shared/hermes-worker.json").write_text(json.dumps({"appRoot": str(self.base / "releases/release-live"), "qualificationReceipt": "receipt"}))
        self.status({"phase": "idle", "maintenance": False})

    def status(self, value):
        (self.base / "shared/upgrade-state/status.json").write_text(json.dumps(value))

    def deployment(self, name, operation, succeeded, **extra):
        config = {"operationId": operation, "upgradeStateDir": str(self.base / "shared/upgrade-state"),
                  "maintenanceFile": str(self.home / "maintenance.json"), "hermesHome": str(self.home),
                  "profileHashes": {str(self.profile): "old"}, "source": str(self.source), **extra}
        (self.base / "operations" / name).mkdir()
        (self.base / "operations" / name / "deploy-config.json").write_text(json.dumps(config))
        if succeeded:
            (self.base / "operations" / f"continued-{operation}").mkdir()
            (self.base / "operations" / f"continued-{operation}" / "result.json").write_text("{}")
        return config


PRIOR = {
    "appBase": "/srv/app", "release": "/srv/app/releases/old", "expectedRelease": "/srv/app/releases/older",
    "operationId": "11111111-1111-4111-8111-111111111111", "webBuild": "aaaaaaaaaaaaaaaa",
    "node": "/srv/app/runtime/node", "qualificationReceipt": "/srv/app/shared/hermes-qualified.json",
    "newQualificationReceipt": "/srv/app/operations/old/qualification.json",
    "newWorkerConfig": {"appRoot": "/srv/app/releases/old", "qualificationReceipt": "/srv/app/shared/hermes-qualified.json"},
    "profileHashes": {"/home/config.yaml": "old"}, "fixedHelperSha256": "helper", "hermesRevision": "d23" * 13 + "d",
    "repairSha256": "repair", "discordConnections": ["discord"], "appOrigin": "https://app.example.test",
}


class ReleaseRules(unittest.TestCase):
    def config(self, **overrides):
        values = dict(release="/srv/app/releases/new", current="/srv/app/releases/old", operation="op-2",
                      web_build="bbbbbbbbbbbbbbbb", worker={"appRoot": "/srv/app/releases/old", "qualificationReceipt": "q", "live": True},
                      profile_hashes={"/home/config.yaml": "now", "/unrelated": "x"}, helper_sha="helper",
                      hermes_revision=PRIOR["hermesRevision"], repair_sha=PRIOR["repairSha256"])
        values.update(overrides)
        return release_app.derive_config(PRIOR, **values)

    def test_carries_settings_and_replaces_only_release_fields(self):
        config = self.config()
        changed = {key for key in PRIOR if config.get(key) != PRIOR[key]}
        self.assertEqual(changed, {"release", "expectedRelease", "operationId", "webBuild", "newWorkerConfig",
                                   "profileHashes", "newQualificationReceipt"})
        self.assertNotIn("newQualificationReceipt", config, "A previous release's fresh receipt is never reused")
        self.assertEqual(config["expectedRelease"], "/srv/app/releases/old")
        self.assertEqual(config["newWorkerConfig"], {"appRoot": "/srv/app/releases/new", "qualificationReceipt": "q", "live": True})
        self.assertEqual(config["profileHashes"], {"/home/config.yaml": "now"})

    def test_installed_hermes_comes_from_live_state(self):
        config = self.config(hermes_revision="e" * 40, repair_sha="new-repair")
        self.assertEqual((config["hermesRevision"], config["repairSha256"]), ("e" * 40, "new-repair"))

    def test_settled_update_phases_count_as_clear(self):
        clear = {"maintenance": False, "leasePresent": False, "drainPresent": False}
        for phase in ("idle", "succeeded", "rolled_back", "cancelled"):
            self.assertTrue(release_app.maintenance_clear({**clear, "phase": phase}), phase)
        self.assertFalse(release_app.maintenance_clear({**clear, "phase": "installing"}))
        self.assertFalse(release_app.maintenance_clear({**clear, "phase": "idle", "maintenance": True}))
        self.assertFalse(release_app.maintenance_clear({**clear, "phase": "idle", "drainPresent": True}))

    def test_supplied_qualification_is_activated_with_the_release(self):
        self.assertEqual(self.config(qualification="/srv/q.json")["newQualificationReceipt"], "/srv/q.json")

    def facts(self, **overrides):
        return {"prior": PRIOR, "maintenance": False, "leasePresent": False, "drainPresent": False,
                "upgradePhase": "idle", **overrides}

    def built(self, **overrides):
        return {"webBuild": "bbbbbbbbbbbbbbbb", "helperSha256": "helper",
                "receipt": {"valid": True, "error": None}, **overrides}

    def problems(self, facts=None, built=None, **options):
        return release_app.preparation_problems(
            facts or self.facts(), built or self.built(),
            **{"local_web_build": "bbbbbbbbbbbbbbbb", "qualification": None, "accept_helper_change": False, **options})

    def test_ready_release_has_no_problems(self):
        self.assertEqual(self.problems(), [])

    def test_refuses_unsafe_or_mismatched_releases(self):
        self.assertIn("Maintenance is active", self.problems(self.facts(leasePresent=True))[0])
        self.assertIn("installing", self.problems(self.facts(upgradePhase="installing"))[0])
        self.assertIn("local build", self.problems(local_web_build="cccccccccccccccc")[0])
        stale = self.built(receipt={"valid": False, "error": "digest differs"})
        self.assertIn("--qualification", self.problems(built=stale)[0])
        self.assertNotIn("--qualification", self.problems(built=stale, qualification="/srv/q.json")[0])

    def test_upgrade_helper_changes_need_explicit_review(self):
        changed = self.built(helperSha256="new-helper")
        self.assertIn("--accept-helper-change", self.problems(built=changed)[0])
        self.assertEqual(self.problems(built=changed, accept_helper_change=True), [])

    def test_names_and_build_versions(self):
        now = datetime.datetime(2026, 10, 1, 20, 49, 5, tzinfo=datetime.timezone.utc)
        self.assertEqual(release_app.release_name("7fac68e44e7d", now), "release-7fac68e4-20261001T204905Z")
        log = "Built service worker 974365546ec56e79 with 7 static files.\nBuilt service worker 3dc4598be2f7b72b with 7 static files."
        self.assertEqual(release_app.built_web_version(log), "3dc4598be2f7b72b")
        with self.assertRaises(ValueError):
            release_app.built_web_version("vite build failed")
        self.assertEqual(release_app.merged_pull_request("Merge pull request #8 from owner/branch"), 8)
        self.assertIsNone(release_app.merged_pull_request("Direct commit"))

    def test_records_reused_and_fresh_qualification(self):
        manifest = {"name": "release-7fac68e4-x", "commit": "7fac68e44e7d" + "0" * 28, "origin": "https://app.example.test",
                    "webBuild": "bbbbbbbbbbbbbbbb", "archiveSha256": "f" * 64, "hermesRevision": PRIOR["hermesRevision"],
                    "qualification": "reused", "pullRequest": 8}
        entry = release_app.ledger_entry(manifest, "production-release-7fac68e4-x.json", datetime.date(2026, 10, 1))
        self.assertTrue(entry.startswith("## October 1 app release 7fac68e\n"))
        self.assertIn("PR #8 merged", entry)
        self.assertIn("(evidence/production-release-7fac68e4-x.json)", entry)
        self.assertIn("existing qualification receipt", entry)
        fresh = release_app.ledger_entry({**manifest, "qualification": "new", "pullRequest": None}, "r.json", datetime.date(2026, 10, 1))
        self.assertIn("fresh qualification receipt", fresh)
        receipt = release_app.production_receipt(manifest, {"webBuild": "bbbbbbbbbbbbbbbb"}, {"maintenanceCleared": True})
        self.assertEqual(receipt["sourceCommit"], manifest["commit"])
        self.assertTrue(receipt["maintenanceCleared"] and receipt["preflightCheckPassed"])


class Activation(unittest.TestCase):
    NAME = "release-7fac68e4-x"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        (root / "docs/evidence").mkdir(parents=True)
        (root / "docs/ValidationLedger.md").write_text("# Validation ledger\n\n## Earlier release\n")
        self.saved = (release_app.ROOT, release_app.MANIFESTS, release_app.guarded,
                      release_app.verify_release, release_app.remote)
        release_app.ROOT, release_app.MANIFESTS = root, root / ".private/releases"
        self.root = root
        self.live = {"current": "/srv/app/releases/old", "workerSha256": "worker"}
        release_app.remote = lambda host, program, payload: self.live
        release_app.save_manifest({"name": self.NAME, "status": "prepared", "host": "host",
            "commit": "7fac68e44e7d" + "0" * 28, "origin": "https://app.example.test", "webBuild": "b" * 16,
            "archiveSha256": "f" * 64, "hermesRevision": PRIOR["hermesRevision"], "qualification": "reused",
            "pullRequest": 8, "appBase": "/srv/app", "operationId": "op",
            "expectedRelease": "/srv/app/releases/old", "workerSha256": "worker"})

    def tearDown(self):
        (release_app.ROOT, release_app.MANIFESTS, release_app.guarded,
         release_app.verify_release, release_app.remote) = self.saved
        self.temporary.cleanup()

    def status(self):
        return release_app.load_manifest(self.NAME)["status"]

    def evidence(self):
        return list((self.root / "docs/evidence").iterdir())

    def activate(self, guarded, checks):
        release_app.guarded = guarded
        release_app.verify_release = lambda manifest: (checks, None)
        release_app.main(["activate", self.NAME])

    def test_records_a_verified_release(self):
        self.activate(lambda host, manifest, check: {"webBuild": "b" * 16}, {"maintenanceCleared": True})
        ledger = (self.root / "docs/ValidationLedger.md").read_text()
        self.assertTrue(ledger.startswith("# Validation ledger\n\n## "))
        self.assertLess(ledger.index("app release 7fac68e"), ledger.index("## Earlier release"))
        receipt = json.loads((self.root / f"docs/evidence/production-{self.NAME}.json").read_text())
        self.assertEqual((receipt["release"], receipt["webBuild"]), (self.NAME, "b" * 16))
        self.assertEqual(self.status(), "recorded")

    def test_refuses_when_live_state_changed_since_preparation(self):
        self.live["workerSha256"] = "edited"
        with self.assertRaises(SystemExit):
            self.activate(lambda *_, **__: self.fail("must not activate"), {})
        self.assertEqual(self.status(), "prepared")

    def test_failed_or_interrupted_activation_is_held_for_review(self):
        with self.assertRaises(SystemExit):
            self.activate(lambda *_, **__: None, {})
        self.assertEqual(self.status(), "needs-review")
        release_app.save_manifest({**release_app.load_manifest(self.NAME), "status": "prepared"})
        def lost(*_, **__):
            raise subprocess.TimeoutExpired("ssh", 1800)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.activate(lost, {})
        self.assertEqual(self.status(), "needs-review")
        self.assertEqual(self.evidence(), [])
        for command in ("activate", "discard"):
            with self.assertRaises(SystemExit):
                release_app.main([command, self.NAME])

    def test_failed_post_release_check_can_be_recorded_later(self):
        with self.assertRaises(SystemExit):
            self.activate(lambda *_, **__: {"webBuild": "b" * 16}, {"maintenanceCleared": False})
        self.assertEqual((self.status(), self.evidence()), ("activated", []))
        release_app.verify_release = lambda manifest: ({"maintenanceCleared": True}, None)
        release_app.main(["record", self.NAME])
        self.assertEqual(self.status(), "recorded")
        self.assertEqual(len(self.evidence()), 1)
        with self.assertRaises(SystemExit):
            release_app.main(["record", self.NAME])


class HostPrograms(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.host = Host(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def test_facts_carry_the_latest_successful_release(self):
        older = self.host.deployment("older", "op-1", True, node="old-node")
        os.utime(self.host.base / "operations/continued-op-1/result.json", (time.time() - 60,) * 2)
        self.host.deployment("latest", "op-2", True, node="new-node")
        self.host.deployment("abandoned", "op-3", False, node="abandoned-node")
        code, output, error = run_remote(release_app.REMOTE_FACTS, {"appBase": str(self.host.base)})
        self.assertEqual(code, 0, error)
        facts = json.loads(output)
        self.assertEqual(facts["prior"]["node"], "new-node")
        self.assertEqual(facts["current"], str((self.host.base / "releases/release-live").resolve()))
        self.assertEqual(facts["profileHashes"], {str(self.host.profile): hashlib.sha256(b"model: default\n").hexdigest()})
        self.assertFalse(facts["maintenance"] or facts["leasePresent"] or facts["drainPresent"])
        self.assertEqual(older["node"], "old-node")
        head = subprocess.check_output(["git", "-C", str(self.host.source), "rev-parse", "HEAD"], text=True).strip()
        repair = subprocess.check_output(["git", "-C", str(self.host.source), "diff", "HEAD", "--binary"])
        self.assertEqual((facts["hermesRevision"], facts["repairSha256"]), (head, hashlib.sha256(repair).hexdigest()))
        self.assertEqual(facts["workerSha256"], hashlib.sha256((self.host.base / "shared/hermes-worker.json").read_bytes()).hexdigest())

    def test_facts_report_active_maintenance(self):
        self.host.deployment("latest", "op-2", True)
        self.host.status({"phase": "blocked", "maintenance": True})
        (self.host.home / ".drain_request.json").write_text("{}")
        facts = json.loads(run_remote(release_app.REMOTE_FACTS, {"appBase": str(self.host.base)})[1])
        self.assertTrue(facts["maintenance"] and facts["drainPresent"])

    def test_facts_refuse_without_a_successful_release(self):
        self.host.deployment("abandoned", "op-3", False)
        code, _, error = run_remote(release_app.REMOTE_FACTS, {"appBase": str(self.host.base)})
        self.assertNotEqual(code, 0)
        self.assertIn("No successful guarded release", error)

    def test_configuration_is_private_and_never_overwritten(self):
        path = self.host.base / "operations/deploy-config.json"
        self.assertEqual(run_remote(release_app.REMOTE_WRITE_CONFIG, {"path": str(path), "config": {"a": 1}})[0], 0)
        self.assertEqual(json.loads(path.read_text()), {"a": 1})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(run_remote(release_app.REMOTE_WRITE_CONFIG, {"path": str(path), "config": {"a": 2}})[0], 0)
        self.assertEqual(json.loads(path.read_text()), {"a": 1})

    def test_discard_removes_only_an_unactivated_release(self):
        release = self.host.base / "releases/release-new"
        operation = self.host.base / "operations/release-new"
        release.mkdir(); operation.mkdir()
        payload = {"appBase": str(self.host.base), "release": str(release), "operationDir": str(operation), "operationId": "op-9"}
        live = dict(payload, release=str(self.host.base / "releases/release-live"))
        self.assertNotEqual(run_remote(release_app.REMOTE_DISCARD, live)[0], 0)
        self.assertTrue((self.host.base / "releases/release-live").exists())
        import fcntl
        with open(self.host.base / "shared/upgrade-state/worker.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            code, _, error = run_remote(release_app.REMOTE_DISCARD, dict(payload, upgradeStateDir=str(self.host.base / "shared/upgrade-state")))
            self.assertNotEqual(code, 0)
            self.assertIn("operation is running", error)
            self.assertTrue(release.exists())
        self.assertEqual(run_remote(release_app.REMOTE_DISCARD, dict(payload, upgradeStateDir=str(self.host.base / "shared/upgrade-state")))[0], 0)
        self.assertFalse(release.exists() or operation.exists())


if __name__ == "__main__":
    unittest.main()
