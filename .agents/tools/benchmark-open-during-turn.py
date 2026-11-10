#!/usr/bin/env python3
"""Time agent-interface.open on a long transcript while a turn runs, with the Python test fakes.

A running turn keeps the decorated-history cache from answering, so every open does the work
that grows with the transcript. This builds a synthetic canonical session in a temp directory:
ROWS visible rows after one in-place compaction, a tool call every few rows with a JSON output,
a receipt per turn and a journal record per call, a SQLite state store with Hermes's message
index. Native projection, the session table and activation are fakes; nothing contacts Hermes.

Each measured open first appends one tool row and its journal record, as a turn does, then
reads the latest window. ``--repo`` names another checkout, such as an export of origin/main,
to time its add-on with the same fakes.

    python3 .agents/tools/benchmark-open-during-turn.py [--repo PATH] [--rows 5000] [--opens 30]
"""
import argparse
import json
import platform
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument("--rows", type=int, default=5000)
parser.add_argument("--opens", type=int, default=30)
args = parser.parse_args()
sys.path.insert(0, str(args.repo.resolve() / "tests"))
import hermes_extension_journal_test as fakes  # noqa: E402


class Store:
    """Hermes's messages table, reduced to the columns and index the add-on's lookup reads."""

    def __init__(self, path):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, message_uid TEXT)")
        self.db.execute("CREATE INDEX idx_messages_session_uid ON messages(session_id, message_uid)")

    def add(self, uid):
        return self.db.execute("INSERT INTO messages(session_id,message_uid) VALUES('stored',?)", (uid,)).lastrowid

    def _read_all(self, sql, params=()):
        return self.db.execute(sql, params).fetchall()


class Yield:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self.value

    def __exit__(self, *exc):
        return False


def project(history, **kwargs):
    """Hermes's compact history view: tool rows without their output."""
    messages = []
    for row in history:
        if row.get("display_kind") == "handoff":
            continue
        if row["role"] == "tool":
            messages.append({"role": "tool", "name": "terminal", "tool_call_id": row["tool_call_id"], "timestamp": row["timestamp"]})
        else:
            messages.append({"role": row["role"], "text": row["content"], "timestamp": row["timestamp"], "row_id": row["_row_id"]})
    return messages


class Transcript:
    def __init__(self, hermes, store):
        self.hermes, self.store, self.count, self.turn = hermes, store, 0, None
        self.history = hermes.session["history"]

    def row(self, role, content, **fields):
        self.count += 1
        row = {"role": role, "content": content, "timestamp": float(self.count), "_row_id": self.store.add(f"uid{self.count}"), **fields}
        self.history.append(row)
        return row

    def user(self):
        self.turn = f"run{self.count}"
        row = self.row("user", f"Question {self.count}")
        fakes.receipt(self.hermes.journal.db, self.turn, row["_row_id"], float(self.count))

    def call(self):
        call, output = f"call{self.count}", {"exit_code": 0, "output": "line of output\n" * 100, "lines": list(range(20))}
        self.row("tool", json.dumps(output), tool_call_id=call)
        fakes.tool(self.hermes.journal.db, self.turn, call, output)

    def compact(self):
        """Hermes's in-place compaction: a handoff, then every kept row stored again under a new ID."""
        kept = [{**row, "_row_id": self.store.add(self.store._read_all("SELECT message_uid FROM messages WHERE id=?", (row["_row_id"],))[0][0])}
                for row in self.history]
        self.history[:] = [{"role": "user", "content": "Summary", "display_kind": "handoff", "timestamp": 0.0}, *kept]


def build(hermes, store, rows):
    transcript = Transcript(hermes, store)
    with hermes.journal.db, store.db:
        # A tenth of the transcript was kept by a compaction; the rest came after it.
        while transcript.count < rows:
            if transcript.count == rows // 10:
                transcript.compact()
            transcript.user()
            for _ in range(3):
                transcript.call()
            transcript.row("assistant", "Done")
    return transcript


def main():
    with tempfile.TemporaryDirectory() as directory:
        store = Store(Path(directory) / "state.db")
        hermes = fakes.FakeHermes([])
        hermes.session = {"session_key": "stored", "history": [], "history_lock": threading.Lock(), "running": True}
        server = hermes.server
        server._sessions["sid"] = hermes.session
        server._history_to_messages = project
        server.project_compaction_message_for_display = lambda row: dict(row)
        server._session_db = lambda session: Yield(store)

        def handle(request):
            params = request.get("params") or {}
            if request["method"] == "profiles.list":
                return server._ok(request["id"], {"profiles": [{"name": "default", "canonical_session": {"resolved_id": "stored"}}]})
            messages = [] if params.get("omit_messages") else server._history_to_messages(list(hermes.session["history"]))
            return server._ok(request["id"], {"session_id": "sid", "messages": messages})
        server.handle_request = handle
        with hermes:
            transcript = build(hermes, store, args.rows)
            visible = len(transcript.history)
            open_ = hermes.methods["agent-interface.open"]
            for _ in range(2):
                open_("warm", {"profile": "default", "window": {"turns": 20}})
            durations, phases = [], []
            for _ in range(args.opens):
                with hermes.journal.db, store.db:
                    transcript.call()
                started = time.perf_counter()
                result = open_("poll", {"profile": "default", "window": {"turns": 20}})["result"]
                durations.append((time.perf_counter() - started) * 1000)
                phases.append(result["app_timing"])
            durations.sort()
            print(f"Repository: {args.repo}")
            print(f"Python {platform.python_version()} on {platform.system()} {platform.machine()}")
            print(f"Transcript: {visible} visible rows at the first measured open, a running turn, {args.opens} opens")
            print(f"Open, wall: median {statistics.median(durations):.1f} ms, p90 {durations[int(len(durations) * 0.9) - 1]:.1f} ms, "
                  f"max {durations[-1]:.1f} ms")
            for name in phases[0]:
                print(f"  {name}: median {statistics.median(phase[name] for phase in phases):.1f} ms")


main()
