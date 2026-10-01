"""Temporary-host tests. No real service, network, or production home is touched."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
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
        if method == "acquire": self.gate = True
        if method == "release": self.gate = False
        return {"active": self.gate, "operationId": self.operation if self.gate else None, "busy": []}

    def clear_drain(self):
        super().clear_drain()
        self.write_gateway("running")

    def control(self, verb):
        super().control(verb)
        if verb == "start": self.write_gateway("draining")

    def google(self): return {"authenticatedHttp": True, "freshWebsocket": True}
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
        self.platform = FixturePlatform(self.config, self.environment)
        self.platform.states = self.states; self.platform.rpc_calls = []; self.platform.gate = False; self.platform.active_work = 0; self.platform.pending_ingress = 0
        self.platform.write_gateway("running")
        linux.atomic(self.stage / "qualification.json", {"revision": self.candidate, "trackedPatchSha256": self.platform.source_state(self.target)[1]})

    def tearDown(self): self.temp.cleanup()
    def git(self, *args): return subprocess.check_output(["git", "-C", str(self.source), *args], stderr=subprocess.PIPE).decode()

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
        self.platform.rollback()
        self.platform.env["HERMES_UPGRADE_ROLLBACK"] = "1"
        self.platform.verify(); self.platform.finish()
        self.assertEqual(self.platform.source_state()[0], self.old)
        self.assertEqual(self.git("symbolic-ref", "--short", "HEAD").strip(), "main")
        self.assertEqual((self.home / "auth.json").read_text(), "fresh-live-grant")
        self.assertEqual((self.home / "installs/selected.json").read_text(), "old generation")
        self.assertIn("model: chosen", (self.home / "config.yaml").read_text())
        self.assertIn("repair fixed", (self.source / "repair.py").read_text())
        self.assertEqual(self.git("diff", "--cached", "--name-only", "--", "staged-repair.py").strip(), "staged-repair.py")

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
