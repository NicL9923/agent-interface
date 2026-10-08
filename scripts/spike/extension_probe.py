"""Real gateway durability/approval probe. Launcher owns the disposable executor PID."""
import argparse
import base64
import asyncio
import json
import os
import signal
import time
import urllib.request
from pathlib import Path
import websockets
from guard import verify_target


class Client:
    def __init__(self):
        self.counter = 0
        self.pending = {}
        self.frames = []

    async def connect(self):
        self.ws = await websockets.connect(os.environ["HERMES_SPIKE_URL"].replace("http", "ws", 1) + "/api/ws?token=" + os.environ["HERMES_SPIKE_TOKEN"])
        self.reader = asyncio.create_task(self.read())
        await self.call("client.capabilities", server_requests=True)
        return self

    async def read(self):
        try:
            async for raw in self.ws:
                frame = json.loads(raw)
                self.frames.append(frame)
                future = self.pending.pop(frame.get("id"), None)
                if future and not future.done():
                    future.set_result(frame)
        except websockets.ConnectionClosed:
            pass

    async def call(self, method, **params):
        self.counter += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.counter] = future
        await self.ws.send(json.dumps({"jsonrpc": "2.0", "id": self.counter, "method": method, "params": params}))
        result = await asyncio.wait_for(future, 45)
        if "error" in result:
            raise RuntimeError(json.dumps(result["error"]))
        return result.get("result", {})

    async def close(self):
        await self.ws.close()
        await self.reader


async def settled(client, profile="spike"):
    for _ in range(100):
        value = await client.call("agent-interface.open", profile=profile)
        if not value.get("app_run_id") and not value.get("info", {}).get("running") and not value.get("inflight", {}).get("streaming"):
            return value
        await asyncio.sleep(0.1)
    raise AssertionError("Hermes did not settle")


async def request(client, method):
    for _ in range(100):
        snapshot = await client.call("agent-interface.open", profile="spike")
        matches = [x for x in snapshot.get("open_requests", []) if x.get("method") == method]
        if matches:
            return matches[0]
        await asyncio.sleep(0.1)
    raise AssertionError("No native " + method + " request was emitted")


async def main(args):
    home = Path(os.environ.get("HERMES_HOME", ""))
    if not home.is_absolute() or (home / ".agent-interface-isolated").read_text() != "agent-interface-disposable-spike" or not os.environ.get("HERMES_SPIKE_URL", "").startswith("http://127.0.0.1:"):
        raise SystemExit("Only the launcher's disposable isolated gateway may be mutated.")
    verify_target(home, os.environ["HERMES_SPIKE_URL"], os.environ["HERMES_SPIKE_TOKEN"])
    destination = Path(os.environ.get("HERMES_SPIKE_EVIDENCE_DIR", "docs/evidence")) / "hermes-extension-probe.json"
    c = await Client().connect()
    caps = await c.call("agent-interface.capabilities")
    def provider_count():
        path = Path(os.environ.get("HERMES_SPIKE_PROVIDER_LOG", "/nonexistent"))
        return sum(bool(json.loads(line).get("messages")) for line in path.read_text().splitlines()) if path.exists() else 0
    if args.verify_restart:
        evidence = json.loads(destination.read_text())
        stored = json.loads((home / "extension-probe-checkpoint.json").read_text())
        receipt = (await c.call("agent-interface.receipt", request_id=stored["request_id"]))["receipt"]
        assert receipt["status"] == "interrupted", receipt
        assert receipt["runId"] == stored["request_id"]
        assert caps["executor_epoch"] != stored["epoch"]
        discovery = await c.call("agent-interface.discover", cursor=stored["cursor"])
        assert any(e["kind"] == "interrupted" and e["runId"] == stored["request_id"] for e in discovery["events"])
        snapshot = await c.call("agent-interface.open", profile="spike")
        assert snapshot.get("app_interruption", {}).get("runId") == stored["request_id"]
        await asyncio.sleep(5)
        snapshot = await c.call("agent-interface.open", profile="spike")
        assert not snapshot.get("info", {}).get("running") and not snapshot.get("inflight", {}).get("streaming")
        assert provider_count() == stored["provider_count"], "Native automatically resumed provider execution"
        assert sum(x.get("text") == "PROBE_SLOW executor kill" for x in snapshot["messages"]) == 1, "Executor restart replayed or lost admission"
        evidence["checks"]["executor_restart"] = {"receipt_status": receipt["status"], "epoch_changed": True, "durable_interrupted_event": True, "automatic_replay": False}
        destination.write_text(json.dumps(evidence, indent=2) + "\n")
        print("Executor interruption and no-replay recovery passed")
        await c.close(); return
    evidence = {"revision": caps["revision"], "provider": "deterministic wire fixture; real Hermes execution", "checks": {}}
    image_capability = await c.call("image.generate", probe=True)
    assert not image_capability.get("available"), "Spike must not use a real configured image backend"
    try:
        generation = await c.call("image.generate", prompt="Synthetic isolated portrait capability probe", aspect_ratio="1:1", max_bytes=2000000)
        assert generation.get("success") is False or generation.get("error"), generation
    except RuntimeError:
        pass
    evidence["checks"]["image_backend_unavailable"] = {"native_capability_probe": True, "native_generation_request_refused": True, "real_image_backend_validated": False}
    snapshot = await c.call("agent-interface.open", profile="spike")
    sid = snapshot["session_id"]
    saved = snapshot["canonical_stored_session_id"]
    private_key = os.environ["HERMES_AGENT_INTERFACE_TOKEN"]
    try:
        await c.call("agent-interface.maintenance", action="acquire", operation_id="spike-maintenance", service_key="invalid")
        raise AssertionError("A browser identity must not acquire host maintenance")
    except RuntimeError:
        pass
    acquired = await c.call("agent-interface.maintenance", action="acquire", operation_id="spike-maintenance", service_key=private_key)
    assert acquired["active"] and acquired["busy"] == []
    other = await Client().connect()
    before_maintenance = provider_count()
    for client in (c, other):
        try:
            await client.call("prompt.submit", session_id=sid, profile="spike", text="No model execution during maintenance")
            raise AssertionError("Native work started behind the maintenance fence")
        except RuntimeError:
            pass
    # These native RPCs use the asynchronous pool and bypass handle_request.
    # Check both work and configuration admission, then prove no profile exists.
    for method, params in (
        ("shell.exec", {"session_id": sid, "profile": "spike", "command": "printf maintenance-bypass"}),
        ("profiles.create", {"name": "maintenance-must-not-create"}),
    ):
        try:
            await other.call(method, **params)
            raise AssertionError("Native pool work crossed the maintenance fence")
        except RuntimeError as error:
            assert "being upgraded" in str(error), str(error)
    roster = await c.call("profiles.list")
    assert not any(profile.get("name") == "maintenance-must-not-create" for profile in roster["profiles"])
    assert provider_count() == before_maintenance
    released = await c.call("agent-interface.maintenance", action="release", operation_id="spike-maintenance", service_key=private_key)
    assert not released["active"]
    await other.close()
    evidence["checks"]["private_maintenance_fence"] = {"browser_identity_refused": True, "two_native_clients_fenced": True, "native_pool_work_fenced": True, "no_model_execution": True, "same_owner_release": True}
    await c.call("config.set", key="approvals.mode", value="manual", profile="spike")
    async def send(request_id, text, actor="synthetic-person-a", steer=False):
        return await c.call("agent-interface.submit", profile="spike", session_id=sid, request_id=request_id, sender_id=actor, text=text, steer=steer, attachments=[])
    first_id = "spike-first-" + str(time.time_ns())
    first = await send(first_id, "PROBE_TOOL first")
    duplicate = await send(first_id, "PROBE_TOOL first")
    assert first == duplicate and first["status"] == "accepted"
    snapshot = await settled(c)
    assert sum(x.get("app_request_id") == first_id for x in snapshot["messages"]) == 1
    assert snapshot["canonical_stored_session_id"] == saved
    detailed_tool = next(x for x in snapshot["messages"] if x.get("role") == "tool" and x.get("app_tool_call"))
    assert detailed_tool["app_run_id"] == first["runId"]
    assert next(x for x in snapshot["messages"] if x.get("app_request_id") == first_id)["app_run_id"] == first["runId"]
    assert detailed_tool["app_tool_call"]["status"] == "completed"
    assert "printf" in detailed_tool["app_tool_call"]["arguments"]
    assert "hermes-real-tool-proof" in detailed_tool["app_tool_call"]["result"]
    evidence["checks"]["canonical_tool_details"] = {"actual_arguments": True, "actual_result": True, "stable_call_identity": True, "completion_state": True}
    evidence["checks"]["canonical_message_run_provenance"] = True
    evidence["checks"]["duplicate_admission"] = {"same_receipt": True, "canonical_user_rows": 1, "real_tool_output": any((x.get("app_tool_result") or {}).get("output") == "hermes-real-tool-proof" for x in snapshot["messages"])}
    second_id = "spike-second-" + str(time.time_ns())
    second = await send(second_id, "second task")
    assert second["runId"] != first["runId"]
    await settled(c)
    evidence["checks"]["sequential_task_identity"] = {"distinct_runs": True, "same_canonical_conversation": True}
    third_id = "spike-guided-" + str(time.time_ns())
    await send(third_id, "PROBE_SLOW_TOOL steering")
    steering_id = third_id + "-guidance"
    guidance = await send(steering_id, "Use the second person's public guidance", "synthetic-person-b", True)
    assert guidance["runId"] == third_id
    snapshot = await settled(c)
    correction = next(x for x in snapshot["messages"] if x.get("text") == "Use the second person's public guidance")
    assert correction.get("app_request_id") == steering_id and correction.get("app_sender_id") == "synthetic-person-b", correction
    evidence["checks"]["steering_attribution"] = {"shares_active_run": True, "canonical_correction_saved": True, "sender_survives_projection": True}
    approval_run = "spike-approval-" + str(time.time_ns())
    await send(approval_run, "PROBE_APPROVAL")
    pending = await request(c, "approval")
    await c.close()
    c = await Client().connect()
    replayed = await request(c, "approval")
    assert replayed["id"] == pending["id"]
    answer = await c.call("request.answer", id=replayed["id"], result={"choice": "once"})
    assert answer["status"] == "ok"
    expired = await c.call("request.answer", id=replayed["id"], result={"choice": "deny"})
    assert expired["status"] == "expired"
    snapshot = await settled(c)
    assert not snapshot.get("open_requests")
    evidence["checks"]["approval_reconnect"] = {"same_native_request": True, "second_client_approved": True, "stale_answer_refused": True}
    sid = snapshot["session_id"]
    await send("spike-clarify-" + str(time.time_ns()), "PROBE_CLARIFY")
    clarify = await request(c, "clarify")
    question = clarify["params"]["questions"][0]
    answer = await c.call("request.answer", id=clarify["id"], result={"answers": {question["qid"]: "Second"}})
    assert answer["status"] == "ok"
    await settled(c)
    evidence["checks"]["clarification"] = {"native_question": True, "answered_by_question_id": True}
    await send("spike-file-" + str(time.time_ns()), "PROBE_FILE")
    snapshot = await settled(c)
    tool = next(x for x in reversed(snapshot["messages"]) if (x.get("app_tool_result") or {}).get("output", "").startswith("MEDIA:"))
    path = tool["app_tool_result"]["output"][6:].strip()
    request_url = os.environ["HERMES_SPIKE_URL"] + "/api/files/download?path=" + urllib.parse.quote(path)
    data = urllib.request.urlopen(urllib.request.Request(request_url, headers={"X-Hermes-Session-Token": os.environ["HERMES_SPIKE_TOKEN"]})).read()
    assert data == b"synthetic-file-proof"
    evidence["checks"]["generated_file"] = {"created_by_real_terminal_tool": True, "authenticated_delivery_bytes": True}
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5N0AAAAASUVORK5CYII=")
    image = await c.call("file.attach", session_id=sid, profile="spike",name="native-image-only.png",data_url="data:image/png;base64,"+base64.b64encode(png).decode())
    descriptor = {"path":image["path"],"name":"native-image-only.png","mime":"image/png"}
    image_id = "spike-image-only-" + str(time.time_ns())
    accepted = await c.call("agent-interface.submit",profile="spike",session_id=sid,request_id=image_id,sender_id="synthetic-person-a",text="",attachments=[descriptor])
    assert accepted["status"] == "accepted"
    snapshot = await settled(c)
    image_row = next(x for x in snapshot["messages"] if x.get("app_request_id")==image_id)
    assert image_row["app_sender_id"] == "synthetic-person-a" and image_row["app_attachments"] == [descriptor] and image_row["app_display_text"] == ""
    evidence["checks"]["image_only_canonical_projection"]={"native_row_binding":True,"sender_attributed":True,"trusted_attachment_rendered":True,"trusted_display_empty":True}
    bad = await c.call("file.attach", session_id=sid, profile="spike",name="image-preparation-failure.txt",data_url="data:text/plain;base64,"+base64.b64encode(b"synthetic unsupported image extension").decode())
    failed_id = "spike-image-preparation-" + str(time.time_ns())
    rejected = await c.call("agent-interface.submit",profile="spike",session_id=sid,request_id=failed_id,sender_id="synthetic-person-a",text="No admission on preparation failure",attachments=[descriptor,{"path":bad["path"],"name":"image-preparation-failure.txt","mime":"image/png"}])
    assert rejected["status"] == "rejected", rejected
    pending = await c.call("image.detach",session_id=sid,profile="spike",path=image["path"])
    assert pending["count"]==0 and not pending["detached"], pending
    next_receipt=await send("spike-after-preparation-"+str(time.time_ns()),"Preparation rejection did not wedge this conversation")
    assert next_receipt["status"]=="accepted"
    await settled(c)
    evidence["checks"]["image_preparation_failure"]={"definite_rejected_receipt":True,"partially_staged_images_cleared":True,"next_native_admission_accepted":True}
    before = await c.call("agent-interface.discover", cursor="0")
    again = await c.call("agent-interface.discover", cursor=before["cursor"])
    assert not again["events"]
    completions = [x for x in before["events"] if x["kind"] == "completed"]
    # Notifications quote the reply, so a completed turn must carry its final text.
    assert completions and any(isinstance(x.get("body"), str) and x["body"].strip() for x in completions), completions
    evidence["checks"]["durable_discovery"] = {"completion_events": len(completions), "completion_bodies": sum(bool(x.get("body")) for x in completions), "approval_events": sum(x["kind"] == "approval" for x in before["events"]), "cursor_replay_duplicates": 0}
    interrupted_id = "spike-interrupted-" + str(time.time_ns())
    await send(interrupted_id, "PROBE_SLOW executor kill")
    try:
        await c.call("agent-interface.maintenance", action="acquire", operation_id="spike-active-maintenance", service_key=private_key)
        raise AssertionError("Maintenance must refuse active native execution")
    except RuntimeError:
        pass
    evidence["checks"]["active_work_upgrade_refused"] = True
    (home / "extension-probe-checkpoint.json").write_text(json.dumps({"request_id": interrupted_id, "epoch": caps["executor_epoch"], "cursor": before["cursor"], "provider_count": provider_count()}))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(evidence, indent=2) + "\n")
    os.kill(args.pid, signal.SIGKILL)
    await c.close()
    print("Real gateway durability, steering, approval, clarification, and file probes passed; executor deliberately killed")


if __name__ == "__main__":
    import urllib.parse
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int)
    parser.add_argument("--verify-restart", action="store_true")
    arguments = parser.parse_args()
    if not arguments.verify_restart and not arguments.pid:
        parser.error("--pid required for the isolated executor interruption probe")
    asyncio.run(main(arguments))
