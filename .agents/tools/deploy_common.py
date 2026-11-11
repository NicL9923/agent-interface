"""Host steps shared by the bootstrap, guarded deploy and native recovery tools.

Each tool builds one Deployment for its operation, with the private configuration,
audit directory, command log and, once held, the native update claim. Recovery pins
this file's SHA256 as deployFunctionsSha256 in its checked configuration.
"""
import contextlib
import datetime
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request


# Written into the release being activated, naming the assets directory of the release it replaces. The app
# serves a hashed /assets/ file the live release lacks from there, so a page opened under the previous
# release can still load its files (src/server/static-cache.ts reads it; tests/static-cache.test.ts compares the name).
PREVIOUS_RELEASE_FILE = "dist/previous-release.json"

# The Hermes plugin directory name of src/hermes/wildbots_voice; src/hermes/voice.py PLUGIN must match.
VOICE_PLUGIN = "wildbots-voice"


class Fence(AssertionError):
    """A cutover guard refused to continue. It subclasses AssertionError, so every
    handler and test written for the former asserts treats it the same way."""


def fence(condition, why):
    """Stop unless condition holds, naming the guard. Unlike assert, survives python -O."""
    if not condition:
        raise Fence(why)


# Host programs sent as source keep their assert guards; any that can be stripped refuse to run.
OPTIMIZED_REFUSAL = """
if not __debug__:
    raise SystemExit("Host programs need their assert guards. Run python3 without -O or PYTHONOPTIMIZE.")
"""


class Refused(Exception):
    """Hermes refused maintenance while the app still ran, because it was busy or could not be asked.
    Nothing was stopped, no lease is held and the saved update status is back, so the operation can
    simply run again. The message says which, and ends with what to do."""


# The add-on's answer to an acquire while it sees active work. Its handler returns this before it
# writes any lease (src/hermes/extension.py, maintenance), so it is the one finished refusal.
BUSY_REFUSAL = {"code": 409, "message": "Hermes still has active work; no maintenance lease acquired"}
# The app's own 5 s poll holds an add-on reservation (src/hermes/extension.py, active_count() > 1), so an
# idle app can draw the busy answer once. A busy answer writes no lease, so asking again is safe.
ACQUIRE_ATTEMPTS = 3
ACQUIRE_RETRY_SECONDS = 2
# How long the maintenance RPC waits for each WebSocket message. Before it decides, acquire
# preempts each canonical Bot Chat's idle compaction for up to 30 s (src/hermes/compaction.py
# PREEMPT_WAIT). One compaction runs at a time, so the usual wait is one preempt; another can
# start as the first ends, and nothing caps the chain. 120 s covers three full waits. A longer
# chain misses the wait and is held for review like any unanswered acquire. Other actions answer at once.
MAINTENANCE_WAIT = {"acquire": 120}
DEFAULT_MAINTENANCE_WAIT = 15
# The add-on's acquire takes an optional `deadline`, the seconds the caller will wait, counted from the moment its
# handler starts, and writes no lease after it (src/hermes/extension.py, acquire_lease); an add-on that honors it says
# `maintenance_deadline: true` in `agent-interface.capabilities`, with an `executor_epoch` naming its process. The
# deadline is the wait less this margin. The margin covers what the add-on does not bound: the handler starting late,
# since a request waits for a free thread in Hermes's dispatch pool, and its answer crossing the socket. Its own overrun
# past the deadline is one 50 ms lock attempt and a 20 ms poll (src/hermes/compaction.py, LOCK_SECONDS, preempt), so
# 30 s, one full preempt wait, is over 100 times that. 90 s is three full preempt waits, the chain the 120 s wait was
# sized for, and a longer chain now ends in a refusal, not a held review. The release helper
# (scripts/hermes-upgrade-linux.py) holds the same values.
DEADLINE_MARGIN = 30
ACQUIRE_DEADLINE = MAINTENANCE_WAIT["acquire"] - DEADLINE_MARGIN
# The clock starts when the handler does, not when the request was sent, and a handler that starts late can write its
# lease after the wait is over. So an acquire with no answer for the whole wait does not prove there is no lease: a
# release confirmed at that point proves only that none existed then. What bounds a late handler is the order of
# the queue. Hermes dispatches each WebSocket request with asyncio.to_thread(server.dispatch) (tui_gateway/ws.py,
# _dispatch_request), the loop's default executor, whose work queue is first in, first out, and the maintenance
# methods are not among the handlers that move to the separate RPC pool. The acquire was sent over its own socket
# at least a full wait before the release, so it was queued first, and its handler started no later than the
# release's. Its lease is therefore written no later than the deadline, ACQUIRE_DEADLINE s, plus the overrun above
# after the release's handler began, and the release's answer came after that. So the tool watches for this
# operation's lease for ACQUIRE_DEADLINE s plus this grace, which covers a few threads taking the add-on's
# maintenance lock in another order (it is only ever held for a file read or write, never across a preempt),
# and releases again if the lease shows. This rests on that queue order. A change of Hermes's dispatch that
# stops queuing in order, or runs maintenance elsewhere, breaks it.
DEADLINE_WATCH_GRACE = 10
DEADLINE_WATCH_SECONDS = ACQUIRE_DEADLINE + DEADLINE_WATCH_GRACE
# Beyond the wait: 10 s for the service ticket, 10 s to open the socket, 5 s to close it, and 5 s to start the
# interpreter, which the release helper's worker budgets as well (scripts/hermes-upgrade-linux.py).
MAINTENANCE_OVERHEAD = 30


class Answered(RuntimeError):
    """The add-on answered a maintenance RPC with this JSON-RPC error, so its handler returned."""

    def __init__(self, error):
        super().__init__("Hermes answered maintenance with an error: " + json.dumps(error))
        self.error = error


class DeadlinePassed(RuntimeError):
    """An acquire sent with a deadline got no answer for the whole wait, which is longer than the deadline. The add-on
    writes no lease after the deadline, which counts from when its handler started: a release is final only after a
    watch (DEADLINE_WATCH_SECONDS) for a handler that started late."""


class NotSent(RuntimeError):
    """A maintenance RPC failed before its request was sent, in the service ticket or the socket
    connection. The add-on never saw it, so no handler can still be running there."""


def tripped(error):
    """Operator-facing name of the fence behind an error, or an empty string."""
    while error is not None:
        if isinstance(error, Fence):
            return " Stopped at fence: " + str(error) + "."
        error = error.__cause__ or error.__context__
    return ""


class Deployment:
    """One operation's host context. Every command revalidates the held update claim."""

    systemctl = "/usr/bin/systemctl"

    def __init__(self, config, *, operation, ops, log, claim=None):
        self.c = config
        self.operation = operation
        self.ops = Path(ops)
        self.log = log
        self.claim = claim
        self.base = Path(config["appBase"])
        self.release = Path(config["release"])
        self.source = Path(config["source"])
        self.home = Path(config["hermesHome"])
        self.current = self.base / "current"
        self.lease = Path(config["maintenanceFile"])
        self.origin = config["appOrigin"]
        self.service_env = self.base / "shared/hermes-service.env"

    def journal(self, phase):
        self.atomic(self.ops / "phase.json", (json.dumps({"operationId": self.operation, "phase": phase,
            "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}) + "\n").encode())

    def execute(self, argv, *, cwd=None, input=None, timeout=120):
        """Run a command under the held claim and keep its output in the private log."""
        if self.claim: self.claim.validate()
        result = subprocess.run(argv, cwd=cwd, input=input, text=True, capture_output=True, timeout=timeout)
        self.log.write(result.stdout + result.stderr); self.log.flush()
        return result

    def run(self, argv, *, cwd=None, input=None, timeout=120):
        result = self.execute(argv, cwd=cwd, input=input, timeout=timeout)
        if result.returncode: raise RuntimeError("A deployment command failed; private log retained")
        return result.stdout

    def maintenance_rpc(self, argv, request):
        """Run the release helper's NATIVE maintenance RPC (scripts/hermes-upgrade-linux.py).

        Returns the add-on's result. Raises Answered when the add-on answered with an error, and
        NotSent when the service ticket or the connection failed before the request was sent, and
        DeadlinePassed when a request that carries a ``deadline`` got no answer for the whole wait;
        NATIVE prints each as its last stdout line before it fails. Any other failure, such as a
        timeout of the child itself, raises as before: no answer arrived, so the handler may still be running.
        """
        wait = MAINTENANCE_WAIT.get(request["method"], DEFAULT_MAINTENANCE_WAIT)
        deadline = request.get("deadline")
        if deadline is not None and deadline >= wait:
            raise ValueError("A deadline must be shorter than the wait for its answer")
        result = self.execute(argv, input=json.dumps(dict(request, wait=wait)), timeout=wait + MAINTENANCE_OVERHEAD)
        if not result.returncode:
            return json.loads(result.stdout)
        lines = result.stdout.splitlines()
        try:
            answer = json.loads(lines[-1]) if lines else None
        except ValueError:
            answer = None
        if isinstance(answer, dict) and list(answer) == ["answeredError"] and isinstance(answer["answeredError"], dict):
            raise Answered(answer["answeredError"])
        if isinstance(answer, dict) and list(answer) == ["unsent"] and answer["unsent"] is True:
            raise NotSent("Hermes was not asked for maintenance " + request["method"])
        if deadline is not None and isinstance(answer, dict) and list(answer) == ["deadlinePassed"] and answer["deadlinePassed"] is True:
            raise DeadlinePassed("Hermes did not answer maintenance " + request["method"] + " within its " + str(deadline) + " s deadline")
        raise RuntimeError("A deployment command failed; private log retained")

    def system(self, action, *names):
        return self.run([self.systemctl, "--user", action, *names])

    def pid(self, unit):
        return self.system("show", unit, "-p", "MainPID", "--value").strip()

    def get_status(self):
        with urllib.request.urlopen("http://127.0.0.1:9119/api/status", timeout=10) as response:
            return json.load(response)

    def wait(self, predicate, seconds=90):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                if predicate(): return
            except (OSError, ValueError, urllib.error.URLError): pass
            time.sleep(1)
        raise RuntimeError("Deployment readiness was not confirmed")

    def atomic(self, path, data):
        temporary = path.with_name(path.name + "." + self.operation)
        with temporary.open("xb") as output: output.write(data); output.flush(); os.fsync(output.fileno())
        temporary.replace(path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)

    def requests_complete(self):
        """Whether every Hermes update request the app admitted has finished."""
        return all(json.loads(path.read_text()).get("status") == "complete"
                   for path in (Path(self.c["upgradeStateDir"]) / "requests").glob("*.json"))

    def gateway_reports_idle(self):
        """Whether the gateway's last published record counts no active agent and lists no active work.

        A Discord turn runs in the gateway runner, not in the add-on's sessions, so the add-on's busy
        list omits it. The gateway rewrites this count at every turn boundary."""
        record = self.gateway_state()
        return type(record.get("active_agents")) is int and record["active_agents"] == 0 and "active_work" in record and record["active_work"] in (None, [])

    def acquire_deadline(self, rpc):
        """(ACQUIRE_DEADLINE, executor_epoch) when the running add-on says it honors a deadline, else (None, None).

        A read that fails is (None, None) as well: an older add-on is held for review exactly as before, and a
        dashboard that cannot be asked will fail the acquire the same way. An add-on that names no process epoch
        cannot be told apart from a restart later, so it gets no deadline either."""
        try: capabilities = rpc("capabilities")
        except (RuntimeError, ValueError, subprocess.SubprocessError): return None, None
        if not isinstance(capabilities, dict) or capabilities.get("maintenance_deadline") is not True: return None, None
        epoch = capabilities.get("executor_epoch")
        return (ACQUIRE_DEADLINE, epoch) if isinstance(epoch, str) and epoch else (None, None)

    def same_add_on(self, rpc, epoch):
        """Whether the add-on that was asked for its capabilities before the acquire is still the process answering.

        A restart between the two can put an add-on that ignores the deadline in its place, and its silence then
        proves nothing. A read that fails is not the same add-on."""
        try: capabilities = rpc("capabilities")
        except (RuntimeError, ValueError, subprocess.SubprocessError): return False
        return isinstance(capabilities, dict) and capabilities.get("executor_epoch") == epoch

    def late_lease(self):
        """Whether a lease file appears within DEADLINE_WATCH_SECONDS. It is this operation's lease, or release says
        otherwise: another operation's answers 409 and ends in a held review."""
        for _ in range(DEADLINE_WATCH_SECONDS):
            if os.path.lexists(self.lease): return True
            time.sleep(1)
        return os.path.lexists(self.lease)

    def acquire_then_stop_app(self, rpc, blocked, previous):
        """Close the app's gate, take the maintenance lease while the app still runs, then stop it.

        ``rpc(action, deadline=None)`` calls the add-on's maintenance RPC through maintenance_rpc;
        action ``capabilities`` reads its capabilities. ``blocked`` is this
        operation's blocked update status and ``previous`` the status it replaces. The app refuses
        sends, update checks and installs once the blocked status is written, telling the sender the
        draft is saved, so no one meets Hermes's own refusal. Work that arrived since the caller's
        status check makes acquire refuse here, before anything stops. The busy answer is asked
        again up to ACQUIRE_ATTEMPTS times, since the app's own poll can hold a reservation. An
        add-on that says it honors a deadline is sent ACQUIRE_DEADLINE with each attempt.

        Raises Refused when nothing changed and nothing can still change: the add-on's busy refusal,
        an answer that fails the checks below, a gateway that counts active work (the add-on does not
        see Discord turns), a request that was never sent, or no answer for the whole wait of a
        request that carried a deadline, from an add-on that is still the process asked for its capabilities (the add-on
        writes no lease after the deadline, and a handler that started late is outwaited, see DEADLINE_WATCH_SECONDS).
        A release then proves no lease remains, the saved status is restored and the app never stopped. With no answer the handler may still
        be running and write the lease later, so that fails at a fence with the blocked status kept
        for review. Any other failure propagates the same way.
        """
        status = Path(self.c["upgradeStateDir"]) / "status.json"
        self.atomic(status, blocked)
        # Read before the phase is journaled: asking for capabilities changes nothing and may fail without consequence.
        deadline, epoch = self.acquire_deadline(rpc)
        self.journal("maintenance-acquiring")
        for attempt in range(1, ACQUIRE_ATTEMPTS + 1):
            try:
                gate = rpc("acquire", deadline=deadline)
            except Answered as answer:
                # Any other error answer is a configuration or ownership problem, not busy work.
                if answer.error != BUSY_REFUSAL: raise
                if attempt < ACQUIRE_ATTEMPTS:
                    time.sleep(ACQUIRE_RETRY_SECONDS)
                    continue
                self.refuse(rpc, status, blocked, previous, answer, "Hermes has active work.")
            except NotSent as unsent:
                # The add-on never saw the request, so no lease can appear. The release proves it.
                self.refuse(rpc, status, blocked, previous, unsent,
                            "Hermes could not be reached: the service ticket or the connection failed before the request was sent.")
            except DeadlinePassed as passed:
                # The add-on writes no lease after its deadline, but the deadline counts from when its handler started,
                # which may be late. refuse() releases, then outwaits a late handler (DEADLINE_WATCH_SECONDS). Not
                # retried: the add-on answered nothing for two minutes. A restart since the capability read puts an
                # add-on there that may ignore the deadline, so that is held for review like any lost answer.
                if not self.same_add_on(rpc, epoch):
                    with contextlib.suppress(Exception): rpc("release")
                    raise Fence("Hermes answered maintenance acquire") from passed
                self.refuse(rpc, status, blocked, previous, passed,
                            "Hermes did not answer the maintenance request within its deadline, so none was granted.")
            except Exception as lost:
                # An acquire that would succeed preempts compactions before it writes, so a lost answer can mean the
                # handler is still running. Release removes a lease it already wrote, never one it
                # writes afterwards, so this is never reported as nothing changed.
                with contextlib.suppress(Exception): rpc("release")
                raise Fence("Hermes answered maintenance acquire") from lost
            break
        try:
            fence(gate["active"] is True and gate["operationId"] == self.operation and gate["busy"] == [], "maintenance acquired by this operation with no busy work")
            fence(json.loads(self.lease.read_text()) == {"operationId": self.operation}, "maintenance lease names this operation")
        except Exception as unexpected:
            # The handler answered, so it has returned; release clears whatever lease it wrote.
            self.refuse(rpc, status, blocked, previous, unexpected, "Hermes's maintenance answer was not this operation's lease.")
        try:
            # The lease admits nothing new, so a Discord turn counted now is the last one to wait for.
            fence(self.gateway_reports_idle(), "gateway reports no active agents or work after maintenance was acquired")
        except Exception as active:
            self.refuse(rpc, status, blocked, previous, active, "The gateway has an active agent or its state is unreadable.")
        self.journal("owned-maintenance-acquired")
        self.system("stop", "agent-interface.service")
        fence(self.requests_complete(), "pending update requests complete after the app stopped")
        # Eliminate an already awaited API request racing the private status write.
        self.atomic(status, blocked)

    def refuse(self, rpc, status, blocked, previous, refusal, reason):
        """Undo a finished acquire that took no usable lease, then raise Refused."""
        # Release clears this operation's lease, if any, and reports what was busy.
        released = rpc("release")
        fence(released["active"] is False, "refused: maintenance released")
        fence(not os.path.lexists(self.lease), "refused: no maintenance lease remains")
        if isinstance(refusal, DeadlinePassed) and self.late_lease():
            # The handler started late and wrote its lease after the release. It has returned, so a second release is final.
            released = rpc("release")
            fence(released["active"] is False, "refused: maintenance released after a late lease")
            fence(not os.path.lexists(self.lease), "refused: no maintenance lease remains after a late lease")
        # The app still runs, but holding the update worker's lock keeps it from writing a
        # new status. One it wrote anyway is left as found for review.
        fence(status.read_bytes() == blocked, "refused: update status is still this operation's blocked status")
        fence(self.requests_complete(), "refused: pending update requests are complete")
        self.atomic(status, previous)
        self.journal("maintenance-refused")
        raise Refused(reason + " Busy work at release: " + json.dumps(released.get("busy")) + ". Activate again when Hermes is idle and answers.") from refusal

    def native(self, code):
        # Set the native root before bootstrap can latch process identity, so native
        # calls resolve the configured home rather than whatever the caller inherited.
        prefix = ("import os; os.environ['HERMES_HOME']=" + repr(str(self.home)) + "; "
                  "import sys; sys.path.insert(0," + repr(str(self.source)) + "); import hermes_bootstrap; ")
        return self.run([self.c["managedPython"], "-I", "-c", prefix + code])

    def google(self):
        fence(json.loads(self.run(self.c["googleVerificationCommand"], timeout=90)) == {"authenticatedHttp": True, "freshWebsocket": True}, "Google session reaches authenticated HTTP and a fresh WebSocket")

    def app_ready(self):
        def request(path, body=None):
            req = urllib.request.Request(self.origin + path,
                data=body, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=10) as response: return response.status, response.read()
            except urllib.error.HTTPError as error: return error.code, error.read()
        code, body = request("/api/health")
        return code == 200 and json.loads(body).get("ok") is True and request("/api/bootstrap")[0] == 401 and request("/api/auth/local", b"{}")[0] == 403

    def retire(self, action, token=None):
        credentials = json.loads(Path(self.c["googleSessionFile"]).read_text())
        body = {"action": action}
        if token: body["token"] = token
        request = urllib.request.Request("http://127.0.0.1:9119/api/health/retirement", data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + credentials["access_token"], "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=15) as response: return json.load(response)

    def switch(self, target):
        self.name_previous_release(Path(target))
        temporary = self.current.with_name("current." + self.operation)
        temporary.symlink_to(target); temporary.replace(self.current)

    def name_previous_release(self, target):
        """Tell the release about to go live which release it replaces, for the app's asset grace.

        Writes PREVIOUS_RELEASE_FILE in ``target``, naming the live release's assets directory, and
        removes one left from an earlier cycle when there is nothing to name: a first release, the
        release itself, or a previous release without assets. The grace is a courtesy to pages already
        open, so a failure here is logged and never stops the cutover."""
        file = target / PREVIOUS_RELEASE_FILE
        try:
            previous = self.current.resolve() if self.current.exists() else None
            assets = previous / "dist/client/assets" if previous is not None and previous != target.resolve() else None
            if assets is None or not assets.is_dir():
                file.unlink(missing_ok=True)
            else:
                self.atomic(file, (json.dumps({"assets": str(assets)}) + "\n").encode())
        except OSError as error:
            self.log.write("The previous release was not named to the app: " + str(error) + "\n"); self.log.flush()

    @property
    def voice_plugin(self):
        """Hermes's plugin link for live voice, and the target it must hold. The target goes
        through current, so switch() moves it to each new release with everything else."""
        return self.home / "plugins" / VOICE_PLUGIN, self.current / "src/hermes/wildbots_voice"

    def voice_plugin_ready(self):
        """Whether link_voice_plugin can run: the path is free, or already the expected link."""
        link, target = self.voice_plugin
        return not os.path.lexists(link) or link.is_symlink() and os.readlink(link) == str(target)

    def link_voice_plugin(self):
        """Links the live voice plugin into Hermes once. Enabling it stays a person's choice
        (`hermes plugins enable wildbots-voice`), since it lets the plugin use the ChatGPT sign-in."""
        link, target = self.voice_plugin
        fence(self.voice_plugin_ready(), "voice plugin path is free or already linked through current")
        if os.path.lexists(link): return
        link.parent.mkdir(parents=True, exist_ok=True)
        temporary = link.with_name("." + link.name + "." + self.operation)
        temporary.symlink_to(target, target_is_directory=True); temporary.replace(link)

    def gateway_state(self):
        return json.loads((self.home / "gateway_state.json").read_text())

    def ready_gateway(self, state):
        record = self.gateway_state()
        stamp = record.get("agent_interface_gateway_guard", {})
        return (record.get("pid") == int(self.pid("hermes-gateway.service")) and record.get("gateway_state") == state
            and record.get("code_sha") == self.c["hermesRevision"] and record.get("hermes_home") == str(self.home)
            and stamp == {"schemaVersion": 1, "maintenanceFile": str(self.lease), "pendingIngress": 0}
            and all(record.get("platforms", {}).get(key, {}).get("state") == "connected" for key in self.c["discordConnections"]))
