"""Temporary-host tests. No real service, network, or production home is touched."""
import contextlib
import datetime as dt
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from support import load_source

ROOT = Path(__file__).resolve().parents[1]
linux = load_source("scripts/hermes-upgrade-linux.py", "linux_upgrade")


class FixturePlatform(linux.Platform):
    def native(self, action, **values):
        if action != "drain": raise AssertionError(action)
        value = {"principal": values["principal"], "requested_at": dt.datetime.now(dt.timezone.utc).isoformat()}
        linux.atomic(self.home / ".drain_request.json", value)
        self.write_gateway("draining")
        return value

    def write_gateway(self, state):
        units = json.loads(self.states.read_text())
        linux.atomic(self.home / "gateway_state.json", {"pid": int(units["gateway.service"]["MainPID"]),
            "agent_interface_gateway_guard": {"schemaVersion": 1, "maintenanceFile": self.config["maintenanceFile"], "pendingIngress": self.pending_ingress}, "hermes_home": str(self.home), "code_sha": self.source_state()[0], "gateway_state": state, "active_agents": self.active_work, "active_work": None,
            "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "platforms": {key: {"state": "connected"} for key in self.config["discordConnections"]}})

    def rpc(self, method):
        self.rpc_calls.append(method)
        if method == "acquire":
            self.gate = True
            linux.atomic(self.config["maintenanceFile"], {"operationId": self.operation})
        if method == "release":
            self.gate = False
            Path(self.config["maintenanceFile"]).unlink(missing_ok=True)
        return {"active": self.gate, "operationId": self.operation if self.gate else None, "busy": []}

    def clear_drain(self):
        super().clear_drain()
        self.write_gateway("running")

    def control(self, verb):
        super().control(verb)
        if verb == "start":
            # A real gateway takes a while after starting before it reports its state.
            if getattr(self, "start_delay", 0):
                self.write_gateway("starting")
                timer = threading.Timer(self.start_delay, self.write_gateway, ("draining",)); timer.start()
                self.timers = [*getattr(self, "timers", []), timer]
            else: self.write_gateway("draining")

    def google(self): return {"authenticatedHttp": True, "freshWebsocket": True}
    def wait_dashboard(self): self.rpc_calls.append("dashboard-ready")
    def anonymous_rejection(self): pass
    def runtime(self, expected=None):
        # The real inspection runs in the launcher's interpreter, so it binds that selection too.
        self.store_python()
        value = {"interpreterSha256": "fixed-python", "dependenciesSha256": "fixed-generation"}
        if expected is not None and value != expected: raise RuntimeError("Untested runtime")
        return value
    def sync(self): return {"ok": True, "state": "synced"}


class HostFixture(unittest.TestCase):
    """A temporary Hermes host: source, home, stage, fake systemctl and store interpreters."""
    platform_type = FixturePlatform

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.home = self.directory / "native-home"; self.home.mkdir(mode=0o700)
        self.source = self.home / "hermes-agent"; self.source.mkdir()
        self.stage_root = self.directory / "stages"; self.stage_root.mkdir(mode=0o700)
        self.stage = self.stage_root / str(uuid.uuid4()); self.stage.mkdir(mode=0o700)
        self.target = self.stage / "source"
        for name, data in {".gitignore": ".hermes/\n", "app.py": "old runtime\n", "repair.py": "repair old\n", "pyproject.toml": "fixed deps\n", "uv.lock": "fixed lock\n"}.items():
            (self.source / name).write_text(data)
        self.git("init", "--initial-branch=main"); self.git("config", "user.email", "fixture@example.test"); self.git("config", "user.name", "Fixture")
        self.git("add", "."); self.git("commit", "-m", "old")
        self.old = self.git("rev-parse", "HEAD").strip()
        (self.source / "app.py").write_text("new runtime\n")
        self.git("commit", "-am", "candidate")
        self.candidate = self.git("rev-parse", "HEAD").strip()
        self.git("reset", "--hard", self.old)
        (self.source / "repair.py").write_text("repair fixed\n")
        (self.source / "staged-repair.py").write_text("new approved regression\n")
        self.git("add", "staged-repair.py")
        subprocess.run(["git", "clone", "--quiet", str(self.source), str(self.target)], check=True)
        subprocess.run(["git", "-C", str(self.target), "checkout", "--quiet", "--detach", self.candidate], check=True)
        (self.target / "repair.py").write_text("repair fixed\n")
        (self.target / "staged-repair.py").write_text("new approved regression\n")
        subprocess.run(["git", "-C", str(self.target), "add", "staged-repair.py"], check=True)
        (self.home / "config.yaml").write_text("model: chosen\nskills:\n  disabled: [intentional]\n")
        (self.home / ".env").write_text("MODEL_KEY=never-print\n")
        (self.home / "auth.json").write_text("old-rotating-token")
        for name in ("installs", "tools"):
            (self.home / name).mkdir(); (self.home / name / "selected.json").write_text("old generation")
        self.service_env = self.directory / "service.env"
        self.service_env.write_text("HERMES_AGENT_INTERFACE_TOKEN=" + "a" * 43 + "\nHERMES_AGENT_INTERFACE_MAINTENANCE_FILE=" + str(self.home / "maintenance.json") + "\n"); self.service_env.chmod(0o600)
        self.unit_file = self.directory / "native.service"; self.unit_file.write_text("native unit unchanged")
        self.states = self.directory / "units.json"
        self.states.write_text(json.dumps({name: {"ActiveState": "active", "SubState": "running", "MainPID": str(100 + n),
            "FragmentPath": str(self.unit_file), "ControlGroup": "/fixture/" + name} for n, name in enumerate(("gateway.service", "dashboard.service", "app.service"))}))
        self.systemctl = self.directory / "systemctl"
        self.systemctl.write_text("#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\np=Path(" + repr(str(self.states)) + ")\ns=json.loads(p.read_text())\nverb,unit=sys.argv[2:4]\nif verb=='show':\n for k,v in s[unit].items(): print(k+'='+v)\nelse:\n s[unit]['ActiveState']='inactive' if verb=='stop' else 'active'\n s[unit]['MainPID']='0' if verb=='stop' else '200'\n p.write_text(json.dumps(s))\n")
        self.systemctl.chmod(0o700)
        # Two native store interpreters, as Hermes PM keeps them side by side across updates.
        self.pythons = {}
        for version in ("3.14.7", "3.14.9"):
            python = self.home / "tools" / ("python-" + version) / "bin/python3"; python.parent.mkdir(parents=True)
            python.write_text("#!/bin/sh\nexec " + shlex.quote(os.sys.executable) + ' "$@"\n'); python.chmod(0o700)
            self.pythons[version] = str(python)
        self.selection = self.directory / "selected-python"
        self.select("3.14.7")
        self.launcher = self.source / ".hermes/bin/hermes"; self.launcher.parent.mkdir(parents=True)
        self.launcher.write_text("#!/bin/sh\nprintf '[\"%s\",\"-I\"]\\n' \"$(cat " + shlex.quote(str(self.selection)) + ')"\n'); self.launcher.chmod(0o700)
        self.config = self.directory / "platform.json"
        linux.atomic(self.config, {"source": str(self.source), "hermesHome": str(self.home), "managedLauncher": str(self.launcher),
            "managedPython": self.pythons["3.14.7"], "serviceEnvFile": str(self.service_env), "qualificationReceipt": str(self.directory / "deployed-receipt.json"),
            "maintenanceFile": str(self.home / "maintenance.json"), "stageRoot": str(self.stage_root), "systemctl": str(self.systemctl),
            "dashboardOrigin": "http://127.0.0.1:9119", "dashboardPort": 9119, "gatewayUnit": "gateway.service", "dashboardUnit": "dashboard.service", "appUnit": "app.service",
            "regressionPython": "/usr/bin/python3", "regressionCommands": {"sharedOAuth": ["/usr/bin/python3", "-c", "pass"], "googleAuth": ["/usr/bin/python3", "-c", "pass"]}, "googleVerificationCommand": ["/usr/bin/true"],
            "discordConnections": ["discord", "second:discord"], "drainAcknowledgeSeconds": 0})
        self.environment = dict(os.environ, HERMES_UPDATE_HANDOFF_PID=str(os.getpid()), HERMES_UPGRADE_OPERATION_ID=str(uuid.uuid4()), HERMES_UPGRADE_SOURCE=str(self.source), HERMES_UPGRADE_CURRENT=self.old,
            HERMES_UPGRADE_CANDIDATE=self.candidate, HERMES_UPGRADE_STAGE_HOME=str(self.stage), HERMES_UPGRADE_STAGE_SOURCE=str(self.target),
            HERMES_UPGRADE_BACKUP_DIR=str(self.stage / "backup"), HERMES_UPGRADE_RECEIPT=str(self.stage / "qualification.json"), HERMES_UPGRADE_QUALIFICATION_PYTHON=os.sys.executable, HERMES_UPGRADE_RUNTIME_FINGERPRINT=json.dumps({"interpreterSha256": "fixed-python", "dependenciesSha256": "fixed-generation"}))
        self.environment["HERMES_UPGRADE_INTEGRATION_DIGEST"] = "a" * 64
        self.platform = self.platform_type(self.config, self.environment)
        self.platform.states = self.states; self.platform.rpc_calls = []; self.platform.gate = False; self.platform.active_work = 0; self.platform.pending_ingress = 0
        self.platform.write_gateway("running")
        linux.atomic(self.stage / "qualification.json", {"revision": self.candidate, "trackedPatchSha256": self.platform.source_state(self.target)[1]})

    def tearDown(self): self.temp.cleanup()
    def select(self, version): self.selection.write_text(self.pythons.get(version, version))
    def git(self, *args): return subprocess.check_output(["git", "-C", str(self.source), *args], stderr=subprocess.PIPE).decode()

    def baseline_receipt(self):
        receipt = {"schemaVersion": 1, "revision": self.old,
            "trackedPatchSha256": self.platform.source_state()[1], "integrationDigest": "a" * 64,
            "qualifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "checks": {"realIntegration": True, "hostRegressions": True}}
        previous = self.stage / "previous-qualification.json"
        linux.atomic(previous, receipt)
        self.platform.env["HERMES_UPGRADE_PREVIOUS_RECEIPT"] = str(previous)
        return receipt


class PlatformTests(HostFixture):
    def test_recovery_restores_crashed_cutover_from_saved_baseline_and_preserves_tokens(self):
        receipt = self.baseline_receipt()
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        (self.home / "auth.json").write_text("new rotating token")
        # A process crash can leave both services stopped and source incomplete.
        self.platform.control("stop"); shutil.rmtree(self.source)
        self.platform.recover()
        self.assertEqual(self.platform.source_state()[0], self.old)
        self.assertEqual((self.home / "auth.json").read_text(), "new rotating token")
        self.assertEqual(json.loads(Path(self.platform.config["qualificationReceipt"]).read_text()), receipt)
        self.assertFalse(self.platform.gate)
        self.assertEqual(self.platform.load()["phase"], "finished")

    def test_restart_service_recovers_legacy_candidate_with_exact_qualification(self):
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        candidate = self.platform.source_state()
        linux.atomic(self.platform.config["qualificationReceipt"], {"schemaVersion": 1, "revision": candidate[0], "trackedPatchSha256": candidate[1],
            "integrationDigest": "a" * 64, "qualifiedAt": "2026-10-01", "checks": {"realIntegration": True, "hostRegressions": True}})
        self.platform.restart_service()
        self.assertEqual(self.platform.source_state(), candidate)
        self.assertFalse(self.platform.gate)

    def test_recovery_refuses_lost_owner_active_work_and_ambiguous_release(self):
        self.baseline_receipt(); self.platform.quiescence(); self.platform.backup(); self.platform.install()
        before = self.platform.source_state()
        linux.atomic(self.platform.config["maintenanceFile"], {"operationId": str(uuid.uuid4())})
        with self.assertRaisesRegex(RuntimeError, "belongs to another"): self.platform.recover()
        linux.atomic(self.platform.config["maintenanceFile"], {"operationId": self.platform.operation})
        self.platform.active_work = 1; self.platform.write_gateway("draining")
        with self.assertRaises(linux.ActiveWork): self.platform.recover()
        self.platform.active_work = 0; self.platform.write_gateway("draining")
        self.platform.save(dict(self.platform.load(), phase="releasing"))
        with self.assertRaisesRegex(RuntimeError, "Admission may have reopened"): self.platform.recover()
        self.assertEqual(self.platform.source_state(), before)
        self.assertTrue(self.platform.gate)

    def test_recovery_rejects_missing_old_receipt_and_changed_unit_before_stopping_services(self):
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        units = self.states.read_bytes()
        with self.assertRaises(FileNotFoundError): self.platform.recover()
        self.assertEqual(self.states.read_bytes(), units)
        receipt = self.baseline_receipt()
        receipt["revision"] = self.candidate
        linux.atomic(self.platform.env["HERMES_UPGRADE_PREVIOUS_RECEIPT"], receipt)
        with self.assertRaisesRegex(RuntimeError, "qualification"): self.platform.recover()
        self.assertEqual(self.states.read_bytes(), units)
        self.unit_file.write_text("changed service")
        with self.assertRaisesRegex(RuntimeError, "service identity changed"): self.platform.restart_service()
        self.assertEqual(self.states.read_bytes(), units)

    def test_cold_backup_exact_install_verify_and_finish_preserve_native_settings(self):
        baseline = self.platform.settings()
        self.platform.quiescence(); self.platform.backup()
        self.assertEqual(self.platform.load()["phase"], "backed_up")
        self.assertEqual(json.loads(self.states.read_text())["app.service"]["MainPID"], "102")
        self.platform.install(); self.platform.verify(); self.platform.finish()
        self.assertEqual(self.platform.source_state(), self.platform.source_state(self.target))
        self.assertEqual(self.git("diff", "--cached", "--name-only", "--", "staged-repair.py").strip(), "staged-repair.py")
        self.assertEqual(self.platform.settings(), baseline)
        self.assertFalse(self.platform.gate)
        self.assertFalse((self.home / ".drain_request.json").exists())

    def test_detached_worker_addresses_its_own_user_service_manager(self):
        environment = {key: value for key, value in self.environment.items()
                       if key not in ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")}
        platform = linux.Platform(self.config, environment)
        self.systemctl.write_text("#!/usr/bin/env python3\nimport os\n"
            "assert os.environ['XDG_RUNTIME_DIR'] == '/run/user/' + str(os.getuid())\n"
            "assert os.environ['DBUS_SESSION_BUS_ADDRESS'] == 'unix:path=' + os.environ['XDG_RUNTIME_DIR'] + '/bus'\n"
            "print('ActiveState=active\\nMainPID=100\\nFragmentPath=" + str(self.unit_file) + "')\n")
        self.assertEqual(platform.unit("gatewayUnit")["MainPID"], "100")

    def test_active_or_unknown_work_refusal_releases_gate_without_stopping_services(self):
        for active in (1, "unknown"):
            self.platform.active_work = active
            self.platform.write_gateway("running")
            before = self.states.read_bytes()
            with self.assertRaises(SystemExit) as refusal: self.platform.quiescence()
            self.assertEqual(refusal.exception.code, 75)
            self.assertEqual(self.states.read_bytes(), before)
            self.assertFalse(self.platform.gate)
            self.assertFalse((self.home / ".drain_request.json").exists())

    def test_failed_baseline_is_a_harmless_refusal(self):
        # An expired verification session fails the read-only baseline before anything is held.
        def google(): raise RuntimeError("Original Google HTTP and fresh WebSocket authentication were not verified")
        self.platform.google = google
        before = self.states.read_bytes()
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), self.assertRaises(SystemExit) as refusal: self.platform.quiescence()
        self.assertEqual(refusal.exception.code, 75)
        self.assertIn("Quiescence refused before maintenance: Original Google HTTP", errors.getvalue())
        self.assertEqual(self.states.read_bytes(), before)
        self.assertFalse(self.platform.gate)
        self.assertFalse(self.platform.record.exists())

    def test_a_missing_service_key_or_an_existing_drain_is_a_harmless_refusal(self):
        # Both are read before the gate is taken and change nothing, so neither may hold the update.
        marker, env = self.home / ".drain_request.json", self.service_env.read_text()
        def missing_key():
            self.service_env.write_text("HERMES_AGENT_INTERFACE_MAINTENANCE_FILE=" + str(self.home / "maintenance.json") + "\n")
        def existing_drain(): linux.atomic(marker, {"principal": "agent-interface:another-operation"})
        for name, setup, reason in (("service key", missing_key, "Private service key is missing or ambiguous"),
                                    ("drain marker", existing_drain, "An existing native drain requires installer review")):
            with self.subTest(name):
                self.service_env.write_text(env)
                setup()
                before, drain = self.states.read_bytes(), marker.read_bytes() if marker.exists() else None
                errors = io.StringIO()
                with contextlib.redirect_stderr(errors), self.assertRaises(SystemExit) as refusal: self.platform.quiescence()
                self.assertEqual(refusal.exception.code, 75)
                self.assertIn("Quiescence refused before maintenance: " + reason, errors.getvalue())
                self.assertEqual(self.states.read_bytes(), before)
                self.assertEqual(marker.read_bytes() if marker.exists() else None, drain)
                self.assertFalse(self.platform.rpc_calls)
                self.assertFalse(self.platform.record.exists())
                marker.unlink(missing_ok=True)

    def test_partial_clone_candidate_materializes_before_stop_and_installs_without_upstream(self):
        upstream = self.directory / "upstream"
        subprocess.run(["git", "clone", "--no-hardlinks", str(self.source), str(upstream)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for name in ("uploadpack.allowFilter", "uploadpack.allowAnySHA1InWant"):
            subprocess.run(["git", "-C", str(upstream), "config", name, "true"], check=True)
        partial = self.directory / "partial"
        subprocess.run(["git", "clone", "--filter=tree:0", "--no-checkout", upstream.as_uri(), str(partial)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(["git", "-C", str(partial), "checkout", "--detach", self.old],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(["git", "-C", str(upstream), "checkout", "--detach", self.candidate],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        (upstream / "candidate-only.txt").write_text("published after partial checkout")
        for argv in (["config", "user.email", "fixture@example.test"], ["config", "user.name", "Fixture"],
                ["add", "candidate-only.txt"], ["commit", "-m", "new candidate tree"]):
            subprocess.run(["git", "-C", str(upstream), *argv], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.candidate = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(self.target), "fetch", "--no-tags", upstream.as_uri(), self.candidate],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(["git", "-C", str(self.target), "checkout", "--detach", self.candidate],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.platform.candidate = self.candidate
        self.platform.env["HERMES_UPGRADE_CANDIDATE"] = self.candidate
        linux.atomic(self.stage / "qualification.json", {"revision": self.candidate, "trackedPatchSha256": self.platform.source_state(self.target)[1]})
        shutil.rmtree(self.source / ".git")
        shutil.move(str(partial / ".git"), self.source / ".git")
        self.git("add", "repair.py", "staged-repair.py")
        self.git("fetch", "--filter=tree:0", "origin", self.candidate)
        offline = dict(os.environ, GIT_NO_LAZY_FETCH="1")
        tree = self.git("cat-file", "-p", self.candidate).splitlines()[0].split()[1]
        missing = subprocess.run(["git", "-C", str(self.source), "cat-file", "-e", tree], env=offline,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        self.assertNotEqual(missing.returncode, 0, "The production fixture must lack the candidate tree")
        self.assertEqual(self.git("config", "--get", "remote.origin.partialclonefilter").strip(), "tree:0")
        self.platform.quiescence()
        before = {name: (self.source / ".git" / name).read_bytes() if (self.source / ".git" / name).exists() else None
            for name in ("config", "HEAD", "index", "shallow")}
        refs = self.git("for-each-ref")
        original_control = self.platform.control
        def control(action):
            if action == "stop":
                subprocess.run(["git", "-C", str(self.source), "cat-file", "-e", tree], env=offline, check=True)
                self.assertEqual(self.git("for-each-ref"), refs)
                for name, data in before.items():
                    self.assertEqual((self.source / ".git" / name).read_bytes() if (self.source / ".git" / name).exists() else None, data)
                shutil.rmtree(upstream)
            original_control(action)
        self.platform.control = control
        self.platform.backup()
        self.platform.install(); self.platform.verify(); self.platform.finish()
        self.assertEqual(self.platform.source_state(), self.platform.source_state(self.target))
        self.assertEqual((self.source / "app.py").read_text(), "new runtime\n")
        self.assertEqual(self.git("config", "--get", "remote.origin.promisor").strip(), "true")
        self.assertFalse(list(self.stage.glob("qualified-objects-*.pack")))

    def test_candidate_import_copies_only_objects_the_installed_store_lacks(self):
        new = [line.split()[0] for line in self.platform.git(self.target, "rev-list", "--objects", self.candidate, "^" + self.old).splitlines()]
        for oid in new[1:]: (self.source / ".git/objects" / oid[:2] / oid[2:]).unlink()
        self.platform.quiescence(); self.platform.backup()
        imported = [line.split()[1] for index in (self.source / ".git/objects/pack").glob("*.idx")
            for line in subprocess.check_output(["git", "show-index"], stdin=index.open("rb")).decode().splitlines()]
        self.assertEqual(sorted(imported), sorted(new[1:]))

    def test_regressions_import_the_candidate_objects_before_any_drain(self):
        new = [line.split()[0] for line in self.platform.git(self.target, "rev-list", "--objects", self.candidate, "^" + self.old).splitlines()]
        for oid in new[1:]: (self.source / ".git/objects" / oid[:2] / oid[2:]).unlink()
        refs, state = self.git("for-each-ref"), self.platform.source_state()
        original_run = self.platform.run
        self.platform.run = lambda argv, **kwargs: None if argv[0] == self.environment["HERMES_UPGRADE_QUALIFICATION_PYTHON"] else original_run(argv, **kwargs)
        self.platform.regressions()
        for oid in new: self.git("cat-file", "-e", oid)
        self.assertFalse((self.home / ".drain_request.json").exists())
        self.assertEqual((self.git("for-each-ref"), self.platform.source_state()), (refs, state))

    def test_regressions_keep_the_live_reserve_before_importing_objects(self):
        new = [line.split()[0] for line in self.platform.git(self.target, "rev-list", "--objects", self.candidate, "^" + self.old).splitlines()]
        for oid in new[1:]: (self.source / ".git/objects" / oid[:2] / oid[2:]).unlink()
        original_run = self.platform.run
        self.platform.run = lambda argv, **kwargs: None if argv[0] == self.environment["HERMES_UPGRADE_QUALIFICATION_PYTHON"] else original_run(argv, **kwargs)
        usage = shutil._ntuple_diskusage(100 * 1024 ** 3, 99 * 1024 ** 3, 1024 ** 3)
        with patch.object(linux.shutil, "disk_usage", return_value=usage), self.assertRaisesRegex(RuntimeError, "needs about .* GB free"):
            self.platform.regressions()
        offline = dict(os.environ, GIT_NO_LAZY_FETCH="1")
        self.assertNotEqual(subprocess.run(["git", "-C", str(self.source), "cat-file", "-e", new[1]], env=offline,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode, 0)

    def test_timeouts_name_the_command_but_no_paths(self):
        error = subprocess.TimeoutExpired(["git", "-C", "/home/private/source", "-c", "core.x=1", "pack-objects", "--stdout"], 900)
        self.assertEqual(linux.describe(error), "TimeoutExpired after 900s (git pack-objects)")
        self.assertEqual(linux.describe(subprocess.TimeoutExpired(["/usr/bin/systemctl", "--user", "stop", "x.service"], 90)), "TimeoutExpired after 90s (systemctl)")

    def test_candidate_import_restores_an_old_object_the_installed_store_lacks(self):
        # A partial clone can lack an old object that the candidate's history still reaches.
        blob = self.git("rev-parse", self.old + ":app.py").strip()
        (self.source / ".git/objects" / blob[:2] / blob[2:]).unlink()
        self.platform.quiescence(); self.platform.backup()
        self.git("cat-file", "-e", blob)
        self.assertEqual(self.platform.load()["phase"], "backed_up")

    def test_unreadable_file_refuses_cold_backup_before_service_shutdown(self):
        self.platform.quiescence()
        before = self.states.read_bytes()
        locked = self.home / "operations/old-caddy/Caddyfile"; locked.parent.mkdir(parents=True)
        locked.write_text("root-only copy"); locked.chmod(0)
        try:
            with self.assertRaisesRegex(RuntimeError, "cannot read .*operations/old-caddy/Caddyfile"): self.platform.backup()
        finally: locked.chmod(0o600)
        self.assertEqual(self.states.read_bytes(), before)
        self.assertEqual(self.platform.load()["phase"], "quiescent")

    def test_verification_waits_for_a_gateway_that_reports_slowly_after_restart(self):
        self.platform.config["verificationSeconds"] = 10
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        self.platform.start_delay = 0.6
        self.platform.control("stop"); self.platform.control("start")
        self.platform.verify()
        self.assertEqual(self.platform.load()["phase"], "verified")

    def test_cold_backup_names_its_failure_even_when_restarting_fails(self):
        self.platform.quiescence()
        archive = self.platform.archive
        def failing(path, source, excluded=None):
            if path.name == "home.tar.gz": raise PermissionError(13, "Permission denied", str(self.home / "locked"))
            return archive(path, source, excluded)
        self.platform.archive = failing
        self.platform.start_delay = 5; self.platform.config["gatewayStartSeconds"] = 0.2
        self.addCleanup(lambda: [timer.cancel() for timer in getattr(self.platform, "timers", [])])
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), self.assertRaisesRegex(RuntimeError, "Gateway state is not confirmed"):
            self.platform.backup()
        self.assertIn("Cold backup failed: PermissionError on " + str(self.home / "locked"), errors.getvalue())

    def test_repair_hash_does_not_depend_on_the_repository_abbreviation(self):
        pinned = self.platform.source_state()[1]
        self.git("config", "core.abbrev", "16")
        self.assertEqual(self.platform.source_state()[1], pinned)
        unpinned = hashlib.sha256(subprocess.check_output(["git", "-C", str(self.source), "diff", "HEAD", "--binary"])).hexdigest()
        self.assertNotEqual(unpinned, pinned)

    def test_failed_verification_names_its_step_and_error_class_but_no_output(self):
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        stderr = "Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named 'secret-bearing-detail'\n"
        def google(): raise subprocess.CalledProcessError(1, ["/py", "live-google-check.py"], output="", stderr=stderr)
        self.platform.google = google
        with self.assertRaises(RuntimeError) as raised: self.platform.verify()
        self.assertEqual(str(raised.exception), "original Google sign-in failed: CalledProcessError (exit 1, ModuleNotFoundError)")
        def status(method):
            if method == "status": raise subprocess.CalledProcessError(2, ["/py", "-c", "native"], stderr=b"RuntimeError: Native maintenance request rejected\n")
            return FixturePlatform.rpc(self.platform, method)
        self.platform.rpc = status
        with self.assertRaisesRegex(RuntimeError, r"^native maintenance status failed: CalledProcessError \(exit 2, RuntimeError\)$"): self.platform.verify()
        # Text shaped like a class name is still untrusted output.
        for line in ("MyToken123Error", "tok.en.Secret99Error: x", "ghp_" + "a" * 30, "sk-proj-abcdef0123456789abcdef"):
            def leaky(method, _line=line):
                if method == "status": raise subprocess.CalledProcessError(2, ["/py"], stderr=_line + "\n")
                return FixturePlatform.rpc(self.platform, method)
            self.platform.rpc = leaky
            with self.subTest(line=line), self.assertRaises(RuntimeError) as raised: self.platform.verify()
            self.assertEqual(str(raised.exception), "native maintenance status failed: CalledProcessError (exit 2, unrecognized error)")

    def test_too_little_space_refuses_cold_backup_before_service_shutdown(self):
        self.platform.quiescence()
        before = self.states.read_bytes()
        # Only the reserve free: the archives, candidate objects and install still need room.
        reserve = self.platform.config.get("backupReserveBytes", 5 * 1024 ** 3)
        usage = type("Usage", (), {"free": reserve + 1, "total": 72 * 1024 ** 3, "used": 60 * 1024 ** 3})()
        with patch.object(linux.shutil, "disk_usage", return_value=usage), self.assertRaisesRegex(RuntimeError, "needs about .* GB free"):
            self.platform.backup()
        self.assertFalse(list(self.stage.glob("qualified-objects-*.pack")))
        # Each allowance counts: the archives, candidate objects twice (packed in staging, then
        # imported) and the install, all checked before any object is imported. The live object
        # store is not archived, so it needs no room.
        archives = self.platform.readable(self.source, excluded=self.source / ".git/objects") + self.platform.readable(self.home, excluded=self.source)
        objects = linux.tree_bytes(self.target / ".git")
        install = linux.tree_bytes(self.target, excluded=self.target / ".git") + linux.tree_bytes(self.stage / "pm-home/installs")
        self.assertGreater(install, 0)
        imported = []
        self.platform.materialize_candidate = lambda: imported.append(True)
        for short in (archives + objects + install, 2 * objects + install, archives + 2 * objects):
            usage.free = reserve + short
            with self.subTest(free=usage.free), patch.object(linux.shutil, "disk_usage", return_value=usage), self.assertRaisesRegex(RuntimeError, "needs about"):
                self.platform.backup()
        self.assertEqual(imported, [])
        self.assertEqual(self.states.read_bytes(), before)
        self.assertEqual(self.platform.load()["phase"], "quiescent")
        # Exactly enough room is enough.
        usage.free = reserve + archives + 2 * objects + install
        with patch.object(linux.shutil, "disk_usage", return_value=usage): self.platform.backup()
        self.assertEqual(self.platform.load()["phase"], "backed_up")

    def test_failed_backup_restarts_hermes_even_when_logging_fails(self):
        self.platform.quiescence()
        def full(path, source, excluded=None): raise OSError(28, "No space left on device", str(path))
        self.platform.archive = full
        class FullDisk(io.StringIO):
            def write(self, text): raise OSError(28, "No space left on device")
        with contextlib.redirect_stderr(FullDisk()), self.assertRaises(OSError):
            self.platform.backup()
        units = json.loads(self.states.read_text())
        self.assertEqual({units[name]["ActiveState"] for name in ("gateway.service", "dashboard.service")}, {"active"})
        self.assertEqual(self.platform.load()["phase"], "quiescent")

    def test_space_is_checked_on_both_filesystems_when_staging_is_separate(self):
        self.platform.quiescence()
        real_stat = os.stat
        def separate(path, *args, **kwargs):
            value = real_stat(path, *args, **kwargs)
            if Path(path) == self.home:
                return os.stat_result((value.st_mode, value.st_ino, value.st_dev + 1, *value[3:10]))
            return value
        roomy = type("Usage", (), {"free": 10 ** 15, "total": 10 ** 15, "used": 0})()
        tight = type("Usage", (), {"free": 1024, "total": 10 ** 15, "used": 0})()
        usage = lambda location: tight if Path(location) == self.home else roomy
        with patch.object(linux.os, "stat", separate), patch.object(linux.shutil, "disk_usage", usage), \
                self.assertRaisesRegex(RuntimeError, "needs about .* free at " + str(self.home)):
            self.platform.backup()
        self.assertEqual(self.platform.load()["phase"], "quiescent")

    def test_a_failed_phase_write_right_after_stopping_still_restarts_hermes(self):
        self.platform.quiescence()
        save = self.platform.save
        def full(record):
            if record.get("phase") == "stopped": raise OSError(28, "No space left on device")
            save(record)
        self.platform.save = full
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(OSError): self.platform.backup()
        units = json.loads(self.states.read_text())
        self.assertEqual({units[name]["ActiveState"] for name in ("gateway.service", "dashboard.service")}, {"active"})

    def test_a_failed_restart_still_names_the_backup_failure(self):
        self.platform.quiescence()
        def full(path, source, excluded=None): raise OSError(28, "No space left on device", str(path))
        self.platform.archive = full
        control = self.platform.control
        def refuse_start(verb):
            if verb == "start": raise RuntimeError("systemd refused to start")
            control(verb)
        self.platform.control = refuse_start
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), self.assertRaisesRegex(RuntimeError, "systemd refused"): self.platform.backup()
        self.assertIn("Cold backup failed: OSError on ", errors.getvalue())

    def test_finish_releases_a_stopped_record_once_hermes_is_verified_running(self):
        self.platform.quiescence()
        self.platform.save(dict(self.platform.load(), phase="stopped"))
        self.platform.finish()
        self.assertEqual(self.platform.load()["phase"], "finished")
        self.assertIn("release", self.platform.rpc_calls)

    def test_verification_waits_for_the_dashboard_before_asking_it_anything(self):
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        self.platform.rpc_calls.clear(); self.platform.verify()
        self.assertEqual(self.platform.rpc_calls[:2], ["dashboard-ready", "status"])

    def test_verification_checks_discord_after_the_dashboard_wait(self):
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        def disconnect():
            state = json.loads((self.platform.home / "gateway_state.json").read_text())
            state["platforms"] = {key: {"state": "disconnected"} for key in state["platforms"]}
            linux.atomic(self.platform.home / "gateway_state.json", state)
        self.platform.wait_dashboard = disconnect
        self.platform.config.update(verificationSeconds=1)
        with self.assertRaisesRegex(RuntimeError, "Discord connections were not restored"): self.platform.verify()

    def test_dashboard_wait_tolerates_a_slow_first_start_and_gives_up_at_its_limit(self):
        import http.server, socket
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
        self.platform.config.update(dashboardOrigin="http://127.0.0.1:" + str(port), dashboardStartSeconds=10)
        class Status(http.server.BaseHTTPRequestHandler):
            def do_GET(self): self.send_response(401); self.end_headers()
            def log_message(self, *args): pass
        servers = []
        def start():
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Status); servers.append(server); server.serve_forever()
        later = threading.Timer(1.5, start); later.start()
        try:
            started = time.monotonic()
            linux.Platform.wait_dashboard(self.platform)
            self.assertGreaterEqual(time.monotonic() - started, 1)
        finally:
            later.cancel()
            while later.is_alive() and not servers: time.sleep(.05)
            if servers: servers[0].shutdown(); servers[0].server_close()
            later.join()
        self.platform.config.update(dashboardStartSeconds=0.5)
        with self.assertRaisesRegex(RuntimeError, "did not start listening"): linux.Platform.wait_dashboard(self.platform)

    def test_missing_qualified_objects_refuses_backup_without_service_shutdown(self):
        self.platform.quiescence()
        before = self.states.read_bytes()
        shutil.rmtree(self.target / ".git/objects")
        with self.assertRaises(subprocess.CalledProcessError): self.platform.backup()
        self.assertEqual(self.states.read_bytes(), before)
        self.assertEqual(self.platform.load()["phase"], "quiescent")
        self.assertFalse(list(self.stage.glob("qualified-objects-*.pack")))

    def test_rollback_restores_source_branch_and_runtime_but_keeps_refreshed_oauth(self):
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        (self.home / "auth.json").write_text("fresh-live-grant")
        (self.home / "installs/selected.json").write_text("new generation")
        (self.home / "config.yaml").write_text("unexpected configuration mutation")
        # The live object store is kept as is, never rebuilt.
        packs = sorted((self.source / ".git/objects/pack").iterdir())
        self.platform.rollback()
        self.assertEqual(sorted((self.source / ".git/objects/pack").iterdir()), packs)
        self.platform.env["HERMES_UPGRADE_ROLLBACK"] = "1"
        self.platform.verify(); self.platform.finish()
        self.assertEqual(self.platform.source_state()[0], self.old)
        self.assertEqual(self.git("symbolic-ref", "--short", "HEAD").strip(), "main")
        self.assertEqual((self.home / "auth.json").read_text(), "fresh-live-grant")
        self.assertEqual((self.home / "installs/selected.json").read_text(), "old generation")
        self.assertIn("model: chosen", (self.home / "config.yaml").read_text())
        self.assertIn("repair fixed", (self.source / "repair.py").read_text())
        self.assertEqual(self.git("diff", "--cached", "--name-only", "--", "staged-repair.py").strip(), "staged-repair.py")

    def test_source_archive_leaves_out_git_objects_and_rollback_refuses_an_incomplete_store(self):
        self.platform.quiescence(); self.platform.backup()
        with tarfile.open(self.stage / "backup/source.tar.gz") as archive: names = archive.getnames()
        self.assertIn("hermes-agent/.git/HEAD", names)
        self.assertFalse([name for name in names if name.startswith("hermes-agent/.git/objects")])
        self.platform.install()
        # A lost baseline blob, with no staged copy to restore it from, stops rollback.
        blob = self.git("rev-parse", self.old + ":app.py").strip()
        (self.source / ".git/objects" / blob[:2] / blob[2:]).unlink(missing_ok=True)
        for pack in (self.source / ".git/objects/pack").glob("*"): pack.unlink()
        shutil.rmtree(self.target / ".git/objects"); (self.target / ".git/objects/pack").mkdir(parents=True)
        with self.assertRaises((subprocess.CalledProcessError, RuntimeError)): self.platform.rollback()
        self.assertNotEqual(self.platform.load()["phase"], "restored")

    def test_rollback_rebuilds_a_lost_object_store_and_clears_stale_git_metadata(self):
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        shutil.rmtree(self.source / ".git/objects")
        (self.source / ".git/index.lock").write_text("stale")
        self.platform.rollback()
        self.assertFalse((self.source / ".git/index.lock").exists())
        self.assertEqual(self.platform.source_state()[0], self.old)
        # Every index blob reads back, including the repair's staged addition, which is in no commit.
        self.assertIn("new approved regression", self.git("diff", "--cached"))
        self.git("fsck", "--no-dangling", "--no-reflogs")

    def test_partially_staged_repair_refuses_backup_before_shutdown(self):
        self.platform.quiescence()
        before = self.states.read_bytes()
        with (self.source / "staged-repair.py").open("a") as output: output.write("unstaged edit\n")
        with self.assertRaisesRegex(RuntimeError, "staged-repair.py"): self.platform.backup()
        self.assertEqual(self.states.read_bytes(), before)

    def test_dependency_change_blocks_before_source_cutover(self):
        self.platform.quiescence(); self.platform.backup()
        (self.target / "uv.lock").write_text("new dependencies")
        with self.assertRaises(RuntimeError): self.platform.install()
        self.assertEqual(self.platform.source_state()[0], self.old)

    def test_qualified_candidate_diff_can_differ_from_current_and_is_verified_exactly(self):
        # A new upstream blob changes Git's diff fingerprint on its new base.
        # The qualified candidate receipt binds that resulting tracked tree.
        (self.target / "repair.py").write_text("upstream unrelated heading\nrepair old\n")
        subprocess.run(["git", "-C", str(self.target), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
            "commit", "--only", "-m", "new upstream base", "--", "repair.py"], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.candidate = self.platform.git(self.target, "rev-parse", "HEAD").strip()
        self.platform.candidate = self.candidate
        self.platform.env["HERMES_UPGRADE_CANDIDATE"] = self.candidate
        (self.target / "repair.py").write_text("upstream unrelated heading\nrepair fixed\n")
        self.platform.quiescence(); self.platform.backup()
        target = self.platform.source_state(self.target)
        self.assertNotEqual(target[1], self.platform.load()["baseline"]["source"][1])
        linux.atomic(self.stage / "qualification.json", {"revision": self.candidate, "trackedPatchSha256": target[1]})
        self.platform.install(); self.platform.verify()
        self.assertEqual(tuple(self.platform.load()["verifiedSource"]), target)
        self.platform.finish()
        self.assertFalse(self.platform.gate)

    def test_repair_changes_before_verification_or_release_keep_admission_closed(self):
        self.platform.quiescence(); self.platform.backup(); self.platform.install()
        repair = self.source / "repair.py"
        original = repair.read_bytes()
        repair.write_text("unexpected repair edit before verification\n")
        with self.assertRaisesRegex(RuntimeError, "Source repair"): self.platform.verify()
        self.assertTrue(self.platform.gate)
        repair.write_bytes(original)
        self.platform.verify()
        repair.write_text("unexpected repair edit after verification\n")
        with self.assertRaisesRegex(RuntimeError, "verified live source repair"): self.platform.finish()
        self.assertTrue(self.platform.gate)
        self.assertTrue((self.home / ".drain_request.json").exists())

    def test_changed_source_patch_or_backup_archive_cannot_be_installed_or_restored(self):
        self.platform.quiescence(); self.platform.backup()
        (self.target / "repair.py").write_text("different repair")
        with self.assertRaises(RuntimeError): self.platform.install()
        with (self.stage / "backup/source.tar.gz").open("ab") as output: output.write(b"corruption")
        with self.assertRaises(RuntimeError): self.platform.rollback()
        self.assertTrue(self.source.is_dir())
        self.assertEqual(self.platform.source_state()[0], self.old)

    def test_untested_native_runtime_blocks_before_services_restart_and_can_roll_back(self):
        self.platform.quiescence(); self.platform.backup()
        self.platform.env["HERMES_UPGRADE_RUNTIME_FINGERPRINT"] = json.dumps({"interpreterSha256": "different", "dependenciesSha256": "different"})
        with self.assertRaises(RuntimeError): self.platform.install()
        self.assertEqual(json.loads(self.states.read_text())["gateway.service"]["ActiveState"], "inactive")
        self.platform.rollback(); self.platform.env["HERMES_UPGRADE_ROLLBACK"] = "1"
        self.platform.verify(); self.platform.finish()
        self.assertEqual(self.platform.source_state()[0], self.old)

    def test_regressions_run_through_qualified_interpreter_in_disposable_home(self):
        calls, original_run = [], self.platform.run
        self.platform.run = lambda argv, **kwargs: original_run(argv, **kwargs) if argv[0] == "git" else calls.append((argv, kwargs))
        self.platform.regressions()
        self.assertEqual(len(calls), 2)
        for argv, kwargs in calls:
            self.assertEqual(argv[0], self.environment["HERMES_UPGRADE_QUALIFICATION_PYTHON"])
            self.assertEqual(kwargs["env"]["HERMES_HOME"], str(self.stage / "regression-home"))
            self.assertEqual(kwargs["env"]["PYTHONPATH"], str(self.target))

    def test_native_pm_sync_does_not_import_auto_update_bootstrap_or_evict_plugins(self):
        pm = self.source / "pm"; pm.mkdir()
        cli = self.source / "hermes_cli"; cli.mkdir()
        calls = self.home / "pm-calls.json"
        record = "import json\nfrom pathlib import Path\np=Path(" + repr(str(calls)) + ")\ndef note(v):\n old=json.loads(p.read_text()) if p.exists() else []\n p.write_text(json.dumps(old+[v]))\n"
        state = self.home / "installs/key"
        (pm / "__init__.py").write_text(record + '''
import shutil,uuid
def sync_venv(extras=None, **kwargs):
 f=Path(__FACTS_PATH__)
 prior=json.loads(f.read_text())['packages']['venv'] if f.exists() else {}
 lock=prior.get('resolved_lock')
 note({'extras':extras,'evict':kwargs['evict_incompatible_plugins'],'explicit':kwargs['explicit'],'root':str(kwargs['project_root']),'seed':Path(lock).read_text() if lock else None})
 # Native PM's stamp depends on dependency inputs, not app.py's contents.
 if prior.get('stamp')=='s' or f.with_name('skip-rebuild').exists(): return
 generation=f.parent/uuid.uuid4().hex
 workspace=generation/'workspace'; workspace.mkdir(parents=True)
 shutil.copy2(kwargs['project_root']/'app.py',workspace/'app.py')
 (workspace/'uv.lock').write_text('new generation lock')
 f.write_text(json.dumps({'packages':{'venv':{'stamp':'s','extras':extras,'environment':str(generation/'venv'),'resolved_lock':str(workspace/'uv.lock')}}}))
'''.replace('__FACTS_PATH__', repr(str(state / "facts.json"))))
        (pm / "environments.py").write_text("from pathlib import Path\ndef install_state_dir(root): return Path(" + repr(str(state)) + ")\ndef runtime_facts_path(root): return install_state_dir(root) / 'facts.json'\n")
        (pm / "lock.py").write_text("import json\nclass Facts:\n def __init__(self, path, strict=False): self.path=path\n def get(self, name): return json.loads(self.path.read_text())['packages'].get(name) if self.path.exists() else None\n def record_state(self, name, stamp, extras, *, environment=None, resolved_lock=None):\n  data=json.loads(self.path.read_text()); fact={'stamp':stamp,'extras':extras}\n  if environment is not None: fact['environment']=str(environment.resolve())\n  if resolved_lock is not None: fact['resolved_lock']=str(resolved_lock.resolve())\n  data['packages'][name]=fact; self.path.write_text(json.dumps(data))\n")
        (pm / "client.py").write_text("from pm import note\ndef ensure_tools_for_sync(): note('tools')\n")
        (cli / "__init__.py").write_text("")
        (cli / "venv_sync.py").write_text("from pm import note\ndef publish_launchers(root): note('publish')\n")
        (cli / "update_lock.py").write_text("import os\nfrom pm import note\nclass UpdateLock:\n def acquire(self):\n  note({'handoff':os.environ.get('HERMES_UPDATE_HANDOFF_PID')}); return True\n def release(self): note('release')\n")
        (self.source / "hermes_bootstrap.py").write_text("raise RuntimeError('Automatic source updater must never be imported')\n")
        result = linux.Platform.sync(self.platform)
        self.assertEqual(result, {"ok": True, "state": "synced"})
        self.assertEqual(json.loads(calls.read_text()), [{"handoff": str(os.getpid())}, "tools", {"extras": None, "evict": False, "explicit": True, "root": str(self.source), "seed": None}, "publish", "release"])
        # A dependency change installs exactly the extras qualification built.
        calls.unlink()
        descriptor = self.stage / "qualified-runtime.json"
        descriptor.write_text(json.dumps({"extras": ["all", "discord"]})); descriptor.chmod(0o600)
        self.platform.env["HERMES_UPGRADE_RUNTIME_DESCRIPTOR"] = str(descriptor)
        linux.Platform.sync(self.platform)
        self.assertEqual(json.loads(calls.read_text())[2]["extras"], ["all", "discord"])
        # Where PM seeds from the prior generation's lock, it seeds from the qualified lock instead.
        calls.unlink()
        generation = self.stage / "pm-home/installs/g/environments/e/venv"; (generation.parent / "workspace").mkdir(parents=True)
        (generation.parent / "workspace/uv.lock").write_text("qualified lock")
        descriptor.write_text(json.dumps({"extras": ["all"], "generation": str(generation)}))
        (state / "facts.json").unlink()
        linux.Platform.sync(self.platform)
        self.assertIsNone(json.loads(calls.read_text())[2]["seed"])
        calls.unlink()
        (state / "old.lock").write_text("baseline lock")
        prior = {"stamp": "s", "extras": ["all"], "environment": "/env", "resolved_lock": str((state / "old.lock").resolve())}
        (state / "facts.json").write_text(json.dumps({"packages": {"venv": prior}}))
        (self.source / "app.py").write_text("new runtime\n")
        linux.Platform.sync(self.platform)
        self.assertEqual(json.loads(calls.read_text())[2]["seed"], "qualified lock")
        self.assertFalse((state / "agent-interface-qualified-uv.lock").exists())
        # A source-only update must rebuild even though its dependency stamp was current.
        venv = json.loads((state / "facts.json").read_text())["packages"]["venv"]
        self.assertNotEqual(venv["environment"], prior["environment"])
        self.assertEqual((Path(venv["environment"]).parent / "workspace/app.py").read_text(), "new runtime\n")
        self.assertTrue(Path(venv["resolved_lock"]).is_file())
        # The stamp also needs invalidation when older facts have no resolved lock.
        calls.unlink()
        without_lock = {key: value for key, value in prior.items() if key != "resolved_lock"}
        (state / "facts.json").write_text(json.dumps({"packages": {"venv": without_lock}}))
        linux.Platform.sync(self.platform)
        self.assertIsNone(json.loads(calls.read_text())[2]["seed"])
        self.assertNotEqual(json.loads((state / "facts.json").read_text())["packages"]["venv"]["environment"], prior["environment"])
        # If PM still reuses the old generation, refuse publication and restore its facts.
        calls.unlink()
        (state / "facts.json").write_text(json.dumps({"packages": {"venv": prior}}))
        (state / "skip-rebuild").touch()
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            linux.Platform.sync(self.platform)
        self.assertIn("Native PM reused the prior dependency generation", failure.exception.stderr)
        self.assertNotIn("publish", json.loads(calls.read_text()))
        self.assertEqual(json.loads((state / "facts.json").read_text())["packages"]["venv"], prior)
        self.assertFalse((state / "agent-interface-qualified-uv.lock").exists())
        (state / "skip-rebuild").unlink()
        (generation.parent / "workspace/uv.lock").unlink()
        with self.assertRaisesRegex(RuntimeError, "qualified dependency lock is missing"): linux.Platform.sync(self.platform)

    def test_dependency_mismatch_keeps_the_failing_inspections_rows_in_the_stage(self):
        descriptor = self.stage / "qualified-runtime.json"
        descriptor.write_text("{}"); descriptor.chmod(0o600)
        self.platform.env["HERMES_UPGRADE_RUNTIME_DESCRIPTOR"] = str(descriptor)
        self.platform.store_python = lambda: "/usr/bin/python3"
        calls = []
        def run(argv, **kwargs):
            calls.append(argv); Path(argv[-1]).write_text("rows"); Path(argv[-1] + ".editable.json").write_text("[]")
            return json.dumps({"interpreterSha256": "same", "dependenciesSha256": "live"})
        self.platform.run = run
        with self.assertRaisesRegex(RuntimeError, r"^Managed dependencies differ from the qualified runtime\. Its package rows are in the stage as runtime-rows-[0-9a-f]{8}\.json$"):
            linux.Platform.runtime(self.platform, {"interpreterSha256": "same", "dependenciesSha256": "qualified"})
        # One inspection, and its own rows are the evidence.
        self.assertEqual(len(calls), 1)
        self.assertEqual(Path(calls[0][-1]).parent, self.stage); self.assertTrue(Path(calls[0][-1]).exists())
        self.assertTrue(Path(calls[0][-1] + ".editable.json").exists())
        with self.assertRaisesRegex(RuntimeError, "^The managed interpreter differs"):
            linux.Platform.runtime(self.platform, {"interpreterSha256": "other", "dependenciesSha256": "live"})
        # A match leaves nothing behind.
        self.assertEqual(linux.Platform.runtime(self.platform, {"interpreterSha256": "same", "dependenciesSha256": "live"})["dependenciesSha256"], "live")
        self.assertFalse(Path(calls[-1][-1]).exists()); self.assertFalse(Path(calls[-1][-1] + ".editable.json").exists())


    def reconfigure(self, **values):
        config = json.loads(self.config.read_text()); config.update(values)
        linux.atomic(self.config, config)
        self.platform.config = config

    def test_a_stale_pinned_interpreter_does_not_block_an_update_and_finish_refreshes_it(self):
        # Oct 30, 2026: Hermes moved to 3.14.9 while the host configuration still named 3.14.7.
        stale = self.pythons["3.14.7"]
        self.reconfigure(managedPython=stale)
        self.select("3.14.9")
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.platform.quiescence(); self.platform.backup(); self.platform.install(); self.platform.verify(); self.platform.finish()
        self.assertIn("Updated 1 interpreter path(s) in " + str(self.config) + " to " + self.pythons["3.14.9"], stderr.getvalue())
        self.assertEqual(self.platform.load()["baseline"]["interpreter"], self.pythons["3.14.9"])
        self.assertEqual(self.platform.load()["phase"], "finished")
        self.assertEqual(json.loads(self.config.read_text())["managedPython"], self.pythons["3.14.9"])

    def test_finish_rewrites_only_exact_interpreter_values_and_the_result_stays_valid(self):
        old, new = self.pythons["3.14.7"], self.pythons["3.14.9"]
        self.reconfigure(regressionPython=old, regressionCommands={"sharedOAuth": [old, "-c", "pass"], "googleAuth": [old, "-c", "pass"]},
            googleVerificationCommand=["/usr/bin/true", old + ".bak", "--python=" + old], interpreters={old: "kept as a key"})
        before = json.loads(self.config.read_text())
        # Native PM installs the candidate's newer interpreter during sync.
        def sync():
            self.select("3.14.9"); return {"ok": True, "state": "synced"}
        self.platform.sync = sync
        self.platform.quiescence(); self.platform.backup()
        self.assertEqual(self.platform.load()["baseline"]["interpreter"], old)
        self.platform.install(); self.platform.verify()
        self.assertEqual(json.loads(self.config.read_text()), before)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr): self.platform.finish()
        self.assertIn("Updated 4 interpreter path(s)", stderr.getvalue())
        after = json.loads(self.config.read_text())
        self.assertEqual(after, dict(before, managedPython=new, regressionPython=new,
            regressionCommands={"sharedOAuth": [new, "-c", "pass"], "googleAuth": [new, "-c", "pass"]}))
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(linux.Platform(self.config, self.environment).config, after)
        self.assertEqual(self.platform.config, after)

    def test_finish_moves_positions_left_on_different_old_versions_to_the_launchers_interpreter(self):
        # The live host had managedPython hand-corrected to 3.14.9 while regression commands stayed on 3.14.7.
        old, new = self.pythons["3.14.7"], self.pythons["3.14.9"]
        self.reconfigure(managedPython=new, regressionPython=old,
                         regressionCommands={"sharedOAuth": [old, "-c", "pass"], "googleAuth": [old, "-c", "pass"]})
        self.select("3.14.9")
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.platform.quiescence(); self.platform.backup(); self.platform.install(); self.platform.verify(); self.platform.finish()
        after = json.loads(self.config.read_text())
        self.assertEqual((after["managedPython"], after["regressionPython"]), (new, new))
        self.assertEqual({argv[0] for argv in after["regressionCommands"].values()}, {new})
        self.assertIn("Updated 3 interpreter path(s)", stderr.getvalue())
        self.assertEqual(linux.Platform(self.config, self.environment).config, after)

    def test_the_interpreter_changing_mid_operation_at_the_baseline_revision_is_refused(self):
        self.platform.quiescence()
        self.select("3.14.9")
        with self.assertRaisesRegex(RuntimeError, "^Baseline managed interpreter selection changed$"): self.platform.store_python()
        # A later hook is a new process; it binds the operation record, not the pinned configuration.
        fresh = FixturePlatform(self.config, self.environment)
        with self.assertRaisesRegex(RuntimeError, "^Baseline managed interpreter selection changed$"): fresh.store_python()
        self.select("3.14.7")
        self.assertEqual(fresh.store_python(), self.pythons["3.14.7"])

    def test_an_interpreter_outside_the_tool_store_is_refused(self):
        self.select(os.sys.executable)
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), self.assertRaises(SystemExit) as refusal: self.platform.quiescence()
        self.assertEqual(refusal.exception.code, 75)
        self.assertEqual(errors.getvalue(), "Quiescence refused before maintenance: The baseline managed interpreter is outside the native tool store\n")
        self.assertFalse((self.stage / "platform.json").exists())
        # A record from an older helper has no interpreter; the tool store still bounds it.
        self.platform.save({"baseline": {"source": list(self.platform.source_state())}, "phase": "quiescent"})
        with self.assertRaisesRegex(RuntimeError, "outside the native tool store"): self.platform.store_python()
        escape = self.home / "tools/python-3.14.9/bin/escape"; escape.symlink_to(os.sys.executable)
        self.select(str(escape))
        with self.assertRaisesRegex(RuntimeError, "outside the native tool store"): self.platform.store_python()
        self.select("3.14.9")
        self.assertEqual(self.platform.store_python(), self.pythons["3.14.9"])
        self.git("reset", "--hard", self.candidate)
        self.select(os.sys.executable)
        with self.assertRaisesRegex(RuntimeError, "escaped the native tool store"): self.platform.store_python()

    def test_sync_runs_in_the_recorded_baseline_interpreter(self):
        calls = []
        self.platform.run = lambda argv, **kwargs: calls.append(argv) or '{"ok": true, "state": "synced"}'
        self.platform.save({"baseline": {"interpreter": self.pythons["3.14.9"]}, "phase": "backed_up"})
        linux.Platform.sync(self.platform)
        self.platform.save({"baseline": {}, "phase": "backed_up"})
        linux.Platform.sync(self.platform)
        self.assertEqual([argv[0] for argv in calls], [self.pythons["3.14.9"], self.pythons["3.14.7"]])

    def test_a_failed_interpreter_refresh_never_fails_finish(self):
        def finish():
            self.platform.save(dict(self.platform.load(), phase="verified"))
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr): self.platform.finish()
            self.assertEqual(self.platform.load()["phase"], "finished")
            return stderr.getvalue()
        self.platform.quiescence(); self.platform.backup(); self.platform.install(); self.platform.verify()
        before = self.config.read_bytes()
        self.select("3.14.9")
        # The configuration directory refuses the atomic replacement.
        self.directory.chmod(0o500)
        try: log = finish()
        finally: self.directory.chmod(0o700)
        self.assertIn("Interpreter path refresh skipped: PermissionError on " + str(self.directory), log)
        self.assertEqual(self.config.read_bytes(), before)
        # The launcher cannot answer.
        self.launcher.write_text("#!/bin/sh\nexit 1\n")
        self.assertIn("Interpreter path refresh skipped: CalledProcessError (exit 1", finish())
        self.assertEqual(self.config.read_bytes(), before)

    def test_private_config_and_fixed_stage_paths_are_required(self):
        self.config.chmod(0o644)
        with self.assertRaises(RuntimeError): linux.Platform(self.config, self.environment)
        self.config.chmod(0o600)
        environment = dict(self.environment, HERMES_UPGRADE_BACKUP_DIR=str(self.directory / "elsewhere"))
        with self.assertRaises(RuntimeError): linux.Platform(self.config, environment)

    def test_gateway_status_requires_current_process_and_fresh_drain_ack(self):
        record = json.loads((self.home / "gateway_state.json").read_text()); record["pid"] = 999
        linux.atomic(self.home / "gateway_state.json", record)
        with self.assertRaises(RuntimeError): self.platform.gateway()
        self.platform.write_gateway("running")
        with self.assertRaises(RuntimeError): self.platform.gateway(draining=True)
        for pending in (1, True, None):
            self.platform.pending_ingress = pending
            self.platform.write_gateway("draining")
            with self.assertRaises(RuntimeError): self.platform.gateway(draining=True)



class AddonPlatform(FixturePlatform):
    """FixturePlatform with the real maintenance RPC: NATIVE runs in the store interpreter against
    a fake add-on. The drain and the gateway stay the fixture's."""
    rpc = linux.Platform.rpc

    def native(self, action, **values):
        return linux.Platform.native(self, action, **values) if action == "rpc" else super().native(action, **values)


# The fake add-on is the WebSocket client module, which NATIVE imports from the Hermes source. It
# answers each maintenance request with the next step a test scripted for that action and fails on
# any request the test did not script. Lease writes are private, as the real handler's are.
FAKE_ADDON = r"""
import json, os, subprocess, sys, time
from pathlib import Path
SCRIPT, CALLS, LEASE = Path(__SCRIPT__), Path(__CALLS__), Path(__LEASE__)
BUSY = {"code": 409, "message": "Hermes still has active work; no maintenance lease acquired"}
# Written by a separate process once this one has exited: the handler finishing after the caller gave up.
LATE = '''
import json, os, sys, time
from pathlib import Path
parent, lease, operation = int(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
while True:
    try: os.kill(parent, 0)
    except ProcessLookupError: break
    time.sleep(.02)
time.sleep(.3)
temporary = lease.with_name(lease.name + ".late")
with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output: output.write(json.dumps({"operationId": operation}))
temporary.replace(lease)
'''
def record(*event):
    with CALLS.open("a") as calls: calls.write(json.dumps(event) + "\n")
def held():
    return json.loads(LEASE.read_text()) if LEASE.exists() else None
def write_lease(operation):
    temporary = LEASE.with_name(LEASE.name + ".writing")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output: output.write(json.dumps({"operationId": operation}))
    temporary.replace(LEASE)
def result(value): return json.dumps({"id": 1, "result": value})
class Socket:
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def send(self, message):
        # A send that fails may still have reached the add-on, so the hook must not call it unsent.
        if SCRIPT.exists() and json.loads(SCRIPT.read_text()).get("failSend"): raise ConnectionResetError("connection reset during send")
        self.params = json.loads(message)["params"]
    def recv(self, timeout):
        action, operation = self.params["action"], self.params["operation_id"]
        record("recv", action, timeout)
        script = json.loads(SCRIPT.read_text())
        if not script.get(action): raise AssertionError("unscripted maintenance " + action)
        step = script[action].pop(0)
        SCRIPT.write_text(json.dumps(script))
        if step == "silence": raise TimeoutError("timed out while waiting for a message")
        if step == "stall": time.sleep(60)
        if step == "busy": return json.dumps({"id": 1, "error": BUSY})
        if step == "grant":
            write_lease(operation)
            return result({"active": True, "operationId": operation, "busy": []})
        if step == "release":
            if held() == {"operationId": operation}: LEASE.unlink()
            return result({"active": held() is not None, "operationId": (held() or {}).get("operationId"), "busy": []})
        if step == "status": return result({"active": held() is not None, "operationId": (held() or {}).get("operationId"), "busy": []})
        if "lateLease" in step:
            subprocess.Popen([sys.executable, "-c", LATE, str(os.getpid()), str(LEASE), step["lateLease"]],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            raise TimeoutError("timed out while waiting for a message")
        if "print" in step:
            print(step["print"], flush=True)
            raise TimeoutError("timed out while waiting for a message")
        if "change" in step:
            Path(step["change"]).write_text("changed while acquiring")
            write_lease(operation)
            return result({"active": True, "operationId": operation, "busy": []})
        return json.dumps(dict(step, id=1))
def connect(url, *, open_timeout, close_timeout):
    record("connect", url)
    if SCRIPT.exists() and json.loads(SCRIPT.read_text()).get("refuseConnect"): raise ConnectionRefusedError("connection refused")
    return Socket()
"""


class MaintenanceRpcTests(HostFixture):
    """What quiescence concludes from each way the add-on can end an acquire, through the real RPC."""
    platform_type = AddonPlatform

    def setUp(self):
        super().setUp()
        self.script, self.calls, self.lease = self.directory / "addon-script.json", self.directory / "addon-calls.jsonl", self.home / "maintenance.json"
        (self.source / "hermes_bootstrap.py").write_text("")
        client = self.source / "websockets/sync/client.py"; client.parent.mkdir(parents=True)
        (self.source / "websockets/__init__.py").write_text(""); (client.parent / "__init__.py").write_text("")
        client.write_text(FAKE_ADDON.replace("__SCRIPT__", repr(str(self.script))).replace("__CALLS__", repr(str(self.calls))).replace("__LEASE__", repr(str(self.lease))))
        key = "a" * 43
        self.refused_tickets = 0
        outer = self
        class Tickets(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                ok = self.path == "/api/agent-interface/service-ticket" and self.headers["Authorization"] == "Bearer " + key
                if ok and outer.refused_tickets:
                    outer.refused_tickets -= 1
                    ok = False
                body = json.dumps({"ticket": "ticket-1"}).encode() if ok else b"{}"
                self.send_response(200 if ok else 403); self.end_headers(); self.wfile.write(body)
            def log_message(self, *_): pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Tickets)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        self.platform.config.update(dashboardOrigin="http://127.0.0.1:" + str(server.server_address[1]))
        # Long enough for a test whose lease appears late; the rest end their watch at once or never start it.
        patcher = patch.object(linux, "LATE_LEASE_SECONDS", 10); patcher.start(); self.addCleanup(patcher.stop)

    def scripted(self, **steps): self.script.write_text(json.dumps(steps))

    def requests(self):
        """Each maintenance request the add-on received, with how long NATIVE waited for its answer."""
        if not self.calls.exists(): return []
        return [event[1:] for event in map(json.loads, self.calls.read_text().splitlines()) if event[0] == "recv"]

    def quiescence(self):
        """Run quiescence; return its exit code, or None when it returned, and what it logged."""
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            try: self.platform.quiescence()
            except SystemExit as exit: return exit.code, errors.getvalue()
        return None, errors.getvalue()

    def phase(self): return json.loads(self.platform.record.read_text())["phase"]

    def assert_unchanged(self, states):
        self.assertEqual(self.states.read_bytes(), states)
        self.assertFalse((self.home / ".drain_request.json").exists())

    def test_busy_answer_is_a_finished_refusal(self):
        self.scripted(acquire=["busy"], release=["release"])
        states = self.states.read_bytes()
        code, log = self.quiescence()
        self.assertEqual(code, 75)
        self.assertIn("Quiescence refused and released maintenance: Hermes answered maintenance with error code 409", log)
        # Acquire waits out the add-on's compaction preempts; release answers at once.
        self.assertEqual(self.requests(), [["acquire", 120], ["release", 15]])
        self.assertEqual(self.phase(), "rejected")
        self.assertFalse(self.lease.exists())
        self.assert_unchanged(states)

    def test_unanswered_acquire_whose_lease_appears_later_is_released_and_refused(self):
        self.scripted(acquire=[{"lateLease": self.platform.operation}], release=["release"])
        states = self.states.read_bytes()
        code, log = self.quiescence()
        # The lease proves the handler returned, so the release that removed it is final.
        self.assertEqual(code, 75)
        self.assertIn("Quiescence refused and released maintenance: Hermes did not answer maintenance acquire", log)
        self.assertEqual(self.requests(), [["acquire", 120], ["release", 15]])
        self.assertEqual(self.phase(), "rejected")
        self.assertFalse(self.lease.exists())
        self.assert_unchanged(states)

    def test_unanswered_acquire_without_a_lease_is_held_and_cancel_recovers_a_later_lease(self):
        self.scripted(acquire=["silence"])
        states = self.states.read_bytes()
        with patch.object(linux, "LATE_LEASE_SECONDS", 0.5): code, log = self.quiescence()
        self.assertNotEqual(code, 75)
        self.assertEqual(code, linux.upgrade_worker().MAINTENANCE_UNANSWERED)
        self.assertIn("Quiescence held for review, maintenance may still be taken: Hermes did not answer maintenance acquire: "
                      "CalledProcessError (exit 1, TimeoutError)", log)
        # No release: it could not stop a lease the handler writes afterwards.
        self.assertEqual(self.requests(), [["acquire", 120]])
        self.assertEqual(self.phase(), "acquire_unanswered")
        self.assert_unchanged(states)
        # Without the lease, the app offers no recovery, and recovery stops at the lease before
        # touching Hermes. Once it exists, the app's Cancel runs recovery from this held phase.
        with self.assertRaises(FileNotFoundError) as missing: self.platform.recovery_guard()
        self.assertEqual(missing.exception.filename, str(self.lease))
        self.assert_unchanged(states)
        linux.atomic(self.lease, {"operationId": self.platform.operation})
        self.scripted(status=["status"])
        self.assertEqual(self.platform.recovery_guard()["phase"], "acquire_unanswered")

    def test_another_operations_lease_ends_the_watch_and_is_left_alone(self):
        self.scripted(acquire=[{"lateLease": "another-operation"}])
        code, log = self.quiescence()
        self.assertEqual(code, linux.upgrade_worker().MAINTENANCE_UNANSWERED)
        self.assertIn("Quiescence held for review", log)
        self.assertEqual(self.requests(), [["acquire", 120]])
        self.assertEqual(json.loads(self.lease.read_text()), {"operationId": "another-operation"})

    def test_a_lease_that_cannot_be_read_as_this_operations_ends_the_watch_and_is_left_alone(self):
        def malformed(): self.lease.write_text("{"); self.lease.chmod(0o600)
        def not_private(): self.lease.write_text(json.dumps({"operationId": self.platform.operation})); self.lease.chmod(0o644)
        def unreadable(): self.lease.write_text(json.dumps({"operationId": self.platform.operation})); self.lease.chmod(0o200)
        cases = [("not JSON", malformed), ("readable by others", not_private)]
        if os.getuid(): cases.append(("unreadable", unreadable))
        for name, write in cases:
            with self.subTest(name):
                self.lease.unlink(missing_ok=True); self.calls.unlink(missing_ok=True)
                write()
                before = self.lease.read_bytes() if name != "unreadable" else None
                self.scripted(acquire=["silence"])
                code, log = self.quiescence()
                # Held without a release: a lease this hook cannot prove is its own is never released.
                self.assertEqual(code, linux.upgrade_worker().MAINTENANCE_UNANSWERED)
                self.assertIn("Quiescence held for review", log)
                self.assertEqual(self.requests(), [["acquire", 120]])
                self.assertEqual(self.phase(), "acquire_unanswered")
                self.assertTrue(self.lease.exists())
                if before is not None: self.assertEqual(self.lease.read_bytes(), before)
                self.lease.chmod(0o600)

    def test_another_error_answer_is_held_for_review_without_a_release(self):
        self.scripted(acquire=[{"error": {"code": 409, "message": "Another maintenance operation owns this lease"}}])
        with self.assertRaisesRegex(RuntimeError, "^Hermes refused maintenance for a reason other than active work, error code 409$"):
            self.platform.quiescence()
        self.assertEqual(self.requests(), [["acquire", 120]])
        self.assertEqual(self.phase(), "acquiring")

    def test_an_unanswered_release_after_a_refusal_fails_closed(self):
        self.scripted(acquire=["busy"], release=["silence"])
        with self.assertRaisesRegex(linux.Unanswered, "^Hermes did not answer maintenance release"):
            self.platform.quiescence()
        self.assertEqual(self.phase(), "acquiring")

    def test_a_failed_child_is_answered_only_when_its_last_line_is_the_answered_error(self):
        for line in ('{"answeredError": "409"}', "answeredError", '{"answeredError": {"code": 409}, "id": 1}'):
            with self.subTest(line=line):
                self.scripted(status=[{"print": line}])
                with self.assertRaises(linux.Unanswered): self.platform.rpc("status")

    def test_a_failed_child_is_unsent_only_when_its_last_line_is_exactly_the_unsent_line(self):
        for line in ('{"unsent": false}', '{"unsent": true, "id": 1}', '"unsent"', "unsent"):
            with self.subTest(line=line):
                self.scripted(status=[{"print": line}])
                with self.assertRaises(linux.Unanswered): self.platform.rpc("status")

    def test_a_timed_out_child_is_unanswered(self):
        # The child timeout is the wait plus the overhead. A wait of 0 and an overhead of 1 s let
        # the real subprocess timeout fire on a stalled add-on without a 45 s test.
        self.scripted(status=["stall"])
        with patch.object(linux, "DEFAULT_MAINTENANCE_WAIT", 0), patch.object(linux, "MAINTENANCE_OVERHEAD", 1):
            with self.assertRaisesRegex(linux.Unanswered, r"^Hermes did not answer maintenance status: TimeoutExpired after 1s ") as lost:
                self.platform.rpc("status")
        self.assertIsNone(lost.exception.__cause__)

    def make_ticket_fail(self, how):
        """Break the service ticket or the connection, and say which."""
        if how == "wrong service key":
            self.service_env.write_text("HERMES_AGENT_INTERFACE_TOKEN=" + "b" * 43 + "\nHERMES_AGENT_INTERFACE_MAINTENANCE_FILE=" + str(self.lease) + "\n")
        elif how == "closed dashboard port":
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                self.platform.config.update(dashboardOrigin="http://127.0.0.1:" + str(probe.getsockname()[1]))
        else:
            self.scripted(refuseConnect=True)

    def test_a_send_that_fails_is_unanswered_not_unsent(self):
        # The request may have left before the socket failed, so a lease can still appear: held, never 75.
        self.script.write_text(json.dumps({"failSend": True}))
        states = self.states.read_bytes()
        with patch.object(linux, "LATE_LEASE_SECONDS", 0.3): code, log = self.quiescence()
        self.assertEqual(code, linux.upgrade_worker().MAINTENANCE_UNANSWERED)
        self.assertIn("Hermes did not answer maintenance acquire", log)
        self.assertEqual(self.phase(), "acquire_unanswered")
        self.assert_unchanged(states)

    def test_a_failure_before_the_request_is_sent_is_not_an_unanswered_acquire(self):
        # Neither failure reached the add-on, so there is no lease to wait for and no handler running.
        env, origin = self.service_env.read_text(), self.platform.config["dashboardOrigin"]
        for how in ("wrong service key", "closed dashboard port", "refused connection"):
            with self.subTest(how):
                self.service_env.write_text(env); self.platform.config.update(dashboardOrigin=origin); self.script.unlink(missing_ok=True)
                self.make_ticket_fail(how)
                self.assertFalse(self.requests())
                with self.assertRaisesRegex(linux.NotSent, r"^Hermes was not asked for maintenance acquire: CalledProcessError \(exit 1, "):
                    self.platform.rpc("acquire")
                # The release the hook then makes fails the same way: it is held for review at once
                # (exit 1), never the 300 s watch and exit 76.
                started = time.monotonic()
                with self.assertRaisesRegex(linux.NotSent, "^Hermes was not asked for maintenance release"):
                    self.platform.quiescence()
                # Not the 300 s watch; half of it tells the two apart on a machine many times slower.
                self.assertLess(time.monotonic() - started, 150)
                self.assertEqual(self.phase(), "acquiring")
                self.assertFalse(self.requests())
                self.assertFalse(self.lease.exists())
                self.assertFalse((self.home / ".drain_request.json").exists())

    def test_an_acquire_refused_before_it_is_sent_is_a_finished_refusal_once_the_release_confirms(self):
        self.refused_tickets = 1
        self.scripted(release=["release"])
        states = self.states.read_bytes()
        code, log = self.quiescence()
        self.assertEqual(code, 75)
        self.assertIn("Quiescence refused and released maintenance: Hermes was not asked for maintenance acquire", log)
        # The acquire never reached the add-on; only the release did.
        self.assertEqual(self.requests(), [["release", 15]])
        self.assertEqual(self.phase(), "rejected")
        self.assertFalse(self.lease.exists())
        self.assert_unchanged(states)

    def test_after_an_acquire_failures_release_and_success_keeps_the_lease(self):
        cases = [("active work in the drain", 1, ["grant"], "Gateway has active or unknown chat"),
            ("an answer that is not this operation's lease", 0, [{"result": {"active": True, "operationId": "another-operation", "busy": []}}],
             "The native dashboard gate was not acquired")]
        for name, active, acquire, reason in cases:
            with self.subTest(name):
                self.platform.active_work = active
                self.platform.write_gateway("running"); self.calls.unlink(missing_ok=True)
                self.scripted(acquire=acquire, release=["release"])
                code, log = self.quiescence()
                self.assertEqual(code, 75)
                self.assertIn("Quiescence refused and released maintenance: " + reason, log)
                self.assertEqual(self.requests(), [["acquire", 120], ["release", 15]])
                self.assertEqual(self.phase(), "rejected")
                self.assertFalse(self.lease.exists())
                self.assertFalse((self.home / ".drain_request.json").exists())
        self.platform.active_work = 0; self.platform.write_gateway("running"); self.calls.unlink()
        # A setting changed while acquiring is released too, but live state changed, so it is held.
        self.scripted(acquire=[{"change": str(self.home / "config.yaml")}], release=["release"])
        with self.assertRaisesRegex(RuntimeError, "^Quiescence refusal changed live host state$") as held: self.platform.quiescence()
        self.assertEqual(str(held.exception.__cause__), "Host inputs changed while acquiring maintenance")
        self.assertEqual((self.requests(), self.lease.exists(), self.phase()), ([["acquire", 120], ["release", 15]], False, "acquiring"))
        self.calls.unlink()
        self.scripted(acquire=["grant"])
        self.assertEqual(self.quiescence()[0], None)
        self.assertEqual(self.requests(), [["acquire", 120]])
        self.assertEqual((self.phase(), json.loads(self.lease.read_text())), ("quiescent", {"operationId": self.platform.operation}))
        self.assertTrue((self.home / ".drain_request.json").exists())

if __name__ == "__main__": unittest.main()
