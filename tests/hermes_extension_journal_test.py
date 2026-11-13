"""Canonical open attribution against the add-on journal, with a fake native gateway.

The real gateway contract lives in scripts/spike/extension_probe.py. These
tests pin the journal reads every conversation poll makes.
"""
import copy
import concurrent.futures
import contextlib
import contextvars
import json
import re
import sqlite3
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from support import load_source

ROOT = Path(__file__).resolve().parents[1]
extension = load_source("src/hermes/extension.py", "extension_journal_test")


def saved(result):
    """An admission answer as the journal saved it: a fresh answer adds its own timings, which a replay does not repeat."""
    return {key: value for key, value in result.items() if key != "app_timing"}


def image_text(text, images):
    return (text or "") + "".join("\n[image: " + path + "]" for path in images)


class FakeGateway:
    """Just enough of tui_gateway.server for one Bridge's open, submit, receipt and discover RPCs."""
    def __init__(self, messages, journal_path=None, environment=None):
        self.messages = messages
        self.journal_path = journal_path
        self.environment = environment or {}
        self.native_calls = []
        self.server = server = types.ModuleType("tui_gateway.server")
        server._sessions = {}
        server._ok = lambda rid, value: {"jsonrpc": "2.0", "id": rid, "result": value}
        server._err = lambda rid, code, message: {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}
        def handle(request):
            self.native_calls.append((request["method"], dict(request.get("params") or {})))
            if request["method"] == "profiles.list":
                return server._ok(request["id"], {"profiles": [{"name": "default", "canonical_session": {"resolved_id": "stored"}}]})
            server._sessions.setdefault("sid", {"session_key": "stored"})
            omitted = (request.get("params") or {}).get("omit_messages") is True
            return server._ok(request["id"], {"session_id": "sid", "messages": [] if omitted else copy.deepcopy(self.messages)})
        server.handle_request = handle
        server._attach_session_transport = lambda session, transport: None
        server._build_persist_message_with_image_refs = image_text
        requests = types.SimpleNamespace(_lock=threading.Lock(), _open={})
        gateway = types.ModuleType("tui_gateway")
        gateway.server, gateway.server_requests = server, requests
        # Native redaction registries, which history projection reads in memory.
        self.redact = types.SimpleNamespace(_VAULT_REDACTION_LOCK=threading.Lock(), _VAULT_REDACTION_VALUES={},
                                            _registry_lock=threading.Lock(), _PLUGIN_PREFIX_PATTERNS={})
        bound = contextvars.ContextVar("transport", default=None)
        self.transport = types.SimpleNamespace(bind_transport=bound.set, current_transport=bound.get)
        self.modules = {"tui_gateway": gateway, "tui_gateway.server": server, "tui_gateway.server_requests": requests,
                        "tui_gateway.transport": self.transport, "agent": types.ModuleType("agent"), "agent.redact": self.redact}
        # The shell summary helpers the add-on keeps answers for (see hermes_shell_summary_test.py).
        self.modules["agent"].display = types.SimpleNamespace(_split_shell_compound=lambda text: [text], _clean_shell_segment=str,
                                                              _shell_head_word=str, _is_shell_boundary_echo=lambda text: False)

    def __enter__(self):
        self.patches = [patch.dict(sys.modules, self.modules), patch.dict("os.environ", self.environment)]
        for item in self.patches:
            item.start()
        self.directory = tempfile.TemporaryDirectory()
        self.journal_file = self.journal_path or Path(self.directory.name) / "agent-interface.db"
        self.journal = self.start(self.journal_file)
        return self

    def start(self, path):
        journal = extension.Journal(path)
        self.bridge = extension.Bridge(self.server, journal, get_hermes_home=lambda: "/home/default",
                                       profile_name_for_home=lambda home: "default")
        self.methods = self.bridge.rpc_methods()
        return journal

    def __exit__(self, *exc):
        # Under the journal lock, which the add-on holds for its journal transactions: a send-lane worker still writing
        # when a test ends finishes that transaction first, and a later one raises instead of using the freed
        # connection, which crashed the interpreter under load.
        with self.journal.lock:
            self.journal.db.close()
        self.directory.cleanup()
        for item in reversed(self.patches):
            item.stop()

    def open(self, **params):
        return self.methods["agent-interface.open"]("poll", {"profile": "default", **params})["result"]


class FakeHermes(FakeGateway):
    """The whole native surface install() wraps, for its seams, registration and Bot Chat delivery."""
    def __init__(self, messages, bridge=False, environment=None, invocation=False, journal_path=None):
        super().__init__(messages, journal_path, {"HERMES_AGENT_INTERFACE_COMPUTER_HOME": "", **(environment or {})})
        server = self.server
        self.registered = {}
        server.dispatch = lambda request, *args, **kwargs: server.handle_request(request)
        server.register_method = self.registered.__setitem__
        server._history_to_messages = lambda history, **kwargs: history
        server.project_compaction_message_for_display = lambda row: row
        server.write_json = lambda frame: True
        server._run_post_turn_followups = lambda *args: None
        server._record_turn_marker = lambda *args, **kwargs: None
        server._maybe_schedule_auto_continue = lambda *args: None
        server._session_cwd = lambda session: "/"
        self.invoked = []
        if invocation:
            def invoke(sid, session, turn, *args, **kwargs):
                text = kwargs.get("text", args[-1] if args else None)
                self.invoked.append((turn.agent.ephemeral_system_prompt, text))
                raise RuntimeError("Synthetic provider failure")
            server._invoke_agent = invoke
        self.retirement = types.SimpleNamespace(acquire=lambda: True, release=lambda: None, active_count=lambda: 1)
        self.modules.update({
            "hermes_constants": types.SimpleNamespace(get_hermes_home=lambda: "/home/default", profile_name_for_home=lambda home: "default"),
            "hermes_cli": types.ModuleType("hermes_cli"),
            "hermes_cli.backend_retirement": types.SimpleNamespace(retirement=self.retirement),
            "agent": types.ModuleType("agent"), "agent.skill_utils": types.SimpleNamespace(ESSENTIAL_SKILLS=set()),
        })
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

    def start(self, path):
        with patch.object(extension, "source_state", lambda: (extension.REVISION, None)):
            journal = extension.install(path)
        self.methods = self.registered
        self.bridge = self.methods["agent-interface.open"].__self__
        return journal


class ProfilesGateway(FakeGateway):
    """Two assistants with their own canonical sessions; a test can hold either one's native activation."""
    def __init__(self):
        super().__init__([])
        self.held, self.entered, self.inside, self.peak = {}, {}, {}, {}
        server, counting = self.server, threading.Lock()
        def handle(request):
            params = request.get("params") or {}
            profile = params.get("profile", "default")
            if request["method"] == "profiles.list":
                return server._ok(request["id"], {"profiles": [{"name": name, "canonical_session": {"resolved_id": "stored-" + name}} for name in ("slow", "fast")]})
            if request["method"] not in ("session.activate", "session.resume"):
                self.native_calls.append((request["method"], params))
                return server._ok(request["id"], {"status": "accepted"})
            with counting:
                self.inside[profile] = self.inside.get(profile, 0) + 1
                self.peak[profile] = max(self.peak.get(profile, 0), self.inside[profile])
            try:
                self.entered.setdefault(profile, threading.Event()).set()
                if profile in self.held:
                    self.held[profile].wait(5)
            finally:
                with counting:
                    self.inside[profile] -= 1
            server._sessions.setdefault("sid-" + profile, {"session_key": "stored-" + profile})
            return server._ok(request["id"], {"session_id": "sid-" + profile, "messages": []})
        server.handle_request = handle

    def opening(self, profile, results):
        thread = threading.Thread(target=lambda: results.append(self.open(profile=profile)), daemon=True)
        thread.start()
        return thread


class PooledHermes(FakeHermes):
    """FakeHermes behind native dispatch as rpc_dispatch does it: long handlers on an
    8-worker pool, reserved before queueing and released once answered; the rest inline."""
    def __init__(self, environment=None):
        super().__init__([], environment=environment)
        server, self.native_pool = self.server, concurrent.futures.ThreadPoolExecutor(max_workers=8)
        self.held, self.entered, self.active, counting = threading.Event(), threading.Event(), [0], threading.Lock()
        def acquire():
            with counting:
                self.active[0] += 1
            return True
        def release():
            with counting:
                self.active[0] -= 1
        self.retirement.acquire, self.retirement.release = acquire, release
        server._LONG_HANDLERS = frozenset({"profiles.list"})
        def handle(request):
            method, params = request["method"], request.get("params") or {}
            if method in self.registered:
                return self.registered[method](request.get("id"), params)
            if method == "profiles.list":
                return server._ok(request["id"], {"profiles": [{"name": name, "canonical_session": {"resolved_id": "stored-" + name}} for name in ("slow", "fast")]})
            profile = params.get("profile", "default")
            if method in ("session.activate", "session.resume") and profile == "slow":
                self.entered.set()
                self.held.wait(10)
            server._sessions.setdefault("sid-" + profile, {"session_key": "stored-" + profile})
            return server._ok(request["id"], {"session_id": "sid-" + profile, "messages": []})
        server.handle_request = handle
        def dispatch(request, transport=None):
            if request["method"] not in server._LONG_HANDLERS:
                return server.handle_request(request)
            if not self.retirement.acquire():
                return server._err(request["id"], 5035, "backend is retiring")
            self.native_pool.submit(lambda: transport.write(server.handle_request(request))).add_done_callback(lambda _: self.retirement.release())
            return None
        server.dispatch = dispatch

    def __exit__(self, *exc):
        self.held.set()
        self.native_pool.shutdown(wait=True)
        return super().__exit__(*exc)


class Replies:
    """A connection transport that records what each request ID was answered."""
    def __init__(self):
        self.answers, self.changed = {}, threading.Condition()

    def write(self, response):
        with self.changed:
            self.answers[response["id"]] = response
            self.changed.notify_all()
        return True

    def wait(self, *ids, timeout=3):
        with self.changed:
            return self.changed.wait_for(lambda: all(rid in self.answers for rid in ids), timeout)


def turns(count, files=()):
    """count user/assistant turns; assistants in ``files`` carry an artifact, row IDs from 1."""
    rows = []
    for turn in range(count):
        rows.append({"row_id": len(rows) + 1, "role": "user", "text": f"prompt {turn}"})
        rows.append({"row_id": len(rows) + 1, "role": "assistant", "text": f"reply {turn}",
                     **({"app_artifacts": [{"path": f"/out/{turn}.png"}]} if turn in files else {})})
    return rows


class EventBodyTests(unittest.TestCase):
    def test_keeps_line_breaks_so_the_app_can_read_markdown_structure(self):
        body = extension.event_body("## Fence\r\n\n\n\n|  Post | State |\n|---|---|\n| North   | Set |  \n")
        self.assertEqual(body, "## Fence\n\n| Post | State |\n|---|---|\n| North | Set |")

    def test_stays_bounded_and_empty_text_has_no_body(self):
        self.assertEqual(len(extension.event_body("word " * 400)), 500)
        self.assertIsNone(extension.event_body(" \n\t\n"))

    def test_keeps_indentation_that_places_lines_inside_a_list(self):
        self.assertEqual(extension.event_body("- ```js\n  code   here\n  ```\n\nSummary."), "- ```js\n  code here\n  ```\n\nSummary.")
        self.assertIsNone(extension.event_body(None))


class HistoryWindowTests(unittest.TestCase):
    """extension.history_window must cut exactly where src/shared/history.ts historyWindow does."""
    def cut(self, rows, start=None, turns=0, before=None):
        kept, window = extension.history_window(rows, "sid", start, turns, before)
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

    def test_nothing_is_cut_at_the_start(self):
        self.assertEqual(self.cut(turns(25), start="1"), ([None] * 50, None))
        self.assertIsNone(self.cut(turns(5))[1])

    def test_a_start_inside_a_turn_cuts_there_and_keeps_the_prompt_its_replies_answer(self):
        # Row 32 is the reply to turn 15's prompt, row 31, as a turn read names a turn whose prompt is hidden.
        rows = turns(25, files={3})
        indexes, window = self.cut(rows, start="32")
        self.assertEqual(window, {"earlier": 31, "context": 3})
        self.assertEqual(indexes, [6, 7, 30] + list(range(31, 50)))
        # A start inside the first turn has no prompt before it to keep.
        rows = [{"row_id": 1, "role": "assistant", "text": "greeting"}, {"row_id": 2, "role": "assistant", "text": "more"}] + turns(3)
        self.assertEqual(self.cut(rows, start="2"), ([1, 2, 3, 4, 5, 6, 7], {"earlier": 1, "context": 0}))

    def test_a_page_before_a_row_ends_there_and_says_so(self):
        rows = turns(25, files={3, 20})
        indexes, window = self.cut(rows, before="31", turns=2)
        # Turns 13 and 14 only: nothing from row 31 on, not even turn 20's reply, which carries a file.
        self.assertEqual(window, {"earlier": 26, "context": 2, "before": "31"})
        self.assertEqual(indexes, [6, 7, 26, 27, 28, 29])
        # It counts back from `before`, never from a start sent beside it.
        self.assertEqual(self.cut(rows, start="41", turns=2, before="31"), (indexes, window))
        # A page that reaches the first turn still ends there, so the window names it.
        self.assertEqual(self.cut(rows, before="5", turns=20), ([0, 1, 2, 3], {"earlier": 0, "context": 0, "before": "5"}))
        self.assertEqual(self.cut(rows, before="31", turns=0)[0], [6, 7])

    def test_an_open_ends_a_page_where_the_server_asks(self):
        # As the server asks: `start` too, which an older add-on cuts from.
        with FakeGateway(turns(25)) as hermes:
            value = hermes.open(window={"start": "31", "turns": 2, "before": "31"})
        self.assertEqual(value["app_window"], {"earlier": 26, "context": 0, "before": "31"})
        self.assertEqual([row["row_id"] for row in value["messages"]], list(range(27, 31)))

    def test_a_page_before_a_row_the_history_lost_is_the_latest_page(self):
        rows = turns(25)
        self.assertEqual(self.cut(rows, before="gone"), self.cut(rows))
        self.assertEqual(self.cut(rows, before="gone", start="31", turns=2), self.cut(rows, start="31", turns=2))
        self.assertEqual(self.cut(turns(5), before=7), self.cut(turns(5)))

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


class ProgressLineTests(unittest.TestCase):
    """Hermes projects a model's progress lines onto assistant rows as `display_commentary`. The add-on must hand them on untouched."""
    PROJECTED = {"display_commentary": ["I'll check the forecast first."], "display_content": "", "display_reasoning": "Private notes"}

    def test_an_open_hands_the_projected_fields_through_unchanged(self):
        rows = [{"role": "user", "row_id": 11, "text": "Weather?", "timestamp": 100},
                {"role": "assistant", "row_id": 12, "text": "", "timestamp": 101, **self.PROJECTED},
                {"role": "tool", "row_id": 13, "tool_call_id": "search", "name": "web_search", "args": {}, "app_tool_result": {"ok": True}},
                {"role": "assistant", "row_id": 14, "text": "Sunny.", "timestamp": 102}]
        with FakeGateway(rows) as hermes:
            messages = hermes.open()["messages"]
        row = next(message for message in messages if message.get("row_id") == 12)
        self.assertEqual({key: row[key] for key in self.PROJECTED}, self.PROJECTED)
        self.assertNotIn("display_commentary", next(message for message in messages if message.get("row_id") == 14))

    def test_a_cut_window_keeps_them_on_the_rows_it_keeps(self):
        rows = turns(25)
        rows[-1].update(self.PROJECTED)
        kept, _ = extension.history_window(rows, "sid", None, 0)
        self.assertEqual(kept[-1]["display_commentary"], self.PROJECTED["display_commentary"])
        self.assertEqual(kept[-1]["display_reasoning"], "Private notes")


class OpenTests(unittest.TestCase):
    def test_native_refusals_settle_but_unknown_errors_never_allow_replay(self):
        params = {"profile": "default", "request_id": "refused", "sender_id": "member", "text": "Hello"}
        for code, status in [(-32602, "rejected"), (-32601, "rejected"), (4010, "rejected"), (4001, "rejected"), (4090, "rejected"), (-32603, "uncertain"), (5000, "uncertain")]:
            with self.subTest(code=code), FakeGateway([]) as hermes:
                hermes.open()
                hermes.native_calls.clear()
                hermes.server.handle_request = Mock(return_value=hermes.server._err("native", code, "Native refused input"))
                submit = hermes.methods["agent-interface.submit"]
                original = saved(submit("send", params)["result"])
                self.assertEqual(original["status"], status)
                if status == "rejected":
                    self.assertNotIn("Native refused input", original["message"])
                    self.assertIn("Your draft is saved", original["message"])
                self.assertEqual(hermes.journal.receipt("refused")["status"], status)
                self.assertEqual(submit("retry", params)["result"], original)
                self.assertEqual(hermes.server.handle_request.call_count, 1)
                terminal = hermes.journal.db.execute("SELECT terminal FROM receipts WHERE request_id='refused'").fetchone()[0]
                self.assertEqual(terminal, int(status == "rejected"))

    def test_refusal_unstages_images_and_does_not_block_the_next_send(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            session = hermes.server._sessions["sid"]
            session.update(history_lock=threading.Lock(), attached_images=["prior.png"])
            def refuse(request):
                if request["method"] == "image.attach":
                    # Native appends the resolved path and answers it (methods_prompt.py:1020-1023 at ed1afb0).
                    session["attached_images"].append(request["params"]["path"])
                    return hermes.server._ok(request["id"], {"attached": True, "path": request["params"]["path"]})
                if request["method"] != "prompt.submit":
                    raise AssertionError("Hermes method not configured for this test: " + request["method"])
                return hermes.server._err(request["id"], 4090, "No slot available")
            hermes.server.handle_request = Mock(side_effect=refuse)
            params = {"profile": "default", "request_id": "image", "sender_id": "member", "text": "Hello"}
            submit = hermes.methods["agent-interface.submit"]
            result = submit("send", {**params, "attachments": [{"path": "/new.png", "mime": "image/png"}]})["result"]
            self.assertEqual(result["status"], "rejected")
            self.assertEqual(session["attached_images"], ["prior.png"])
            hermes.server.handle_request = Mock(return_value=hermes.server._ok("native", {"status": "accepted"}))
            self.assertEqual(submit("next", {**params, "request_id": "next"})["result"]["status"], "accepted")
            self.assertEqual(hermes.server.handle_request.call_count, 1)

    def test_image_refusal_still_settles_if_native_closed_the_session(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            session = hermes.server._sessions["sid"]
            session.update(history_lock=threading.Lock(), attached_images=[])
            def closed(request):
                if request["method"] == "image.attach":
                    session["attached_images"].append(request["params"]["path"])
                    return hermes.server._ok(request["id"], {"attached": True, "path": request["params"]["path"]})
                if request["method"] != "prompt.submit":
                    raise AssertionError("Hermes method not configured for this test: " + request["method"])
                hermes.server._sessions.pop("sid")
                return hermes.server._err(request["id"], 4001, "Session not found")
            hermes.server.handle_request = Mock(side_effect=closed)
            result = hermes.methods["agent-interface.submit"]("send", {"profile": "default", "request_id": "closed", "sender_id": "member", "text": "Hello", "attachments": [{"path": "/new.png", "mime": "image/png"}]})["result"]
            self.assertEqual(result["status"], "rejected")
            self.assertEqual(hermes.journal.receipt("closed")["status"], "rejected")

    def test_admitted_steering_closes_the_asks_it_answers_after_every_lock_is_released(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            calls = []
            def admitted(profile, sid, actor, text):
                free = []
                probe = threading.Thread(target=lambda: free.extend(lock.acquire(blocking=False) and (lock.release() or True)
                                                                    for lock in (hermes.bridge.submission_lock, hermes.journal.lock)))
                probe.start(); probe.join()
                calls.append((profile, sid, actor, text, free))
            hermes.journal.steering_admitted = admitted
            submit = hermes.methods["agent-interface.submit"]
            hermes.server.handle_request = Mock(return_value=hermes.server._ok("native", {"status": "accepted"}))
            params = {"profile": "default", "request_id": "first", "sender_id": "member", "text": "Start"}
            submit("send", params)
            self.assertEqual(calls, [])
            hermes.server._sessions["sid"]["running"] = True
            hermes.server.handle_request = Mock(return_value=hermes.server._ok("native", {"status": "queued"}))
            steer = {**params, "request_id": "steer", "text": "Use the other address"}
            self.assertEqual(submit("send", steer)["result"]["status"], "accepted")
            self.assertEqual(calls, [("default", "sid", "member", "Use the other address", [True, True])])
            # A replay, a native refusal and a hook failure close nothing more and still answer.
            submit("again", steer)
            hermes.server.handle_request = Mock(return_value=hermes.server._ok("native", {"status": "rejected"}))
            submit("send", {**params, "request_id": "refused", "text": "Late"})
            hermes.journal.steering_admitted = Mock(side_effect=RuntimeError("hook"))
            hermes.server.handle_request = Mock(return_value=hermes.server._ok("native", {"status": "queued"}))
            with self.assertLogs(level="ERROR"):
                self.assertEqual(submit("send", {**params, "request_id": "third", "text": "Again"})["result"]["status"], "accepted")
            self.assertEqual(len(calls), 1)

    def test_the_steering_decision_survives_admission_receipt_recovery_and_history(self):
        rows = [{"row_id": 1, "role": "user", "text": "Start"}, {"row_id": 2, "role": "user", "text": "Use the other address"}]
        with FakeGateway(rows) as hermes:
            hermes.open()
            submit, native = hermes.methods["agent-interface.submit"], hermes.server.handle_request
            hermes.server.handle_request = Mock(return_value=hermes.server._ok("native", {"status": "accepted"}))
            params = {"profile": "default", "request_id": "first", "sender_id": "member", "text": "Start"}
            self.assertIs(submit("send", params)["result"]["steering"], False)
            hermes.server._sessions["sid"]["running"] = True
            hermes.server.handle_request = Mock(return_value=hermes.server._ok("native", {"status": "queued"}))
            steer = {**params, "request_id": "steer", "text": "Use the other address"}
            self.assertIs(submit("send", steer)["result"]["steering"], True)
            # A replay answers the saved decision, however the session moved since.
            hermes.server._sessions["sid"]["running"] = False
            self.assertIs(submit("again", steer)["result"]["steering"], True)
            lookup = lambda key: hermes.methods["agent-interface.receipt"]("lookup", {"request_id": key})["result"]["receipt"]
            self.assertEqual((lookup("first")["steering"], lookup("steer")["steering"]), (False, True))
            with hermes.journal.db:
                hermes.journal.db.execute("UPDATE receipts SET row_id=1 WHERE request_id='first'")
                hermes.journal.db.execute("UPDATE receipts SET row_id=2 WHERE request_id='steer'")
            hermes.server.handle_request = native
            messages = {row["row_id"]: row for row in hermes.open()["messages"]}
            self.assertNotIn("app_steering", messages[1])
            self.assertIs(messages[2]["app_steering"], True)
            self.assertEqual(messages[2]["app_request_id"], "steer")

    def test_submit_resolves_canonical_and_preserves_interruption_guard(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            hermes.native_calls.clear()
            submit=hermes.methods["agent-interface.submit"]
            params={"profile":"default","request_id":"one","sender_id":"member","text":"Hello"}
            result=saved(submit("send",params)["result"])
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

    def test_voice_turn_reaches_native_submit_only_for_a_new_turn(self):
        base = {"profile": "default", "request_id": "one", "sender_id": "member", "text": "Weather?"}
        # Only a literal true marks the turn. A steer joins the running turn, whose route is already bound.
        for mark, running, expected in [(True, False, ("prompt.submit", True)), ("true", False, ("prompt.submit", None)),
                                        (None, False, ("prompt.submit", None)), (True, True, ("session.steer", None))]:
            with self.subTest(mark=mark, running=running), FakeGateway([]) as hermes:
                hermes.open()
                hermes.native_calls.clear()
                hermes.modules["tui_gateway.server"]._sessions["sid"]["running"] = running
                params = {**base, **({"voice_turn": mark} if mark is not None else {})}
                self.assertEqual(hermes.methods["agent-interface.submit"]("send", params)["result"]["status"], "accepted")
                self.assertEqual([(method, params.get("voice_turn")) for method, params in hermes.native_calls], [expected])

    def test_submit_response_survives_restart_without_canonical_activation(self):
        params = {"profile": "default", "request_id": "one", "sender_id": "member", "text": "Hello"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "journal.db"
            with FakeGateway([], journal_path=path) as hermes:
                original = saved(hermes.methods["agent-interface.submit"]("send", params)["result"])
                self.assertEqual((original["status"], original["userRowId"]), ("accepted", None))
                with hermes.journal.db:
                    hermes.journal.db.execute("UPDATE receipts SET row_id=42 WHERE request_id='one'")
                epoch = hermes.journal.epoch
            for _ in range(2):
                with FakeGateway([], journal_path=path) as hermes:
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
            "native-refusal": ("rejected", "Hermes was starting or reconnecting and did not accept this message. Your draft is saved. Try sending it again."),
        }
        for mode, (status, message) in failures.items():
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "journal.db"
                params = {"profile": "default", "request_id": "failed", "sender_id": "member", "text": "Hello"}
                with FakeGateway([], journal_path=path) as hermes:
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
                            # Fails after its append, so its answer names no path.
                            session["attached_images"].append(request["params"]["path"])
                            raise RuntimeError("Synthetic image failure")
                        native.side_effect = fail_image
                    elif mode == "native":
                        native.side_effect = RuntimeError("Synthetic native failure")
                    elif mode == "native-refusal":
                        session["running"] = True
                        native.return_value = server._err("native", 4010, "Agent does not support steer")
                    original = saved(submit("send", params)["result"])
                    self.assertEqual((original["status"], original["message"]), (status, message))
                    self.assertEqual(native.call_count, int(mode in ("image-preparation", "native", "native-refusal")))
                    if mode == "image-preparation":
                        self.assertEqual(session["attached_images"], ["prior.png"])
                    native.reset_mock()
                    self.assertEqual(submit("retry", params)["result"], original)
                    native.assert_not_called()
                with FakeGateway([], journal_path=path) as hermes:
                    self.assertEqual(hermes.methods["agent-interface.submit"]("retry", params)["result"], original)
                    self.assertEqual(hermes.native_calls, [])

    def test_old_receipt_without_snapshot_recovers_conservatively(self):
        params = {"profile": "default", "request_id": "old", "sender_id": "member", "text": "Hello"}
        # Dropping the new column reproduces the preceding journal schema. A NULL
        # snapshot also covers a crash after durable intent but before a response.
        for old_schema in (False, True):
            with self.subTest(old_schema=old_schema), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "journal.db"
                with FakeGateway([], journal_path=path) as hermes:
                    hermes.methods["agent-interface.submit"]("send", params)
                    with hermes.journal.db:
                        if old_schema:
                            hermes.journal.db.execute("ALTER TABLE receipts DROP COLUMN admission_response")
                        else:
                            hermes.journal.db.execute("UPDATE receipts SET admission_response=NULL,status='uncertain' WHERE request_id='old'")
                with FakeGateway([], journal_path=path) as hermes:
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
                with FakeGateway([], journal_path=path) as hermes:
                    self.assertEqual(hermes.methods["agent-interface.submit"]("retry", params)["result"], recovered)
                    self.assertEqual(hermes.native_calls, [])

    def test_submit_rejects_changed_input_before_refresh_or_interruption_guard(self):
        with FakeGateway([]) as hermes:
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

    def test_every_error_a_send_answers_before_admission_leaves_no_receipt_and_calls_nothing_in_hermes(self):
        """src/server/hermes.ts reports these as a message that was not sent (BEFORE_ADMISSION). A new error code,
        or a new place one of these is answered after the receipt is written, must not be added to that set."""
        with FakeGateway([]) as hermes:
            hermes.open()
            submit = hermes.methods["agent-interface.submit"]
            first = {"profile": "default", "request_id": "one", "sender_id": "member", "text": "Hello"}
            self.assertEqual(submit("send", first)["result"]["status"], "accepted")
            receipts = lambda: hermes.journal.db.execute("SELECT request_id, digest, status FROM receipts ORDER BY request_id").fetchall()
            before = receipts()
            hermes.native_calls.clear()
            cases = (
                ("no request ID", {**first, "request_id": ""}, -32602, "request_id, sender_id and non-empty text required"),
                ("no sender", {**first, "request_id": "two", "sender_id": ""}, -32602, "request_id, sender_id and non-empty text required"),
                ("blank text and no attachments", {**first, "request_id": "three", "text": "  "}, -32602, "request_id, sender_id and non-empty text required"),
                ("another conversation than the profile's canonical one", {**first, "request_id": "four", "session_id": "not-canonical"},
                 -32602, "Open this profile's canonical conversation before admission"),
                ("a request ID that already names different text", {**first, "text": "Changed"}, 4093, "Request ID already belongs to a different input"),
            )
            for name, params, code, message in cases:
                with self.subTest(name):
                    error = submit("refused", params)["error"]
                    self.assertEqual((error["code"], error["message"]), (code, message))
                    self.assertEqual(receipts(), before)
                    self.assertEqual(hermes.native_calls, [])

    def test_submit_requires_review_after_stopped_terminal_or_inflight(self):
        for mode in ("terminal", "inflight", "cold"):
            with self.subTest(mode=mode), FakeGateway([]) as hermes:
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
        with FakeGateway(turns(1)) as hermes:
            hermes.open()
            session = hermes.modules["tui_gateway.server"]._sessions["sid"]
            session.update(history=hermes.messages, history_lock=threading.Lock(), profile_home=hermes.directory.name)
            hermes.open()
            cache, canonical = hermes.bridge.decorated, hermes.bridge.canonical
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
        with FakeGateway(turns(25, files={3})) as hermes:
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
            # The open says the decorated history answered it.
            self.assertEqual(hit["app_cache"]["decorated"], 1)
            self.assertFalse(any("FROM tools" in sql or "row_id IN" in sql for sql in seen))
            # Only this assistant's receipts and tools are decorated history: another assistant's writes and events keep it.
            def receipt(profile, request_id, db=hermes.journal.db):
                with db:
                    db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,actor,epoch,status,created) VALUES(?,?,?,?,?,?,?,?)",
                               (request_id, "d", profile, "sid", "member", "e", "accepted", 0))
            receipt("other", "elsewhere")
            hermes.journal.event("default", "sid", "completed", "Result")
            hermes.open()
            self.assertTrue(hermes.native_calls[-1][1]["omit_messages"])
            with hermes.journal.db:
                hermes.journal.db.execute("INSERT INTO tools(profile,stored_session,tool_id,result) VALUES(?,?,?,?)", ("default", "sid", "call", "{}"))
            hermes.open()
            self.assertNotIn("omit_messages", hermes.native_calls[-1][1])
            hermes.open()
            self.assertTrue(hermes.native_calls[-1][1]["omit_messages"])
            # Another connection's write counts too, as from the dashboard's process.
            other = sqlite3.connect(hermes.journal_file)
            receipt("default", "from-another-process", other)
            other.close()
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

    def test_every_write_to_a_profiles_receipts_and_tools_moves_only_its_version(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = extension.Journal(Path(directory) / "agent-interface.db")
            db = journal.db
            with db:
                db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,actor,epoch,status,created) VALUES('r','d','a','s','m','e','accepted',0)")
                db.execute("INSERT INTO tools(id,profile,stored_session,tool_id,result) VALUES(1,'a','s','t','{}')")
            for statement, moved in (
                ("INSERT INTO receipts(request_id,digest,profile,session_id,actor,epoch,status,created) VALUES('r2','d','a','s','m','e','accepted',0)", {"a": 1}),
                ("UPDATE receipts SET row_id=7 WHERE request_id='r'", {"a": 1}),
                ("DELETE FROM receipts WHERE request_id='r2'", {"a": 1}),
                ("INSERT INTO tools(profile,stored_session,tool_id,result) VALUES('a','s','t2','{}')", {"a": 1}),
                ("UPDATE tools SET artifacts='[]' WHERE id=1", {"a": 1}),
                ("DELETE FROM tools WHERE tool_id='t2'", {"a": 1}),
                # A row that moves to another profile changes both histories.
                ("UPDATE receipts SET profile='b' WHERE request_id='r'", {"a": 1, "b": 1}),
                ("INSERT INTO events(profile,session_id,kind,title,occurred,epoch) VALUES('a','s','completed','Done',0,'e')", {}),
                ("INSERT INTO interruptions(profile,stored_session,request_id,created) VALUES('a','s','r',0)", {}),
            ):
                with self.subTest(statement=statement):
                    before = {profile: journal.version(profile) for profile in "ab"}
                    with db:
                        db.execute(statement)
                    self.assertEqual({profile: journal.version(profile) - before[profile] for profile in "ab"}, {"a": 0, "b": 0, **moved})
            db.close()

    def test_one_assistants_slow_open_never_holds_up_anothers(self):
        with ProfilesGateway() as hermes:
            hermes.held["slow"] = threading.Event()
            slow, fast = [], []
            waiting = hermes.opening("slow", slow)
            self.assertTrue(hermes.entered["slow"].wait(5))
            # A global open lock would queue this behind the held activation.
            hermes.opening("fast", fast).join(2)
            self.assertEqual([result["session_id"] for result in fast], ["sid-fast"])
            self.assertEqual(slow, [])
            hermes.held["slow"].set()
            waiting.join(5)
            self.assertEqual(slow[0]["session_id"], "sid-slow")

    def test_one_assistants_opens_still_run_one_at_a_time(self):
        with ProfilesGateway() as hermes:
            hermes.held["slow"] = threading.Event()
            results = []
            first = hermes.opening("slow", results)
            self.assertTrue(hermes.entered["slow"].wait(5))
            second = hermes.opening("slow", results)
            time.sleep(0.2)
            self.assertEqual((hermes.inside["slow"], results), (1, []))
            hermes.held["slow"].set()
            first.join(5); second.join(5)
            self.assertEqual(hermes.peak["slow"], 1)
            # The second open reports the time it spent behind the first.
            self.assertGreaterEqual(max(result["app_timing"]["wait"] for result in results), 150)
            self.assertEqual(hermes.bridge.canonical, {"slow": "sid-slow"})

    def test_a_send_never_waits_behind_its_assistants_history_read(self):
        with ProfilesGateway() as hermes:
            hermes.open(profile="slow")
            hermes.held["slow"] = threading.Event()
            hermes.entered["slow"].clear()
            reading = hermes.opening("slow", [])
            self.assertTrue(hermes.entered["slow"].wait(5))
            sent = []
            params = {"profile": "slow", "request_id": "send", "sender_id": "member", "text": "Hello"}
            sending = threading.Thread(target=lambda: sent.append(hermes.methods["agent-interface.submit"]("send", params)), daemon=True)
            sending.start(); sending.join(2)
            self.assertEqual([response["result"]["status"] for response in sent], ["accepted"])
            hermes.held["slow"].set()
            reading.join(5)

    def test_open_reports_its_phases_in_milliseconds(self):
        with FakeGateway(turns(2)) as hermes:
            timing = hermes.open(window={"turns": 20})["app_timing"]
            self.assertEqual(set(timing), {"wait", "activate", "decorate", "window", "total"})
            self.assertTrue(all(isinstance(value, float) and value >= 0 for value in timing.values()))
            self.assertGreaterEqual(timing["total"], timing["activate"])

    def test_decorated_history_outlives_an_overnight_idle_until_its_bound(self):
        with FakeGateway(turns(3)) as hermes:
            hermes.open()
            session = hermes.modules["tui_gateway.server"]._sessions["sid"]
            session.update(history=hermes.messages, history_lock=threading.Lock(), profile_home=hermes.directory.name)
            hermes.open()
            stored = time.monotonic()
            # Coming back to an unchanged chat the next morning reuses its exact decorated history, rather than reading
            # and decorating every row again.
            with patch.object(extension.time, "monotonic", return_value=stored + 12 * 60 * 60):
                self.assertEqual(len(hermes.open()["messages"]), 6)
            self.assertTrue(hermes.native_calls[-1][1].get("omit_messages"))
            with patch.object(extension.time, "monotonic", return_value=stored + extension.DECORATED_TTL + 1):
                hermes.open()
            self.assertNotIn("omit_messages", hermes.native_calls[-1][1])

    def test_decorated_history_follows_native_redaction_registries(self):
        with FakeGateway(turns(3)) as hermes:
            hermes.open()
            session = hermes.modules["tui_gateway.server"]._sessions["sid"]
            session.update(history=hermes.messages, history_lock=threading.Lock(), profile_home=hermes.directory.name)
            hermes.open()
            hermes.open()
            self.assertTrue(hermes.native_calls[-1][1].get("omit_messages"))
            # A vault fill or plugin pattern scrubs native commentary without touching history.
            for registry, value in ((hermes.redact._VAULT_REDACTION_VALUES, {"secret": None}), (hermes.redact._PLUGIN_PREFIX_PATTERNS, ["tok_"])):
                registry["/home/default"] = value
                hermes.open()
                self.assertNotIn("omit_messages", hermes.native_calls[-1][1])
                hermes.open()
                self.assertTrue(hermes.native_calls[-1][1].get("omit_messages"))
            # A Hermes that keeps them elsewhere gets only the short lifetime.
            with patch.dict(sys.modules, {"agent.redact": None}):
                hermes.open()
                stored = time.monotonic()
                with patch.object(extension.time, "monotonic", return_value=stored + extension.UNTRACKED_REDACTION_TTL - 1):
                    hermes.open()
                self.assertTrue(hermes.native_calls[-1][1].get("omit_messages"))
                with patch.object(extension.time, "monotonic", return_value=stored + extension.UNTRACKED_REDACTION_TTL + 1):
                    hermes.open()
                self.assertNotIn("omit_messages", hermes.native_calls[-1][1])

    def test_the_configuration_of_the_home_hermes_runs_in_ends_a_profiles_decorated_history(self):
        # Hermes labels tools in the language configured where it runs, not only in the profile's home.
        with FakeGateway(turns(3)) as hermes, tempfile.TemporaryDirectory() as launch:
            hermes.bridge.get_hermes_home = lambda: launch
            hermes.open()
            session = hermes.modules["tui_gateway.server"]._sessions["sid"]
            session.update(history=hermes.messages, history_lock=threading.Lock(), profile_home=hermes.directory.name)
            hermes.open()
            hermes.open()
            self.assertTrue(hermes.native_calls[-1][1].get("omit_messages"))
            (Path(launch) / "config.yaml").write_text("display:\n  language: fr\n")
            hermes.open()
            self.assertNotIn("omit_messages", hermes.native_calls[-1][1])

    def test_eviction_keeps_the_most_recently_read_histories(self):
        clock = Mock(return_value=100)
        with FakeGateway(turns(1)) as hermes, patch.object(extension.time, "monotonic", clock), patch.object(extension, "DECORATED_LIMIT", 2):
            hermes.open()
            sessions = hermes.modules["tui_gateway.server"]._sessions
            sessions["sid"].update(history=hermes.messages, history_lock=threading.Lock(), profile_home=hermes.directory.name)
            hermes.open()
            clock.return_value = 300
            hermes.open()
            cache = hermes.bridge.decorated
            # A hit refreshes its read time; its lifetime still counts from the fill.
            self.assertEqual(cache["sid"][3:], (100, 300))
            for sid, filled, read in (("read-recently", 50, 350), ("filled-recently", 200, 200)):
                hermes.bridge.canonical[sid], sessions[sid] = sid, dict(sessions["sid"])
                cache[sid] = (*cache["sid"][:3], filled, read)
            clock.return_value = 400
            sessions["sid"]["history"] = hermes.messages = turns(2)
            hermes.open()
            self.assertEqual(sorted(cache), ["read-recently", "sid"])

    def test_light_open_skips_native_history_and_a_window_cuts_it(self):
        with FakeGateway(turns(25, files={3})) as hermes:
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


class AdmissionTurnTests(unittest.TestCase):
    """Whether a new task started its own turn, as native prompt.submit answered."""
    def submit(self, hermes, rid, native, **extra):
        """Submit with Hermes answering ``native``: a prompt.submit or session.steer status, or a whole answer."""
        calls = []
        # The gateway's own activation answers opens; admission answers ``native``; anything else is unexpected.
        opens = hermes.__dict__.setdefault("activation", hermes.server.handle_request)
        def handle(request):
            if request["method"] in ("session.activate", "session.resume", "profiles.list"):
                return opens(request)
            calls.append(request["method"])
            if request["method"] not in ("prompt.submit", "session.steer"):
                raise AssertionError("Hermes method not configured for this test: " + request["method"])
            return hermes.server._ok(request["id"], native if isinstance(native, dict) else {"status": native})
        hermes.server.handle_request = handle
        params = {"profile": "default", "request_id": rid, "sender_id": "member", "text": "Hello " + rid, **extra}
        return hermes.methods["agent-interface.submit"](rid, params)["result"], calls, params

    def lookup(self, hermes, rid):
        """The receipt a server reads after a lost answer."""
        return hermes.methods["agent-interface.receipt"]("lookup", {"request_id": rid})["result"]["receipt"]

    def test_a_new_task_says_what_hermes_did_with_its_turn(self):
        # The add-on read the session idle; Hermes's answer says whether a turn had taken it meanwhile.
        # Answers pinned from ed1afb0: methods_prompt.py:973 and :762, compute_host_bridge.py:327, session_auto_continue.py:259 and :454.
        for native, turn in [("streaming", "started"), ({"status": "streaming", "turn_isolation": True}, "started"), ("queued", "queued"),
                             ({"status": "queued", "admission_id": "a1", "forwarded": True}, "queued"),
                             ("redirected", "joined"), ("steered", "joined"),
                             # An answer this add-on does not know is never taken for a started turn.
                             ("accepted", "unknown"), ({}, "unknown"), ({"voice_stopped": False}, "unknown")]:
            with self.subTest(native=native), FakeGateway([]) as hermes:
                hermes.open()
                answer, calls, params = self.submit(hermes, "send", native)
                self.assertEqual((calls, answer["status"], answer["steering"], answer["runId"], answer.get("turn")),
                                 (["prompt.submit"], "accepted", False, "send", turn))
                # A replay answers the same, from what the journal saved, and so does the lookup after a lost answer.
                self.assertEqual(hermes.methods["agent-interface.submit"]("again", params)["result"], saved(answer))
                self.assertEqual(self.lookup(hermes, "send")["turn"], turn)

    def test_a_typed_stop_admits_nothing_and_holds_up_no_later_send(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            with hermes.journal.db:
                hermes.journal.db.execute("INSERT INTO interruptions VALUES('default','stored','old',1)")
            # Hermes's answer to a stop phrase typed while the session's voice mode is on (methods_prompt.py:265-268).
            answer, calls, params = self.submit(hermes, "stop", {"voice_stopped": True}, reviewed_interruption=True)
            self.assertEqual((calls, answer["status"], answer["steering"], answer["turn"]), (["prompt.submit"], "accepted", False, "none"))
            self.assertIn("voice chat", answer["message"])
            self.assertEqual(hermes.methods["agent-interface.submit"]("again", params)["result"], saved(answer))
            # A server that lost the answer learns from the lookup that nothing was admitted, so the typed words stay a draft.
            self.assertEqual((self.lookup(hermes, "stop")["status"], self.lookup(hermes, "stop")["turn"]), ("accepted", "none"))
            self.assertEqual(hermes.journal.db.execute("SELECT terminal FROM receipts WHERE request_id='stop'").fetchone(), (1,))
            # No run is open, so an open names none and the next send is not held up as a task Hermes is finishing.
            self.assertIsNone(hermes.open()["app_run_id"])
            # Nothing ran, so the interruption still needs its review.
            unreviewed = hermes.methods["agent-interface.submit"]("send", {"profile": "default", "request_id": "unreviewed", "sender_id": "member", "text": "Next"})
            self.assertEqual(unreviewed["error"]["code"], 4094)
            following, _, _ = self.submit(hermes, "next", "streaming", reviewed_interruption=True)
            self.assertEqual((following["status"], following["runId"], following["turn"]), ("accepted", "next", "started"))

    def test_an_unknown_answer_stays_open_for_the_turn_it_may_have_started(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            answer, _, _ = self.submit(hermes, "unknown", "accepted")
            self.assertEqual((answer["status"], answer["turn"]), ("accepted", "unknown"))
            # Only a turn's end settles it, so it is not terminal.
            self.assertEqual(hermes.journal.db.execute("SELECT terminal FROM receipts WHERE request_id='unknown'").fetchone(), (0,))
            # With Hermes idle, a different send is refused as the preceding task finishing, not admitted beside it.
            refused, calls, _ = self.submit(hermes, "next", "streaming")
            self.assertEqual(calls, [])
            self.assertEqual((refused["status"], refused["message"]), ("rejected", "Hermes is finishing the preceding task. Your input was not admitted; send it again after the task settles."))

    def test_a_steer_carries_no_turn_though_hermes_answers_it_queued(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            self.submit(hermes, "first", "streaming")
            hermes.server._sessions["sid"]["running"] = True
            # Native session.steer answers "queued" when it accepts the text into the running turn.
            answer, calls, _ = self.submit(hermes, "steer", "queued")
            self.assertEqual((calls, answer["status"], answer["steering"], answer["runId"]), (["session.steer"], "accepted", True, "first"))
            self.assertNotIn("turn", answer)
            self.assertNotIn("turn", self.lookup(hermes, "steer"))

    def test_a_refusal_carries_no_turn_in_its_answer_or_its_lookup(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            self.submit(hermes, "first", "streaming")
            hermes.server._sessions["sid"]["running"] = True
            refused, calls, _ = self.submit(hermes, "image", "streaming", attachments=[{"path": "/tmp/a.png", "name": "a.png", "mime": "image/png"}], steer=True)
            self.assertEqual((calls, refused["status"]), ([], "rejected"))
            self.assertNotIn("turn", refused)
            self.assertEqual(self.lookup(hermes, "image")["status"], "rejected")
            self.assertNotIn("turn", self.lookup(hermes, "image"))

    def test_an_answer_saved_before_the_add_on_stored_a_started_turn_says_nothing_about_it(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            answer, _, params = self.submit(hermes, "old", "streaming")
            self.assertEqual(answer["turn"], "started")
            # An add-on older than this field saved the same answer without it, for a turn it started or one it queued.
            with hermes.journal.db:
                stored = json.loads(hermes.journal.db.execute("SELECT admission_response FROM receipts WHERE request_id='old'").fetchone()[0])
                del stored["turn"]
                hermes.journal.db.execute("UPDATE receipts SET admission_response=? WHERE request_id='old'", (json.dumps(stored),))
            # The replay and the lookup do not invent a started turn for it.
            self.assertEqual(hermes.methods["agent-interface.submit"]("again", params)["result"], stored)
            self.assertNotIn("turn", hermes.methods["agent-interface.submit"]("again", params)["result"])
            self.assertEqual(self.lookup(hermes, "old")["status"], "accepted")
            self.assertNotIn("turn", self.lookup(hermes, "old"))
            # A receipt whose answer was never saved has no turn to give either.
            with hermes.journal.db:
                hermes.journal.db.execute("UPDATE receipts SET admission_response=NULL WHERE request_id='old'")
            self.assertNotIn("turn", self.lookup(hermes, "old"))

    def test_the_add_on_says_it_reports_the_turn(self):
        with FakeHermes([]) as hermes:
            self.assertIs(hermes.registered["agent-interface.capabilities"]("caps", {})["result"]["admission_turn"], True)

    def test_the_add_on_says_it_honors_a_maintenance_deadline(self):
        # An older add-on ignores the parameter and would write a lease after its caller gave up, so a caller asks first.
        with FakeHermes([]) as hermes:
            self.assertIs(hermes.registered["agent-interface.capabilities"]("caps", {})["result"]["maintenance_deadline"], True)


class InlineGuidanceTests(unittest.TestCase):
    def pending_app_turn(self, hermes):
        receipt(hermes.journal.db, "app-root", 1, time.time(), text="Original user text")
        hermes.journal.db.execute("UPDATE receipts SET terminal=0,session_id='sid' WHERE request_id='app-root'")

    def test_current_native_invocation_uses_post_model_switch_agent_and_restores_on_error(self):
        with FakeHermes([], invocation=True) as hermes:
            hermes.journal.memory_refresh.before_turn = Mock()
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
            self.assertEqual(hermes.journal.memory_refresh.before_turn.call_count, 4)
            hermes.journal.memory_refresh.before_turn.assert_called_with("default", session, agent)

    def test_app_turns_drop_the_native_first_contact_note_and_others_keep_it(self):
        intro = "[System note: This is the user's very first message ever. Introduce yourself and mention /help.]"
        offer = "[System note: This is the user's very first message ever. OFFER to build a profile:\n  1. Ask.]"
        with FakeHermes([], invocation=True) as hermes:
            hermes.journal.memory_refresh.before_turn = Mock()
            server = hermes.modules["tui_gateway.server"]
            hermes.open()
            self.pending_app_turn(hermes)
            session = server._sessions["sid"]
            for note in (intro, offer):
                agent = types.SimpleNamespace(ephemeral_system_prompt="", _gateway_turn_context_notes=f"Daybreak note.\n\n{note}")
                with self.assertRaises(RuntimeError):
                    server._invoke_agent("sid", session, types.SimpleNamespace(agent=agent), None, None, None, [], None, None, None, "Original user text")
                self.assertEqual(agent._gateway_turn_context_notes, "Daybreak note.")
            # Another client's turn in the same session keeps Hermes's own note.
            agent = types.SimpleNamespace(ephemeral_system_prompt="", _gateway_turn_context_notes=intro)
            with self.assertRaises(RuntimeError):
                server._invoke_agent("sid", session, types.SimpleNamespace(agent=agent), None, None, None, [], None, None, None, "Other client text")
            self.assertEqual(agent._gateway_turn_context_notes, intro)

    def test_memory_refresh_runs_at_goal_and_steering_invocation_boundaries(self):
        with FakeHermes([], invocation=True) as hermes:
            server = hermes.modules["tui_gateway.server"]
            hermes.open()
            session = server._sessions["sid"]
            session['agent'] = agent = types.SimpleNamespace(ephemeral_system_prompt='Original system')
            refresh = hermes.journal.memory_refresh.before_turn = Mock()
            for kind in ('goal_continue', 'steering'):
                with self.assertRaisesRegex(RuntimeError, 'Synthetic provider failure'):
                    server._invoke_agent('sid', session, types.SimpleNamespace(agent=agent), None, None, None, [], kind, None, None, 'Followup')
                refresh.assert_called_with('default', session, agent)
            self.assertEqual(refresh.call_count, 2)
            self.assertEqual([text for _, text in hermes.invoked], ['Followup', 'Followup'])

    def test_memory_refresh_hook_ignores_other_native_sessions_in_the_same_profile(self):
        with FakeHermes([], invocation=True) as hermes:
            server = hermes.modules['tui_gateway.server']
            hermes.open()
            agent = types.SimpleNamespace(ephemeral_system_prompt='Native frozen system')
            native = dict(session_key='native-stored', agent=agent)
            server._sessions['native-chat'] = native
            refresh = hermes.journal.memory_refresh.before_turn = Mock()
            with self.assertRaisesRegex(RuntimeError, 'Synthetic provider failure'):
                server._invoke_agent('native-chat', native, types.SimpleNamespace(agent=agent), None, None, None, [], None, None, None, 'Native chat text')
            refresh.assert_not_called()
            self.assertEqual(hermes.invoked[-1], ('Native frozen system', 'Native chat text'))

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
            # Every app turn says it, once, so the model writes a progress line before slow tool work.
            self.assertEqual(observed.values[0].count("what you understood and what you will check first"), 1)
            self.assertIn("Do not name tools", observed.values[0])
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
            # A steer Hermes delivered mid-turn, typed a steer and without an admission row ID.
            {"role": "user", "row_id": 13, "text": "Shorter please", "timestamp": 101, "display_kind": "steer"},
            {"role": "assistant", "row_id": 14, "text": "Summary", "timestamp": 102},
            {"role": "user", "row_id": 20, "text": image_text("", ["/srv/photo.png"]), "timestamp": 200},
            {"role": "tool", "row_id": 21, "tool_call_id": "read", "name": "read_file", "args": {"path": "other.pdf"}, "app_tool_result": {"pages": 3}},
            {"role": "user", "row_id": 30, "text": "From the desktop", "timestamp": 300},
            {"role": "tool", "row_id": 31, "tool_call_id": "read", "name": "read_file", "args": {}, "app_tool_result": {"pages": 3}},
            {"role": "system", "text": "Compacted", "timestamp": 301},
        ]
        with FakeGateway(messages) as hermes:
            db = hermes.journal.db
            with db:
                receipt(db, "first", 10, 1, text="Summarize\n@file:\"/srv/report.pdf\"", attachments=[report], actor="kimberly")
                # The root's turn finished and reported its committed rows, which leave the steer's row out.
                db.execute("UPDATE receipts SET turn_rows='[10, 11, 12, 14]' WHERE request_id='first'")
                receipt(db, "steer", None, 2, run_id="first", text="Shorter please", steering=1)
                receipt(db, "photo", 20, 3, attachments=[photo])
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
            {**messages[3], "app_request_id": "steer", "app_sender_id": "nicolas", "app_run_id": "first", "app_attachments": [], "app_display_text": "Shorter please", "app_steering": True},
            {**messages[4], "app_run_id": "first"},
            {**messages[5], "app_request_id": "photo", "app_sender_id": "nicolas", "app_run_id": "photo", "app_attachments": [photo], "app_display_text": ""},
            {**messages[6], "app_run_id": "photo", "app_artifacts": []},
            messages[7], messages[8], messages[9],
        ])
        self.assertEqual(value["app_tool_calls"], [])

    def statements(self, turns):
        messages, write = history(turns)
        with FakeGateway(messages) as hermes:
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
        with FakeGateway(messages) as hermes:
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


class MaintenanceLeaseTests(unittest.TestCase):
    def hermes(self, directory):
        self.lease = Path(directory) / "state" / "maintenance.json"
        return FakeHermes([], environment={"HERMES_AGENT_INTERFACE_MAINTENANCE_FILE": str(self.lease), "HERMES_AGENT_INTERFACE_TOKEN": "key"})

    def lease_call(self, hermes, action, operation="operation-1", key="key"):
        return hermes.methods["agent-interface.maintenance"]("lease", {"service_key": key, "action": action, "operation_id": operation})

    def test_a_held_lease_fences_native_admission_but_not_reads_until_released(self):
        with tempfile.TemporaryDirectory() as directory, self.hermes(directory) as hermes:
            server = hermes.server
            self.assertEqual(self.lease_call(hermes, "acquire", key="wrong")["error"]["code"], 403)
            self.assertEqual(self.lease_call(hermes, "acquire")["result"], {"active": True, "operationId": "operation-1", "busy": []})
            self.assertEqual(stat.S_IMODE(self.lease.stat().st_mode), 0o600)
            self.assertEqual(server.handle_request({"id": 1, "method": "prompt.submit", "params": {}})["error"]["code"], 409)
            self.assertEqual(server.dispatch({"id": 2, "method": "session.steer", "params": {}})["error"]["code"], 409)
            self.assertIn("result", server.handle_request({"id": 3, "method": "profiles.list", "params": {}}))
            self.assertFalse(hermes.retirement.acquire())
            self.assertEqual(self.lease_call(hermes, "acquire", "operation-2")["error"]["code"], 409)
            self.assertEqual(self.lease_call(hermes, "release")["result"]["active"], False)
            self.assertFalse(self.lease.exists())
            self.assertIn("result", server.handle_request({"id": 4, "method": "prompt.submit", "params": {}}))
            self.assertTrue(hermes.retirement.acquire())

    def test_busy_work_refuses_a_lease_and_an_unsafe_lease_file_closes_admission(self):
        with tempfile.TemporaryDirectory() as directory, self.hermes(directory) as hermes:
            hermes.server._sessions["sid"] = {"session_key": "stored", "running": True}
            refused = self.lease_call(hermes, "acquire")
            self.assertEqual((refused["error"]["code"], self.lease.exists()), (409, False))
            self.lease.parent.mkdir()
            self.lease.write_text('{"operationId": "installer"}')
            self.lease.chmod(0o640)
            with self.assertRaisesRegex(RuntimeError, "not private"):
                hermes.server.handle_request({"id": 1, "method": "prompt.submit", "params": {}})
            # A dangling link is not a missing lease: admission stays closed until repaired.
            self.lease.unlink()
            self.lease.symlink_to(Path(directory) / "missing.json")
            with self.assertRaisesRegex(RuntimeError, "not private"):
                hermes.server.handle_request({"id": 2, "method": "prompt.submit", "params": {}})

class ReadQueueTests(unittest.TestCase):
    def test_one_slow_assistants_reads_never_take_hermes_native_workers(self):
        with PooledHermes() as hermes:
            replies, server = Replies(), hermes.server
            opens = [server.dispatch({"id": f"slow-{index}", "method": "agent-interface.open", "params": {"profile": "slow"}}, replies) for index in range(8)]
            self.assertEqual(opens, [None] * 8)
            self.assertTrue(hermes.entered.wait(3))
            # As many reads as Hermes has workers, all behind one held activation. Native long
            # handlers and another assistant's read still answer.
            self.assertIsNone(server.dispatch({"id": "roster", "method": "profiles.list", "params": {}}, replies))
            server.dispatch({"id": "fast", "method": "agent-interface.open", "params": {"profile": "fast"}}, replies)
            server.dispatch({"id": "discover", "method": "agent-interface.discover", "params": {"cursor": "0"}}, replies)
            self.assertTrue(replies.wait("roster", "fast"), replies.answers)
            self.assertEqual(replies.answers["fast"]["result"]["session_id"], "sid-fast")
            self.assertFalse(any(rid.startswith("slow") for rid in replies.answers))
            # Each queued read holds a native admission reservation until it is answered.
            self.assertGreaterEqual(hermes.active[0], 8)
            hermes.held.set()
            self.assertTrue(replies.wait(*(f"slow-{index}" for index in range(8))))
            self.assertTrue(all(replies.answers[f"slow-{index}"]["result"]["session_id"] == "sid-slow" for index in range(8)))
            deadline = time.monotonic() + 3
            while hermes.active[0] and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(hermes.active[0], 0)

    def test_direct_calls_and_writes_keep_native_dispatch(self):
        with PooledHermes() as hermes:
            server = hermes.server
            # In-process callers and requests without a connection transport answer synchronously.
            self.assertEqual(server.handle_request({"id": 1, "method": "agent-interface.open", "params": {"profile": "fast"}})["result"]["session_id"], "sid-fast")
            self.assertEqual(server.dispatch({"id": 2, "method": "agent-interface.open", "params": {"profile": "fast"}})["result"]["session_id"], "sid-fast")
            self.assertIn("result", server.dispatch({"id": 3, "method": "agent-interface.receipt", "params": {"request_id": "none"}}, Replies()))


class GatedHermes(PooledHermes):
    """PooledHermes where each of the slow assistant's activations waits until the test releases that one."""
    def __init__(self):
        super().__init__()
        self.held.set()
        self.gates, self.started = [], threading.Condition()
        pooled = self.server.handle_request
        def handle(request):
            params = request.get("params") or {}
            if request["method"] in ("session.activate", "session.resume") and params.get("profile") == "slow":
                gate = {"go": threading.Event(), "fail": False}
                with self.started:
                    self.gates.append(gate)
                    self.started.notify_all()
                if not gate["go"].wait(10):
                    raise RuntimeError("The test never released this activation")
                if gate["fail"]:
                    raise RuntimeError("Synthetic activation failure")
            return pooled(request)
        self.server.handle_request = handle

    def activations(self, count):
        """Wait until ``count`` activations have started; True if they did."""
        with self.started:
            return self.started.wait_for(lambda: len(self.gates) >= count, 3)

    def release(self, index, fail=False):
        self.gates[index]["fail"] = fail
        self.gates[index]["go"].set()

    def settled(self):
        """Admission reservations still held once answered reads release theirs, waiting up to 3 seconds."""
        deadline = time.monotonic() + 3
        while self.active[0] and time.monotonic() < deadline:
            time.sleep(0.01)
        return self.active[0]

    def open(self, rid, replies, **params):
        self.server.dispatch({"id": rid, "method": "agent-interface.open", "params": {"profile": "slow", **params}}, replies)


class WindowedHermes(GatedHermes):
    """GatedHermes whose slow assistant's history is 25 turns, row IDs 1 to 50."""
    def __init__(self):
        super().__init__()
        gated = self.server.handle_request
        def handle(request):
            response = gated(request)
            params = request.get("params") or {}
            if request["method"] in ("session.activate", "session.resume") and "result" in response and params.get("omit_messages") is not True:
                response["result"]["messages"] = turns(25)
            return response
        self.server.handle_request = handle


class ReadMergeTests(unittest.TestCase):
    def test_identical_opens_waiting_behind_a_running_one_share_one_computation(self):
        with GatedHermes() as hermes:
            replies = Replies()
            hermes.open("running", replies)
            self.assertTrue(hermes.activations(1))
            hermes.open("a", replies, window={"turns": 20})
            hermes.open("b", replies, window={"turns": 20})
            hermes.release(0)
            self.assertTrue(hermes.activations(2))
            hermes.release(1)
            self.assertTrue(replies.wait("running", "a", "b"))
            self.assertEqual(len(hermes.gates), 2)
            a, b = (replies.answers[rid] for rid in ("a", "b"))
            self.assertEqual((a["id"], b["id"]), ("a", "b"))
            self.assertEqual({**a["result"], "app_timing": None}, {**b["result"], "app_timing": None})
            self.assertEqual(hermes.settled(), 0)

    def test_a_request_arriving_after_its_twin_started_gets_its_own_computation(self):
        for name, window in {"same parameters": {}, "another window": {"window": {"turns": 5}}}.items():
            with self.subTest(name), GatedHermes() as hermes:
                replies = Replies()
                hermes.open("running", replies)
                self.assertTrue(hermes.activations(1))
                hermes.open("a", replies)
                hermes.release(0)
                self.assertTrue(hermes.activations(2))
                # The running read may already have read what this request needs to see changed.
                hermes.open("b", replies, **window)
                hermes.release(1)
                self.assertTrue(hermes.activations(3))
                hermes.release(2)
                self.assertTrue(replies.wait("a", "b"))
                self.assertEqual(len(hermes.gates), 3)

    def test_waiting_opens_that_differ_only_in_window_share_one_activation_and_each_gets_its_own_cut(self):
        with WindowedHermes() as hermes:
            replies = Replies()
            hermes.open("running", replies)
            self.assertTrue(hermes.activations(1))
            # The server's turn read after a tool event, a client's page, and a read of everything.
            hermes.open("turn", replies, window={"start": "32"})
            hermes.open("page", replies, window={"turns": 20})
            hermes.open("whole", replies)
            hermes.release(0)
            self.assertTrue(hermes.activations(2))
            hermes.release(1)
            self.assertTrue(replies.wait("running", "turn", "page", "whole"))
            self.assertEqual(len(hermes.gates), 2)
            answers = {rid: replies.answers[rid]["result"] for rid in ("turn", "page", "whole")}
            # The turn read keeps row 31, the prompt its replies answer, before its window.
            self.assertEqual([m["row_id"] for m in answers["turn"]["messages"]], list(range(31, 51)))
            self.assertEqual(answers["turn"]["app_window"], {"earlier": 31, "context": 1})
            self.assertEqual([m["row_id"] for m in answers["page"]["messages"]], list(range(11, 51)))
            self.assertEqual(answers["page"]["app_window"], {"earlier": 10, "context": 0})
            self.assertEqual([m["row_id"] for m in answers["whole"]["messages"]], list(range(1, 51)))
            self.assertNotIn("app_window", answers["whole"])
            self.assertEqual({rid: replies.answers[rid]["id"] for rid in answers}, {rid: rid for rid in answers})
            self.assertEqual(hermes.settled(), 0)

    def test_waiting_opens_merge_only_with_the_same_parameters_connection_and_method(self):
        cases = {
            # An open without history never answers one that asked for it, whatever their windows.
            "parameters": lambda hermes, replies: (hermes.open("a", replies, omit_messages=True), hermes.open("b", replies, window={"turns": 10})),
            # Native activation binds the session to its caller's connection.
            "connection": lambda hermes, replies: (hermes.open("a", replies), hermes.open("b", other)),
        }
        for name, queue in cases.items():
            with self.subTest(name), GatedHermes() as hermes:
                replies, other = Replies(), Replies()
                hermes.open("running", replies)
                self.assertTrue(hermes.activations(1))
                queue(hermes, replies)
                for index in range(3):
                    self.assertTrue(hermes.activations(index + 1))
                    hermes.release(index)
                self.assertTrue(replies.wait("running", "a"))
                self.assertTrue((other if name == "connection" else replies).wait("b"))
                self.assertEqual(len(hermes.gates), 3)
        # A queued read outside the merge list never shares a computation.
        with patch.object(extension, "MERGED_READS", frozenset()), GatedHermes() as hermes:
            replies = Replies()
            hermes.open("running", replies)
            self.assertTrue(hermes.activations(1))
            hermes.open("a", replies)
            hermes.open("b", replies)
            for index in range(3):
                self.assertTrue(hermes.activations(index + 1))
                hermes.release(index)
            self.assertTrue(replies.wait("a", "b"))
            self.assertEqual(len(hermes.gates), 3)

    def test_a_merged_failure_answers_every_request_with_its_own_id(self):
        with GatedHermes() as hermes:
            replies = Replies()
            hermes.open("running", replies)
            self.assertTrue(hermes.activations(1))
            hermes.open("a", replies)
            hermes.open("b", replies)
            hermes.release(0)
            self.assertTrue(hermes.activations(2))
            hermes.release(1, fail=True)
            self.assertTrue(replies.wait("a", "b"))
            for rid in ("a", "b"):
                answer = replies.answers[rid]
                self.assertEqual((answer["id"], answer["error"]["code"]), (rid, -32000))
                self.assertIn("Synthetic activation failure", answer["error"]["message"])
            self.assertEqual(len(hermes.gates), 2)
            self.assertEqual(hermes.settled(), 0)

    def test_an_open_reports_the_time_it_waited_in_the_queue_within_its_total(self):
        with GatedHermes() as hermes:
            replies = Replies()
            hermes.open("running", replies)
            self.assertTrue(hermes.activations(1))
            hermes.open("waiting", replies)
            time.sleep(0.2)
            hermes.release(0)
            self.assertTrue(hermes.activations(2))
            hermes.release(1)
            self.assertTrue(replies.wait("running", "waiting"))
            running, waiting = (replies.answers[rid]["result"]["app_timing"] for rid in ("running", "waiting"))
            self.assertEqual(list(waiting), ["queued", "wait", "activate", "decorate", "window", "total"])
            # The held activation is the running read's own time; the second read spent it in the queue.
            self.assertLess(running["queued"], 100)
            self.assertGreaterEqual(running["activate"], 150)
            self.assertGreaterEqual(waiting["queued"], 150)
            self.assertLess(waiting["activate"], 100)
            self.assertGreaterEqual(waiting["total"], waiting["queued"] + waiting["activate"])

    def test_identical_discovers_waiting_behind_a_running_one_share_one_routine_scan(self):
        jobs = [{"id": "job", "name": "[bot:default] Daily AI news"}]
        run = {"id": "execution", "status": "completed", "claimed_at": "2026-10-31T07:00:00-05:00"}
        scans, entered, go = [], threading.Event(), threading.Event()

        def list_jobs(profile):
            # Each scan lists every profile's jobs, so this records one entry per profile per scan.
            scans.append(profile)
            return jobs

        def list_executions(job_id, limit):
            # Hermes's cron ledger; the first read holds the discovery lane until the test releases it.
            if not entered.is_set():
                entered.set()
                if not go.wait(10):
                    raise RuntimeError("The test never released the first scan")
            return [run]
        with PooledHermes() as hermes:
            executions = types.ModuleType("cron.executions")
            executions.list_executions, executions.EXECUTIONS_FILE = list_executions, Path(hermes.directory.name) / "executions.db"
            cron = types.ModuleType("cron")
            cron.executions = executions
            modules = {"hermes_cli.web_routers.cron": types.SimpleNamespace(_owner_home_scope=lambda _: contextlib.nullcontext(), _list_cron_jobs_sync=list_jobs),
                       "cron": cron, "cron.executions": executions}
            with patch.dict(sys.modules, modules):
                replies = Replies()
                discover = lambda rid: hermes.server.dispatch({"id": rid, "method": "agent-interface.discover", "params": {"cursor": "0", "full": True}}, replies)
                discover("running")
                self.assertTrue(entered.wait(3))
                discover("a")
                discover("b")
                go.set()
                self.assertTrue(replies.wait("running", "a", "b"))
            # One forced scan of both profiles for the running request, one for both waiting ones.
            self.assertEqual(scans, ["slow", "fast", "slow", "fast"])
            a, b = (replies.answers[rid] for rid in ("a", "b"))
            self.assertEqual((a["id"], b["id"]), ("a", "b"))
            self.assertEqual(a["result"], b["result"])
            self.assertEqual([(event["botId"], event["routineId"]) for event in a["result"]["events"]], [("slow", "job"), ("fast", "job")])
            # Each profile's run was recorded once, as two separate scans would have left it.
            self.assertEqual(hermes.journal.db.execute("SELECT profile FROM events WHERE routine_id='job' ORDER BY id").fetchall(), [("slow",), ("fast",)])
            self.assertEqual(hermes.active[0], 0)

    def test_a_response_without_timings_only_takes_its_own_id(self):
        error = {"jsonrpc": "2.0", "id": "first", "error": {"code": -32000, "message": "failed"}}
        self.assertEqual(extension.answered(error, "second", 0.5), {**error, "id": "second"})
        self.assertIsNone(extension.answered(None, "second", 0.5))
        found = {"jsonrpc": "2.0", "id": "first", "result": {"cursor": "3", "events": []}}
        self.assertEqual(extension.answered(found, "second", 0.5)["result"], found["result"])


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

    def test_routine_events_carry_what_each_run_said_read_once_per_run(self):
        jobs = [{"id": "job", "name": "[bot:default] Daily AI news"}]
        ledger = Mock(return_value=[{"id": "execution", "status": "completed", "claimed_at": "2026-10-31T07:00:00-05:00"}])
        with FakeHermes([]) as hermes:
            executions = types.ModuleType("cron.executions")
            executions.list_executions, executions.EXECUTIONS_FILE = ledger, Path(hermes.directory.name) / "executions.db"
            cron = types.ModuleType("cron")
            cron.executions = executions
            modules = {"hermes_cli.web_routers.cron": types.SimpleNamespace(_owner_home_scope=lambda _: contextlib.nullcontext(), _list_cron_jobs_sync=lambda _: jobs),
                       "cron": cron, "cron.executions": executions}
            body = Mock(return_value="Three model launches.")
            with patch.dict(sys.modules, modules), patch.object(extension, "routine_run_body", body):
                discover = hermes.methods["agent-interface.discover"]
                events = discover("tick", {"cursor": "0", "full": True})["result"]["events"]
                discover("tick", {"cursor": "0", "full": True})
        self.assertEqual([(event["title"], event["body"], event["routineId"]) for event in events], [("[bot:default] Daily AI news", "Three model launches.", "job")])
        body.assert_called_once_with("/home/default", "job", ledger.return_value[0], ledger.return_value)

    def test_routine_run_body_quotes_the_runs_own_answer_or_error(self):
        with tempfile.TemporaryDirectory() as home:
            output = Path(home) / "cron" / "output" / "job"
            output.mkdir(parents=True)
            document = lambda answer: f"# Cron Job: Daily AI news\n\n**Job ID:** job\n\n## Prompt\n\nSummarize today's AI news.\n\n## Response\n\n{answer}\n"
            (output / "2026-10-30_07-00-04.md").write_text(document("Yesterday's news."))
            (output / "2026-10-31_07-00-09.md").write_text(document("**Three** model launches\nand a new benchmark."))
            (output / "2026-10-31_09-00-02.md").write_text(document("A later run."))
            run = {"status": "completed", "claimed_at": "2026-10-31T07:00:00.700-05:00", "finished_at": "2026-10-31T07:00:10-05:00"}
            body = lambda execution, job="job": extension.routine_run_body(home, job, execution)
            # Lines survive for the app to read as Markdown.
            self.assertEqual(body(run), "**Three** model launches\nand a new benchmark.")
            # A run whose document was pruned or never written must not borrow a later run's, even within the grace.
            pruned = {"status": "completed", "claimed_at": "2026-10-31T06:59:00-05:00", "finished_at": "2026-10-31T06:59:30-05:00"}
            self.assertIsNone(extension.routine_run_body(home, "job", pruned, [pruned, run]))
            self.assertIsNone(body({**run, "claimed_at": "2026-10-31T08:00:00-05:00", "finished_at": "2026-10-31T08:00:05-05:00"}))
            # Nor across the hour daylight saving repeats, when the next claim's wall clock reads earlier.
            (output / "2026-11-01_01-06-00.md").write_text(document("The next run's answer."))
            before = {"status": "completed", "claimed_at": "2026-11-01T01:04:00-05:00", "finished_at": "2026-11-01T01:04:30-05:00"}
            self.assertIsNone(extension.routine_run_body(home, "job", before, [before, {"claimed_at": "2026-11-01T01:02:00-06:00"}]))
            # Hermes's reader checks length frames over the whole document, so a long prompt still yields its answer.
            prompt = "context " * 40000
            (output / "2026-10-31_09-00-02.md").write_text(f"# Cron Job: Daily AI news\n\n## Prompt\n\n{prompt}\n\n## Response\n\nLong prompt, short answer.\n")
            self.assertEqual(body({"status": "completed", "claimed_at": "2026-10-31T09:00:00-05:00"}), "Long prompt, short answer.")
            self.assertEqual(body({"status": "failed", "error": "Provider\n rate limit"}), "Provider\n rate limit")
            self.assertIsNone(body({"status": "unknown"}))
            self.assertIsNone(body(run, job="../job"))
            self.assertIsNone(body({"status": "completed"}))
            (output / "2026-10-31_07-00-09.md").unlink()
            (output / "2026-10-31_07-00-09.md").symlink_to(output / "2026-10-30_07-00-04.md")
            self.assertIsNone(body(run))
            # Nor may the job's folder link to another profile's output.
            elsewhere = Path(home) / "private-profile"
            elsewhere.mkdir()
            (elsewhere / "2026-10-31_07-00-09.md").write_text(document("Private notes."))
            (output.parent / "linked").symlink_to(elsewhere)
            self.assertIsNone(body(run, job="linked"))

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


class SubmissionRecoveryGateTests(unittest.TestCase):
    def test_gate_reads_restart_marker_inflight_and_prior_owner_across_runtime_sid(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = extension.Journal(Path(directory) / 'gates.db')
            try:
                session = dict(session_key='stored', running=False)
                self.assertFalse(journal.submission_state('ranch', 'sid', session)['interrupted'])
                session['inflight_turn'] = dict(interrupted=True)
                self.assertTrue(journal.submission_state('ranch', 'sid', session)['interrupted'])
                session.pop('inflight_turn')
                with journal.db:
                    journal.db.execute("INSERT INTO interruptions VALUES('ranch','stored','crashed',1)")
                self.assertTrue(journal.submission_state('ranch', 'sid', session)['interrupted'])
                self.assertFalse(journal.submission_state('other', 'sid', session)['interrupted'])
                with journal.db:
                    journal.db.execute("DELETE FROM interruptions")
                    journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,status,terminal,created) VALUES('past','d','ranch','old-sid','stored','person','e','interrupted',1,1)")
                journal.event('ranch', 'old-sid', 'interrupted', 'Stopped', 'past')
                self.assertTrue(journal.submission_state('ranch', 'new-sid', session)['interrupted'])
            finally:
                journal.db.close()

    def test_unsettled_receipt_and_resume_require_idle_use_the_same_submit_gate(self):
        with FakeHermes([]) as hermes:
            hermes.open()
            session = hermes.modules['tui_gateway.server']._sessions['sid']
            with hermes.journal.db:
                hermes.journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,status,terminal,created) VALUES('previous','d','default','sid','stored','person','e','accepted',0,1)")
            self.assertEqual(hermes.journal.submission_state('default', 'sid', session)['current'], ('previous',))
            submit = hermes.methods['agent-interface.submit']
            params = dict(profile='default', request_id='continuation', sender_id='person', text='Continue', require_idle=True)
            refused = submit('resume', params)['result']
            self.assertEqual(refused['status'], 'rejected')
            with hermes.journal.db:
                hermes.journal.db.execute("UPDATE receipts SET terminal=1")
            session['running'] = True
            busy = submit('resume', dict(params, request_id='busy'))
            self.assertEqual(busy['error']['code'], 4091)
            self.assertIsNone(hermes.journal.receipt('busy'))


if __name__ == "__main__":
    unittest.main()
