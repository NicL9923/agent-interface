"""App sends on per-assistant lanes, off the socket's reader, with the journal lock held only for journal statements.

Hermes is a fake at its edges: native dispatch and handle_request, which reserve retirement admission as
rpc_dispatch does; image.attach, prompt.submit and session.steer, which a test can hold or fail per
assistant; and session.compress for a background compaction. The bridge, its lanes, the journal and the
idle compactor are the real code.
"""
import logging
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from hermes_compaction_test import DELAY, Agent, Native
from hermes_extension_journal_test import PooledHermes, Replies, saved

ADMISSION = ("image.attach", "prompt.submit", "session.steer")


class LaneHermes(PooledHermes):
    """Two assistants, "slow" and "fast", behind native dispatch, with Hermes's admission calls held per assistant.

    Each native handle_request call holds a retirement reservation while it runs, as native's does, so
    maintenance sees every request in flight. ``hold(method, profile)`` returns an Event the next such
    call waits on; ``fail[(method, profile)]`` makes them raise. Each call records the transport bound
    while it ran. prompt.submit marks the session running, as native admission does.
    """
    def __init__(self, environment=None):
        super().__init__(environment)
        self.held.set()
        self.retiring = False
        counting = self.retirement.acquire
        self.retirement.acquire = lambda: not self.retiring and counting()
        self.retirement.active_count = lambda: self.active[0]
        self.gates, self.fail, self.calls, self.changed = {}, {}, [], threading.Condition()
        server = self.server
        pooled = server.handle_request

        def admit(request):
            method, params = request["method"], request.get("params") or {}
            profile = params.get("profile")
            with self.changed:
                self.calls.append((method, profile, params.get("text", params.get("path")), self.transport.current_transport()))
                gates = self.gates.get((method, profile))
                gate = gates.pop(0) if gates else None
                self.changed.notify_all()
            if gate is not None and not gate.wait(10):
                raise RuntimeError("The test never released " + method)
            if (method, profile) in self.fail:
                raise self.fail[(method, profile)]
            session = server._sessions["sid-" + profile]
            if method == "image.attach":
                session.setdefault("attached_images", []).append(params["path"])
                return server._ok(request["id"], {"attached": True})
            if method == "session.steer":
                return server._ok(request["id"], {"status": "queued", "text": params["text"]})
            session["running"] = True
            return server._ok(request["id"], {"status": "streaming"})

        def handle(request):
            if not self.retirement.acquire():
                return server._err(request.get("id"), 5035, "backend is retiring; reconnect to continue")
            try:
                return admit(request) if request["method"] in ADMISSION else pooled(request)
            finally:
                self.retirement.release()
        server.handle_request = handle

    def __enter__(self):
        super().__enter__()
        for profile in ("slow", "fast"):
            self.server.handle_request({"id": "open", "method": "agent-interface.open", "params": {"profile": profile}})
            self.server._sessions["sid-" + profile].update(history_lock=threading.RLock(), attached_images=[])
        return self

    def __exit__(self, *exc):
        for gates in self.gates.values():
            for gate in gates:
                gate.set()
        return super().__exit__(*exc)

    def hold(self, method, profile):
        gate = threading.Event()
        self.gates.setdefault((method, profile), []).append(gate)
        return gate

    def reached(self, method, profile, count=1):
        """Wait until ``count`` calls of ``method`` for ``profile`` have reached Hermes; True if they did."""
        with self.changed:
            return self.changed.wait_for(lambda: sum(call[:2] == (method, profile) for call in self.calls) >= count, 5)

    def send(self, rid, profile, replies, **params):
        """Dispatch an app send as the socket's reader does; returns what dispatch returned to the reader."""
        return self.server.dispatch({"id": rid, "method": "agent-interface.submit", "params": {
            "profile": profile, "request_id": rid, "sender_id": "member", "text": "Message " + rid, **params}}, replies)

    def settled(self):
        """Admission reservations still held, waiting up to 3 seconds for answered requests to release theirs."""
        deadline = time.monotonic() + 3
        while self.active[0] and time.monotonic() < deadline:
            time.sleep(0.01)
        return self.active[0]

    def free(self):
        """Whether another thread can take the journal lock and the submission lock at once."""
        result = []
        def probe():
            for lock in (self.journal.lock, self.bridge.submission_lock):
                got = lock.acquire(timeout=1)
                result.append(got)
                if got:
                    lock.release()
        thread = threading.Thread(target=probe)
        thread.start()
        thread.join(5)
        return result == [True, True]


def compacting(test, hermes, profile):
    """A background compaction of the assistant's canonical session that cannot be cancelled: its commit
    holds the fence until the test sets ``release``, so a preempt waits for it."""
    events, server, idle = [], hermes.server, hermes.bridge.compaction
    sid = "sid-" + profile
    server._sessions[sid].update(agent=Agent(), history_version=1, history=[{}] * 30)
    server._session_uses_compute_host = lambda session: False
    native = Native(server, sid, events)
    native.answers = [None]
    idle.delay, idle.native, idle.size = DELAY, native, lambda session: (2000, 1000)
    idle.activity[sid] = time.time() - DELAY
    thread = threading.Thread(target=lambda: idle.compact(profile, sid), daemon=True)
    thread.start()
    if not native.entered.wait(5):
        raise AssertionError("The compaction never reached Hermes")
    test.addCleanup(lambda: (native.release.set(), thread.join(5)))
    return native


def within(call, seconds=2):
    """``call()``'s result, run on another thread; fails if it is still blocked after ``seconds``."""
    result = []
    thread = threading.Thread(target=lambda: result.append(call()), daemon=True)
    thread.start()
    thread.join(seconds)
    if thread.is_alive():
        raise AssertionError("Blocked: " + getattr(call, "__name__", repr(call)))
    return result[0] if result else None


def tool_frames(hermes, sid, tool_id):
    for kind, payload in (("tool.start", {"tool_id": tool_id, "name": "terminal", "args": {"command": "ls"}}),
                          ("tool.complete", {"tool_id": tool_id, "name": "terminal", "result": {"exit_code": 0}})):
        hermes.bridge.write({"method": "event", "params": {"type": kind, "session_id": sid, "payload": payload}})


class SendLaneTests(unittest.TestCase):
    def test_a_send_waiting_for_a_compaction_holds_up_no_other_assistant(self):
        with LaneHermes() as hermes:
            native = compacting(self, hermes, "slow")
            replies, server = Replies(), hermes.server
            with self.assertLogs(level=logging.INFO) as logs:
                # The reader hands both sends to their lanes and reads on.
                self.assertIsNone(hermes.send("slow-send", "slow", replies))
                with hermes.changed:
                    self.assertTrue(hermes.changed.wait_for(lambda: native.events, 5))
                # The slow send is waiting for the compaction to let go. Everything else answers.
                self.assertIsNone(hermes.send("fast-send", "fast", replies))
                server.dispatch({"id": "fast-open", "method": "agent-interface.open", "params": {"profile": "fast"}}, replies)
                self.assertTrue(replies.wait("fast-send", "fast-open"), replies.answers)
                self.assertEqual(replies.answers["fast-send"]["result"]["status"], "accepted")
                self.assertEqual(replies.answers["fast-open"]["result"]["session_id"], "sid-fast")
                lookup = server.dispatch({"id": "lookup", "method": "agent-interface.receipt", "params": {"request_id": "fast-send"}}, replies)
                self.assertEqual(lookup["result"]["receipt"]["status"], "accepted")
                self.assertNotIn("slow-send", replies.answers)
                self.assertTrue(hermes.free())
                time.sleep(0.2)
                native.release.set()
                self.assertTrue(replies.wait("slow-send"))
            slow = replies.answers["slow-send"]["result"]
            # The compaction was the only work, so the send starts its own task.
            self.assertEqual((slow["status"], slow["steering"], slow["runId"]), ("accepted", False, "slow-send"))
            self.assertGreaterEqual(slow["app_timing"]["preempt"], 150)
            self.assertLess(slow["app_timing"]["wait"], 100)
            self.assertTrue(any("background compaction to stop" in line and "slow" in line for line in logs.output), logs.output)
            self.assertEqual(hermes.settled(), 0)

    def test_a_send_staging_images_leaves_the_journal_to_everyone_else(self):
        with LaneHermes() as hermes:
            replies, server = Replies(), hermes.server
            staging = hermes.hold("image.attach", "slow")
            hermes.send("photo", "slow", replies, attachments=[{"path": "/photo.png", "mime": "image/png"}])
            self.assertTrue(hermes.reached("image.attach", "slow"))
            # Another assistant's open and tool frames, and a lookup of the send itself, read the journal now.
            server.dispatch({"id": "fast-open", "method": "agent-interface.open", "params": {"profile": "fast"}}, replies)
            self.assertTrue(replies.wait("fast-open"))
            within(lambda: tool_frames(hermes, "sid-fast", "listing"))
            recorded = hermes.journal.db.execute("SELECT stored_session,tool_id FROM tools").fetchall()
            self.assertEqual(recorded, [("stored-fast", "listing")])
            lookup = within(lambda: server.dispatch({"id": "lookup", "method": "agent-interface.receipt", "params": {"request_id": "photo"}}, replies))
            self.assertEqual(lookup["result"]["receipt"]["status"], "uncertain")
            # No other admission, such as a routine delivery to the same chat, takes the staged images.
            delivered = threading.Event()
            def deliver():
                with hermes.bridge.delivery_admission("sid-slow"):
                    delivered.set()
            delivery = threading.Thread(target=deliver, daemon=True)
            delivery.start()
            self.assertFalse(delivered.wait(0.3))
            time.sleep(0.2)
            staging.set()
            self.assertTrue(replies.wait("photo"))
            self.assertTrue(delivered.wait(5))
            delivery.join(5)
            photo = replies.answers["photo"]["result"]
            self.assertEqual(photo["status"], "accepted")
            self.assertGreaterEqual(photo["app_timing"]["staging"], 150)
            self.assertEqual(hermes.server._sessions["sid-slow"]["attached_images"], ["/photo.png"])
            self.assertEqual(hermes.settled(), 0)

    def test_one_assistants_sends_are_admitted_in_arrival_order_on_the_callers_transport(self):
        with LaneHermes() as hermes:
            replies = Replies()
            admitting = hermes.hold("prompt.submit", "slow")
            hermes.send("first", "slow", replies)
            self.assertTrue(hermes.reached("prompt.submit", "slow"))
            hermes.send("second", "slow", replies)
            # While Hermes admits the first, its turn can start and stream: the journal is free.
            self.assertTrue(within(lambda: hermes.bridge.app_prompt("sid-slow", "Message first")))
            within(lambda: tool_frames(hermes, "sid-slow", "early"))
            self.assertEqual(hermes.journal.db.execute("SELECT run_id FROM tools").fetchall(), [("first",)])
            self.assertEqual([call[2] for call in hermes.calls], ["Message first"])
            time.sleep(0.2)
            admitting.set()
            self.assertTrue(replies.wait("first", "second"))
            self.assertEqual([(method, text) for method, _, text, _ in hermes.calls],
                             [("prompt.submit", "Message first"), ("session.steer", "Message second")])
            self.assertTrue(all(transport is replies for *_, transport in hermes.calls))
            first, second = (replies.answers[rid]["result"] for rid in ("first", "second"))
            self.assertEqual((first["runId"], first["steering"], second["runId"], second["steering"]), ("first", False, "first", True))
            self.assertGreaterEqual(first["app_timing"]["native"], 150)
            self.assertGreaterEqual(second["app_timing"]["queued"], 150)
            self.assertEqual(list(first["app_timing"]), ["queued", "open", "preempt", "wait", "journal", "staging", "native", "total"])
            self.assertGreaterEqual(first["app_timing"]["total"], first["app_timing"]["queued"] + first["app_timing"]["native"])

    def test_a_duplicate_arriving_mid_admission_gets_the_same_answer_and_is_admitted_once(self):
        with LaneHermes() as hermes:
            replies, other = Replies(), Replies()
            admitting = hermes.hold("prompt.submit", "slow")
            hermes.send("dup", "slow", replies)
            self.assertTrue(hermes.reached("prompt.submit", "slow"))
            # The same request again, from this connection and from another.
            hermes.server.dispatch({"id": "again", "method": "agent-interface.submit", "params": {
                "profile": "slow", "request_id": "dup", "sender_id": "member", "text": "Message dup"}}, replies)
            hermes.send("dup", "slow", other)
            admitting.set()
            self.assertTrue(replies.wait("dup", "again") and other.wait("dup"))
            first = replies.answers["dup"]["result"]
            self.assertEqual(first["status"], "accepted")
            self.assertEqual(saved(first), replies.answers["again"]["result"])
            self.assertEqual(saved(first), other.answers["dup"]["result"])
            self.assertNotIn("app_timing", other.answers["dup"]["result"])
            self.assertEqual([call[0] for call in hermes.calls], ["prompt.submit"])
            self.assertEqual(hermes.journal.db.execute("SELECT count(*) FROM receipts").fetchone(), (1,))

    def test_a_request_id_sent_to_another_assistant_mid_admission_is_refused_as_a_conflict(self):
        with LaneHermes() as hermes:
            replies = Replies()
            admitting = hermes.hold("prompt.submit", "slow")
            hermes.send("shared", "slow", replies)
            self.assertTrue(hermes.reached("prompt.submit", "slow"))
            # Another lane, so it runs beside the first; only submission_lock decides the owner.
            conflict = Replies()
            hermes.server.dispatch({"id": "conflict", "method": "agent-interface.submit", "params": {
                "profile": "fast", "request_id": "shared", "sender_id": "member", "text": "Message shared"}}, conflict)
            admitting.set()
            self.assertTrue(replies.wait("shared") and conflict.wait("conflict"))
            self.assertEqual(conflict.answers["conflict"]["error"]["code"], 4093)
            first = replies.answers["shared"]["result"]
            self.assertEqual((first["status"], first["runId"]), ("accepted", "shared"))
            self.assertEqual(saved(first), hermes.journal.admission_response("shared"))
            self.assertEqual([call[:2] for call in hermes.calls], [("prompt.submit", "slow")])

    def test_a_compaction_that_will_not_stop_holds_a_send_for_the_preempt_bound_once(self):
        with LaneHermes() as hermes:
            compacting(self, hermes, "slow")
            replies = Replies()
            with patch.object(sys.modules[type(hermes.bridge.compaction).__module__], "PREEMPT_WAIT", 0.5), self.assertLogs(level=logging.WARNING):
                hermes.send("stuck", "slow", replies)
                self.assertTrue(replies.wait("stuck"))
            stuck = replies.answers["stuck"]["result"]
            # It proceeds beside the compaction, as an ordinary new task, after one bound and not two.
            self.assertEqual((stuck["status"], stuck["steering"]), ("accepted", False))
            self.assertGreaterEqual(stuck["app_timing"]["preempt"], 450)
            self.assertLess(stuck["app_timing"]["preempt"], 900)
            self.assertTrue(hermes.bridge.compaction.owns("sid-slow"))

    def test_maintenance_treats_queued_and_running_sends_as_active_work(self):
        with tempfile.TemporaryDirectory() as directory:
            lease = Path(directory) / "maintenance.json"
            with LaneHermes({"HERMES_AGENT_INTERFACE_MAINTENANCE_FILE": str(lease), "HERMES_AGENT_INTERFACE_TOKEN": "key"}) as hermes:
                replies, server = Replies(), hermes.server
                maintenance = lambda action: server.dispatch({"id": action, "method": "agent-interface.maintenance", "params": {
                    "service_key": "key", "action": action, "operation_id": "operation-1"}}, replies)
                admitting = hermes.hold("prompt.submit", "slow")
                hermes.send("running", "slow", replies)
                self.assertTrue(hermes.reached("prompt.submit", "slow"))
                before = hermes.active[0]
                hermes.send("waiting", "slow", replies)
                # The waiting send holds its own reservation before any thread runs it.
                self.assertEqual(hermes.active[0], before + 1)
                refused = maintenance("acquire")
                self.assertEqual((refused["error"]["code"], lease.exists()), (409, False))
                self.assertIn("active work", refused["error"]["message"])
                admitting.set()
                self.assertTrue(replies.wait("running", "waiting"))
                self.assertEqual(hermes.settled(), 0)
                # Its turn ends; nothing is in flight.
                server._sessions["sid-slow"]["running"] = False
                self.assertTrue(maintenance("acquire")["result"]["active"])
                # Under the lease a send is refused before it reaches a lane, and leaves no receipt.
                held = hermes.send("late", "slow", replies)
                self.assertEqual(held["error"]["code"], 409)
                self.assertIsNone(hermes.journal.receipt("late"))
                self.assertFalse(maintenance("release")["result"]["active"])
                # A retiring gateway refuses a send at arrival, before any receipt.
                hermes.retiring = True
                self.assertEqual(hermes.send("retiring", "slow", replies)["error"]["code"], 5035)
                self.assertIsNone(hermes.journal.receipt("retiring"))
                self.assertEqual([call[2] for call in hermes.calls], ["Message running", "Message waiting"])

    def test_a_failure_in_a_queued_send_answers_its_caller_and_leaves_no_lock_held(self):
        with LaneHermes() as hermes:
            replies = Replies()
            hermes.fail[("prompt.submit", "slow")] = RuntimeError("Synthetic native failure")
            hermes.send("lost", "slow", replies)
            self.assertTrue(replies.wait("lost"))
            lost = replies.answers["lost"]["result"]
            # Hermes may have admitted it before failing, so it stays uncertain and is never replayed.
            self.assertEqual((lost["status"], lost["message"]), ("uncertain", "Synthetic native failure"))
            self.assertTrue(hermes.free())
            hermes.fail[("image.attach", "fast")] = RuntimeError("Synthetic image failure")
            hermes.send("photo", "fast", replies, attachments=[{"path": "/photo.png", "mime": "image/png"}])
            self.assertTrue(replies.wait("photo"))
            self.assertEqual(replies.answers["photo"]["result"]["status"], "rejected")
            self.assertTrue(hermes.free())
            # A handler that raises outside Hermes's calls, here on a profile that is not a name, still answers.
            hermes.server.dispatch({"id": "bad", "method": "agent-interface.submit", "params": {
                "profile": ["slow"], "request_id": "bad", "sender_id": "member", "text": "Hello"}}, replies)
            hermes.server.dispatch({"id": "bad-open", "method": "agent-interface.open", "params": {"profile": {"name": "slow"}}}, replies)
            self.assertTrue(replies.wait("bad", "bad-open"))
            self.assertEqual((replies.answers["bad"]["error"]["code"], replies.answers["bad-open"]["error"]["code"]), (-32000, -32000))
            self.assertTrue(hermes.free())
            # The lane goes on: the next send to the failed assistant gets its answer.
            hermes.send("next", "fast", replies)
            self.assertTrue(replies.wait("next"))
            self.assertEqual(replies.answers["next"]["result"]["status"], "accepted")
            self.assertEqual(hermes.settled(), 0)


if __name__ == "__main__":
    unittest.main()
