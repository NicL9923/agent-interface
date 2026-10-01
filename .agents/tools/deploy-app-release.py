#!/usr/bin/env python3
"""Bootstrap a built app release and gateway guards with private rollback copies."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import runpy
import stat
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--config", type=Path, required=True)
parser.add_argument("--check", action="store_true", help="Verify the release and live authentication without switching services")
args = parser.parse_args()
os.umask(0o077)
info = args.config.lstat()
assert args.config.is_absolute() and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
c = json.loads(args.config.read_text())
origin = c["appOrigin"]
parsed_origin = urlsplit(origin)
assert parsed_origin.scheme == "https" and parsed_origin.netloc and not parsed_origin.username
assert not parsed_origin.path and not parsed_origin.query and not parsed_origin.fragment
base, release, source, home = [Path(c[key]) for key in ("appBase", "release", "source", "hermesHome")]
assert all(path.is_absolute() for path in (base, release, source, home))
assert release.parent == base / "releases" and release.is_dir() and not release.is_symlink()
current = base / "current"
old_release = current.resolve(strict=True)
assert current.is_symlink() and release != old_release
operation = str(uuid.uuid4())
ops = base / "operations" / ("release-" + operation)
ops.mkdir(mode=0o700)
lease = Path(c["maintenanceFile"])
drain = home / ".drain_request.json"
assert lease.is_absolute() and not lease.exists() and not lease.is_symlink() and not drain.exists()
app_env, service_env = [base / "shared" / name for name in ("app.env", "hermes-service.env")]
units = Path.home() / ".config/systemd/user"
gateway_dropin = units / "hermes-gateway.service.d/90-agent-interface.conf"
gateway_link = source / "agent_interface_gateway.py"
assert not gateway_dropin.exists() and not gateway_link.exists() and not gateway_link.is_symlink()
saved = {str(path): path.read_bytes() for path in (app_env, service_env)}
for path, data in saved.items(): (ops / Path(path).name).write_bytes(data)
configs = [home / "config.yaml", home / "profiles/kimberly/config.yaml"]
hashes = lambda: {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in configs}
baseline = hashes()
log = (ops / "commands.log").open("a")
claim = None

def journal(phase):
    atomic(ops / "phase.json", (json.dumps({"operationId": operation, "phase": phase,
        "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}) + "\n").encode())

def run(argv, *, cwd=None, input=None, timeout=120):
    if claim: claim.validate()
    result = subprocess.run(argv, cwd=cwd, input=input, text=True, capture_output=True, timeout=timeout)
    log.write(result.stdout + result.stderr); log.flush()
    if result.returncode: raise RuntimeError("A deployment command failed; private log retained")
    return result.stdout

def system(action, *names):
    return run(["/usr/bin/systemctl", "--user", action, *names])

def pid(unit):
    return system("show", unit, "-p", "MainPID", "--value").strip()

def get_status():
    with urllib.request.urlopen("http://127.0.0.1:9119/api/status", timeout=10) as response:
        return json.load(response)

def wait(predicate, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if predicate(): return
        except (OSError, ValueError, urllib.error.URLError): pass
        time.sleep(1)
    raise RuntimeError("Deployment readiness was not confirmed")

def atomic(path, data):
    temporary = path.with_name(path.name + "." + operation)
    with temporary.open("xb") as output: output.write(data); output.flush(); os.fsync(output.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)

def change_environment(path, values):
    lines = path.read_text().splitlines()
    lines = [line for line in lines if line.split("=", 1)[0] not in values]
    atomic(path, ("\n".join(lines + [key + "=" + value for key, value in values.items()]) + "\n").encode())

def native(code):
    prefix = "import sys; sys.path.insert(0," + repr(str(source)) + "); import hermes_bootstrap; "
    return run([c["managedPython"], "-I", "-c", prefix + code])

def google():
    assert json.loads(run(c["googleVerificationCommand"], timeout=90)) == {"authenticatedHttp": True, "freshWebsocket": True}

def app_ready():
    def request(path, body=None):
        req = urllib.request.Request(origin + path,
            data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as response: return response.status, response.read()
        except urllib.error.HTTPError as error: return error.code, error.read()
    code, body = request("/api/health")
    return code == 200 and json.loads(body).get("ok") is True and request("/api/bootstrap")[0] == 401 and request("/api/auth/local", b"{}")[0] == 403

def retire(action, token=None):
    credentials = json.loads(Path(c["googleSessionFile"]).read_text())
    body = {"action": action}
    if token: body["token"] = token
    request = urllib.request.Request("http://127.0.0.1:9119/api/health/retirement", data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + credentials["access_token"], "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=15) as response: return json.load(response)

def switch(target):
    temporary = current.with_name("current." + operation)
    temporary.symlink_to(target); temporary.replace(current)

def gateway_state():
    return json.loads((home / "gateway_state.json").read_text())

def ready_gateway(state):
    record = gateway_state()
    stamp = record.get("agent_interface_gateway_guard", {})
    return (record.get("pid") == int(pid("hermes-gateway.service")) and record.get("gateway_state") == state
        and record.get("code_sha") == c["hermesRevision"] and record.get("hermes_home") == str(home)
        and stamp == {"schemaVersion": 1, "maintenanceFile": str(lease), "pendingIngress": 0}
        and all(record.get("platforms", {}).get(key, {}).get("state") == "connected" for key in c["discordConnections"]))

def release_lease():
    # Use the native private maintenance authority; never remove another owner's gate.
    code = ("import runpy; m=runpy.run_path(" + repr(str(release / "scripts/hermes-upgrade-linux.py")) + "); "
        "import os; os.environ['HERMES_UPGRADE_SOURCE']=" + repr(str(source)) + "; "
        "exec(m['NATIVE'])")
    secret = dict(line.split("=", 1) for line in service_env.read_text().splitlines() if "=" in line)["HERMES_AGENT_INTERFACE_TOKEN"]
    request = {"action": "rpc", "source": str(source), "origin": "http://127.0.0.1:9119", "key": secret,
               "operation": operation, "method": "release"}
    value = json.loads(run([c["managedPython"], "-I", "-c", code], input=json.dumps(request), timeout=45))
    assert value["active"] is False

revision = run(["git", "-C", str(source), "rev-parse", "HEAD"]).strip()
patch = subprocess.check_output(["git", "-C", str(source), "diff", "HEAD", "--binary"])
assert revision == c["hermesRevision"] and hashlib.sha256(patch).hexdigest() == c["repairSha256"]
assert c["webBuild"] in (release / "dist/client/sw.js").read_text()
before = get_status()
assert before["active_agents"] == before["active_sessions"] == 0 and not before["gateway_busy"]
assert before["auth_required"] and before["auth_providers"] == ["google-family"]
google()
if args.check:
    assert app_ready()
    journal("preflight-passed")
    print(json.dumps({"releaseVerified": True, "originalGoogleHttpAndFreshWebsocket": True, "noServiceChanges": True}))
    log.close()
    raise SystemExit(0)
claim = runpy.run_path(str(release / "scripts/hermes-upgrade-worker.py"))["NativeUpdateClaim"](source, home)
claim.__enter__()
os.environ["HERMES_UPDATE_HANDOFF_PID"] = str(os.getpid())
changed = False
committed = False
commit_attempted = False
permit = None
release_started = False
try:
    # Recheck source under native updater ownership before stopping anything.
    assert run(["git", "-C", str(source), "rev-parse", "HEAD"]).strip() == revision
    assert hashlib.sha256(subprocess.check_output(["git", "-C", str(source), "diff", "HEAD", "--binary"])).hexdigest() == c["repairSha256"]
    run([c["node"], str(release / ".agents/tools/backup-app.mjs"), str(base / "shared/app.sqlite"), str(ops / "database")])
    (ops / "baseline.json").write_text(json.dumps({"oldRelease": str(old_release), "source": revision,
        "repairSha256": c["repairSha256"], "profileHashes": baseline}, indent=2) + "\n")
    journal("quiescence")
    system("stop", "agent-interface.service")
    requested = json.loads(native("import json; from gateway.drain_control import write_drain_request; print(json.dumps(write_drain_request(principal=" + repr(operation) + ",suppress_notification=True)))"))
    requested_at = datetime.datetime.fromisoformat(requested["requested_at"])
    old_pid = int(pid("hermes-gateway.service"))
    def drained():
        record = gateway_state()
        updated = datetime.datetime.fromisoformat(record["updated_at"])
        return (record.get("pid") == old_pid and updated > requested_at and record.get("gateway_state") == "draining"
            and record.get("code_sha") == revision and record.get("hermes_home") == str(home)
            and 0 <= time.time() - updated.timestamp() <= 10
            and pid("hermes-gateway.service") == str(old_pid)
            and type(record.get("active_agents")) is int and record["active_agents"] == 0
            and "active_work" in record and record["active_work"] in (None, []))
    wait(drained, 20)
    permit = retire("prepare")
    assert permit.get("ok") is True and permit.get("idle") is True
    commit_attempted = True
    assert retire("commit", permit["token"]).get("ok") is True
    committed = True
    journal("retirement-committed")
    stop_started = time.time()
    system("stop", "hermes-dashboard.service", "hermes-gateway.service")
    assert pid("hermes-dashboard.service") == pid("hermes-gateway.service") == "0"
    # Refuse cutover after a timed-out or killed native gateway shutdown.
    stop_verdict = dict(line.split("=", 1) for line in system("show", "hermes-gateway.service",
        "--property=Result,ExecMainCode,ExecMainStatus").splitlines())
    assert stop_verdict["Result"] == "success" and stop_verdict["ExecMainCode"] == "1" and stop_verdict["ExecMainStatus"] == "0"
    assert (home / ".clean_shutdown").stat().st_mtime >= stop_started
    stopped = gateway_state()
    assert stopped.get("pid") == old_pid and stopped.get("gateway_state") == "stopped"
    assert datetime.datetime.fromisoformat(stopped["updated_at"]).timestamp() >= stop_started
    assert stopped.get("code_sha") == revision and stopped.get("hermes_home") == str(home)
    assert hashes() == baseline
    assert run(["git", "-C", str(source), "rev-parse", "HEAD"]).strip() == revision
    assert hashlib.sha256(subprocess.check_output(["git", "-C", str(source), "diff", "HEAD", "--binary"])).hexdigest() == c["repairSha256"]
    atomic(lease, (json.dumps({"operationId": operation}) + "\n").encode())
    switch(release); changed = True
    journal("release-switched")
    gateway_link.symlink_to(current / "src/hermes/gateway_guard.py")
    change_environment(service_env, {"HERMES_AGENT_INTERFACE_MAINTENANCE_FILE": str(lease),
        "HERMES_AGENT_INTERFACE_QUALIFICATION_FILE": c["qualificationReceipt"]})
    gateway_dropin.parent.mkdir(parents=True, exist_ok=True)
    gateway_dropin.write_text("[Service]\nEnvironmentFile=" + str(service_env) + "\nExecStart=\nExecStart="
        + str(source / ".hermes/bin/hermes") + " --run-module agent_interface_gateway\n")
    change_environment(app_env, c["upgradeEnvironment"])
    system("daemon-reload")
    system("start", "hermes-dashboard.service", "hermes-gateway.service", "agent-interface.service")
    wait(lambda: get_status().get("auth_providers") == ["google-family"])
    wait(lambda: ready_gateway("draining"))
    journal("guarded-verification")
    google()
    wait(app_ready)
    assert hashes() == baseline
    run([c["node"], "--env-file=" + str(app_env), "--import", "tsx", "scripts/setup.ts", "--check"], cwd=current)
    # The RPC may succeed even if its response is lost. From this point new
    # native work can start, so diagnostics cannot authorize another shutdown.
    release_started = True
    release_lease()
    assert json.loads(drain.read_text()).get("principal") == operation
    native("from gateway.drain_control import clear_drain_request; assert clear_drain_request()")
    wait(lambda: ready_gateway("running"))
    google()
    assert app_ready()
    state = Path(c["upgradeStateDir"]) / "status.json"
    atomic(state, (json.dumps({"phase": "idle", "maintenance": False, "checks": [],
        "current": {"revision": revision, "version": revision[:12], "notesUrl": "https://github.com/NousResearch/hermes-agent/commit/" + revision},
        "message": "Check for a Hermes update when you're ready.", "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}) + "\n").encode())
    result = {"webBuild": c["webBuild"], "release": str(release), "hermesRevision": revision,
        "hermesVersionUnchanged": True, "repairPreserved": True, "profileSettingsPreserved": True,
        "originalGoogleHttpAndFreshWebsocket": True, "gatewayGuardVerified": True, "bothDiscordConnected": True}
    (ops / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    journal("complete")
    print(json.dumps(result))
except BaseException:
    if release_started:
        journal("activated-needs-review")
        print("The new release reached admission release; services kept running for review. Do not stop them without fresh quiescence.")
        raise SystemExit(2)
    if commit_attempted and not committed:
        try:
            # Native commit is idempotent. Recover a lost reply before deciding
            # whether the original dashboard can be restarted safely.
            google()
            verdict = retire("commit", permit["token"])
            if verdict.get("ok") is not True:
                # An expired permit may have admitted new work. Fence it again;
                # a failed fresh idle proof cannot authorize a restart.
                permit = retire("prepare")
                assert permit.get("ok") is True and permit.get("idle") is True
                assert retire("commit", permit["token"]).get("ok") is True
            committed = True
        except BaseException:
            journal("retirement-needs-review")
            print("Retirement admission could not be proved; original native owners preserved for review.")
            raise SystemExit(2)
    # Recover the old deployment before opening native ingress. Keep rotating
    # grants and the live application database; never replay stale credentials.
    journal("rollback")
    system("stop", "agent-interface.service")
    if changed:
        system("stop", "hermes-dashboard.service", "hermes-gateway.service")
        switch(old_release)
        gateway_dropin.unlink(missing_ok=True); gateway_link.unlink(missing_ok=True)
        for filename, data in saved.items(): atomic(Path(filename), data)
        system("daemon-reload")
    if lease.exists() and json.loads(lease.read_text()).get("operationId") == operation: lease.unlink()
    recovery_admission_open = pid("hermes-gateway.service") != "0" or pid("hermes-dashboard.service") != "0"
    try:
        # The former gateway cannot honor persistent maintenance. Keep it stopped
        # while recovering and verifying the original dashboard and application.
        if committed or changed:
            if not changed and pid("hermes-gateway.service") != "0":
                requested = json.loads(native("import json; from gateway.drain_control import write_drain_request; print(json.dumps(write_drain_request(principal=" + repr(operation) + ",suppress_notification=True)))"))
                requested_at = datetime.datetime.fromisoformat(requested["requested_at"])
                wait(drained, 20)
                assert drained()
            system("stop", "hermes-gateway.service")
            recovery_admission_open = True
            system("restart", "hermes-dashboard.service")
        wait(lambda: get_status().get("auth_providers") == ["google-family"])
        google()
        if drain.exists() and json.loads(drain.read_text()).get("principal") == operation:
            if pid("hermes-gateway.service") != "0": recovery_admission_open = True
            native("from gateway.drain_control import clear_drain_request; assert clear_drain_request()")
        system("start", "agent-interface.service")
        wait(app_ready)
        recovery_admission_open = True
        system("start", "hermes-gateway.service")
        def recovered_gateway():
            record = gateway_state()
            return (record.get("pid") == int(pid("hermes-gateway.service")) and record.get("gateway_state") == "running"
                and record.get("code_sha") == revision and record.get("hermes_home") == str(home)
                and all(record.get("platforms", {}).get(key, {}).get("state") == "connected" for key in c["discordConnections"]))
        wait(recovered_gateway)
        journal("rollback-verified")
    except BaseException:
        if not recovery_admission_open:
            system("stop", "agent-interface.service", "hermes-dashboard.service", "hermes-gateway.service")
        journal("rollback-needs-review")
        print("Release recovery needs review. Native owners that may have admitted work were preserved; private recovery copies retained.")
        raise SystemExit(2)
    print("Release activation failed; previous release restored and original sign-in verified.")
    raise SystemExit(1)
finally:
    if claim: claim.__exit__(None, None, None)
    log.close()
