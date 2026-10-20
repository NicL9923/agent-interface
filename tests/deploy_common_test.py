"""Shared deploy and recovery host steps, against fake systemctl, native and app processes."""
import ast
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".agents/tools"
sys.path.insert(0, str(TOOLS))
import deploy_common  # noqa: E402


def executable(path, body):
    path.write_text("#!" + sys.executable + "\n" + body)
    path.chmod(0o700)
    return path


class Fixture:
    def __init__(self, root):
        self.root = root
        self.base, self.home, self.source = root / "app", root / "hermes", root / "source"
        for path in (self.base / "releases/new", self.base / "releases/old", self.base / "shared", self.home, self.source):
            path.mkdir(parents=True)
        (self.base / "current").symlink_to(self.base / "releases/old")
        self.ops = root / "ops"
        self.ops.mkdir()
        self.log = (self.ops / "commands.log").open("a")
        self.config = {"appBase": str(self.base), "release": str(self.base / "releases/new"), "source": str(self.source),
                       "hermesHome": str(self.home), "maintenanceFile": str(self.home / "maintenance.json"),
                       "appOrigin": "https://app.example.test", "managedPython": sys.executable,
                       "hermesRevision": "d" * 40, "discordConnections": ["discord", "discord-kimberly"]}
        self.deployment = deploy_common.Deployment(self.config, operation="op-1", ops=self.ops, log=self.log)
        # Answers MainPID queries and records every call, like the user systemd manager.
        self.calls = root / "systemctl-calls.jsonl"
        self.deployment.systemctl = str(executable(root / "systemctl", f"""
import json, sys
with open({str(self.calls)!r}, "a") as calls: calls.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[2] == "show": print("4242")
"""))

    def close(self):
        self.log.close()

    def systemctl_calls(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.host = Fixture(Path(temporary.name))
        self.addCleanup(self.host.close)
        self.d = self.host.deployment

    def test_context_derives_paths_from_configuration(self):
        self.assertEqual((self.d.current, self.d.lease, self.d.service_env),
                         (self.host.base / "current", self.host.home / "maintenance.json",
                          self.host.base / "shared/hermes-service.env"))

    def test_commands_log_output_fail_closed_and_revalidate_the_update_claim(self):
        self.assertEqual(self.d.run([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr)"]), "out\n")
        with self.assertRaisesRegex(RuntimeError, "private log retained"):
            self.d.run([sys.executable, "-c", "raise SystemExit(3)"])
        self.assertEqual((self.host.ops / "commands.log").read_text(), "out\nerr\n")
        marker = self.host.root / "ran"
        class LostClaim:
            def validate(self): raise RuntimeError("update claim lost")
        self.d.claim = LostClaim()
        with self.assertRaisesRegex(RuntimeError, "update claim lost"):
            self.d.run([sys.executable, "-c", f"open({str(marker)!r}, 'w')"])
        self.assertFalse(marker.exists())

    def test_systemctl_targets_the_user_manager(self):
        self.assertEqual(self.d.pid("hermes-gateway.service"), "4242")
        self.d.system("stop", "agent-interface.service", "hermes-gateway.service")
        self.assertEqual(self.host.systemctl_calls(), [
            ["--user", "show", "hermes-gateway.service", "-p", "MainPID", "--value"],
            ["--user", "stop", "agent-interface.service", "hermes-gateway.service"]])

    def test_native_pins_the_configured_home_before_bootstrap_imports(self):
        (self.host.source / "hermes_bootstrap.py").write_text(
            "import os\nLATCHED = os.environ.get('HERMES_HOME')\n")
        with mock.patch.dict(os.environ, HERMES_HOME=str(self.host.root / "inherited-profile")):
            output = self.d.native("print(hermes_bootstrap.LATCHED)")
        self.assertEqual(output.strip(), str(self.host.home))

    def test_atomic_journal_and_switch_leave_no_temporary_files(self):
        self.d.journal("release-switched")
        phase = json.loads((self.host.ops / "phase.json").read_text())
        self.assertEqual((phase["operationId"], phase["phase"]), ("op-1", "release-switched"))
        self.d.atomic(self.host.ops / "phase.json", b"replaced\n")
        self.assertEqual((self.host.ops / "phase.json").read_bytes(), b"replaced\n")
        self.d.switch(self.host.base / "releases/new")
        self.assertEqual((self.host.base / "current").resolve(), (self.host.base / "releases/new").resolve())
        self.assertEqual(sorted(path.name for path in self.host.ops.iterdir()), ["commands.log", "phase.json"])
        self.assertEqual(sorted(path.name for path in self.host.base.iterdir()), ["current", "releases", "shared"])

    def test_wait_retries_transient_reads_but_never_swallows_a_guard(self):
        answers = iter([OSError("not yet"), ValueError("partial json"), False, True])
        def predicate():
            answer = next(answers)
            if isinstance(answer, Exception): raise answer
            return answer
        with mock.patch.object(deploy_common.time, "sleep"):
            self.d.wait(predicate)
            with self.assertRaises(AssertionError):
                self.d.wait(lambda: (_ for _ in ()).throw(AssertionError("owner replaced")))
        with self.assertRaisesRegex(RuntimeError, "readiness was not confirmed"):
            self.d.wait(lambda: False, 0)

    def gateway(self, **changes):
        record = {"pid": 4242, "gateway_state": "draining", "code_sha": "d" * 40, "hermes_home": str(self.host.home),
                  "agent_interface_gateway_guard": {"schemaVersion": 1, "maintenanceFile": str(self.d.lease), "pendingIngress": 0},
                  "platforms": {"discord": {"state": "connected"}, "discord-kimberly": {"state": "connected"}}, **changes}
        (self.host.home / "gateway_state.json").write_text(json.dumps(record))

    def test_ready_gateway_binds_process_revision_home_guard_and_every_discord_connection(self):
        self.gateway()
        self.assertTrue(self.d.ready_gateway("draining"))
        self.assertFalse(self.d.ready_gateway("running"))
        stamp = {"schemaVersion": 1, "maintenanceFile": "/elsewhere", "pendingIngress": 0}
        for change in ({"pid": 4243}, {"code_sha": "e" * 40}, {"hermes_home": "/elsewhere"},
                       {"agent_interface_gateway_guard": stamp},
                       {"platforms": {"discord": {"state": "connected"}, "discord-kimberly": {"state": "reconnecting"}}}):
            with self.subTest(change=change):
                self.gateway(**change)
                self.assertFalse(self.d.ready_gateway("draining"))

    def test_google_requires_authenticated_http_and_a_fresh_websocket(self):
        verdict = {"authenticatedHttp": True, "freshWebsocket": True}
        self.host.config["googleVerificationCommand"] = [sys.executable, "-c", f"print({json.dumps(json.dumps(verdict))})"]
        self.d.google()
        self.host.config["googleVerificationCommand"] = [sys.executable, "-c", "print('{\"authenticatedHttp\": true}')"]
        with self.assertRaises(AssertionError):
            self.d.google()

    def test_app_ready_needs_health_and_signed_out_refusals(self):
        replies = {"/api/health": (200, b'{"ok": true}'), "/api/bootstrap": (401, b"{}"), "/api/auth/local": (403, b"{}")}
        class App(http.server.BaseHTTPRequestHandler):
            def reply(self):
                code, body = replies[self.path]
                self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers()
                self.wfile.write(body)
            do_GET = do_POST = reply
            def log_message(self, *_): pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), App)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.d.origin = f"http://127.0.0.1:{server.server_address[1]}"
        self.assertTrue(self.d.app_ready())
        for path, reply in (("/api/bootstrap", (200, b"{}")), ("/api/auth/local", (200, b"{}")), ("/api/health", (200, b'{"ok": false}'))):
            with self.subTest(path=path):
                saved = replies[path]
                replies[path] = reply
                self.assertFalse(self.d.app_ready())
                replies[path] = saved


class FenceTests(unittest.TestCase):
    def test_fence_names_the_guard_and_still_counts_as_an_assertion(self):
        deploy_common.fence(True, "unused")
        with self.assertRaisesRegex(deploy_common.Fence, "^gateway exited cleanly$") as caught:
            deploy_common.fence(0, "gateway exited cleanly")
        self.assertIsInstance(caught.exception, AssertionError)

    def test_operator_output_names_the_fence_behind_a_later_failure(self):
        self.assertEqual(deploy_common.tripped(RuntimeError("command failed")), "")
        try:
            try:
                deploy_common.fence(False, "drain request names this operation")
            except AssertionError:
                raise RuntimeError("rollback failed")
        except RuntimeError as error:
            self.assertEqual(deploy_common.tripped(error), " Stopped at fence: drain request names this operation.")

    def test_cutover_tool_refuses_under_python_optimize_and_names_the_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text("{}")
            config.chmod(0o644)
            done = subprocess.run([sys.executable, "-O", str(TOOLS / "deploy-guarded-app-release.py"), "--config", str(config)],
                                  capture_output=True, text=True, timeout=30)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("Fence: config file is private and owned by this user", done.stderr)

    def test_tools_guard_with_named_unique_fences_instead_of_assert(self):
        # python -O strips assert. Host program strings are covered by their own refusal.
        for path in sorted(TOOLS.glob("*.py")):
            with self.subTest(tool=path.name):
                tree = ast.parse(path.read_text())
                self.assertEqual([node.lineno for node in ast.walk(tree) if isinstance(node, ast.Assert)], [])
                names = [node.args[1] for node in ast.walk(tree)
                         if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "fence"]
                self.assertTrue(all(isinstance(name, ast.Constant) and isinstance(name.value, str) for name in names))
                values = [name.value for name in names]
                self.assertEqual(sorted(value for value in set(values) if values.count(value) > 1), [])


class ToolWiringTests(unittest.TestCase):
    TOOLS = ("deploy-app-release.py", "deploy-guarded-app-release.py", "recover-app-after-native-update.py")

    def test_tools_bind_each_shared_step_to_its_own_name(self):
        # A swapped tuple binding would run the wrong host step under a familiar name.
        for name in self.TOOLS:
            for node in ast.walk(ast.parse((TOOLS / name).read_text())):
                if isinstance(node, ast.Assign) and isinstance(node.value, ast.Tuple) and isinstance(node.targets[0], ast.Tuple):
                    pairs = list(zip(node.targets[0].elts, node.value.elts))
                    for target, value in pairs:
                        if isinstance(value, ast.Attribute) and isinstance(value.value, ast.Name) and value.value.id == "d":
                            self.assertEqual(target.id, value.attr, name)
                            self.assertTrue(callable(getattr(deploy_common.Deployment, value.attr, None)), value.attr)

    def test_idle_wait_recognizes_the_guarded_preflights_busy_fence(self):
        spec = importlib.util.spec_from_file_location("prepare_when_idle", TOOLS / "prepare-when-idle.py")
        idle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(idle)
        source = (TOOLS / "deploy-guarded-app-release.py").read_text()
        busy = [node.args[1].value for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
                and getattr(node.func, "id", None) == "fence" and ast.unparse(node.args[0]) == "gate['active'] is False and gate['busy'] == []"]
        self.assertEqual(len(busy), 1)
        # Only the fence's own line, as a traceback without source would print it.
        self.assertTrue(idle.BUSY.search("deploy_common.Fence: " + busy[0]))
        gateway = sorted((node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
            and getattr(node.func, "id", None) == "fence" and "record['active_agents'] == 0" in ast.unparse(node.args[0])),
            key=lambda node: node.lineno)
        self.assertEqual(len(gateway), 2)
        self.assertTrue(idle.BUSY.search("deploy_common.Fence: " + gateway[0].args[1].value))
        self.assertFalse(idle.BUSY.search("deploy_common.Fence: " + gateway[1].args[1].value))
        self.assertFalse(idle.BUSY.search("deploy_common.Fence: release serves the configured web build"))

    def test_staged_recovery_ships_the_shared_module_its_helper_pins(self):
        spec = importlib.util.spec_from_file_location("stage_recovery", TOOLS / "stage-recovery-tools.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        spec = importlib.util.spec_from_file_location("recover_app", TOOLS / "recover-app-after-native-update.py")
        recover = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recover)
        self.assertEqual(stage.FILES, ("recover-app-after-native-update.py", recover.SHARED_FUNCTIONS))
        self.assertTrue((TOOLS / recover.SHARED_FUNCTIONS).is_file())


if __name__ == "__main__":
    unittest.main()
