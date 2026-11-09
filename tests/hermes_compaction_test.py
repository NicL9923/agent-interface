"""Idle compaction of canonical Bot Chats: when it runs, and how every input preempts it.

Hermes is a fake at its edges: the gateway's session table and ``session.compress``, the
compaction's commit fence, and its token estimator. The real gateway contract, including a
message sent during a held compaction, lives in scripts/spike/compaction_probe.py.
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
    """What the add-on reads from Hermes's agent. Anything else is an AttributeError."""
    def __init__(self, tail=1000, summary=200):
        self.context_compressor = types.SimpleNamespace(tail_token_budget=tail, max_summary_tokens=summary,
                                                        _compression_working_attempt_generation=3)
        self._cached_system_prompt = "s" * 400
        self.tools = None


def estimate(messages, *, system_prompt="", tools=None):
    # Hermes's rough estimate is characters over four; here every history row is 100 tokens.
    return len(system_prompt) // 4 + 100 * len(messages)


class Fence:
    """A compaction's CompressionCommitFence. ``answers`` are its successive try_cancel results, the last repeating:
    True cancelled, False a commit already started, None a commit holding the fence."""
    def __init__(self, native, answers):
        self.native, self.answers, self.cancelled, self.progress = native, list(answers), False, False

    @property
    def progress_observed(self):
        return self.progress

    def try_cancel_before_commit(self):
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        session = self.native.server._sessions[self.native.sid]
        self.native.events.append(("cancel", bool(session.get("_manual_compress_active")), answer))
        if answer is True:
            self.cancelled = True
        elif answer is False:
            self.native.release.set()
        return answer


class Native:
    """Hermes's ``session.compress``: holds the session running like _manual_compress_turn, publishes its
    commit fence on the agent, and returns when the fence is cancelled or the summary is released."""
    def __init__(self, server, sid, events, rows_after=None):
        self.server, self.sid, self.events, self.rows_after = server, sid, events, rows_after
        self.calls, self.entered, self.release = [], threading.Event(), threading.Event()
        self.hold_before_active, self.hold_before_dispatch = threading.Event(), threading.Event()
        self.hold_before_active.set()
        self.hold_before_dispatch.set()
        self.answers = [True]
        # Hermes's release of the session: it admits a queued turn, which reserves native admission.
        self.on_release = lambda: None

    def __call__(self, method, params):
        if method != "session.compress":
            raise AssertionError("Unexpected native call " + method)
        self.calls.append(params)
        session = self.server._sessions[self.sid]
        self.hold_before_active.wait(5)
        with session["history_lock"]:
            session["running"] = session["_manual_compress_active"] = True
            # The add-on's owned_turn seam names the thread Hermes holds the session for.
            session[compaction.OWNER] = threading.get_ident()
        fence = session["agent"]._active_compression_commit_fence = Fence(self, self.answers)
        self.entered.set()
        try:
            # Hermes builds the summary prompt, then marks this attempt's summary as working.
            self.hold_before_dispatch.wait(5)
            session["agent"].context_compressor._compression_working_attempt_generation += 1
            for _ in range(500):
                if fence.cancelled:
                    return {"status": "aborted"}
                if self.release.is_set():
                    break
                time.sleep(0.01)
            if self.rows_after is not None:
                session["history"] = session["history"][:self.rows_after]
                session["history_version"] += 1
            return {"status": "compressed"}
        finally:
            del session["agent"]._active_compression_commit_fence
            with session["history_lock"]:
                session.pop(compaction.OWNER, None)
                session.pop("_manual_compress_active", None)
                session["running"] = False
            self.on_release()


class Fixture:
    """One canonical profile with a built agent, idle long enough and over budget."""
    def __init__(self, test):
        self.events = []
        directory = tempfile.TemporaryDirectory()
        test.addCleanup(directory.cleanup)
        self.journal = extension.Journal(Path(directory.name) / "journal.db")
        test.addCleanup(self.journal.db.close)
        self.requests = types.SimpleNamespace(_lock=threading.Lock(), _open={})
        gateway = types.ModuleType("tui_gateway")
        gateway.server_requests = self.requests
        modules = {"tui_gateway": gateway, "tui_gateway.server_requests": self.requests,
                   "agent": types.ModuleType("agent"),
                   "agent.model_metadata": types.SimpleNamespace(estimate_request_tokens_rough=estimate)}
        patcher = patch.dict(sys.modules, modules)
        patcher.start()
        test.addCleanup(patcher.stop)
        self.agent = Agent()
        self.server = types.SimpleNamespace(_sessions={"sid": {
            "session_key": "stored", "agent": self.agent, "history_lock": threading.RLock(), "history_version": 4,
            "history": [{"role": "user", "content": "x"}] * 30, "last_active": NOW - DELAY}},
            _session_uses_compute_host=lambda session: bool(session.get("host")), _manual_compress_turn=lambda: None)
        self.native = Native(self.server, "sid", self.events)
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
        fences = types.SimpleNamespace(CompressionCommitFence=Fence)
        with patch.dict(sys.modules, {"agent": types.ModuleType("agent"), "agent.model_metadata": estimator, "agent.conversation_compression": fences}):
            self.assertTrue(compaction.supported(server))
            # Hermes b9cb268 and d23cc6b compacted without marking the session running.
            self.assertFalse(compaction.supported(types.SimpleNamespace(_session_uses_compute_host=lambda s: False)))
            fences.CompressionCommitFence = object
            self.assertFalse(compaction.supported(server))
        with patch.dict(sys.modules, {"agent": types.ModuleType("agent"), "agent.model_metadata": estimator, "agent.conversation_compression": None}):
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
            session = {"agent": Agent(tail=1000, summary=200), "history_lock": threading.Lock(), "history": [{}] * 3}
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
        # The same history is never compacted twice, and nothing was ever cancelled.
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

    def test_an_input_cancels_the_compaction_and_proceeds_once_hermes_lets_go(self):
        fixture = Fixture(self)
        thread, results = fixture.running()
        self.assertTrue(fixture.idle.owns("sid"))
        self.assertTrue(fixture.idle.preempt("sid"))
        self.assertEqual(fixture.events, [("cancel", True, True)])
        self.assertFalse(fixture.idle.owns("sid"))
        self.assertFalse(fixture.session["running"])
        thread.join(5)
        self.assertEqual(results, [{"status": "aborted"}])
        self.assertNotIn("sid", fixture.idle.after)

    def test_the_cancel_waits_until_hermes_has_marked_the_compaction_active(self):
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
        self.assertEqual(fixture.events, [])
        fixture.native.hold_before_active.set()
        waiter.join(5)
        thread.join(5)
        self.assertEqual((preempted, fixture.events), ([True], [("cancel", True, True)]))

    def test_the_cancel_waits_until_the_summary_has_started(self):
        # Cancelled before its summary starts, Hermes would read no progress and back off its own compaction.
        fixture = Fixture(self)
        fixture.native.hold_before_dispatch.clear()
        thread, results = fixture.running()
        preempted = []
        waiter = threading.Thread(target=lambda: preempted.append(fixture.idle.preempt("sid")), daemon=True)
        waiter.start()
        time.sleep(0.1)
        self.assertEqual(fixture.events, [])
        fixture.native.hold_before_dispatch.set()
        waiter.join(5)
        thread.join(5)
        self.assertEqual((preempted, results, fixture.events), ([True], [{"status": "aborted"}], [("cancel", True, True)]))

    def test_a_held_session_lock_cannot_keep_an_input_past_the_bound(self):
        fixture = Fixture(self)
        thread, _ = fixture.running()
        fixture.idle.monotonic = time.monotonic
        holder = threading.Thread(target=lambda: (fixture.session["history_lock"].acquire(), time.sleep(2), fixture.session["history_lock"].release()), daemon=True)
        with self.assertLogs(compaction.log, logging.WARNING):
            holder.start()
            time.sleep(0.05)
            started = time.monotonic()
            self.assertTrue(fixture.idle.preempt("sid", wait=0.3))
            self.assertLess(time.monotonic() - started, 1)
        holder.join(5)
        thread.join(5)

    def test_a_commit_holding_the_fence_is_retried_then_left_to_finish(self):
        fixture = Fixture(self)
        fixture.native.answers = [None, None, False]
        fixture.native.rows_after = 5
        thread, results = fixture.running()
        self.assertTrue(fixture.idle.preempt("sid"))
        thread.join(5)
        self.assertEqual(fixture.events, [("cancel", True, None), ("cancel", True, None), ("cancel", True, False)])
        self.assertEqual((results, fixture.idle.after["sid"]), ([{"status": "compressed"}], 600))

    def test_input_another_client_queued_in_hermes_cancels_the_compaction(self):
        fixture = Fixture(self)
        thread, results = fixture.running()
        fixture.session["queued_prompt"] = {"text": "from another client"}
        thread.join(5)
        self.assertEqual((results, fixture.events), ([{"status": "aborted"}], [("cancel", True, True)]))

    def held(self, fixture, owner=None):
        """A compaction Hermes holds for ``owner``'s thread, its summary already started."""
        attempt = compaction.Attempt(working=2)
        fixture.session["_manual_compress_active"] = True
        fixture.session[compaction.OWNER] = attempt.thread if owner is None else owner
        fixture.agent._active_compression_commit_fence = Fence(fixture.native, [True])
        return attempt

    def test_only_the_compaction_this_attempt_asked_for_is_cancelled(self):
        cases = [
            # Hermes released the session; the fence is a later turn's own compaction's.
            ("released", lambda f, a: f.session.pop(compaction.OWNER)),
            # Another client's manual compaction won the session.
            ("another client", lambda f, a: f.session.update({compaction.OWNER: a.thread + 1})),
            # This attempt already ended; the compaction now held is a later one.
            ("finished attempt", lambda f, a: a.done.set()),
        ]
        for name, change in cases:
            with self.subTest(name):
                fixture = Fixture(self)
                attempt = self.held(fixture)
                change(fixture, attempt)
                fixture.idle.stop("sid", attempt)
                self.assertEqual((fixture.events, attempt.cancelled), ([], False))
        fixture = Fixture(self)
        attempt = self.held(fixture)
        fixture.idle.stop("sid", attempt)
        self.assertEqual((fixture.events, attempt.cancelled), ([("cancel", True, True)], True))

    def test_a_compaction_that_ends_while_the_cancel_waits_for_the_session_lock_is_not_cancelled(self):
        fixture = Fixture(self)
        attempt = self.held(fixture)
        with patch.object(compaction, "LOCK_SECONDS", 5), fixture.session["history_lock"]:
            stopper = threading.Thread(target=fixture.idle.stop, args=("sid", attempt), daemon=True)
            stopper.start()
            time.sleep(0.05)
            # Hermes releases the session, and could admit a turn, under the same lock.
            fixture.session.pop(compaction.OWNER)
            fixture.session.pop("_manual_compress_active")
        stopper.join(5)
        self.assertEqual((fixture.events, attempt.cancelled), ([], False))

    def test_an_attempt_that_finishes_while_the_cancel_waits_for_the_lock_cancels_nothing_after_it(self):
        fixture = Fixture(self)
        attempt = self.held(fixture)
        with patch.object(compaction, "LOCK_SECONDS", 5), fixture.session["history_lock"]:
            stopper = threading.Thread(target=fixture.idle.stop, args=("sid", attempt), daemon=True)
            stopper.start()
            time.sleep(0.05)
            # The attempt ended, and the same poll thread now holds the session for the next one.
            attempt.done.set()
            fixture.agent._active_compression_commit_fence = Fence(fixture.native, [True])
        stopper.join(5)
        self.assertEqual((fixture.events, attempt.cancelled), ([], False))

    def test_a_stall_fallback_is_cancelled_only_once_its_own_summary_starts(self):
        fixture = Fixture(self)
        compressor = fixture.agent.context_compressor
        attempt = compaction.Attempt(working=compressor._compression_working_attempt_generation)
        fixture.session["_manual_compress_active"], fixture.session[compaction.OWNER] = True, attempt.thread
        primary = fixture.agent._active_compression_commit_fence = Fence(fixture.native, [True])
        fixture.idle.stop("sid", attempt)
        self.assertEqual(fixture.events, [])
        # The primary summary started and stalled; Hermes published a fresh fence for its fallback.
        compressor._compression_working_attempt_generation += 1
        fallback = fixture.agent._active_compression_commit_fence = Fence(fixture.native, [True])
        fixture.idle.stop("sid", attempt)
        self.assertEqual(fixture.events, [])
        compressor._compression_working_attempt_generation += 1
        fixture.idle.stop("sid", attempt)
        self.assertEqual((primary.cancelled, fallback.cancelled, attempt.cancelled), (False, True, True))

    def test_a_fallback_whose_marker_was_missed_counts_as_started_once_it_reports_progress(self):
        fixture = Fixture(self)
        attempt = self.held(fixture)
        attempt.fence = Fence(fixture.native, [True])
        fallback = fixture.agent._active_compression_commit_fence = Fence(fixture.native, [True])
        fixture.idle.stop("sid", attempt)
        self.assertFalse(fallback.cancelled)
        fallback.progress = True
        fixture.idle.stop("sid", attempt)
        self.assertTrue(fallback.cancelled)

    def test_the_seam_names_the_thread_only_while_hermes_holds_the_session(self):
        fixture = Fixture(self)
        seen = []
        @contextlib.contextmanager
        def original(sid, session):
            seen.append(("claim", session.get(compaction.OWNER)))
            yield
            # Hermes releases the session and drains its queue here.
            seen.append(("release", session.get(compaction.OWNER)))
        fixture.server._manual_compress_turn = original
        with patch.object(compaction.threading, "Thread"):
            fixture.idle.start(interval=60)
        with fixture.server._manual_compress_turn("sid", fixture.session):
            seen.append(("held", fixture.session.get(compaction.OWNER)))
        self.assertEqual(seen, [("claim", None), ("held", threading.get_ident()), ("release", None)])

    def test_a_compaction_that_cannot_be_cancelled_releases_the_input_after_the_bound(self):
        fixture = Fixture(self)
        fixture.native.answers = [None]
        thread, _ = fixture.running()
        ticks = iter([0.0] + [compaction.PREEMPT_WAIT + 1] * 1000)
        fixture.idle.monotonic = lambda: next(ticks)
        with self.assertLogs(compaction.log, logging.WARNING):
            self.assertTrue(fixture.idle.preempt("sid"))
        self.assertTrue(fixture.idle.owns("sid"))
        fixture.native.release.set()
        thread.join(5)
        self.assertFalse(fixture.idle.owns("sid"))


def bridge_with_compaction(test, hermes):
    """The bridge's own IdleCompaction, enabled, running a compaction Hermes holds until cancelled."""
    events = []
    server, idle = hermes.server, hermes.bridge.compaction
    session = server._sessions["sid"]
    session.update(agent=Agent(), history_lock=threading.RLock(), history_version=1, history=[{}] * 30)
    server._session_uses_compute_host = lambda session: False
    native = Native(server, "sid", events)
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
            self.assertEqual(fixture.events, [("cancel", True, True)])

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
            self.assertEqual(fixture.events, [("cancel", True, True)])


    def test_maintenance_stops_a_compaction_instead_of_waiting_for_it(self):
        with tempfile.TemporaryDirectory() as directory, FakeHermes([], environment={
                "HERMES_AGENT_INTERFACE_MAINTENANCE_FILE": str(Path(directory) / "maintenance.json"), "HERMES_AGENT_INTERFACE_TOKEN": "key"}) as hermes:
            hermes.open()
            fixture = bridge_with_compaction(self, hermes)
            # Hermes's release admits any queued turn through the guarded retirement gate.
            fixture.native.on_release = hermes.retirement.acquire
            # Waiting under maintenance_lock would hold that release until this bound ran out.
            started = time.monotonic()
            with patch.object(sys.modules[type(hermes.bridge.compaction).__module__], "PREEMPT_WAIT", 2):
                lease = hermes.methods["agent-interface.maintenance"]("lease", {"service_key": "key", "action": "acquire", "operation_id": "operation-1"})
            self.assertLess(time.monotonic() - started, 1)
            self.assertNotIn("error", lease)
            self.assertEqual((lease["result"]["active"], lease["result"]["busy"]), (True, []))
            self.assertEqual(fixture.events, [("cancel", True, True)])


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
