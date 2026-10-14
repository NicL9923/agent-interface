"""Temporary-host tests. No real service, network, or production home is touched."""
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("linux_upgrade", ROOT / "scripts/hermes-upgrade-linux.py")
linux = importlib.util.module_from_spec(spec); spec.loader.exec_module(linux)


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
        value = {"interpreterSha256": "fixed-python", "dependenciesSha256": "fixed-generation"}
        if expected is not None and value != expected: raise RuntimeError("Untested runtime")
        return value
    def sync(self): return {"ok": True, "state": "synced"}


class PlatformTests(unittest.TestCase):
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
        self.launcher = self.source / ".hermes/bin/hermes"; self.launcher.parent.mkdir(parents=True)
        self.launcher.write_text('#!/bin/sh\nprintf \'{"ok":true,"state":"current"}\\n\'\n'); self.launcher.chmod(0o700)
        self.config = self.directory / "platform.json"
        linux.atomic(self.config, {"source": str(self.source), "hermesHome": str(self.home), "managedLauncher": str(self.launcher),
            "managedPython": str(Path(os.sys.executable).absolute()), "serviceEnvFile": str(self.service_env), "qualificationReceipt": str(self.directory / "deployed-receipt.json"),
            "maintenanceFile": str(self.home / "maintenance.json"), "stageRoot": str(self.stage_root), "systemctl": str(self.systemctl),
            "dashboardOrigin": "http://127.0.0.1:9119", "dashboardPort": 9119, "gatewayUnit": "gateway.service", "dashboardUnit": "dashboard.service", "appUnit": "app.service",
            "regressionPython": "/usr/bin/python3", "regressionCommands": {"sharedOAuth": ["/usr/bin/python3", "-c", "pass"], "googleAuth": ["/usr/bin/python3", "-c", "pass"]}, "googleVerificationCommand": ["/usr/bin/true"],
            "discordConnections": ["discord", "second:discord"], "drainAcknowledgeSeconds": 0})
        self.environment = dict(os.environ, HERMES_UPDATE_HANDOFF_PID=str(os.getpid()), HERMES_UPGRADE_OPERATION_ID=str(uuid.uuid4()), HERMES_UPGRADE_SOURCE=str(self.source), HERMES_UPGRADE_CURRENT=self.old,
            HERMES_UPGRADE_CANDIDATE=self.candidate, HERMES_UPGRADE_STAGE_HOME=str(self.stage), HERMES_UPGRADE_STAGE_SOURCE=str(self.target),
            HERMES_UPGRADE_BACKUP_DIR=str(self.stage / "backup"), HERMES_UPGRADE_RECEIPT=str(self.stage / "qualification.json"), HERMES_UPGRADE_QUALIFICATION_PYTHON=os.sys.executable, HERMES_UPGRADE_RUNTIME_FINGERPRINT=json.dumps({"interpreterSha256": "fixed-python", "dependenciesSha256": "fixed-generation"}))
        self.environment["HERMES_UPGRADE_INTEGRATION_DIGEST"] = "a" * 64
        self.platform = FixturePlatform(self.config, self.environment)
        self.platform.states = self.states; self.platform.rpc_calls = []; self.platform.gate = False; self.platform.active_work = 0; self.platform.pending_ingress = 0
        self.platform.write_gateway("running")
        linux.atomic(self.stage / "qualification.json", {"revision": self.candidate, "trackedPatchSha256": self.platform.source_state(self.target)[1]})

    def tearDown(self): self.temp.cleanup()
    def git(self, *args): return subprocess.check_output(["git", "-C", str(self.source), *args], stderr=subprocess.PIPE).decode()

    def baseline_receipt(self):
        receipt = {"schemaVersion": 1, "revision": self.old,
            "trackedPatchSha256": self.platform.source_state()[1], "integrationDigest": "a" * 64,
            "qualifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "checks": {"realIntegration": True, "hostRegressions": True}}
        previous = self.stage / "previous-qualification.json"
        linux.atomic(previous, receipt)
        self.platform.env["HERMES_UPGRADE_PREVIOUS_RECEIPT"] = str(previous)
        return receipt

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
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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
        calls = []
        self.platform.run = lambda argv, **kwargs: calls.append((argv, kwargs))
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
        (pm / "__init__.py").write_text(record + "def sync_venv(**kwargs):\n note({'evict':kwargs['evict_incompatible_plugins'],'explicit':kwargs['explicit'],'root':str(kwargs['project_root'])})\n")
        (pm / "client.py").write_text("from pm import note\ndef ensure_tools_for_sync(): note('tools')\n")
        (cli / "__init__.py").write_text("")
        (cli / "venv_sync.py").write_text("from pm import note\ndef publish_launchers(root): note('publish')\n")
        (cli / "update_lock.py").write_text("import os\nfrom pm import note\nclass UpdateLock:\n def acquire(self):\n  note({'handoff':os.environ.get('HERMES_UPDATE_HANDOFF_PID')}); return True\n def release(self): note('release')\n")
        (self.source / "hermes_bootstrap.py").write_text("raise RuntimeError('Automatic source updater must never be imported')\n")
        result = linux.Platform.sync(self.platform)
        self.assertEqual(result, {"ok": True, "state": "synced"})
        self.assertEqual(json.loads(calls.read_text()), [{"handoff": str(os.getpid())}, "tools", {"evict": False, "explicit": True, "root": str(self.source)}, "publish", "release"])

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


if __name__ == "__main__": unittest.main()
