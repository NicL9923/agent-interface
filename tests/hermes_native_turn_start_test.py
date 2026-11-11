"""The add-on's read of a running native turn says when that turn started.

Hermes keeps ``started_at`` on the session's turn but leaves it out of the ``inflight`` snapshot it reports. The add-on
stamps it on the snapshot so the server can place the turn's saved rows by time, not by words. Hermes is a fake at its
edge: the session table and the snapshot its gateway answers an open with.
"""
import copy
import unittest

from hermes_extension_journal_test import FakeGateway, FakeHermes

STARTED = 1_790_779_733.179978
TURN = {"user": "Check the barn", "assistant": "Barn checked.", "started_at": STARTED, "streaming": True, "updated_at": STARTED + 3}
SNAPSHOT = {"user": "Check the barn", "assistant": "Barn checked.", "streaming": True}


def open_turn(turn, snapshot):
    """The open Hermes's gateway answers with ``snapshot`` while the session's own turn is ``turn``."""
    with FakeGateway([]) as hermes:
        server = hermes.server
        server._sessions["sid"] = {"session_key": "stored", "running": True, "inflight_turn": turn}
        native = server.handle_request

        def answer(request):
            response = native(request)
            if request["method"] != "profiles.list":
                response["result"]["inflight"] = copy.deepcopy(snapshot)
            return response
        server.handle_request = answer
        return hermes.open()["inflight"]


ROW_AT = STARTED - 0.4


class QueuedHermes(FakeHermes):
    """Hermes running a prompt through ``_run_prompt_submit`` as upstream does at ``ed1afb0``.

    A drain writes the prompt's row first and stages it as ``_submit_user_row`` (``_replace_queued_user_row_for_turn``,
    ``session_auto_continue.py:493``), then ``_admit_prompt_turn`` starts the turn with the clock at ``STARTED``
    (``prompt_turn.py:157``, ``_start_inflight_turn``). An ordinary prompt.submit started the turn at ``prompt.submit`` and writes its row after.
    """
    def start(self, path):
        def admit(rid, sid, session, text, **kwargs):
            inflight = session.get("inflight_turn")
            if not isinstance(inflight, dict) or inflight.get("status") == "error":
                session["inflight_turn"] = {"user": text.strip(), "assistant": "", "started_at": STARTED, "streaming": True, "updated_at": STARTED}
        self.server._run_prompt_submit = admit
        return super().start(path)

    def run(self, session, text, staged=None, **kwargs):
        """A turn for ``text``: the add-on's wrapped ``_run_prompt_submit`` with ``staged`` as the session's staged row."""
        session.pop("inflight_turn", None)
        session.update({"session_key": "stored", "running": True})
        if staged is None:
            session.pop("_submit_user_row", None)
        else:
            session["_submit_user_row"] = staged
        self.server._run_prompt_submit("rid", "sid", session, text, **kwargs)
        return session

    def start_after(self, session, snapshot):
        """The open Hermes answers with ``snapshot`` while the session holds the turn it started."""
        native = self.server.handle_request
        def answer(request):
            response = native(request)
            if request["method"] != "profiles.list":
                response["result"]["inflight"] = copy.deepcopy(snapshot)
            return response
        self.server.handle_request = answer
        return self.open()["inflight"].get("started_at")


class QueuedPromptStartTests(unittest.TestCase):
    def started(self, text, staged, session=None, snapshot=None, **kwargs):
        with QueuedHermes([]) as hermes:
            hermes.server._sessions["sid"] = {} if session is None else session
            hermes.run(hermes.server._sessions["sid"], text, staged, **kwargs)
            return hermes.start_after(hermes.server._sessions["sid"], snapshot or {"user": text.strip(), "assistant": "", "streaming": True})

    def test_a_queued_prompt_starts_where_its_row_was_saved_before_hermes_started_the_turn(self):
        staged = {"role": "user", "content": "Check the barn", "timestamp": ROW_AT, "_row_id": 5}
        self.assertEqual(self.started("Check the barn", staged), ROW_AT)

    def test_an_ordinary_prompt_whose_row_is_saved_after_the_turn_started_keeps_the_start(self):
        staged = {"role": "user", "content": "Check the barn", "timestamp": STARTED + 0.2, "_row_id": 5}
        self.assertEqual(self.started("Check the barn", staged), STARTED)

    def test_a_turn_with_no_staged_row_keeps_the_start(self):
        self.assertEqual(self.started("Check the barn", None), STARTED)

    def test_a_staged_row_that_is_not_this_turns_prompt_or_has_no_usable_time_is_ignored(self):
        # An earlier send whose turn never ran can leave its row staged, and a row Hermes stamps oddly must not move the start.
        for name, staged in [("another prompt", {"content": "Check the loft", "timestamp": ROW_AT}),
                             ("not a row", "Check the barn"), ("no time", {"content": "Check the barn"}),
                             ("a string time", {"content": "Check the barn", "timestamp": "1790779732"}),
                             ("a boolean time", {"content": "Check the barn", "timestamp": True}),
                             ("zero", {"content": "Check the barn", "timestamp": 0}),
                             ("not a number", {"content": "Check the barn", "timestamp": float("nan")})]:
            with self.subTest(name):
                self.assertEqual(self.started("Check the barn", staged), STARTED)

    def test_a_turn_never_carries_the_row_of_the_turn_before(self):
        # The queued turn ends, then a prompt of the same words runs with no row staged: its start is its own.
        with QueuedHermes([]) as hermes:
            session = hermes.server._sessions["sid"] = {}
            hermes.run(session, "Check the barn", {"content": "Check the barn", "timestamp": ROW_AT})
            hermes.run(session, "Check the barn")
            self.assertEqual(hermes.start_after(session, {"user": "Check the barn", "assistant": "", "streaming": True}), STARTED)

    def test_a_row_kept_for_another_prompt_does_not_start_a_turn_of_different_words(self):
        # The turn on the session is not the prompt the row belongs to (a goal continuation after a queued prompt).
        with QueuedHermes([]) as hermes:
            session = hermes.server._sessions["sid"] = {}
            hermes.run(session, "Check the barn", {"content": "Check the barn", "timestamp": ROW_AT})
            session["inflight_turn"]["user"] = "[Resume] Plan the trip"
            self.assertEqual(hermes.start_after(session, {"user": "[Resume] Plan the trip", "assistant": "", "streaming": True}), STARTED)

    def test_the_row_is_read_for_the_text_the_turn_runs_whatever_its_spacing(self):
        staged = {"content": "  Check the barn\n", "timestamp": ROW_AT}
        self.assertEqual(self.started("  Check the barn\n", staged, snapshot={"user": "Check the barn", "assistant": "", "streaming": True}), ROW_AT)


class TurnStartTests(unittest.TestCase):
    def test_the_running_turns_start_rides_on_its_snapshot_and_nothing_else_changes(self):
        self.assertEqual(open_turn(TURN, SNAPSHOT), {**SNAPSHOT, "started_at": STARTED})

    def test_a_turn_that_has_grown_since_the_snapshot_is_still_that_turn(self):
        grown = {**TURN, "assistant": "Barn checked. Door shut."}
        self.assertEqual(open_turn(grown, SNAPSHOT)["started_at"], STARTED)

    def test_a_snapshot_of_another_turn_gets_no_start(self):
        # A new turn began after the snapshot was taken: its start would put the snapshot's rows before the turn.
        for name, turn in [("another prompt", {**TURN, "user": "Check the loft"}),
                           ("the same prompt, a new reply", {**TURN, "assistant": "Looking."}),
                           ("the same prompt, no reply yet", {**TURN, "assistant": ""})]:
            with self.subTest(name):
                self.assertNotIn("started_at", open_turn(turn, SNAPSHOT))

    def test_a_turn_with_no_usable_start_gets_none(self):
        # Hermes makes a turn with no start when text arrives before any prompt did.
        without = {key: value for key, value in TURN.items() if key != "started_at"}
        for name, started in [("missing", without), ("none", {**TURN, "started_at": None}), ("a string", {**TURN, "started_at": "1790779733"}),
                              ("a boolean", {**TURN, "started_at": True}), ("zero", {**TURN, "started_at": 0}),
                              ("negative", {**TURN, "started_at": -1.5}), ("not a number", {**TURN, "started_at": float("nan")}),
                              ("infinite", {**TURN, "started_at": float("inf")})]:
            with self.subTest(name):
                self.assertNotIn("started_at", open_turn(started, SNAPSHOT))

    def test_no_snapshot_or_no_turn_gets_no_inflight_at_all(self):
        self.assertIsNone(open_turn(TURN, None))
        self.assertEqual(open_turn(None, SNAPSHOT), SNAPSHOT)
        self.assertEqual(open_turn("not a turn", SNAPSHOT), SNAPSHOT)


if __name__ == "__main__":
    unittest.main()
