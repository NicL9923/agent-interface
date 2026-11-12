"""After a restart, a background warm-up projects each recent assistant's history into the memo its first open adopts.

The warm-up reads the canonical chat from the profile's store read-only, projects it piece by piece under the
profile's lock, and lets go whenever live work arrives, keeping what it projected. Hermes is a fake at its edges:
the session table, the native projection (which records the rows and thread of every call), a read-only SessionDB
over each profile's chat, profile directories on disk with their state.db files, and the redaction registry. The
journal is the add-on's own. The answer with no readable redaction state, which never memoizes, is the whole
projection every warmed answer must equal.
"""
import copy
import json
import logging
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from hermes_extension_journal_test import FakeGateway, extension, receipt, tool
from hermes_projection_memo_test import ProjectingHermes, call


class Chat:
    """One profile's store as the warm-up reads it: its "Bot Chat" row, that row's compression tip and its rows."""

    def __init__(self, rows, tip="stored", row=None):
        self.rows, self.tip, self.row = rows, tip, {"id": "root"} if row is None else row


def session_db(hermes, signature=True, read_only=True):
    """Hermes's SessionDB over the fake's chats. Only the reads the warm-up makes exist, and only read-only.

    A chat whose row is an exception raises it from the title lookup, as a damaged store would."""

    class SessionDB:
        def __init__(self, db_path, read_only=False):
            if read_only is not True:
                raise AssertionError("the warm-up opened a store writable")
            self.chat = hermes.chats[Path(db_path)]

        def get_session_by_title(self, title):
            if isinstance(self.chat.row, Exception):
                raise self.chat.row
            return self.chat.row if title == "Bot Chat" else None

        def get_compression_tip(self, session_id):
            return self.chat.tip if session_id == self.chat.row.get("id") else None

        def get_messages_as_conversation(self, session_id, include_ancestors=False, include_row_ids=False, include_compacted=False):
            if (session_id, include_ancestors, include_row_ids, include_compacted) != (self.chat.tip, True, True, True):
                raise AssertionError("not the display read an open makes")
            hermes.reads += 1
            if hermes.on_read is not None:
                hermes.on_read()
            # Fresh rows on every read, as the store gives them.
            return copy.deepcopy(self.chat.rows() if callable(self.chat.rows) else self.chat.rows)

        def close(self):
            pass

    if not read_only:
        # An older Hermes whose store opens only writable.
        def __init__(self, db_path=None):
            raise AssertionError("never opened")
        SessionDB.__init__ = __init__
    if not signature:
        def get_messages_as_conversation(self, session_id, include_ancestors=False, include_row_ids=False):
            raise AssertionError("never read without compacted rows")
        SessionDB.get_messages_as_conversation = get_messages_as_conversation
    return SessionDB


class WarmHermes(ProjectingHermes):
    """ProjectingHermes after a restart: no session is canonical yet, nothing runs, and stores exist on disk.

    The default profile is the home the gateway runs in, so it projects with no ``profile_home``. Native resume and
    activation project images as Hermes does, as URLs unless ``inline_images`` is false. Install starts no warm-up
    thread; tests drive it. ``on_project(ids)`` and ``on_read()`` run inside Hermes's projection and store read.
    """

    def __init__(self):
        super().__init__()
        self.environment[extension.WARM_SETTING] = "0"
        self.session["running"] = False
        self.reads, self.on_read, self.on_project, self.hold, self.resolved = 0, None, None, None, "stored"
        self.calls = []
        self.root = tempfile.TemporaryDirectory()
        self.launch = Path(self.store_path).parent
        self.server._hermes_home = str(self.launch)
        self.chats = {Path(self.store_path): Chat(lambda: self.session["history"])}
        self.modules["hermes_state"] = types.SimpleNamespace(SessionDB=session_db(self))
        profiles = types.ModuleType("hermes_cli.profiles")
        profiles.get_profile_dir = self.profile_dir
        self.modules["hermes_cli.profiles"] = profiles
        server, self.entered = self.server, threading.Event()

        def handle(request):
            method, params = request["method"], request.get("params") or {}
            self.native_calls.append((method, dict(params)))
            if method == "profiles.list":
                return server._ok(request["id"], {"profiles": [{"name": "default", "canonical_session": {"resolved_id": self.resolved}}]})
            if method == "session.resume" and self.hold is not None:
                self.entered.set()
                self.hold.wait(5)
            images = "inline_images" not in params or params["inline_images"] is True
            messages = [] if params.get("omit_messages") else server._history_to_messages(
                list(self.session["history"]), profile_home=None, image_urls=images)
            return server._ok(request["id"], {"session_id": "sid", "messages": messages})
        server.handle_request = handle

    def profile_dir(self, name):
        if "/" in name:
            raise ValueError("not a profile ID")
        return self.launch if name == "default" else Path(self.root.name) / "profiles" / name

    def profile(self, name, chat, created):
        """A named profile with a store on disk holding ``chat``, and an app send ``created`` seconds in."""
        store = self.profile_dir(name) / "state.db"
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_bytes(b"SQLite format 3\0")
        self.chats[store] = chat
        self.send(name, created)
        return store

    def send(self, profile, created):
        with self.journal.db:
            receipt(self.journal.db, f"{profile}-{created}", None, created, profile=profile)

    def project(self, history, **kwargs):
        ids = [row.get("_row_id") if isinstance(row, dict) else None for row in history]
        self.calls.append((threading.current_thread().name, ids))
        if self.on_project is not None:
            self.on_project(ids)
        return super().project(history, **kwargs)

    def projected_by(self, thread):
        return {row for name, ids in self.calls if name == thread for row in ids}

    def __enter__(self):
        self.pieces = patch.object(extension, "PIECE_ROWS", 1)
        self.pieces.start()
        self.timing = [patch.object(extension, "WARM_POLL", 0.005), patch.object(extension, "WARM_PAUSE", 0)]
        for item in self.timing:
            item.start()
        FakeGateway.__enter__(self)
        return self

    def __exit__(self, *exc):
        for item in self.timing:
            item.stop()
        self.root.cleanup()
        return super().__exit__(*exc)

    def target(self, profile="default"):
        return next(target for target in self.bridge.warm_targets() if target[0] == profile)


def chat(hermes, turns):
    """``turns`` turns of a user row and a reply; with one row per piece, each turn is a piece. Returns each turn's row IDs."""
    rows = []
    for turn in range(turns):
        rows.append({hermes.add("user", f"u{turn}", f"Question {turn}")["_row_id"], hermes.add("assistant", f"a{turn}", f"Answer {turn}")["_row_id"]})
    return rows


def turn_during(hermes, piece, writes):
    """A native projection hook: a turn starts while the warm-up projects ``piece`` and ends 30 ms later, having
    saved a turn of its own when ``writes``."""
    started = []

    def turn():
        time.sleep(0.03)
        if writes:
            chat(hermes, 1)
        hermes.session["running"] = False

    def hook(ids):
        if piece <= set(ids) and not started:
            started.append(True)
            hermes.session["running"] = True
            threading.Thread(target=turn).start()
    return hook


def until(condition, seconds=5):
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        time.sleep(0.002)


class FirstOpenTests(unittest.TestCase):
    def test_the_second_open_after_a_restart_reuses_what_the_first_one_projected(self):
        # Production on November 12: 10.9 s, then 4.4 s, then 0.3 s. The first open resumed, projected without its
        # memo and without image URLs, and the second projected everything again into an empty memo.
        with WarmHermes() as hermes:
            turns = chat(hermes, 3)
            photo = hermes.add("user", "u9", "Look ![photo]")["_row_id"]
            first = hermes.answer()
            self.assertEqual(hermes.projected(), set().union(*turns, {photo}))
            # The first open shows images as every later one does.
            self.assertIn("Look ![photo]", [m.get("text") for m in first["messages"]])
            self.assertEqual(hermes.answer(), first)
            self.assertEqual(hermes.projected(), set())

    def test_a_first_open_adopts_the_warmed_history_and_projects_nothing(self):
        with WarmHermes() as hermes:
            chat(hermes, 3)
            hermes.send("default", 1)
            self.assertTrue(hermes.bridge.warm(*hermes.target()))
            hermes.projected()
            value = hermes.answer()
            self.assertEqual(hermes.projected(), set())
            self.assertEqual(hermes.bridge.warm_caches, {})
            self.assertEqual(value, hermes.whole())
            hermes.projected()
            hermes.answer()
            self.assertEqual(hermes.projected(), set())

    def test_a_warm_up_of_an_earlier_tip_is_dropped_when_the_chat_goes_live(self):
        with WarmHermes() as hermes:
            chat(hermes, 2)
            hermes.send("default", 1)
            self.assertTrue(hermes.bridge.warm(*hermes.target()))
            # A compaction moved the chat to a new tip before anyone opened it.
            hermes.resolved = hermes.session["session_key"] = "stored-2"
            hermes.answer()
            self.assertEqual(hermes.bridge.warm_caches, {})

    def test_the_first_open_parses_no_tool_record_the_warm_up_parsed(self):
        with WarmHermes() as hermes:
            user = hermes.add("user", "u1", "Check the pump")
            hermes.add("assistant", "a1", "", tool_calls=[call("c1", "terminal")])
            hermes.add("tool", "t1", json.dumps({"ok": "c1"}), tool_call_id="c1")
            hermes.add("assistant", "a2", "Running.")
            with hermes.journal.db:
                receipt(hermes.journal.db, "run", user["_row_id"], 1)
                for call_id in ("c1", "c2", "c3"):
                    tool(hermes.journal.db, "run", call_id, {"ok": call_id})
                # Another stored session's record is not this chat's.
                hermes.journal.db.execute("INSERT INTO tools(profile,stored_session,run_id,tool_id,result,artifacts,detail) "
                                          "VALUES('default','stored-2','run','c4','{}','[]',NULL)")
            with patch.object(extension, "WARM_STEP", 2):
                self.assertTrue(hermes.bridge.warm(*hermes.target()))
            records = hermes.bridge.warm_caches["default", "stored"].tool_records
            self.assertEqual(sorted(record[0]["ok"] for record in records.values()), ["c1", "c2", "c3"])
            statements = []
            hermes.journal.db.set_trace_callback(statements.append)
            value = hermes.answer()
            self.assertEqual([s for s in statements if "SELECT id,result,artifacts,detail FROM tools" in s], [])
            self.assertEqual(next(m for m in value["messages"] if m["role"] == "tool")["app_tool_call"]["id"], "run:c1")


class SteppingAsideTests(unittest.TestCase):
    def test_an_open_arriving_mid_warm_up_takes_over_and_no_piece_is_projected_twice(self):
        callers = {"an app open": lambda hermes: hermes.answer(),
                   # A routine or bot delivery to an assistant that is not live yet.
                   "a delivery": lambda hermes: hermes.bridge.open_canonical("default")}
        for name, caller in callers.items():
            with self.subTest(name):
                self.open_arrives(caller)

    def open_arrives(self, caller):
        with WarmHermes() as hermes:
            turns = chat(hermes, 6)
            hermes.send("default", 1)
            answers = []
            opener = threading.Thread(target=lambda: answers.append(caller(hermes)), name="opener")

            def arrive(ids):
                # While the warm-up projects the third piece, an open asks for the same chat and waits for its lock.
                if turns[2] <= set(ids) and not opener.is_alive() and not answers:
                    opener.start()
                    # Counted while it waits for the lock the warm-up holds.
                    until(lambda: hermes.bridge.opens == 1)
            hermes.on_project = arrive
            self.assertTrue(hermes.bridge.warm(*hermes.target()))
            opener.join(5)
            warmed, opened = hermes.projected_by(threading.current_thread().name), hermes.projected_by("opener")
            self.assertEqual(warmed, set().union(*turns[:3]))
            self.assertEqual(opened - warmed, set().union(*turns[3:]))
            self.assertEqual(opened & warmed, set())
            hermes.on_project = None
            if isinstance(answers[0], dict):
                self.assertEqual(answers[0], hermes.whole())
            else:
                self.assertEqual(answers[0], "sid")
            self.assertEqual(hermes.bridge.warm_caches, {})

    def test_an_open_already_under_way_keeps_its_chat_and_the_warm_up_reads_nothing(self):
        with WarmHermes() as hermes:
            turns = chat(hermes, 3)
            hermes.send("default", 1)
            target = hermes.target()
            hermes.hold = threading.Event()
            answers, warmed = [], []
            opener = threading.Thread(target=lambda: answers.append(hermes.answer()), name="opener")
            opener.start()
            self.assertTrue(hermes.entered.wait(5))
            warmer = threading.Thread(target=lambda: warmed.append(hermes.bridge.warm(*target)), name="warmer")
            warmer.start()
            time.sleep(0.05)
            hermes.hold.set()
            opener.join(5)
            warmer.join(5)
            self.assertEqual(warmed, [True])
            self.assertEqual((hermes.reads, hermes.projected_by("warmer")), (0, set()))
            self.assertEqual(hermes.projected_by("opener"), set().union(*turns))
            self.assertEqual(hermes.bridge.warm_caches, {})

    def test_an_open_finishing_while_the_warm_up_reads_leaves_it_nothing_to_project(self):
        with WarmHermes() as hermes:
            chat(hermes, 3)
            hermes.send("default", 1)
            target = hermes.target()

            def open_meanwhile():
                hermes.on_read = None
                opener = threading.Thread(target=hermes.answer, name="opener")
                opener.start()
                opener.join(5)
            hermes.on_read = open_meanwhile
            self.assertTrue(hermes.bridge.warm(*target))
            self.assertEqual(hermes.projected_by(threading.current_thread().name), set())
            self.assertEqual(hermes.bridge.warm_caches, {})

    def test_the_warm_up_waits_for_a_turn_and_reads_again_only_what_the_turn_changed(self):
        with WarmHermes() as hermes:
            chat(hermes, 4)
            hermes.send("default", 1)
            target = hermes.target()
            hermes.session["running"] = True
            warmer = threading.Thread(target=hermes.bridge.warm, args=target, name="warmer")
            warmer.start()
            time.sleep(0.05)
            self.assertEqual((hermes.reads, hermes.projected_by("warmer")), (0, set()))
            hermes.session["running"] = False
            warmer.join(5)
            self.assertEqual(hermes.reads, 1)

        for writes in (False, True):
            with self.subTest(writes=writes), WarmHermes() as hermes:
                turns = chat(hermes, 4)
                hermes.send("default", 1)
                hermes.on_project = turn_during(hermes, turns[1], writes)
                self.assertTrue(hermes.bridge.warm(*hermes.target()))
                self.assertEqual(hermes.reads, 2 if writes else 1)
                hermes.on_project = None
                hermes.projected()
                # Whatever the turn wrote was read and warmed too.
                value = hermes.answer()
                self.assertEqual(hermes.projected(), set())
                self.assertEqual(value, hermes.whole())

    def test_live_work_is_any_open_app_request_send_or_working_session(self):
        with WarmHermes() as hermes:
            bridge = hermes.bridge
            self.assertFalse(bridge.live_work())

            def an_open():
                hermes.hold = threading.Event()
                threading.Thread(target=hermes.answer).start()
                self.assertTrue(hermes.entered.wait(5))
                return hermes.hold.set

            def lane(lanes):
                gate = threading.Event()
                lanes.submit(("agent-interface.discover", None), lambda requests: gate.wait(5), "request")
                return gate.set

            def flag(table, key, value):
                table[key] = value
                return lambda: table.pop(key)
            cases = {
                "an open": an_open,
                "an app read in its lane": lambda: lane(bridge.reads),
                "an app send in its lane": lambda: lane(bridge.sends),
                "an app send admitting": lambda: flag(bridge.sends_in_flight, 1, ["default", "admitting"]),
                "a native turn": lambda: flag(hermes.session, "running", True),
                "input queued in Hermes for another session": lambda: flag(hermes.server._sessions, "other", {"pending_steer": "x"}),
            }
            for name, start in cases.items():
                with self.subTest(name):
                    stop = start()
                    self.assertTrue(bridge.live_work())
                    stop()
                    until(lambda: not bridge.live_work())

    def test_tool_row_parsing_steps_aside_too(self):
        with WarmHermes() as hermes, patch.object(extension, "WARM_STEP", 1):
            hermes.send("default", 1)
            last = set()
            for turn in range(3):
                user = hermes.add("user", f"u{turn}", f"Run {turn}")
                hermes.add("assistant", f"a{turn}", "", tool_calls=[call(f"c{turn}", "terminal")])
                last = {user["_row_id"], hermes.add("tool", f"t{turn}", json.dumps({"turn": turn}), tool_call_id=f"c{turn}")["_row_id"]}

            def turn_starts(ids):
                # A turn starts as the last piece is projected, and runs until the test ends it.
                if last <= set(ids):
                    hermes.session["running"] = True
            hermes.on_project = turn_starts
            warmer = threading.Thread(target=hermes.bridge.warm, args=hermes.target(), name="warmer")
            warmer.start()
            until(lambda: hermes.session["running"])
            time.sleep(0.05)
            self.assertEqual(len(hermes.bridge.warm_caches["default", "stored"].tool_results), 0)
            hermes.on_project = None
            hermes.session["running"] = False
            warmer.join(5)
            self.assertEqual(len(hermes.bridge.warm_caches["default", "stored"].tool_results), 3)

    def test_a_redaction_change_while_the_warm_up_stood_aside_projects_again(self):
        with WarmHermes() as hermes:
            hermes.send("default", 1)
            user = hermes.add("user", "u0", "Run 0")
            hermes.add("assistant", "a0", "", tool_calls=[call("c0", "terminal")])
            last = {user["_row_id"], hermes.add("tool", "t0", json.dumps({"turn": 0}), tool_call_id="c0")["_row_id"]}

            def turn_starts(ids):
                # A turn starts as the last piece is projected; while it runs, a new value is redacted.
                if last <= set(ids):
                    hermes.on_project = None
                    hermes.session["running"] = True
            hermes.on_project = turn_starts
            warmer = threading.Thread(target=hermes.bridge.warm, args=hermes.target(), name="warmer")
            warmer.start()
            until(lambda: hermes.session["running"])
            first = len(hermes.calls)
            hermes.redact._VAULT_REDACTION_VALUES["/home/default"] = {"fixture-redacted": None}
            hermes.session["running"] = False
            warmer.join(5)
            # The projection under the old redaction is not kept as finished: the warm-up projects again under the new one.
            self.assertGreater(len(hermes.calls), first)
            self.assertEqual(hermes.bridge.warm_caches["default", "stored"].projections.context[2], extension.redaction_state())

    def test_record_parsing_steps_aside_too(self):
        with WarmHermes() as hermes:
            chat(hermes, 1)
            hermes.send("default", 1)
            with hermes.journal.db:
                for call in ("c1", "c2", "c3"):
                    tool(hermes.journal.db, "run", call, {"ok": call})
            listed = []

            def trace(statement):
                if "SELECT id FROM tools" in statement:
                    listed.append(statement)
                elif "SELECT id,result,artifacts,detail FROM tools" in statement and len(listed) == 1:
                    # A turn starts while the first record is parsed.
                    hermes.session["running"] = True
                    threading.Timer(0.02, hermes.session.__setitem__, ("running", False)).start()
            hermes.journal.db.set_trace_callback(trace)
            with patch.object(extension, "WARM_STEP", 1):
                self.assertTrue(hermes.bridge.warm(*hermes.target()))
            hermes.journal.db.set_trace_callback(None)
            self.assertEqual(len(listed), 2)
            self.assertEqual(len(hermes.bridge.warm_caches["default", "stored"].tool_records), 3)


class BudgetTests(unittest.TestCase):
    def test_warming_keeps_within_the_room_other_memos_leave_and_stops_when_it_runs_out(self):
        with WarmHermes() as hermes:
            chat(hermes, 4)
            hermes.send("default", 1)
            bridge = hermes.bridge
            self.assertTrue(bridge.warm(*hermes.target()))
            pieces = [entry[3] for entry in bridge.warm_caches.pop(("default", "stored")).projections.pieces.values()]
            # Another assistant's memo, used before the restart's first open.
            other = extension.ProjectionMemo(bridge.projection_budget)
            rows = [{"role": "user", "content": "ranch " * 20, "_row_id": 1}]
            other.project(rows, lambda part: ([{"text": row["content"]} for row in part], []), dict, "context")
            bridge.projection_budget.fixed = other.size + pieces[0] + pieces[1]
            hermes.projected()
            self.assertFalse(bridge.warm(*hermes.target()))
            memo = bridge.warm_caches["default", "stored"].projections
            self.assertEqual((len(memo.pieces), memo.size), (2, pieces[0] + pieces[1]))
            self.assertEqual(other.size, extension.text_size(rows) + extension.text_size([{"text": rows[0]["content"]}]))
            # Nothing past the first piece that did not fit was projected.
            self.assertEqual(len(hermes.projected()), 6)

    def test_a_warm_up_that_stepped_aside_still_fits_what_it_kept_before(self):
        with WarmHermes() as hermes:
            turns = chat(hermes, 4)
            hermes.send("default", 1)
            bridge = hermes.bridge
            self.assertTrue(bridge.warm(*hermes.target()))
            whole = bridge.warm_caches.pop(("default", "stored")).projections.size
            bridge.projection_budget.fixed = whole
            hermes.on_project = turn_during(hermes, turns[1], writes=False)
            # Its second try reuses the pieces it kept, which count once against the room.
            self.assertTrue(bridge.warm(*hermes.target()))
            self.assertEqual(bridge.warm_caches["default", "stored"].projections.size, whole)

    def test_the_most_recent_assistants_are_warmed_first_until_the_budget_is_full(self):
        with WarmHermes() as hermes:
            chat(hermes, 2)
            hermes.send("default", 2)
            rows = lambda name: [{"role": "user", "content": f"{name}?", "_row_id": 1, "timestamp": 1.0},
                                 {"role": "assistant", "content": f"{name}, done.", "_row_id": 2, "timestamp": 2.0}]
            hermes.profile("ranch", Chat(rows("Fence"), tip="ranch-stored"), created=3)
            hermes.profile("barn", Chat(rows("Hay"), tip="barn-stored"), created=1)
            bridge = hermes.bridge
            bridge.warm_histories()
            self.assertEqual(set(bridge.warm_caches), {("ranch", "ranch-stored"), ("default", "stored"), ("barn", "barn-stored")})
            ranch = bridge.warm_caches["ranch", "ranch-stored"].projections.size
            bridge.warm_caches.clear()
            # Room for ranch's chat alone: the default assistant, sent to before it, keeps nothing, and barn is not read.
            bridge.projection_budget.fixed = ranch
            hermes.reads = 0
            bridge.warm_histories()
            self.assertEqual(set(bridge.warm_caches), {("ranch", "ranch-stored"), ("default", "stored")})
            self.assertEqual(bridge.warm_caches["ranch", "ranch-stored"].projections.size, ranch)
            self.assertEqual(bridge.warm_caches["default", "stored"].projections.size, 0)
            self.assertEqual(hermes.reads, 2)


class RankTests(unittest.TestCase):
    @staticmethod
    def memo(budget, name, background=False):
        rows = [{"role": "user", "content": f"{name} " * 30, "_row_id": 1}]
        memo = extension.ProjectionMemo(budget)
        memo.project(rows, lambda part: ([{"text": row["content"]} for row in part], []), dict, "context", background=background)
        return memo

    def test_a_warmed_memo_empties_before_any_memo_an_open_used(self):
        size = self.memo(extension.ProjectionBudget(), "ranch").size
        budget = extension.ProjectionBudget(budget=2 * size)
        opened = self.memo(budget, "ranch")
        warmed = self.memo(budget, "fence", background=True)
        # A chat opened later, nobody having opened the warmed one: it empties, not the one an open used first.
        self.memo(budget, "barns")
        self.assertEqual((opened.size, warmed.size), (size, 0))

    def test_a_warmed_cache_the_budget_empties_is_forgotten(self):
        with WarmHermes() as hermes:
            chat(hermes, 2)
            hermes.send("default", 1)
            bridge = hermes.bridge
            self.assertTrue(bridge.warm(*hermes.target()))
            warmed = bridge.warm_caches.pop(("default", "stored")).projections.size
            ranch, barns = (self.memo(extension.ProjectionBudget(), name).size for name in ("ranch", "barns"))
            # Room for any two of the three chats. Ranch is opened, then the warm-up runs, then barns is opened.
            bridge.projection_budget.fixed = ranch + warmed + barns - 1
            opened = self.memo(bridge.projection_budget, "ranch")
            self.assertTrue(bridge.warm(*hermes.target()))
            self.assertEqual(bridge.warm_caches["default", "stored"].projections.size, warmed)
            self.memo(bridge.projection_budget, "barns")
            self.assertEqual(opened.size, ranch)
            self.assertEqual(bridge.warm_caches, {})

    def test_a_warm_up_waiting_out_a_turn_still_empties_first(self):
        with WarmHermes() as hermes:
            turns = chat(hermes, 4)
            hermes.send("default", 1)
            bridge = hermes.bridge
            ranch, barns = (self.memo(extension.ProjectionBudget(), name).size for name in ("ranch", "barns"))
            opened = self.memo(bridge.projection_budget, "ranch")

            def turn_starts(ids):
                # A turn starts as the second piece is projected, and runs until the test ends it.
                if turns[1] <= set(ids):
                    hermes.session["running"] = True
            hermes.on_project = turn_starts
            warmer = threading.Thread(target=bridge.warm, args=hermes.target(), name="warmer")
            warmer.start()
            try:
                # The warm-up stopped and kept the pieces before the turn.
                until(lambda: ("default", "stored") in bridge.warm_caches and bridge.warm_caches["default", "stored"].projections.size)
                kept = bridge.warm_caches["default", "stored"].projections.size
                bridge.projection_budget.fixed = ranch + kept + barns - 1
                self.memo(bridge.projection_budget, "barns")
                self.assertEqual(opened.size, ranch)
                self.assertNotIn(("default", "stored"), bridge.warm_caches)
            finally:
                hermes.on_project = None
                hermes.session["running"] = False
                warmer.join(5)

    def test_a_stop_partway_through_reused_pieces_keeps_every_piece(self):
        # Reproduced in review: six pieces kept, a stop at the second pause of the next pass, one piece left.
        rows = [{"role": "user" if index % 2 == 0 else "assistant", "content": str(index), "_row_id": index + 1} for index in range(12)]
        memo, pauses = extension.ProjectionMemo(extension.ProjectionBudget()), []

        def stop_at_second(full):
            pauses.append(full)
            if len(pauses) == 2:
                raise extension.WarmupYield
        with patch.object(extension, "PIECE_ROWS", 1):
            memo.project(rows, lambda part: ([{"text": row["content"]} for row in part], []), dict, "context")
            whole = (dict(memo.pieces), memo.size)
            with self.assertRaises(extension.WarmupYield):
                memo.project(rows, lambda part: ([{"text": row["content"]} for row in part], []), dict, "context", pause=stop_at_second)
        self.assertEqual((memo.pieces, memo.size), whole)
        # The room shrank since: a stop keeps what fits, in order.
        pieces = [entry[3] for entry in whole[0].values()]
        pauses.clear()
        with patch.object(extension, "PIECE_ROWS", 1), self.assertRaises(extension.WarmupYield):
            memo.project(rows, lambda part: ([{"text": row["content"]} for row in part], []), dict, "context",
                         pause=stop_at_second, limit=pieces[0] + pieces[1])
        self.assertEqual((list(memo.pieces), memo.size), (list(whole[0])[:2], pieces[0] + pieces[1]))

    def test_a_warm_up_stepping_aside_on_a_grown_history_projects_only_what_is_new(self):
        with WarmHermes() as hermes:
            chat(hermes, 4)
            hermes.send("default", 1)
            self.assertTrue(hermes.bridge.warm(*hermes.target()))
            new = chat(hermes, 1)[0]
            hermes.projected()

            def turn_starts():
                # A turn starts as the warm-up reads the grown history, so it stops before the first reused piece.
                hermes.on_read = None
                hermes.session["running"] = True
                threading.Timer(0.02, hermes.session.__setitem__, ("running", False)).start()
            hermes.on_read = turn_starts
            self.assertTrue(hermes.bridge.warm(*hermes.target()))
            self.assertEqual(hermes.projected(), new)

    def test_a_warm_up_whose_cache_another_open_drops_is_not_counted(self):
        with WarmHermes() as hermes:
            chat(hermes, 2)
            hermes.send("default", 1)
            with hermes.journal.db:
                tool(hermes.journal.db, "run", "c1", {"ok": 1})
            bridge = hermes.bridge
            barns = self.memo(extension.ProjectionBudget(), "barns").size

            def another_open(statement):
                # While the warm-up parses records, another chat is opened past the budget.
                if "SELECT id,result,artifacts,detail FROM tools" in statement:
                    hermes.journal.db.set_trace_callback(None)
                    bridge.projection_budget.fixed = bridge.warm_caches["default", "stored"].projections.size + barns - 1
                    self.memo(bridge.projection_budget, "barns")
            hermes.journal.db.set_trace_callback(another_open)
            self.assertFalse(bridge.warm(*hermes.target()))
            self.assertEqual(bridge.warm_caches, {})

    def test_a_pause_comes_before_every_piece_reused_or_not(self):
        rows = [{"role": "user" if index % 2 == 0 else "assistant", "content": str(index), "_row_id": index + 1} for index in range(6)]
        memo = extension.ProjectionMemo(extension.ProjectionBudget())
        with patch.object(extension, "PIECE_ROWS", 1):
            for _ in range(2):
                pauses = []
                memo.project(rows, lambda part: ([{"text": row["content"]} for row in part], []), dict, "context", pause=pauses.append)
                self.assertEqual(pauses, [False, False, False])
        self.assertEqual(memo.report["reused"], 3)


class TargetTests(unittest.TestCase):
    def test_targets_are_the_assistants_sent_to_most_recently_with_a_canonical_chat_on_disk(self):
        with WarmHermes() as hermes:
            hermes.send("default", 1)
            hermes.profile("ranch", Chat([], tip="ranch-tip"), created=5)
            hermes.profile("retired", Chat([], row={"id": "root", "archived": 1}), created=4)
            hermes.profile("untitled", Chat([], row={}), created=3)
            empty = hermes.profile("empty", Chat([]), created=2)
            empty.write_bytes(b"")
            hermes.send("missing", 6)
            hermes.send("bad/name", 7)
            with patch.object(extension, "WARM_PROFILES", 10):
                targets = hermes.bridge.warm_targets()
            ranch_store = hermes.profile_dir("ranch") / "state.db"
            self.assertEqual(targets, [
                ("ranch", ranch_store, "ranch-tip", {"profile_home": ranch_store.parent, "image_urls": True}),
                ("default", Path(hermes.store_path), "stored", {"profile_home": None, "image_urls": True}),
            ])
            with patch.object(extension, "WARM_PROFILES", 3):
                # The three most recent sends: bad/name, missing and ranch; only ranch has a chat.
                self.assertEqual([target[0] for target in hermes.bridge.warm_targets()], ["ranch"])

    def test_a_chat_never_compacted_is_its_own_tip(self):
        with WarmHermes() as hermes:
            hermes.profile("ranch", Chat([], tip=None), created=1)
            self.assertEqual(hermes.target("ranch")[2], "root")


class StartTests(unittest.TestCase):
    def test_a_hermes_without_what_the_warm_up_reads_warms_nothing_and_says_what_is_missing_once(self):
        cases = {
            "hermes_state.SessionDB": lambda hermes: hermes.modules.__setitem__("hermes_state", None),
            "SessionDB.get_compression_tip": lambda hermes: delattr(hermes.modules["hermes_state"].SessionDB, "get_compression_tip"),
            "SessionDB(db_path, read_only)":
                lambda hermes: setattr(hermes.modules["hermes_state"], "SessionDB", session_db(hermes, read_only=False)),
            "SessionDB.get_messages_as_conversation(include_compacted)":
                lambda hermes: setattr(hermes.modules["hermes_state"], "SessionDB", session_db(hermes, signature=False)),
            "hermes_cli.profiles.get_profile_dir": lambda hermes: hermes.modules.__setitem__("hermes_cli.profiles", None),
            "project_compaction_message_for_display": lambda hermes: delattr(hermes.server, "project_compaction_message_for_display"),
            "agent.redact's registries": lambda hermes: hermes.modules.__setitem__("agent.redact", types.SimpleNamespace()),
        }
        for missing, remove in cases.items():
            with self.subTest(missing), WarmHermes() as hermes:
                hermes.environment.pop(extension.WARM_SETTING)
                remove(hermes)
                with patch.dict(sys.modules, hermes.modules), patch.dict("os.environ", {extension.WARM_SETTING: ""}), \
                        self.assertLogs(extension.__name__, logging.WARNING) as logs:
                    self.assertIsNone(hermes.bridge.start_warmup(delay=0))
                self.assertEqual(len(logs.output), 1)
                self.assertIn(f"Hermes has no {missing};", logs.output[0])

    def test_the_off_switch_starts_nothing_and_checks_nothing(self):
        with WarmHermes() as hermes:
            hermes.modules["hermes_state"] = None
            with patch.dict(sys.modules, hermes.modules), self.assertLogs(extension.__name__, logging.INFO) as logs:
                self.assertIsNone(hermes.bridge.start_warmup(delay=0))
            self.assertEqual([record.levelno for record in logs.records], [logging.INFO])

    def test_a_started_warm_up_warms_in_the_background(self):
        with WarmHermes() as hermes, patch.dict("os.environ", {extension.WARM_SETTING: "1"}):
            chat(hermes, 2)
            hermes.send("default", 1)
            with self.assertLogs(extension.__name__, logging.INFO) as logs:
                thread = hermes.bridge.start_warmup(delay=0)
                thread.join(5)
            self.assertEqual(thread.name, "agent-interface-warmup")
            self.assertIn("warmed 1 of 1 assistants", logs.output[-1])
            self.assertIn(("default", "stored"), hermes.bridge.warm_caches)

    def test_an_assistant_that_fails_is_skipped_and_logs_no_history(self):
        def read():
            raise ValueError("The token is hunter2")
        failures = {"its store read": Chat(read, tip="ranch-stored"),
                    "its title lookup": Chat([], row=ValueError("The token is hunter2"))}
        for name, ranch in failures.items():
            with self.subTest(name), WarmHermes() as hermes:
                chat(hermes, 2)
                hermes.send("default", 1)
                hermes.profile("ranch", ranch, created=2)
                with self.assertLogs(extension.__name__, logging.INFO) as logs:
                    hermes.bridge.warm_histories()
                self.assertIn("History warm-up skipped ranch: ValueError", logs.output[0])
                self.assertIn("warmed 1 of", logs.output[-1])
                self.assertIn(("default", "stored"), hermes.bridge.warm_caches)
                self.assertNotIn("hunter2", "\n".join(logs.output))

    def test_running_out_of_memory_stops_the_warm_up(self):
        def read():
            raise MemoryError
        failures = {"a store read": (Chat(read, tip="ranch-stored"), "History warm-up stopped after 0 of 2 assistants: MemoryError"),
                    "a title lookup": (Chat([], row=MemoryError()), "History warm-up found no assistants: MemoryError")}
        for name, (ranch, message) in failures.items():
            with self.subTest(name), WarmHermes() as hermes:
                chat(hermes, 2)
                hermes.send("default", 1)
                hermes.profile("ranch", ranch, created=2)
                with self.assertLogs(extension.__name__, logging.WARNING) as logs:
                    hermes.bridge.warm_histories()
                self.assertEqual(len(logs.output), 1)
                self.assertIn(message, logs.output[0])
                self.assertEqual(hermes.bridge.warm_caches, {})

if __name__ == "__main__":
    unittest.main()
