"""Shared computer admission and identity checks without a desktop dependency."""
import contextlib
import importlib.util
import io
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import threading
import time
import subprocess
import sys
import types
import unittest
from unittest.mock import Mock, patch

from support import load_source

computer = load_source("src/hermes/computer.py", "computer")
computer_host = load_source("src/hermes/computer_host.py", "computer_host")


class TestLease:
    HUMAN = "human"
    class HumanHasControl(RuntimeError):
        pass

    def __init__(self):
        self.value = types.SimpleNamespace(holder="agent", viewer_id=None, epoch=0)

    def get(self, **kwargs):
        return self.value

    def acquire(self, viewer, **kwargs):
        self.value = types.SimpleNamespace(holder="human", viewer_id=viewer, epoch=self.value.epoch + 1)
        return self.value

    def release(self, viewer, **kwargs):
        if self.value.viewer_id == viewer:
            self.value = types.SimpleNamespace(holder="agent", viewer_id=None, epoch=self.value.epoch + 1)
        return self.value

    def assert_agent_may_act(self, **kwargs):
        if self.value.holder == "human":
            raise self.HumanHasControl("A human is using the household computer")


def try_lock(path, queue):
    instance = computer.Computer(path, "http://127.0.0.1:9222", None, None)
    try:
        with instance.operation(timeout=.1):
            queue.put("acquired")
    except computer.ComputerError:
        queue.put("busy")


class BrowserTargetRecoveryTests(unittest.TestCase):
    def recover(self, disappear_after, close_error=False):
        clock = [0.0]
        queries, closed = [], []
        request = {}

        def send(message):
            request.update(json.loads(message))

        def receive(timeout):
            if request["method"] == "Target.getTargets":
                queries.append(True)
                present = ["unrelated"]
                if disappear_after is None or len(queries) <= disappear_after:
                    present.append("interrupted")
                result = {"targetInfos": [{"targetId": target} for target in present]}
            else:
                closed.append(request["params"]["targetId"])
                if close_error:
                    return json.dumps({"id": request["id"], "error": {"message": "No target with given id found"}})
                result = {"success": True}
            return json.dumps({"id": request["id"], "result": result})

        socket = types.SimpleNamespace(send=send, recv=receive)
        ipc = types.SimpleNamespace(identify=lambda *a, **k: None,
            pid_path=lambda name: types.SimpleNamespace(exists=lambda: False), ping=lambda *a, **k: False)
        admin = types.SimpleNamespace(_fingerprinted_pending_generation=lambda path: None)
        modules = {"browser_harness": types.SimpleNamespace(_ipc=ipc, admin=admin),
            "websockets.sync.client": types.SimpleNamespace(connect=lambda *a, **k: contextlib.nullcontext(socket))}
        opener = types.SimpleNamespace(open=lambda *a, **k: io.BytesIO(
            b'{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser"}'))
        record = {"endpoint": "http://127.0.0.1:9222", "targets": ["interrupted"]}
        with (patch.dict(sys.modules, modules), patch.dict(os.environ, {"BU_NAME": "recovery-test"}),
              patch.object(sys, "stdin", io.StringIO(json.dumps(record))),
              patch("urllib.request.build_opener", return_value=opener),
              patch.object(time, "monotonic", side_effect=lambda: clock[0]),
              patch.object(time, "sleep", side_effect=lambda duration: clock.__setitem__(0, clock[0] + duration))):
            exec(computer.HARNESS_RECOVERY, {})
        self.assertEqual(closed, ["interrupted"])
        return len(queries)

    def test_waits_until_asynchronously_closed_target_disappears(self):
        self.assertEqual(self.recover(disappear_after=3), 4)

    def test_target_disappearing_before_close_is_already_recovered(self):
        self.assertEqual(self.recover(disappear_after=1, close_error=True), 2)

    def test_close_acknowledgement_or_error_cannot_hide_a_running_target(self):
        for close_error in (False, True):
            with self.subTest(close_error=close_error), self.assertRaisesRegex(RuntimeError, "still running"):
                self.recover(disappear_after=None, close_error=close_error)


class ComputerFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / "computer"
        self.lease = TestLease()
        self.starts = []
        self.runtime = types.SimpleNamespace(start=lambda: self.starts.append(True),
            status=lambda: types.SimpleNamespace(supported=True, installed=True, running=True))
        self.instance = computer.Computer(self.home, "http://127.0.0.1:9222", self.runtime, self.lease)
        self.scope = patch.object(computer, "resource_scope", lambda home: contextlib.nullcontext())
        self.scope.start()
        self.env = patch.dict(os.environ, {"HERMES_AGENT_INTERFACE_TOKEN": "private-test-key", "HERMES_AGENT_INTERFACE_MAINTENANCE_FILE": ""})
        self.env.start()
        self.instance._browser_ready = lambda: True
        self.instance._private_dir()

    def tearDown(self):
        self.env.stop()
        self.scope.stop()
        self.temp.cleanup()

    def member(self, actor="one", name="Member one"):
        with self.instance.operation():
            _, _, viewer = self.instance._viewer({"actorId": actor, "actorName": name}, create=True)
        return {"actorId": actor, "actorName": name, "viewerId": viewer, "service_key": "private-test-key"}


class ComputerTests(ComputerFixture):
    def test_member_identity_survives_coordinator_restart(self):
        first = self.member()
        restarted = computer.Computer(self.home, self.instance.endpoint, self.runtime, self.lease)
        with restarted.operation():
            _, _, viewer = restarted._viewer({"actorId": "one", "actorName": "Updated name"}, create=True)
        self.assertEqual(first["viewerId"], viewer)
        self.assertEqual((self.home / "bot-desktop/computer-viewers.json").stat().st_mode & 0o777, 0o600)

    def test_another_member_cannot_take_or_release_human_control(self):
        owner, other = self.member(), self.member("two", "Member two")
        self.instance.request({**owner, "action": "take"})
        for action in ("take", "release"):
            with self.assertRaisesRegex(computer.ComputerError, "Another person"):
                self.instance.request({**other, "action": action})
        self.assertEqual(self.lease.get().viewer_id, owner["viewerId"])
        self.assertTrue(self.instance.status(owner)["control"]["mine"])
        self.assertFalse(self.instance.status(other)["control"]["mine"])
        self.instance.request({**owner, "action": "release"})
        self.assertEqual(self.instance.status(owner)["control"]["kind"], "idle")

    def test_reading_or_inventing_another_viewer_id_does_not_grant_control(self):
        owner, other = self.member(), self.member("two", "Member two")
        for viewer in (owner["viewerId"], "invented"):
            with self.assertRaisesRegex(computer.ComputerError, "does not belong"):
                self.instance.request({**other, "viewerId": viewer, "action": "take"})

    def test_private_authentication_is_required_for_control(self):
        member = self.member()
        for action in ("take", "release", "observe"):
            with self.assertRaisesRegex(computer.ComputerError, "Private application authentication"):
                self.instance.request({**member, "action": action, "service_key": "wrong"})

    def test_human_control_refuses_every_bot_capture_and_action(self):
        member = self.member()
        self.instance.request({**member, "action": "take"})
        with self.assertRaises(TestLease.HumanHasControl):
            with self.instance.bot_operation("Assistant"):
                self.fail("The bot must never be admitted")
        self.assertEqual(self.starts, [])

    def test_hand_over_waits_for_the_complete_running_bot_call(self):
        member = self.member()
        started, finish, taken = threading.Event(), threading.Event(), threading.Event()
        def bot():
            with self.instance.bot_operation("Assistant"):
                started.set()
                self.assertTrue(finish.wait(2))
        def take():
            self.instance.request({**member, "action": "take"})
            taken.set()
        worker = threading.Thread(target=bot)
        worker.start()
        self.assertTrue(started.wait(1))
        self.assertEqual(self.instance.status()["control"], {"kind": "bot", "name": "Assistant"})
        taker = threading.Thread(target=take)
        taker.start()
        self.assertFalse(taken.wait(.1))
        finish.set()
        worker.join(2)
        taker.join(2)
        self.assertTrue(taken.is_set())
        self.assertEqual(self.lease.get().holder, "human")

    def test_human_can_take_during_secret_wait_and_bot_never_continues(self):
        member = self.member()
        waiting, answered = threading.Event(), threading.Event()
        failures, continued = [], []
        def bot():
            try:
                with self.instance.bot_operation("Assistant"):
                    with self.instance.suspend_for_prompt():
                        waiting.set()
                        self.assertTrue(answered.wait(2))
                    continued.append("secret-write")
            except TestLease.HumanHasControl as error:
                failures.append(error)
        worker = threading.Thread(target=bot); worker.start()
        self.assertTrue(waiting.wait(1))
        self.assertFalse((self.instance.state / "computer-active.json").exists())
        self.instance.request({**member, "action": "take"})
        answered.set(); worker.join(2)
        self.assertFalse(worker.is_alive()); self.assertEqual(len(failures), 1)
        self.assertEqual(continued, [])
        self.assertEqual(self.instance.status(member)["control"]["kind"], "human")

    def test_take_then_release_during_secret_wait_cannot_resume_old_page_work(self):
        member = self.member()
        with self.assertRaisesRegex(computer.ComputerError, "Control changed"):
            with self.instance.bot_operation("Assistant"):
                with self.instance.suspend_for_prompt():
                    self.instance.request({**member, "action": "take"})
                    self.instance.request({**member, "action": "release"})
                self.fail("An old inspection must never save or fill after any human takeover")
        self.assertEqual(self.lease.get().holder, "agent")
        self.assertFalse((self.instance.state / "computer-active.json").exists())

    def test_secure_wait_rechecks_maintenance_and_recovers_activity_when_unchanged(self):
        with self.instance.bot_operation("Assistant"):
            with self.instance.suspend_for_prompt():
                with self.instance.operation(timeout=.1): pass
            self.assertEqual(self.instance.status()["control"], {"kind": "bot", "name": "Assistant"})
        maintenance = self.home / "maintenance.json"
        with patch.dict(os.environ, {"HERMES_AGENT_INTERFACE_MAINTENANCE_FILE": str(maintenance)}):
            with self.assertRaisesRegex(computer.ComputerError, "upgraded"):
                with self.instance.bot_operation("Assistant"):
                    with self.instance.suspend_for_prompt(): maintenance.write_text("{}")
        self.assertFalse((self.instance.state / "computer-active.json").exists())

    def test_expiring_prompt_does_not_clear_another_running_bot_record(self):
        waiting, resumed, started, finished = [threading.Event() for _ in range(4)]
        failures = []
        def first():
            try:
                with self.instance.bot_operation("First"):
                    with self.instance.suspend_for_prompt():
                        waiting.set(); resumed.wait(2)
            except computer.ComputerError: failures.append(True)
        def second():
            with self.instance.bot_operation("Second"):
                started.set(); finished.wait(2)
        one = threading.Thread(target=first); one.start(); self.assertTrue(waiting.wait(1))
        two = threading.Thread(target=second); two.start(); self.assertTrue(started.wait(1))
        # Recovery entered while another caller owns the machine prevents resumption.
        self.instance._write("computer-recovery.json", {})
        resumed.set(); finished.set(); two.join(2); one.join(2)
        self.assertFalse(one.is_alive()); self.assertFalse(two.is_alive())
        self.assertEqual(failures, [True])

    def test_operation_lock_serializes_different_executor_processes(self):
        context = multiprocessing.get_context("spawn")
        queue = context.Queue()
        with self.instance.operation():
            process = context.Process(target=try_lock, args=(str(self.home), queue))
            process.start()
            self.assertEqual(queue.get(timeout=5), "busy")
            process.join(5)
        self.assertEqual(process.exitcode, 0)

    def test_crashed_bot_record_does_not_claim_an_active_owner(self):
        self.instance._write("computer-active.json", {"name": "Crashed assistant"})
        self.assertEqual(self.instance.status()["control"]["kind"], "idle")

    def test_maintenance_lease_blocks_new_bot_actions(self):
        maintenance = self.home / "maintenance.json"
        maintenance.write_text("{}")
        with patch.dict(os.environ, {"HERMES_AGENT_INTERFACE_MAINTENANCE_FILE": str(maintenance)}):
            with self.assertRaisesRegex(computer.ComputerError, "upgraded"):
                with self.instance.bot_operation("Assistant"):
                    self.fail("Maintenance must reject bot admission")

    def test_failed_recovery_blocks_bots_and_humans_but_keeps_retry_available(self):
        member = self.member()
        self.instance._write("computer-recovery.json", {"python": "/qualified/python", "environment": {"BU_NAME": "household-fixture"}})
        with patch.object(self.instance, "recover_harness", return_value=False):
            with self.assertRaisesRegex(computer.ComputerError, "needs recovery"):
                self.instance.request({**member, "action": "take"})
            with self.assertRaisesRegex(computer.ComputerError, "needs recovery"):
                with self.instance.bot_operation("Assistant"):
                    self.fail("An uncertain daemon must block bot admission")
        status = self.instance.status()
        self.assertTrue(status["available"])
        self.assertFalse(status["browserReady"])
        self.assertIn("recovery", status["reason"])

    def test_recovery_child_receives_only_recorded_routing_and_safe_locale(self):
        record = {"python": "/qualified/python", "environment": {"BU_NAME": "household-fixture", "BH_RUNTIME_DIR": "/tmp/private-ipc"}}
        self.instance._write("computer-recovery.json", record)
        with patch.dict(os.environ, {"HOUSEHOLD_TEST_SECRET": "do-not-copy"}), patch.object(computer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertTrue(self.instance.recover_harness(record))
        self.assertNotIn("HOUSEHOLD_TEST_SECRET", run.call_args.kwargs["env"])
        self.assertNotIn("HERMES_AGENT_INTERFACE_TOKEN", run.call_args.kwargs["env"])
        self.assertEqual(run.call_args.kwargs["env"]["BU_NAME"], "household-fixture")
        self.assertFalse((self.instance.state / "computer-recovery.json").exists())

    def test_configuration_is_explicit_and_loopback_only(self):
        with patch.dict(os.environ, {"HERMES_AGENT_INTERFACE_COMPUTER_HOME": ""}):
            self.assertIsNone(computer.configured())
        for endpoint in ("http://example.com:9222", "http://user:pass@127.0.0.1:9222", "http://127.0.0.1:9222/api", "https://127.0.0.1:9222"):
            with patch.dict(os.environ, {"HERMES_AGENT_INTERFACE_COMPUTER_HOME": str(self.home), "HERMES_AGENT_INTERFACE_COMPUTER_CDP_URL": endpoint}):
                with self.assertRaises(computer.ComputerError):
                    computer.configured()


class LocalBrowserTests(ComputerFixture):
    def setUp(self):
        super().setUp()
        self.websocket = "ws://127.0.0.1:9222/devtools/browser/12345678-abcd-1234-abcd-123456789abc"
        self.endpoint = patch.object(self.instance, "_browser_endpoint", return_value=self.websocket)
        self.discovery = self.endpoint.start(); self.addCleanup(self.endpoint.stop)
        self.parent = os.getpid()
        self.child = self.parent + 1
        self.processes = {
            self.parent: types.SimpleNamespace(pid=self.parent, create_time=lambda: 100.0,
                uids=lambda: types.SimpleNamespace(real=os.getuid()), status=lambda: "running"),
            self.child: types.SimpleNamespace(pid=self.child, create_time=lambda: 101.0, ppid=lambda: self.parent,
                uids=lambda: types.SimpleNamespace(real=os.getuid()), status=lambda: "running",
                cmdline=lambda: ["chrome", "--remote-debugging-port=9222"],
                net_connections=lambda **kwargs: [types.SimpleNamespace(status="LISTEN",
                    laddr=types.SimpleNamespace(ip="127.0.0.1", port=9222))]),
        }
        self.psutil = types.SimpleNamespace(Process=lambda pid: self.processes[pid], Error=RuntimeError,
            STATUS_ZOMBIE="zombie", CONN_LISTEN="LISTEN")
        self.modules = patch.dict(sys.modules, {"psutil": self.psutil})
        self.modules.start(); self.addCleanup(self.modules.stop)
        platform = patch.object(computer.sys, "platform", "darwin")
        platform.start(); self.addCleanup(platform.stop)

    def register(self):
        self.instance.register_browser(types.SimpleNamespace(pid=self.child, poll=lambda: None))

    def test_registered_live_browser_requires_matching_websocket_generation(self):
        self.assertFalse(self.instance.verified_local_browser())
        self.register()
        self.assertTrue(self.instance.verified_local_browser())
        self.discovery.return_value = self.websocket + "changed"
        self.assertFalse(self.instance.verified_local_browser())

    def test_stale_processes_wrong_parent_owner_and_port_fail_closed(self):
        self.register()
        child = self.processes[self.child]
        for key, value in (("create_time", lambda: 202.0), ("ppid", lambda: 1),
                           ("uids", lambda: types.SimpleNamespace(real=os.getuid() + 1)),
                           ("status", lambda: "zombie"), ("cmdline", lambda: ["chrome", "--remote-debugging-port=9999"]),
                           ("net_connections", lambda **kwargs: [])):
            with self.subTest(key=key), patch.object(child, key, value):
                self.assertFalse(self.instance.verified_local_browser())
        del self.processes[self.parent]
        self.assertFalse(self.instance.verified_local_browser())

    def test_registration_must_be_private_regular_and_well_formed(self):
        self.register()
        record = self.instance.state / "computer-browser.json"
        record.chmod(0o644)
        self.assertFalse(self.instance.verified_local_browser())
        record.chmod(0o600)
        valid = record.read_text()
        for invalid in ("{", "null", '[]', '{"endpoint":"http://other:9222"}'):
            record.write_text(invalid)
            self.assertFalse(self.instance.verified_local_browser())
        record.unlink()
        target = self.instance.state / "other.json"
        target.write_text(valid)
        record.symlink_to(target)
        self.assertFalse(self.instance.verified_local_browser())

    def test_supervisor_cannot_register_an_unowned_or_exited_child(self):
        for exited in (True, False):
            with self.subTest(exited=exited), patch.object(self.processes[self.child], "ppid", return_value=1):
                with self.assertRaises(computer.ComputerError):
                    self.instance.register_browser(types.SimpleNamespace(pid=self.child, poll=lambda _exited=exited: 0 if _exited else None))

    def test_profile_consent_and_effective_terminal_policy_are_both_required(self):
        self.register()
        cfg = {"browser": {"agent_interface": {"allow_local_network": True}}}
        scope = {"TERMINAL_ENV": "local"}
        class Refusal(ValueError): pass
        modules = {
            "hermes_cli.config": types.SimpleNamespace(read_raw_config=lambda: cfg),
            "hermes_constants": types.SimpleNamespace(get_hermes_home_override=lambda: self.home),
            "tools.terminal_scope": types.SimpleNamespace(get_terminal_scope=lambda: scope,
                terminal_env=lambda name, default: scope.get(name, default), TerminalPolicyUnavailable=Refusal),
            "tools.terminal_tool": types.SimpleNamespace(_ensure_terminal_env_bridged=lambda: None),
        }
        self.instance._local_policy = types.SimpleNamespace(config=modules["hermes_cli.config"],
            constants=modules["hermes_constants"], scope=modules["tools.terminal_scope"],
            terminal=modules["tools.terminal_tool"])
        with patch.dict(sys.modules, modules):
            self.assertTrue(self.instance.profile_local_browser())
            for backend in ("ssh", "docker", "modal", "singularity", "", "unknown"):
                scope["TERMINAL_ENV"] = backend
                self.assertFalse(self.instance.profile_local_browser(), backend)
            scope["TERMINAL_ENV"] = "local"
            for consent in (False, None, "true", 1):
                cfg["browser"]["agent_interface"]["allow_local_network"] = consent
                self.assertFalse(self.instance.profile_local_browser(), str(consent))
            cfg["browser"]["agent_interface"].pop("allow_local_network")
            self.assertFalse(self.instance.profile_local_browser(), "Consent defaults off")
            cfg["browser"]["agent_interface"]["allow_local_network"] = True
            scope = None
            self.assertFalse(self.instance.profile_local_browser(), "Routed policy must never fall back to ambient local")
            scope = {"TERMINAL_ENV": "local"}
            for invalid in (None, [], "true"):
                cfg["browser"] = invalid
                self.assertFalse(self.instance.profile_local_browser())

    def test_linux_identity_uses_kernel_ticks_and_unreadable_stat_fails_closed(self):
        # Field 2 may contain spaces and parentheses. Field 22 is start ticks.
        def proc_stat(path, *args, **kwargs):
            pid = int(path.parent.name)
            return f"{pid} (chrome (worker)) " + " ".join(["S", *(["0"] * 18), str(pid * 100)])
        with patch.object(computer.sys, "platform", "linux"), patch.object(Path, "read_text", proc_stat):
            self.register()
            with patch.object(self.processes[self.child], "create_time", return_value=999.0):
                self.assertTrue(self.instance.verified_local_browser())
            self.assertEqual(self.instance._process_identity(self.child)["started"], self.child * 100)
            with patch.object(Path, "read_text", return_value="malformed"):
                self.assertFalse(self.instance.verified_local_browser())
            with patch.object(Path, "read_text", side_effect=PermissionError):
                self.assertFalse(self.instance.verified_local_browser())

    def test_discovery_rejects_external_or_unidentified_websockets(self):
        self.endpoint.stop()
        for value in ("ws://remote.example:9222/devtools/browser/12345678901234567890",
                      "ws://127.0.0.1:9999/devtools/browser/12345678901234567890",
                      "ws://127.0.0.1:9222/devtools/browser/short", "", None):
            opener = types.SimpleNamespace(open=lambda *a, _value=value, **k: io.BytesIO(
                json.dumps({"webSocketDebuggerUrl": _value}).encode()))
            with self.subTest(value=value), patch("urllib.request.build_opener", return_value=opener):
                self.assertFalse(computer.Computer._browser_ready(self.instance))


class InstallToolsTests(ComputerFixture):
    def setUp(self):
        super().setUp()
        noop = lambda *a, **k: None
        self.native_local = Mock(return_value="native decision")
        self.native_dispatch = Mock(return_value="native dispatch")
        self.config = types.SimpleNamespace(read_raw_config=noop)
        self.constants = types.SimpleNamespace(get_hermes_home_override=noop,
            get_hermes_home=lambda: self.home, profile_name_for_home=lambda home: "patch")
        self.terminal_scope = types.SimpleNamespace(get_terminal_scope=noop, terminal_env=noop,
            TerminalPolicyUnavailable=ValueError)
        self.terminal = types.SimpleNamespace(_ensure_terminal_env_bridged=noop)
        self.registry = types.SimpleNamespace(dispatch=self.native_dispatch)
        self.cdp = types.SimpleNamespace(_get_cdp_override_raw=noop)
        self.cloud = types.SimpleNamespace(_is_local_backend=self.native_local)
        runtime = types.SimpleNamespace(start=noop, desktop_env=noop, stop_if_idle=noop)
        lease = TestLease()
        lease.human_holds = noop; lease.viewer_may_send_input = noop
        modules = {
            "browser_tool": types.SimpleNamespace(), "browser_tool_cdp": self.cdp,
            "browser_tool_cloud": self.cloud,
            "browser_tool_session": types.SimpleNamespace(_run_browser_command=noop, _shares_bot_desktop_browser=noop),
            "browser_tool_lifecycle": types.SimpleNamespace(_cleanup_single_browser_session=noop),
            "browser_use_cli": types.SimpleNamespace(_route_backend=noop, _set_cdp_env=noop, _run_cli_killing_process_group=noop),
            "browser_extension_router": types.SimpleNamespace(routed_browser_handler=noop),
            "browser_cdp_tool": types.SimpleNamespace(),
            "terminal_scope": self.terminal_scope, "terminal_tool": self.terminal,
            "url_safety": types.SimpleNamespace(is_always_blocked_url=Mock(return_value=False)),
            "browser_tool_eval_policy": types.SimpleNamespace(_JS_URL_LITERAL_RE=computer.re.compile(r"https?://[^\s'\"]+")),
        }
        self.native_modules = modules
        fake_modules = {"tools": types.SimpleNamespace(**modules),
            "tools.registry": types.SimpleNamespace(registry=self.registry),
            "tools.bot_desktop": types.SimpleNamespace(runtime=runtime, lease=lease, placement=types.SimpleNamespace()),
            "tools.browser_supervisor_dialogs": types.SimpleNamespace(
                DialogSupervisionMixin=type("Dialogs", (), {"_dialog_timeout_expired": noop})),
            "hermes_cli": types.SimpleNamespace(config=self.config), "hermes_constants": self.constants}
        patched = patch.dict(sys.modules, fake_modules)
        patched.start(); self.addCleanup(patched.stop)
        setting = patch.object(computer, "configured", return_value=(self.home, self.instance.endpoint))
        setting.start(); self.addCleanup(setting.stop)

    def test_matching_override_calls_profile_policy_other_overrides_preserve_native_result(self):
        installed = computer.install_tools()
        with patch.object(installed, "profile_local_browser", return_value=False) as policy:
            self.assertIs(self.cloud._is_local_backend(), False)
            policy.assert_called_once_with()
            self.native_local.assert_not_called()
            policy.reset_mock()
            for override in (None, "", "http://127.0.0.1:1", "http://external.example:9222"):
                with patch.object(self.cdp, "_get_cdp_override_raw", return_value=override):
                    self.assertEqual(self.cloud._is_local_backend(), "native decision")
            policy.assert_not_called()
            self.assertEqual(self.native_local.call_count, 4)

    def test_missing_profile_policy_seams_refuse_install_before_mutating_native(self):
        for module, name in ((self.config, "read_raw_config"), (self.constants, "get_hermes_home_override"),
                             (self.terminal_scope, "get_terminal_scope"), (self.terminal_scope, "terminal_env"),
                             (self.terminal_scope, "TerminalPolicyUnavailable"), (self.terminal, "_ensure_terminal_env_bridged")):
            with self.subTest(name=name), patch.object(module, name, None):
                with self.assertRaisesRegex(computer.ComputerError, "require qualification"):
                    computer.install_tools()
                self.assertIs(self.cloud._is_local_backend, self.native_local)
                self.assertFalse(hasattr(self.registry, "_agent_interface_computer"))

    def test_metadata_dispatch_uses_native_matcher_and_keeps_private_literals_allowed(self):
        installed = computer.install_tools()
        matcher = self.native_modules["url_safety"].is_always_blocked_url
        matcher.side_effect = lambda url: "metadata.google.internal" in url
        cases = (("browser_console", {"expression": 'fetch("http://metadata.google.internal")'}),
                 ("browser_cdp", {"method": "Page.navigate", "params": {"url": "http://metadata.google.internal"}}),
                 ("browser_cdp", {"method": "Runtime.evaluate", "params": {"expression": 'fetch("http://metadata.google.internal")'}}))
        with patch.object(installed, "bot_operation", return_value=contextlib.nullcontext()):
            for name, args in cases:
                result = json.loads(self.registry.dispatch(name, args))
                self.assertFalse(result["success"])
                self.assertIn("metadata", result["error"])
            self.native_dispatch.assert_not_called()
            self.assertEqual(self.registry.dispatch("browser_console", {"expression": 'fetch("https://100.100.0.5")'}), "native dispatch")
        self.assertIn(unittest.mock.call("https://100.100.0.5"), matcher.call_args_list)


class SupervisorRestartTests(ComputerFixture):
    def setUp(self):
        super().setUp()
        self.source = Path(self.temp.name) / "source"
        self.source.mkdir()
        git = lambda *args: subprocess.run(["git", "-C", str(self.source), *args], check=True, capture_output=True)
        self.git = git
        git("init", "-q"); git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "old")
        self.hermes = Path(self.temp.name) / "hermes"
        self.hermes.mkdir()
        self.loaded = computer_host.loaded_code(self.source)

    def gateway(self, state, code_sha):
        (self.hermes / "gateway_state.json").write_text(json.dumps({"gateway_state": state, "code_sha": code_sha}))

    def update_source(self):
        self.git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "new")
        return computer_host.installed_revision(self.source)

    def reason(self):
        return computer_host.restart_reason(self.loaded, self.source, self.hermes)

    def test_restarts_once_the_gateway_runs_the_installed_update(self):
        self.gateway("running", self.loaded[1])
        self.assertIsNone(self.reason())
        new = self.update_source()
        self.gateway("draining", new)
        self.assertIsNone(self.reason(), "An update in progress must finish first")
        self.gateway("running", new)
        self.assertEqual(self.reason(), "Hermes is running revision " + new[:12])

    def test_gateway_still_on_old_code_after_an_outside_update_never_loops(self):
        new = self.update_source()
        restarted = computer_host.loaded_code(self.source)
        self.gateway("running", self.loaded[1])
        self.assertIsNone(computer_host.restart_reason(restarted, self.source, self.hermes))
        self.assertIsNone(self.reason(), "Restarting cannot reach the gateway's revision")
        self.gateway("running", new)
        self.assertIsNone(computer_host.restart_reason(restarted, self.source, self.hermes))

    def test_restarts_after_an_app_release_once_the_gateway_runs(self):
        released = (Path("/releases/new/computer_host.py"), self.loaded[1])
        self.gateway("stopped", self.loaded[1])
        self.assertIsNone(computer_host.restart_reason(released, self.source, self.hermes))
        self.gateway("running", self.loaded[1])
        self.assertEqual(computer_host.restart_reason(released, self.source, self.hermes), "The app release changed")
        (self.hermes / "gateway_state.json").write_text("{")
        self.assertIsNone(computer_host.restart_reason(released, self.source, self.hermes))

    def test_restart_waits_for_human_control_running_bot_and_pending_recovery(self):
        held = contextlib.ExitStack()
        self.lease.acquire("viewer")
        self.assertFalse(computer_host.claim_idle(self.instance, held, computer.ComputerError))
        self.lease.release("viewer")
        with self.instance.bot_operation("Assistant"):
            self.assertFalse(computer_host.claim_idle(self.instance, held, computer.ComputerError))
        self.instance._write("computer-recovery.json", {"pending": True})
        self.assertFalse(computer_host.claim_idle(self.instance, held, computer.ComputerError))
        (self.instance.state / "computer-recovery.json").unlink()
        # Recovery recorded by an action that ends while the supervisor waits for the lock.
        operation = self.instance.operation
        def recovery_left_behind(timeout):
            self.instance._write("computer-recovery.json", {"pending": True})
            return operation(timeout=timeout)
        with patch.object(self.instance, "operation", recovery_left_behind):
            self.assertFalse(computer_host.claim_idle(self.instance, held, computer.ComputerError))
        (self.instance.state / "computer-recovery.json").unlink()
        self.assertTrue(computer_host.claim_idle(self.instance, held, computer.ComputerError))
        with self.assertRaises(computer.ComputerError):
            with self.instance.bot_operation("Assistant"):
                pass
        held.close()
        with self.instance.bot_operation("Assistant"):
            pass


if __name__ == "__main__":
    unittest.main()
