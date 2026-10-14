"""Canonical open attribution against the add-on journal, with a fake native gateway.

The real gateway contract lives in scripts/spike/extension_probe.py. These
tests pin the journal reads every conversation poll makes.
"""
import copy
import importlib.util
import json
import re
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("extension_journal_test", ROOT / "src/hermes/extension.py")
extension = importlib.util.module_from_spec(spec); spec.loader.exec_module(extension)


def image_text(text, images):
    return (text or "") + "".join("\n[image: " + path + "]" for path in images)


class FakeHermes:
    """Just enough of tui_gateway for install() and agent-interface.open."""
    def __init__(self, messages):
        self.messages = messages
        self.methods = {}
        server = types.ModuleType("tui_gateway.server")
        server._sessions = {}
        server._ok = lambda rid, value: {"jsonrpc": "2.0", "id": rid, "result": value}
        server._err = lambda rid, code, message: {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}
        def handle(request):
            if request["method"] == "profiles.list":
                return server._ok(request["id"], {"profiles": [{"name": "default", "canonical_session": {"resolved_id": "stored"}}]})
            server._sessions.setdefault("sid", {"session_key": "stored"})
            return server._ok(request["id"], {"session_id": "sid", "messages": copy.deepcopy(self.messages)})
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

    def __enter__(self):
        self.patches = [patch.dict(sys.modules, self.modules), patch.object(extension, "source_state", lambda: (extension.REVISION, None)),
                        patch.dict("os.environ", {"HERMES_AGENT_INTERFACE_COMPUTER_HOME": ""})]
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

    def open(self):
        return self.methods["agent-interface.open"]("poll", {"profile": "default"})["result"]


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


if __name__ == "__main__":
    unittest.main()
