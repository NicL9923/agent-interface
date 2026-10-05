"""Shared computer admission and identity checks without a desktop dependency."""
import contextlib
import importlib.util
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import threading
import time
import subprocess
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("computer", Path(__file__).resolve().parents[1] / "src/hermes/computer.py")
computer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(computer)
spec = importlib.util.spec_from_file_location("computer_host", Path(__file__).resolve().parents[1] / "src/hermes/computer_host.py")
computer_host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(computer_host)


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
