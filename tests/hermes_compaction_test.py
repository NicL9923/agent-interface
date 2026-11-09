"""Idle compaction of canonical Bot Chats: when it runs, and how every input preempts it.

Hermes is a fake at its edges: the gateway's session table and ``session.compress``, the agent's
stop and clear calls, and its token estimator. The real gateway contract, including a message
sent during a held compaction, lives in scripts/spike/compaction_probe.py.
"""
import contextlib
import json
import logging
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from support import load_source
from hermes_extension_journal_test import FakeGateway, FakeHermes, extension

compaction = load_source("src/hermes/compaction.py", "compaction_test")

NOW = 1_800_000_000.0
DELAY = 600


class Agent:
    """The agent's stop and clear calls, in the order they arrive. Anything else is an AttributeError."""
    def __init__(self, events, tail=1000, summary=200):
        self.events = events
        self.context_compressor = types.SimpleNamespace(tail_token_budget=tail, max_summary_tokens=summary)
        self._cached_system_prompt = "s" * 400
        self.tools = None

    def clear_interrupt(self, *, hard_cancel=False):
        self.events.append(("clear", hard_cancel))


def estimate(messages, *, system_prompt="", tools=None):
    # Hermes's rough estimate is characters over four; here every history row is 100 tokens.
    return len(system_prompt) // 4 + 100 * len(messages)


class Native:
    """Hermes's ``session.compress``: holds the session running like _manual_compress_turn, until stopped or released."""
    def __init__(self, server, sid, rows_after=None):
        self.server, self.sid, self.rows_after = server, sid, rows_after
        self.calls, self.entered, self.release, self.stopped = [], threading.Event(), threading.Event(), threading.Event()
        self.hold_before_active = threading.Event()
        self.hold_before_active.set()
        # Whether a turn Hermes drained from its own queue is running when the compaction returns.
        self.drained_turn = False

    def __call__(self, method, params):
        if method != "session.compress":
            raise AssertionError("Unexpected native call " + method)
        self.calls.append(params)
        session = self.server._sessions[self.sid]
        self.hold_before_active.wait(5)
        session["running"] = session["_manual_compress_active"] = True
        self.entered.set()
        try:
            for _ in range(500):
                if self.stopped.is_set():
                    return {"status": "aborted"}
                if self.release.is_set():
                    break
                time.sleep(0.01)
            if self.rows_after is not None:
                session["history"] = session["history"][:self.rows_after]
                session["history_version"] += 1
            return {"status": "compressed"}
        finally:
            session.pop("_manual_compress_active", None)
            session["running"] = self.drained_turn


class Fixture:
    """One canonical profile with a built agent, idle long enough and over budget."""
    def __init__(self, test):
        self.events = []
        directory = tempfile.TemporaryDirectory()
        test.addCleanup(directory.cleanup)
        self.journal = extension.Journal(Path(directory.name) / "journal.db")
        test.addCleanup(self.journal.db.close)
        self.requests = types.SimpleNamespace(_lock=threading.Lock(), _open={})
        def hard_interrupt(agent):
            session = self.server._sessions["sid"]
            # Hermes's explicit stop only reaches a compaction it has already marked active.
            self.events.append(("stop", bool(session.get("_manual_compress_active"))))
            self.native.stopped.set()
            return True
        gateway = types.ModuleType("tui_gateway")
        gateway.server_requests = self.requests
        modules = {"tui_gateway": gateway, "tui_gateway.server_requests": self.requests,
                   "agent": types.ModuleType("agent"),
                   "agent.interrupt_compat": types.SimpleNamespace(request_hard_interrupt=hard_interrupt),
                   "agent.model_metadata": types.SimpleNamespace(estimate_request_tokens_rough=estimate)}
        patcher = patch.dict(sys.modules, modules)
        patcher.start()
        test.addCleanup(patcher.stop)
        self.agent = Agent(self.events)
        self.server = types.SimpleNamespace(_sessions={"sid": {
            "session_key": "stored", "agent": self.agent, "history_lock": threading.RLock(), "history_version": 4,
            "history": [{"role": "user", "content": "x"}] * 30, "last_active": NOW - DELAY}},
            _session_uses_compute_host=lambda session: bool(session.get("host")), _manual_compress_turn=lambda: None)
        self.native = Native(self.server, "sid")
        self.lease = None
        self.clock = [NOW]
        self.monotonic = [0.0]
        self.canonical = {"default": "sid"}
        self.idle = compaction.IdleCompaction(self.server, self.native, self.canonical, self.journal, threading.RLock(),
                                              lambda: self.lease, DELAY, clock=lambda: self.clock[0],
                                              monotonic=lambda: self.monotonic[0])
        self.idle.activity["sid"] = NOW - DELAY

    @property
    def session(self):
        return self.server._sessions["sid"]

    def blocker(self):
        with self.idle.submission_lock:
            return self.idle.blocker("default", "sid", self.session, self.clock[0])

    def running(self):
        """Start a compaction on its own thread and return once Hermes holds the session for it."""
        results = []
        thread = threading.Thread(target=lambda: results.append(self.idle.compact("default", "sid")), daemon=True)
        thread.start()
        if not self.native.entered.wait(5):
            raise AssertionError("The compaction never reached Hermes")
        return thread, results


class SettingTests(unittest.TestCase):
    def test_the_setting_reads_seconds_and_turns_off_at_zero_or_when_unreadable(self):
        cases = [(None, 600, False), ("", 600, False), (" 120 ", 120, False), ("0", 0, False), ("-5", 0, True),
                 ("ten minutes", 0, True), ("1.5", 0, True)]
        for raw, expected, warned in cases:
            with self.subTest(raw=raw), self.assertLogs(compaction.log, logging.ERROR) if warned else _quiet():
                environ = {} if raw is None else {compaction.SETTING: raw}
                self.assertEqual(compaction.delay_from(environ), expected)

    def test_a_hermes_that_does_not_hold_a_manual_compaction_is_not_supported(self):
        server = types.SimpleNamespace(_manual_compress_turn=lambda: None, _session_uses_compute_host=lambda s: False)
        estimator = types.SimpleNamespace(estimate_request_tokens_rough=estimate)
        stop = types.SimpleNamespace(request_hard_interrupt=lambda agent: True)
        with patch.dict(sys.modules, {"agent": types.ModuleType("agent"), "agent.model_metadata": estimator, "agent.interrupt_compat": stop}):
            self.assertTrue(compaction.supported(server))
            # Hermes b9cb268 and d23cc6b compacted without marking the session running.
            self.assertFalse(compaction.supported(types.SimpleNamespace(_session_uses_compute_host=lambda s: False)))
        with patch.dict(sys.modules, {"agent": types.ModuleType("agent"), "agent.model_metadata": estimator, "agent.interrupt_compat": None}):
            self.assertFalse(compaction.supported(server))


class _quiet:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class SizeTests(unittest.TestCase):
    def test_the_budget_is_the_prompt_plus_the_compactors_tail_ceiling_and_summary(self):
        with patch.dict(sys.modules, {"agent": types.ModuleType("agent"),
                                      "agent.model_metadata": types.SimpleNamespace(estimate_request_tokens_rough=estimate)}):
            session = {"agent": Agent([], tail=1000, summary=200), "history_lock": threading.Lock(), "history": [{}] * 3}
            # 100 prompt tokens, 1.5 x 1000 tail, 200 summary.
            self.assertEqual(compaction.request_size(session), (400, 1800))
            for compressor in (None, types.SimpleNamespace(tail_token_budget=0, max_summary_tokens=200),
                               types.SimpleNamespace(tail_token_budget=1000), types.SimpleNamespace(tail_token_budget="1000", max_summary_tokens=200)):
                with self.subTest(compressor=compressor):
                    session["agent"].context_compressor = compressor
                    self.assertIsNone(compaction.request_size(session))


class DecisionTests(unittest.TestCase):
    def test_an_idle_canonical_session_over_budget_is_due(self):
        self.assertIsNone(Fixture(self).blocker())

    def test_each_reason_to_wait_blocks_compaction(self):
        def unsettled(f):
            with f.journal.db:
                f.journal.db.execute(extension.INSERT_REJECTED, ("r", "d", "default", "sid", "stored", "a", "e", "r", "t", "[]", 0, "accepted", 0, NOW))
        def interrupted(f):
            with f.journal.db:
                f.journal.db.execute("INSERT INTO interruptions VALUES('default','stored','old',1)")
        cases = [
            ("not canonical", lambda f: f.canonical.update(default="other")),
            ("compacting", lambda f: f.idle.attempts.update(sid=compaction.Attempt())),
            ("agent not built", lambda f: f.session.update(agent=None)),
            ("compute host", lambda f: f.session.update(host=True)),
            ("busy", lambda f: f.session.update(queued_prompt={"text": "next"})),
            ("maintenance", lambda f: setattr(f, "lease", {"operationId": "upgrade"})),
            ("open request", lambda f: f.requests._open.update(q=types.SimpleNamespace(sid="sid"))),
            ("unsettled receipt", unsettled),
            ("interruption under review", interrupted),
            ("recent activity", lambda f: f.session.update(last_active=NOW - 1)),
            ("already compacted", lambda f: f.idle.settled.update(sid=("stored", 4))),
            ("size unknown", lambda f: f.agent.context_compressor.__setattr__("tail_token_budget", None)),
            ("within budget", lambda f: f.session.update(history=[{}] * 3)),
        ]
        for reason, change in cases:
            with self.subTest(reason=reason):
                fixture = Fixture(self)
                change(fixture)
                self.assertEqual(fixture.blocker(), reason)

    def test_idle_time_and_size_boundaries(self):
        fixture = Fixture(self)
        fixture.idle.activity["sid"] = NOW - DELAY + 1
        self.assertEqual(fixture.blocker(), "recent activity")
        fixture.idle.activity["sid"] = NOW - DELAY
        self.assertIsNone(fixture.blocker())
        # Budget 1800: 100 prompt tokens and 17 rows is 1800, at the budget; one more row is over.
        fixture.session["history"] = [{}] * 17
        self.assertEqual(fixture.blocker(), "within budget")
        fixture.session["history"] = [{}] * 18
        self.assertIsNone(fixture.blocker())

    def test_a_session_first_seen_now_waits_a_full_delay(self):
        fixture = Fixture(self)
        fixture.idle.activity.clear()
        fixture.session["last_active"] = None
        self.assertEqual(fixture.blocker(), "recent activity")
        fixture.clock[0] = NOW + DELAY
        self.assertIsNone(fixture.blocker())

    def test_after_a_compaction_left_it_over_budget_it_waits_for_the_transcript_to_double(self):
        fixture = Fixture(self)
        fixture.idle.after["sid"] = 2000
        fixture.session["history"] = [{}] * 39
        self.assertEqual(fixture.blocker(), "within budget")
        fixture.session["history"] = [{}] * 40
        self.assertIsNone(fixture.blocker())

    def test_activity_from_frames_restarts_the_wait_but_its_own_frames_do_not(self):
        fixture = Fixture(self)
        fixture.idle.touch("sid")
        self.assertEqual(fixture.idle.activity["sid"], NOW)
        fixture.idle.activity["sid"] = NOW - DELAY
        fixture.idle.attempts["sid"] = compaction.Attempt()
        fixture.idle.touch("sid")
        self.assertEqual(fixture.idle.activity["sid"], NOW - DELAY)
        fixture.idle.delay = 0
        fixture.idle.attempts.clear()
        fixture.idle.touch("other")
        self.assertNotIn("other", fixture.idle.activity)


class CompactTests(unittest.TestCase):
    def test_a_due_session_compacts_once_through_session_compress(self):
        fixture = Fixture(self)
        fixture.native.rows_after = 5
        result = fixture.idle.compact("default", "sid")
        self.assertEqual(result, {"status": "compressed"})
        self.assertEqual(fixture.native.calls, [{"session_id": "sid", "profile": "default"}])
        self.assertFalse(fixture.idle.owns("sid"))
        self.assertEqual(fixture.idle.after["sid"], 600)
        # The same history is never compacted twice, and no stop was ever requested.
        self.assertEqual(fixture.blocker(), "already compacted")
        self.assertEqual(fixture.events, [])

    def test_a_refused_or_failed_compaction_waits_for_the_next_turn(self):
        fixture = Fixture(self)
        def refused(method, params):
            raise RuntimeError(json.dumps({"code": 4009, "message": "session busy"}))
        fixture.idle.native = refused
        self.assertIsNone(fixture.idle.compact("default", "sid"))
        self.assertFalse(fixture.idle.owns("sid"))
        self.assertNotIn("sid", fixture.idle.after)
        self.assertEqual(fixture.blocker(), "already compacted")
        fixture.session["history_version"] += 1
        self.assertIsNone(fixture.blocker())

    def test_a_session_not_due_never_reaches_hermes(self):
        fixture = Fixture(self)
        fixture.session["running"] = True
        self.assertIsNone(fixture.idle.compact("default", "sid"))
        self.assertEqual(fixture.native.calls, [])

    def test_poll_forgets_sessions_that_are_no_longer_canonical(self):
        fixture = Fixture(self)
        fixture.idle.activity["old"], fixture.idle.settled["old"], fixture.idle.after["old"] = NOW, ("k", 1), 10
        fixture.session["running"] = True
        fixture.idle.poll()
        self.assertEqual((set(fixture.idle.activity), set(fixture.idle.settled), set(fixture.idle.after)), ({"sid"}, set(), set()))


class PreemptTests(unittest.TestCase):
    def test_nothing_to_preempt_without_a_compaction(self):
        fixture = Fixture(self)
        self.assertFalse(fixture.idle.preempt("sid"))
        self.assertEqual(fixture.events, [])

    def test_an_input_stops_the_compaction_and_the_stop_is_cleared_before_it_proceeds(self):
        fixture = Fixture(self)
        thread, results = fixture.running()
        self.assertTrue(fixture.idle.owns("sid"))
        self.assertTrue(fixture.idle.preempt("sid"))
        # By the time preempt returns, Hermes released the session and the stop request is gone,
        # so the input's own turn cannot start stopped and refuse its message.
        self.assertEqual(fixture.events, [("stop", True), ("clear", False)])
        self.assertFalse(fixture.idle.owns("sid"))
        self.assertFalse(fixture.session["running"])
        thread.join(5)
        self.assertEqual(results, [{"status": "aborted"}])
        self.assertNotIn("sid", fixture.idle.after)

    def test_the_stop_waits_until_hermes_has_marked_the_compaction_active(self):
        fixture = Fixture(self)
        fixture.native.hold_before_active.clear()
        thread = threading.Thread(target=lambda: fixture.idle.compact("default", "sid"), daemon=True)
        thread.start()
        for _ in range(500):
            if fixture.idle.owns("sid"):
                break
            time.sleep(0.01)
        preempted = []
        waiter = threading.Thread(target=lambda: preempted.append(fixture.idle.preempt("sid")), daemon=True)
        waiter.start()
        time.sleep(0.1)
        # Registered but not yet in Hermes: a stop now would land on an idle agent.
        self.assertEqual(fixture.events, [])
        fixture.native.hold_before_active.set()
        waiter.join(5)
        thread.join(5)
        self.assertEqual((preempted, fixture.events), ([True], [("stop", True), ("clear", False)]))

    def test_input_another_client_queued_in_hermes_stops_the_compaction(self):
        fixture = Fixture(self)
        thread, results = fixture.running()
        fixture.session["queued_prompt"] = {"text": "from another client"}
        thread.join(5)
        self.assertEqual((results, fixture.events), ([{"status": "aborted"}], [("stop", True), ("clear", False)]))

    def test_a_turn_hermes_drained_from_its_queue_keeps_its_stop_state(self):
        fixture = Fixture(self)
        fixture.native.drained_turn = True
        thread, _ = fixture.running()
        self.assertTrue(fixture.idle.preempt("sid"))
        thread.join(5)
        # Hermes started that turn as the compaction ended; clearing now could erase a stop meant for it.
        self.assertEqual(fixture.events, [("stop", True)])

    def test_a_stop_after_the_compaction_finished_does_nothing(self):
        fixture = Fixture(self)
        attempt = compaction.Attempt()
        attempt.finished = True
        fixture.session["_manual_compress_active"] = True
        fixture.idle.stop("sid", attempt)
        self.assertEqual((fixture.events, attempt.stopped), ([], False))

    def test_a_compaction_that_will_not_stop_releases_the_input_after_the_bound(self):
        fixture = Fixture(self)
        thread, _ = fixture.running()
        fixture.native.stopped.set = lambda: None  # This compaction ignores the stop.
        ticks = iter([0.0] + [compaction.PREEMPT_WAIT + 1] * 1000)
        fixture.idle.monotonic = lambda: next(ticks)
        with self.assertLogs(compaction.log, logging.WARNING):
            self.assertTrue(fixture.idle.preempt("sid"))
        self.assertTrue(fixture.idle.owns("sid"))
        fixture.native.release.set()
        thread.join(5)
        # The stop it ignored is still cleared before the session is let go.
        self.assertEqual(fixture.events, [("stop", True), ("clear", False)])
        self.assertFalse(fixture.idle.owns("sid"))


def bridge_with_compaction(test, hermes):
    """The bridge's own IdleCompaction, enabled, running a compaction Hermes holds until stopped."""
    events = []
    server, idle = hermes.server, hermes.bridge.compaction
    session = server._sessions["sid"]
    session.update(agent=Agent(events), history_lock=threading.RLock(), history_version=1, history=[{}] * 30)
    server._session_uses_compute_host = lambda session: False
    native = Native(server, "sid")
    def hard_interrupt(agent):
        events.append(("stop", bool(session.get("_manual_compress_active"))))
        native.stopped.set()
    patcher = patch.dict(sys.modules, {"agent.interrupt_compat": types.SimpleNamespace(request_hard_interrupt=hard_interrupt)})
    patcher.start()
    test.addCleanup(patcher.stop)
    idle.delay, idle.native, idle.size = DELAY, native, lambda session: (2000, 1000)
    idle.activity["sid"] = time.time() - DELAY
    thread = threading.Thread(target=lambda: idle.compact("default", "sid"), daemon=True)
    thread.start()
    if not native.entered.wait(5):
        raise AssertionError("The compaction never reached Hermes")
    test.addCleanup(lambda: (native.release.set(), thread.join(5)))
    return types.SimpleNamespace(events=events, native=native, thread=thread)


class BridgeTests(unittest.TestCase):
    """The add-on's admission paths treat a background compaction as no work at all."""

    def test_a_message_during_compaction_stops_it_and_starts_its_own_turn(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            fixture = bridge_with_compaction(self, hermes)
            hermes.native_calls.clear()
            # The client saw the compaction's running flag and asked to steer; there is no task to steer.
            result = hermes.methods["agent-interface.submit"]("send", {"profile": "default", "request_id": "one", "sender_id": "member",
                                                                       "text": "What's the weather?", "steer": True})["result"]
            self.assertEqual((result["status"], result["steering"], result["runId"]), ("accepted", False, "one"))
            self.assertEqual([method for method, _ in hermes.native_calls], ["prompt.submit"])
            self.assertEqual(fixture.events, [("stop", True), ("clear", False)])

    def test_a_compaction_looks_idle_to_every_client_and_its_progress_stays_private(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            fixture = bridge_with_compaction(self, hermes)
            session = hermes.server._sessions["sid"]
            session["app_exposed_reasoning"] = "Earlier turn's reasoning"
            value = {"session_id": "sid", "running": True, "info": {"running": True}, "inflight": None}
            hermes.bridge.describe_task("default", "sid", session, value)
            self.assertEqual((value["running"], value["info"]["running"], value["inflight"]), (False, False, None))
            written = []
            hermes.bridge.native_write = written.append
            progress = {"method": "event", "params": {"type": "status.update", "session_id": "sid", "payload": {"text": "compressing 30 messages"}}}
            self.assertTrue(hermes.bridge.write(progress))
            self.assertEqual(written, [])
            fixture.native.release.set()
            fixture.thread.join(5)
            hermes.bridge.write(progress)
            self.assertEqual(written, [progress])

    def test_discovery_does_not_hold_completed_events_behind_a_compaction(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            hermes.journal.event("default", "sid", "completed", "Hermes completed", "run", event_key="run:completed")
            bridge_with_compaction(self, hermes)
            # No routines: discovery reads only the journal's events.
            executions = types.SimpleNamespace(list_executions=lambda **_: [], EXECUTIONS_FILE=Path(hermes.directory.name) / "executions.db")
            cron = types.SimpleNamespace(_owner_home_scope=lambda _: contextlib.nullcontext(), _list_cron_jobs_sync=lambda _: [])
            with patch.dict(sys.modules, {"hermes_cli": types.ModuleType("hermes_cli"), "hermes_cli.web_routers": types.ModuleType("hermes_cli.web_routers"),
                                          "hermes_cli.web_routers.cron": cron, "cron": types.SimpleNamespace(executions=executions), "cron.executions": executions}):
                found = hermes.methods["agent-interface.discover"]("poll", {"cursor": "0"})["result"]["events"]
            self.assertEqual([(event["kind"], event["runId"]) for event in found], [("completed", "run")])

    def test_routine_delivery_admission_stops_a_compaction_first(self):
        with FakeGateway([]) as hermes:
            hermes.open()
            fixture = bridge_with_compaction(self, hermes)
            with hermes.bridge.delivery_admission("sid") as allowed:
                self.assertTrue(allowed)
                self.assertFalse(hermes.server._sessions["sid"]["running"])
            self.assertEqual(fixture.events, [("stop", True), ("clear", False)])


    def test_maintenance_stops_a_compaction_instead_of_waiting_for_it(self):
        with tempfile.TemporaryDirectory() as directory, FakeHermes([], environment={
                "HERMES_AGENT_INTERFACE_MAINTENANCE_FILE": str(Path(directory) / "maintenance.json"), "HERMES_AGENT_INTERFACE_TOKEN": "key"}) as hermes:
            hermes.open()
            fixture = bridge_with_compaction(self, hermes)
            lease = hermes.methods["agent-interface.maintenance"]("lease", {"service_key": "key", "action": "acquire", "operation_id": "operation-1"})
            self.assertNotIn("error", lease)
            self.assertEqual((lease["result"]["active"], lease["result"]["busy"]), (True, []))
            self.assertEqual(fixture.events, [("stop", True), ("clear", False)])


class OriginalRowTests(unittest.TestCase):
    """Copies native in-place compaction stores keep the row ID of the message they copy."""

    def store(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        db = sqlite3.connect(Path(directory.name) / "state.db", check_same_thread=False)
        self.addCleanup(db.close)
        db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, message_uid TEXT)")
        # Rows 1-4 were archived; 5 and 6 copy 2 and 4; 7 is new; 9's uid also names an older row of another session.
        db.executemany("INSERT INTO messages VALUES(?,?,?)", [(1, "stored", "a"), (2, "stored", "b"), (3, "stored", "c"), (4, "stored", "d"),
                                                             (5, "stored", "b"), (6, "stored", "d"), (7, "stored", "e"), (8, "other", "f"), (9, "stored", "f")])
        store = types.SimpleNamespace(_read_all=lambda sql, params=(): db.execute(sql, params).fetchall())
        return store

    def test_copies_show_their_originals_row_id_and_receipts_follow(self):
        store = self.store()
        with FakeGateway([{"row_id": 1, "role": "user", "text": "first"}, {"row_id": 5, "role": "user", "text": "kept"},
                          {"row_id": 6, "role": "assistant", "text": "reply"}, {"row_id": 7, "role": "user", "text": "new"},
                          {"row_id": 9, "role": "user", "text": "own"}]) as hermes:
            seen = []
            def session_db(session):
                seen.append(session.get("session_key"))
                return _Yield(store)
            hermes.server._session_db = session_db
            with hermes.journal.db:
                hermes.journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,status,row_id,terminal,created) VALUES('kept','d','default','sid','stored','member','e','kept','kept','accepted',2,1,1)")
            rows = hermes.open()["messages"]
            self.assertEqual([row["row_id"] for row in rows], [1, 2, 4, 7, 9])
            self.assertEqual((rows[1]["app_request_id"], rows[1]["app_sender_id"]), ("kept", "member"))
            self.assertEqual(seen, ["stored"])

    def test_without_a_session_store_rows_are_left_alone(self):
        with FakeGateway([{"row_id": 5, "role": "user", "text": "kept"}]) as hermes:
            hermes.server._session_db = lambda session: _Yield(None)
            self.assertEqual([row["row_id"] for row in hermes.open()["messages"]], [5])


class _Yield:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self.value

    def __exit__(self, *exc):
        return False


if __name__ == "__main__":
    unittest.main()
