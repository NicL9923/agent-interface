"""Shared deploy and recovery host steps, against fake systemctl, native and app processes."""
import ast
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

from support import load_source

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".agents/tools"
ABSENT = object()  # A change that leaves a key out of a fake record, which None cannot say.
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

    def release(self, name, assets=True):
        """A release directory the way the build leaves it: dist/client with a hashed asset, unless ``assets`` is false."""
        release = self.host.base / "releases" / name
        (release / "dist").mkdir(parents=True, exist_ok=True)
        if assets: (release / "dist/client/assets").mkdir(parents=True, exist_ok=True)
        return release

    def named(self, release):
        file = release / deploy_common.PREVIOUS_RELEASE_FILE
        return json.loads(file.read_text()) if file.exists() else None

    def test_the_release_going_live_is_told_which_release_it_replaces(self):
        old, new = self.release("old"), self.release("new")
        self.d.switch(new)
        self.assertEqual(self.named(new), {"assets": str(old / "dist/client/assets")})
        # The old release is untouched, and the file was written whole, leaving no temporary one.
        self.assertIsNone(self.named(old))
        self.assertEqual(sorted(path.name for path in (new / "dist").iterdir()), ["client", "previous-release.json"])
        # A rollback names the release it came from, so pages opened under it still load.
        self.d.switch(old)
        self.assertEqual(self.named(old), {"assets": str(new / "dist/client/assets")})
        self.assertEqual(self.named(new), {"assets": str(old / "dist/client/assets")})

    def test_a_stale_name_is_replaced_or_removed_when_there_is_nothing_to_name(self):
        old, new = self.release("old"), self.release("new")
        (new / deploy_common.PREVIOUS_RELEASE_FILE).write_text('{"assets": "/gone/release/dist/client/assets"}')
        self.d.switch(new)
        self.assertEqual(self.named(new), {"assets": str(old / "dist/client/assets")})
        # Switching to the release already live names nothing: it would be its own previous release.
        self.d.switch(new)
        self.assertIsNone(self.named(new))
        # A previous release without assets has nothing to serve.
        (self.host.base / "current").unlink(); (self.host.base / "current").symlink_to(self.release("bare", assets=False))
        (new / deploy_common.PREVIOUS_RELEASE_FILE).write_text('{"assets": "/stale"}')
        self.d.switch(new)
        self.assertIsNone(self.named(new))

    def test_a_first_release_with_no_current_link_names_nothing(self):
        new = self.release("new")
        (self.host.base / "current").unlink()
        self.d.switch(new)
        self.assertIsNone(self.named(new))
        self.assertEqual((self.host.base / "current").resolve(), new.resolve())

    def test_a_name_that_cannot_be_written_is_logged_and_never_stops_the_cutover(self):
        old = self.release("old")
        new = self.host.base / "releases/new"  # no dist directory to write into
        self.d.switch(new)
        self.assertEqual((self.host.base / "current").resolve(), new.resolve())
        self.assertIn("The previous release was not named to the app: ", (self.host.ops / "commands.log").read_text())
        self.assertFalse((new / "dist").exists())
        self.assertTrue(old.exists())

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
        # An add-on older than the maintenance_deadline capability, which every test not about it meets.
        self.answers = {"capabilities": dict}
        self.deadlines = []
        # The retry pause is a clock; pin it so no test waits. Only the tool's own time module is patched: the shared one also
        # records the 1 ms waits of Python's subprocess wait loop, which run only when a child has not exited yet, under load.
        own = types.ModuleType("time")
        own.__dict__.update(vars(time))
        own_time = mock.patch.object(deploy_common, "time", own)
        own_time.start()
        self.addCleanup(own_time.stop)
        sleep = mock.patch.object(deploy_common.time, "sleep")
        self.sleeps = sleep.start()
        self.addCleanup(sleep.stop)
        self.gateway()

    def gateway(self, **changes):
        """The gateway's published record. Each Discord turn changes its count at the turn's boundaries.
        A change of ABSENT leaves that key out of the record."""
        record = {"pid": 4242, "gateway_state": "running", "active_agents": 0, "active_work": None, **changes}
        (self.host.home / "gateway_state.json").write_text(json.dumps({key: value for key, value in record.items() if value is not ABSENT}))

    def in_turn(self, *answers):
        """An RPC action answering with each of these in turn, then failing on any further call."""
        remaining = list(answers)
        def answer():
            if not remaining: raise AssertionError("unexpected extra maintenance RPC")
            return remaining.pop(0)()
        return answer

    def rpc(self, action, deadline=None):
        """The add-on's maintenance RPC. Each test configures the actions it expects."""
        phase = self.host.ops / "phase.json"
        if action == "acquire": self.deadlines.append(deadline)
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

    def recorded(self, capabilities=False):
        """[call, phase, status, lease present] per call. The capability read is left out unless asked for."""
        events = [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []
        return [event for event in events if capabilities or event[0] != "capabilities"]

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
        with self.assertRaisesRegex(deploy_common.Refused, '^Hermes has active work\\. Busy work at release: .*"profile": "nic".*Activate again') as caught:
            self.run_steps()
        # Three asks, two pauses between them, then the release that proves nothing changed.
        self.assertEqual([event[0] for event in self.recorded()], ["acquire", "acquire", "acquire", "release"])
        self.assertEqual(self.sleeps.call_args_list, [mock.call(2), mock.call(2)])
        self.assertEqual((self.status.read_bytes(), self.phase(), self.d.lease.exists()), (self.PREVIOUS, "maintenance-refused", False))
        self.assertIsInstance(caught.exception.__cause__, deploy_common.Answered)

    def test_busy_answer_from_the_apps_own_poll_is_asked_again_before_refusing(self):
        # The app's 5 s poll can hold a reservation when acquire runs, so an idle app can answer busy once.
        self.answers["acquire"] = self.in_turn(self.busy, self.busy, self.acquired)
        self.run_steps()
        self.assertEqual([event[0] for event in self.recorded()], ["acquire", "acquire", "acquire", "stop"])
        self.assertEqual(self.sleeps.call_args_list, [mock.call(2), mock.call(2)])
        # Each ask met the blocked status and no lease, and a busy answer needed no release between them.
        self.assertEqual([event[3] for event in self.recorded()], [False, False, False, True])
        self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "owned-maintenance-acquired"))

    def test_the_gateways_active_agent_refuses_after_the_acquire_and_before_the_app_stops(self):
        """A Discord turn runs in the gateway runner, so the add-on's own busy list never names it."""
        def acquired_with(**record):
            def acquire():
                gate = self.acquired()
                self.gateway(**record)  # the turn is counted by the time acquire returns
                return gate
            return acquire
        cases = (
            ("an active agent", {"active_agents": 1}),
            ("named active work", {"active_work": [{"kind": "chat"}]}),
            ("a count that is not a number", {"active_agents": "0"}),
            ("a boolean count", {"active_agents": False}),
            ("no count", {"active_agents": None}),
            # The guarded preflight requires the key, so this check cannot take a record that never lists its work.
            ("no work list", {"active_work": ABSENT}),
        )
        for name, record in cases:
            with self.subTest(name):
                self.status.write_bytes(self.PREVIOUS)
                self.events.unlink(missing_ok=True)
                self.answers.update(acquire=acquired_with(**record), release=self.released)
                with self.assertRaisesRegex(deploy_common.Refused, "^The gateway has an active agent") as caught:
                    self.run_steps()
                self.assertEqual(str(caught.exception.__cause__), "gateway reports no active agents or work after maintenance was acquired")
                self.assertEqual([event[0] for event in self.recorded()], ["acquire", "release"])
                # The release removed the lease the acquire took, and the household's status is back.
                self.assertEqual((self.status.read_bytes(), self.phase(), self.d.lease.exists()), (self.PREVIOUS, "maintenance-refused", False))
        self.assertEqual(self.sleeps.call_count, 0)

    def test_an_unreadable_gateway_record_after_the_acquire_is_a_refusal_not_a_stop(self):
        self.answers.update(acquire=self.acquired, release=self.released)
        (self.host.home / "gateway_state.json").write_text("{")
        with self.assertRaises(deploy_common.Refused) as caught:
            self.run_steps()
        self.assertIsInstance(caught.exception.__cause__, ValueError)
        self.assertEqual([event[0] for event in self.recorded()], ["acquire", "release"])
        self.assertEqual((self.status.read_bytes(), self.d.lease.exists()), (self.PREVIOUS, False))

    def test_a_gateway_refusal_that_cannot_prove_the_release_is_held_for_review(self):
        self.gateway(active_agents=1)
        self.answers.update(acquire=self.acquired, release=lambda: {"active": True, "operationId": "op-1", "busy": []})
        with self.assertRaisesRegex(deploy_common.Fence, "^refused: maintenance released$"):
            self.run_steps()
        self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "maintenance-acquiring"))

    def test_a_request_that_was_never_sent_is_a_refusal_through_the_release_path(self):
        def unsent():
            raise deploy_common.NotSent("Hermes was not asked for maintenance acquire")
        self.answers.update(acquire=unsent, release=self.released)
        with self.assertRaisesRegex(deploy_common.Refused, "^Hermes could not be reached: .*before the request was sent\\.") as caught:
            self.run_steps()
        self.assertIsInstance(caught.exception.__cause__, deploy_common.NotSent)
        # Not retried: nothing was busy. The release still ran, the saved status is back and the app never stopped.
        self.assertEqual([event[0] for event in self.recorded()], ["acquire", "release"])
        self.assertEqual(self.sleeps.call_count, 0)
        self.assertEqual((self.status.read_bytes(), self.phase(), self.d.lease.exists()), (self.PREVIOUS, "maintenance-refused", False))

    def test_an_unsent_acquire_whose_release_is_unsent_too_is_held_for_review(self):
        # Nothing was ever sent, but the tool cannot prove it: the worker keeps the same rule.
        def unsent():
            raise deploy_common.NotSent("Hermes was not asked for maintenance")
        self.answers.update(acquire=unsent, release=unsent)
        with self.assertRaises(deploy_common.NotSent) as caught:
            self.run_steps()
        self.assertNotIsInstance(caught.exception, deploy_common.Refused)
        self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "maintenance-acquiring"))
        self.assertNotIn("stop", [event[0] for event in self.recorded()])

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
        self.assertEqual(self.sleeps.call_count, 0)

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

    CAPABLE = {"revision": "r", "maintenance_deadline": True, "executor_epoch": "epoch-1"}

    def test_a_capable_add_on_is_asked_before_the_acquire_and_sent_a_deadline_with_each_attempt(self):
        self.answers["capabilities"] = lambda: self.CAPABLE
        self.answers["acquire"] = self.in_turn(self.busy, self.acquired)
        self.run_steps()
        blocked = self.BLOCKED.decode()
        # The read comes after the app's gate closes, before the phase says an acquire may be under way, and holds no lease.
        self.assertEqual(self.recorded(capabilities=True), [["capabilities", None, blocked, False], ["acquire", "maintenance-acquiring", blocked, False],
                                                              ["acquire", "maintenance-acquiring", blocked, False], ["stop", "owned-maintenance-acquired", blocked, True]])
        self.assertEqual(self.deadlines, [90, 90])

    def test_an_add_on_that_does_not_say_it_honors_a_deadline_is_sent_none(self):
        # Each is a capabilities answer that is not exactly maintenance_deadline: true. A deadline sent to an older
        # add-on is ignored there, and the answer it never gives would then be read as proof.
        for name, capabilities in (("an older add-on", {"revision": "r"}), ("false", {"maintenance_deadline": False}), ("a string", {"maintenance_deadline": "true"}),
                                   ("the number one", {"maintenance_deadline": 1}), ("an unrelated key", {"maintenance_deadlines": True}), ("no object", ["maintenance_deadline"]),
                                   # A restart cannot be told apart later without the process's epoch, so no epoch is no deadline.
                                   ("no epoch", {"maintenance_deadline": True}), ("an empty epoch", {"maintenance_deadline": True, "executor_epoch": ""}),
                                   ("a numeric epoch", {"maintenance_deadline": True, "executor_epoch": 7})):
            with self.subTest(name):
                self.deadlines.clear(); self.d.lease.unlink(missing_ok=True); self.events.unlink(missing_ok=True)
                self.answers.update(capabilities=lambda capabilities=capabilities: capabilities, acquire=self.acquired)
                self.run_steps()
                self.assertEqual(self.deadlines, [None])

    def test_a_capability_read_that_fails_leaves_the_acquire_to_run_as_before(self):
        def timed_out(): raise subprocess.TimeoutExpired("python", 40)
        def refused(): raise deploy_common.Answered({"code": -32601, "message": "unknown method"})
        def unsent(): raise deploy_common.NotSent("Hermes was not asked for maintenance capabilities")
        def not_json(): raise json.JSONDecodeError("Expecting value", "", 0)
        for name, read in (("the child failed", lambda: (_ for _ in ()).throw(RuntimeError("A deployment command failed; private log retained"))),
                           ("the child timed out", timed_out), ("the add-on answered an error", refused), ("it was not sent", unsent), ("the output was not JSON", not_json)):
            with self.subTest(name):
                self.deadlines.clear(); self.d.lease.unlink(missing_ok=True); self.events.unlink(missing_ok=True)
                self.answers.update(capabilities=read, acquire=self.acquired)
                self.run_steps()
                # No deadline, so no proof is claimed: a lost answer from here is held for review, as for an older add-on.
                self.assertEqual(self.deadlines, [None])
                self.assertEqual([event[0] for event in self.recorded()], ["acquire", "stop"])

    def test_a_capability_read_that_fails_for_an_unexpected_reason_is_not_swallowed(self):
        # Only the failures of a read are a missing capability. A bug in the tool is not.
        def broken(): raise KeyError("operation")
        self.answers["capabilities"] = broken
        with self.assertRaises(KeyError):
            self.run_steps()
        self.assertEqual(self.recorded(), [])

    def silent_acquire(self):
        raise deploy_common.DeadlinePassed("Hermes did not answer maintenance acquire within its 90 s deadline")

    def test_no_answer_after_the_deadline_is_a_refusal_once_a_watch_after_the_release_sees_no_lease(self):
        self.answers.update(capabilities=lambda: self.CAPABLE, release=lambda: self.released([{"profile": "nic", "state": "queued"}]), acquire=self.silent_acquire)
        with self.assertRaisesRegex(deploy_common.Refused, "^Hermes did not answer the maintenance request within its deadline, so none was granted\\. "
                                    'Busy work at release: .*"profile": "nic".*Activate again') as caught:
            self.run_steps()
        self.assertIsInstance(caught.exception.__cause__, deploy_common.DeadlinePassed)
        # Not asked again: the add-on answered nothing for two minutes. The release still ran and the app never stopped.
        self.assertEqual([event[0] for event in self.recorded()], ["acquire", "release"])
        # The capabilities were read again, for the process epoch, and then the lease was watched for. The handler may
        # have started as late as the release's did, so the watch lasts its whole deadline and the grace after it.
        self.assertEqual([event[0] for event in self.recorded(capabilities=True)], ["capabilities", "acquire", "capabilities", "release"])
        self.assertGreaterEqual(sum(call.args[0] for call in self.sleeps.call_args_list), deploy_common.DEADLINE_WATCH_SECONDS)
        self.assertEqual((self.status.read_bytes(), self.phase(), self.d.lease.exists()), (self.PREVIOUS, "maintenance-refused", False))

    def test_the_status_stays_blocked_until_the_watch_ends(self):
        # The app keeps refusing sends while a late handler may still write its lease.
        seen = []
        self.sleeps.side_effect = lambda seconds: seen.append(self.status.read_bytes())
        self.answers.update(capabilities=lambda: self.CAPABLE, release=self.released, acquire=self.silent_acquire)
        with self.assertRaises(deploy_common.Refused): self.run_steps()
        self.assertEqual(set(seen), {self.BLOCKED})
        self.assertEqual(self.status.read_bytes(), self.PREVIOUS)

    def test_a_handler_that_starts_late_and_writes_its_lease_after_the_release_is_released_again(self):
        # The handler waited for a thread in Hermes's pool, so the tool's wait ended before its deadline did. The first
        # release found no lease, and the handler wrote one after it. Refusing now would leave Hermes refusing every chat.
        written = []
        def late_lease(seconds):
            if len(self.sleeps.call_args_list) == 5 and not written: written.append(self.acquired())
        self.sleeps.side_effect = late_lease
        self.answers.update(capabilities=lambda: self.CAPABLE, acquire=self.silent_acquire,
                            release=self.in_turn(lambda: self.released([{"profile": "nic"}]), lambda: self.released([{"profile": "late"}])))
        with self.assertRaisesRegex(deploy_common.Refused, 'Busy work at release: .*"profile": "late"') as caught:
            self.run_steps()
        self.assertIsInstance(caught.exception.__cause__, deploy_common.DeadlinePassed)
        self.assertEqual([event[0::3] for event in self.recorded()], [["acquire", False], ["release", False], ["release", True]])
        # The watch ended when the lease showed, not at the end of its time.
        self.assertEqual(self.sleeps.call_count, 5)
        self.assertEqual((self.status.read_bytes(), self.phase(), self.d.lease.exists()), (self.PREVIOUS, "maintenance-refused", False))
        self.assertNotIn("stop", [event[0] for event in self.recorded()])

    def test_a_lease_written_in_the_last_second_of_the_watch_is_still_released_again(self):
        # The handler started as late as the grace allows. The last look comes after the last sleep, so it is the one
        # that sees a lease written during that sleep.
        def last_second(seconds):
            if len(self.sleeps.call_args_list) == deploy_common.DEADLINE_WATCH_SECONDS: self.acquired()
        self.sleeps.side_effect = last_second
        self.answers.update(capabilities=lambda: self.CAPABLE, acquire=self.silent_acquire,
                            release=self.in_turn(self.released, lambda: self.released([{"profile": "late"}])))
        with self.assertRaisesRegex(deploy_common.Refused, 'Busy work at release: .*"profile": "late"'):
            self.run_steps()
        self.assertEqual([event[0::3] for event in self.recorded()], [["acquire", False], ["release", False], ["release", True]])
        self.assertEqual((self.status.read_bytes(), self.phase(), self.d.lease.exists()), (self.PREVIOUS, "maintenance-refused", False))

    def test_a_late_lease_that_the_second_release_cannot_clear_is_held_for_review(self):
        def late_lease(seconds): self.acquired() if not self.d.lease.exists() else None
        for name, second in (("it answers the lease still held", lambda: {"active": True, "operationId": "op-1", "busy": []}),
                             ("it removes nothing", lambda: {"active": False, "operationId": None, "busy": []}),
                             ("it gets no answer", lambda: (_ for _ in ()).throw(RuntimeError("A deployment command failed; private log retained"))),
                             ("another operation owns the lease", lambda: (_ for _ in ()).throw(deploy_common.Answered({"code": 409, "message": "Another maintenance operation owns this lease"})))):
            with self.subTest(name):
                self.status.write_bytes(self.PREVIOUS); self.d.lease.unlink(missing_ok=True); self.events.unlink(missing_ok=True)
                self.sleeps.side_effect = late_lease
                self.answers.update(capabilities=lambda: self.CAPABLE, acquire=self.silent_acquire, release=self.in_turn(self.released, second))
                with self.assertRaises(Exception) as caught: self.run_steps()
                self.assertNotIsInstance(caught.exception, deploy_common.Refused)
                self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "maintenance-acquiring"))
                self.assertNotIn("stop", [event[0] for event in self.recorded()])

    def test_a_restart_since_the_capability_read_is_held_for_review_after_a_release_attempt(self):
        # The acquire went to a different process than the one that said it honors a deadline, so its silence proves nothing.
        different = ({**self.CAPABLE, "executor_epoch": "epoch-2"}, "a new epoch"), ({"revision": "r"}, "an add-on that ignores the deadline"), \
            ({"maintenance_deadline": True}, "no epoch"), ({"executor_epoch": ["epoch-1"]}, "an epoch that is not the string")
        def no_answer(): raise RuntimeError("A deployment command failed; private log retained")
        failures = ((no_answer, "the second read fails"), (lambda: (_ for _ in ()).throw(subprocess.TimeoutExpired("python", 40)), "the second read times out"),
                    (lambda: (_ for _ in ()).throw(deploy_common.Answered({"code": -32601, "message": "unknown method"})), "the second read is an error"),
                    (lambda: ["executor_epoch"], "the second read is not an object"))
        for second, name in [(lambda capabilities=capabilities: capabilities, name) for capabilities, name in different] + list(failures):
            with self.subTest(name):
                self.status.write_bytes(self.PREVIOUS); self.d.lease.unlink(missing_ok=True); self.events.unlink(missing_ok=True); self.sleeps.reset_mock()
                self.answers.update(capabilities=self.in_turn(lambda: self.CAPABLE, second), acquire=self.silent_acquire, release=self.released)
                with self.assertRaisesRegex(deploy_common.Fence, "^Hermes answered maintenance acquire$") as caught:
                    self.run_steps()
                self.assertNotIsInstance(caught.exception, deploy_common.Refused)
                self.assertIsInstance(caught.exception.__cause__, deploy_common.DeadlinePassed)
                # The release is still tried, as for any lost answer, but is not proof, and no watch runs.
                self.assertEqual([event[0] for event in self.recorded()], ["acquire", "release"])
                self.assertEqual(self.sleeps.call_count, 0)
                self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "maintenance-acquiring"))

    def test_a_release_that_cannot_prove_it_after_the_deadline_is_held_for_review(self):
        def silent(): raise deploy_common.DeadlinePassed("no answer")
        def no_answer(): raise RuntimeError("A deployment command failed; private log retained")
        self.answers.update(capabilities=lambda: self.CAPABLE, acquire=silent, release=no_answer)
        with self.assertRaises(RuntimeError) as caught:
            self.run_steps()
        self.assertNotIsInstance(caught.exception, deploy_common.Refused)
        self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "maintenance-acquiring"))
        self.assertNotIn("stop", [event[0] for event in self.recorded()])

    def test_a_capable_add_on_that_fails_to_answer_some_other_way_is_still_held_for_review(self):
        # Only the deadline passing proves no lease can appear. The child timing out itself does not.
        def child_timed_out(): raise subprocess.TimeoutExpired("python", 145)
        self.answers.update(capabilities=lambda: self.CAPABLE, acquire=child_timed_out, release=self.released)
        with self.assertRaisesRegex(deploy_common.Fence, "^Hermes answered maintenance acquire$") as caught:
            self.run_steps()
        self.assertNotIsInstance(caught.exception, deploy_common.Refused)
        self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "maintenance-acquiring"))

    def test_an_older_add_ons_unanswered_acquire_is_still_held_for_review(self):
        # The first release after this one meets an add-on without the capability. Without a deadline there is no
        # proof, so a lost answer is held exactly as before and no DeadlinePassed can come from it.
        def no_answer(): raise RuntimeError("A deployment command failed; private log retained")
        self.answers.update(acquire=no_answer, release=self.released)
        with self.assertRaisesRegex(deploy_common.Fence, "^Hermes answered maintenance acquire$"):
            self.run_steps()
        self.assertEqual(self.deadlines, [None])
        self.assertEqual((self.status.read_bytes(), self.phase()), (self.BLOCKED, "maintenance-acquiring"))

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
import json, time
from pathlib import Path
def record(*event):
    with open({str(self.calls)!r}, "a") as calls: calls.write(json.dumps(event) + "\\n")
# A clock that only moves when the fake socket blocks or NATIVE sleeps, so a 120 s wait costs no time.
real_monotonic, skew = time.monotonic, [0.0]
time.monotonic = lambda: real_monotonic() + skew[0]
def sleep(seconds):
    record("sleep", round(seconds))
    skew[0] += seconds
time.sleep = sleep
class Socket:
    def __init__(self): self.steps = json.loads(Path({str(self.script)!r}).read_text())
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def send(self, message):
        record("send", json.loads(message))
        if self.steps and self.steps[0] == "send-fails": raise ConnectionResetError("reset while sending")
    def recv(self, timeout):
        record("recv", timeout)
        if not self.steps: raise AssertionError("unscripted WebSocket receive")
        step = self.steps.pop(0)
        if step == "silence":
            skew[0] += timeout
            raise TimeoutError("timed out while waiting for a message")
        if step == "drop":
            skew[0] += 2
            raise ConnectionResetError("connection dropped after two seconds")
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

    def call(self, method, *steps, deadline=None):
        self.script.write_text(json.dumps(list(steps)))
        request = dict(self.request, method=method)
        if deadline is not None: request["deadline"] = deadline
        return self.d.maintenance_rpc(self.argv, request)

    def sleeps(self):
        """How long NATIVE slept after a failure, on the fake clock."""
        return [event[1] for event in self.recorded() if event[0] == "sleep"]

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

    def test_a_failure_before_the_request_is_sent_is_reported_as_not_sent_and_reaches_no_add_on(self):
        with socket.socket() as closed:
            closed.bind(("127.0.0.1", 0))
            closed_port = closed.getsockname()[1]
        cases = (("the service key is refused", dict(self.request, key="wrong-key")),
                 ("the dashboard is not listening", dict(self.request, origin=f"http://127.0.0.1:{closed_port}")))
        for name, request in cases:
            with self.subTest(name):
                self.script.write_text("[]")
                self.calls.unlink(missing_ok=True)
                with self.assertRaisesRegex(deploy_common.NotSent, "^Hermes was not asked for maintenance acquire$") as caught:
                    self.d.maintenance_rpc(self.argv, dict(request, method="acquire"))
                self.assertNotIsInstance(caught.exception, deploy_common.Answered)
                self.assertFalse(self.calls.exists(), "no WebSocket message was sent")

    def test_a_connection_refused_by_the_socket_is_not_sent_either(self):
        (self.host.source / "websockets/sync/client.py").write_text(
            "def connect(url, *, open_timeout, close_timeout): raise ConnectionRefusedError('refused')\n")
        with self.assertRaises(deploy_common.NotSent):
            self.call("acquire")

    def test_a_send_that_fails_may_have_reached_the_add_on_so_it_is_not_reported_as_not_sent(self):
        # The request can be delivered before the send reports an error, and acquire's handler writes the lease last.
        with self.assertRaises(RuntimeError) as caught:
            self.call("acquire", "send-fails")
        self.assertNotIsInstance(caught.exception, (deploy_common.NotSent, deploy_common.Answered))
        self.assertIn("ConnectionResetError", (self.host.ops / "commands.log").read_text())

    def test_a_failed_child_is_not_sent_only_when_its_last_line_is_exactly_the_unsent_marker(self):
        for stdout in ('{"unsent": false}', '{"unsent": true, "answeredError": {}}', '{"unsent": 1}', '"unsent"', 'unsent'):
            with self.subTest(stdout=stdout):
                child = executable(self.host.root / "child", f"import sys; print({stdout!r}); sys.exit(1)")
                with self.assertRaises(RuntimeError) as caught:
                    self.d.maintenance_rpc([str(child)], dict(self.request, method="acquire"))
                self.assertNotIsInstance(caught.exception, deploy_common.NotSent)
        child = executable(self.host.root / "child", "import sys; print('noise'); print('{\"unsent\": true}'); sys.exit(1)")
        with self.assertRaises(deploy_common.NotSent):
            self.d.maintenance_rpc([str(child)], dict(self.request, method="release"))
        # A marker anything follows may be a handler's own output before it failed, so it proves nothing was sent.
        child = executable(self.host.root / "child", "import sys; print('{\"unsent\": true}'); print('later output'); sys.exit(1)")
        with self.assertRaises(RuntimeError) as caught:
            self.d.maintenance_rpc([str(child)], dict(self.request, method="release"))
        self.assertNotIsInstance(caught.exception, deploy_common.NotSent)

    def test_a_failed_child_is_answered_only_when_its_last_line_is_the_answered_error(self):
        for stdout in ('{"active": false}', '{"answeredError": "409"}', 'answeredError'):
            with self.subTest(stdout=stdout):
                child = executable(self.host.root / "child", f"import sys; print({stdout!r}); sys.exit(1)")
                with self.assertRaises(RuntimeError) as caught:
                    self.d.maintenance_rpc([str(child)], dict(self.request, method="acquire"))
                self.assertNotIsInstance(caught.exception, deploy_common.Answered)

    def test_capabilities_are_read_without_credentials_and_with_the_short_wait(self):
        capabilities = {"revision": "r", "maintenance_deadline": True}
        self.assertEqual(self.call("capabilities", {"id": 1, "result": capabilities}), capabilities)
        sent = {"jsonrpc": "2.0", "id": 1, "method": "agent-interface.capabilities", "params": {}}
        port = self.request["origin"].rsplit(":", 1)[1]
        self.assertEqual(self.recorded(), [["connect", f"ws://127.0.0.1:{port}/api/ws?ticket=ticket-1"], ["send", sent], ["recv", 15]])

    def test_a_deadline_rides_on_the_acquire_and_is_shorter_than_the_wait_for_its_answer(self):
        acquired = {"active": True, "operationId": "op-1", "busy": []}
        self.assertEqual(self.call("acquire", {"id": 1, "result": acquired}, deadline=deploy_common.ACQUIRE_DEADLINE), acquired)
        sent = next(event[1] for event in self.recorded() if event[0] == "send")
        self.assertEqual(sent["params"], {"action": "acquire", "operation_id": "op-1", "service_key": "service-key", "deadline": 90})
        self.assertEqual(self.recorded()[-1], ["recv", 120])
        self.assertEqual(self.sleeps(), [])

    def test_a_deadline_that_is_not_shorter_than_the_wait_is_refused_before_anything_runs(self):
        # Without room between them, no answer would prove the deadline had passed.
        for deadline in (120, 121, 1000):
            with self.subTest(deadline=deadline):
                self.calls.unlink(missing_ok=True)
                with self.assertRaisesRegex(ValueError, "^A deadline must be shorter than the wait for its answer$"):
                    self.call("acquire", deadline=deadline)
                self.assertFalse(self.calls.exists(), "no WebSocket message was sent")
        # A method with the short wait has no room for 90 s either.
        with self.assertRaises(ValueError): self.call("release", deadline=90)

    def test_no_answer_for_the_whole_wait_of_a_request_with_a_deadline_is_the_deadline_passing(self):
        with self.assertRaisesRegex(deploy_common.DeadlinePassed, "^Hermes did not answer maintenance acquire within its 90 s deadline$") as caught:
            self.call("acquire", "silence", deadline=90)
        self.assertNotIsInstance(caught.exception, deploy_common.Answered)
        # The receive itself waited the whole 120 s, so there was nothing left to wait out.
        self.assertEqual([event for event in self.recorded() if event[0] in ("recv", "sleep")], [["recv", 120], ["sleep", 0]])

    def test_a_connection_lost_after_the_send_waits_out_the_rest_of_the_wait_before_it_is_the_deadline_passing(self):
        # The add-on's handler keeps running when the socket drops, and writes no lease after its deadline:
        # not before, so the child waits out the wait first.
        with self.assertRaises(deploy_common.DeadlinePassed):
            self.call("acquire", "drop", deadline=90)
        self.assertEqual(self.sleeps(), [118])
        # A send that fails may already have delivered the request, so it waits the whole wait.
        self.calls.unlink()
        with self.assertRaises(deploy_common.DeadlinePassed):
            self.call("acquire", "send-fails", deadline=90)
        self.assertEqual(self.sleeps(), [120])

    def test_native_itself_says_nothing_about_a_deadline_that_leaves_no_room_in_the_wait(self):
        # The callers refuse such a request first; NATIVE does not trust them. With no room between
        # deadline and wait, no answer proves nothing, so it prints no marker and does not wait.
        self.script.write_text(json.dumps(["silence"]))
        request = dict(self.request, method="acquire", wait=120, deadline=120)
        result = self.d.execute(self.argv, input=json.dumps(request))
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("deadlinePassed", result.stdout)
        self.assertEqual(self.sleeps(), [])

    def test_an_answer_with_an_error_is_never_the_deadline_passing(self):
        # The answered-error line must stay last: the handler returned, and it was the busy answer.
        with self.assertRaises(deploy_common.Answered) as caught:
            self.call("acquire", {"id": 1, "error": self.BUSY}, deadline=90)
        self.assertEqual(caught.exception.error, self.BUSY)
        self.assertEqual(self.sleeps(), [])

    def test_a_failure_before_the_send_is_not_sent_even_with_a_deadline(self):
        # Nothing reached the add-on and nothing is waited out.
        with self.assertRaises(deploy_common.NotSent):
            self.d.maintenance_rpc(self.argv, dict(self.request, key="wrong-key", method="acquire", deadline=90))
        self.assertFalse(self.calls.exists())

    def test_a_failed_child_is_the_deadline_passing_only_when_the_request_had_one_and_its_last_line_is_exactly_the_marker(self):
        bad = ('{"deadlinePassed": false}', '{"deadlinePassed": true, "unsent": true}', '{"deadlinePassed": 1}', '"deadlinePassed"', "deadlinePassed")
        for stdout in bad:
            with self.subTest(stdout=stdout):
                child = executable(self.host.root / "child", f"import sys; print({stdout!r}); sys.exit(1)")
                with self.assertRaises(RuntimeError) as caught:
                    self.d.maintenance_rpc([str(child)], dict(self.request, method="acquire", deadline=90))
                self.assertNotIsInstance(caught.exception, deploy_common.DeadlinePassed)
        # Anything after the marker may be output of a handler that failed some other way.
        child = executable(self.host.root / "child", "import sys; print('{\"deadlinePassed\": true}'); print('later output'); sys.exit(1)")
        with self.assertRaises(RuntimeError) as caught:
            self.d.maintenance_rpc([str(child)], dict(self.request, method="acquire", deadline=90))
        self.assertNotIsInstance(caught.exception, deploy_common.DeadlinePassed)
        # The exact marker from a request that sent no deadline proves nothing: no lease was ever bounded.
        child = executable(self.host.root / "child", "import sys; print('{\"deadlinePassed\": true}'); sys.exit(1)")
        with self.assertRaises(RuntimeError) as caught:
            self.d.maintenance_rpc([str(child)], dict(self.request, method="acquire"))
        self.assertNotIsInstance(caught.exception, deploy_common.DeadlinePassed)
        with self.assertRaises(deploy_common.DeadlinePassed):
            self.d.maintenance_rpc([str(child)], dict(self.request, method="acquire", deadline=90))


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
                         if isinstance(node, ast.Call) and getattr(node.func, "id", None) in ("fence", "idle")]
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
        calls = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)]
        named = lambda name: [node for node in calls if getattr(node.func, "id", None) == name]
        # The preflight's busy guards are idle() calls, which exit 75 on activation and raise a Fence under --check.
        busy = [node.args[1].value for node in named("idle") if ast.unparse(node.args[0]) == "gate['busy'] == []"]
        self.assertEqual(len(busy), 1)
        # A gate another operation holds is a fence the wait never retries: someone must look at it.
        held = [node.args[1].value for node in named("fence") if ast.unparse(node.args[0]) == "gate['active'] is False"]
        self.assertEqual(len(held), 1)
        self.assertFalse(idle.BUSY.search("deploy_common.Fence: " + held[0]))
        # Only the fence's own line, as a traceback without source would print it.
        self.assertTrue(idle.BUSY.search("deploy_common.Fence: " + busy[0]))
        gateway = [node for node in named("idle") if "record['active_agents'] == 0" in ast.unparse(node.args[0])]
        self.assertEqual(len(gateway), 1)
        self.assertTrue(idle.BUSY.search("deploy_common.Fence: " + gateway[0].args[1].value))
        # The same count after the drain is a fence of the cutover, which prepare-when-idle never sees.
        drained = [node for node in named("fence") if "record['active_agents'] == 0" in ast.unparse(node.args[0])]
        self.assertEqual(len(drained), 1)
        self.assertFalse(idle.BUSY.search("deploy_common.Fence: " + drained[0].args[1].value))
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

    def test_both_release_tools_hold_one_deadline_and_it_leaves_a_margin_the_add_on_cannot_overrun(self):
        linux = load_source("scripts/hermes-upgrade-linux.py", "linux_upgrade")
        compaction = load_source("src/hermes/compaction.py", "compaction_constants")
        for module in (deploy_common, linux):
            wait = module.MAINTENANCE_WAIT["acquire"]
            self.assertEqual((wait, module.DEADLINE_MARGIN, module.ACQUIRE_DEADLINE), (120, 30, 90), module.__name__)
            # The wait must outlast the deadline by more than one full preempt wait, the longest single step the
            # add-on bounds, or an answer from a handler that started late could land after the caller gave up.
            self.assertGreaterEqual(wait - module.ACQUIRE_DEADLINE, compaction.PREEMPT_WAIT)
            # A handler that started as late as the release's runs its whole deadline after it, so the watch that
            # follows a confirmed release has to outlast the deadline by a grace, not equal it.
            self.assertGreater(module.DEADLINE_WATCH_SECONDS, module.ACQUIRE_DEADLINE, module.__name__)
        self.assertEqual(deploy_common.MAINTENANCE_WAIT, linux.MAINTENANCE_WAIT)
        # The child's own timeout is the wait plus these 30 s for ticket, socket, close and interpreter start. The
        # worker's figure is the one that counted all four, and a shorter one here kills a slow-starting child as lost.
        self.assertEqual((deploy_common.MAINTENANCE_OVERHEAD, linux.MAINTENANCE_OVERHEAD), (30, 30))
        self.assertEqual(deploy_common.DEADLINE_WATCH_SECONDS, linux.DEADLINE_WATCH_SECONDS)

    def test_the_guarded_tool_passes_the_deadline_to_its_rpc_request(self):
        tree = ast.parse((TOOLS / "deploy-guarded-app-release.py").read_text())
        rpc = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "rpc")
        self.assertEqual([argument.arg for argument in rpc.args.args], ["action", "deadline"])
        self.assertIn("req['deadline'] = deadline", [ast.unparse(node) for node in ast.walk(rpc) if isinstance(node, ast.Assign)])

    def test_staged_recovery_ships_the_shared_module_its_helper_pins(self):
        stage = load_source(".agents/tools/stage-recovery-tools.py", "stage_recovery")
        recover = load_source(".agents/tools/recover-app-after-native-update.py", "recover_app")
        self.assertEqual(stage.FILES, ("recover-app-after-native-update.py", recover.SHARED_FUNCTIONS))
        self.assertTrue((TOOLS / recover.SHARED_FUNCTIONS).is_file())


if __name__ == "__main__":
    unittest.main()
