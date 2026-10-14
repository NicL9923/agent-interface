"""Host steps shared by the bootstrap, guarded deploy and native recovery tools.

Each tool builds one Deployment for its operation, with the private configuration,
audit directory, command log and, once held, the native update claim. Recovery pins
this file's SHA256 as deployFunctionsSha256 in its checked configuration.
"""
import datetime
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request


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

    def run(self, argv, *, cwd=None, input=None, timeout=120):
        if self.claim: self.claim.validate()
        result = subprocess.run(argv, cwd=cwd, input=input, text=True, capture_output=True, timeout=timeout)
        self.log.write(result.stdout + result.stderr); self.log.flush()
        if result.returncode: raise RuntimeError("A deployment command failed; private log retained")
        return result.stdout

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

    def native(self, code):
        # Set the native root before bootstrap can latch process identity, so native
        # calls resolve the configured home rather than whatever the caller inherited.
        prefix = ("import os; os.environ['HERMES_HOME']=" + repr(str(self.home)) + "; "
                  "import sys; sys.path.insert(0," + repr(str(self.source)) + "); import hermes_bootstrap; ")
        return self.run([self.c["managedPython"], "-I", "-c", prefix + code])

    def google(self):
        assert json.loads(self.run(self.c["googleVerificationCommand"], timeout=90)) == {"authenticatedHttp": True, "freshWebsocket": True}

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

    def gateway_state(self):
        return json.loads((self.home / "gateway_state.json").read_text())

    def ready_gateway(self, state):
        record = self.gateway_state()
        stamp = record.get("agent_interface_gateway_guard", {})
        return (record.get("pid") == int(self.pid("hermes-gateway.service")) and record.get("gateway_state") == state
            and record.get("code_sha") == self.c["hermesRevision"] and record.get("hermes_home") == str(self.home)
            and stamp == {"schemaVersion": 1, "maintenanceFile": str(self.lease), "pendingIngress": 0}
            and all(record.get("platforms", {}).get(key, {}).get("state") == "connected" for key in self.c["discordConnections"]))
