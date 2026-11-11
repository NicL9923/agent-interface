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
# Beyond the wait: up to 10 s for the service ticket, 10 s to open the socket and 5 s to close it.
MAINTENANCE_OVERHEAD = 25


class Answered(RuntimeError):
    """The add-on answered a maintenance RPC with this JSON-RPC error, so its handler returned."""

    def __init__(self, error):
        super().__init__("Hermes answered maintenance with an error: " + json.dumps(error))
        self.error = error


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
        NotSent when the service ticket or the connection failed before the request was sent; NATIVE
        prints each as its last stdout line before it fails. Any other failure, such as a timeout or
        a dropped socket, raises as before: no answer arrived, so the handler may still be running.
        """
        wait = MAINTENANCE_WAIT.get(request["method"], DEFAULT_MAINTENANCE_WAIT)
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
        return type(record.get("active_agents")) is int and record["active_agents"] == 0 and record.get("active_work") in (None, [])

    def acquire_then_stop_app(self, rpc, blocked, previous):
        """Close the app's gate, take the maintenance lease while the app still runs, then stop it.

        ``rpc`` calls the add-on's maintenance RPC through maintenance_rpc. ``blocked`` is this
        operation's blocked update status and ``previous`` the status it replaces. The app refuses
        sends, update checks and installs once the blocked status is written, telling the sender the
        draft is saved, so no one meets Hermes's own refusal. Work that arrived since the caller's
        status check makes acquire refuse here, before anything stops. The busy answer is asked
        again up to ACQUIRE_ATTEMPTS times, since the app's own poll can hold a reservation.

        Raises Refused when nothing changed and nothing can still change: the add-on's busy refusal,
        an answer that fails the checks below, a gateway that counts active work (the add-on does not
        see Discord turns), or a request that was never sent. A release then proves no lease remains,
        the saved status is restored and the app never stopped. With no answer the handler may still
        be running and write the lease later, so that fails at a fence with the blocked status kept
        for review. Any other failure propagates the same way.
        """
        status = Path(self.c["upgradeStateDir"]) / "status.json"
        self.atomic(status, blocked)
        self.journal("maintenance-acquiring")
        for attempt in range(1, ACQUIRE_ATTEMPTS + 1):
            try:
                gate = rpc("acquire")
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
            except Exception as lost:
                # The add-on preempts compactions before it decides, so a lost answer can mean the
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
        temporary = self.current.with_name("current." + self.operation)
        temporary.symlink_to(target); temporary.replace(self.current)

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
