"""Shared deploy and recovery host steps, against fake systemctl, native and app processes."""
import ast
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

from support import load_source

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

    def test_voice_plugin_link_follows_current_and_never_replaces_another_path(self):
        link = self.host.home / "plugins/wildbots-voice"
        self.assertTrue(self.d.voice_plugin_ready())
        self.d.link_voice_plugin()
        self.assertEqual(os.readlink(link), str(self.host.base / "current/src/hermes/wildbots_voice"))
        # Activating the next release moves the plugin with current; the link itself stays.
        for release in ("old", "new"):
            (self.host.base / "releases" / release / "src/hermes/wildbots_voice").mkdir(parents=True)
        self.d.switch(self.host.base / "releases/new")
        self.assertEqual(link.resolve(), (self.host.base / "releases/new/src/hermes/wildbots_voice").resolve())
        self.d.link_voice_plugin()
        self.assertEqual(sorted(path.name for path in link.parent.iterdir()), ["wildbots-voice"])
        # A folder or a link someone else put there is never replaced.
        for occupy in (lambda: link.mkdir(), lambda: link.symlink_to(self.host.base / "releases/old/src/hermes/wildbots_voice")):
            link.unlink() if link.is_symlink() else link.rmdir()
            occupy()
            with self.subTest(occupied=link.is_symlink()):
                self.assertFalse(self.d.voice_plugin_ready())
                with self.assertRaisesRegex(deploy_common.Fence, "voice plugin path"):
                    self.d.link_voice_plugin()

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


class AcquireThenStopTests(unittest.TestCase):
    """The release's cutover start: the app's gate, then Hermes's lease, then the app stop.

    The add-on's maintenance RPC is faked at its call; systemctl is a fake executable that
    records what the host looked like when each call arrived and fails on any other unit or verb.
    """
    PREVIOUS = b'{"phase": "idle", "maintenance": false}\n'
    BLOCKED = b'{"phase": "blocked", "maintenance": true, "operationId": "op-1"}\n'

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.host = Fixture(Path(temporary.name))
        self.addCleanup(self.host.close)
        self.d = self.host.deployment
        state = self.host.root / "upgrade"
        (state / "requests").mkdir(parents=True)
        self.status, self.requests = state / "status.json", state / "requests"
        self.status.write_bytes(self.PREVIOUS)
        self.host.config["upgradeStateDir"] = str(state)
        self.events = self.host.root / "events.jsonl"
        # What a stop also does on the host, standing in for an app request the stop cut short.
        self.on_stop = self.host.root / "on-stop.json"
        self.on_stop.write_text("{}")
        self.d.systemctl = str(executable(self.host.root / "systemctl", f"""
import json, os, sys
from pathlib import Path
def phase():
    path = Path({str(self.host.ops / "phase.json")!r})
    return json.loads(path.read_text())["phase"] if path.exists() else None
if sys.argv[1:] != ["--user", "stop", "agent-interface.service"]:
    sys.exit("unexpected systemctl call: " + " ".join(sys.argv[1:]))
with open({str(self.events)!r}, "a") as events:
    events.write(json.dumps(["stop", phase(), Path({str(self.status)!r}).read_text(), os.path.lexists({str(self.d.lease)!r})]) + "\\n")
for path, text in json.loads(Path({str(self.on_stop)!r}).read_text()).items(): Path(path).write_text(text)
"""))
        self.answers = {}

    def rpc(self, action):
        """The add-on's maintenance RPC. Each test configures the actions it expects."""
        phase = self.host.ops / "phase.json"
        with self.events.open("a") as events:
            events.write(json.dumps([action, json.loads(phase.read_text())["phase"] if phase.exists() else None,
                                     self.status.read_text(), os.path.lexists(self.d.lease)]) + "\n")
        if action not in self.answers:
            raise AssertionError("unexpected maintenance RPC: " + action)
        return self.answers[action]()

    def acquired(self):
        self.d.lease.write_text(json.dumps({"operationId": "op-1"}))
        return {"active": True, "operationId": "op-1", "busy": []}

    def released(self, busy=()):
        if self.d.lease.exists():
            self.d.lease.unlink()
        return {"active": False, "operationId": None, "busy": list(busy)}

    def busy(self):
        # The add-on's handler returns this error and writes no lease (src/hermes/extension.py).
        raise deploy_common.Answered({"code": 409, "message": "Hermes still has active work; no maintenance lease acquired"})

    def run_steps(self):
        self.d.acquire_then_stop_app(self.rpc, self.BLOCKED, self.PREVIOUS)

    def recorded(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def phase(self):
        return json.loads((self.host.ops / "phase.json").read_text())["phase"]

    def test_acquires_under_the_apps_closed_gate_before_stopping_the_app(self):
        self.answers["acquire"] = self.acquired
        self.run_steps()
        blocked = self.BLOCKED.decode()
        # [call, journal phase, update status, lease present] at the moment of each call.
        self.assertEqual(self.recorded(), [["acquire", "maintenance-acquiring", blocked, False],
                                           ["stop", "owned-maintenance-acquired", blocked, True]])
        self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "owned-maintenance-acquired"))

    def test_status_an_app_request_wrote_during_the_stop_is_replaced_by_the_blocked_status(self):
        self.answers["acquire"] = self.acquired
        self.on_stop.write_text(json.dumps({str(self.status): '{"phase": "checking", "maintenance": false}'}))
        self.run_steps()
        self.assertEqual(self.status.read_bytes(), self.BLOCKED)

    def test_update_request_admitted_before_the_stop_holds_the_release_for_review(self):
        self.answers["acquire"] = self.acquired
        self.on_stop.write_text(json.dumps({str(self.requests / "r.json"): '{"status": "pending"}'}))
        with self.assertRaisesRegex(deploy_common.Fence, "^pending update requests complete after the app stopped$"):
            self.run_steps()
        # Not a harmless refusal: the lease stays held and the release is held for review.
        self.assertTrue(self.d.lease.exists())

    def test_busy_work_at_acquire_releases_restores_the_status_and_never_stops_the_app(self):
        self.answers.update(acquire=self.busy, release=lambda: self.released([{"profile": "nic", "state": "queued"}]))
        with self.assertRaisesRegex(deploy_common.Refused, '"profile": "nic"') as caught:
            self.run_steps()
        self.assertEqual([event[0] for event in self.recorded()], ["acquire", "release"])
        self.assertEqual((self.status.read_bytes(), self.phase(), self.d.lease.exists()), (self.PREVIOUS, "maintenance-refused", False))
        self.assertIsInstance(caught.exception.__cause__, deploy_common.Answered)

    def test_another_error_answer_is_held_for_review_without_a_release(self):
        # Same code as the busy refusal, but no busy work to wait out: a rerun cannot succeed.
        def other_owner():
            raise deploy_common.Answered({"code": 409, "message": "Another maintenance operation owns this lease"})
        self.answers["acquire"] = other_owner
        with self.assertRaisesRegex(deploy_common.Answered, "Another maintenance operation") as caught:
            self.run_steps()
        self.assertNotIsInstance(caught.exception, deploy_common.Refused)
        self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "maintenance-acquiring"))
        self.assertEqual([event[0] for event in self.recorded()], ["acquire"])

    def test_unanswered_acquire_keeps_the_blocked_status_since_its_lease_can_still_appear(self):
        """No answer means the add-on may still be preempting compactions before it writes the lease."""
        def lost_after_lease():
            self.acquired()
            raise subprocess.TimeoutExpired("python", 145)
        def no_answer():
            raise RuntimeError("A deployment command failed; private log retained")
        cases = (
            # The answer was lost on its way back: the release still removes the lease it finds.
            ("answer lost after the lease", lost_after_lease, self.released, [["acquire", False], ["release", True]], False),
            # The handler is still preempting: release finds nothing, and the lease is written once it returns.
            ("lease written after the release", no_answer,
             lambda: (self.released(), self.acquired())[0], [["acquire", False], ["release", False]], True),
            ("release unreachable", no_answer, no_answer, [["acquire", False], ["release", False]], False),
        )
        for name, acquire, release, calls, late_lease in cases:
            with self.subTest(name):
                self.status.write_bytes(self.PREVIOUS)
                self.d.lease.unlink(missing_ok=True)
                self.events.unlink(missing_ok=True)
                self.answers.update(acquire=acquire, release=release)
                with self.assertRaisesRegex(deploy_common.Fence, "^Hermes answered maintenance acquire$") as caught:
                    self.run_steps()
                self.assertNotIsInstance(caught.exception, deploy_common.Refused)
                self.assertEqual([event[0::3] for event in self.recorded()], calls)
                # The app keeps refusing sends: a lease that appears later never meets an idle status.
                self.assertEqual((self.status.read_bytes(), self.phase(), self.d.lease.exists()), (self.BLOCKED, "maintenance-acquiring", late_lease))

    def test_unexpected_acquire_answers_are_refusals_once_released(self):
        def other_lease():
            self.d.lease.write_text(json.dumps({"operationId": "op-1", "owner": "someone else"}))
            return {"active": True, "operationId": "op-1", "busy": []}
        for answer, why in ((lambda: {**self.acquired(), "busy": [{"profile": "nic"}]}, "maintenance acquired by this operation with no busy work"),
                            (other_lease, "maintenance lease names this operation")):
            with self.subTest(why=why):
                self.status.write_bytes(self.PREVIOUS)
                self.answers.update(acquire=answer, release=self.released)
                with self.assertRaises(deploy_common.Refused) as caught:
                    self.run_steps()
                self.assertEqual(str(caught.exception.__cause__), why)
                self.assertEqual(self.status.read_bytes(), self.PREVIOUS)
        self.assertNotIn("stop", [event[0] for event in self.recorded()])

    def test_uncertain_refusal_keeps_the_blocked_status_for_review(self):
        pending = self.requests / "r.json"
        cases = (
            ("refused: maintenance released", lambda: None, lambda: {"active": True, "operationId": "op-1", "busy": []}),
            ("refused: no maintenance lease remains", lambda: None, lambda: (self.acquired(), {"active": False, "busy": []})[1]),
            ("refused: update status is still this operation's blocked status",
             lambda: self.status.write_text('{"phase": "installing", "maintenance": true}'), self.released),
            ("refused: pending update requests are complete", lambda: pending.write_text('{"status": "pending"}'), self.released),
        )
        for why, during_acquire, release in cases:
            with self.subTest(why=why):
                self.status.write_bytes(self.PREVIOUS)
                pending.unlink(missing_ok=True)
                self.d.lease.unlink(missing_ok=True)
                def acquire(during_acquire=during_acquire):
                    during_acquire()
                    return self.busy()
                self.answers.update(acquire=acquire, release=release)
                with self.assertRaisesRegex(deploy_common.Fence, "^" + why + "$") as caught:
                    self.run_steps()
                self.assertNotIsInstance(caught.exception, deploy_common.Refused)
                self.assertNotEqual(self.status.read_bytes(), self.PREVIOUS)
                self.assertEqual(self.phase(), "maintenance-acquiring")
        self.assertNotIn("stop", [event[0] for event in self.recorded()])

    def test_a_failed_release_is_not_a_refusal(self):
        def release():
            raise RuntimeError("A deployment command failed; private log retained")
        self.answers.update(acquire=self.busy, release=release)
        with self.assertRaises(RuntimeError) as caught:
            self.run_steps()
        self.assertNotIsInstance(caught.exception, deploy_common.Refused)
        self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "maintenance-acquiring"))
        self.assertNotIn("stop", [event[0] for event in self.recorded()])


class MaintenanceRpcTests(unittest.TestCase):
    """The release helper's real NATIVE maintenance RPC, run as the guarded tool runs it.

    The service-ticket endpoint is a local HTTP server. The WebSocket client library is a fake
    module in the fake Hermes source, which NATIVE puts first on sys.path; it replays the messages
    a test scripts and fails on any receive the test did not script.
    """
    REQUEST = {"action": "rpc", "key": "service-key", "operation": "op-1"}
    BUSY = {"code": 409, "message": "Hermes still has active work; no maintenance lease acquired"}

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.host = Fixture(Path(temporary.name))
        self.addCleanup(self.host.close)
        self.d = self.host.deployment
        source = self.host.source
        (source / "hermes_bootstrap.py").write_text("")
        (source / "websockets/sync").mkdir(parents=True)
        (source / "websockets/__init__.py").write_text("")
        (source / "websockets/sync/__init__.py").write_text("")
        self.script, self.calls = self.host.root / "ws-script.json", self.host.root / "ws-calls.jsonl"
        (source / "websockets/sync/client.py").write_text(f"""
import json
from pathlib import Path
def record(*event):
    with open({str(self.calls)!r}, "a") as calls: calls.write(json.dumps(event) + "\\n")
class Socket:
    def __init__(self): self.steps = json.loads(Path({str(self.script)!r}).read_text())
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def send(self, message): record("send", json.loads(message))
    def recv(self, timeout):
        record("recv", timeout)
        if not self.steps: raise AssertionError("unscripted WebSocket receive")
        step = self.steps.pop(0)
        if step == "silence": raise TimeoutError("timed out while waiting for a message")
        return json.dumps(step)
def connect(url, *, open_timeout, close_timeout):
    record("connect", url)
    return Socket()
""")
        class Tickets(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                ok = self.path == "/api/agent-interface/service-ticket" and self.headers["Authorization"] == "Bearer service-key"
                body = json.dumps({"ticket": "ticket-1"}).encode() if ok else b"{}"
                self.send_response(200 if ok else 403); self.end_headers(); self.wfile.write(body)
            def log_message(self, *_): pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Tickets)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.request = dict(self.REQUEST, source=str(source), origin=f"http://127.0.0.1:{server.server_address[1]}")
        # Exactly the guarded tool's rpc command.
        helper = ROOT / "scripts/hermes-upgrade-linux.py"
        self.argv = [sys.executable, "-I", "-c", "import runpy; m=runpy.run_path(" + repr(str(helper)) + "); exec(m['NATIVE'])"]

    def call(self, method, *steps):
        self.script.write_text(json.dumps(list(steps)))
        return self.d.maintenance_rpc(self.argv, dict(self.request, method=method))

    def recorded(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def test_result_returns_and_acquire_waits_out_the_add_ons_compaction_preempts(self):
        acquired = {"active": True, "operationId": "op-1", "busy": []}
        self.assertEqual(self.call("acquire", {"method": "event"}, {"id": 1, "result": acquired}), acquired)
        sent = {"jsonrpc": "2.0", "id": 1, "method": "agent-interface.maintenance",
                "params": {"action": "acquire", "operation_id": "op-1", "service_key": "service-key"}}
        port = self.request["origin"].rsplit(":", 1)[1]
        # The add-on preempts up to 30 s per canonical Bot Chat before it answers acquire.
        self.assertEqual(self.recorded(), [["connect", f"ws://127.0.0.1:{port}/api/ws?ticket=ticket-1"], ["send", sent],
                                           ["recv", 120], ["recv", 120]])
        self.calls.unlink()
        self.call("release", {"id": 1, "result": {"active": False, "operationId": None, "busy": []}})
        self.assertEqual(self.recorded()[-1], ["recv", 15])

    def test_an_error_answer_is_reported_as_answered_with_the_add_ons_error(self):
        with self.assertRaises(deploy_common.Answered) as caught:
            self.call("acquire", {"id": 1, "error": self.BUSY})
        self.assertEqual(caught.exception.error, self.BUSY)
        # The child still fails as every other NATIVE caller expects.
        self.assertIn("RuntimeError: Native maintenance request rejected", (self.host.ops / "commands.log").read_text())

    def test_no_answer_is_a_plain_failure_not_an_answer(self):
        with self.assertRaises(RuntimeError) as caught:
            self.call("acquire", "silence")
        self.assertNotIsInstance(caught.exception, deploy_common.Answered)
        self.assertIn("TimeoutError", (self.host.ops / "commands.log").read_text())

    def test_a_failed_child_is_answered_only_when_its_last_line_is_the_answered_error(self):
        for stdout in ('{"active": false}', '{"answeredError": "409"}', 'answeredError'):
            with self.subTest(stdout=stdout):
                child = executable(self.host.root / "child", f"import sys; print({stdout!r}); sys.exit(1)")
                with self.assertRaises(RuntimeError) as caught:
                    self.d.maintenance_rpc([str(child)], dict(self.request, method="acquire"))
                self.assertNotIsInstance(caught.exception, deploy_common.Answered)


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
                raise RuntimeError("rollback failed")  # noqa: B904 - implicit chaining is the case under test
        except RuntimeError as error:
            self.assertEqual(deploy_common.tripped(error), " Stopped at fence: drain request names this operation.")

    def test_cutover_tool_refuses_under_python_optimize_and_names_the_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text("{}")
            config.chmod(0o644)
            done = subprocess.run([sys.executable, "-O", str(TOOLS / "deploy-guarded-app-release.py"), "--config", str(config)],
                                  capture_output=True, text=True, timeout=30, check=False)
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
        idle = load_source(".agents/tools/prepare-when-idle.py", "prepare_when_idle")
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

    def test_guarded_check_exits_before_any_step_that_changes_the_host(self):
        # --check promises no service changes: under the update claim, everything before its exit
        # only reads. The cutover steps run inside the try that follows it.
        tree = ast.parse((TOOLS / "deploy-guarded-app-release.py").read_text())
        claim = next(node for node in ast.walk(tree) if isinstance(node, ast.With))
        check = next(index for index, node in enumerate(claim.body) if isinstance(node, ast.If) and ast.unparse(node.test) == "args.check")
        self.assertEqual(ast.unparse(claim.body[check].body[-1]), "sys.exit(0)")
        calls = [node for statement in claim.body[:check] for node in ast.walk(statement) if isinstance(node, ast.Call)]
        names = {ast.unparse(node.func) for node in calls}
        self.assertFalse(names & {"atomic", "journal", "system", "d.acquire_then_stop_app", "native"}, names)
        self.assertEqual({ast.unparse(node) for node in calls if ast.unparse(node.func) == "rpc"}, {"rpc('status')"})
        self.assertIsInstance(claim.body[check + 1], ast.Try)
        self.assertIn("d.acquire_then_stop_app", {ast.unparse(node.func) for node in ast.walk(claim.body[check + 1]) if isinstance(node, ast.Call)})

    def test_guarded_maintenance_rpc_tells_an_error_answer_from_no_answer(self):
        # A plain run() would turn the busy refusal into a lost answer, and every refusal into a review.
        tree = ast.parse((TOOLS / "deploy-guarded-app-release.py").read_text())
        rpc = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "rpc")
        self.assertEqual(ast.unparse(rpc.body[-1].value.func), "d.maintenance_rpc")

    def test_staged_recovery_ships_the_shared_module_its_helper_pins(self):
        stage = load_source(".agents/tools/stage-recovery-tools.py", "stage_recovery")
        recover = load_source(".agents/tools/recover-app-after-native-update.py", "recover_app")
        self.assertEqual(stage.FILES, ("recover-app-after-native-update.py", recover.SHARED_FUNCTIONS))
        self.assertTrue((TOOLS / recover.SHARED_FUNCTIONS).is_file())


if __name__ == "__main__":
    unittest.main()
