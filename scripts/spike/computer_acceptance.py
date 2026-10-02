"""Real native browser acceptance against an explicitly selected idle computer.

Conversational identity stays in a marked disposable home. The caller must
authorize the resource and endpoint; this probe creates and closes its own tabs.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import urllib.request

home = Path(os.environ.get("HERMES_HOME", ""))
if not home.is_absolute() or (home / ".agent-interface-isolated").read_text() != "agent-interface-disposable-spike":
    raise SystemExit("Browser acceptance requires a marked disposable conversational home")
resource = os.environ["HERMES_COMPUTER_ACCEPTANCE_HOME"]
endpoint = os.environ["HERMES_COMPUTER_ACCEPTANCE_CDP_URL"]
os.environ.update(HERMES_AGENT_INTERFACE_COMPUTER_HOME=resource,
    HERMES_AGENT_INTERFACE_COMPUTER_CDP_URL=endpoint,
    HERMES_AGENT_INTERFACE_TOKEN="disposable-computer-acceptance-key")
root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("computer_acceptance_addon", root / "src/hermes/computer.py")
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
computer = addon.install_tools()
from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
from tools.registry import registry
import hermes_cli

if computer._lease().holder == computer.lease.HUMAN:
    raise SystemExit("Real acceptance requires an idle computer")
with computer.operation():
    pending = computer._read("computer-recovery.json", None)
    if pending is not None and not computer.recover_harness(pending):
        raise SystemExit("Real acceptance could not recover the existing interrupted action")
assert computer.status()["running"] and computer.status()["browserReady"], "The selected real desktop/browser is unavailable"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def targets():
    with opener.open(endpoint + "/json/list", timeout=2) as response:
        return {item["id"] for item in json.load(response)}

checks = {}
baseline = targets()
prefix = "acceptance-" + secrets.token_hex(6)
executions = {}
native_cli = computer._run_harness_cli
def observed_cli(command, code, env, timeout):
    record = executions.setdefault(env["BU_NAME"], {"python": command[0], "endpoint": endpoint, "targets": [],
        "environment": {key: env[key] for key in ("HOME", "PYTHONPATH", "BU_NAME", "BH_HOME", "BH_CONFIG_DIR", "BH_RUNTIME_DIR", "BH_RUNTIME_DIR_SHARED", "BH_TMP_DIR", "BH_TMP_DIR_SHARED") if key in env}})
    try:
        return native_cli(command, code, env, timeout)
    finally:
        pending = computer._read("computer-recovery.json", None)
        if pending is not None:
            record["targets"] = list(set(record["targets"]) | set(pending.get("targets", [])))
computer._run_harness_cli = observed_cli
def call(profile, code, timeout=30):
    bot_home = home / "runtime" / (prefix + profile)
    bot_home.mkdir(mode=0o700, parents=True, exist_ok=True)
    token = set_hermes_home_override(str(bot_home))
    try:
        result = json.loads(registry.dispatch("browser_exec", {"code": code, "timeout_s": timeout}, task_id=prefix + profile))
        assert get_hermes_home() == bot_home
        return result
    finally:
        reset_hermes_home_override(token)

owned = set()
member = {"actorId": "agent-interface-native-qualification", "actorName": "Native qualification",
    "service_key": os.environ["HERMES_AGENT_INTERFACE_TOKEN"]}
viewer = None
try:
    assert registry.get_entry("browser_exec").check_fn()
    current = {}
    for profile in ("one", "two", "one"):
        result = call(profile, "import json\nprint(json.dumps(current_tab()))")
        assert result.get("success"), result
        tab = json.loads(result["output"].strip())["targetId"]
        owned.add(tab)
        if profile in current:
            assert tab == current[profile]
        current[profile] = tab
    assert current["one"] != current["two"] and not (owned & baseline)
    checks["actual_native_browser_exec_shares_browser_with_separate_persistent_bot_tabs"] = True

    attachment = computer.request({**member, "action": "observe"})
    viewer = attachment["viewerId"]
    computer.request({**member, "action": "take", "viewerId": viewer})
    result = call("one", "print(current_tab())")
    assert not result.get("success") and "human" in result.get("error", "").lower(), result
    computer.request({**member, "action": "release", "viewerId": viewer})
    checks["actual_native_human_lease_blocks_default_browser_exec"] = True

    # A wrapped/caught helper timeout must still trigger recovery. The second
    # target exercises routine new_tab ownership beyond the original task tab.
    result = call("one", """new_tab('about:blank')
try:
    cdp('Runtime.evaluate', expression="new Promise(resolve => setTimeout(() => {document.title='late mutation'; resolve(true)}, 20000))", awaitPromise=True)
except Exception:
    print('caught asynchronous browser timeout')
""")
    assert result.get("success"), result
    assert not (computer.state / "computer-recovery.json").exists(), "The real timeout could not recover safely"
    after = targets()
    assert current["one"] not in after and current["two"] in after and baseline <= after
    assert after == baseline | {current["two"]}, "Recovery left an unowned task tab or closed another session"
    assert computer._browser_ready(), "Recovering a task must preserve the shared Chrome process"
    checks["actual_ipc_timeout_closes_original_and_switched_targets_and_preserves_other_sessions"] = True

    result = call("one", "import json\nprint(json.dumps(current_tab()))")
    assert result.get("success"), result
    replacement = json.loads(result["output"].strip())["targetId"]
    assert replacement != current["one"]
    owned.add(replacement)
    computer.request({**member, "action": "take", "viewerId": viewer})
    computer.request({**member, "action": "release", "viewerId": viewer})
    checks["actual_timeout_recovery_reopens_bot_and_human_control"] = True
finally:
    if viewer and computer._lease().viewer_id == viewer:
        computer.request({**member, "action": "release", "viewerId": viewer})
    # Failures retain a recovery fence. Never erase an uncertain operation to
    # make the acceptance run look clean.
    with computer.operation():
        pending = computer._read("computer-recovery.json", None)
        if pending is not None and not computer.recover_harness(pending):
            raise RuntimeError("Acceptance retained the interrupted task's recovery fence")
        for record in executions.values():
            computer._write("computer-recovery.json", record)
            if not computer.recover_harness(record):
                raise RuntimeError("Acceptance cleanup could not prove its task daemons and targets stopped")
assert targets() == baseline
revision = subprocess.check_output(["git", "-C", str(Path(hermes_cli.__file__).resolve().parents[1]), "rev-parse", "HEAD"], text=True).strip()
result = {"revision": revision, "checks": checks, "desktopHardware": "real supervised native desktop and fixed-CDP Chrome"}
output = home / "evidence"
output.mkdir(mode=0o700, exist_ok=True)
(output / "hermes-computer-acceptance.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
