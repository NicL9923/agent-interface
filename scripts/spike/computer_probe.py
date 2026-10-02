"""Exercise the shared coordinator against real native tool dispatch and leases.

This probe requires a marked disposable Hermes home. Desktop start is replaced
inside this probe process only: package installation and real GUI streaming have
their separate host acceptance checks. No live profile or executor is touched.
"""
import importlib.util
import asyncio
import json
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace

home = Path(os.environ.get("HERMES_HOME", ""))
if (not home.is_absolute() or (home / ".agent-interface-isolated").read_text() != "agent-interface-disposable-spike"):
    raise SystemExit("Shared computer probe requires a marked disposable Hermes home")
root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("computer_probe_addon", root / "src/hermes/computer.py")
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
resource = home / "runtime" / "computer-probe"
resource.mkdir(parents=True, mode=0o700, exist_ok=True)
os.environ["HERMES_AGENT_INTERFACE_COMPUTER_HOME"] = str(resource)
os.environ["HERMES_AGENT_INTERFACE_COMPUTER_CDP_URL"] = "http://127.0.0.1:9222"
os.environ["HERMES_AGENT_INTERFACE_TOKEN"] = "disposable-computer-probe-service-key"

from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
from tools.bot_desktop import runtime, lease
from tools.registry import registry
from hermes_cli.dashboard_auth.ws_tickets import consume_ticket, TicketInvalid
from tools import browser_tool_session as browser_session
from tools import browser_use_cli
from tui_gateway import server
import hermes_cli

checks = {}
addon.install(server)
computer = registry._agent_interface_computer
starts = []
runtime.start = lambda: starts.append(str(get_hermes_home()))
# Keep actual native lease and registry execution. Only desktop hardware liveness
# is a fixture; no X server/browser is started on the qualification host.
runtime.status = lambda: type("Status", (), {"supported": True, "installed": True, "running": True})()
computer._browser_ready = lambda: True

def routed(args, **kwargs):
    return json.dumps({"profileHome": str(get_hermes_home()), "screenState": str(runtime.state_dir())})
registry.register(name="browser_computer_probe", toolset="browser", handler=routed,
    schema={"name": "browser_computer_probe", "description": "Disposable profile routing probe", "parameters": {"type": "object", "properties": {}}})

for profile in ("one", "two"):
    profile_home = home / "runtime" / ("computer-bot-" + profile)
    profile_home.mkdir(mode=0o700, exist_ok=True)
    token = set_hermes_home_override(str(profile_home))
    try:
        result = json.loads(registry.dispatch("browser_computer_probe", {}, task_id=profile))
        assert result == {"profileHome": str(profile_home), "screenState": str(resource / "bot-desktop")}
        assert get_hermes_home() == profile_home
    finally:
        reset_hermes_home_override(token)
assert get_hermes_home() == home
assert starts == [str(resource), str(resource)]
checks["native_dispatch_preserves_two_bot_home_identities_and_one_screen"] = True

# Exercise the default native browser_exec handler, including its native env
# builder and own-tab preamble. Only the CLI's process result is synthetic.
executions = []
def cli_result(command, code, env, timeout):
    executions.append({"env": dict(env), "code": code})
    return subprocess.CompletedProcess(command, 0, "shared computer fixture\n", "")
computer._run_harness_cli = cli_result
browser_use_cli._attach_vault_supervisor = lambda env, task_id: None
assert registry.get_entry("browser_exec").check_fn(), "Default browser_exec must remain available"
for profile in ("one", "two", "one"):
    token = set_hermes_home_override(str(home / "runtime" / ("computer-bot-" + profile)))
    try:
        result = json.loads(registry.dispatch("browser_exec", {"code": "print('shared computer fixture')"}, task_id="probe-" + profile))
        assert result.get("success") is True, result
    finally:
        reset_hermes_home_override(token)
assert executions[0]["env"]["BU_NAME"] != executions[1]["env"]["BU_NAME"]
assert executions[0]["env"]["BU_NAME"] == executions[2]["env"]["BU_NAME"]
for execution in executions:
    assert execution["env"].get("BU_CDP_URL") == computer.endpoint
    assert execution["env"].get("BU_AUTOSPAWN") == "0"
    assert "_computer_current" in execution["code"]
    assert "pin this named session to its own tab" not in execution["code"]
    assert execution["env"]["BH_RUNTIME_DIR"].startswith("/tmp/agentui-computer-")
assert len({execution["env"]["BH_RUNTIME_DIR"] for execution in executions}) == 1
checks["default_native_browser_exec_preserves_tool_availability_and_pins_per_task_tabs"] = True

# Ordinary user-code errors do not leave an input fence: the CLI and its daemon
# have completed the request. A CLI timeout can leave daemon recovery running.
computer._run_harness_cli = lambda command, code, env, timeout: subprocess.CompletedProcess(command, 1, "", "SyntaxError: invalid syntax")
result = json.loads(registry.dispatch("browser_exec", {"code": "invalid syntax!"}, task_id="syntax-probe"))
assert result.get("success") is False, result
assert not (computer.state / "computer-recovery.json").exists()
computer._run_harness_cli = cli_result
checks["ordinary_browser_code_errors_do_not_leave_a_recovery_fence"] = True

def rpc(params):
    result = server.handle_request({"jsonrpc": "2.0", "id": 81, "method": "agent-interface.computer",
        "params": {"service_key": os.environ["HERMES_AGENT_INTERFACE_TOKEN"], **params}})
    assert "error" not in result, result
    return result["result"]

one = {"actorId": "member-one", "actorName": "Member one"}
two = {"actorId": "member-two", "actorName": "Member two"}
first = rpc({**one, "action": "observe"})
second = rpc({**two, "action": "observe"})
info = consume_ticket(first["ticket"])
assert info["hermes_home"] == str(resource) and info["viewer_id"] == first["viewerId"]
try:
    consume_ticket(first["ticket"])
    raise AssertionError("Native display ticket was reused")
except TicketInvalid:
    pass
assert rpc({**one, "action": "observe"})["viewerId"] == first["viewerId"]
checks["native_single_use_display_ticket_and_reconnect_viewer_identity"] = True

rpc({**one, "action": "take", "viewerId": first["viewerId"]})
assert lease.get().holder == lease.HUMAN
assert lease.get(profile_key=str(resource)).viewer_id == first["viewerId"]
assert rpc({**one, "action": "status"})["control"]["mine"] is True
assert rpc({**two, "action": "status"})["control"]["mine"] is False
for tool in ("browser_snapshot", "browser_cdp", "computer_use"):
    result = json.loads(registry.dispatch(tool, {}))
    assert result.get("success") is False and "human" in result["error"].lower(), result
assert browser_session._shares_bot_desktop_browser({"features": {"cdp_override": True}})
checks["native_human_lease_fences_browser_cdp_and_computer_capture"] = True

for action in ("take", "release"):
    refused = server.handle_request({"jsonrpc": "2.0", "id": 82, "method": "agent-interface.computer",
        "params": {"service_key": os.environ["HERMES_AGENT_INTERFACE_TOKEN"], **two, "action": action, "viewerId": second["viewerId"]}})
    assert "error" in refused
assert lease.get().viewer_id == first["viewerId"]
rpc({**one, "action": "release", "viewerId": first["viewerId"]})
assert lease.get().holder == lease.AGENT
checks["native_owner_cannot_be_stolen_or_released_by_another_member"] = True

assert browser_session._run_browser_command("fixture", "close", []) == {"success": True, "data": {}}
refused = json.loads(registry.dispatch("browser_cdp", {"method": "Browser.close"}))
assert refused.get("success") is False and "persistent" in refused["error"]
checks["native_task_cleanup_cannot_close_supervised_browser"] = True

recover = computer.recover_harness
computer.recover_harness = lambda record: False
def timed_out(command, code, env, timeout):
    raise subprocess.TimeoutExpired(command, timeout)
computer._run_harness_cli = timed_out
result = json.loads(registry.dispatch("browser_exec", {"code": "print('timed out fixture')"}, task_id="timeout-probe"))
assert result.get("success") is not True and "timed out" in result.get("error", ""), result
pending = computer._read("computer-recovery.json", None)
assert pending is not None
assert set(pending["environment"]).issubset({"HOME", "PYTHONPATH", "BU_NAME", "BH_HOME", "BH_CONFIG_DIR", "BH_RUNTIME_DIR", "BH_RUNTIME_DIR_SHARED", "BH_TMP_DIR", "BH_TMP_DIR_SHARED"})
assert "HERMES_AGENT_INTERFACE_TOKEN" not in pending["environment"]
status = rpc({**one, "action": "status"})
assert status["available"] and not status["browserReady"] and "recovery" in status["reason"]
refused = server.handle_request({"jsonrpc": "2.0", "id": 83, "method": "agent-interface.computer",
    "params": {"service_key": os.environ["HERMES_AGENT_INTERFACE_TOKEN"], **one, "action": "take", "viewerId": first["viewerId"]}})
assert "error" in refused and "recovery" in refused["error"]["message"], refused
for tool in ("browser_snapshot", "browser_cdp", "computer_use"):
    result = json.loads(registry.dispatch(tool, {}))
    assert result.get("success") is False and "recovery" in result["error"], result
from tools.browser_supervisor_dialogs import DialogSupervisionMixin
async def watchdog_fence():
    supervisor = SimpleNamespace(_dialog_watchdogs={})
    await DialogSupervisionMixin._dialog_timeout_expired(supervisor, "fixture-dialog")
    handle = supervisor._dialog_watchdogs["fixture-dialog"]
    handle.cancel()
asyncio.run(watchdog_fence())
checks["failed_timeout_recovery_fences_human_bot_and_background_dialog_input"] = True

# Execute the qualified native daemon-identity/termination helper itself. This
# mock CLI created no daemon, so the real helper must prove that namespace idle.
computer.recover_harness = recover
assert computer.recover_harness(pending), "The native recovery helper did not verify an idle named namespace"
assert not (computer.state / "computer-recovery.json").exists()
rpc({**one, "action": "take", "viewerId": first["viewerId"]})
rpc({**one, "action": "release", "viewerId": first["viewerId"]})
checks["qualified_native_harness_recovery_reopens_control_after_verified_termination"] = True

revision = subprocess.check_output(["git", "-C", str(Path(hermes_cli.__file__).resolve().parents[1]), "rev-parse", "HEAD"], text=True).strip()
result = {"revision": revision, "checks": checks, "desktopHardware": "fixture; real display and browser acceptance is separate"}
output = Path(os.environ.get("HERMES_SPIKE_EVIDENCE_DIR", home / "evidence"))
output.mkdir(mode=0o700, exist_ok=True)
(output / "hermes-computer-probe.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
