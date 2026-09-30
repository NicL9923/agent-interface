"""Actual native admission and history probes inside a marked disposable home."""
import argparse
import asyncio
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types

from guard import MARKER, verify_home


def probe_tool_projection(server, checks):
    from agent.codex_runtime import make_codex_app_server_event_bridge
    from agent.transports.codex_event_projector import CodexEventProjector

    def opened():
        response = server.handle_request({"id": 101, "method": "agent-interface.open", "params": {"profile": "default"}})
        assert "error" not in response, response
        return response["result"]
    # This projection fixture never submits a model turn. Keep its unrelated
    # native prewarm timer from racing our controlled callbacks; the full suite
    # separately requires actual provider execution and native tool invocation.
    schedule_build = server._schedule_agent_build
    server._schedule_agent_build = lambda *_args, **_kwargs: None
    try: snapshot = opened()
    finally: server._schedule_agent_build = schedule_build
    sid = snapshot["session_id"]; session = server._sessions[sid]
    callbacks, flushes = [], []
    def completed(*args):
        callbacks.append(args)
        server._on_tool_complete(sid, *args)
    agent = types.SimpleNamespace(tool_start_callback=lambda *args: server._on_tool_start(sid, *args),
        tool_complete_callback=completed, _touch_activity=lambda *_args: None,
        _flush_messages_to_session_db=lambda messages: flushes.append(messages))
    bridge = make_codex_app_server_event_bridge(agent)
    item = {"type": "commandExecution", "id": "qualification-codex-call", "command": "qualification callback only",
            "cwd": str(Path(os.environ["HERMES_HOME"])), "aggregatedOutput": "Native Codex exposed result", "exitCode": 0}
    notification = {"method": "item/completed", "params": {"item": item}}
    session["running"] = True
    server._emit("message.start", sid)
    bridge({"method": "item/started", "params": {"item": item}}); bridge(notification)
    assert callbacks and not flushes, "Codex tool callback ordering changed; qualify its new durability seam"
    live = opened()
    assert any(call.get("status") == "completed" and call.get("result") == item["aggregatedOutput"]
               for call in live["app_tool_calls"]), "Completed Codex result vanished before native persistence"
    checks["native_codex_completion_visible_before_durable_flush"] = True
    # Commit the actual native Codex projection, then finish the native turn.
    with server._session_db(session) as db:
        assert db is not None
        for row in CodexEventProjector().project(notification).messages:
            db.append_message(session["session_key"], row["role"], row.get("content"), tool_calls=row.get("tool_calls"),
                              tool_call_id=row.get("tool_call_id"), tool_name=row.get("tool_name"))
        session["history"] = db.get_messages_as_conversation(session["session_key"], include_row_ids=True)
    session["running"] = False
    settled = opened()
    assert settled["app_tool_calls"] == [] and any(row.get("role") == "tool" and
        row.get("app_tool_result", {}).get("output") == item["aggregatedOutput"] for row in settled["messages"])
    checks["native_codex_durable_result_replaces_live_completion"] = True

    # The ordinary executor flushes before its completion callback. Verify the
    # real native result row suppresses that matching live card immediately.
    raw_id, args = "qualification-durable-call", {"command": "qualification callback only"}
    result = {"output": "Native durable tool output", "exit_code": 0}
    session["running"] = True; server._emit("message.start", sid)
    server._on_tool_start(sid, raw_id, "terminal", args)
    with server._session_db(session) as db:
        db.append_message(session["session_key"], "assistant", "", tool_calls=[{
            "id": raw_id, "type": "function", "function": {"name": "terminal", "arguments": json.dumps(args)}}])
        db.append_message(session["session_key"], "tool", json.dumps(result), tool_call_id=raw_id, tool_name="terminal")
        session["history"] = db.get_messages_as_conversation(session["session_key"], include_row_ids=True)
    server._on_tool_complete(sid, raw_id, "terminal", args, json.dumps(result))
    durable = opened()
    assert not durable["app_tool_calls"], "Native durable tool result was duplicated by a completed live card"
    assert any(row.get("tool_call_id") == raw_id and row.get("app_tool_result") == result for row in durable["messages"])
    checks["native_durable_completion_has_one_tool_card"] = True
    # Reuse the same call ID, arguments, and result in another native turn. The
    # previous durable row must not hide this new completion before its flush.
    server._emit("message.start", sid)
    server._on_tool_start(sid, raw_id, "terminal", args)
    server._on_tool_complete(sid, raw_id, "terminal", args, json.dumps(result))
    repeated = opened()
    assert len(repeated["app_tool_calls"]) == 1 and repeated["app_tool_calls"][0]["status"] == "completed", "An old reused call row hid a new completion"
    with server._session_db(session) as db:
        db.append_message(session["session_key"], "assistant", "", tool_calls=[{
            "id": raw_id, "type": "function", "function": {"name": "terminal", "arguments": json.dumps(args)}}])
        db.append_message(session["session_key"], "tool", json.dumps(result), tool_call_id=raw_id, tool_name="terminal")
        session["history"] = db.get_messages_as_conversation(session["session_key"], include_row_ids=True)
    assert opened()["app_tool_calls"] == [], "The new durable reused call did not replace its live card"
    checks["native_reused_old_call_cannot_hide_new_completion"] = True
    session["running"] = False
    # Close native DB owners before removing this disposable home.
    server._shutdown_sessions()
    from hermes_state_registry import close_all_under
    close_all_under(Path(os.environ["HERMES_HOME"]))


def probe_gateway(home, checks):
    import gateway.drain_control as drain
    import gateway.run_startup as startup
    import gateway.status as status
    import gateway.run_inbound as inbound
    spec = importlib.util.spec_from_file_location("qualification_gateway_guard", Path(__file__).resolve().parents[2] / "src/hermes/gateway_guard.py")
    guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
    lease = home / "gateway-maintenance.json"
    guard.install(drain, startup, status, lease, inbound)

    # Exercise the actual shared native inbound pipeline. Only the eventual
    # command body is harmless; production authorization and work stay untouched.
    class NativeIngress(inbound.GatewayInboundMixin):
        _external_drain_active = True
        called = False
        waiting = None
        entered = None
        async def _hm_admit_event(self, event):
            if self.waiting:
                self.entered.set(); await self.waiting.wait()
            return event, None, event.internal
        def _hm_estop_gate(self, *_args): return None
        def _session_key_for_source(self, *_args): return "qualification-guard"
        async def _hm_pending_reply_intercepts(self, *_args): return None
        def _hm_evict_idle_stale_agent(self, *_args): pass
        def _is_session_running(self, *_args): return False
        async def _hm_dispatch_idle_commands(self, *_args):
            self.called = True; return True, "harmless qualification command"

    async def scenario():
        lease.write_text("held")
        for internal in (True, False):
            native = NativeIngress()
            result = await native._handle_message(types.SimpleNamespace(internal=internal, get_command=lambda: None))
            assert not native.called and (result is None if internal else isinstance(result, str)), result
        assert status._get_code_identity_fields()["agent_interface_gateway_guard"]["pendingIngress"] == 0
        checks["persistent_gateway_fences_internal_and_idle_commands"] = True
        lease.unlink()
        native = NativeIngress(); native.waiting = asyncio.Event(); native.entered = asyncio.Event()
        task = asyncio.create_task(native._handle_message(types.SimpleNamespace(internal=True)))
        await asyncio.wait_for(native.entered.wait(), 3)
        lease.write_text("held")
        assert status._get_code_identity_fields()["agent_interface_gateway_guard"]["pendingIngress"] == 1
        native.waiting.set(); await asyncio.wait_for(task, 3)
        assert native.called and status._get_code_identity_fields()["agent_interface_gateway_guard"]["pendingIngress"] == 0
        checks["native_gateway_preflight_counted_until_completion"] = True
        assert drain.drain_requested(), "Native drain expiry bypassed persistent maintenance"
        checks["persistent_gateway_drain_remains_closed"] = True
        lease.unlink()
    asyncio.run(scenario())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    parent = verify_home(os.environ.get("HERMES_HOME", ""))
    if not args.source.is_absolute() or not (args.source / "tui_gateway/server.py").is_file():
        raise SystemExit("Guard probe requires the qualification source")
    sys.path.insert(0, str(args.source))
    sys.dont_write_bytecode = True
    os.umask(0o077)
    checks = {}
    with tempfile.TemporaryDirectory(prefix="maintenance-guard-", dir=parent.parent) as directory:
        home = Path(directory)
        (home / ".agent-interface-isolated").write_text(MARKER)
        key = "disposable-maintenance-guard-key"
        os.environ.update(HERMES_HOME=str(home), HERMES_AGENT_INTERFACE_TOKEN=key,
                          HERMES_AGENT_INTERFACE_MAINTENANCE_FILE=str(home / "maintenance.json"))
        spec = importlib.util.spec_from_file_location("maintenance_probe_extension", Path(__file__).resolve().parents[2] / "src/hermes/extension.py")
        extension = importlib.util.module_from_spec(spec); spec.loader.exec_module(extension)
        extension.install()
        from tui_gateway import server
        from hermes_cli.backend_retirement import retirement

        def maintenance(action):
            return server.handle_request({"id": 100, "method": "agent-interface.maintenance", "params": {
                "action": action, "operation_id": "qualification-guard-probe", "service_key": key}})

        class Transport:
            def write(self, _response): return True

        native_pool = server._pool
        server._pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        started, release, queued = threading.Event(), threading.Event(), threading.Event()
        def blocking(rid, _params):
            started.set(); release.wait(10); return server._ok(rid, {})
        def pending(rid, _params):
            queued.set(); return server._ok(rid, {})
        server._methods["qualification.blocking"] = blocking
        server._methods["qualification.queued"] = pending
        server._LONG_HANDLERS = server._LONG_HANDLERS | {"qualification.blocking", "qualification.queued"}
        try:
            server.dispatch({"id": 1, "method": "qualification.blocking", "params": {}}, Transport())
            assert started.wait(3), "Native long handler did not start"
            server.dispatch({"id": 2, "method": "qualification.queued", "params": {}}, Transport())
            assert retirement.active_count() == 2 and not queued.is_set(), "Native queued RPC has no admission reservation"
            response = maintenance("acquire")
            assert "error" in response and not (home / "maintenance.json").exists(), response
            checks["queued_long_rpc_refuses_maintenance"] = True
        finally:
            release.set(); server._pool.shutdown(wait=True); server._pool = native_pool
        assert queued.is_set() and retirement.active_count() == 0
        response = maintenance("acquire")
        assert response.get("result", {}).get("active"), response
        response = server.dispatch({"id": 3, "method": "qualification.queued", "params": {}}, Transport())
        assert "error" in response, response
        assert server._start_session_work(lambda: None, name="qualification-gated-deferred") is None
        checks["held_lease_blocks_long_rpc_and_deferred_work"] = True
        assert maintenance("release")["result"]["active"] is False

        deferred_started, deferred_release = threading.Event(), threading.Event()
        def deferred(): deferred_started.set(); deferred_release.wait(10)
        thread = server._start_session_work(deferred, name="qualification-reserved-deferred")
        try:
            assert thread is not None and deferred_started.wait(3)
            response = maintenance("acquire"); assert "error" in response, response
            checks["deferred_reservation_refuses_maintenance"] = True
        finally:
            deferred_release.set()
            if thread: thread.join(3)
        assert retirement.active_count() == 0
        server._sessions["qualification-scheduled"] = {"_auto_continue_scheduled": True}
        response = maintenance("acquire"); assert "error" in response, response
        del server._sessions["qualification-scheduled"]
        checks["scheduled_continuation_refuses_maintenance"] = True

        locked, proceed, completed = threading.Event(), threading.Event(), threading.Event()
        def session_lock_owner():
            with server._sessions_lock:
                locked.set(); proceed.wait(3)
                if retirement.acquire(): retirement.release()
            completed.set()
        owner = threading.Thread(target=session_lock_owner, daemon=True); owner.start()
        assert locked.wait(3)
        responses = []
        rpc = threading.Thread(target=lambda: responses.append(maintenance("acquire")), daemon=True); rpc.start()
        try:
            rpc.join(2)
            assert not rpc.is_alive(), "Maintenance inverted native session/admission lock order"
            assert responses[0].get("result", {}).get("active"), responses
        finally:
            proceed.set(); owner.join(3)
        assert completed.is_set()
        assert maintenance("release")["result"]["active"] is False
        checks["native_session_lock_order_completes"] = True

        history = [
            {"role": "tool", "tool_call_id": "reused", "content": "hidden old output", "display_kind": "hidden", "_row_id": 10, "timestamp": 1},
            {"role": "tool", "tool_call_id": "reused", "content": "first visible output", "_row_id": 11, "timestamp": 2},
            {"role": "tool", "tool_call_id": "reused", "content": "second visible output", "_row_id": 12, "timestamp": 3},
        ]
        projected = server._history_to_messages(history)
        assert [(row.get("row_id"), row.get("app_tool_result")) for row in projected] == [(11, "first visible output"), (12, "second visible output")], projected
        checks["hidden_reused_tool_rows_preserve_native_identity"] = True
        probe_tool_projection(server, checks)
        probe_gateway(home, checks)
        native_pool.shutdown(wait=True)
    destination = Path(__file__).resolve().parents[2] / "docs/evidence/hermes-maintenance-guard-probe.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps({"checks": checks}, indent=2) + "\n")
    print(json.dumps(checks))


if __name__ == "__main__": main()
