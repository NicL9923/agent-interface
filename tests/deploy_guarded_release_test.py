"""The guarded release tool, run for real against a fake host.

The tool runs in this process through runpy, so its exit codes and output are the ones an operator
and release-app.py see. The edges are fakes: systemctl and the managed Python that carries the
maintenance RPC are executables that record their calls and answer from a script each test writes;
git is real, against a temporary repository; urllib answers the app and dashboard requests; the
update claim is a stand-in for Hermes's native lock. Anything a test did not script fails loudly.
"""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import time
import types
import unittest
import urllib.error
from unittest import mock
import uuid

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".agents/tools"
sys.path.insert(0, str(TOOLS))
import deploy_common  # noqa: E402

TOOL = TOOLS / "deploy-guarded-app-release.py"
BUSY = {"code": 409, "message": "Hermes still has active work; no maintenance lease acquired"}
IDLE_GATE = {"active": False, "operationId": None, "busy": []}


def executable(path, body):
    path.write_text("#!" + sys.executable + "\n" + body)
    path.chmod(0o700)
    return path


# The tool's own time module, so a patched sleep sees only the tool's pauses. Patching the shared module also records the
# 1 ms waits of Python's subprocess wait loop, which run only when a child has not exited yet, so a loaded machine added one.
def tool_time():
    own = types.ModuleType("time")
    own.__dict__.update(vars(time))
    return mock.patch.object(deploy_common, "time", own)


class Response:
    def __init__(self, status, body):
        self.status, self.body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.body


class GuardedReleaseTests(unittest.TestCase):
    PREVIOUS = '{"phase": "idle", "maintenance": false}\n'

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = root = Path(temporary.name).resolve()
        self.operation = str(uuid.uuid4())
        self.base, self.home, self.source = root / "app", root / "hermes", root / "source"
        self.state = root / "upgrade"
        for path in (self.base / "releases/old", self.base / "releases/new/scripts", self.base / "releases/new/src/hermes",
                     self.base / "releases/new/dist/client", self.base / "shared", self.base / "operations", self.home,
                     self.source, self.state / "requests"):
            path.mkdir(parents=True)
        (self.base / "current").symlink_to(self.base / "releases/old")
        release = self.base / "releases/new"
        (release / "scripts/hermes-upgrade-linux.py").write_text("# the release's helper\n")
        (release / "dist/client/sw.js").write_text("const build = 'web-build-1';\n")
        # Hermes's native update lock, which the tool holds for the whole operation.
        (release / "scripts/hermes-upgrade-worker.py").write_text("""
import os
class NativeUpdateClaim:
    def __init__(self, source, home): self.owner_pid = os.getpid()
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def validate(self): pass
""")
        (release / "src/hermes/qualification.py").write_text("import json\nfrom pathlib import Path\ndef read_receipt(path, release): return json.loads(Path(path).read_text())\n")
        git = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "-C", str(self.source)]
        subprocess.run([*git, "init", "-q"], check=True)
        (self.source / "tracked").write_text("x")
        subprocess.run([*git, "add", "tracked"], check=True)
        subprocess.run([*git, "commit", "-qm", "base"], check=True)
        self.revision = subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip()
        self.receipt = self.state / "qualification.json"
        self.receipt.write_text(json.dumps({"revision": self.revision, "trackedPatchSha256": hashlib.sha256(b"").hexdigest()}))
        self.receipt.chmod(0o600)
        profile = self.home / "config.yaml"
        profile.write_text("profile: nic\n")
        (self.state / "status.json").write_text(self.PREVIOUS)
        (self.base / "shared/hermes-worker.json").write_text("{}\n")
        (self.base / "shared/hermes-service.env").write_text(
            f"HERMES_AGENT_INTERFACE_TOKEN=service-key\nHERMES_AGENT_INTERFACE_QUALIFICATION_FILE={self.receipt}\n")
        (self.base / "shared/app.env").write_text(f"HERMES_QUALIFICATION_FILE={self.receipt}\n")
        self.lease = self.home / "maintenance.json"
        self.calls, self.plan_path, self.systemctl_calls = root / "rpc-calls.jsonl", root / "rpc-plan.json", root / "systemctl.jsonl"
        self.plan_path.write_text("{}")
        # The managed Python the maintenance RPC runs in: it answers from the plan, one step per call.
        rpc = executable(root / "managed-python", f"""
import json, sys
from pathlib import Path
request = json.load(sys.stdin)
with open({str(self.calls)!r}, "a") as calls: calls.write(json.dumps({{"method": request["method"], "wait": request["wait"], "deadline": request.get("deadline")}}) + "\\n")
plan = json.loads(Path({str(self.plan_path)!r}).read_text())
queue = plan.get(request["method"], [])
if not queue: sys.exit("unscripted maintenance RPC: " + request["method"])
step = queue.pop(0)
Path({str(self.plan_path)!r}).write_text(json.dumps(plan))
for path, text in step.get("writes", {{}}).items(): Path(path).write_text(text)
for path in step.get("removes", []): Path(path).unlink(missing_ok=True)
if "answeredError" in step: print(json.dumps({{"answeredError": step["answeredError"]}})); sys.exit(1)
if step.get("unsent"): print(json.dumps({{"unsent": True}})); sys.exit(1)
if step.get("deadlinePassed"): print(json.dumps({{"deadlinePassed": True}})); sys.exit(1)
if step.get("fail"): sys.exit(1)
print(json.dumps(step["result"]))
""")
        systemctl = executable(root / "systemctl", f"""
import json, sys
with open({str(self.systemctl_calls)!r}, "a") as calls: calls.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["--user", "show"]: print("4242")
""")
        # The first step the tool takes after the lease is held: a failing backup ends the run for review.
        node = executable(root / "node", "import sys; sys.exit(1)")
        verdict = json.dumps(json.dumps({"authenticatedHttp": True, "freshWebsocket": True}))
        config = {"appBase": str(self.base), "release": str(release), "source": str(self.source), "hermesHome": str(self.home),
                  "expectedRelease": str(self.base / "releases/old"), "operationId": self.operation, "maintenanceFile": str(self.lease),
                  "appOrigin": "https://app.example.test", "upgradeStateDir": str(self.state), "managedPython": str(rpc), "node": str(node),
                  "fixedHelperSha256": hashlib.sha256((release / "scripts/hermes-upgrade-linux.py").read_bytes()).hexdigest(),
                  "webBuild": "web-build-1", "profileHashes": {str(profile): hashlib.sha256(profile.read_bytes()).hexdigest()},
                  "qualificationReceipt": str(self.receipt), "hermesRevision": self.revision,
                  "repairSha256": hashlib.sha256(b"").hexdigest(), "newWorkerConfig": {"qualificationReceipt": str(self.receipt)},
                  "discordConnections": ["discord"], "googleVerificationCommand": [sys.executable, "-c", f"print({verdict})"]}
        self.config_path = root / "deploy-config.json"
        self.config_path.write_text(json.dumps(config))
        self.config_path.chmod(0o600)
        self.app_status = {"active_agents": 0, "active_sessions": 0}
        self.gateway()
        own_time = tool_time()
        own_time.start()
        self.addCleanup(own_time.stop)
        patches = (mock.patch.object(deploy_common.Deployment, "systemctl", str(systemctl)),
                   mock.patch("urllib.request.urlopen", side_effect=self.urlopen),
                   mock.patch.object(deploy_common.time, "sleep"),
                   mock.patch.dict(os.environ))
        self.sleeps = patches[2].start()
        for patch in (patches[0], patches[1], patches[3]):
            patch.start()
        for patch in patches:
            self.addCleanup(patch.stop)
        # The tool sets both for the whole process; keep them from leaking into other tests.
        self.addCleanup(os.umask, os.umask(0o022))
        self.addCleanup(setattr, sys, "dont_write_bytecode", sys.dont_write_bytecode)

    def gateway(self, **changes):
        record = {"pid": 4242, "gateway_state": "running", "code_sha": self.revision, "hermes_home": str(self.home),
                  "agent_interface_gateway_guard": {"schemaVersion": 1, "maintenanceFile": str(self.lease), "pendingIngress": 0},
                  "platforms": {"discord": {"state": "connected"}}, "active_agents": 0, "active_work": None,
                  "updated_at": deploy_common.datetime.datetime.now(deploy_common.datetime.timezone.utc).isoformat(), **changes}
        self.gateway_record = json.dumps(record)
        (self.home / "gateway_state.json").write_text(self.gateway_record)

    def urlopen(self, request, timeout=None):
        url = getattr(request, "full_url", request)
        if url == "http://127.0.0.1:9119/api/status":
            return Response(200, json.dumps(self.app_status).encode())
        replies = {"/api/health": (200, b'{"ok": true}'), "/api/bootstrap": (401, b"{}"), "/api/auth/local": (403, b"{}")}
        code, body = replies[url.removeprefix("https://app.example.test")]
        if code != 200:
            raise urllib.error.HTTPError(url, code, "refused", {}, io.BytesIO(body))
        return Response(code, body)

    def script(self, **steps):
        """What the add-on answers to each maintenance action, in order. Status is idle unless scripted."""
        steps.setdefault("status", [{"result": IDLE_GATE}])
        # An add-on older than the maintenance_deadline capability, which every test not about it meets.
        steps.setdefault("capabilities", [{"result": {"revision": "r"}}])
        self.plan_path.write_text(json.dumps(steps))

    def acquired(self, **writes):
        return {"result": {"active": True, "operationId": self.operation, "busy": []},
                "writes": {str(self.lease): json.dumps({"operationId": self.operation}), **writes}}

    def released(self, busy=()):
        return {"result": {"active": False, "operationId": None, "busy": list(busy)}, "removes": [str(self.lease)]}

    def run_tool(self, *flags):
        """Run the tool; return (exit code, stdout), or raise what it raised."""
        out = io.StringIO()
        # An earlier run's lock can outlive it, held by the traceback a test kept; a new file is a new lock.
        (self.state / "worker.lock").unlink(missing_ok=True)
        with mock.patch.object(sys, "argv", [str(TOOL), "--config", str(self.config_path), *flags]), contextlib.redirect_stdout(out):
            try:
                runpy.run_path(str(TOOL), run_name="__main__")
            except SystemExit as done:
                return done.code, out.getvalue()
        raise AssertionError("the tool returned without exiting")

    def rpc_calls(self, capabilities=False):
        """The maintenance methods the tool called, in order. The capability read is left out unless asked for."""
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return [call["method"] for call in calls if capabilities or call["method"] != "capabilities"]

    def acquire_requests(self):
        """The (wait, deadline) each acquire was sent with."""
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return [(call["wait"], call["deadline"]) for call in calls if call["method"] == "acquire"]

    def stopped(self):
        return [call for call in map(json.loads, self.systemctl_calls.read_text().splitlines()) if call[1] == "stop"] if self.systemctl_calls.exists() else []

    def phase(self):
        path = self.base / "operations" / ("continued-" + self.operation) / "phase.json"
        return json.loads(path.read_text())["phase"] if path.exists() else None

    def assert_nothing_changed(self):
        self.assertEqual((self.state / "status.json").read_text(), self.PREVIOUS)
        self.assertEqual((self.stopped(), self.phase(), self.lease.exists()), ([], None, False))

    # The preflight: Hermes busy or unreachable changes nothing, so activation exits 75 and the stage stays prepared.
    def busy_preflights(self):
        """Each way the preflight finds Hermes busy: (name, arrange, the fence's name, text the person is shown)."""
        def add_on(result):
            return lambda: self.script(status=[{"result": result}])
        yield ("the add-on lists busy work", add_on({"active": False, "operationId": None, "busy": [{"profile": "nic"}]}),
               "maintenance gate inactive with no busy work", '"profile": "nic"')
        yield ("the gateway counts an agent", lambda: self.gateway(active_agents=1),
               "gateway reports no active agents or work", None)
        yield ("the gateway names active work", lambda: self.gateway(active_work=[{"kind": "chat", "profile": "kim"}]),
               "gateway reports no active agents or work", '"profile": "kim"')
        yield ("the dashboard counts an agent", lambda: setattr(self, "app_status", {"active_agents": 1, "active_sessions": 0}),
               "no active agents or sessions", None)
        yield ("the dashboard counts a session", lambda: setattr(self, "app_status", {"active_agents": 0, "active_sessions": 2}),
               "no active agents or sessions", None)

    def test_idle_hermes_passes_check_without_changing_anything(self):
        self.script()
        code, out = self.run_tool("--check")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["idleGatewayVerified"], True)
        self.assertEqual(self.rpc_calls(), ["status"])
        self.assertEqual([call[1] for call in map(json.loads, self.systemctl_calls.read_text().splitlines())], ["show"])
        self.assert_nothing_changed()

    def test_busy_hermes_at_the_preflight_exits_75_with_nothing_changed(self):
        for name, arrange, fence_name, shown in self.busy_preflights():
            with self.subTest(name):
                self.script()
                self.gateway()
                self.app_status = {"active_agents": 0, "active_sessions": 0}
                self.calls.unlink(missing_ok=True)
                arrange()
                code, out = self.run_tool()
                self.assertEqual(code, 75)
                self.assertIn("Release not started: Hermes has active work (" + fence_name + ")", out)
                self.assertIn("Nothing was changed. Activate again when Hermes is idle and answers.", out)
                if shown: self.assertIn(shown, out)
                # Never past the preflight: no acquire, no release, no stop, no journal, the status as it was.
                self.assertNotIn("acquire", self.rpc_calls())
                self.assert_nothing_changed()

    def test_busy_hermes_under_check_still_fails_as_the_fence_prepare_when_idle_retries(self):
        for name, arrange, fence_name, _ in self.busy_preflights():
            with self.subTest(name):
                self.script()
                self.gateway()
                self.app_status = {"active_agents": 0, "active_sessions": 0}
                arrange()
                with self.assertRaises(deploy_common.Fence) as caught:
                    self.run_tool("--check")
                self.assertEqual(str(caught.exception), fence_name)
                self.assertNotIsInstance(caught.exception, deploy_common.Refused)

    def test_an_unreachable_dashboard_at_the_preflight_exits_75_but_stays_a_failure_under_check(self):
        self.script(status=[{"unsent": True}])
        code, out = self.run_tool()
        self.assertEqual(code, 75)
        self.assertRegex(out, r"^Release not started: Hermes could not be reached \(Hermes was not asked for maintenance status\)\. Nothing was changed")
        self.assert_nothing_changed()
        self.script(status=[{"unsent": True}])
        with self.assertRaises(deploy_common.NotSent):
            self.run_tool("--check")

    def test_other_preflight_failures_are_not_a_refusal(self):
        # A failed status call with no marker may have reached Hermes; a stale gateway or an unready app is not busy work.
        cases = (
            ("status fails with no marker", lambda: self.script(status=[{"fail": True}]), RuntimeError, "private log retained"),
            ("status answers an error", lambda: self.script(status=[{"answeredError": BUSY}]), deploy_common.Answered, "active work"),
            # No lease was at the configured path a moment earlier, so a held gate is a concurrent or misconfigured operation.
            ("another operation holds the gate", lambda: self.script(status=[{"result": {"active": True, "operationId": "other", "busy": []}}]),
             deploy_common.Fence, "^no other operation holds the maintenance gate$"),
            ("another operation holds the gate and lists work", lambda: self.script(status=[{"result": {"active": True, "operationId": "other", "busy": [{"profile": "nic"}]}}]),
             deploy_common.Fence, "^no other operation holds the maintenance gate$"),
            ("gateway heartbeat is stale", lambda: self.gateway(updated_at="2020-01-01T00:00:00+00:00"), deploy_common.Fence,
             "gateway heartbeat under two minutes old"),
            ("gateway is not running", lambda: self.gateway(gateway_state="draining"), deploy_common.Fence, "gateway running, guarded and connected"),
        )
        for name, arrange, error, why in cases:
            for flags in ((), ("--check",)):
                with self.subTest(name, flags=flags):
                    self.script()
                    self.gateway()
                    arrange()
                    with self.assertRaisesRegex(error, why):
                        self.run_tool(*flags)
                    self.assert_nothing_changed()

    # The acquire: every ending that proves nothing changed exits 75 with the saved status back and the app running.
    def assert_refused(self, out, reason):
        code, text = out
        self.assertEqual(code, 75)
        self.assertRegex(text, "^Release not started: " + reason)
        self.assertTrue(text.rstrip().endswith("Nothing was stopped and the update status was restored."), text)
        self.assertEqual(((self.state / "status.json").read_text(), self.stopped(), self.phase(), self.lease.exists()),
                         (self.PREVIOUS, [], "maintenance-refused", False))

    def test_a_busy_acquire_is_asked_three_times_then_refused_with_nothing_stopped(self):
        self.script(acquire=[{"answeredError": BUSY}] * 3, release=[self.released([{"profile": "nic"}])])
        self.assert_refused(self.run_tool(), r'Hermes has active work\. Busy work at release: .*"profile": "nic"')
        self.assertEqual(self.rpc_calls(), ["status", "acquire", "acquire", "acquire", "release"])
        self.assertEqual([call.args for call in self.sleeps.call_args_list], [(2,), (2,)])

    def test_a_busy_answer_from_the_apps_own_poll_does_not_stop_the_release(self):
        self.script(acquire=[{"answeredError": BUSY}, self.acquired()])
        # The backup fails by design: the run reaches the app stop and ends held for review, which is not a refusal.
        code, out = self.run_tool()
        self.assertEqual(code, 2)
        self.assertEqual(self.rpc_calls(), ["status", "acquire", "acquire"])
        self.assertEqual(self.stopped(), [["--user", "stop", "agent-interface.service"]])
        self.assertEqual(self.phase(), "maintenance-held-needs-review")

    def test_a_gateway_turn_the_add_on_cannot_see_refuses_before_the_app_stops(self):
        # A Discord turn started between the preflight and the acquire: the add-on's busy list is empty.
        active = {"active_agents": 1, "active_work": [{"kind": "chat", "session": "discord:dm"}]}
        self.script(acquire=[self.acquired(**{str(self.home / "gateway_state.json"): json.dumps({**json.loads(self.gateway_record), **active})})],
                    release=[self.released()])
        self.assert_refused(self.run_tool(), r"The gateway has an active agent or its state is unreadable\. Busy work at release: \[\]")
        self.assertEqual(self.rpc_calls(), ["status", "acquire", "release"])
        self.assertEqual(self.sleeps.call_count, 0)

    def test_an_unsent_acquire_is_a_refusal_through_the_release_path(self):
        self.script(acquire=[{"unsent": True}], release=[self.released()])
        self.assert_refused(self.run_tool(), r"Hermes could not be reached: the service ticket or the connection failed before the request was sent\.")
        self.assertEqual(self.rpc_calls(), ["status", "acquire", "release"])

    def test_an_unsent_acquire_that_cannot_be_released_is_held_for_review(self):
        self.script(acquire=[{"unsent": True}], release=[{"unsent": True}])
        code, out = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("Release activation needs review", out)
        self.assertEqual(((self.state / "status.json").read_text().count("blocked"), self.stopped(), self.phase()), (1, [], "maintenance-held-needs-review"))

    def test_an_acquire_with_no_answer_is_still_held_for_review(self):
        # An add-on without the capability is sent no deadline, so a lost answer proves nothing.
        self.script(acquire=[{"fail": True}], release=[self.released()])
        code, out = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("Stopped at fence: Hermes answered maintenance acquire.", out)
        self.assertEqual((self.stopped(), self.phase()), ([], "maintenance-held-needs-review"))
        self.assertEqual(self.acquire_requests(), [(120, None)])

    CAPABLE = [{"result": {"revision": "r", "maintenance_deadline": True, "executor_epoch": "epoch-1"}}]

    def test_a_capable_add_on_is_asked_first_and_sent_a_deadline_shorter_than_the_wait(self):
        self.script(capabilities=self.CAPABLE, acquire=[self.acquired()])
        # The backup fails by design: the run reaches the app stop and ends held for review.
        code, _ = self.run_tool()
        self.assertEqual(code, 2)
        self.assertEqual(self.rpc_calls(capabilities=True)[:3], ["status", "capabilities", "acquire"])
        self.assertEqual(self.acquire_requests(), [(120, 90)])
        self.assertEqual(self.stopped(), [["--user", "stop", "agent-interface.service"]])

    def test_no_answer_after_the_deadline_is_a_refusal_with_nothing_stopped(self):
        # The capabilities are read again after the deadline passed, for the process epoch.
        self.script(capabilities=self.CAPABLE * 2, acquire=[{"deadlinePassed": True}], release=[self.released()])
        self.assert_refused(self.run_tool(), r"Hermes did not answer the maintenance request within its deadline, so none was granted\. Busy work at release: \[\]")
        # Not asked again: the add-on answered nothing for the whole wait.
        self.assertEqual(self.rpc_calls(), ["status", "acquire", "release"])
        self.assertEqual(self.acquire_requests(), [(120, 90)])
        # The tool watched for a late lease for the deadline it sent and the grace after it, with the blocked status kept.
        self.assertGreaterEqual(sum(call.args[0] for call in self.sleeps.call_args_list), deploy_common.DEADLINE_WATCH_SECONDS)

    def test_an_add_on_restarted_since_the_capability_read_is_held_for_review_not_refused(self):
        restarted = [{"result": {"revision": "r", "maintenance_deadline": True, "executor_epoch": "epoch-2"}}]
        self.script(capabilities=self.CAPABLE + restarted, acquire=[{"deadlinePassed": True}], release=[self.released()])
        code, out = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("Stopped at fence: Hermes answered maintenance acquire.", out)
        self.assertEqual((self.stopped(), self.phase(), self.sleeps.call_count), ([], "maintenance-held-needs-review", 0))

    def test_a_capable_add_ons_plain_failure_is_still_held_for_review(self):
        # Only the marker NATIVE prints after the wait proves no lease can appear.
        self.script(capabilities=self.CAPABLE, acquire=[{"fail": True}], release=[self.released()])
        code, out = self.run_tool()
        self.assertEqual(code, 2)
        self.assertIn("Stopped at fence: Hermes answered maintenance acquire.", out)
        self.assertEqual((self.stopped(), self.phase()), ([], "maintenance-held-needs-review"))

    def test_a_capability_read_that_fails_leaves_the_acquire_without_a_deadline(self):
        self.script(capabilities=[{"fail": True}], acquire=[{"fail": True}], release=[self.released()])
        code, _ = self.run_tool()
        self.assertEqual(code, 2)
        self.assertEqual(self.acquire_requests(), [(120, None)])
        self.assertEqual(self.phase(), "maintenance-held-needs-review")


if __name__ == "__main__":
    unittest.main()
