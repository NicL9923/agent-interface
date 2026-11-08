"""Real native approval scopes, auto-review, clarify shapes and the steering decision.

Runs against the launcher's already running disposable add-on gateway. It creates its own
profile, never starts a gateway and never touches another profile's configuration.
Checks what WildBots relies on: the choices Hermes offers per approval request, what each
request.answer choice grants, where "always" persists, that the add-on's removal withdraws
both the saved pattern and its live session grant, that approvals.mode smart lets the
guardian decide and limits a guardian-denied request to once/deny, that clarify carries
multi_select and its (Recommended) first choice, and that the add-on returns its steering
admission decision in the receipt and on history rows.
"""
import asyncio
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from extension_probe import Client
from guard import verify_target

PROFILE = "approval-scope"
PATTERN = "recursive delete"


def automation(operation, **fields):
    data = dict(operation=operation, profile=PROFILE, visibleProfiles=[PROFILE], **fields)
    request = urllib.request.Request(os.environ["HERMES_SPIKE_URL"] + "/api/agent-interface/service/agent-interface/automation",
        method="POST", headers={"Authorization": "Bearer " + os.environ["HERMES_SPIKE_TOKEN"], "Content-Type": "application/json"},
        data=json.dumps(data).encode())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def saved_config():
    from hermes_cli.profiles import get_profile_dir
    import hermes_yaml as yaml
    return yaml.safe_load((Path(get_profile_dir(PROFILE)) / "config.yaml").read_text()) or {}


async def outcome(client, method="approval", seconds=20):
    """Waits until the turn either asks with `method` or settles. Returns ('ask', request) or ('settled', snapshot)."""
    for _ in range(seconds * 10):
        snapshot = await client.call("agent-interface.open", profile=PROFILE)
        asks = [x for x in snapshot.get("open_requests", []) if x.get("method") == method]
        if asks:
            return "ask", asks[0]
        if not snapshot.get("app_run_id") and not snapshot.get("info", {}).get("running") and not snapshot.get("inflight", {}).get("streaming"):
            return "settled", snapshot
        await asyncio.sleep(0.1)
    raise AssertionError("Hermes neither asked nor settled")


async def main():
    home = Path(os.environ.get("HERMES_HOME", ""))
    if not home.is_absolute() or (home / ".agent-interface-isolated").read_text() != "agent-interface-disposable-spike" or not os.environ.get("HERMES_SPIKE_URL", "").startswith("http://127.0.0.1:"):
        raise SystemExit("Only the launcher's disposable isolated gateway may be mutated.")
    verify_target(home, os.environ["HERMES_SPIKE_URL"], os.environ["HERMES_SPIKE_TOKEN"])
    destination = Path(os.environ.get("HERMES_SPIKE_EVIDENCE_DIR", "docs/evidence")) / "hermes-approval-scope-probe.json"
    c = await Client().connect()
    caps = await c.call("agent-interface.capabilities")
    assert caps.get("approval_settings") is True and caps.get("steering_decision") is True, caps
    evidence = {"revision": caps["revision"], "provider": "deterministic wire fixture; real Hermes approval and clarify execution", "checks": {}}
    checks = evidence["checks"]
    await c.call("profiles.create", name=PROFILE, no_alias=True)
    sid = (await c.call("agent-interface.open", profile=PROFILE, omit_messages=True))["session_id"]

    async def send(text, steer=False):
        request_id = "approval-scope-" + str(time.time_ns())
        receipt = await c.call("agent-interface.submit", profile=PROFILE, session_id=sid, request_id=request_id,
                               sender_id="synthetic-person-a", text=text, steer=steer, attachments=[])
        assert receipt["status"] == "accepted", receipt
        return request_id, receipt

    async def answer(request, choice):
        result = await c.call("request.answer", id=request["id"], result={"choice": choice})
        assert result["status"] == "ok", result
        kind, snapshot = await outcome(c)
        assert kind == "settled", ("asked again after " + choice, snapshot)
        return snapshot

    async def asks(text):
        await send(text)
        kind, request = await outcome(c)
        assert kind == "ask", "Hermes ran the command without asking"
        return request

    async def runs_without_asking(text):
        await send(text)
        kind, snapshot = await outcome(c)
        assert kind == "settled", ("Hermes asked although a grant covers it", snapshot)
        return snapshot

    status, settings = automation("approval_mode", mode="manual")
    assert status == 200 and settings == {"ok": True, "allowlist": [], "mode": "manual"}, (status, settings)

    # Per-request choices: an ordinary dangerous command offers every scope, keyed by its pattern.
    request = await asks("PROBE_APPROVAL scope")
    params = request["params"]
    assert params["choices"] == ["once", "session", "always", "deny"], params
    assert PATTERN in params["pattern_keys"] and params["pattern_key"] == PATTERN, params
    assert params.get("allow_session") is True and params.get("allow_permanent") is True, params
    checks["offered_choices"] = {"choices": params["choices"], "pattern_keys": params["pattern_keys"], "command_shown": "command" in params}

    # session: no saved pattern, but the same session runs the pattern again without asking.
    await answer(request, "session")
    assert PATTERN not in (saved_config().get("command_allowlist") or [])
    await runs_without_asking("PROBE_APPROVAL again in this session")
    checks["session_choice"] = {"granted_for_session": True, "saved_to_config": False}

    # The add-on's removal withdraws a session grant even when nothing is saved.
    status, settings = automation("approval_allowlist_remove", pattern=PATTERN)
    assert status == 200 and settings["allowlist"] == [], (status, settings)
    request = await asks("PROBE_APPROVAL after withdrawing the session grant")
    checks["session_grant_withdrawn"] = True

    # always: saved to this profile's command_allowlist and listed by the add-on.
    await answer(request, "always")
    assert PATTERN in saved_config()["command_allowlist"], saved_config()
    status, settings = automation("approval_settings")
    assert status == 200 and settings["allowlist"] == [PATTERN], settings
    await runs_without_asking("PROBE_APPROVAL with the pattern always allowed")
    checks["always_choice"] = {"saved_to_profile_command_allowlist": True, "listed_by_add_on": True}

    # Removal edits the config and withdraws the live session grant that "always" also made.
    status, settings = automation("approval_allowlist_remove", pattern=PATTERN)
    assert status == 200 and settings["allowlist"] == [], (status, settings)
    assert PATTERN not in (saved_config().get("command_allowlist") or [])
    request = await asks("PROBE_APPROVAL after removing the always grant")
    checks["always_removed"] = {"config_entry_removed": True, "live_session_grant_removed": True, "asks_again_at_once": True}

    # deny: the command does not run and the tool result says so.
    snapshot = await answer(request, "deny")
    tool = next(x for x in reversed(snapshot["messages"]) if x.get("role") == "tool")
    assert "BLOCKED" in json.dumps(tool.get("app_tool_result", tool.get("content"))), tool
    checks["deny_choice"] = {"command_blocked": True}

    status, refused = automation("approval_allowlist_remove", pattern="")
    assert status == 400 and "pattern" in refused["error"], (status, refused)
    status, refused = automation("approval_mode", mode="off")
    assert status == 400 and "manual or smart" in refused["error"], (status, refused)
    checks["add_on_refusals"] = {"blank_pattern": True, "approvals_off": True}

    # approvals.mode smart: the guardian approves a safe command with no ask, and a command it
    # denies asks the person with only once/deny. "always" sent anyway is not persisted.
    status, settings = automation("approval_mode", mode="smart")
    assert status == 200 and settings["mode"] == "smart" and saved_config()["approvals"]["mode"] == "smart", settings
    await runs_without_asking("PROBE_APPROVAL_SMART_SAFE")
    request = await asks("PROBE_APPROVAL_SMART_DENY")
    assert request["params"]["choices"] == ["once", "deny"] and request["params"].get("smart_denied") is True, request["params"]
    await answer(request, "always")
    assert (saved_config().get("command_allowlist") or []) == []
    request = await asks("PROBE_APPROVAL_SMART_DENY again")
    await answer(request, "deny")
    status, settings = automation("approval_mode", mode="manual")
    assert status == 200 and settings["mode"] == "manual"
    checks["smart_mode"] = {"guardian_approved_without_asking": True, "guardian_denied_offers": ["once", "deny"],
                            "unoffered_always_not_persisted": True, "unoffered_always_still_ran_once": True}

    # Clarify: native multi_select and the (Recommended) mark on the first of several choices.
    await send("PROBE_CLARIFY_MULTI")
    kind, clarify = await outcome(c, "clarify")
    assert kind == "ask"
    first, second = clarify["params"]["questions"]
    assert first["multi_select"] is True and first["choices"][0] == "Feed (Recommended)", first
    assert second["multi_select"] is False and second["choices"] == ["North (Recommended)", "South"], second
    # A multi-select answer is a JSON array; a picked recommended label comes back bare.
    result = await c.call("request.answer", id=clarify["id"], result={"answers": {first["qid"]: json.dumps(["Water", "Fence"]), second["qid"]: "North (Recommended)"}})
    assert result["status"] == "ok", result
    kind, snapshot = await outcome(c, "clarify")
    assert kind == "settled"
    tool = next(x for x in reversed(snapshot["messages"]) if x.get("role") == "tool")
    result = tool.get("app_tool_result", tool.get("content", tool.get("text")))
    responses = (json.loads(result) if isinstance(result, str) else result)["responses"]
    assert [x["user_response"] for x in responses] == [["Water", "Fence"], "North"], responses
    checks["clarify_shapes"] = {"multi_select_on_wire": True, "first_of_several_marked_recommended": True,
                                "json_array_answer": True, "recommended_suffix_stripped": True}

    # Steering: the add-on returns its admission decision and marks the history row.
    idle_id, idle = await send("PROBE_TOOL before steering")
    assert idle["steering"] is False, idle
    await outcome(c)
    root_id, _ = await send("PROBE_SLOW_TOOL steering")
    steer_id, steered = await send("Steer the synthetic task", steer=True)
    assert steered["steering"] is True and steered["runId"] == root_id, steered
    receipt = (await c.call("agent-interface.receipt", request_id=steer_id))["receipt"]
    assert receipt["steering"] is True, receipt
    kind, snapshot = await outcome(c)
    assert kind == "settled"
    rows = {x.get("app_request_id"): x for x in snapshot["messages"] if x.get("app_request_id")}
    assert rows[steer_id].get("app_steering") is True, rows[steer_id]
    assert "app_steering" not in rows[idle_id] and "app_steering" not in rows[root_id]
    checks["steering_decision"] = {"admission_response": True, "receipt_lookup": True, "history_row": True, "idle_send_unmarked": True}

    await c.close()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(evidence, indent=2) + "\n")
    print("Approval scopes, auto-review, clarify shapes and steering decision passed against real Hermes")


if __name__ == "__main__":
    asyncio.run(main())
