#!/usr/bin/env python3
"""Time agent-interface.open on a long transcript while a turn runs, with the Python test fakes.

A running turn keeps the decorated-history cache from answering, so every open does the work
that grows with the transcript. This builds a synthetic canonical session in a temp directory.
Each turn is five rows: a user message with its receipt, three tool calls with JSON outputs and
a journal record each, and an assistant reply. One in-place compaction, a tenth of the way in,
archives every row and stores each again, as Hermes does. The SQLite state store has Hermes's
own messages table and every index on it, in WAL mode as Hermes opens it, so the add-on's
lookups get Hermes's query plans. Native projection, the session table and activation are
fakes; nothing contacts Hermes.

Each measured open first commits one tool row and its journal record, as a turn does, so the
state.db WAL changes between any two opens, then reads the latest window. Besides the open and
its phases, it times ``original_rows``, the compaction-copy lookup inside the decorate phase.
``--repo`` names another checkout, such as an export of origin/main, to time its add-on with the
same fakes. ``--plan`` prints the query plan of every statement the add-on ran against the store.

``--contend`` also times the journal lock. It wraps ``journal.lock`` to record each thread's
outermost hold, and runs a frame thread beside the opens that records a live tool call every
millisecond, as each ``tool.start`` and ``tool.complete`` does, through the add-on's own
``record_live_tool``. It reports the open's holds, the attribution pass, and the frame thread's
lock wait and whole call, split by whether the call began during an attribution pass or during
the rest of the open, where only the interpreter lock is shared.

    python3 .agents/tools/benchmark-open-during-turn.py [--repo PATH] [--rows 5000] [--opens 30] [--plan] [--contend]
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

# Hermes's messages table and every index on it, verbatim from upstream ed1afb082eb3:
# hermes_state_common.py SCHEMA_SQL (531-561, 754-763), DEFERRED_INDEX_SQL (797-808, 883-887)
# and hermes_state_schema.py:977-978. Hermes never runs ANALYZE, so neither does this.
MESSAGES_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    effect_disposition TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,
    reasoning_content TEXT,
    reasoning_details TEXT,
    codex_reasoning_items TEXT,
    codex_message_items TEXT,
    platform_message_id TEXT,
    observed INTEGER DEFAULT 0,
    _compressed_summary INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0,
    api_content TEXT,
    display_kind TEXT,
    display_metadata TEXT,
    display_identity BLOB,
    display_order INTEGER,
    message_uid TEXT,
    absorbed_message_uids TEXT,
    tool_call_uids TEXT,
    tool_call_uid TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_assistant_calls_by_session
    ON messages(session_id)
    WHERE role = 'assistant' AND tool_calls IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_platform_msg_id
    ON messages(session_id, platform_message_id) WHERE platform_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_session_active
    ON messages(session_id, active, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_display_page
    ON messages(session_id, display_order, active DESC, id DESC)
    WHERE active = 1 OR compacted = 1;
CREATE INDEX IF NOT EXISTS idx_messages_display_backfill
    ON messages(session_id) WHERE (display_order IS NULL OR display_identity IS NULL)
    AND (active = 1 OR compacted = 1);
CREATE INDEX IF NOT EXISTS idx_messages_display_identity
    ON messages(session_id, display_identity, display_order)
    WHERE display_identity IS NOT NULL AND (active = 1 OR compacted = 1);
CREATE INDEX IF NOT EXISTS idx_messages_active_null
    ON messages(active) WHERE active IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_session_uid
    ON messages(session_id, message_uid) WHERE active = 1;
"""
fakes = None


class Store:
    """Hermes's state.db for one stored session, with the handle methods the add-on reads."""

    def __init__(self, path):
        self.db_path = str(path)
        self.db = sqlite3.connect(path, check_same_thread=False)
        # Hermes opens state.db in WAL mode (hermes_state_wal.py:254), so each commit grows the WAL.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(MESSAGES_SCHEMA)
        # Hermes stamps each file's generation into the header (hermes_state.py:1180).
        self.db.execute("PRAGMA application_id=1234567")
        # Each statement the add-on ran, with its last parameters, for --plan.
        self.statements = {}

    def add(self, role, uid, timestamp):
        return self.db.execute("INSERT INTO messages(session_id,role,timestamp,message_uid) VALUES('stored',?,?,?)", (role, timestamp, uid)).lastrowid

    def archive(self):
        """Hermes's compaction archive (hermes_state_messages.py:73): every active row, still searchable."""
        self.db.execute("UPDATE messages SET active = 0, compacted = 1 WHERE session_id = 'stored' AND active = 1")

    def _read_all(self, sql, params=()):
        self.statements[sql] = params
        return self.db.execute(sql, params).fetchall()


class TimedLock:
    """The journal's lock, recording each thread's outermost hold and the wait before it, in milliseconds."""

    def __init__(self, lock):
        self.lock, self.local = lock, threading.local()
        self.holds, self.waits = [], []

    def acquire(self, blocking=True, timeout=-1):
        started = time.perf_counter()
        got = self.lock.acquire(blocking, timeout)
        if got:
            depth = getattr(self.local, "depth", 0)
            if depth == 0:
                self.local.since = time.perf_counter()
                self.waits.append((threading.get_ident(), started, (self.local.since - started) * 1000))
            self.local.depth = depth + 1
        return got

    def release(self):
        self.local.depth -= 1
        if self.local.depth == 0:
            self.holds.append((threading.get_ident(), self.local.since, (time.perf_counter() - self.local.since) * 1000))
        self.lock.release()

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()
        return False


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
        row = {"role": role, "content": content, "timestamp": float(self.count), "_row_id": self.store.add(role, f"uid{self.count}", float(self.count)), **fields}
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
        """Hermes's in-place compaction: archive every row, then a handoff and each kept row stored again under a new ID."""
        uids = dict(self.store.db.execute("SELECT id,message_uid FROM messages WHERE session_id='stored'").fetchall())
        self.store.archive()
        kept = [{**row, "_row_id": self.store.add(row["role"], uids[row["_row_id"]], row["timestamp"])} for row in self.history]
        self.history[:] = [{"role": "user", "content": "Summary", "display_kind": "handoff", "timestamp": 0.0}, *kept]


def build(hermes, store, rows):
    """Five-row turns: a user message, three tool calls and a reply, compacted once a tenth of the way in."""
    transcript = Transcript(hermes, store)
    with hermes.journal.db, store.db:
        while transcript.count < rows:
            if transcript.count == rows // 10:
                transcript.compact()
            transcript.user()
            for _ in range(3):
                transcript.call()
            transcript.row("assistant", "Done")
    return transcript


def main():
    global fakes
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--rows", type=int, default=5000)
    parser.add_argument("--opens", type=int, default=30)
    parser.add_argument("--plan", action="store_true", help="print the query plan of each statement the add-on ran against the store")
    parser.add_argument("--contend", action="store_true", help="time journal lock holds, and a frame thread recording live tool calls beside the opens")
    args = parser.parse_args()
    sys.path.insert(0, str(args.repo.resolve() / "tests"))
    import hermes_extension_journal_test
    fakes = hermes_extension_journal_test
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
            tools = sum(row["role"] == "tool" for row in transcript.history)
            open_ = hermes.methods["agent-interface.open"]
            bridge, lookups = open_.__self__, []
            original_rows = bridge.original_rows

            def timed_original_rows(*args):
                started = time.perf_counter()
                try:
                    return original_rows(*args)
                finally:
                    lookups.append((time.perf_counter() - started) * 1000)
            bridge.original_rows = timed_original_rows
            passes, frames = [], []
            if args.contend:
                lock = hermes.journal.lock = TimedLock(hermes.journal.lock)
                attribute = bridge.attribute

                def timed_attribute(*args, **kwargs):
                    started = time.perf_counter()
                    try:
                        return attribute(*args, **kwargs)
                    finally:
                        passes.append((started, time.perf_counter()))
                bridge.attribute = timed_attribute
            for _ in range(2):
                open_("warm", {"profile": "default", "window": {"turns": 20}})
            durations, phases, spans = [], [], []
            del lookups[:]
            # The first warm-up open parses every tool row and journal record: a cold row cache.
            cold = [(end - start) * 1000 for start, end in passes[:1]]
            del passes[:]
            stop = threading.Event()

            def frame_thread():
                # Each tool.start and tool.complete frame records the call; tool.complete also inserts a row.
                payload = {"tool_id": "live", "name": "terminal", "args": {"command": "ls"}}
                while not stop.is_set():
                    started = time.perf_counter()
                    before = len(lock.waits)
                    bridge.record_live_tool("sid", hermes.session, "tool.start", payload)
                    ended = time.perf_counter()
                    waits = [wait for ident, _, wait in lock.waits[before:] if ident == threading.get_ident()]
                    frames.append((started, sum(waits), (ended - started) * 1000))
                    time.sleep(0.001)
            if args.contend:
                contender = threading.Thread(target=frame_thread, name="frames", daemon=True)
                contender.start()
                del lock.holds[:]
            for _ in range(args.opens):
                wal = Path(store.db_path + "-wal").stat()
                with hermes.journal.db, store.db:
                    transcript.call()
                after = Path(store.db_path + "-wal").stat()
                if (wal.st_size, wal.st_mtime_ns) == (after.st_size, after.st_mtime_ns):
                    sys.exit("The write before an open left the state.db WAL unchanged; this would not model a running turn.")
                started = time.perf_counter()
                result = open_("poll", {"profile": "default", "window": {"turns": 20}})["result"]
                durations.append((time.perf_counter() - started) * 1000)
                spans.append((started, time.perf_counter()))
                phases.append(result["app_timing"])
            if args.contend:
                stop.set()
                contender.join(5)
            if len(lookups) != args.opens:
                sys.exit(f"{args.opens - len(lookups)} opens skipped the compaction-copy lookup; they did not model a running turn.")

            def summary(values):
                values = sorted(values)
                return f"median {statistics.median(values):.1f} ms, p90 {values[int(len(values) * 0.9) - 1]:.1f} ms"
            print(f"Repository: {args.repo}")
            print(f"Python {platform.python_version()}, SQLite {sqlite3.sqlite_version} on {platform.system()} {platform.machine()}")
            print(f"Transcript: {visible} visible rows ({tools} tool rows) at the first measured open, a running turn, {args.opens} opens")
            print(f"Open, wall: {summary(durations)}, max {max(durations):.1f} ms")
            for name in phases[0]:
                print(f"  {name}: {summary(phase[name] for phase in phases)}")
            print(f"  original_rows (in decorate): {summary(lookups)}")
            if args.contend:
                opener = threading.get_ident()
                within = lambda moment, ranges: any(start <= moment < end for start, end in ranges)
                holds = [hold for ident, since, hold in lock.holds if ident == opener and within(since, spans)]
                print(f"Journal lock, opener's holds during measured opens ({len(holds)}): {summary(holds)}, max {max(holds):.1f} ms")
                print(f"  attribution pass: {summary([(end - start) * 1000 for start, end in passes])}; cold row cache, first open: {cold[0]:.1f} ms")
                during = [frame for frame in frames if within(frame[0], passes)]
                rest = [frame for frame in frames if within(frame[0], spans) and not within(frame[0], passes)]
                for name, group in (("began during an attribution pass", during), ("began in the rest of an open", rest)):
                    if group:
                        print(f"Frame thread, {len(group)} calls that {name}:")
                        print(f"  journal lock wait: {summary([frame[1] for frame in group])}, max {max(frame[1] for frame in group):.1f} ms")
                        print(f"  whole call: {summary([frame[2] for frame in group])}, max {max(frame[2] for frame in group):.1f} ms")
            if args.plan:
                for sql, params in store.statements.items():
                    print(f"\n{sql}")
                    for row in store.db.execute("EXPLAIN QUERY PLAN " + sql, params):
                        print(f"  {row[3]}")


if __name__ == "__main__":
    main()
