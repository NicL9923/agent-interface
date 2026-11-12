"""An app open reuses Hermes's projection of each unchanged piece of a long history and answers as a whole projection.

ProjectionMemo cuts a history where no tool row reads a call named before the cut, projects each piece
alone, and keeps each piece's projection for the next open. Hermes is a fake at its edges: the session
table, a real SQLite state store, the redaction registry, the profile's config.yaml, and a native
projection that, like Hermes's ``_history_to_messages``, labels each tool row from the last call an
assistant row named with its ID, hidden assistant rows included. The answer with no readable redaction
state, which never memoizes, is the whole projection every memoized answer must equal.
"""
import json
import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from hermes_extension_journal_test import extension, receipt
from hermes_open_row_cache_test import TranscriptHermes


def call(call_id, name, **arguments):
    return {"id": call_id, "function": {"name": name, "arguments": json.dumps(arguments)}}


class ProjectingHermes(TranscriptHermes):
    """TranscriptHermes whose native projection carries tool calls from row to row and reads the profile's language.

    ``native_inputs`` holds the row IDs of every native projection call, so a test sees which rows were projected.
    ``numbered`` adds cross-row state the add-on does not know about, which only shadow mode can catch.
    """

    def __init__(self):
        super().__init__()
        self.native_inputs, self.numbered = [], False
        self.home = tempfile.TemporaryDirectory()
        self.kwargs = {"profile_home": self.home.name}
        server = self.server

        def handle(request):
            method, params = request["method"], request.get("params") or {}
            self.native_calls.append((method, dict(params)))
            if method == "profiles.list":
                return server._ok(request["id"], {"profiles": [{"name": "default", "canonical_session": {"resolved_id": "stored"}}]})
            messages = [] if params.get("omit_messages") else server._history_to_messages(list(self.session["history"]), **self.kwargs)
            return server._ok(request["id"], {"session_id": "sid", "messages": messages})
        server.handle_request = handle

    def __enter__(self):
        # Every safe cut is taken, so these short histories are cut into turns as a long one is into longer pieces.
        self.pieces = patch.object(extension, "PIECE_ROWS", 1)
        self.pieces.start()
        return super().__enter__()

    def __exit__(self, *exc):
        self.pieces.stop()
        self.home.cleanup()
        return super().__exit__(*exc)

    def project(self, history, *, profile_home=None, image_urls=True):
        self.native_inputs.append([row.get("_row_id") if isinstance(row, dict) else None for row in history])
        config = Path(profile_home or "/nonexistent") / "config.yaml"
        language = config.read_text().strip() if config.exists() else "en"
        secrets = [value for values in self.redact._VAULT_REDACTION_VALUES.values() for value in values]
        calls, messages = {}, []
        for row in history:
            if not isinstance(row, dict):
                continue
            row = self.server.project_compaction_message_for_display(row)
            if row is None:
                continue
            if row["role"] == "assistant" and row.get("tool_calls"):
                for named in row["tool_calls"]:
                    function = named.get("function", {})
                    if named.get("id", "") and function.get("name"):
                        calls[named["id"]] = (function["name"], json.loads(function.get("arguments") or "{}"))
            if row.get("display_kind") == "hidden":
                continue
            if row["role"] == "tool":
                name, arguments = calls.get(row.get("tool_call_id") or "", (None, None))
                message = {"role": "tool", "name": name or "tool", "label": f"{language}:{name or 'tool'}", "args": arguments or {},
                           "tool_call_id": row["tool_call_id"], "timestamp": row["timestamp"]}
            else:
                text = row["content"]
                for secret in secrets:
                    text = text.replace(secret, "[REDACTED]")
                message = {"role": row["role"], "text": text if image_urls else text.replace("![photo]", "[image]"), "timestamp": row["timestamp"],
                           **({"row_id": row["_row_id"]} if "_row_id" in row else {}),
                           **({"display_kind": row["display_kind"]} if row.get("display_kind") else {})}
            if self.numbered:
                message["n"] = len(messages)
            messages.append(message)
        return messages

    def projected(self):
        """The row IDs native projection was given since the last call, then forgets them."""
        rows = {row for rows in self.native_inputs for row in rows}
        self.native_inputs.clear()
        return rows

    def whole(self):
        """The answer with no readable redaction state: projected whole, the memo left as it is."""
        with patch.dict(sys.modules, {"agent.redact": types.SimpleNamespace()}):
            return self.answer()


def turns(hermes):
    """Four turns that test every way a tool row reads a call named before it. Returns each turn's rows."""
    add = hermes.add
    first = [add("user", "u1", "Read both. The token is hunter2."),
             add("assistant", "a1", "", tool_calls=[call("c1", "read", path="a"), call("c2", "read", path="b")]),
             add("tool", "t1", "a", tool_call_id="c1"),
             # A steer delivered inside the tool batch: a user row that starts no turn.
             add("user", "s1", "Also look at c", display_kind="steer"),
             add("tool", "t2", "b", tool_call_id="c2"),
             add("assistant", "a2", "Both read. ![photo]")]
    second = [add("user", "u2", "Fetch it"),
              # A hidden assistant row still names the call its tool row reads, after a steer.
              add("assistant", "a3", "", display_kind="hidden", tool_calls=[call("c3", "fetch", url="x")]),
              add("user", "s2", "Quickly", display_kind="steer"),
              add("tool", "t3", "fetched", tool_call_id="c3"),
              add("assistant", "a4", "Fetched.")]
    # The model reuses c1; the next turn's late result reads this call, not the first one.
    third = [add("user", "u3", "Write it"),
             add("assistant", "a5", "", tool_calls=[call("c1", "write", path="c")]),
             add("tool", "t4", "written", tool_call_id="c1"),
             add("assistant", "a6", "Written.")]
    fourth = [add("user", "u4", "Status?"),
              add("tool", "t5", "late", tool_call_id="c1"),
              add("assistant", "a7", "All done.")]
    return first, second, third, fourth


def ids(rows):
    return {row["_row_id"] for row in rows}


class EquivalenceTests(unittest.TestCase):
    def assert_whole(self, hermes):
        memoized = hermes.answer()
        hermes.projected()
        self.assertEqual(memoized, hermes.whole())
        hermes.projected()
        return memoized

    def test_a_memoized_open_answers_as_a_whole_projection_through_every_change(self):
        with ProjectingHermes() as hermes:
            first, second, third, fourth = turns(hermes)
            value = self.assert_whole(hermes)
            tools = [(m["name"], m["args"]) for m in value["messages"] if m["role"] == "tool"]
            self.assertEqual(tools, [("read", {"path": "a"}), ("read", {"path": "b"}), ("fetch", {"url": "x"}),
                                     ("write", {"path": "c"}), ("write", {"path": "c"})])
            # Nothing changed: no row is projected again.
            self.assertEqual(hermes.answer(), value)
            self.assertEqual(hermes.projected(), set())
            # An appended turn is the only piece projected, and so is the piece a row is appended to.
            fifth = [hermes.add("user", "u5", "One more"), hermes.add("assistant", "a8", "Sure.")]
            hermes.answer()
            self.assertEqual(hermes.projected(), ids(fifth))
            self.assert_whole(hermes)
            hermes.session["history"].append({"role": "assistant", "content": "Six.", "timestamp": 99.0})
            hermes.answer()
            self.assertEqual(hermes.projected(), ids(fifth) | {None})
            # A middle row edited to text of the same length, under the same row ID: only its piece is projected again.
            # The fourth turn's tool row reads the third turn's call, so the two turns are one piece.
            index = hermes.session["history"].index(fourth[2])
            hermes.session["history"][index] = {**fourth[2], "content": "All good."}
            value = self.assert_whole(hermes)
            self.assertIn("All good.", [m.get("text") for m in value["messages"]])
            hermes.answer()
            hermes.session["history"][index] = {**fourth[2], "content": "Done here"}
            hermes.answer()
            self.assertEqual(hermes.projected(), ids(third) | ids(fourth))
            # A flush stamps a live row's ID in place.
            unsaved = hermes.session["history"][-1]
            unsaved["_row_id"] = hermes.stored("a9")
            value = self.assert_whole(hermes)
            self.assertEqual(value["messages"][-1]["row_id"], unsaved["_row_id"])
            # A live row changed in place where the cheap key cannot see it: same row ID, same length.
            unsaved["content"] = "Six!"
            value = self.assert_whole(hermes)
            self.assertEqual(value["messages"][-1]["text"], "Six!")
            # Compaction rewrites every kept row under a new ID, after a handoff.
            hermes.compact(hermes.session["history"][len(first):])
            value = self.assert_whole(hermes)
            self.assertNotIn("Read both. The token is hunter2.", [m.get("text") for m in value["messages"]])
            self.assertEqual(value["messages"][0]["row_id"], second[0]["_row_id"])

    def test_what_a_projection_reads_besides_its_rows_projects_again(self):
        with ProjectingHermes() as hermes:
            turns(hermes)
            hermes.answer()
            hermes.projected()
            changes = {
                "a vault value registered mid-turn": lambda: hermes.redact._VAULT_REDACTION_VALUES.update({"/home/default": {"hunter2": None}}),
                "the profile's language": lambda: (Path(hermes.home.name) / "config.yaml").write_text("fr"),
                "the projection's arguments": lambda: hermes.kwargs.update(image_urls=False),
            }
            for name, change in changes.items():
                with self.subTest(name):
                    before = hermes.answer()
                    change()
                    value = self.assert_whole(hermes)
                    self.assertNotEqual(value, before)
                    hermes.answer()
                    self.assertEqual(hermes.projected(), set())
            texts = [m.get("text") or m.get("label") for m in value["messages"]]
            self.assertIn("Read both. The token is [REDACTED].", texts)
            self.assertIn("fr:read", texts)
            self.assertIn("Both read. [image]", texts)

    def test_without_readable_redaction_state_every_open_projects_every_row(self):
        with ProjectingHermes() as hermes:
            turns(hermes)
            hermes.whole()
            hermes.projected()
            hermes.whole()
            self.assertEqual(hermes.projected(), {row["_row_id"] for row in hermes.session["history"]})

    def test_a_row_that_is_not_a_mapping_projects_as_hermes_skips_it(self):
        with ProjectingHermes() as hermes:
            first, *_ = turns(hermes)
            hermes.session["history"].insert(3, None)
            self.assertEqual(self.assert_whole(hermes), hermes.whole())


class CopyTests(unittest.TestCase):
    def test_decoration_never_reaches_a_kept_projection(self):
        with ProjectingHermes() as hermes:
            _, _, _, fourth = turns(hermes)
            with hermes.journal.db:
                receipt(hermes.journal.db, "status", fourth[0]["_row_id"], 1)
            for _ in range(2):
                message = next(m for m in hermes.answer()["messages"] if m.get("row_id") == fourth[0]["_row_id"])
                self.assertEqual(message["app_request_id"], "status")
            with hermes.journal.db:
                hermes.journal.db.execute("DELETE FROM receipts WHERE request_id='status'")
            message = next(m for m in hermes.answer()["messages"] if m.get("row_id") == fourth[0]["_row_id"])
            self.assertNotIn("app_request_id", message)


class BudgetTests(unittest.TestCase):
    def test_a_history_beyond_the_budget_keeps_its_first_pieces_and_projects_the_rest(self):
        with ProjectingHermes() as hermes:
            first, second, third, fourth = turns(hermes)
            memo = None
            with patch.object(extension, "PROJECTION_BUDGET", sum(extension.text_size(row) for row in first + second)):
                hermes.bridge.row_caches.clear()
                value = hermes.answer()
                memo = hermes.bridge.row_caches["sid"].projections
                self.assertLessEqual(memo.size, memo.budget)
                hermes.projected()
                self.assertEqual(hermes.answer(), value)
                self.assertEqual(hermes.projected(), ids(third) | ids(fourth))
            self.assertEqual(value, hermes.whole())

    def test_a_new_stored_session_starts_an_empty_memo(self):
        with ProjectingHermes() as hermes:
            turns(hermes)
            hermes.answer()
            hermes.projected()
            hermes.session["session_key"] = "stored-2"
            hermes.answer()
            self.assertEqual(hermes.projected(), {row["_row_id"] for row in hermes.session["history"]})


class ShadowTests(unittest.TestCase):
    def test_shadow_mode_answers_with_the_whole_projection_and_says_where_the_memo_differs(self):
        with ProjectingHermes() as hermes, patch.dict(os.environ, {extension.PROJECTION_SHADOW: "1"}):
            turns(hermes)
            value = hermes.answer()
            self.assertEqual(value.pop("app_projection_shadow"), {"segments": 3, "reused": 0, "difference": None, "tool_difference": None})
            value = hermes.answer()
            self.assertEqual(value.pop("app_projection_shadow")["reused"], 3)
            self.assertEqual(value, hermes.whole())
            # Native state the memo does not model: messages numbered across the whole history.
            hermes.numbered = True
            hermes.redact._VAULT_REDACTION_VALUES["/home/default"] = {"unused": None}
            with self.assertLogs(extension.__name__, logging.WARNING) as logs:
                value = hermes.answer()
            report = value.pop("app_projection_shadow")
            # The second piece starts at message 6 and numbers from 0 again.
            self.assertEqual((report["difference"], report["tool_difference"]), (6, None))
            self.assertIn("differed from the whole one at message 6", logs.output[0])
            self.assertEqual([m["n"] for m in value["messages"]], list(range(len(value["messages"]))))
            self.assertEqual(value, hermes.whole())

    def test_shadow_mode_is_off_unless_set(self):
        with ProjectingHermes() as hermes, patch.dict(os.environ, {extension.PROJECTION_SHADOW: "0"}):
            turns(hermes)
            self.assertNotIn("app_projection_shadow", hermes.answer())


class CutTests(unittest.TestCase):
    def test_a_history_is_cut_only_at_user_rows_no_later_tool_row_reads_across(self):
        rows = [{"role": "user"}, {"role": "assistant", "tool_calls": [call("c1", "read")]}, {"role": "user", "display_kind": "steer"},
                {"role": "tool", "tool_call_id": "c1"}, {"role": "user"}, {"role": "assistant", "tool_calls": [{"id": "c2", "function": {}}]},
                {"role": "user"}, {"role": "tool", "tool_call_id": "c2"}, "not a row", {"role": "user"}]
        # A call without a name names nothing for Hermes, so its tool row reads nothing.
        self.assertEqual(extension.projection_cuts(rows, dict, least=1), [0, 4, 6, 9])
        # A row Hermes's compaction projection hides names nothing.
        self.assertEqual(extension.projection_cuts(rows[:4], lambda row: None if row.get("tool_calls") else dict(row), least=1), [0, 2])

    def test_each_piece_but_the_last_holds_the_least_rows_and_rows_added_later_move_no_cut(self):
        rows = [{"role": "user" if index % 2 == 0 else "assistant"} for index in range(12)]
        self.assertEqual(extension.projection_cuts(rows, dict, least=3), [0, 4, 8])
        self.assertEqual(extension.projection_cuts(rows[:9], dict, least=3), [0, 4, 8])
        self.assertEqual(extension.projection_cuts(rows, dict), [0])

    def test_a_call_hermes_cannot_read_raises_as_hermes_does(self):
        for bad in (["not a call"], [{"id": ["unhashable"], "function": {"name": "read"}}]):
            with self.subTest(bad), self.assertRaises((AttributeError, TypeError)):
                extension.projection_cuts([{"role": "assistant", "tool_calls": bad}], dict)


if __name__ == "__main__":
    unittest.main()
