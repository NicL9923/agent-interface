"""The add-on's read of a running native turn says when that turn started.

Hermes keeps ``started_at`` on the session's turn but leaves it out of the ``inflight`` snapshot it reports. The add-on
stamps it on the snapshot so the server can place the turn's saved rows by time, not by words. Hermes is a fake at its
edge: the session table and the snapshot its gateway answers an open with.
"""
import copy
import unittest

from hermes_extension_journal_test import FakeGateway

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
