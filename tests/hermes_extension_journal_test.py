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
    def __init__(self, messages, bridge=False, environment=None, invocation=False):
        self.messages = messages
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
        self.journal = extension.install(Path(self.directory.name) / "agent-interface.db")
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
            self.assertEqual((result["app_run_id"],result["running"],result["interruption_pending"]),("one",False,False))
            self.assertEqual([method for method,_ in hermes.native_calls],["prompt.submit"])
            with hermes.journal.db:
                hermes.journal.db.execute("INSERT INTO interruptions VALUES('default','stored','old',1)")
            refused=submit("send",{**params,"request_id":"two"})
            self.assertEqual(refused["error"]["code"],4094)

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
    def test_unchanged_jobs_skip_ledgers_with_safety_net_and_forced_scans(self):
        jobs=[{"id":"job", "last_run_at":"one", "next_run_at":"two"}]
        ledger=Mock(return_value=[{"id":"execution", "status":"completed", "session_id":"sid"}])
        modules={"hermes_cli.web_routers.cron":types.SimpleNamespace(_owner_home_scope=lambda _:contextlib.nullcontext(),_list_cron_jobs_sync=lambda _:jobs),
                 "cron.executions":types.SimpleNamespace(list_executions=ledger)}
        with FakeHermes([]) as hermes, patch.dict(sys.modules,modules), patch.object(extension.time,"monotonic",return_value=100) as clock:
            discover=hermes.methods["agent-interface.discover"]
            first=discover("tick",{"cursor":"0"})["result"]
            self.assertEqual(len(first["events"]),1)
            ledger.assert_called_once_with(job_id="job",limit=100)
            clock.return_value=105
            self.assertEqual(discover("tick",{"cursor":first["cursor"]})["result"]["events"],[])
            self.assertEqual(ledger.call_count,1)
            jobs[0]["last_run_at"]="moved"
            discover("tick",{})
            self.assertEqual(ledger.call_count,2)
            clock.return_value=164
            discover("tick",{})
            self.assertEqual(ledger.call_count,2)
            clock.return_value=165
            discover("tick",{})
            self.assertEqual(ledger.call_count,3)
            discover("tick",{"full":True})
            self.assertEqual(ledger.call_count,4)


if __name__ == "__main__":
    unittest.main()
