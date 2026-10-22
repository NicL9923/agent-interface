"""Canonical open attribution against the add-on journal, with a fake native gateway.

The real gateway contract lives in scripts/spike/extension_probe.py. These
tests pin the journal reads every conversation poll makes.
"""
import copy
import contextlib
import importlib.util
import json
import re
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("extension_journal_test", ROOT / "src/hermes/extension.py")
extension = importlib.util.module_from_spec(spec); spec.loader.exec_module(extension)


def image_text(text, images):
    return (text or "") + "".join("\n[image: " + path + "]" for path in images)


class FakeHermes:
    """Just enough of tui_gateway for install() and agent-interface.open."""
    def __init__(self, messages, bridge=False, environment=None, invocation=False, journal_path=None):
        self.messages = messages
        self.journal_path = journal_path
        self.environment = environment or {}
        self.methods = {}
        server = types.ModuleType("tui_gateway.server")
        server._sessions = {}
        server._ok = lambda rid, value: {"jsonrpc": "2.0", "id": rid, "result": value}
        server._err = lambda rid, code, message: {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}
        self.native_calls = []
        def handle(request):
            self.native_calls.append((request["method"], dict(request.get("params") or {})))
            if request["method"] == "profiles.list":
                return server._ok(request["id"], {"profiles": [{"name": "default", "canonical_session": {"resolved_id": "stored"}}]})
            server._sessions.setdefault("sid", {"session_key": "stored"})
            omitted = (request.get("params") or {}).get("omit_messages") is True
            return server._ok(request["id"], {"session_id": "sid", "messages": [] if omitted else copy.deepcopy(self.messages)})
        server.handle_request = handle
        server.dispatch = lambda request, *args, **kwargs: handle(request)
        server.register_method = self.methods.__setitem__
        server._history_to_messages = lambda history, **kwargs: history
        server.project_compaction_message_for_display = lambda row: row
        server.write_json = lambda frame: True
        server._run_post_turn_followups = lambda *args: None
        server._record_turn_marker = lambda *args, **kwargs: None
        server._maybe_schedule_auto_continue = lambda *args: None
        server._attach_session_transport = lambda session, transport: None
        server._session_cwd = lambda session: "/"
        self.invoked = []
        if invocation:
            def invoke(sid, session, turn, *args, **kwargs):
                text = kwargs.get("text", args[-1] if args else None)
                self.invoked.append((turn.agent.ephemeral_system_prompt, text))
                raise RuntimeError("Synthetic provider failure")
            server._invoke_agent = invoke
        server._build_persist_message_with_image_refs = image_text
        requests = types.SimpleNamespace(_lock=threading.Lock(), _open={})
        gateway = types.ModuleType("tui_gateway")
        gateway.server, gateway.server_requests = server, requests
        retirement = types.SimpleNamespace(acquire=lambda: True, release=lambda: None, active_count=lambda: 1)
        self.modules = {
            "tui_gateway": gateway, "tui_gateway.server": server, "tui_gateway.server_requests": requests,
            "tui_gateway.transport": types.SimpleNamespace(Transport=object),
            "hermes_constants": types.SimpleNamespace(get_hermes_home=lambda: "/home/default", profile_name_for_home=lambda home: "default"),
            "hermes_cli": types.ModuleType("hermes_cli"),
            "hermes_cli.backend_retirement": types.SimpleNamespace(retirement=retirement),
            "agent": types.ModuleType("agent"), "agent.skill_utils": types.SimpleNamespace(ESSENTIAL_SKILLS=set()),
        }
        # Bot Chat delivery: Hermes 6ebd92d's dashboard consumer, or eb75627's authority-only producers.
        self.mailbox = types.ModuleType("tools.bot_live_delivery")
        native = lambda *args, **kwargs: None
        for name in ("_root", "_locked", "_read", "_write", "_scan_read", "_next_sequence", "_delivery_id", "complete_delivery",
                     "find_canonical_live_owner", "deliver_to_live_owner"):
            setattr(self.mailbox, name, native)
        self.mailbox.has_mailbox = lambda home: False
        for name in ("_ensure_active_session_slot", "_session_turn_admission", "_run_prompt_submit", "_notif_release_turn"):
            setattr(server, name, native)
        if bridge:
            self.mailbox.authority_delivery = native
        else:
            server._poll_bot_live_delivery_once = native
        self.modules.update({"tools": types.ModuleType("tools"), "tools.bot_live_delivery": self.mailbox,
                             "tools.bot_failure_reasons": types.SimpleNamespace(classify_agent_error=lambda error: "unknown")})

    def __enter__(self):
        self.patches = [patch.dict(sys.modules, self.modules), patch.object(extension, "source_state", lambda: (extension.REVISION, None)),
                        patch.dict("os.environ", {"HERMES_AGENT_INTERFACE_COMPUTER_HOME": "", **self.environment})]
        for item in self.patches:
            item.start()
        self.directory = tempfile.TemporaryDirectory()
        self.journal = extension.install(self.journal_path or Path(self.directory.name) / "agent-interface.db")
        return self

    def __exit__(self, *exc):
        self.journal.db.close()
        self.directory.cleanup()
        for item in reversed(self.patches):
            item.stop()

    def open(self, **params):
        return self.methods["agent-interface.open"]("poll", {"profile": "default", **params})["result"]


def turns(count, files=()):
    """count user/assistant turns; assistants in ``files`` carry an artifact, row IDs from 1."""
    rows = []
    for turn in range(count):
        rows.append({"row_id": len(rows) + 1, "role": "user", "text": f"prompt {turn}"})
        rows.append({"row_id": len(rows) + 1, "role": "assistant", "text": f"reply {turn}",
                     **({"app_artifacts": [{"path": f"/out/{turn}.png"}]} if turn in files else {})})
    return rows


class HistoryWindowTests(unittest.TestCase):
    """extension.history_window must cut exactly where src/shared/history.ts historyWindow does."""
    def cut(self, rows, start=None, turns=0):
        kept, window = extension.history_window(rows, "sid", start, turns)
        return [row.get("app_index") for row in kept], window

    def test_latest_page_keeps_twenty_turns_and_only_needed_earlier_rows(self):
        rows = turns(25, files={1, 3, 7})
        indexes, window = self.cut(rows)
        self.assertEqual(window, {"earlier": 10, "context": 4})
        self.assertEqual(indexes, [2, 3, 6, 7] + list(range(10, 50)))

    def test_a_start_keeps_the_reader_window_and_extends_by_whole_turns(self):
        rows = turns(25)
        self.assertEqual(self.cut(rows, start="31")[1], {"earlier": 30, "context": 0})
        self.assertEqual(self.cut(rows, start="31", turns=2)[1], {"earlier": 26, "context": 0})
        self.assertEqual(self.cut(rows, start="missing")[1]["earlier"], 10)

    def test_nothing_is_cut_at_the_start_or_mid_turn(self):
        rows = turns(25)
        self.assertEqual(self.cut(rows, start="1"), ([None] * 50, None))
        self.assertIsNone(self.cut(rows, start="32")[1])
        self.assertIsNone(self.cut(turns(5))[1])

    def test_hidden_rows_and_positional_ids_follow_the_app(self):
        rows = turns(25)
        rows.insert(4, {"role": "assistant", "display_kind": "hidden", "text": "scaffold"})
        for row in rows[30:]:
            row.pop("row_id", None)
        rows[29]["app_request_id"] = "app-request"
        indexes, window = self.cut(rows, start="sid-30")
        self.assertEqual((indexes[0], window), (30, {"earlier": 30, "context": 0}))
        self.assertEqual(self.cut(rows, start="app-request")[1], {"earlier": 28, "context": 0})
        self.assertNotIn("scaffold", [row["text"] for row in extension.history_window(rows, "sid", None, 0)[0]])


class OpenTests(unittest.TestCase):
    def test_submit_resolves_canonical_and_preserves_interruption_guard(self):
        with FakeHermes([]) as hermes:
            hermes.open()
            hermes.native_calls.clear()
            submit=hermes.methods["agent-interface.submit"]
            params={"profile":"default","request_id":"one","sender_id":"member","text":"Hello"}
            result=submit("send",params)["result"]
            self.assertEqual(result["status"],"accepted")
            self.assertEqual((result["app_run_id"],result["admission"]),("one","canonical"))
            self.assertNotIn("running",result)
            # Replaying the request ID returns the identical receipt, however the session's state moved.
            hermes.modules["tui_gateway.server"]._sessions["sid"]["running"]=True
            self.assertEqual(submit("again",params)["result"],result)
            self.assertEqual([method for method,_ in hermes.native_calls],["prompt.submit"])
            with hermes.journal.db:
                hermes.journal.db.execute("INSERT INTO interruptions VALUES('default','stored','old',1)")
                hermes.journal.db.execute("UPDATE receipts SET status='interrupted',row_id=77,terminal=1 WHERE request_id='one'")
            self.assertEqual(submit("again",params)["result"],result)
            live = hermes.methods["agent-interface.receipt"]("lookup", {"request_id": "one"})["result"]["receipt"]
            self.assertEqual((live["status"], live["userRowId"]), ("interrupted", 77))
            refused=submit("send",{**params,"request_id":"two"})
            self.assertEqual(refused["error"]["code"],4094)
            # An already admitted request needs no surviving canonical runtime session.
            hermes.modules["tui_gateway.server"]._sessions.clear()
            self.assertEqual(submit("again",params)["result"],result)
            self.assertEqual([method for method,_ in hermes.native_calls],["prompt.submit"])

    def test_submit_response_survives_restart_without_canonical_activation(self):
        params = {"profile": "default", "request_id": "one", "sender_id": "member", "text": "Hello"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "journal.db"
            with FakeHermes([], journal_path=path) as hermes:
                original = hermes.methods["agent-interface.submit"]("send", params)["result"]
                self.assertEqual((original["status"], original["userRowId"]), ("accepted", None))
                with hermes.journal.db:
                    hermes.journal.db.execute("UPDATE receipts SET row_id=42 WHERE request_id='one'")
                epoch = hermes.journal.epoch
            for _ in range(2):
                with FakeHermes([], journal_path=path) as hermes:
                    self.assertNotEqual(hermes.journal.epoch, epoch)
                    submit = hermes.methods["agent-interface.submit"]
                    self.assertEqual(submit("retry", params)["result"], original)
                    self.assertEqual(submit("stale-sid", {**params, "session_id": "retired"})["result"], original)
                    self.assertEqual(hermes.journal.receipt("one")["status"], "interrupted")
                    self.assertEqual(hermes.journal.receipt("one")["userRowId"], 42)
                    self.assertEqual(hermes.native_calls, [])

    def test_submit_failure_messages_survive_retry_and_restart(self):
        failures = {
            "finishing": ("rejected", "Hermes is finishing the preceding task. Your input was not admitted; send it again after the task settles."),
            "running-image": ("rejected", "Images cannot be added while Hermes is working. Keep this draft and send it after the task settles."),
            "image-preparation": ("rejected", "Image preparation failed before admission: Synthetic image failure"),
            "native": ("uncertain", "Synthetic native failure"),
        }
        for mode, (status, message) in failures.items():
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "journal.db"
                params = {"profile": "default", "request_id": "failed", "sender_id": "member", "text": "Hello"}
                with FakeHermes([], journal_path=path) as hermes:
                    hermes.open()
                    server = hermes.modules["tui_gateway.server"]
                    session = server._sessions["sid"]
                    submit = hermes.methods["agent-interface.submit"]
                    if mode == "finishing":
                        submit("root", {**params, "request_id": "root"})
                    if mode in ("running-image", "image-preparation"):
                        params["attachments"] = [{"path": "/photo.png", "mime": "image/png"}]
                    if mode == "running-image":
                        session["running"] = True
                    native = Mock(wraps=server.handle_request)
                    server.handle_request = native
                    if mode == "image-preparation":
                        session.update(history_lock=threading.Lock(), attached_images=["prior.png"])
                        def fail_image(request, session=session):
                            self.assertEqual(request["method"], "image.attach")
                            session["attached_images"].append("new.png")
                            raise RuntimeError("Synthetic image failure")
                        native.side_effect = fail_image
                    elif mode == "native":
                        native.side_effect = RuntimeError("Synthetic native failure")
                    original = submit("send", params)["result"]
                    self.assertEqual((original["status"], original["message"]), (status, message))
                    self.assertEqual(native.call_count, int(mode in ("image-preparation", "native")))
                    if mode == "image-preparation":
                        self.assertEqual(session["attached_images"], ["prior.png"])
                    native.reset_mock()
                    self.assertEqual(submit("retry", params)["result"], original)
                    native.assert_not_called()
                with FakeHermes([], journal_path=path) as hermes:
                    self.assertEqual(hermes.methods["agent-interface.submit"]("retry", params)["result"], original)
                    self.assertEqual(hermes.native_calls, [])

    def test_old_receipt_without_snapshot_recovers_conservatively(self):
        params = {"profile": "default", "request_id": "old", "sender_id": "member", "text": "Hello"}
        # Dropping the new column reproduces the preceding journal schema. A NULL
        # snapshot also covers a crash after durable intent but before a response.
        for old_schema in (False, True):
            with self.subTest(old_schema=old_schema), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "journal.db"
                with FakeHermes([], journal_path=path) as hermes:
                    hermes.methods["agent-interface.submit"]("send", params)
                    with hermes.journal.db:
                        if old_schema:
                            hermes.journal.db.execute("ALTER TABLE receipts DROP COLUMN admission_response")
                        else:
                            hermes.journal.db.execute("UPDATE receipts SET admission_response=NULL,status='uncertain' WHERE request_id='old'")
                with FakeHermes([], journal_path=path) as hermes:
                    submit = hermes.methods["agent-interface.submit"]
                    recovered = submit("retry", params)["result"]
                    self.assertEqual((recovered["status"], recovered["userRowId"]), ("uncertain", None))
                    self.assertEqual((recovered["requestId"], recovered["runId"], recovered["senderId"]), ("old", "old", "member"))
                    self.assertEqual((recovered["app_run_id"], recovered["admission"]), ("old", "canonical"))
                    self.assertIn("Original admission response is unavailable", recovered["message"])
                    self.assertEqual(hermes.journal.receipt("old")["status"], "interrupted")
                    with hermes.journal.db:
                        hermes.journal.db.execute("UPDATE receipts SET status='accepted',row_id=99,terminal=1 WHERE request_id='old'")
                    self.assertEqual(submit("retry", params)["result"], recovered)
                    self.assertEqual(hermes.native_calls, [])
                with FakeHermes([], journal_path=path) as hermes:
                    self.assertEqual(hermes.methods["agent-interface.submit"]("retry", params)["result"], recovered)
                    self.assertEqual(hermes.native_calls, [])

    def test_submit_rejects_changed_input_before_refresh_or_interruption_guard(self):
        with FakeHermes([]) as hermes:
            params = {"profile": "default", "request_id": "one", "sender_id": "member", "text": "Hello"}
            submit = hermes.methods["agent-interface.submit"]
            submit("send", params)
            with hermes.journal.db:
                hermes.journal.db.execute("INSERT INTO interruptions VALUES('default','stored','one',1)")
            hermes.modules["tui_gateway.server"]._sessions.clear()
            hermes.native_calls.clear()
            for changes in ({"text": "Changed"}, {"sender_id": "other"}, {"profile": "other"},
                            {"attachments": [{"path": "/photo.png", "mime": "image/png"}]}):
                with self.subTest(changes=changes):
                    self.assertEqual(submit("conflict", {**params, **changes})["error"]["code"], 4093)
            self.assertEqual(hermes.native_calls, [])

    def test_submit_requires_review_after_stopped_terminal_or_inflight(self):
        for mode in ("terminal", "inflight", "cold"):
            with self.subTest(mode=mode), FakeHermes([]) as hermes:
                hermes.open()
                session = hermes.modules["tui_gateway.server"]._sessions["sid"]
                if mode == "inflight":
                    session["inflight_turn"] = {"user": "Stopped", "interrupted": True}
                elif mode == "cold":
                    with hermes.journal.db:
                        hermes.journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,terminal,created) VALUES('old','d','default','old-sid','stored','member','e','old','Ask','[]',0,'accepted',1,1)")
                    hermes.journal.event("default", "old-sid", "interrupted", "Stopped", "old")
                else:
                    hermes.journal.event("default", "sid", "interrupted", "Stopped")
                submit = hermes.methods["agent-interface.submit"]
                params = {"profile": "default", "request_id": "new", "sender_id": "member", "text": "Hello"}
                self.assertEqual(submit("send", params)["error"]["code"], 4094)
                self.assertNotIn("prompt.submit", [method for method, _ in hermes.native_calls])
                self.assertEqual(submit("send", {**params, "reviewed_interruption": True})["result"]["status"], "accepted")
                # Once reviewed admission has started a new run, an idempotent retry
                # sees that current run rather than reapplying its predecessor's stop.
                self.assertEqual(submit("send", params)["result"]["status"], "accepted")

    def test_history_cache_prunes_noncanonical_sessions_and_caps_entries(self):
        with FakeHermes(turns(1)) as hermes:
            hermes.open()
            session = hermes.modules["tui_gateway.server"]._sessions["sid"]
            session.update(history=hermes.messages, history_lock=threading.Lock(), profile_home=hermes.directory.name)
            hermes.open()
            method = hermes.methods["agent-interface.open"]
            cells = dict(zip(method.__code__.co_freevars, (cell.cell_contents for cell in method.__closure__)))
            cache, canonical = cells["decorated"], cells["canonical"]
            cache["obsolete"] = cache["sid"]
            hermes.open()
            self.assertNotIn("obsolete", cache)
            # Simulate many profiles with retained histories. Each read enforces the cap.
            for index in range(40):
                sid = f"profile-{index}"
                canonical[sid] = sid
                hermes.modules["tui_gateway.server"]._sessions[sid] = dict(session)
                cache[sid] = cache["sid"]
            cache.pop("sid")
            hermes.open()
            self.assertLessEqual(len(cache), 32)

    def test_decorated_cache_skips_projection_and_binding_and_invalidates(self):
        with FakeHermes(turns(25, files={3})) as hermes:
            expected = hermes.open(window={"turns": 20})
            session = hermes.modules["tui_gateway.server"]._sessions["sid"]
            session.update(history=hermes.messages, history_lock=threading.Lock(),profile_home=hermes.directory.name)
            self.assertEqual(hermes.open(window={"turns": 20})["messages"], expected["messages"])
            seen = []
            hermes.journal.db.set_trace_callback(seen.append)
            hit = hermes.open(window={"turns": 20})
            hermes.journal.db.set_trace_callback(None)
            self.assertEqual(hit["messages"], expected["messages"])
            self.assertTrue(hermes.native_calls[-1][1]["omit_messages"])
            self.assertFalse(any("FROM tools" in sql or "row_id IN" in sql for sql in seen))
            hermes.journal.event("default", "sid", "completed", "Result")
            hermes.open()
            self.assertNotIn("omit_messages", hermes.native_calls[-1][1])
            hermes.open()
            self.assertTrue(hermes.native_calls[-1][1]["omit_messages"])
            for filename in ("state.db", "state.db-wal", "config.yaml"):
                hermes.open()
                Path(hermes.directory.name,filename).write_text("changed")
                hermes.open()
                self.assertNotIn("omit_messages",hermes.native_calls[-1][1])
            session["running"]=True
            hermes.open(); hermes.open()
            self.assertNotIn("omit_messages",hermes.native_calls[-1][1])
            session["running"]=False
            session["history"] = hermes.messages = turns(3)
            self.assertEqual(len(hermes.open()["messages"]), 6)
            self.assertNotIn("omit_messages", hermes.native_calls[-1][1])
            session["history"][0]["_row_id"]=12345
            hermes.open()
            self.assertNotIn("omit_messages", hermes.native_calls[-1][1])
            session["history"][-1] = {"role":"assistant", "text":"Replacement"}
            hermes.open()
            self.assertNotIn("omit_messages", hermes.native_calls[-1][1])

    def test_light_open_skips_native_history_and_a_window_cuts_it(self):
        with FakeHermes(turns(25, files={3})) as hermes:
            first = hermes.open(omit_messages=True)
            self.assertEqual(len(first["messages"]), 50)
            light = hermes.open(omit_messages=True, window={"turns": 20})
            self.assertEqual((light["messages"], "app_window" in light), ([], False))
            self.assertEqual(hermes.native_calls[-1], ("session.activate", {"session_id": "sid", "profile": "default", "omit_messages": True}))
            cut = hermes.open(window={"turns": 20})
            self.assertEqual(cut["app_window"], {"earlier": 10, "context": 2})
            self.assertEqual([row["app_index"] for row in cut["messages"][:3]], [6, 7, 10])
            self.assertNotIn("omit_messages", hermes.native_calls[-1][1])
            self.assertNotIn("app_window", hermes.open())


class InlineGuidanceTests(unittest.TestCase):
    def pending_app_turn(self, hermes):
        receipt(hermes.journal.db, "app-root", 1, time.time(), text="Original user text")
        hermes.journal.db.execute("UPDATE receipts SET terminal=0,session_id='sid' WHERE request_id='app-root'")

    def test_current_native_invocation_uses_post_model_switch_agent_and_restores_on_error(self):
        with FakeHermes([], invocation=True) as hermes:
            server = hermes.modules["tui_gateway.server"]
            hermes.open()
            self.pending_app_turn(hermes)
            session = server._sessions["sid"]
            stale_agent = types.SimpleNamespace(ephemeral_system_prompt="Previous model")
            session["agent"] = stale_agent
            agent = types.SimpleNamespace(ephemeral_system_prompt="Current model")
            turn = types.SimpleNamespace(agent=agent)
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, "Synthetic provider failure"):
                    server._invoke_agent("sid", session, turn, None, None, None, [], None, None, None, "Original user text")
            self.assertEqual(hermes.invoked[0][1], "Original user text")
            self.assertTrue(hermes.invoked[0][0].startswith("Current model\n\n"))
            self.assertEqual(hermes.invoked[0][0].count("fenced wildbots-html"), 1)
            self.assertEqual(hermes.invoked[0], hermes.invoked[1])
            self.assertEqual(agent.ephemeral_system_prompt, "Current model")
            self.assertEqual(stale_agent.ephemeral_system_prompt, "Previous model")
            with self.assertRaises(RuntimeError):
                server._invoke_agent("sid", session, turn, None, None, None, [], "bot_dm", None, {"kind": "agent"}, "Original user text")
            self.assertEqual(hermes.invoked[-1][0], "Current model")
            with self.assertRaises(RuntimeError):
                server._invoke_agent("sid", session, turn, None, None, None, [], None, None, None, "Other client text")
            self.assertEqual(hermes.invoked[-1][0], "Current model")

    def test_guidance_is_ephemeral_and_only_for_app_sessions(self):
        with FakeHermes([]) as hermes:
            server = hermes.modules["tui_gateway.server"]
            hermes.open()
            self.pending_app_turn(hermes)
            session = server._sessions["sid"]
            # The legacy native runner is a no-op. Observe the guidance while it executes.
            wrapper = server._run_prompt_submit
            # Observe the prompt assigned during native execution and its restoration.
            class ObservedAgent:
                def __init__(self):
                    self.values = []
                    self._prompt = "Existing private instructions"
                @property
                def ephemeral_system_prompt(self):
                    return self._prompt
                @ephemeral_system_prompt.setter
                def ephemeral_system_prompt(self, value):
                    self.values.append(value)
                    self._prompt = value
            observed = ObservedAgent()
            session["agent"] = observed
            for _ in range(2):
                wrapper("request", "sid", session, "Original user text")
            self.assertEqual(observed.ephemeral_system_prompt, "Existing private instructions")
            self.assertEqual(observed.values[0].count("fenced wildbots-html"), 1)
            self.assertTrue(observed.values[0].startswith("Existing private instructions\n\n"))
            self.assertEqual(observed.values[0], observed.values[2])
            wrapper("request", "sid", session, "Other client text")
            wrapper("__bot_dm__", "sid", session, "Original user text")
            self.assertEqual(len(observed.values), 4)
            self.assertEqual(hermes.messages, [])


def receipt(db, request_id, row_id, created, *, profile="default", run_id=None, text=None, attachments=(), steering=0, status="accepted", actor="nicolas"):
    db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,row_id,terminal,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
               (request_id, "digest", profile, "old-sid", "stored", actor, "epoch", run_id or request_id, text, json.dumps(list(attachments)), steering, status, row_id, 1, created))


def tool(db, run_id, tool_id, result, *, name="terminal", arguments="{}", profile="default", artifacts=()):
    db.execute("INSERT INTO tools(profile,stored_session,run_id,tool_id,result,artifacts,detail) VALUES(?,?,?,?,?,?,?)",
               (profile, "stored", run_id, tool_id, json.dumps(result), json.dumps(list(artifacts)), json.dumps({"id": run_id + ":" + tool_id, "name": name, "arguments": arguments})))


def history(turns):
    """A long canonical chat in which every app turn is already bound, plus two stale corrections."""
    messages = []
    def write(db):
        for turn in range(turns):
            base = 4 * turn + 1
            receipt(db, f"r{turn}", base, turn, text=f"Turn {turn}")
            tool(db, f"r{turn}", f"call{turn}", {"ok": turn})
            tool(db, f"r{turn}", f"call{turn}", {"ok": -turn})
            tool(db, f"r{turn}", f"other{turn}", {"ok": turn})
            receipt(db, f"elsewhere{turn}", base, turn, profile="patch")
        # Native never persisted these corrections; they stay unbound, as on the live host.
        receipt(db, "stale-a", None, turns, run_id="r0", text="never shown", steering=1)
        receipt(db, "stale-b", None, turns, run_id="r0", text="never shown either", steering=1)
    for turn in range(turns):
        base = 4 * turn + 1
        messages += [{"role": "user", "row_id": base, "text": f"Turn {turn}", "timestamp": turn},
                     {"role": "tool", "row_id": base + 1, "tool_call_id": f"call{turn}", "name": "terminal", "args": {}, "app_tool_result": {"ok": turn}},
                     {"role": "tool", "row_id": base + 2, "tool_call_id": f"other{turn}", "name": "terminal", "args": {}, "app_tool_result": {"ok": turn}},
                     {"role": "assistant", "row_id": base + 3, "text": "Done", "timestamp": turn}]
    return messages, write


class CanonicalOpenTests(unittest.TestCase):
    def test_attribution_binding_and_tool_details(self):
        report = {"path": "/srv/report.pdf", "name": "report.pdf", "mime": "application/pdf"}
        photo = {"path": "/srv/photo.png", "name": "photo.png", "mime": "image/png"}
        messages = [
            {"role": "user", "row_id": 10, "text": "Summarize\n@file:\"/srv/report.pdf\"", "timestamp": 100},
            {"role": "tool", "row_id": 11, "tool_call_id": "read", "name": "read_file", "args": {"path": "report.pdf"}, "app_tool_result": {"pages": 3}},
            {"role": "tool", "row_id": 12, "tool_call_id": "shell", "name": "terminal", "args": {}, "app_tool_result": {"exit_code": 0}},
            # A native correction persisted after admission, without an admission row ID.
            {"role": "user", "row_id": 13, "text": "Shorter please", "timestamp": 101},
            {"role": "assistant", "row_id": 14, "text": "Summary", "timestamp": 102},
            {"role": "user", "row_id": 20, "text": image_text("", ["/srv/photo.png"]), "timestamp": 200},
            {"role": "tool", "row_id": 21, "tool_call_id": "read", "name": "read_file", "args": {"path": "other.pdf"}, "app_tool_result": {"pages": 3}},
            {"role": "user", "row_id": 30, "text": "From the desktop", "timestamp": 300},
            {"role": "tool", "row_id": 31, "tool_call_id": "read", "name": "read_file", "args": {}, "app_tool_result": {"pages": 3}},
            {"role": "system", "text": "Compacted", "timestamp": 301},
        ]
        with FakeHermes(messages) as hermes:
            db = hermes.journal.db
            with db:
                receipt(db, "first", 10, 1, text="Summarize\n@file:\"/srv/report.pdf\"", attachments=[report], actor="kimberly")
                receipt(db, "steer", None, 2, run_id="first", text="Shorter please", steering=1)
                receipt(db, "photo", None, 3, attachments=[photo])
                # Another profile's row IDs belong to its own state database.
                receipt(db, "elsewhere", 30, 4, profile="patch", text="Not this chat")
                tool(db, "first", "read", {"pages": 3}, name="read_file", arguments=json.dumps({"path": "report.pdf"}), artifacts=[report])
                tool(db, "first", "shell", {"exit_code": 0}, artifacts=[{"path": "/srv/a.txt"}])
                tool(db, "first", "shell", {"exit_code": 1})
                tool(db, "photo", "read", {"pages": 3}, name="read_file", arguments=json.dumps({"path": "report.pdf"}))
            value = hermes.open()
            self.assertEqual(db.execute("SELECT request_id,row_id FROM receipts ORDER BY created").fetchall(),
                             [("first", 10), ("steer", 13), ("photo", 20), ("elsewhere", 30)])
        first = dict(app_request_id="first", app_sender_id="kimberly", app_run_id="first")
        self.assertEqual(value["messages"], [
            {**messages[0], **first, "app_attachments": [report], "app_display_text": "Summarize"},
            {**messages[1], "app_run_id": "first", "app_artifacts": [report],
             "app_tool_call": {"id": "first:read", "name": "read_file", "arguments": json.dumps({"path": "report.pdf"})}},
            # A reused call ID keeps its matching output but cannot claim one call's detail.
            {**messages[2], "app_run_id": "first", "app_artifacts": [{"path": "/srv/a.txt"}]},
            {**messages[3], "app_request_id": "steer", "app_sender_id": "nicolas", "app_run_id": "first", "app_attachments": [], "app_display_text": "Shorter please"},
            {**messages[4], "app_run_id": "first"},
            {**messages[5], "app_request_id": "photo", "app_sender_id": "nicolas", "app_run_id": "photo", "app_attachments": [photo], "app_display_text": ""},
            {**messages[6], "app_run_id": "photo", "app_artifacts": []},
            messages[7], messages[8], messages[9],
        ])
        self.assertEqual(value["app_tool_calls"], [])

    def statements(self, turns):
        messages, write = history(turns)
        with FakeHermes(messages) as hermes:
            with hermes.journal.db:
                write(hermes.journal.db)
            seen = []
            hermes.journal.db.set_trace_callback(seen.append)
            value = hermes.open()
            hermes.journal.db.set_trace_callback(None)
            plans = {sql: [row[3] for row in hermes.journal.db.execute("EXPLAIN QUERY PLAN " + sql)] for sql in seen if sql.lstrip().upper().startswith("SELECT")}
        self.assertEqual(value["messages"][-2]["app_run_id"], f"r{turns - 1}")
        self.assertEqual(value["messages"][-3]["app_artifacts"], [])
        return seen, plans

    def test_poll_reads_do_not_grow_with_history(self):
        short, _ = self.statements(5)
        long, _ = self.statements(60)
        self.assertEqual(len(long), len(short))

    def test_poll_reads_never_scan_a_journal_table(self):
        _, plans = self.statements(30)
        scans = {sql[:200]: plan for sql, plan in plans.items() if any(re.match(r"SCAN (receipts|tools|events|interruptions)\b", step) for step in plan)}
        self.assertEqual(scans, {})

    def test_poll_never_shows_half_of_a_concurrent_write(self):
        report = {"path": "/srv/report.pdf", "name": "report.pdf", "mime": "application/pdf"}
        photo = {"path": "/srv/photo.png", "name": "photo.png", "mime": "image/png"}
        messages = [
            {"role": "user", "row_id": 10, "text": "Summarize", "timestamp": 100},
            {"role": "tool", "row_id": 11, "tool_call_id": "read", "name": "read_file", "args": {}, "app_tool_result": {"pages": 3}},
            # Its persisted text is not the image-ref form, so only a native completion can bind it.
            {"role": "user", "row_id": 20, "text": "Look at this", "timestamp": 200},
            {"role": "assistant", "row_id": 21, "text": "A photo", "timestamp": 201},
        ]
        class Interleaved:
            """The journal connection, with one native writer let in before its first tools read."""
            def __init__(self, db, writer):
                self.db, self.writer = db, writer
            def __enter__(self):
                return self.db.__enter__()
            def __exit__(self, *exc):
                return self.db.__exit__(*exc)
            def execute(self, sql, *args):
                if self.writer and "FROM tools" in sql:
                    self.writer.start()
                    self.writer.join(0.5)
                    self.writer = None
                return self.db.execute(sql, *args)
        with FakeHermes(messages) as hermes:
            journal, db = hermes.journal, hermes.journal.db
            with db:
                receipt(db, "first", 10, 1, text="Summarize")
                receipt(db, "photo", None, 2, text="Look at this", attachments=[photo])
            before = hermes.open()["messages"]
            def native_writes():
                # Same shape as the write hook: one transaction under the journal lock.
                with journal.lock, db:
                    db.execute("UPDATE receipts SET row_id=20 WHERE request_id='photo'")
                    tool(db, "first", "read", {"pages": 3}, name="read_file", artifacts=[report])
            writer = threading.Thread(target=native_writes)
            journal.db = Interleaved(db, writer)
            during = hermes.open()["messages"]
            writer.join(5)
            journal.db = db
            after = hermes.open()["messages"]
        self.assertNotEqual(before, after)
        self.assertIn(during, (before, after))


class BotDeliveryInstallTests(unittest.TestCase):
    def test_native_consumer_hermes_keeps_native_delivery_and_owes_only_addon_receipts(self):
        with FakeHermes([]) as hermes:
            self.assertFalse(getattr(hermes.mailbox, "_agent_interface_bridge", False))
            self.assertFalse(hermes.journal.bot_delivery.native_records)

    def test_authority_hermes_also_runs_receipts_its_retired_consumer_left(self):
        with FakeHermes([], bridge=True) as hermes:
            self.assertTrue(hermes.journal.bot_delivery.native_records)

    def test_authority_only_hermes_delivers_only_beside_a_settled_chat_outside_maintenance(self):
        with tempfile.TemporaryDirectory() as directory:
            lease = Path(directory) / "maintenance.json"
            with FakeHermes([], bridge=True, environment={"HERMES_AGENT_INTERFACE_MAINTENANCE_FILE": str(lease)}) as hermes:
                self.assertTrue(hermes.mailbox._agent_interface_bridge)
                consumer = hermes.journal.bot_delivery
                sid = consumer.open_canonical("default")
                self.assertEqual(sid, "sid")
                def allowed():
                    with consumer.admission(sid) as value:
                        return value
                self.assertTrue(allowed())
                db = hermes.journal.db
                with db:
                    db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,terminal,created) VALUES('open','d','default','sid','stored','nicolas','e','open','Ask','[]',0,'accepted',0,1)")
                self.assertFalse(allowed())
                with db:
                    db.execute("UPDATE receipts SET terminal=1 WHERE request_id='open'")
                self.assertTrue(allowed())
                lease.write_text('{"operationId": "installer"}'); lease.chmod(0o600)
                self.assertFalse(allowed())


class DiscoveryTests(unittest.TestCase):
    def test_ledger_only_writes_trigger_scan_with_safety_net_and_forced_scans(self):
        jobs = [{"id": "job", "last_run_at": "one", "next_run_at": "two"}]
        ledger = Mock(return_value=[{"id": "execution", "status": "completed", "session_id": "sid"}])
        with FakeHermes([]) as hermes:
            db = Path(hermes.directory.name) / "executions.db"
            db.write_text("first")
            executions = types.ModuleType("cron.executions")
            executions.list_executions, executions.EXECUTIONS_FILE = ledger, db
            cron = types.ModuleType("cron")
            cron.executions = executions
            modules = {"hermes_cli.web_routers.cron": types.SimpleNamespace(_owner_home_scope=lambda _: contextlib.nullcontext(), _list_cron_jobs_sync=lambda _: jobs),
                       "cron": cron, "cron.executions": executions}
            with patch.dict(sys.modules, modules), patch.object(extension.time, "monotonic", return_value=100) as clock:
                discover = hermes.methods["agent-interface.discover"]
                first = discover("tick", {"cursor": "0"})["result"]
                self.assertEqual(len(first["events"]), 1)
                ledger.assert_called_once_with(job_id="job", limit=100)
                clock.return_value = 105
                self.assertEqual(discover("tick", {"cursor": first["cursor"]})["result"]["events"], [])
                self.assertEqual(ledger.call_count, 1)
                # Job metadata has not moved, but both DB and WAL writes must be seen.
                db.write_text("a terminal execution write")
                discover("tick", {})
                self.assertEqual(ledger.call_count, 2)
                db.with_name("executions.db-wal").write_text("another terminal execution")
                discover("tick", {})
                self.assertEqual(ledger.call_count, 3)
                clock.return_value = 164
                discover("tick", {})
                self.assertEqual(ledger.call_count, 3)
                clock.return_value = 165
                discover("tick", {})
                self.assertEqual(ledger.call_count, 4)
                discover("tick", {"full": True})
                self.assertEqual(ledger.call_count, 5)

    def test_approval_events_name_their_native_request_for_notification_actions(self):
        with FakeHermes([]) as hermes:
            server = hermes.modules["tui_gateway.server"]
            server._sessions["sid"] = {"session_key": "stored"}
            with hermes.journal.db:
                hermes.journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,terminal,created) VALUES('run','d','default','sid','stored','nicolas','e','run','Ask','[]',0,'accepted',0,1)")
            server.write_json({"jsonrpc": "2.0", "id": "request:7", "method": "approval", "params": {"session_id": "sid", "command": "rm -rf build"}})
            # A journal row from before approval identities, and one whose key belongs to another run, get none.
            hermes.journal.event("default", "sid", "approval", "Approval requested", "run")
            hermes.journal.event("default", "sid", "approval", "Approval requested", "run", event_key="other:approval:9")
            hermes.journal.event("default", "sid", "completed", "Done", "run", event_key="run:completed:")
            executions = types.ModuleType("cron.executions")
            executions.list_executions, executions.EXECUTIONS_FILE = Mock(return_value=[]), Path(hermes.directory.name) / "executions.db"
            cron = types.ModuleType("cron")
            cron.executions = executions
            modules = {"hermes_cli.web_routers.cron": types.SimpleNamespace(_owner_home_scope=lambda _: contextlib.nullcontext(), _list_cron_jobs_sync=lambda _: []),
                       "cron": cron, "cron.executions": executions}
            with patch.dict(sys.modules, modules):
                events = hermes.methods["agent-interface.discover"]("tick", {"cursor": "0"})["result"]["events"]
        self.assertEqual([(event["kind"], event.get("approvalId")) for event in events],
                         [("approval", "request:7"), ("approval", None), ("approval", None), ("completed", None)])


if __name__ == "__main__":
    unittest.main()
