"""Opens during a turn reuse per-row results that no later write can change.

The decorated-history cache misses for the whole of a turn, so each open re-reads every row.
RowCache keeps what one open learned about rows, by keys that cannot go stale. Which row a
compaction copy copies is asked of state.db on every open, because a restored file can change
it under every mark the add-on could check. Hermes is a
fake at its edges: the session table, its native history projection and a real SQLite state
store with the columns the add-on reads. The journal is the add-on's own, in a temp directory.
"""
import contextlib
import json
import sqlite3
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from hermes_extension_journal_test import FakeHermes, extension, receipt, tool

REPORT = {"path": "/srv/report.pdf", "name": "report.pdf", "mime": "application/pdf"}
RESTORED = {"path": "/srv/restored.pdf", "name": "restored.pdf", "mime": "application/pdf"}


class TranscriptHermes(FakeHermes):
    """One canonical session mid-turn: raw history rows, the state.db they live in and a native projection.

    Native projection drops a compaction handoff, shows tool rows without their output and
    redacts registered vault values from text, as Hermes does in memory.
    """

    def __init__(self):
        super().__init__([])
        self.store_directory = tempfile.TemporaryDirectory()
        self.store_path = Path(self.store_directory.name) / "state.db"
        self.store = state_store(self.store_path, application_id=1)
        # The JSON row IDs of each lookup the add-on ran against the store.
        self.store_reads = []
        server = self.server
        self.session = {"session_key": "stored", "history": [], "history_lock": threading.Lock(), "running": True}
        server._sessions["sid"] = self.session

        def handle(request):
            method, params = request["method"], request.get("params") or {}
            self.native_calls.append((method, dict(params)))
            if method == "profiles.list":
                return server._ok(request["id"], {"profiles": [{"name": "default", "canonical_session": {"resolved_id": "stored"}}]})
            messages = [] if params.get("omit_messages") else server._history_to_messages(list(self.session["history"]))
            return server._ok(request["id"], {"session_id": "sid", "messages": messages})
        server.handle_request = handle
        server._history_to_messages = self.project
        server.project_compaction_message_for_display = lambda row: None if row.get("display_kind") == "handoff" else dict(row)

        server._session_db = self.session_db

    @contextlib.contextmanager
    def session_db(self, session):
        """Hermes's profile store handle. Its registry reacquires the file by path, so a replaced file is read."""
        connection = sqlite3.connect(self.store_path)

        def read_all(sql, params=()):
            if "json_each" in sql:
                self.store_reads.append(json.loads(params[-1]))
            return connection.execute(sql, params).fetchall()
        try:
            yield types.SimpleNamespace(db_path=str(self.store_path), _read_all=read_all)
        finally:
            connection.close()

    def replace_store(self, uids, application_id):
        """Another state.db renamed over this one: a new inode with these rows of the same stored session."""
        replacement = self.store_path.with_name("replacement.db")
        with contextlib.closing(state_store(replacement, application_id, uids)):
            pass
        self.store.close()
        replacement.replace(self.store_path)
        self.store = sqlite3.connect(self.store_path, check_same_thread=False)

    def restore_store(self, source):
        """Hermes's snapshot restore: SQLite's backup API writes the snapshot's pages into the live file."""
        with contextlib.closing(sqlite3.connect(source)) as snapshot, contextlib.closing(sqlite3.connect(self.store_path)) as live:
            snapshot.backup(live)

    def snapshot_store(self, name):
        path = self.store_path.with_name(name)
        with contextlib.closing(sqlite3.connect(path)) as copy:
            self.store.backup(copy)
        return path

    def __exit__(self, *exc):
        self.store.close()
        self.store_directory.cleanup()
        return super().__exit__(*exc)

    def project(self, history, **kwargs):
        secrets = [value for values in self.redact._VAULT_REDACTION_VALUES.values() for value in values]
        messages = []
        for row in history:
            row = self.server.project_compaction_message_for_display(row)
            if row is None:
                continue
            if row["role"] == "tool":
                messages.append({"role": "tool", "name": "terminal", "tool_call_id": row["tool_call_id"], "timestamp": row["timestamp"]})
                continue
            text = row["content"]
            for secret in secrets:
                text = text.replace(secret, "[REDACTED]")
            messages.append({"role": row["role"], "text": text, "timestamp": row["timestamp"],
                             **({"row_id": row["_row_id"]} if "_row_id" in row else {})})
        return messages

    def stored(self, uid, session="stored"):
        """A committed state.db row; its ID."""
        with self.store:
            return self.store.execute("INSERT INTO messages(session_id,message_uid) VALUES(?,?)", (session, uid)).lastrowid

    def add(self, role, uid, content, **fields):
        """A raw history row for a new committed message."""
        row = {"role": role, "content": content, "timestamp": float(len(self.session["history"])), "_row_id": self.stored(uid), **fields}
        self.session["history"].append(row)
        return row

    def replace(self, rows):
        """Hermes's ``replace_messages(active_only=True)``, as the gateway's /retry calls it: these rows deleted, then each stored again with its uid under a new ID."""
        uids = [self.store.execute("SELECT message_uid FROM messages WHERE id=?", (row["_row_id"],)).fetchone()[0] for row in rows]
        with self.store:
            self.store.executemany("DELETE FROM messages WHERE id=?", [(row["_row_id"],) for row in rows])
        self.session["history"] = [{**row, "_row_id": self.stored(uid)} for row, uid in zip(rows, uids)]

    def compact(self, rows):
        """Hermes's in-place compaction: a handoff, then each kept row stored again under a new ID."""
        self.session["history"] = [{"role": "user", "content": "Summary of earlier work", "display_kind": "handoff", "timestamp": 0.0}]
        for row in rows:
            uid = self.store.execute("SELECT message_uid FROM messages WHERE id=?", (row["_row_id"],)).fetchone()[0]
            self.session["history"].append({**row, "_row_id": self.stored(uid)})

    def __enter__(self):
        super().__enter__()
        # The first open resumes the session; only later ones activate it with a cache.
        self.open()
        return self

    def answer(self):
        """An open's result without its timings and cache counts, which differ between any two opens."""
        value = self.open()
        value.pop("app_timing")
        value.pop("app_cache")
        return value


def state_store(path, application_id, uids=()):
    """A state.db with the columns the add-on reads and Hermes's per-file generation stamp; rows of session ``stored``."""
    store = sqlite3.connect(path, check_same_thread=False)
    store.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, message_uid TEXT)")
    store.execute(f"PRAGMA application_id={application_id}")
    with store:
        store.executemany("INSERT INTO messages(session_id,message_uid) VALUES('stored',?)", [(uid,) for uid in uids])
    return store


def state_store_file(hermes, name, uids, application_id):
    path = hermes.store_path.with_name(name)
    with contextlib.closing(state_store(path, application_id, uids)):
        pass
    return path


def alice_and_bob(hermes):
    """Rows 1 to 4: Alice's message, Bob's, then two more, each uid unique; each sender's receipt bound to its row."""
    with hermes.journal.db:
        rows = [hermes.add("user", uid, f"Message {uid}") for uid in ("A", "B", "C", "Z")]
        receipt(hermes.journal.db, "alice-request", rows[0]["_row_id"], 1, actor="alice")
        receipt(hermes.journal.db, "bob-request", rows[1]["_row_id"], 2, actor="bob")
    return rows


def senders(value):
    return [(message["row_id"], message.get("app_sender_id")) for message in value["messages"]]


def tool_row(hermes, uid, call, content):
    return hermes.add("tool", uid, content, tool_call_id=call)


def first_turn(hermes):
    """A turn with a receipt, a tool call with an output file and detail, a non-JSON output and a secret."""
    with hermes.journal.db:
        user = hermes.add("user", "u1", "Summarize")
        receipt(hermes.journal.db, "first", user["_row_id"], 1, attachments=[REPORT])
        tool_row(hermes, "t1", "read", json.dumps({"pages": 3}))
        tool(hermes.journal.db, "first", "read", {"pages": 3}, artifacts=[REPORT])
        tool_row(hermes, "t2", "shell", "plain output")
        hermes.add("assistant", "a1", "Done. The token is hunter2.")


class WarmAndColdTests(unittest.TestCase):
    def assert_warm_matches_cold(self, hermes):
        warm = hermes.answer()
        hermes.bridge.row_caches.clear()
        self.assertEqual(warm, hermes.answer())
        return warm

    def test_an_open_answers_the_same_with_warm_and_cold_caches_through_every_change(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            hermes.answer()
            value = self.assert_warm_matches_cold(hermes)
            self.assertEqual([m["row_id"] for m in value["messages"]], [1, 2, 3, 4])
            self.assertEqual(value["messages"][1]["app_tool_call"]["id"], "first:read")
            # A compaction stores every kept row again; each copy shows as its original, with its receipt.
            hermes.compact(hermes.session["history"])
            value = self.assert_warm_matches_cold(hermes)
            self.assertEqual([m["row_id"] for m in value["messages"]], [1, 2, 3, 4])
            self.assertEqual(value["messages"][0]["app_request_id"], "first")
            self.assertEqual(value["messages"][1]["app_artifacts"], [REPORT])
            # A vault value registered mid-turn redacts text already shown.
            hermes.redact._VAULT_REDACTION_VALUES["/home/default"] = {"hunter2": None}
            value = self.assert_warm_matches_cold(hermes)
            self.assertEqual(value["messages"][-1]["text"], "Done. The token is [REDACTED].")
            # Hermes's prune rewrites a tool row's content in place, under the same row ID.
            pruned = hermes.session["history"][2]
            hermes.session["history"][2] = {**pruned, "content": "[pruned]"}
            value = self.assert_warm_matches_cold(hermes)
            self.assertEqual((value["messages"][1]["app_tool_result"], "app_artifacts" in value["messages"][1]), ("[pruned]", False))
            hermes.session["history"][2] = pruned
            # A second record for the same call in the same run means neither can claim the detail.
            with hermes.journal.db:
                tool(hermes.journal.db, "first", "read", {"pages": 3})
            value = self.assert_warm_matches_cold(hermes)
            self.assertNotIn("app_tool_call", value["messages"][1])
            # A new turn mid-flight: a receipt bound after the row, and a tool record written by the frame hook.
            user = hermes.add("user", "u2", "Again")
            tool_row(hermes, "t3", "list", json.dumps({"files": 2}))
            hermes.answer()
            with hermes.journal.db:
                receipt(hermes.journal.db, "second", user["_row_id"], 2)
                tool(hermes.journal.db, "second", "list", {"files": 2}, artifacts=[REPORT])
            value = self.assert_warm_matches_cold(hermes)
            self.assertEqual((value["messages"][-2]["app_request_id"], value["messages"][-1]["app_artifacts"]), ("second", [REPORT]))
            # Another stored session: rows of the first one are not its rows, and its tool records are its own.
            hermes.session["session_key"] = "stored-2"
            value = self.assert_warm_matches_cold(hermes)
            self.assertEqual(value["messages"][0]["row_id"], 5)
            self.assertNotIn("app_artifacts", value["messages"][-1])


class ReuseTests(unittest.TestCase):
    def test_a_warm_open_parses_only_rows_it_has_not_seen_and_asks_the_store_about_every_row(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            hermes.compact(hermes.session["history"])
            cold = hermes.answer()
            hermes.store_reads.clear()
            statements = []
            hermes.journal.db.set_trace_callback(statements.append)
            # Both the tool row and its journal record hold this text; neither is parsed again.
            content = hermes.session["history"][2]["content"]
            with patch.object(extension.json, "loads", wraps=json.loads) as loads:
                warm = hermes.answer()
            # Which row each copy copies is never cached: both lookups ask about every visible row.
            visible = [row["_row_id"] for row in hermes.session["history"] if "_row_id" in row]
            self.assertEqual(hermes.store_reads, [visible, visible])
            self.assertFalse([sql for sql in statements if "SELECT id,result" in sql])
            self.assertNotIn(content, [call.args[0] for call in loads.call_args_list if call.args])
            self.assertEqual(warm, cold)
            statements.clear()
            hermes.store_reads.clear()
            tool_row(hermes, "t3", "read", json.dumps({"pages": 4}))
            with hermes.journal.db:
                tool(hermes.journal.db, "first", "read", {"pages": 4})
            hermes.answer()
            hermes.journal.db.set_trace_callback(None)
            # The new record is read once, by itself.
            visible = [*visible, hermes.session["history"][-1]["_row_id"]]
            self.assertEqual(hermes.store_reads, [visible, visible])
            bodies = [sql for sql in statements if "SELECT id,result" in sql]
            self.assertEqual(len(bodies), 1)
            self.assertIn("json_each('[2]')", bodies[0])

    def test_cached_records_still_go_only_to_the_call_with_their_output_and_name(self):
        with TranscriptHermes() as hermes:
            with hermes.journal.db:
                user = hermes.add("user", "u1", "Read both")
                receipt(hermes.journal.db, "first", user["_row_id"], 1)
                tool_row(hermes, "t1", "read", json.dumps({"pages": 3}))
                tool(hermes.journal.db, "first", "read", {"pages": 9}, artifacts=[{"path": "/srv/other.pdf"}])
                tool(hermes.journal.db, "first", "read", {"pages": 3}, artifacts=[REPORT])
                tool_row(hermes, "t2", "named", json.dumps({"ok": True}))
                tool(hermes.journal.db, "first", "named", {"ok": True}, name="read_file")
            for _ in range(2):
                value = hermes.answer()
                self.assertEqual(value["messages"][1]["app_artifacts"], [REPORT])
                # Its one record is another tool's, by name.
                self.assertNotIn("app_tool_call", value["messages"][2])

    def test_changing_one_response_never_changes_another(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            for _ in range(2):
                # The first response is the one that filled the cache; the second was read from it.
                tool_message = hermes.answer()["messages"][1]
                tool_message["app_tool_result"]["pages"] = -99
                tool_message["app_artifacts"][0]["path"] = "/srv/other.pdf"
                tool_message["app_tool_call"]["name"] = "changed"
                value = hermes.answer()["messages"][1]
                self.assertEqual((value["app_tool_result"], value.get("app_artifacts"), value.get("app_tool_call", {}).get("name")),
                                 ({"pages": 3}, [REPORT], "terminal"))

    def test_other_native_history_readers_never_fill_the_cache(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            hermes.answer()
            rows = hermes.bridge.row_caches["sid"]
            rows.tool_results.clear()
            # Another client's session.history goes through the same native seam, outside an app open.
            projected = hermes.server._history_to_messages(list(hermes.session["history"]))
            self.assertEqual(projected[1]["app_tool_result"], {"pages": 3})
            self.assertEqual(rows.tool_results, {})


class InvalidationTests(unittest.TestCase):
    def test_a_row_the_store_cannot_read_yet_is_asked_again(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            hermes.answer()
            # Hermes stamps a copy's row ID before another connection can read its commit.
            copy = {**hermes.session["history"][0], "_row_id": 99}
            hermes.session["history"].append(copy)
            self.assertEqual(hermes.answer()["messages"][-1]["row_id"], 99)
            with hermes.store:
                hermes.store.execute("INSERT INTO messages(id,session_id,message_uid) VALUES(99,'stored','u1')")
            value = hermes.answer()
            self.assertEqual((value["messages"][-1]["row_id"], value["messages"][-1]["app_request_id"]), (1, "first"))

    def test_a_replaced_or_restored_state_database_answers_as_a_cold_open(self):
        # Each case starts from rows 1 to 4 (uids A, B, C, Z), a snapshot of them, and their
        # compaction copies 5 to 8 already read by one open. Another file of the same stored
        # session reuses row IDs 1 to 8; its row 5 copies its own row 3 and its row 8 has uid Z.
        other = ["Y1", "Y2", "A", "Y4", "A", "Y6", "Y7", "Z"]

        def compacted_again(hermes, rows):
            # The snapshot's rows live again; one more row is written, then compaction keeps A, C and Z
            # as rows 6 to 8, so row 6 now copies Alice's row 1 where it copied Bob's row 2 before.
            hermes.session["history"] = list(rows)
            hermes.add("user", "X", "Dropped by compaction")
            hermes.compact([rows[0], rows[2], rows[3]])

        def newer_after_divergence(hermes, rows, copies, snapshot):
            # This history goes on: compaction keeps B, C and Z as rows 9 to 11, and a snapshot is taken.
            hermes.compact(copies[2:])
            later = hermes.session["history"]
            newer = hermes.snapshot_store("newer.db")
            # The older snapshot is restored and diverges: its rows 9 to 11 copy A, C and Z, and an open reads them.
            hermes.restore_store(snapshot)
            compacted_again(hermes, rows)
            hermes.compact(hermes.session["history"][1:])
            hermes.answer()
            # The newer snapshot comes back, where row 9 copies Bob's row 2.
            hermes.restore_store(newer)
            hermes.session["history"] = later

        def divergent_replace(hermes, rows, copies, snapshot):
            # One history: replace_messages moves A, B, C and Z to rows 5 to 8, and compaction copies them to 9 to 12.
            hermes.restore_store(snapshot)
            hermes.session["history"] = list(rows)
            hermes.replace(rows)
            hermes.compact(hermes.session["history"])
            hermes.answer()
            # The other: back at the snapshot, two compactions copy them to 5 to 8, then to 9 to 12. Rows 9
            # and 5 hold uid A in both, but here the earliest row with it is Alice's row 1.
            hermes.restore_store(snapshot)
            hermes.session["history"] = list(rows)
            hermes.compact(rows)
            hermes.compact(hermes.session["history"][1:])

        cases = {
            # A new inode with the same generation stamp.
            "replaced file": (lambda hermes, rows, copies, snapshot: hermes.replace_store(other, application_id=1),
                              [(3, None), (6, None), (7, None), (8, None)]),
            # Pages written into the same inode, with another generation stamp.
            "another database restored into the file": (lambda hermes, rows, copies, snapshot: hermes.restore_store(
                state_store_file(hermes, "other.db", other, application_id=2)), [(3, None), (6, None), (7, None), (8, None)]),
            # An older snapshot, then new rows under the IDs the copies had.
            "an older snapshot restored, then written again": (lambda hermes, rows, copies, snapshot: (
                hermes.restore_store(snapshot), [hermes.stored(f"n{index}") for index in range(5, 9)]),
                [(5, None), (6, None), (7, None), (8, None)]),
            # The second review's sequence: same inode, stamp and newest row (8, Z) as before the restore.
            "an older snapshot restored, then compacted again": (
                lambda hermes, rows, copies, snapshot: (hermes.restore_store(snapshot), compacted_again(hermes, rows)),
                [(1, "alice"), (3, None), (4, None)]),
            "a newer snapshot of the same history restored after the file diverged": (
                newer_after_divergence, [(2, "bob"), (3, None), (4, None)]),
            # A copy and its recorded original both still hold their uid, yet an earlier row holds it too.
            "a divergent history in which replace_messages had moved an earlier row": (
                divergent_replace, [(1, "alice"), (2, "bob"), (3, None), (4, None)]),
        }
        for name, (change, expected) in cases.items():
            with self.subTest(name), TranscriptHermes() as hermes:
                rows = alice_and_bob(hermes)
                snapshot = hermes.snapshot_store("snapshot.db")
                hermes.compact(rows)
                copies = hermes.session["history"]
                self.assertEqual(senders(hermes.answer()), [(1, "alice"), (2, "bob"), (3, None), (4, None)])
                change(hermes, rows, copies, snapshot)
                warm = hermes.answer()
                self.assertEqual(senders(warm), expected)
                hermes.bridge.row_caches.clear()
                self.assertEqual(warm, hermes.answer())

    def test_a_restored_journal_is_read_again(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            self.assertEqual(hermes.answer()["messages"][1]["app_artifacts"], [REPORT])
            # An older journal whose record for the same call names another file, written into the live file.
            snapshot = Path(hermes.directory.name) / "journal-snapshot.db"
            with contextlib.closing(sqlite3.connect(snapshot)) as copy:
                hermes.journal.db.backup(copy)
                with copy:
                    copy.execute("UPDATE tools SET artifacts=? WHERE id=1", (json.dumps([RESTORED]),))
            with contextlib.closing(sqlite3.connect(snapshot)) as source, contextlib.closing(sqlite3.connect(Path(hermes.directory.name) / "agent-interface.db")) as live:
                source.backup(live)
            warm = hermes.answer()
            hermes.bridge.row_caches.clear()
            self.assertEqual(warm, hermes.answer())
            self.assertEqual(warm["messages"][1]["app_artifacts"], [RESTORED])

    def test_new_content_under_the_same_tool_row_is_parsed_again(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            self.assertEqual(hermes.answer()["messages"][1]["app_tool_result"], {"pages": 3})
            hermes.session["history"][1] = {**hermes.session["history"][1], "content": json.dumps({"pages": 0, "pruned": True})}
            self.assertEqual(hermes.answer()["messages"][1]["app_tool_result"], {"pages": 0, "pruned": True})

    def test_a_new_stored_session_starts_from_an_empty_cache(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            hermes.compact(hermes.session["history"])
            self.assertEqual(hermes.answer()["messages"][0]["row_id"], 1)
            # The same runtime session now stores into another session, whose rows these are not.
            hermes.session["session_key"] = "stored-2"
            self.assertEqual(hermes.answer()["messages"][0]["row_id"], 5)
            self.assertEqual(hermes.bridge.row_caches["sid"].scope, "stored-2")

    def test_a_session_no_longer_canonical_loses_its_cache(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            hermes.answer()
            bridge, sessions = hermes.bridge, hermes.server._sessions
            bridge.canonical["other"], sessions["other-sid"] = "other-sid", {"session_key": "elsewhere"}
            bridge.row_cache("other-sid", sessions["other-sid"])
            hermes.answer()
            self.assertIn("other-sid", bridge.row_caches)
            # Its session ended.
            del sessions["other-sid"]
            hermes.answer()
            self.assertNotIn("other-sid", bridge.row_caches)

    def test_each_table_keeps_only_its_newest_entries(self):
        with TranscriptHermes() as hermes, patch.object(extension, "ROW_CACHE_LIMIT", 2):
            first_turn(hermes)
            for index in range(3):
                tool_row(hermes, f"extra{index}", f"call{index}", json.dumps({"index": index}))
                with hermes.journal.db:
                    tool(hermes.journal.db, "first", f"call{index}", {"index": index})
            hermes.compact(hermes.session["history"])
            value = hermes.answer()
            rows = hermes.bridge.row_caches["sid"]
            ids = [row["_row_id"] for row in hermes.session["history"][1:]]
            self.assertEqual((list(rows.tool_results), list(rows.tool_records)), (ids[-2:], [3, 4]))
            # Rows evicted while this open filled the tables still answered it.
            self.assertEqual([m["row_id"] for m in value["messages"]], list(range(1, 8)))
            self.assertEqual([m.get("app_tool_result") for m in value["messages"][-3:]], [{"index": 0}, {"index": 1}, {"index": 2}])
            # A warm open that fills the tables again evicts entries it found there; it still uses them.
            for _ in range(2):
                self.assertEqual(hermes.answer(), value)
            hermes.bridge.row_caches.clear()
            self.assertEqual(hermes.answer(), value)


class ConcurrencyTests(unittest.TestCase):
    def test_opens_on_read_workers_beside_the_frame_writer_match_a_cold_open(self):
        with TranscriptHermes() as hermes:
            first_turn(hermes)
            server, failures, stop = hermes.server, [], threading.Event()

            def reader():
                try:
                    while not stop.is_set():
                        hermes.open()
                except Exception as exc:
                    failures.append(exc)

            def writer():
                # The frame hook records each completed tool while the transcript grows.
                try:
                    for index in range(40):
                        tool_row(hermes, f"w{index}", f"live{index}", json.dumps({"n": index}))
                        server.write_json({"method": "event", "params": {"session_id": "sid", "type": "tool.complete",
                                                                         "payload": {"tool_id": f"live{index}", "result": {"n": index}}}})
                except Exception as exc:
                    failures.append(exc)

            readers = [threading.Thread(target=reader) for _ in range(4)]
            for thread in readers:
                thread.start()
            writing = threading.Thread(target=writer)
            writing.start()
            writing.join(30)
            stop.set()
            for thread in readers:
                thread.join(30)
            self.assertEqual(failures, [])
            warm = hermes.answer()
            hermes.bridge.row_caches.clear()
            self.assertEqual(warm, hermes.answer())
            self.assertEqual(warm["messages"][-1]["app_tool_result"], {"n": 39})


if __name__ == "__main__":
    unittest.main()
