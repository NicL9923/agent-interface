"""Revision-bound Hermes gateway add-on, without changes to core execution or state.db.

Launch from the tested Hermes environment with HERMES_HOME set by its supervisor:
python src/hermes/extension.py --port 19119
See docs/HermesCapabilityMatrix.md. Journal contains private runtime data, never commit it.
"""
import argparse
import atexit
import collections
import concurrent.futures
import contextvars
import datetime
import hashlib
import json
import math
import logging
import os
import sqlite3
import threading
import time
import uuid
import weakref
import contextlib
import functools
import re
import mimetypes
import subprocess
import importlib.util
import inspect
import hmac
import sys
from pathlib import Path

REVISION = "b9cb268deffc97946ec11645aa622a7353dd0591"
QUALIFIED_REVISIONS = {REVISION, "d23cc6b06455b8551fb6f61d3cad040a0e82f5b6"}
QUALIFIED_OAUTH_PATCH = "2b8335c692f100640e375ffd338f26f6d86195a4ff91c2000e3306bcea9d671c"


class NativeResponseError(RuntimeError):
    """A native RPC refusal, distinct from losing its response after admission."""
    def __init__(self, error):
        super().__init__(json.dumps(error))
        self.code = error.get("code")
        self.error = error

    @property
    def refused_admission(self):
        # Qualified native handlers return these before invoking or queueing a turn.
        return self.code in (-32601, -32602, 4000, 4001, 4002, 4010, 4090, 409, 5035)

    @property
    def refusal_message(self):
        if self.code == 409:
            return "Hermes is paused for maintenance. Your draft is saved. Try again when maintenance finishes."
        if self.code == 4090:
            return "Hermes cannot start another task right now. Your draft is saved. Try again after its current work settles."
        if self.code in (4001, 4010, 5035):
            return "Hermes was starting or reconnecting and did not accept this message. Your draft is saved. Try sending it again."
        return "Hermes could not accept this message. Your draft is saved. Reconnect and try again."


def sibling_module(name):
    """Load src/hermes/NAME.py once per process, under its one canonical module name.

    A second load under another name would be a separate instance with its own state.
    Keep every copy of this function identical; tests/hermes_private_fs_test.py checks.
    """
    canonical, path = "agent_interface_" + name, Path(__file__).resolve().with_name(name + ".py")
    if canonical not in sys.modules:
        spec = importlib.util.spec_from_file_location(canonical, path)
        sys.modules[canonical] = module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except BaseException:
            del sys.modules[canonical]
            raise
    module = sys.modules[canonical]
    if Path(module.__file__).resolve() != path:
        raise ImportError(canonical + " is already loaded from " + module.__file__)
    return module


private_fs = sibling_module("private_fs")


def qualification_module():
    return sibling_module("qualification")


def source_state():
    """Qualify imported Hermes, including tracked local repairs, without logging their contents."""
    import hermes_cli
    source = Path(hermes_cli.__file__).resolve().parents[1]
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    # Pin abbreviated object names: repair hashes cover diff text, and every recorded hash used 10.
    patch = subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", str(source), "diff", "HEAD"])
    patch_hash = hashlib.sha256(patch).hexdigest() if patch else None
    known = actual in QUALIFIED_REVISIONS and patch_hash in (None, QUALIFIED_OAUTH_PATCH)
    if not known:
        try:
            qualification = qualification_module()
            provisional = qualification.provisional_revision()
            if provisional == actual and patch_hash == (os.environ.get("HERMES_SPIKE_PATCH_SHA256") or None):
                return actual, patch_hash
            receipt = qualification.read_receipt(os.environ.get("HERMES_AGENT_INTERFACE_QUALIFICATION_FILE", ""), Path(__file__).resolve().parents[2])
            known = receipt["revision"] == actual and receipt["trackedPatchSha256"] == patch_hash
        except (OSError, ValueError, KeyError, TypeError):
            known = False
    if not known:
        raise SystemExit("Hermes source or tracked repair differs from the qualified add-on. Run compatibility probes before deployment.")
    return actual, patch_hash


def _profile_version_triggers(table):
    bump = "INSERT INTO profile_versions(profile,version) VALUES({}.profile,1) ON CONFLICT(profile) DO UPDATE SET version=version+1;"
    return f"""
    CREATE TRIGGER IF NOT EXISTS {table}_version_insert AFTER INSERT ON {table} BEGIN {bump.format("new")} END;
    CREATE TRIGGER IF NOT EXISTS {table}_version_delete AFTER DELETE ON {table} BEGIN {bump.format("old")} END;
    CREATE TRIGGER IF NOT EXISTS {table}_version_update AFTER UPDATE ON {table} BEGIN {bump.format("new")} END;
    CREATE TRIGGER IF NOT EXISTS {table}_version_moved AFTER UPDATE OF profile ON {table} WHEN old.profile IS NOT new.profile
        BEGIN {bump.format("old")} END;"""


# Journal.version: the tables a decorated history reads, counted per profile.
PROFILE_VERSION_SCHEMA = "CREATE TABLE IF NOT EXISTS profile_versions(profile TEXT PRIMARY KEY, version INTEGER NOT NULL);" + "".join(
    _profile_version_triggers(table) for table in ("receipts", "tools"))


class Journal:
    def __init__(self, path):
        self.epoch = uuid.uuid4().hex
        self.lock = threading.RLock()
        # Photos a send's turn ran without, by request ID, until the answer that saves them has been written.
        self.images_missing = {}
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL, stored_session TEXT, actor TEXT NOT NULL, epoch TEXT NOT NULL, run_id TEXT, input_text TEXT, attachments TEXT, steering INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, row_id INTEGER, terminal INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, occurred REAL NOT NULL, epoch TEXT NOT NULL,event_key TEXT,routine_id TEXT);
        CREATE TABLE IF NOT EXISTS tools(id INTEGER PRIMARY KEY AUTOINCREMENT,profile TEXT NOT NULL,stored_session TEXT NOT NULL,run_id TEXT,tool_id TEXT,result TEXT NOT NULL,artifacts TEXT);
        CREATE TABLE IF NOT EXISTS interruptions(profile TEXT NOT NULL,stored_session TEXT NOT NULL,request_id TEXT NOT NULL,created REAL NOT NULL,PRIMARY KEY(profile,stored_session));
        """)
        if "run_id" not in {row[1] for row in self.db.execute("PRAGMA table_info(receipts)")}:
            self.db.execute("ALTER TABLE receipts ADD COLUMN run_id TEXT")
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(receipts)")}
        if "input_text" not in columns:
            self.db.execute("ALTER TABLE receipts ADD COLUMN input_text TEXT")
        if "steering" not in columns:
            self.db.execute("ALTER TABLE receipts ADD COLUMN steering INTEGER NOT NULL DEFAULT 0")
        for column in ("stored_session", "attachments", "admission_response", "turn_rows"):
            if column not in columns:
                self.db.execute(f"ALTER TABLE receipts ADD COLUMN {column} TEXT")
        if "artifacts" not in {row[1] for row in self.db.execute("PRAGMA table_info(tools)")}:
            self.db.execute("ALTER TABLE tools ADD COLUMN artifacts TEXT")
        if "detail" not in {row[1] for row in self.db.execute("PRAGMA table_info(tools)")}:
            self.db.execute("ALTER TABLE tools ADD COLUMN detail TEXT")
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(events)")}
        for column in ("event_key", "routine_id"):
            if column not in columns:
                self.db.execute(f"ALTER TABLE events ADD COLUMN {column} TEXT")
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS events_identity ON events(event_key) WHERE event_key IS NOT NULL")
        # Every conversation poll reads these; without them each read scans its table.
        self.db.execute("CREATE INDEX IF NOT EXISTS receipts_session ON receipts(session_id,created)")
        self.db.execute("CREATE INDEX IF NOT EXISTS receipts_owner ON receipts(profile,stored_session,created)")
        self.db.execute("CREATE INDEX IF NOT EXISTS receipts_row ON receipts(row_id)")
        self.db.execute("CREATE INDEX IF NOT EXISTS tools_call ON tools(profile,stored_session,tool_id,run_id)")
        self.db.execute("CREATE INDEX IF NOT EXISTS events_session ON events(profile,session_id)")
        self.db.executescript(PROFILE_VERSION_SCHEMA)
        self.db.execute("CREATE INDEX IF NOT EXISTS events_run ON events(run_id)")
        with self.db:
            for request_id, profile, sid, stored in self.db.execute("SELECT COALESCE(run_id,request_id),profile,session_id,stored_session FROM receipts WHERE terminal=0 AND status IN ('accepted','uncertain')").fetchall():
                self.event(profile, sid, "interrupted", "Hermes restarted. Review before retrying.", request_id, event_key=f"{request_id}:interrupted")
                if stored:
                    self.db.execute("INSERT OR REPLACE INTO interruptions(profile,stored_session,request_id,created) VALUES(?,?,?,?)", (profile, stored, request_id, time.time()))
            self.db.execute("UPDATE receipts SET status='interrupted',terminal=1 WHERE terminal=0 AND status IN ('accepted','uncertain')")

    def version(self, profile):
        """How many times the profile's receipts and tools have changed, the journal rows its decorated history reads.

        Counted by triggers, so every writer counts, sibling add-ons and other processes included, and a write for
        one assistant never invalidates another's history. A rollback may invalidate unnecessarily, but can never
        reuse stale rows.
        """
        row = self.db.execute("SELECT version FROM profile_versions WHERE profile=?", (profile,)).fetchone()
        return row[0] if row else 0

    def has_event(self, event_key):
        with self.lock:
            return self.db.execute("SELECT 1 FROM events WHERE event_key=?", (event_key,)).fetchone() is not None

    def event(self, profile, sid, kind, title, run_id=None, body=None, event_key=None, routine_id=None):
        with self.lock, self.db:
            self.db.execute("INSERT OR IGNORE INTO events(profile,session_id,run_id,kind,title,body,occurred,epoch,event_key,routine_id) VALUES(?,?,?,?,?,?,?,?,?,?)", (profile, sid, run_id, kind, title, body, time.time(), self.epoch, event_key, routine_id))

    def receipt(self, request_id):
        row = self.db.execute("SELECT status,COALESCE(run_id,request_id),row_id,actor,steering,admission_response FROM receipts WHERE request_id=?", (request_id,)).fetchone()
        if row is None:
            return None
        # steering is the decision made under the submission lock: this input joined the running task.
        value = {"requestId": request_id, "status": row[0], "runId": row[1], "userRowId": row[2], "senderId": row[3], "steering": bool(row[4])}
        # The turn the saved answer carried, for a caller whose answer was lost. A receipt saved before the add-on
        # stored a started turn, a steer and a refusal carry none.
        stored = json.loads(row[5]) if row[5] else {}
        if stored.get("turn") is not None:
            value["turn"] = stored["turn"]
        # The photos this send's turn ran without: the answer's, or one noted since (``note_images_missing``).
        missing = self.images_missing.get(request_id, stored.get("imagesMissing"))
        if type(missing) is int and missing > 0:
            value["imagesMissing"], value["message"] = missing, images_missing_message(missing)
        return value

    def note_images_missing(self, request_id, count):
        """Say that this send's turn ran without ``count`` of its photos, in its receipt and every lookup of it.

        The turn can find them gone before the add-on has saved Hermes's answer, which then reads this; after, the
        saved answer is amended. Never lowers a count already noted.
        """
        with self.lock, self.db:
            row = self.db.execute("SELECT admission_response FROM receipts WHERE request_id=?", (request_id,)).fetchone()
            if row is None or count <= 0:
                return
            stored = json.loads(row[0]) if row[0] else None
            count = max(count, self.images_missing.get(request_id, 0), (stored or {}).get("imagesMissing") or 0)
            if stored is None:
                self.images_missing[request_id] = count
                return
            stored.update(imagesMissing=count, message=images_missing_message(count))
            self.db.execute("UPDATE receipts SET admission_response=? WHERE request_id=?", (json.dumps(stored), request_id))

    def last_terminal(self, profile, sid, stored):
        """The newest settled outcome of the session, or of its canonical owner after a cold resume."""
        terminal = self.db.execute(LATEST_TERMINAL, (profile, sid)).fetchone()
        if not terminal:
            latest = self.db.execute(LATEST_ROOT, (profile, stored)).fetchone()
            terminal = self.db.execute(RUN_TERMINAL, (latest[0],)).fetchone() if latest else None
        return terminal

    def submission_state(self, profile, sid, session):
        """The shared recovery gates for app input and goal continuation.

        Callers doing a goal mutation also hold this session's history_lock.
        """
        with self.lock:
            stored = session.get("session_key")
            running = bool(session.get("running"))
            current = self.db.execute(OPEN_RUN, (sid,)).fetchone()
            interrupted = self.db.execute("SELECT 1 FROM interruptions WHERE profile=? AND stored_session=?", (profile, stored)).fetchone()
            terminal = self.last_terminal(profile, sid, stored)
            inflight = session.get("inflight_turn") or {}
            interrupted = bool(interrupted) or not running and not current and (bool(inflight.get("interrupted")) or bool(terminal and terminal[0] == "interrupted"))
            return dict(stored=stored, running=running, current=current, interrupted=interrupted)

    def admission_response(self, request_id):
        row = self.db.execute("SELECT admission_response FROM receipts WHERE request_id=?", (request_id,)).fetchone()
        if row is None:
            return None
        if row[0] is not None:
            return json.loads(row[0])
        # Older journals and intents interrupted before the response was saved cannot
        # reconstruct the original result. Never infer permission to send again from
        # their evolving status or row binding. Freeze an explicit recovery response.
        value = {**self.receipt(request_id), "status": "uncertain", "userRowId": None,
                 "admission": "canonical",
                 "message": "Original admission response is unavailable. Check agent-interface.receipt and review the task before retrying."}
        value["app_run_id"] = value["runId"]
        with self.db:
            self.db.execute("UPDATE receipts SET admission_response=? WHERE request_id=?", (json.dumps(value), request_id))
        return value


# The web and iOS clients' history page, src/shared/history.ts HISTORY_PAGE_TURNS.
PAGE_TURNS = 20


def detached(value):
    """A copy of a JSON value: every dict and list new, so a reader of one cannot change another."""
    if type(value) is dict:
        return {key: detached(item) for key, item in value.items()}
    if type(value) is list:
        return [detached(item) for item in value]
    return value


def history_window(messages, sid, start=None, turns=0, before=None):
    """The app's history window, cut here so earlier rows never cross the socket.

    Mirrors historyWindow in src/shared/history.ts over the rows the app shows, with the
    app's own message IDs. Returns (rows, window). Rows before the window are kept only
    when the app still needs them: those carrying files, for its earlier-file count, and
    the prompt each such reply answers, for its origin. Each returned row carries its
    position among visible rows, so positional IDs stay the same. ``window`` is None,
    and every row is returned, when nothing is cut.

    A window that names a row inside a turn starts there, as historyWindow does. The server's
    turn read names a turn's first saved message, which for a turn whose prompt is hidden,
    such as a routine's or an auto-continue, is a reply. The prompt before that row is kept,
    so its replies take the origin the whole history gives them.

    ``before`` names a row the window ends just before, counting ``turns`` back from it in place of
    ``start``: an earlier page for a client that holds everything from that row on. The window then
    names it, so the server knows the rows after it were left out. One the history does not hold is
    ignored.
    """
    visible = [row for row in messages if row.get("display_kind") != "hidden"]
    def identity(index):
        row = visible[index]
        for key in ("app_request_id", "row_id"):
            if row.get(key) is not None:
                return str(row[key])
        return f"{sid}-{index}"
    turns = turns if type(turns) is int and turns >= 0 else 0
    def position(name):
        return next((index for index in range(len(visible)) if identity(index) == name), -1) if isinstance(name, str) and name else -1
    bound = position(before)
    end = bound if bound >= 0 else position(start)
    if end < 0:
        end, turns = len(visible), max(turns, PAGE_TURNS)
    first = end
    while first > 0 and turns > 0:
        first -= 1
        if visible[first].get("role") == "user":
            turns -= 1
    if first == 0 and bound < 0:
        return messages, None
    kept, prompt = set(), None
    for index in range(first):
        row = visible[index]
        if row.get("role") == "user":
            prompt = index
        files = row.get("app_attachments") if row.get("role") == "user" else row.get("app_artifacts")
        if isinstance(files, list) and files:
            kept.add(index)
            if row.get("role") == "assistant" and prompt is not None:
                kept.add(prompt)
    if visible[first].get("role") != "user" and prompt is not None:
        kept.add(prompt)
    last = bound if bound >= 0 else len(visible)
    rows = [dict(visible[index], app_index=index) for index in sorted(kept) + list(range(first, last))]
    return rows, {"earlier": first, "context": len(kept), **({"before": before} if bound >= 0 else {})}


FIRST_CONTACT_NOTE = "[System note: This is the user's very first message ever."


def without_first_contact_note(notes):
    """Turn context notes without Hermes's first-contact note, which native joins on blank lines."""
    if not isinstance(notes, str) or FIRST_CONTACT_NOTE not in notes:
        return notes
    return "\n\n".join(part for part in notes.split("\n\n") if not part.lstrip().startswith(FIRST_CONTACT_NOTE))


def event_body(value):
    """A bounded excerpt for event bodies that keeps its line breaks.

    The app reads it as Markdown, which needs lines and indentation to tell a table, a
    heading or a list from prose, and shows it as one plain line. Spaces after a line's
    indentation and runs of blank lines collapse.
    """
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    # Leading indentation stays: it places a line inside a list or code block.
    lines = [line[:len(line) - len(line.lstrip())] + " ".join(line.split()) if line.strip() else "" for line in value.splitlines()]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines).strip("\n"))
    return text[:500] or None


# A routine run saves its document after it is claimed and before Hermes records it finished.
ROUTINE_OUTPUT_GRACE = datetime.timedelta(seconds=300)
# Hermes validates a document's length frames, so it is read whole. Larger ones get no preview.
ROUTINE_OUTPUT_LIMIT = 8 * 1024 * 1024


def routine_answer(document):
    """The answer in a routine's saved output document, or None for a blank or silent run.

    Documents of agent runs hold a header and the prompt before a "## Response" section.
    Hermes's own reader validates its length frames and recognizes silent replies.
    """
    try:
        from cron.scheduler_prompt import _archive_answer
    except Exception:
        _archive_answer = None
    if _archive_answer is not None:
        return _archive_answer(document)
    if "## Response" not in document:
        return None
    return document.rpartition("## Response")[2].strip() or None


def ledger_time(value):
    """A ledger timestamp on Hermes's wall clock, which also names output documents."""
    return datetime.datetime.fromisoformat(value).replace(tzinfo=None)


def routine_run_body(home, job_id, execution, executions=()):
    """What a finished routine run said, for its notification: its error, or the answer it saved.

    ``executions`` are the job's other ledger rows. A document written after another attempt
    was claimed may be that attempt's, so it is never borrowed. A preview is a courtesy:
    anything missing, ambiguous or unreadable leaves the event without a body.
    """
    status = execution.get("status")
    if status == "failed":
        return event_body(execution.get("error"))
    if status != "completed" or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", str(job_id)):
        return None
    try:
        # Claims are ordered by their real instants. A later claim whose wall clock went back, as
        # when daylight saving ends, bounds the window before this claim, so no document matches.
        instant = datetime.datetime.fromisoformat(execution["claimed_at"])
        # Document names keep whole seconds, so a claim counts from the start of its second.
        claimed = ledger_time(execution["claimed_at"]).replace(microsecond=0)
        bounds = [ledger_time(other["claimed_at"]).replace(microsecond=0) for other in executions
                  if other is not execution and other.get("claimed_at") and datetime.datetime.fromisoformat(other["claimed_at"]) > instant]
        if execution.get("finished_at"):
            bounds.append(ledger_time(execution["finished_at"]) + ROUTINE_OUTPUT_GRACE)
        latest = min(bounds, default=None)
        # Never follow a link out of this profile's own output folder.
        directory = Path(home).resolve() / "cron" / "output" / job_id
        if directory.resolve() != directory:
            return None
        for path in sorted(directory.glob("*.md")):
            try:
                written = datetime.datetime.strptime(path.stem, "%Y-%m-%d_%H-%M-%S")
            except ValueError:
                continue
            if written < claimed:
                continue
            if latest and written >= latest:
                return None
            # The first document after the claim is this run's.
            if path.is_symlink() or not path.is_file() or path.resolve().parent != directory or path.stat().st_size > ROUTINE_OUTPUT_LIMIT:
                return None
            return event_body(routine_answer(path.read_text(encoding="utf-8", errors="replace")))
    except Exception:
        logging.getLogger(__name__).debug("Could not read a routine run's output for its notification", exc_info=True)
    return None


class LaneQueue:
    """Runs add-on requests on threads of its own, one job at a time per key, in arrival order.

    Waiting work holds no thread, so one slow assistant can take at most one worker
    and never any of Hermes's native RPC pool, which its long handlers need. A request
    whose ``merge`` key equals that of a job still waiting in its lane joins that job,
    and one run answers both; ``run`` gets every merged request, to answer each its own way. A job takes no one once it starts, so every request is
    answered by a computation that began after it arrived.
    """

    def __init__(self, workers, name):
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix="agent-interface-" + name)
        atexit.register(lambda: self.pool.shutdown(wait=False, cancel_futures=True))
        self.lock = threading.Lock()
        # Each lane holds only waiting jobs: (merge key, run, requests). run_next takes one out before it runs.
        self.queues = {}

    def submit(self, key, run, request, merge=None):
        """Queue ``request`` for a job that calls ``run(requests)`` with every request merged into it."""
        with self.lock:
            lane = self.queues.get(key)
            if lane is not None:
                waiting = next((job for job in lane if merge is not None and job[0] == merge), None)
                if waiting is not None:
                    waiting[2].append(request)
                else:
                    lane.append((merge, run, [request]))
                return
            lane = self.queues[key] = collections.deque([(merge, run, [request])])
            # Scheduled under the lock, so no request joins a lane whose worker may never run.
            try:
                self.pool.submit(self.run_next, key, lane)
            except BaseException:
                # The executor can queue the work item and then fail to start its thread. That item
                # runs on the next worker that starts, and finds its lane gone.
                del self.queues[key]
                raise

    def run_next(self, key, lane):
        with self.lock:
            # A work item whose scheduling failed: its caller was refused, so it runs nothing.
            if self.queues.get(key) is not lane:
                return
            _, run, requests = lane.popleft()
        try:
            run(requests)
        except Exception:
            logging.getLogger(__name__).exception("Add-on request failed")
        finally:
            with self.lock:
                more = bool(lane)
                if not more:
                    del self.queues[key]
            # Requeue behind other keys' work instead of looping, so keys share workers fairly.
            # If a new thread fails to start here, this worker still runs the queued item.
            if more:
                self.pool.submit(self.run_next, key, lane)


class Reservation:
    """One admission reservation, released at most once, so a second release cannot free another request's.

    ``unlist`` runs just after the release, both under ``lock``, so a reader holding ``lock`` sees the
    reservation and what lists it go together, and nothing is unlisted while its reservation is held.
    """

    def __init__(self, retirement, lock, unlist=None):
        self.retirement, self.lock, self.unlist, self.held = retirement, lock, unlist, True

    def release(self):
        with self.lock:
            held, self.held = self.held, False
            if held:
                self.retirement.release()
                if self.unlist is not None:
                    self.unlist()
        if not held:
            logging.getLogger(__name__).error("An admission reservation was released twice; the second release was ignored", stack_info=True)


def window_of(request):
    """The ``window`` an open asked for, or None."""
    params = request.get("params")
    return params.get("window") if isinstance(params, dict) else None


def own_window(response, merged, index):
    """The merged open's response with the ``index``-th request's own window, as open_locked cut it for each."""
    if merged is None or merged["answers"] is None or not isinstance(response, dict) or not isinstance(response.get("result"), dict):
        return response
    result = {key: value for key, value in response["result"].items() if key != "app_window"}
    result["messages"], cut = merged["answers"][index]
    if cut:
        result["app_window"] = cut
    return {**response, "result": result}


def answered(response, rid, queued):
    """One queued request's answer from its job's response: its own ID and, for an open, its own wait.

    ``queued`` is the seconds the request waited before its job started. ``app_timing`` reports
    it as ``queued`` and counts it in ``total``, so the app server's ``transit``, Hermes's
    round trip less the add-on's total, stays the time outside the add-on.
    """
    if response is None:
        return None
    reply = {**response, "id": rid}
    result = response.get("result")
    timing = result.get("app_timing") if isinstance(result, dict) else None
    if isinstance(timing, dict):
        waited = round(queued * 1000, 1)
        reply["result"] = {**result, "app_timing": {"queued": waited, **timing, "total": round(timing.get("total", 0) + waited, 1)}}
    return reply


class Keeper:
    """Holds a canonical session's transport open between app requests."""
    closed = False

    def write(self, _frame):
        return True

    def close(self):
        self.closed = True


def redaction_state():
    """A digest of native redaction registries, which change history projection in memory only.

    None when this Hermes keeps them elsewhere, so a renamed registry cannot pass unnoticed.
    """
    try:
        redact = importlib.import_module("agent.redact")
        vault_lock, vault = redact._VAULT_REDACTION_LOCK, redact._VAULT_REDACTION_VALUES
        plugin_lock, plugin = redact._registry_lock, redact._PLUGIN_PREFIX_PATTERNS
    except (ImportError, AttributeError):
        return None
    digest = hashlib.sha256()
    with vault_lock:
        vault = sorted((str(home), sorted(values)) for home, values in vault.items())
    with plugin_lock:
        plugin = sorted((str(source), list(patterns)) for source, patterns in plugin.items())
    digest.update(json.dumps([vault, plugin]).encode())
    return digest.hexdigest()


def history_row_floor(session):
    # Native flushes stamp raw rows with their durable IDs. Snapshot those
    # already-visible rows without taking another database or session lock.
    history = list(session.get("display_history_prefix") or []) + list(session.get("history") or [])
    ids = [row["_row_id"] for row in history if isinstance(row, dict) and type(row.get("_row_id")) is int]
    return max(ids) if ids else None if history else 0


def parsed_result(result):
    if isinstance(result, str):
        try:
            return json.loads(result)
        except (ValueError, TypeError):
            pass
    return result


def turn_extent(row_ids):
    """A turn's committed rows, or None unless they are a list of row IDs.

    Checked when a completion is saved and again when the stored copy is read, which may be damaged."""
    if isinstance(row_ids, list) and all(type(row) is int and row > 0 for row in row_ids):
        return row_ids
    return None


def approval_id(row):
    # The approval's native request ID, which its event identity ends with, lets a notification decide it.
    prefix = f"{row[3]}:approval:"
    return row[9][len(prefix):] if row[4] == "approval" and row[3] and isinstance(row[9], str) and row[9].startswith(prefix) and len(row[9]) > len(prefix) else None


# The run a session's newest unsettled receipt belongs to.
# A receipt Hermes put into the running turn (admission turn "joined") marks its row as a steer, as a steering receipt does.
# It is its own run, because the turn it joined may be another client's, so it is bound through its own turn_rows.
JOINED = "json_extract(%sadmission_response,'$.turn')='joined'"
OPEN_RUN = "SELECT COALESCE(run_id,request_id) FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created DESC LIMIT 1"
# The run an open names: OPEN_RUN without receipts whose admission Hermes has not answered yet.
SHOWN_RUN = "SELECT COALESCE(run_id,request_id) FROM receipts WHERE session_id=? AND terminal=0 AND request_id NOT IN (SELECT value FROM json_each(?)) ORDER BY created DESC LIMIT 1"
LATEST_TERMINAL = "SELECT kind FROM events WHERE profile=? AND session_id=? AND kind IN ('completed','failed','interrupted') ORDER BY id DESC LIMIT 1"
LATEST_ROOT = "SELECT COALESCE(run_id,request_id) FROM receipts WHERE profile=? AND stored_session=? AND steering=0 ORDER BY created DESC LIMIT 1"
RUN_TERMINAL = "SELECT kind FROM events WHERE run_id=? AND kind IN ('completed','failed','interrupted') ORDER BY id DESC LIMIT 1"
INSERT_REJECTED = "INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,terminal,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"


# Reads the app polls. They run on the add-on's own read queue instead of the
# connection's serial lane, so one slow history read never queues every other RPC.
QUEUED_READS = frozenset({"agent-interface.open", "agent-interface.discover"})
# App sends, likewise off the connection's serial lane, so a send waiting for a background
# compaction to stop never holds up another request on the socket. One lane per assistant
# keeps each assistant's sends in arrival order; a send never merges with another.
QUEUED_SENDS = frozenset({"agent-interface.submit"})
# Methods whose lane is the requested assistant's; the rest share one lane per method.
PROFILE_LANES = frozenset({"agent-interface.open", "agent-interface.submit"})
# Queued reads whose waiting requests may share one computation when their connection and
# parameters are identical, except an open's ``window``: opens that differ only there share one
# activation and decoration, and each answer is cut to its own window, the last step of an open.
# Each answer depends only on its parameters and state read after every merged request arrived,
# and the effects are idempotent: an open activates the session and binds receipts to rows;
# discovery records each routine run once, by its unique event key.
MERGED_READS = frozenset({"agent-interface.open", "agent-interface.discover"})
# Distinct assistants read at once; a busy assistant's later reads wait without a thread.
READ_WORKERS = 4
# Distinct assistants' sends at once. Admissions themselves take turns under submission_lock;
# only the wait for a compaction to stop runs beside them, and the idle compactor runs one
# compaction at a time, so a second assistant's send never waits for a worker behind it.
SEND_WORKERS = 4
# What Hermes did with a new task it did not start at once, by native prompt.submit's successful
# answer at ed1afb0. Over a running session (tui_gateway/session_auto_continue.py _handle_busy_submit),
# "queued" is the busy queue's disposition: the text was queued, merged into a queued prompt, or
# dropped as a copy of the running prompt, so it promises no separate later turn; a session another
# gateway owns queues it in that owner's queue (methods_prompt.py _submit_to_ledger_owner). "steered"
# and "redirected" put it into the running turn, which gives it no turn of its own. See admission_turn.
ADMISSION_TURN = {"queued": "queued", "steered": "joined", "redirected": "joined"}


def images_missing_message(count):
    """What a receipt says when the turn that ran a send did not have ``count`` of its photos."""
    return (f"{'Your photo was' if count == 1 else f'{count} of your photos were'} not sent with this message: "
            "another task took them first. Check the reply and send them again.")


def admission_turn(result):
    """What a new task's successful prompt.submit answer says about its turn.

    Only "streaming" says Hermes started the turn, answered "started" (methods_prompt.py:973; compute_host_bridge.py:327
    for an isolated turn). It is saved like every other turn, so a saved answer without one was saved by an add-on
    older than the field and says nothing. A typed stop phrase while the session's voice mode is on ends the voice
    chat and admits nothing: {"voice_stopped": true} (methods_prompt.py:265-268, checked first at :835-836, and :760-761), "none".
    Any answer this does not know is "unknown", never taken for a started turn.
    """
    status = result.get("status")
    if status == "streaming":
        return "started"
    if status is None and result.get("voice_stopped") is True:
        return "none"
    return ADMISSION_TURN.get(status, "unknown")
# Where an admission spent its time, reported as app_timing like an open's phases.
SUBMIT_PHASES = ("open", "preempt", "wait", "journal", "staging", "native")
# Decorated history is keyed on exact history identity, the profile's journal version and native
# redaction state; the lifetime only bounds what an identity collision could serve.
# Without readable redaction state, the earlier short lifetime still applies.
DECORATED_TTL = 600
UNTRACKED_REDACTION_TTL = 30
DECORATED_LIMIT = 32
# Entries per table of one canonical session's RowCache; the oldest go first.
ROW_CACHE_LIMIT = 20000


class RowCache:
    """Per-row results an open computed for one canonical session that no later write can change.

    The decorated-history cache misses for the whole of a turn, so an open during a turn reads
    these instead of redoing work that grows with the transcript. Each table answers only
    from its own key; none depends on redaction state or the journal version.

    ``tool_results``: a tool row ID -> (its content, that content parsed). Hermes's proactive
    prune rewrites a row's content under the same ID, so a hit needs the same content.
    ``tool_records``: a journal ``tools.id`` -> its parsed record. The add-on only inserts them.

    Which row a compaction copy copies is not kept; ``original_rows`` says why.
    ``journal`` is the ``PRAGMA data_version`` of the journal connection ``tool_records`` came from; only another
    connection's commit, such as a restore, moves it. That connection stays on the file it opened
    for the life of the process, so a journal replaced by rename is never read until a restart,
    which starts every cache empty. A changed mark empties its table before the table answers.

    Callers hold the session's profile lock. ``scope`` is the stored session the tables
    describe; a changed one starts a new cache. Values are parsed JSON shared by every open, so
    nothing that reads them may change them; a response gets copies.
    """

    def __init__(self, scope, projections=None):
        self.scope = scope
        self.tool_results, self.tool_records = {}, {}
        self.journal = None
        self.projections = ProjectionMemo(projections)

    @staticmethod
    def keep(table, key, value):
        table[key] = value
        while len(table) > ROW_CACHE_LIMIT:
            del table[next(iter(table))]


def file_stamp(path):
    """What changes when a file is replaced or written: device, inode, times and size. None for a missing file."""
    try:
        info = path.stat()
        return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns, info.st_size)
    except FileNotFoundError:
        return None


def text_size(value):
    """The characters of every string in a JSON value, keys included."""
    if type(value) is str:
        return len(value)
    if type(value) is dict:
        return sum(len(key) if type(key) is str else 0 for key in value) + sum(text_size(item) for item in value.values())
    if type(value) in (list, tuple):
        return sum(text_size(item) for item in value)
    return 0


# Rows each piece of a memoized history holds at least, but the last. Hermes reads the profile's configuration once
# per projection that holds commentary, so a 8,016-row chat cut at every safe turn (394 pieces) projected 23% slower
# than whole; at 64 rows (86 pieces) it is no slower, and an open still projects only its last piece again.
PIECE_ROWS = 64


def projection_cuts(history, display, least=None):
    """Where Hermes's history projection can be cut so that each piece projects alone exactly as it does in the whole.

    ``_history_to_messages`` (tui_gateway/session_history.py:297 at ed1afb0) carries one thing from row to row:
    ``tool_call_args``, the name and arguments of each call an assistant row's ``tool_calls`` named, by call ID. A
    tool row reads the last such entry before it, so a model that reuses a call ID reads its latest call. The rest of
    the projection, commentary included, looks at one row or message at a time. A cut is safe where no tool row after
    it reads an entry made before it. Rows are cut only at user rows, so pieces follow turns and repeat between opens,
    but a user row is never taken to start a turn: a steer is a user row in the middle of a tool batch, and a hidden
    assistant row still names calls that later rows read. Each row is seen as Hermes sees it, after ``display``,
    its compaction projection. A piece holds at least ``least`` rows (PIECE_ROWS), but the last; cuts are taken
    from the start, so rows added at the end never move an earlier cut. Returns the index each piece starts at, the
    first 0. A call that is not a mapping, or an ID that cannot be a key, raises here what Hermes's own projection of
    that row raises.
    """
    least = PIECE_ROWS if least is None else least
    last, blocked, users = {}, [0] * (len(history) + 1), []
    for index, row in enumerate(history):
        if not isinstance(row, dict):
            continue
        if row.get("role") == "user":
            users.append(index)
        shown = display(row)
        if not isinstance(shown, dict):
            continue
        if shown.get("role") == "assistant" and shown.get("tool_calls"):
            for call in shown["tool_calls"]:
                if call.get("id", "") and call.get("function", {}).get("name"):
                    last[call.get("id", "")] = index
        elif shown.get("role") == "tool":
            source = last.get(shown.get("tool_call_id") or "")
            if source is not None:
                # No cut in source + 1 .. index: this row would lose the call it reads.
                blocked[source + 1] += 1
                blocked[index + 1] -= 1
    cuts, covered, users = [0], 0, set(users)
    for index in range(len(history)):
        covered += blocked[index]
        if index - cuts[-1] >= least and covered == 0 and index in users:
            cuts.append(index)
    return cuts


def project_rows(native, display, history, kwargs):
    """Hermes's projection of ``history``, and what the add-on reads from each of its tool rows.

    Returns (messages, tool rows): each visible tool row as ((its call ID, its time), its row ID, its
    content), in history order. Native compaction and hidden scaffolding stay hidden. A model can reuse a
    call ID later, so a tool row is known by its call ID and native time together.
    """
    messages, tool_rows = native(history, **kwargs), []
    for row in history:
        if not isinstance(row, dict) or row.get("role") != "tool":
            continue
        visible = native([row], **kwargs)
        projected = display(row)
        if not visible or not isinstance(projected, dict):
            continue
        tool_rows.append(((visible[0].get("tool_call_id"), visible[0].get("timestamp")), projected.get("_row_id"), projected.get("content")))
    return messages, tool_rows


# Characters every ProjectionMemo in the gateway keeps together, counted by text_size over each kept piece's input
# rows, projection and tool rows. The longest chat seen, 8,016 rows, has 62 million characters of input rows alone,
# and its memo held about 110 MB. One memo may use all of it; a history beyond it keeps its first pieces and projects
# the rest every open. When several chats' memos pass it, the one used least recently empties (ProjectionBudget).
PROJECTION_BUDGET = 192_000_000
# Set to 1 to project each app open's history whole as well, answer with the whole projection, and log where the two
# differ. docs/Hosting.md has the switch. Release qualification runs with it on.
PROJECTION_SHADOW = "HERMES_AGENT_INTERFACE_PROJECTION_SHADOW"


class ProjectionBudget:
    """The characters every ProjectionMemo of one gateway keeps, together.

    A memo lives as long as its session is canonical, so without a shared budget each long chat ever opened would
    keep up to the whole budget for the life of the gateway. After each projection the memos used least recently
    empty until the total fits; the memo that just projected keeps its pieces.
    """

    def __init__(self, budget=None):
        self.fixed, self.lock, self.memos, self.uses = budget, threading.Lock(), weakref.WeakSet(), 0

    @property
    def budget(self):
        return PROJECTION_BUDGET if self.fixed is None else self.fixed

    def room(self, memo):
        """Characters ``memo`` may keep without emptying another memo."""
        with self.lock:
            return self.budget - sum(other.size for other in self.memos if other is not memo)

    def charge(self, memo, background=False):
        """Counts ``memo``'s pieces and empties the memos used least recently until the total fits.

        A ``background`` projection, the warm-up's, nobody opened: it ranks below every memo an open has used, so
        a later open empties it before any of those. Each emptied memo's ``on_empty`` runs after the lock is let go.
        """
        emptied = []
        with self.lock:
            if background:
                memo.used = 0
            else:
                self.uses += 1
                memo.used = self.uses
            self.memos.add(memo)
            total = sum(other.size for other in self.memos)
            # An open's memo is used last, and alone it never keeps more than the budget.
            for other in sorted(self.memos, key=lambda other: other.used):
                if total <= self.budget:
                    break
                total -= other.size
                other.pieces, other.size = {}, 0
                emptied.append(other)
        for other in emptied:
            if other.on_empty is not None:
                other.on_empty()


class ProjectionMemo:
    """Hermes's projection of each piece of one canonical session's history, kept between app opens.

    Hermes reads and projects a long chat's whole history on every open, though only its newest turn
    changes between opens. The history is cut where ``projection_cuts`` says a piece projects alone as it
    does in the whole, and a piece whose rows equal the rows a kept projection came from reuses it. Rows are
    fresh dictionaries on every read of the store, so equal content is the only identity they have: a cheap
    key (row IDs and content lengths) finds the candidate, and full equality decides.

    ``context`` is everything else a projection reads: its keyword arguments, the profile's configuration
    stamps and native redaction state. Another context empties the memo. Each kept piece holds a copy of its
    input rows, made before Hermes projects that copy, because live rows change in place (a flush stamps
    ``_row_id``), and a copy of its projection, because decoration changes the messages it is given. A hit
    hands out a new copy. After each projection the memo holds exactly the pieces of that history, in order,
    until their rows reach ``budget`` characters, so pieces a rewrite left behind never accumulate.

    Callers hold the session's profile lock. ``report`` says what the last projection did, for shadow mode.
    ``shared`` is the gateway's ProjectionBudget; another memo's projection may empty this one between opens.
    """

    def __init__(self, shared=None):
        self.shared = ProjectionBudget() if shared is None else shared
        self.context, self.pieces, self.size, self.report, self.used, self.full = None, {}, 0, None, 0, False
        # Runs when the shared budget empties this memo; the warm-up's drops the cache nobody adopted.
        self.on_empty = None

    @property
    def budget(self):
        return self.shared.budget

    @staticmethod
    def key(piece):
        def size(value):
            return len(value) if type(value) in (str, list) else -1
        return tuple((row.get("_row_id"), row.get("role"), size(row.get("content"))) if type(row) is dict else (type(row).__name__,) for row in piece)

    @staticmethod
    def snapshot(piece):
        # dict.copy() takes each live row whole, so a flush stamping it meanwhile cannot break the copy.
        return [detached(row.copy()) if type(row) is dict else detached(row) for row in piece]

    def project(self, history, project, display, context, shadow=False, pause=None, limit=None, background=False):
        """(messages, tool rows) as ``project`` gives them for the whole ``history``, reusing kept pieces.

        ``project(rows)`` is Hermes's projection of ``rows`` with project_rows; ``display`` its compaction projection.
        ``pause(full)`` runs before each piece, reused or not, ``full`` once a piece did not fit, and may raise to
        stop: the memo then keeps the pieces before that one, which a later projection of the history reuses.
        ``limit`` is the characters this projection may keep, the shared budget when None. ``full`` says afterwards
        whether a piece did not fit. ``background`` charges the shared budget as ProjectionBudget.charge says.
        """
        limit = self.budget if limit is None else limit
        cuts = projection_cuts(history, display)
        if context != self.context:
            self.context, self.pieces, self.size = context, {}, 0
        kept, size, messages, tool_rows, inputs, reused, full = {}, 0, [], [], [], 0, False
        for start, end in zip(cuts, cuts[1:] + [len(history)]):
            piece = history[start:end]
            if pause is not None:
                try:
                    pause(full)
                except BaseException:
                    self.pieces, self.size, self.full = kept, size, full
                    self.shared.charge(self, background)
                    raise
            key = self.key(piece)
            entry = self.pieces.get(key)
            if entry is not None and entry[0] == piece:
                reused += 1
                projected = detached(entry[1])
            else:
                rows = self.snapshot(piece)
                projected, piece_tools = project(rows)
                kept_projection = detached(projected)
                entry = (rows, kept_projection, piece_tools, text_size(rows) + text_size(kept_projection) + text_size(piece_tools))
            if key not in kept:
                if size + entry[3] <= limit:
                    kept[key] = entry
                    size += entry[3]
                else:
                    full = True
            messages.extend(projected)
            tool_rows.extend(entry[2])
            inputs.append(entry[0])
        self.pieces, self.size, self.full = kept, size, full
        self.shared.charge(self, background)
        self.report = {"segments": len(cuts), "reused": reused, "difference": None, "tool_difference": None}
        if shadow:
            whole, whole_tools = project([row for rows in inputs for row in rows])
            self.report["difference"] = first_difference(messages, whole)
            self.report["tool_difference"] = first_difference(tool_rows, whole_tools)
            if self.report["difference"] is not None or self.report["tool_difference"] is not None:
                logging.getLogger(__name__).warning(
                    "A memoized history projection differed from the whole one at message %s and tool row %s of %d messages "
                    "in %d pieces; answered with the whole one", self.report["difference"], self.report["tool_difference"],
                    len(whole), len(cuts))
                return whole, whole_tools
        return messages, tool_rows


def first_difference(left, right):
    """The first index where two lists differ, the shorter one's length when one extends the other, or None."""
    for index, (a, b) in enumerate(zip(left, right)):
        if a != b:
            return index
    return None if len(left) == len(right) else min(len(left), len(right))


# Hermes labels every shell command in a history each time it projects one, and its shell parser walks each
# command character by character several times. A coding assistant's chat with 2,400 commands spent about 4 of
# the 6 seconds of every open there. These helpers are pure functions of one string that only
# summarize_shell_command calls, so their answers are kept. summarize_shell_command itself stays native:
# it translates with the profile's language.
SHELL_SUMMARY_HELPERS = ("_split_shell_compound", "_clean_shell_segment", "_shell_head_word", "_is_shell_boundary_echo")
# Characters of keys and answers each helper keeps. That 2,400-command chat needs about 2 million for the largest.
SHELL_SUMMARY_BUDGET = 4_000_000


class TextMemo:
    """A pure function of one string, answering repeated strings from memory within a character budget.

    The least recently used answers go first. A list answer is kept as a tuple and returned as a new list,
    so a caller that changes its copy never changes a later answer. Anything but a string, and a string too
    long to keep, goes to the function every time.
    """

    def __init__(self, native, budget=SHELL_SUMMARY_BUDGET):
        self.native, self.budget = native, budget
        self.kept, self.size, self.lock = collections.OrderedDict(), 0, threading.Lock()

    @staticmethod
    def chars(text, value):
        items = value if type(value) is tuple else (value,)
        return len(text) + sum(len(item) for item in items if type(item) is str)

    def __call__(self, text):
        if type(text) is not str or len(text) > self.budget // 16:
            return self.native(text)
        with self.lock:
            hit = self.kept.get(text)
            if hit is not None:
                self.kept.move_to_end(text)
        if hit is None:
            value = self.native(text)
            hit = (True, tuple(value)) if type(value) is list else (False, value)
            with self.lock:
                if text not in self.kept:
                    self.kept[text] = hit
                    self.size += self.chars(text, hit[1])
                    while self.size > self.budget:
                        old, (_, answer) = self.kept.popitem(last=False)
                        self.size -= self.chars(old, answer)
        listed, value = hit
        return list(value) if listed else value


def memoize_shell_summary(display):
    """Keeps Hermes's shell-summary helpers' answers. See SHELL_SUMMARY_HELPERS. Installing twice wraps nothing again."""
    missing = []
    for name in SHELL_SUMMARY_HELPERS:
        native = getattr(display, name, None)
        if isinstance(native, TextMemo):
            continue
        if not callable(native):
            missing.append(name)
            continue
        setattr(display, name, TextMemo(native))
    if missing:
        # Hermes renamed or removed them. Opens still work, at the speed they had before the memo.
        logging.getLogger(__name__).warning("Hermes's shell summary has no %s; long chats open without its memo", ", ".join(missing))

# A gateway restart empties every memo, and the first opens of a long chat after it paid the whole projection: 10.9 s
# for a 8,800-row chat on November 12. After the add-on installs, a background thread projects the canonical history of
# the assistants the app used most recently into the memo their first open adopts. Set to 0 to turn it off.
WARM_SETTING = "HERMES_AGENT_INTERFACE_WARM_HISTORY"
# Assistants warmed per start, most recent app send first. The shared budget bounds what their memos keep.
WARM_PROFILES = 6
# Seconds after install before warming starts, so Hermes finishes starting first.
WARM_DELAY = 2
# Seconds the warm-up sleeps before each piece it projects, so live threads take the interpreter between pieces.
WARM_PAUSE = 0.005
# Seconds between looks while live work runs.
WARM_POLL = 0.25
# Tool rows, or journal tool records under the journal's lock, the warm-up parses per step. Parsing all 4,131 records
# of the longest chat took 0.44 s, most of a cold open's attribution (0.81 s against 0.05 s warm).
WARM_STEP = 256


class WarmupYield(Exception):
    """Live work arrived: the warm-up let go of the profile, keeping the pieces it projected."""


class WarmupFull(Exception):
    """The gateway's projection budget has no room left for warmed pieces."""


# Methods a held maintenance lease still admits: status, history and discovery reads.
# Session marks that count as work to maintenance, besides app sends that hold a lane.
BUSY_MARKS = ("running", "queued_prompt", "queued_prompts", "pending_steer", "_auto_continue_scheduled")
MAINTENANCE_READS = {"agent-interface.maintenance", "agent-interface.capabilities", "agent-interface.receipt", "agent-interface.discover",
                     "client.capabilities", "profiles.list", "profiles.describe", "session.list", "session.history", "session.info", "session.events.since",
                     "groups.capabilities", "groups.list", "groups.state", "groups.log"}


class Bridge:
    """The add-on's hooks into one native gateway, sharing its journal and canonical sessions.

    install() builds one per process, wraps the native seams and registers the
    agent-interface RPCs. Methods are grouped by concern, in installation order.
    """

    def __init__(self, server, journal, *, get_hermes_home, profile_name_for_home, maintenance_file=None):
        self.server, self.journal = server, journal
        self.get_hermes_home, self.profile_name_for_home = get_hermes_home, profile_name_for_home
        self.maintenance_file = maintenance_file
        # One lock per profile: an assistant's open never waits on another's. Weak values keep
        # a lock alive exactly while a thread holds or waits on it.
        self.profile_locks = weakref.WeakValueDictionary()
        self.profile_locks_guard = threading.Lock()
        # Leaf lock for the decorated-history cache, which every profile's open prunes.
        self.cache_lock = threading.Lock()
        self.submission_lock = threading.RLock()
        self.reads = LaneQueue(READ_WORKERS, "read")
        self.sends = LaneQueue(SEND_WORKERS, "send")
        # Each queued app send, from its reservation until it is answered: [profile, "queued" or "admitting"].
        # Maintenance status lists them as active work, as acquire already counts their reservations.
        self.sends_in_flight = {}
        self.sends_in_flight_lock = threading.Lock()
        # The clock a maintenance deadline runs on; a test pins it.
        self.monotonic = time.monotonic
        # Each session's accepted sends that Hermes put into its running turn and the turn has not yet completed:
        # the rows that completion reports are kept with them. Memory only, so a restart leaves them unbound.
        self.joined, self.joined_lock = {}, threading.Lock()
        # The (profile, session, actor) a submit on this thread just admitted as steering.
        self.steered = threading.local()
        # Each prompt.submit the add-on sends carries a request ID of its own. Hermes passes that ID
        # to the turn it starts for that prompt, and only to that turn first, so the turn that ran a
        # receipt's prompt is known by it. Native ID -> (session, receipt request ID, text).
        self.turn_requests = {}
        self.turn_requests_lock = threading.Lock()
        # The receipt whose prompt this thread's native turn runs, or None. Set around Hermes's
        # _run_prompt_submit, whose turn thread runs with a copy of the caller's context.
        self.turn_claim = contextvars.ContextVar("agent_interface_turn_claim", default=None)
        # Request IDs whose intent is written but whose admission Hermes has not answered yet. An open
        # names no run for them, so it shows what it showed before the admission began. journal.lock.
        self.admitting = set()
        self.maintenance_lock = threading.RLock()
        self.maintenance_read = contextvars.ContextVar("agent_interface_maintenance_read", default=False)
        self.keepers = {}
        self.canonical = {}
        self.decorated = {}
        # RowCache per canonical session ID, pruned with the decorated cache. ``projecting`` is
        # the one this thread's native activation may use while it projects history.
        self.row_caches = {}
        # Every session's projection memo keeps its pieces within this one budget.
        self.projection_budget = ProjectionBudget()
        self.projecting = contextvars.ContextVar("agent_interface_projecting", default=None)
        # (profile, stored session ID) -> the RowCache the history warm-up filled, until an open's resume adopts it or the
        # budget empties its memo. cache_lock; the cache changes only under the profile's lock.
        self.warm_caches = {}
        # Opens running or waiting for their profile's lock, from every caller; the warm-up steps aside for them.
        self.opens, self.opens_lock = 0, threading.Lock()
        # While a queued open runs for every open merged into it: {"windows": each one's window, in
        # arrival order, "answers": each one's (rows, cut), which open_locked fills}. See route.
        self.open_windows = contextvars.ContextVar("agent_interface_open_windows", default=None)
        self.settlement = {}
        self.discovery_lock = threading.RLock()
        self.routine_scans = {}
        journal.canonical_session = self.canonical.get
        journal.profile_for_session = self.profile_for
        journal.live_profile_for_session = self.live_profile_for
        journal.memory_refresh = sibling_module("experience").MemoryRefresh(journal, server,
            lambda profile: (session for sid, session in server._sessions.copy().items() if sid == self.canonical.get(profile)))
        # Main assistants' rosters and the gate on their agent messages; see delegation.py.
        def hermes_root():
            home = Path(self.get_hermes_home()).resolve()
            return home.parent.parent if home.parent.name == "profiles" else home
        self.delegation = sibling_module("delegation").Delegation(
            journal.db, journal.lock, self.profile_for_agent,
            current_profile=lambda: self.profile_name_for_home(self.get_hermes_home()) or "default", hermes_root=hermes_root)
        # Idle Bot Chats compact in the background; every admitted input preempts it. See compaction.py.
        compaction = sibling_module("compaction")
        self.compaction = compaction.IdleCompaction(server, self.native, self.canonical, journal, self.submission_lock,
                                                    self.maintenance_state, compaction.delay_from() if compaction.supported(server) else 0)

    def profile_for_agent(self, agent):
        """The profile a tool-calling agent belongs to, from its own session store, as message_agent finds it."""
        try:
            from tools.bot_mode_dm import _agent_home
            return self.profile_name_for_home(_agent_home(agent)) or "default"
        except Exception:
            return None

    # Maintenance lease: a held lease fences every native admission except reads.

    def maintenance_state(self):
        if not self.maintenance_file:
            return None
        path = Path(self.maintenance_file)
        if not path.is_absolute():
            raise RuntimeError("Maintenance lease requires an absolute private path.")
        if not os.path.lexists(path):
            return None
        if not private_fs.owner_private(path):
            raise RuntimeError("Maintenance lease is not private.")
        return json.loads(path.read_text())

    def busy_sessions(self, ignoring_compaction=False):
        """Active work for maintenance: busy sessions, then app sends that wait for or hold a lane.

        A send staging images or inside Hermes's admission call has not marked its session running,
        and one waiting on its lane has not reached Hermes at all. Each holds an admission
        reservation, so acquire refuses; status lists them so its callers refuse first.

        A background compaction holds its session running, but only acquire's preempt stops it, so
        acquire's first look passes ``ignoring_compaction``: a session whose only mark is that
        compaction's own running flag is no work yet. Queued input beside it is work.
        """
        # Native workers can reserve admission while holding _sessions_lock.
        # Snapshot the dictionary without taking that lock in the reverse order;
        # native reservations cover work queued after this snapshot.
        sessions = self.server._sessions.copy()
        with self.sends_in_flight_lock:
            sends = [tuple(send) for send in self.sends_in_flight.values()]
        def working(sid, session):
            marks = [key for key in BUSY_MARKS if session.get(key)]
            return bool(marks) and not (ignoring_compaction and marks == ["running"] and self.compaction.owns(sid))
        return [{"sessionId": sid, "profile": self.profile_for(sid), "state": "running"}
                for sid, session in sessions.items() if working(sid, session)] + [
            {"sessionId": self.canonical.get(profile), "profile": profile, "state": state} for profile, state in sends]

    def maintenance(self, rid, params):
        arrived = self.monotonic()
        server = self.server
        secret = os.environ.get("HERMES_AGENT_INTERFACE_TOKEN", "")
        supplied = params.get("service_key", "")
        if not secret or not isinstance(supplied, str) or not hmac.compare_digest(supplied, secret):
            return server._err(rid, 403, "Private maintenance authentication required")
        if not self.maintenance_file:
            return server._err(rid, 409, "Host maintenance lease is not configured")
        action = params.get("action", "status")
        operation = params.get("operation_id")
        if action not in ("status", "acquire", "release"):
            return server._err(rid, 400, "Unknown maintenance action")
        if action != "status" and (not isinstance(operation, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", operation)):
            return server._err(rid, 400, "Invalid maintenance operation")
        if action == "acquire":
            # How long the caller will wait, in seconds, counted from this request's arrival. Unknown to an
            # add-on older than the maintenance_deadline capability, which ignores it and acquires regardless.
            seconds = params.get("deadline")
            if seconds is not None and (isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not 0 < seconds < math.inf):
                return server._err(rid, 400, "Invalid maintenance deadline")
            return self.acquire_lease(rid, operation, None if seconds is None else arrived + seconds)
        with self.maintenance_lock:
            lease = self.maintenance_state()
            if lease and lease.get("operationId") != operation and action != "status":
                return server._err(rid, 409, "Another maintenance operation owns this lease")
            busy = self.busy_sessions()
            if action == "release" and lease:
                Path(self.maintenance_file).unlink()
                lease = None
            return server._ok(rid, {"active": lease is not None, "operationId": (lease or {}).get("operationId"), "busy": busy})

    def acquire_lease(self, rid, operation, deadline):
        """Write the maintenance lease unless refused, or unless the caller's ``deadline`` (this clock) has passed.

        The first look, under maintenance_lock, refuses what would be refused anyway, so a refused
        acquire stops no compaction. Only an acquire that would otherwise succeed stops them, outside
        the lock: Hermes's release of a compacting session takes it. The look is repeated under the lock
        immediately before the write, because the preempts took time: another acquire or input may have
        come in, and the caller may have given up. A caller that gave up cannot know whether a lease will
        appear, so none is written after its deadline.
        """
        def refused(message="Hermes still has active work; no maintenance lease acquired"):
            return self.server._err(rid, 409, message)
        def look(first):
            lease = self.maintenance_state()
            if lease and lease.get("operationId") != operation:
                return refused("Another maintenance operation owns this lease")
            # This request holds one native reservation. Queued RPCs and deferred work reserve before
            # execution and must also be idle. At the first look each running compaction holds one too,
            # and a compaction ending between the two reads only makes this count low: the second look is exact.
            compacting = self.compaction.running() if first else 0
            if self.busy_sessions(ignoring_compaction=first) or self.retirement.active_count() - compacting > 1:
                return refused()
            return None
        with self.maintenance_lock:
            refusal = look(True)
        if refusal:
            return refusal
        for sid in list(self.canonical.copy().values()):
            remaining = None if deadline is None else deadline - self.monotonic()
            if remaining is not None and remaining <= 0:
                return refused()
            self.compaction.preempt(sid, wait=None if remaining is None else min(remaining, sibling_module("compaction").PREEMPT_WAIT))
        with self.maintenance_lock:
            refusal = look(False)
            if refusal:
                return refusal
            if deadline is not None and self.monotonic() >= deadline:
                return refused()
            path = Path(self.maintenance_file)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            private_fs.atomic_json(path, {"operationId": operation})
            return self.server._ok(rid, {"active": True, "operationId": operation, "busy": []})

    def guarded_acquire(self):
        with self.maintenance_lock:
            if self.maintenance_state() and not self.maintenance_read.get():
                return False
            return self.original_acquire()

    def guarded_call(self, call, request, *args, **kwargs):
        method = request.get("method", "")
        read = method in MAINTENANCE_READS or method == "agent-interface.computer" and request.get("params", {}).get("action", "status") == "status"
        token = self.maintenance_read.set(read)
        try:
            with self.maintenance_lock:
                if not read and self.maintenance_state():
                    return self.server._err(request.get("id"), 409, "Hermes is being upgraded. Your current work and drafts are preserved.")
            # Native admission takes the same gate atomically. Never hold our
            # lock across a native handler's own session/profile locks.
            return call(request, *args, **kwargs)
        finally:
            self.maintenance_read.reset(token)

    def install_maintenance(self, retirement):
        server = self.server
        self.retirement = retirement
        original_handle, original_dispatch = server.handle_request, server.dispatch
        self.original_acquire = retirement.acquire
        retirement.acquire = self.guarded_acquire
        # Native dispatch reserves pool work before queueing. Fencing only the
        # synchronous handler misses native shell/configuration/image RPCs.
        server.handle_request = lambda request: self.guarded_call(original_handle, request)
        self.original_handle, self.original_dispatch = original_handle, original_dispatch
        server.dispatch = lambda request, *args, **kwargs: self.guarded_call(self.route, request, *args, **kwargs)
        server.register_method("agent-interface.maintenance", self.maintenance)

    def route(self, request, *args, **kwargs):
        """Native dispatch, except polled add-on reads and app sends, which go to the add-on's lanes.

        This mirrors native long handlers: reserve admission before queueing, answer through
        the connection's transport, release once answered. A queued send holds its reservation
        while it waits and runs, so maintenance and retirement treat it as active work, as they
        did a send the reader ran itself. Direct handle_request calls stay synchronous, and a
        request without a connection transport keeps native dispatch.
        """
        arrived = time.perf_counter()
        transport = args[0] if args else kwargs.get("transport")
        method = request.get("method") if isinstance(request, dict) else None
        if method not in QUEUED_READS and method not in QUEUED_SENDS or transport is None or "id" not in request:
            return self.original_dispatch(request, *args, **kwargs)
        from tui_gateway.transport import bind_transport
        server, retirement = self.server, self.retirement
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        profile = params.get("profile", "default")
        # Listed whenever its reservation is held, so maintenance status and acquire agree about it. Maintenance
        # reads both under maintenance_lock, so listing and reserving are one step to it, and so are releasing
        # and unlisting in Reservation.release. Neither step waits on anything but the native fence.
        send = [profile if isinstance(profile, str) else None, "queued"] if method in QUEUED_SENDS else None
        def unlist():
            with self.sends_in_flight_lock:
                self.sends_in_flight.pop(id(send), None)
        with self.maintenance_lock:
            if send is not None:
                with self.sends_in_flight_lock:
                    self.sends_in_flight[id(send)] = send
            if not retirement.acquire():
                unlist()
                return server._err(request["id"], 5035, "backend is retiring; reconnect to continue")
        reservation = Reservation(retirement, self.maintenance_lock, unlist if send is not None else None)
        context = contextvars.copy_context()
        def answer(requests):
            # Each merged request holds its own admission reservation until it is answered.
            started = time.perf_counter()
            if send is not None:
                with self.sends_in_flight_lock:
                    send[1] = "admitting"
            merged = {"windows": [window_of(each) for each, *_ in requests], "answers": None} if method == "agent-interface.open" else None
            token = self.open_windows.set(merged)
            try:
                # Native activation and admission attach the session to the transport bound here,
                # the caller's, which every merged request shares.
                bind_transport(transport)
                try:
                    response = self.original_handle(request)
                except Exception as exc:
                    response = server._err(request["id"], -32000, f"handler error: {exc}")
                for index, (each, arrival, _) in enumerate(requests):
                    reply = answered(own_window(response, merged, index), each["id"], started - arrival)
                    if reply is not None:
                        transport.write(reply)
            finally:
                self.open_windows.reset(token)
                for *_, held in requests:
                    held.release()
        # A profile that is not a name still gets its handler's answer, from a lane of its own.
        lane = (method, profile if method in PROFILE_LANES and isinstance(profile, str) else None)
        merge = None
        if method in MERGED_READS:
            try:
                # Native activation binds the session to its caller's connection, so only one connection's requests merge.
                # Opens that differ only in their window share one activation; each answer is cut to its own window.
                merged_params = {key: value for key, value in params.items() if key != "window"} if method == "agent-interface.open" and isinstance(request.get("params"), dict) else request.get("params")
                merge = (id(transport), json.dumps(merged_params, sort_keys=True))
            except (TypeError, ValueError):
                merge = None
        try:
            (self.sends if method in QUEUED_SENDS else self.reads).submit(
                lane, lambda requests: context.run(answer, requests), (request, arrived, reservation), merge)
        except BaseException:
            # Nothing was queued, so native dispatch answers the raise and nothing else ever will.
            reservation.release()
            raise
        return None


    # Native seams: tool detail, inline guidance, frames and turn settlement.

    def native(self, method, params, rid="extension-native"):
        response = self.server.handle_request({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        if "error" in response:
            raise NativeResponseError(response["error"])
        return response["result"]

    def profile_for(self, sid):
        session = self.server._sessions.get(sid, {})
        home = session.get("profile_home") or session.get("hermes_home")
        # Receipt ownership is authoritative for app-started turns, including default.
        row = self.journal.db.execute("SELECT profile FROM receipts WHERE session_id=? ORDER BY created DESC LIMIT 1", (sid,)).fetchone()
        return row[0] if row else self.profile_name_for_home(home or self.get_hermes_home())

    def live_profile_for(self, sid):
        session = self.server._sessions.get(sid)
        if session is None:
            return None
        home = session.get("profile_home") or session.get("hermes_home")
        return self.profile_name_for_home(home or self.get_hermes_home()) or "default"

    def detailed_history(self, history, **kwargs):
        # Keep the canonical native projection, adding only details present in its
        # original tool rows. The compact native view otherwise omits most outputs.
        # Only an app open's own activation has caches; other native readers, such as
        # experience.py's, project and parse every row.
        rows = self.projecting.get()
        display, project = self.projection_parts(kwargs)
        context = self.projection_context(kwargs) if rows is not None else None
        if context is None:
            messages, tool_rows = project(history)
        else:
            messages, tool_rows = rows.projections.project(history, project, display, context, os.environ.get(PROJECTION_SHADOW) == "1")
        found = {}
        for key, row_id, content in tool_rows:
            found.setdefault(key, collections.deque()).append((row_id, content))
        for message in messages:
            if message.get("role") != "tool":
                continue
            matches = found.get((message.get("tool_call_id"), message.get("timestamp")))
            if not matches:
                continue
            row_id, result = matches.popleft()
            if row_id is not None:
                message["row_id"] = row_id
            if result is not None:
                message["app_tool_result"] = self.tool_result(result, row_id, rows)
        return messages

    def projection_parts(self, kwargs):
        """(Hermes's compaction display projection, ``project(rows)``: its history projection of ``rows`` with project_rows)."""
        display = self.server.project_compaction_message_for_display
        return display, lambda part: project_rows(self.native_history, display, part, kwargs)

    def projection_context(self, kwargs):
        """What a history projection reads besides its rows, for ProjectionMemo; None when it cannot be known.

        Hermes projects commentary under the profile's configuration and redaction, and labels tools in the
        configured display language, read from the home that is current while it projects.
        """
        redaction = redaction_state()
        if redaction is None:
            return None
        homes = {Path(home) for home in (kwargs.get("profile_home"), self.get_hermes_home()) if home}
        configs = tuple(sorted((str(home), file_stamp(home / "config.yaml")) for home in homes))
        return tuple(sorted((name, repr(value)) for name, value in kwargs.items())), configs, redaction

    @staticmethod
    def tool_result(content, row_id, rows):
        """A tool row's content, parsed when it is JSON, reusing this row's last parse of the same content."""
        if not isinstance(content, str):
            return content
        known = rows.tool_results.get(row_id) if rows is not None and type(row_id) is int else None
        # Usually the very string parsed last time, which compares by identity.
        if known is not None and known[0] == content:
            return known[1]
        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            parsed = content
        if rows is not None and type(row_id) is int:
            RowCache.keep(rows.tool_results, row_id, (content, parsed))
        return parsed

    def artifacts(self, result, session):
        # Only actual native tool results can register outputs. Never scan user text.
        root = Path(self.server._session_cwd(session)).resolve()
        def strings(value):
            if isinstance(value, str):
                yield value
            elif isinstance(value, dict):
                for item in value.values():
                    yield from strings(item)
            elif isinstance(value, list):
                for item in value:
                    yield from strings(item)
        paths = [path for raw in strings(result) for path in re.findall(r"(?:MEDIA:|@file:)([^\s\"'<>]+)", raw)]
        registered = []
        for value in paths:
            try:
                path = Path(value).resolve(strict=True)
                if not path.is_file() or not path.is_relative_to(root):
                    continue
                if any(part.startswith(".") or any(word in part.lower() for word in ("credential", "secret", "token", "password")) for part in path.relative_to(root).parts):
                    continue
                registered.append({"path": str(path), "name": path.name, "mime": mimetypes.guess_type(path.name)[0] or "application/octet-stream"})
            except (OSError, ValueError):
                continue
        return registered

    def app_prompt(self, sid, text, display_kind=None, author=None):
        if not isinstance(text, str) or display_kind is not None or author is not None:
            return False
        # A canonical session also accepts DMs, background work and other clients.
        # Only an unresolved app root with this exact input gets rendering guidance.
        with self.journal.lock:
            return self.journal.db.execute("SELECT 1 FROM receipts WHERE session_id=? AND terminal=0 AND steering=0 AND status IN ('uncertain','accepted') AND input_text=? LIMIT 1", (sid, text)).fetchone() is not None

    def with_inline_guidance(self, original, eligible, agent, *args, guidance_profile=None, **kwargs):
        if not eligible or agent is None:
            return original(*args, **kwargs)
        roster = self.delegation.guidance_for(guidance_profile) if guidance_profile else None
        # Hermes stages its first-contact note before the turn. It points at /help and offers a
        # profile interview, which suit a terminal, not an app chat with its own first-run flow.
        notes = getattr(agent, "_gateway_turn_context_notes", None)
        kept = without_first_contact_note(notes)
        if kept != notes:
            agent._gateway_turn_context_notes = kept
        prior = getattr(agent, "ephemeral_system_prompt", None)
        added = [part for part in (self.inline_instructions, self.progress_instructions, roster) if part and part not in (prior or "")]
        if added:
            agent.ephemeral_system_prompt = "\n\n".join(part for part in (prior, *added) if part)
        try:
            return original(*args, **kwargs)
        finally:
            agent.ephemeral_system_prompt = prior

    def install_inline_guidance(self):
        # Add client rendering guidance at model-call time, without changing SOUL,
        # persisted user text, receipt digests, or steering matches.
        server = self.server
        self.inline_instructions = json.loads((Path(__file__).resolve().parents[1] / "shared" / "inline-ui-instructions.json").read_text())
        # Said on every app turn, because a model skips a one-time rule about half the time. Hermes shows the line
        # it writes before a tool call as a progress line, in the chat and in live Talk.
        self.progress_instructions = json.loads((Path(__file__).resolve().parents[1] / "shared" / "progress-line-instructions.json").read_text())
        # Newer Hermes splits the invocation from turn setup and model changes.
        # Older qualified revisions enter with an already-built session agent.
        if hasattr(server, "_invoke_agent"):
            original_invoke = server._invoke_agent
            def invoke(sid, session, turn, *args, **kwargs):
                profile = self.live_profile_for(sid)
                if self.canonical.get(profile) == sid:
                    self.journal.memory_refresh.before_turn(profile, session, turn.agent)
                text = kwargs.get("text", args[7] if len(args) > 7 else None)
                display_kind = kwargs.get("display_kind", args[4] if len(args) > 4 else None)
                author = kwargs.get("turn_author", args[6] if len(args) > 6 else None)
                return self.with_inline_guidance(original_invoke, self.app_prompt(sid, text, display_kind, author), turn.agent, sid, session, turn, *args,
                                                 guidance_profile=profile, **kwargs)
            server._invoke_agent = invoke
        else:
            original_run = server._run_prompt_submit
            def run(rid, sid, session, *args, **kwargs):
                text = kwargs.get("text", args[0] if args else None)
                eligible = not str(rid).startswith("__") and self.app_prompt(sid, text, kwargs.get("display_kind"), kwargs.get("turn_author"))
                return self.with_inline_guidance(original_run, eligible, session.get("agent"), rid, sid, session, *args,
                                                 guidance_profile=self.live_profile_for(sid), **kwargs)
            server._run_prompt_submit = run

    def claim_turn(self, rid, sid, text, display_kind, author):
        """The receipt a native turn starting under request ID ``rid`` runs the prompt of, or None.

        Hermes's prompt.submit hands its own request ID to the turn it starts. A queue drain or a
        goal continuation started after that turn reuses the same ID for a turn that runs another
        prompt, so an ID names a receipt once, for the first turn that starts with it. That turn
        must also run exactly the text the receipt sent, unmarked: anything else is not the
        receipt's prompt, and the receipt stays unbound.
        """
        if not isinstance(rid, str):
            return None
        with self.turn_requests_lock:
            sent = self.turn_requests.pop(rid, None)
        if sent is None or sent[0] != sid or sent[2] != text or display_kind is not None or author is not None:
            return None
        return {"sid": sid, "request_id": sent[1], "used": False, "images": sent[3]}

    def install_turn_claims(self):
        server = self.server
        if not hasattr(server, "_run_prompt_submit"):
            return
        original = server._run_prompt_submit
        def run(rid, sid, session, *args, **kwargs):
            claim = self.claim_turn(rid, sid, kwargs.get("text", args[0] if args else None), kwargs.get("display_kind"), kwargs.get("turn_author"))
            # Set even when None: a drain or continuation runs on the thread of the turn that just
            # finished, and must never pass that turn's receipt to its own.
            token = self.turn_claim.set(claim)
            try:
                self.note_submit_row_time(session, kwargs.get("text", args[0] if args else None))
                if claim is not None and claim["images"]:
                    self.check_turn_images(session, claim)
                return original(rid, sid, session, *args, **kwargs)
            finally:
                self.turn_claim.reset(token)
        server._run_prompt_submit = run

    @staticmethod
    def usable_time(value):
        return type(value) in (int, float) and math.isfinite(value) and value > 0

    @classmethod
    def note_submit_row_time(cls, session, text):
        """Keep when the row this turn's prompt was saved under was stamped, as ``app_turn_row``, before Hermes admits the turn.

        A queued prompt that runs has its row written at the end of the transcript first (``_drain_queued_prompt`` ->
        ``_replace_queued_user_row_for_turn``, ``session_auto_continue.py:493``) and only then reaches ``_admit_prompt_turn``,
        which starts the turn (``_start_inflight_turn``). The turn's own prompt row is earlier than its ``started_at``, and
        ``mark_turn_start`` has to report that row's time or the prompt falls outside the turn. An ordinary prompt.submit starts the
        turn before it writes the row, so its row is later and changes nothing. Hermes staged the row as the session's
        ``_submit_user_row``; ``_adopt_submit_user_row`` pops it later, so it is read now. A row staged for another prompt is not
        this turn's. Set on every turn, even to nothing, so a turn never carries the last one's row.
        """
        staged = session.get("_submit_user_row")
        at = staged.get("timestamp") if isinstance(staged, dict) and isinstance(text, str) and staged.get("content") == text else None
        if cls.usable_time(at):
            session["app_turn_row"] = {"user": text.strip(), "at": at}
        else:
            session.pop("app_turn_row", None)

    def check_turn_images(self, session, claim):
        """Note on the receipt each photo of the send that is no longer staged as its turn starts.

        Hermes's prompt.submit marks the session running and returns; the turn's own thread takes the staged photos
        after that, and only a turn that is already running can have taken them first. At the turn's start they are
        still staged unless another client's turn, or a prompt that found the session running, took them. Never
        stops the turn: it runs, and the receipt says it ran without them.
        """
        try:
            gone = self.photos_gone(session, claim["images"])
            if gone:
                logging.getLogger(__name__).warning("A send's turn started without %d of its photos", len(gone))
                self.journal.note_images_missing(claim["request_id"], len(gone))
        except Exception:
            logging.getLogger(__name__).exception("Checking a send's photos at its turn's start failed")

    def photos_not_sent(self, sid, staged, turn, text):
        """The photos of a send whose prompt found a turn running that did not go with it.

        Hermes puts a prompt into a running turn as text only, so every photo of a ``joined`` send stayed behind, and
        is taken back here: it would otherwise run in the next turn, whoever's it is. A ``queued`` prompt keeps the
        photos staged when it arrived with it, in its own queue entry (``_handle_busy_submit``, ``session_auto_continue.py:
        418-439`` at ``ed1afb0``), so one found in neither the session's list nor that entry went to the turn that
        took the session first.

        Another client's prompt that was handled as busy first moved every staged photo into its own entry, so only
        our entry counts: the last one added, the one whose text ends with ours (``_enqueue_prompt`` appends a new
        entry, or merges text-only into the head). When the last entry is not ours, ours was never queued or has
        drained already, and nothing is said. The one window left is another entry that ends with the very same text.
        """
        session = self.server._sessions.get(sid)
        if session is None:
            return []
        if turn == "joined":
            self.unstage_images(sid, staged)
            return list(staged)
        with session["history_lock"]:
            entries = [entry for entry in (session.get("queued_prompt"), *(session.get("queued_prompts") or [])) if isinstance(entry, dict)]
            ours = entries[-1] if entries else None
            if ours is None or not isinstance(ours.get("text"), str) or not ours["text"].rstrip().endswith(text.rstrip()):
                return []
            kept = [*session.get("attached_images", []), *(ours.get("image_paths") or [])]
        gone = []
        for image in staged:
            if image in kept:
                kept.remove(image)
            else:
                gone.append(image)
        return gone

    @staticmethod
    def photos_gone(session, staged):
        """The photos of ``staged`` the session no longer lists, each listed entry counted once.

        Under history_lock, which each snapshot of the list takes for itself alone.
        """
        with session["history_lock"]:
            listed = list(session.get("attached_images", []))
        gone = []
        for image in staged:
            if image in listed:
                listed.remove(image)
            else:
                gone.append(image)
        return gone

    def bind_turn_row(self, sid, payload):
        """Bind the receipt this thread's turn claimed to the prompt row its completion reports.

        Only a turn that claimed the receipt at its start binds it, once, and only an unbound
        receipt: Hermes's own answer to prompt.submit names the row whenever it staged one, and
        that row stays even when the turn could not adopt it and reports a row of its own.
        Every other completion, such as another client's turn, a queued or redirected send's
        neighbor, a resumed turn or a goal continuation, binds nothing.

        The same completion lists the turn's committed rows (``persisted_turn.row_ids``), kept as the
        receipt's turn: a steer is bound later only to a row within its span. A value that is not a list
        of row IDs keeps no turn.
        """
        claim = self.turn_claim.get()
        if claim is None or claim["sid"] != sid or claim["used"]:
            return
        claim["used"] = True
        persisted = payload.get("persisted_turn") or {}
        row_id, row_ids = persisted.get("user_row_id"), persisted.get("row_ids")
        if type(row_id) is not int:
            return
        extent = turn_extent(row_ids)
        extent = None if extent is None else json.dumps(extent)
        with self.journal.lock, self.journal.db:
            self.journal.db.execute("UPDATE receipts SET row_id=COALESCE(row_id,?),turn_rows=? WHERE request_id=? AND steering=0", (row_id, extent, claim["request_id"]))

    def keep_joined_turn(self, sid, payload):
        """Keep the rows of the turn that just completed with each send Hermes put into it.

        A send answered ``steered`` or ``redirected`` joined the turn running when its answer came, which can be
        another client's, so no receipt holds that turn's rows. The completion's committed rows are kept as the send's
        ``turn_rows`` with the turn's own prompt row first, which bind_steers reads as the start of the turn's span and
        never binds, and bind_steers binds the send by the steer rule. A completion that reports no rows, or no prompt
        row, keeps none.
        """
        with self.joined_lock:
            requests = self.joined.pop(sid, None)
        persisted = payload.get("persisted_turn") or {}
        prompt, extent = persisted.get("user_row_id"), turn_extent(persisted.get("row_ids"))
        if not requests or type(prompt) is not int or extent is None:
            return
        with self.journal.lock, self.journal.db:
            self.journal.db.execute("UPDATE receipts SET turn_rows=? WHERE request_id IN (SELECT value FROM json_each(?))",
                                    (json.dumps([prompt, *(row for row in extent if row != prompt)]), json.dumps(requests)))

    def record_live_tool(self, sid, session, kind, payload):
        """Keep a running or finished tool call for polls until its history row appears."""
        with self.journal.lock:
            run = self.journal.db.execute(OPEN_RUN, (sid,)).fetchone()
        calls = session.setdefault("app_live_tools", {})
        tool_id = payload["tool_id"]
        prior = calls.get(tool_id, {})
        detail = {**prior, "id": prior.get("id") or f"{run[0] if run else session.get('app_turn_id', sid)}:{tool_id}",
                  "name": payload.get("name") or prior.get("name") or "Tool",
                  "status": "running" if kind == "tool.start" else "completed"}
        if payload.get("args") is not None:
            detail["arguments"] = json.dumps(payload["args"], ensure_ascii=False, indent=2)
        elif isinstance(payload.get("args_text"), str):
            detail["arguments"] = payload["args_text"]
        if kind == "tool.start":
            detail["startedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            session.setdefault("app_live_tool_row_floors", {})[tool_id] = history_row_floor(session)
        else:
            result = payload.get("result")
            detail["result"] = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
            if isinstance(result, dict) and (result.get("success") is False or result.get("ok") is False or result.get("error") or
                                           isinstance(result.get("exit_code"), int) and not isinstance(result.get("exit_code"), bool) and result["exit_code"] != 0):
                detail["status"] = "failed"
                if isinstance(result.get("error"), str):
                    detail["error"] = result["error"]
            detail["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        calls[tool_id] = detail

    def write(self, frame):
        journal, server = self.journal, self.server
        params = frame.get("params") or {}
        sid = params.get("session_id")
        kind = params.get("type")
        payload = params.get("payload") or {}
        session = server._sessions.get(sid, {}) if sid else {}
        if sid and kind == "status.update" and self.compaction.owns(sid):
            # A background compaction's progress line. Nobody asked for it, so no client shows it.
            return True
        self.compaction.touch(sid)
        if sid and kind == "message.start":
            session["app_live_tools"] = {}
            session["app_live_tool_row_floors"] = {}
            session["app_exposed_reasoning"] = ""
            session["app_turn_id"] = uuid.uuid4().hex
        if sid and kind in ("reasoning.delta", "reasoning.available") and isinstance(payload.get("text"), str):
            text = payload["text"]
            prior = session.get("app_exposed_reasoning", "")
            session["app_exposed_reasoning"] = prior + text if kind != "reasoning.available" or not prior.endswith(text) else prior
        if sid and kind in ("tool.start", "tool.complete") and isinstance(payload.get("tool_id"), str):
            self.record_live_tool(sid, session, kind, payload)
        event_kind = {"complete": "completed", "error": "failed", "interrupted": "interrupted"}.get(payload.get("status")) if kind == "message.complete" else None
        if frame.get("method") == "approval":
            event_kind = "approval"
        if sid and kind == "message.complete":
            # Image-only admission has no staged row. Native completion reports the turn's
            # committed rows, which bind the receipt only if this turn ran its prompt.
            self.bind_turn_row(sid, payload)
            self.keep_joined_turn(sid, payload)
        if sid and kind == "tool.complete":
            with journal.lock, journal.db:
                session = server._sessions.get(sid, {})
                run = journal.db.execute(OPEN_RUN, (sid,)).fetchone()
                journal.db.execute("INSERT INTO tools(profile,stored_session,run_id,tool_id,result,artifacts,detail) VALUES(?,?,?,?,?,?,?)", (self.profile_for(sid), session.get("session_key", sid), run[0] if run else None, payload.get("tool_id"), json.dumps(payload.get("result")), json.dumps(self.artifacts(payload.get("result"), session)), json.dumps(session.get("app_live_tools", {}).get(payload.get("tool_id")))))
        if sid and event_kind == "approval":
            with journal.lock:
                row = journal.db.execute(OPEN_RUN, (sid,)).fetchone()
                root = row[0] if row else None
                identity = f"{root}:{event_kind}:{frame.get('id') if event_kind == 'approval' else ''}" if root else None
                # Approval commands can carry credentials, so the event body stays empty; the chat shows them after sign-in.
                journal.event(self.profile_for(sid), sid, event_kind, "Approval requested" if event_kind == "approval" else "Hermes " + event_kind, root, event_key=identity)
        elif sid and event_kind:
            # A native message.complete closes one turn, before steering/goal queue drain.
            # The post-followup seam below is the task boundary.
            self.settlement[sid] = event_kind
        return self.native_write(frame)

    def followups(self, rid, sid, session, result, goal_followup):
        # Inline queue drains can themselves wait for approvals. Keep admission live
        # during that execution; the unresolved-root guard fences the idle seam.
        journal = self.journal
        self.native_followups(rid, sid, session, result, goal_followup)
        with self.submission_lock:
            if session.get("running") or session.get("queued_prompt"):
                return
            kind = self.settlement.pop(sid, None)
            if kind:
                with journal.lock, journal.db:
                    row = journal.db.execute("SELECT COALESCE(run_id,request_id),profile FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created LIMIT 1", (sid,)).fetchone()
                    if row:
                        # Notifications quote what actually happened instead of a generic status.
                        outcome = result if isinstance(result, dict) else {}
                        body = event_body(outcome.get("final_response") if kind == "completed" else outcome.get("error") if kind == "failed" else None)
                        journal.event(row[1], sid, kind, "Hermes " + kind, row[0], body=body, event_key=f"{row[0]}:{kind}")
                        journal.db.execute("UPDATE receipts SET terminal=1,status=CASE WHEN ? THEN 'interrupted' ELSE status END WHERE COALESCE(run_id,request_id)=? AND terminal=0", (kind == "interrupted", row[0]))

    def record_marker(self, session, text, **kwargs):
        if session.get("app_manual_recovery"):
            kwargs["auto_continue"] = False
        return self.native_marker(session, text, **kwargs)

    def maybe_continue(self, sid, session, stored_key):
        with self.maintenance_lock:
            if self.maintenance_state():
                return None
        profile = self.profile_name_for_home(session.get("profile_home") or self.get_hermes_home())
        with self.journal.lock:
            owned = self.journal.db.execute("SELECT 1 FROM receipts WHERE profile=? AND stored_session=? LIMIT 1", (profile, stored_key)).fetchone()
        if owned:
            session["app_manual_recovery"] = True
            return None
        return self.native_auto_continue(sid, session, stored_key)

    def install_native_seams(self):
        server = self.server
        self.native_history = server._history_to_messages
        server._history_to_messages = self.detailed_history
        try:
            from agent import display
        except ImportError:
            logging.getLogger(__name__).warning("Hermes has no agent.display; long chats open without the shell summary memo")
        else:
            memoize_shell_summary(display)
        self.install_inline_guidance()
        self.install_turn_claims()
        self.native_write = server.write_json
        server.write_json = self.write
        self.native_followups = server._run_post_turn_followups
        server._run_post_turn_followups = self.followups
        # Disable native automatic retry narrowly for canonical sessions admitted through this app.
        self.native_marker = server._record_turn_marker
        server._record_turn_marker = self.record_marker
        self.native_auto_continue = server._maybe_schedule_auto_continue
        server._maybe_schedule_auto_continue = self.maybe_continue

    # Canonical open: each profile's one Bot Chat, attributed from the journal.

    def profile_lock(self, profile):
        """The profile's open lock. Order: submission_lock, profile lock, journal.lock, cache_lock."""
        with self.profile_locks_guard:
            lock = self.profile_locks.get(profile)
            if lock is None:
                lock = self.profile_locks[profile] = threading.RLock()
            return lock

    def history_identity(self, session):
        if "history" not in session or "history_lock" not in session:
            return None
        with session["history_lock"]:
            if any(session.get(key) for key in ("running", "queued_prompt", "queued_prompts", "pending_steer",
                                                "_auto_continue_scheduled", "_compute_host_open_request", "resume_hydrating")):
                return None
            prefix, history = session.get("display_history_prefix"), session.get("history")
            def rows_identity(rows):
                # Flush stamps row IDs in place without changing history_version.
                return (id(rows), len(rows or []), tuple((id(row), row.get("_row_id")) for row in rows or [] if isinstance(row, dict)))
            memory = (session.get("session_key"), session.get("history_version"), rows_identity(prefix), rows_identity(history))
            home = Path(session.get("profile_home") or self.get_hermes_home())
        db = self.server._get_db() if not session.get("profile_home") and hasattr(self.server, "_get_db") else None
        db_path = Path(getattr(db, "db_path", home / "state.db"))
        # Like the native change watcher, observe both DB and WAL: another native
        # connection can commit a display lineage without changing the warm history.
        # File replacement, checkpoint and profile commentary configuration invalidate too.
        # Vault secrets and plugin patterns registered at runtime redact native commentary.
        return memory, tuple(file_stamp(path) for path in (db_path, db_path.with_name(db_path.name + "-wal"), home / "config.yaml")), redaction_state()

    def row_cache(self, sid, session):
        """The canonical session's RowCache, a new one when its stored session changed.

        Callers hold the profile's lock, the only one under which its tables change.
        """
        scope = session.get("session_key")
        with self.cache_lock:
            rows = self.row_caches.get(sid)
            if rows is None or rows.scope != scope:
                rows = self.row_caches[sid] = RowCache(scope, self.projection_budget)
            return rows

    def activate(self, profile, omit, skip_cache):
        """Activate or resume the profile's canonical session; None for an unknown profile.

        Returns (value, cached, identity, mutation). ``cached`` is decorated history this
        poll may reuse, already placed in ``value``. Callers hold the profile's lock.
        """
        server, journal, canonical, decorated = self.server, self.journal, self.canonical, self.decorated
        # Retain only live canonical sessions, with a bounded household cache. Other
        # profiles' opens change these dictionaries concurrently, so read snapshots.
        live_canonical = set(canonical.copy().values()) & set(server._sessions.copy())
        with self.cache_lock:
            for old in [sid for sid in decorated if sid not in live_canonical]:
                del decorated[old]
            for old in [sid for sid in self.row_caches if sid not in live_canonical]:
                del self.row_caches[old]
        cached = None
        identity = None
        mutation = None
        if profile in canonical and canonical[profile] in server._sessions:
            sid = canonical[profile]
            rows = self.row_cache(sid, server._sessions[sid])
            identity = None if omit else self.history_identity(server._sessions[sid])
            with journal.lock:
                mutation = journal.version(profile)
                with self.cache_lock:
                    entry = decorated.get(sid)
                    lifetime = DECORATED_TTL if identity is not None and identity[-1] is not None else UNTRACKED_REDACTION_TTL
                    if not omit and not skip_cache and identity is not None and mutation is not None and entry and entry[:2] == (identity, mutation) and time.monotonic() - entry[3] < lifetime:
                        cached = entry[2]
                        # Eviction keeps the most recently read histories; lifetime counts from the fill.
                        decorated[sid] = (*entry[:4], time.monotonic())
            rows.projections.report = None
            token = self.projecting.set(rows)
            try:
                value = self.native("session.activate", {"session_id": sid, "profile": profile, **({"omit_messages": True} if omit or cached is not None else {})})
                # Native activation takes its own snapshot. Never combine cached history with
                # a live payload that crossed a history or journal mutation.
                if cached is not None and (self.history_identity(server._sessions[sid]) != identity or entry[1] != journal.version(profile)):
                    cached = None
                    identity = self.history_identity(server._sessions[sid])
                    value = self.native("session.activate", {"session_id": sid, "profile": profile})
            finally:
                self.projecting.reset(token)
            if cached is not None:
                value["messages"] = cached
                value["messages_omitted"] = False
                value["message_count"] = len(cached)
        else:
            roster = self.native("profiles.list", {"include_sessions": True})["profiles"]
            bot = next((x for x in roster if x["name"] == profile), None)
            if bot is None:
                return None
            saved = bot.get("canonical_session")
            if saved:
                # The resume projects through the memo the warm-up filled, or a new one, which later opens keep. It
                # projects images as every later open's activation does, so its pieces are theirs.
                scope = saved["resolved_id"]
                with self.cache_lock:
                    rows = self.warm_caches.pop((profile, scope), None) or RowCache(scope, self.projection_budget)
                    # A warm-up of an earlier tip of this chat is never adopted.
                    for key in [key for key in self.warm_caches if key[0] == profile]:
                        del self.warm_caches[key]
                rows.projections.on_empty = None
                rows.projections.report = None
                token = self.projecting.set(rows)
                try:
                    value = self.native("session.resume", {"session_id": scope, "profile": profile, "close_on_disconnect": False})
                finally:
                    self.projecting.reset(token)
                # row_cache replaces it if the resume landed on another stored session.
                with self.cache_lock:
                    self.row_caches[value["session_id"]] = rows
            else:
                value = self.native("session.create", {"profile": profile, "title": "Bot Chat", "hidden": True, "follow_profile_config": True, "close_on_disconnect": False})
                try:
                    self.native("session.title", {"session_id": value["session_id"], "profile": profile, "title": "Bot Chat"})
                except RuntimeError:
                    # Another official writer acquired the unique canonical title. Adopt it.
                    roster = self.native("profiles.list", {"include_sessions": True})["profiles"]
                    saved = next(x for x in roster if x["name"] == profile)["canonical_session"]
                    if not saved:
                        raise
                    value = self.native("session.resume", {"session_id": saved["resolved_id"], "profile": profile, "close_on_disconnect": False})
            canonical[profile] = value["session_id"]
        return value, cached, identity, mutation

    def mark_local_requests(self, value):
        # A compute-host mirror is not locally owned. Only expose inline
        # capture when this executor's native registry can settle the exact
        # canonical request and register its values at its own egress guard.
        from tui_gateway import server_requests as secure_requests
        explicit = getattr(self.journal, "explicit_credential", lambda _request_id: None)
        with secure_requests._lock:
            for request in value["open_requests"]:
                local = secure_requests._open.get(request.get("id"))
                request["app_local_secure"] = bool(local is not None and local.sid == value["session_id"] and local.method == request.get("method"))
                # A login the agent asked for by address, with what the card must show besides it.
                credential = explicit(request.get("id")) if request["app_local_secure"] and request.get("method") == "vault.save_login" else None
                if credential:
                    request["app_credential"] = credential

    @staticmethod
    def mark_turn_start(session, value):
        """Say when the native turn Hermes reports as running started, in epoch seconds, as ``inflight.started_at``.

        Hermes sets ``started_at`` on the session's turn when it starts (``_start_inflight_turn``) but leaves it out of
        the ``inflight`` snapshot it reports. The server places the turn's saved rows by it, since a prompt's words cannot
        tell a new native turn from guidance steered into the running one. The turn starts at its prompt's row when that was saved
        before Hermes started the turn, as a queued prompt's is. Only a turn that is still the one the snapshot
        describes is stamped: another turn may have started since the snapshot was taken, and its start would put the
        snapshot's rows before the turn.
        """
        inflight, turn = value.get("inflight"), session.get("inflight_turn")
        if not isinstance(inflight, dict) or not isinstance(turn, dict):
            return
        started, user = turn.get("started_at"), str(turn.get("user") or "").strip()
        if not Bridge.usable_time(started):
            return
        if user != inflight.get("user") or not str(turn.get("assistant") or "").startswith(inflight.get("assistant") or ""):
            return
        # A queued prompt's row was saved before Hermes started its turn (``note_submit_row_time``): the turn starts at the prompt.
        row = session.get("app_turn_row")
        if isinstance(row, dict) and row.get("user") == user and row["at"] < started:
            started = row["at"]
        inflight["started_at"] = started

    def describe_task(self, profile, sid, session, value):
        if self.compaction.owns(sid):
            # Hermes holds the session running while it compacts. That is not anyone's task,
            # and a client that saw it would send its next message as steering.
            for holder in (value, value.get("info")):
                if isinstance(holder, dict) and "running" in holder:
                    holder["running"] = False
        elif session.get("running") and session.get("app_exposed_reasoning"):
            value.setdefault("inflight", {})
            if value["inflight"] is None:
                value["inflight"] = {}
            value["inflight"]["reasoning"] = session["app_exposed_reasoning"]
        self.mark_turn_start(session, value)
        session["app_manual_recovery"] = True
        # A registered keeper marks a session prepared for app work; open_canonical relies on it.
        keeper = self.keepers.get(sid) or Keeper()
        self.server._attach_session_transport(session, keeper)
        self.keepers.setdefault(sid, keeper)
        db = self.journal.db
        value["executor_epoch"] = self.journal.epoch
        value["canonical_stored_session_id"] = session.get("session_key")
        # Other profiles' opens share this connection. Never hold the journal across native calls.
        with self.journal.lock:
            interruption = db.execute("SELECT request_id,created FROM interruptions WHERE profile=? AND stored_session=?", (profile, value["canonical_stored_session_id"])).fetchone()
            # An admission still waiting on staging or on Hermes's answer is not a run yet: Hermes
            # may still refuse or queue it, and its turn may not have started.
            current = db.execute(SHOWN_RUN, (sid, json.dumps(sorted(self.admitting)))).fetchone()
            # Cold resume has a new runtime SID; use the canonical journal owner.
            terminal = self.journal.last_terminal(profile, sid, value["canonical_stored_session_id"])
        value["app_interruption"] = {"requestId": interruption[0], "runId": interruption[0], "detail": "Hermes restarted during this task. Review its results before retrying."} if interruption else None
        value["app_run_id"] = current[0] if current else None
        value["app_task_state"] = {"completed": "done", "failed": "failed", "interrupted": "interrupted"}.get(terminal[0]) if terminal and not current else None

    def original_rows(self, session, messages):
        """Show each copy native in-place compaction makes under the row ID of the message it copies.

        Compaction archives every row and stores its kept head and tail again as new rows. Every
        copy keeps the message's ``message_uid``. Without this, the copies of recent messages would
        lose their receipts (sender, files, run) and every copy would change its message ID.

        The store is asked on every open; nothing here is cached. A snapshot restored into the
        live file keeps its inode and generation stamp, yet its copies can reuse these row IDs
        for other messages. Checking that a copy and its recorded original still hold their uid
        is not enough either: Hermes's ``replace_messages`` can move a message's first row in one
        history and not in a restored one. Only a changed database or WAL signature would say when
        to look again, and a running turn changes it before nearly every open.
        """
        ids = [m["row_id"] for m in messages if type(m.get("row_id")) is int]
        key = session.get("session_key")
        if not ids or not key or not callable(getattr(self.server, "_session_db", None)):
            return
        with self.server._session_db(session) as db:
            if db is None:
                return
            visible = json.dumps(ids)
            # The session index finds every copy; a uid join instead takes seconds on a long chat.
            first = dict(db._read_all("SELECT message_uid,MIN(id) FROM messages WHERE session_id=? AND message_uid IN "
                                      "(SELECT message_uid FROM messages WHERE id IN (SELECT value FROM json_each(?))) GROUP BY message_uid", (key, visible)))
            uids = dict(db._read_all("SELECT id,message_uid FROM messages WHERE session_id=? AND id IN (SELECT value FROM json_each(?))", (key, visible)))
        for message in messages:
            original = first.get(uids.get(message.get("row_id")))
            if type(original) is int and original < message["row_id"]:
                message["row_id"] = original

    def tool_records(self, ids, rows):
        """Parsed journal tool records by ``tools.id``, in the order of ``ids``.

        Each is (result, artifacts, detail or None, detail's parsed arguments or None). Rows in
        the session's RowCache are not read again. Callers hold journal.lock.
        """
        known = rows.tool_records if rows is not None else {}
        if rows is not None:
            journal = self.journal.db.execute("PRAGMA data_version").fetchone()[0]
            if rows.journal != journal:
                known.clear()
                rows.journal = journal
        missing = [record_id for record_id in ids if record_id not in known]
        found = {}
        if missing:
            for record_id, result, artifacts, detail in self.journal.db.execute(
                    "SELECT id,result,artifacts,detail FROM tools WHERE id IN (SELECT value FROM json_each(?))", (json.dumps(missing),)):
                detail = json.loads(detail) if detail else None
                arguments = None
                if isinstance(detail, dict):
                    try:
                        arguments = json.loads(detail.get("arguments", "{}"))
                    except (ValueError, TypeError):
                        arguments = None
                found[record_id] = (json.loads(result), json.loads(artifacts or "[]"), detail, arguments)
        records = {record_id: found[record_id] if record_id in found else known[record_id] for record_id in ids if record_id in found or record_id in known}
        for record_id, record in found.items():
            RowCache.keep(known, record_id, record)
        return records

    def attribute(self, profile, sid, value, rows=None):
        """Bind app receipts, files and tool details to native history rows.

        Returns (messages, the profile's journal version after binding). App attribution follows
        Hermes's durable row identity, never a rewritten body. Read each journal table once
        per poll, not once per message. The only binding made here is a steer's, from these
        rows and the journal alone, so a later read of the same rows and journal binds
        nothing new and the result can be cached. Callers hold journal.lock, which native
        writers also take, so none lands mid-poll. ``rows`` is the session's RowCache, or None.
        """
        journal, server = self.journal, self.server
        stored = value["canonical_stored_session_id"]
        messages = value.get("messages", [])
        self.bind_steers(profile, stored, messages)
        attributed = {}
        for row in journal.db.execute("SELECT row_id,request_id,actor,COALESCE(run_id,request_id),attachments,input_text,steering=1 OR " + JOINED % "" + " FROM receipts WHERE profile=? AND row_id IN (SELECT value FROM json_each(?)) ORDER BY created DESC", (profile, json.dumps([m["row_id"] for m in messages if type(m.get("row_id")) is int]))):
            attributed.setdefault(row[0], row[1:])
        # Which records each call has comes from the index alone; their bodies come from the cache.
        calls = {row[0]: row[1:] for row in journal.db.execute("SELECT id,tool_id,run_id FROM tools WHERE profile=? AND stored_session=? AND tool_id IN (SELECT value FROM json_each(?)) ORDER BY id", (profile, server._sessions[sid].get("session_key", sid), json.dumps([m["tool_call_id"] for m in messages if m.get("role") == "tool" and type(m.get("tool_call_id")) is str])))}
        tool_records = {}
        for record_id, record in self.tool_records(list(calls), rows).items():
            tool_records.setdefault(calls[record_id], []).append(record)
        current_run = None
        for message in messages:
            if message.get("role") == "user":
                current_run = None
            if message.get("row_id") is None:
                row = None
            elif type(message["row_id"]) is int:
                row = attributed.get(message["row_id"])
            else:
                row = journal.db.execute("SELECT request_id,actor,COALESCE(run_id,request_id),attachments,input_text,steering FROM receipts WHERE row_id=? AND profile=? ORDER BY created DESC LIMIT 1", (message.get("row_id"), profile)).fetchone()
            if row:
                message["app_request_id"], message["app_sender_id"] = row[:2]
                current_run = row[2]
                message["app_attachments"] = json.loads(row[3] or "[]")
                display_text = row[4] or ""
                suffix = "\n".join("@file:" + json.dumps(x["path"], ensure_ascii=False) for x in message["app_attachments"] if not str(x.get("mime", "")).startswith("image/"))
                if suffix and display_text.endswith("\n" + suffix):
                    display_text = display_text[:-len(suffix)-1]
                message["app_display_text"] = display_text
                if row[5]:
                    # Admitted into the task that was already running, so every device can say so.
                    message["app_steering"] = True
            if current_run:
                message["app_run_id"] = current_run
            if message.get("role") == "tool":
                if not current_run:
                    recorded = []
                elif type(message.get("tool_call_id")) is str:
                    recorded = tool_records.get((message["tool_call_id"], current_run), [])
                else:
                    found = journal.db.execute("SELECT id FROM tools WHERE profile=? AND stored_session=? AND tool_id=? AND run_id=? ORDER BY id", (profile, server._sessions[sid].get("session_key", sid), message.get("tool_call_id"), current_run)).fetchall()
                    recorded = list(self.tool_records([row[0] for row in found], rows).values())
                tool = next((item for item in recorded if item[0] == message.get("app_tool_result")), None)
                if tool:
                    # The persisted native output remains authoritative.
                    message["app_artifacts"] = tool[1]
                    # Reused IDs within a run cannot identify one call's
                    # timestamps or arguments. Fall back to its native row.
                    detail = tool[2]
                    if len(recorded) == 1 and isinstance(detail, dict) and detail.get("name") == message.get("name") and tool[3] == (message.get("args") or {}):
                        message["app_tool_call"] = detail
        return messages, journal.version(profile)

    def bind_steers(self, profile, stored, messages):
        """Bind each unbound steer whose row can only be its own.

        Hermes answers session.steer with no row and no request ID, and writes the steer later as
        a user row holding its words, typed ``display_kind`` ``steer``, beside any other client's
        correction with the same words (``tui_gateway/methods_session_interrupt.py:114-130``,
        ``agent/agent_runtime_helpers.py:3668-3703`` and ``agent/prompt_builder.py:583-592`` at
        ``ed1afb0``). Words alone are no evidence. A steer is bound only once its root's turn has
        finished and reported its committed rows (``turn_rows``, kept by bind_turn_row). Those leave
        the steer's own row out: Hermes reports only rows whose message carries a committed row ID,
        and the steer's is appended mid-turn without one (``agent/persisted_turn_receipt.py:40``),
        as release qualification against real Hermes saw on 2026-11-12. So the turn bounds a span,
        from its lowest row to its highest, and a steer is bound only when exactly one user row in
        that span holds its words and is typed a steer, that row was not saved more than a second
        before the steer was sent, no receipt holds that row, and no other receipt of the run,
        bound or not, sent the same words. The second is the slack between the add-on's clock at
        the receipt and Hermes's at the row, as before this rule. A row whose time cannot be read or
        compared binds nothing.

        A send Hermes put into the running turn instead of starting its own (admission turn ``joined``)
        is bound by the same rule, with itself as the root: ``keep_joined_turn`` keeps the rows of the turn
        it joined, that turn's own prompt row first, as its ``turn_rows``. That prompt row starts the span
        and is never a candidate. The row need not be typed a steer: a redirect Hermes takes during a model
        request is written as a plain user row (``agent/conversation_loop.py:324-354`` at ``ed1afb0``), and
        one during tool execution as a steer. A later send into that turn steers into the joined send's run,
        so the rule's guard on words of one run covers both. Anything else leaves it unbound and its row
        shows unattributed. Known limit: a native client's identical words in the same turn, saved after
        the steer was sent or within that second, can still take the steer's place, because Hermes names
        no steer's row (docs/HermesCapabilityMatrix.md). Callers hold journal.lock.
        """
        journal = self.journal
        steers = journal.db.execute("SELECT steer.request_id,steer.input_text,steer.run_id,root.turn_rows,steer.created,steer.steering=1 FROM receipts steer JOIN receipts root ON root.request_id=steer.run_id WHERE steer.profile=? AND steer.stored_session=? AND (steer.steering=1 OR steer.run_id=steer.request_id AND " + JOINED % "steer." + ") AND steer.status='accepted' AND steer.row_id IS NULL AND root.turn_rows IS NOT NULL", (profile, stored)).fetchall()
        def saved(row_id):
            # When Hermes saved the row, read as main reads it: float() of its time, and a missing or
            # zero one as now. None for a time that cannot be read or compared, which binds nothing.
            stamp = next(message for message in messages if message.get("row_id") == row_id).get("timestamp")
            try:
                at = float(stamp or time.time())
            except (TypeError, ValueError, OverflowError):
                return None
            return at if math.isfinite(at) else None
        for request_id, text, run_id, extent, sent, steering in steers:
            try:
                extent = turn_extent(json.loads(extent))
            except ValueError:
                continue
            if not extent:
                continue
            # The span of the turn's rows, which leave a delivered steer's row out. A joined send's are
            # kept with the turn's own prompt row first, which is never its row.
            low, high, prompt = min(extent), max(extent), None if steering else extent[0]
            found = [message["row_id"] for message in messages if message.get("role") == "user" and type(message.get("row_id")) is int
                     and low <= message["row_id"] <= high and message["row_id"] != prompt and message.get("text") == text
                     and (not steering or message.get("display_kind") == "steer")]
            # The root's own row is held by the root's receipt, so the second test also excludes it.
            if len(found) != 1 or (at := saved(found[0])) is None or sent > at + 1 or journal.db.execute("SELECT 1 FROM receipts WHERE profile=? AND (row_id=? OR (COALESCE(run_id,request_id)=? AND input_text=? AND request_id<>?)) LIMIT 1", (profile, found[0], run_id, text, request_id)).fetchone():
                continue
            with journal.db:
                journal.db.execute("UPDATE receipts SET row_id=? WHERE request_id=?", (found[0], request_id))

    def unrepresented_tool_calls(self, session, messages):
        # Standard native tools flush before completion; Codex can expose
        # completion before its turn flush. Keep those results until their
        # exact call appears in visible canonical history. Reused old IDs
        # cannot suppress a new call, and uncertain boundaries keep detail.
        calls = []
        if not session.get("running"):
            return calls
        # Frame threads add tools and replace these per turn. Iterate copies.
        live, floors = dict(session.get("app_live_tools", {})), dict(session.get("app_live_tool_row_floors", {}))
        for tool_id, call in live.items():
            represented = False
            if call.get("status") != "running":
                floor = floors.get(tool_id)
                try:
                    arguments = json.loads(call.get("arguments", "{}"))
                except (ValueError, TypeError):
                    arguments = None
                for message in messages:
                    if message.get("role") != "tool":
                        continue
                    if (message.get("app_tool_call") or {}).get("id") == call.get("id"):
                        represented = True
                        break
                    if (type(floor) is int and type(message.get("row_id")) is int and message["row_id"] > floor
                            and message.get("tool_call_id") == tool_id and message.get("name") == call.get("name")
                            and arguments == (message.get("args") or {})
                            and parsed_result(message.get("app_tool_result")) == parsed_result(call.get("result"))):
                        represented = True
                        break
            if not represented:
                calls.append(call)
        return calls

    def open_bot(self, rid, params):
        """The profile's canonical session, reporting where this open spent its time.

        ``app_timing`` holds milliseconds: waiting for the profile's lock, native activation,
        journal decoration, windowing and the whole call.
        """
        started = time.perf_counter()
        phases = dict.fromkeys(("wait", "activate", "decorate", "window"), 0.0)
        with self.opening(), self.profile_lock(params.get("profile", "default")):
            phases["wait"] = time.perf_counter() - started
            response = self.open_locked(rid, params, phases)
        if "result" in response:
            phases["total"] = time.perf_counter() - started
            response["result"]["app_timing"] = {name: round(seconds * 1000, 1) for name, seconds in phases.items()}
        return response

    def open_locked(self, rid, params, phases):
        server, journal = self.server, self.journal
        profile = params.get("profile", "default")
        # Callers that need only the session, its run state and open requests skip the
        # native history read. A first open still resumes with history.
        omit = params.get("omit_messages") is True
        mark = time.perf_counter()
        activated = self.activate(profile, omit, params.get("_skip_cache"))
        if activated is None:
            return server._err(rid, 4040, "Unknown Hermes profile")
        phases["activate"] += time.perf_counter() - mark
        mark = time.perf_counter()
        value, cached, identity, mutation = activated
        value.setdefault("open_requests", [])
        self.mark_local_requests(value)
        sid = value["session_id"]
        session = server._sessions[sid]
        self.describe_task(profile, sid, session, value)
        rows = self.row_cache(sid, session)
        if cached is None:
            # Reads the session store, so never under journal.lock, which native writers take.
            self.original_rows(session, value.get("messages", []))
        with journal.lock:
            if cached is None:
                messages, bound_mutation = self.attribute(profile, sid, value, rows)
        # Never acquire history_lock while holding journal.lock: native flushes
        # emit frames under history_lock and the frame hook needs journal.lock.
        after = self.history_identity(session) if not omit else None
        if cached is not None and (after != identity or mutation != journal.version(profile)):
            phases["decorate"] += time.perf_counter() - mark
            return self.open_locked(rid, {**params, "_skip_cache": True}, phases)
        with journal.lock:
            if cached is None:
                cache = self.decorated
                with self.cache_lock:
                    if not omit and identity is not None and after == identity and mutation == bound_mutation == journal.version(profile):
                        # Full binding preserves cursor identities and earlier file context.
                        now = time.monotonic()
                        cache[sid] = (identity, bound_mutation, messages, now, now)
                        while len(cache) > DECORATED_LIMIT:
                            del cache[min(cache, key=lambda key: cache[key][4])]
                    else:
                        cache.pop(sid, None)
        phases["decorate"] += time.perf_counter() - mark
        mark = time.perf_counter()
        value["app_tool_calls"] = self.unrepresented_tool_calls(session, value.get("messages", []))
        if cached is None and rows.projections.report is not None and os.environ.get(PROJECTION_SHADOW) == "1":
            value["app_projection_shadow"] = rows.projections.report
        if "messages" in value:
            # Each open merged into this one (see route) cuts its own window from the same history.
            merged = self.open_windows.get()
            windows = merged["windows"] if merged is not None else [params.get("window")]
            answers = [self.windowed(value["messages"], sid, None if omit else window) for window in windows]
            value["messages"], cut = answers[0]
            if cut:
                value["app_window"] = cut
            if merged is not None:
                merged["answers"] = answers
        phases["window"] += time.perf_counter() - mark
        return server._ok(rid, value)

    @staticmethod
    def windowed(messages, sid, window):
        """(rows, cut) for one open's ``window``; cut is None when the whole history goes.

        The caches hold these rows and their parsed results for later opens. Only the rows that
        leave are copied, after the window has cut a long chat down to them.
        """
        cut = None
        if isinstance(window, dict):
            messages, cut = history_window(messages, sid, window.get("start"), window.get("turns", 0), window.get("before"))
        return detached(messages), cut

    @contextlib.contextmanager
    def opening(self):
        """Counts an open from before it waits for its profile's lock until it ends; see live_work."""
        with self.opens_lock:
            self.opens += 1
        try:
            yield
        finally:
            with self.opens_lock:
                self.opens -= 1

    def open_canonical(self, profile):
        # A live, prepared canonical session needs no lock, so a send never waits behind a
        # history read. Submit rechecks ownership under the journal lock.
        sid = self.canonical.get(profile)
        if sid in self.server._sessions and sid in self.keepers:
            return sid
        # Counted before it waits for the lock, as open_bot counts, so a warm-up holding it steps aside.
        with self.opening(), self.profile_lock(profile):
            if self.canonical.get(profile) in self.server._sessions:
                return self.canonical[profile]
            response = self.open_bot("agent-interface-delivery", {"profile": profile})
        return None if "error" in response else response["result"]["session_id"]

    # History warm-up: after a restart, each recent assistant's first open finds its history projected.

    def warm_seams(self):
        """What the warm-up reads in Hermes that this Hermes lacks, by name; empty when it has everything."""
        missing = []
        try:
            from hermes_state import SessionDB
        except ImportError:
            SessionDB = None
            missing.append("hermes_state.SessionDB")
        if SessionDB is not None:
            try:
                arguments = inspect.signature(SessionDB).parameters
            except (TypeError, ValueError):
                arguments = {}
            if not {"db_path", "read_only"} <= set(arguments):
                missing.append("SessionDB(db_path, read_only)")
            for name in ("get_session_by_title", "get_compression_tip"):
                if not callable(getattr(SessionDB, name, None)):
                    missing.append("SessionDB." + name)
            try:
                parameters = inspect.signature(SessionDB.get_messages_as_conversation).parameters
            except (AttributeError, TypeError, ValueError):
                parameters = {}
            # Without compacted rows the read is not the history an open projects.
            if not {"include_ancestors", "include_row_ids", "include_compacted"} <= set(parameters):
                missing.append("SessionDB.get_messages_as_conversation(include_compacted)")
        try:
            from hermes_cli.profiles import get_profile_dir  # noqa: F401
        except ImportError:
            missing.append("hermes_cli.profiles.get_profile_dir")
        if not callable(getattr(self.server, "project_compaction_message_for_display", None)):
            missing.append("project_compaction_message_for_display")
        if redaction_state() is None:
            missing.append("agent.redact's registries")
        return missing

    def start_warmup(self, delay=WARM_DELAY):
        """Starts the warm-up thread, unless it is turned off or this Hermes lacks what it reads. Returns the thread."""
        log = logging.getLogger(__name__)
        if os.environ.get(WARM_SETTING, "").strip() == "0":
            log.info("History warm-up is off (%s=0)", WARM_SETTING)
            return None
        missing = self.warm_seams()
        if missing:
            log.warning("Hermes has no %s; chats open without warmed history after a restart", ", ".join(missing))
            return None
        thread = threading.Thread(target=self.warm_histories, args=(delay,), name="agent-interface-warmup", daemon=True)
        thread.start()
        return thread

    def warm_histories(self, delay=0):
        """Warms each target in turn until the projection budget is full. Logs no history, only counts and timings."""
        log = logging.getLogger(__name__)
        time.sleep(delay)
        started, warmed = time.perf_counter(), 0
        try:
            targets = self.warm_targets()
        except Exception as exc:
            # The type only: a message could quote a row.
            log.warning("History warm-up found no assistants: %s", type(exc).__name__)
            return
        for profile, store, stored, kwargs in targets:
            try:
                if not self.warm(profile, store, stored, kwargs):
                    break
            except Exception as exc:
                log.warning("History warm-up skipped %s: %s", profile, type(exc).__name__)
                continue
            warmed += 1
        log.info("History warm-up warmed %d of %d assistants in %.1f s", warmed, len(targets), time.perf_counter() - started)

    def warm_targets(self):
        """(profile, store, stored session, projection arguments) for the canonical chat of each assistant the app sent
        to most recently, most recent first, at most WARM_PROFILES, as an open's resume would project it.

        The stored session is the "Bot Chat" titled session's compression tip, which ``profiles.list`` names. The
        projection arguments are those of Hermes's resume and activation: the profile's home, None for the home the
        gateway runs in, as ``_profile_home`` gives it, and image URLs.
        """
        from hermes_state import SessionDB
        from hermes_cli.profiles import get_profile_dir
        with self.journal.lock:
            profiles = [row[0] for row in self.journal.db.execute(
                "SELECT profile FROM receipts GROUP BY profile ORDER BY MAX(created) DESC LIMIT ?", (WARM_PROFILES,))]
        launch = Path(getattr(self.server, "_hermes_home", None) or self.get_hermes_home()).resolve()
        targets = []
        for profile in profiles:
            try:
                home = Path(get_profile_dir(profile))
            except ValueError:
                continue
            store = home / "state.db"
            try:
                if not store.is_file() or store.stat().st_size == 0:
                    continue
                db = SessionDB(db_path=store, read_only=True)
                try:
                    row = db.get_session_by_title("Bot Chat")
                    if not row or row.get("archived"):
                        continue
                    stored = db.get_compression_tip(row["id"]) or row["id"]
                finally:
                    db.close()
            except Exception as exc:
                # One store that cannot be read leaves the others warmed. The type only: a message could quote a row.
                logging.getLogger(__name__).warning("History warm-up skipped %s: %s", profile, type(exc).__name__)
                continue
            kwargs = {"profile_home": None if home.resolve() == launch else home, "image_urls": True}
            targets.append((profile, store, stored, kwargs))
        return targets

    @staticmethod
    def warm_read(store, stored):
        """The canonical chat's display history as an open reads it: ancestors, row IDs and compacted rows."""
        from hermes_state import SessionDB
        db = SessionDB(db_path=store, read_only=True)
        try:
            return db.get_messages_as_conversation(stored, include_ancestors=True, include_row_ids=True, include_compacted=True)
        finally:
            db.close()

    def live_work(self):
        """Whether an open, an app read or send, or a native turn or its queued input is running or waiting."""
        with self.opens_lock:
            if self.opens:
                return True
        for lanes in (self.reads, self.sends):
            with lanes.lock:
                if lanes.queues:
                    return True
        with self.sends_in_flight_lock:
            if self.sends_in_flight:
                return True
        return any(isinstance(session, dict) and any(session.get(key) for key in BUSY_MARKS)
                   for session in self.server._sessions.copy().values())

    def warm(self, profile, store, stored, kwargs):
        """Projects one assistant's canonical history into the RowCache its first open adopts, then parses its journal
        tool records into the same cache.

        Runs only while nothing else does, step by step, under the profile's lock, the one every open takes, so an
        open never uses the same cache at once. Before each step, a piece or WARM_STEP tool rows or records, it sleeps, and when
        live work has arrived it lets go of the lock, keeping what it did, and starts over once the gateway is quiet:
        an open in the meantime adopts the cache and does only the rest. The history is read again only when the store
        changed. Returns False when the projection budget has no room left, True otherwise, including when an open made
        the chat live first, since that open's cache is its own.
        """
        display, project = self.projection_parts(kwargs)
        history = stamp = None
        while True:
            while self.live_work():
                time.sleep(WARM_POLL)
            if self.canonical.get(profile) in self.server._sessions:
                return True
            files = (file_stamp(store), file_stamp(store.with_name(store.name + "-wal")))
            if history is None or files != stamp:
                history, stamp = self.warm_read(store, stored), files
            lock = self.profile_lock(profile)
            if not lock.acquire(blocking=False):
                time.sleep(WARM_POLL)
                continue
            try:
                if self.canonical.get(profile) in self.server._sessions:
                    return True
                context = self.projection_context(kwargs)
                key = (profile, stored)
                with self.cache_lock:
                    rows = self.warm_caches.get(key)
                    if rows is None:
                        rows = self.warm_caches[key] = RowCache(stored, self.projection_budget)
                        # A weak reference: the memo must not keep its own cache alive once nobody holds it.
                        rows.projections.on_empty = functools.partial(self.drop_warm, key, weakref.ref(rows))
                room = self.projection_budget.room(rows.projections)

                def pause(full):
                    if full:
                        raise WarmupFull
                    time.sleep(WARM_PAUSE)
                    if self.live_work():
                        raise WarmupYield
                try:
                    _, tool_rows = rows.projections.project(history, project, display, context, pause=pause, limit=room, background=True)
                    self.warm_tool_results(tool_rows, rows, pause)
                    self.warm_tool_records(profile, stored, rows, pause)
                except WarmupYield:
                    continue
                except WarmupFull:
                    return False
                return not rows.projections.full
            finally:
                lock.release()

    def drop_warm(self, key, ref):
        """Forgets a warmed cache nobody adopted once the budget empties its memo, with its parsed rows and records."""
        rows = ref()
        with self.cache_lock:
            if rows is not None and self.warm_caches.get(key) is rows:
                del self.warm_caches[key]

    def warm_tool_results(self, tool_rows, rows, pause):
        """Parses each tool row's content into ``rows`` as an open's decoration does, WARM_STEP rows a step."""
        def known(row_id, content):
            return (rows.tool_results.get(row_id) or (None,))[0] == content
        todo = [(row_id, content) for _, row_id, content in tool_rows
                if isinstance(content, str) and type(row_id) is int and not known(row_id, content)]
        for start in range(0, len(todo), WARM_STEP):
            pause(False)
            for row_id, content in todo[start:start + WARM_STEP]:
                self.tool_result(content, row_id, rows)

    def warm_tool_records(self, profile, stored, rows, pause):
        """Parses the stored session's journal tool records into ``rows``, the newest last, a step at a time."""
        with self.journal.lock:
            ids = [row[0] for row in self.journal.db.execute(
                "SELECT id FROM tools WHERE profile=? AND stored_session=? ORDER BY id", (profile, stored))][-ROW_CACHE_LIMIT:]
        for start in range(0, len(ids), WARM_STEP):
            step = [record_id for record_id in ids[start:start + WARM_STEP] if record_id not in rows.tool_records]
            if step:
                pause(False)
                with self.journal.lock:
                    self.tool_records(step, rows)

    # Admission: one durable receipt per app request, before native execution.

    def admitted(self, rid, request_id, message=None, turn=None):
        # Save the complete response in the same transaction as its final
        # admission state. receipt() remains the mutable status projection.
        value = self.journal.receipt(request_id)
        value.update(app_run_id=value["runId"], admission="canonical")
        if message is not None:
            value["message"] = message
        if turn is not None:
            # A new task's turn, saved with the answer so a replay and the receipt lookup say the same: see admission_turn.
            value["turn"] = turn
        self.journal.db.execute("UPDATE receipts SET admission_response=? WHERE request_id=?", (json.dumps(value), request_id))
        self.journal.images_missing.pop(request_id, None)
        return self.server._ok(rid, value)

    def stage_images(self, sid, profile, attachments, staged):
        """Attach image attachments natively, recording in ``staged`` the one entry each of this request's calls added.

        Native image.attach appends one entry, the resolved path, and answers it as ``path``
        (``methods_prompt.py:1020-1023`` and ``:1351-1355`` at ed1afb0, ``:749-752`` and ``:1093-1097`` at b9cb268
        and d23cc6b). It takes no lock, so another client's attach can append beside it while it reads the image's
        header (``server.py:754-763`` at ed1afb0, ``:840-849`` at the others), and not every entry new since the call
        began is this request's. An error after the append answers 5027 with no path (``methods_prompt.py:1024-1025``
        at ed1afb0, ``:753-754`` at the others). Its entry is then known only for an absolute path without ``$`` or
        ``\\``: native appends that path with symlinks resolved (``hermes_cli/cli_terminal_input.py:86-137``). Native
        joins a relative path to ``TERMINAL_CWD``, which need not be this process's directory, and expands ``$`` and
        ``\\ ``, so such a path claims nothing and its image stays staged rather than removing an entry this request
        cannot prove its own. The app sends absolute upload paths.
        """
        sessions = self.server._sessions
        for attachment in attachments:
            if str(attachment.get("mime", "")).startswith("image/"):
                path = attachment["path"]
                prior = list(sessions[sid].get("attached_images", []))
                result = None
                try:
                    result = self.native("image.attach", {"session_id": sid, "profile": profile, "path": path})
                finally:
                    answered = result.get("path") if isinstance(result, dict) else None
                    # Native reads the path as str(path).strip() (methods_prompt.py:1005 at ed1afb0, :734 at the others).
                    raw = str(path or "").strip()
                    if isinstance(answered, str):
                        own = {answered}
                    elif os.path.isabs(raw) and "$" not in raw and "\\" not in raw:
                        own = {os.path.realpath(raw)}
                    else:
                        own = set()
                    added = list(sessions[sid].get("attached_images", []))
                    for image in prior:
                        if image in added:
                            added.remove(image)
                    # One entry at most: an identical path another client attached meanwhile is not told apart.
                    mine = next((image for image in reversed(added) if image in own), None)
                    if mine is None and isinstance(answered, str):
                        # Hermes answered the path it appended, so the entry was added even when a turn another client
                        # started took the list while native read the image's header. The check before the prompt
                        # finds it gone.
                        mine = answered
                    if mine is not None:
                        staged.append(mine)

    def unstage_images(self, sid, staged):
        """Remove this request's staged images from the live list, keeping every other entry.

        Native image.attach appends without a lock, so this never writes back a copy: it deletes each entry in place
        under ``history_lock``, which Hermes's own readers take to snapshot and clear the list (``prompt_turn.py:138-152``
        and ``session_auto_continue.py:413-420`` at ed1afb0, ``:134-143`` and ``:388-393`` at the others). An append
        lands at the end, so the index found in one copy of the list still names the same entry when it is deleted.
        """
        session = self.server._sessions.get(sid)
        if session is None or not staged:
            return
        with session["history_lock"]:
            images = session.get("attached_images", [])
            for image in reversed(staged):
                snapshot = images[:]
                if image in snapshot:
                    del images[len(snapshot) - 1 - snapshot[::-1].index(image)]

    def turn_request(self, sid, request_id, text, images=()):
        """A request ID of its own for the prompt.submit that carries this receipt's prompt.

        Registered before Hermes is called: the turn can start before the call returns. ``images`` are the photos
        staged for it, which its turn finds still staged as it starts.
        """
        native_rid = "agent-interface-submit:" + uuid.uuid4().hex
        with self.turn_requests_lock:
            self.turn_requests[native_rid] = (sid, request_id, text, tuple(images))
        return native_rid

    def turn_started(self, sid, native_rid, streaming):
        """Hermes answered prompt.submit. Only a started turn can still claim the ID.

        Any other answer, a refusal, a queue, a redirect, starts no turn with this ID. Once a turn
        starts, the session's earlier unclaimed IDs are dropped so the table stays small: Hermes
        admits one turn at a time, so their turns either ran or failed to start. Dropping an ID
        can only leave a receipt unbound, never bind one. Called under submission_lock.
        """
        with self.turn_requests_lock:
            if not streaming:
                self.turn_requests.pop(native_rid, None)
                return
            for key in [key for key, sent in self.turn_requests.items() if sent[0] == sid and key != native_rid]:
                del self.turn_requests[key]

    def submit(self, rid, params, phases=None):
        """Admit one app message durably, as a new task or as steering into the running one.

        An app send arrives on its assistant's send lane, so that assistant's sends come one at a
        time; goal continuation calls this directly, already holding submission_lock. ``phases``,
        when given, gathers the seconds each step took for the answer's ``app_timing``, and gains
        ``fresh`` when this call made the admission decision rather than replaying one.
        """
        server, journal = self.server, self.journal
        phases = {} if phases is None else phases
        request_id = params.get("request_id")
        actor = params.get("sender_id")
        profile = params.get("profile", "default")
        text = params.get("text", "")
        sid = params.get("session_id")
        attachments = params.get("attachments") or []
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 200 or not isinstance(actor, str) or not actor or not isinstance(text, str) or (not text.strip() and not attachments):
            return server._err(rid, -32602, "request_id, sender_id and non-empty text required")
        digest = hashlib.sha256(json.dumps([profile, actor, text, attachments], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        # A replay or a conflicting reuse stops no compaction and needs no canonical session. Only
        # this skip rests on the read: submission_lock still decides who owns the request ID.
        mark = time.perf_counter()
        with journal.lock:
            known = journal.db.execute("SELECT 1 FROM receipts WHERE request_id=?", (request_id,)).fetchone() is not None
        phases["journal"] = phases.get("journal", 0.0) + time.perf_counter() - mark
        mark = time.perf_counter()
        if sid is None and not known:
            sid = self.open_canonical(profile)
        phases["open"] = phases.get("open", 0.0) + time.perf_counter() - mark
        preempting = sid is not None and not known
        # While held, no background compaction of this session can start, so the wait for one to
        # stop happens before the lock every admission takes, and holds up no other assistant.
        with self.compaction.admitting(sid) if preempting else contextlib.nullcontext():
            mark = time.perf_counter()
            preempted = preempting and self.compaction.preempt(sid)
            waited = time.perf_counter() - mark
            phases["preempt"] = phases.get("preempt", 0.0) + waited
            if preempted:
                logging.getLogger(__name__).info("A send waited %.0f ms for profile %s's background compaction to stop", waited * 1000, profile)
            mark = time.perf_counter()
            with self.submission_lock:
                phases["wait"] = phases.get("wait", 0.0) + time.perf_counter() - mark
                if preempting:
                    # Nothing can have started since, so this returns at once. A compaction the first
                    # call left running at its bound gets only what remains of that bound.
                    mark = time.perf_counter()
                    preempted = self.compaction.preempt(sid, wait=max(0.0, sibling_module("compaction").PREEMPT_WAIT - waited)) or preempted
                    phases["preempt"] += time.perf_counter() - mark
                return self.admit(rid, params, sid, digest, preempted, phases)

    def admit(self, rid, params, sid, digest, preempted, phases):
        """The admission decision and its native call. Callers hold submission_lock.

        journal.lock covers each journal transaction and nothing else, so tool frames, opens,
        receipt lookups and the turn's own start never wait for Hermes's admission call or for
        image staging. Every receipt is written under submission_lock, so the request ID's owner
        and digest are settled once the first transaction below has read them.
        """
        server, journal = self.server, self.journal
        request_id, actor, text = params.get("request_id"), params.get("sender_id"), params.get("text", "")
        profile = params.get("profile", "default")
        attachments = params.get("attachments") or []
        def timed(phase, mark):
            phases[phase] = phases.get(phase, 0.0) + time.perf_counter() - mark
        mark = time.perf_counter()
        with journal.lock:
            # Replays need neither fresh canonical activation nor interruption review. A request
            # without a receipt at submit's early read had its canonical session opened then.
            previous = journal.db.execute("SELECT digest FROM receipts WHERE request_id=?", (request_id,)).fetchone()
            if previous:
                timed("journal", mark)
                if previous[0] != digest:
                    return server._err(rid, 4093, "Request ID already belongs to a different input")
                return server._ok(rid, journal.admission_response(request_id))
            phases["fresh"] = True
            if sid is None or self.canonical.get(profile) != sid:
                timed("journal", mark)
                return server._err(rid, -32602, "Open this profile's canonical conversation before admission")
            state = journal.submission_state(profile, sid, server._sessions[sid])
            stored, running, current, interrupted = (state[key] for key in ("stored", "running", "current", "interrupted"))
            if params.get("require_idle") is True and running:
                timed("journal", mark)
                return server._err(rid, 4091, "This assistant started another turn before goal continuation admission")
            if interrupted and params.get("reviewed_interruption") is not True:
                timed("journal", mark)
                return server._err(rid, 4094, "Review the interrupted task before starting another turn")
            rejected = (request_id, digest, profile, sid, stored, actor, journal.epoch, request_id, text, json.dumps(attachments), False, "rejected", 1, time.time())
            if current and not server._sessions[sid].get("running"):
                # Native releases running before draining its followup queue. No new root
                # may be admitted in that interval or retired with the preceding task.
                with journal.db:
                    journal.db.execute(INSERT_REJECTED, rejected)
                    response = self.admitted(rid, request_id, "Hermes is finishing the preceding task. Your input was not admitted; send it again after the task settles.")
                timed("journal", mark)
                return response
            steering = bool(params.get("steer")) or bool(server._sessions.get(sid, {}).get("running"))
            if preempted and not current:
                # No app task was open, so nothing can be steered: the compaction this input
                # just stopped was the only work. Hermes queues it if a native turn started meanwhile.
                steering = False
            if steering and any(str(x.get("mime", "")).startswith("image/") for x in attachments):
                with journal.db:
                    journal.db.execute(INSERT_REJECTED, rejected)
                    response = self.admitted(rid, request_id, "Images cannot be added while Hermes is working. Keep this draft and send it after the task settles.")
                timed("journal", mark)
                return response
            run_id = current[0] if steering and current else request_id
            # FULL-synchronous intent is durable before native execution may be admitted, and
            # committed before any frame of its turn can look for it.
            with journal.db:
                journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (request_id, digest, profile, sid, stored, actor, journal.epoch, run_id, text, json.dumps(attachments), steering, "uncertain", time.time()))
            self.admitting.add(request_id)
        timed("journal", mark)
        try:
            return self.admit_native(rid, params, sid, steering, interrupted, stored, phases)
        finally:
            with journal.lock:
                self.admitting.discard(request_id)

    def admit_native(self, rid, params, sid, steering, interrupted, stored, phases):
        """Image staging and Hermes's admission call for an intent admit just wrote, and the answer.

        Each final journal transaction also ends the admission for readers, so an open sees the
        intent hidden or the answered receipt, never a receipt Hermes answered still hidden.
        """
        journal = self.journal
        request_id, actor, text = params.get("request_id"), params.get("sender_id"), params.get("text", "")
        profile = params.get("profile", "default")
        attachments = params.get("attachments") or []
        def timed(phase, mark):
            phases[phase] = phases.get(phase, 0.0) + time.perf_counter() - mark
        staged = []
        mark = time.perf_counter()
        try:
            if not steering:
                self.stage_images(sid, profile, attachments, staged)
        except Exception as exc:
            # No prompt invocation occurred, so this receipt is definitely rejected.
            self.unstage_images(sid, staged)
            timed("staging", mark)
            mark = time.perf_counter()
            with journal.lock, journal.db:
                journal.db.execute("UPDATE receipts SET status='rejected',terminal=1 WHERE request_id=?", (request_id,))
                response = self.admitted(rid, request_id, "Image preparation failed before admission: " + str(exc)[:400])
                self.admitting.discard(request_id)
            timed("journal", mark)
            return response
        timed("staging", mark)
        native_rid = self.turn_request(sid, request_id, text, staged) if not steering else "extension-native"
        # Nothing but Hermes's own call follows this check. A photo gone from the session's list since it was attached
        # went to a turn another client started in between, and the prompt would run, or queue, without it.
        session = self.server._sessions.get(sid)
        gone = self.photos_gone(session, staged) if staged and session is not None else []
        if gone:
            mark = time.perf_counter()
            self.turn_started(sid, native_rid, False)
            self.unstage_images(sid, staged)
            logging.getLogger(__name__).warning("A send's photos were taken before its prompt was sent: %d of %d", len(gone), len(staged))
            with journal.lock, journal.db:
                journal.db.execute("UPDATE receipts SET status='rejected',terminal=1 WHERE request_id=?", (request_id,))
                response = self.admitted(rid, request_id, "Another task took your photo before this message was sent. Nothing was sent. Keep this draft and send it again.")
                # In the same transaction as the refusal, so a reader never sees it settled and still admitting;
                # admit's finally discards it too, later and outside the lock.
                self.admitting.discard(request_id)
            timed("journal", mark)
            return response
        mark = time.perf_counter()
        try:
            method = "session.steer" if steering else "prompt.submit"
            native = {"session_id": sid, "profile": profile, "text": text}
            # A spoken Talk turn runs on Hermes's auxiliary.voice_chat route. A steer joins a
            # running turn, whose route is already bound, so it carries no voice mark.
            if params.get("voice_turn") is True and not steering:
                native["voice_turn"] = True
            result = self.native(method, native, native_rid)
        except Exception as exc:
            timed("native", mark)
            mark = time.perf_counter()
            # Known native admission refusals happen before invoking or queueing a turn.
            # Crashes and unrecognized errors may follow side effects, so stay uncertain.
            if isinstance(exc, NativeResponseError) and exc.refused_admission:
                self.turn_started(sid, native_rid, False)
                self.unstage_images(sid, staged)
                logging.getLogger(__name__).warning("Native message admission refused with code %s", exc.code)
                with journal.lock, journal.db:
                    journal.db.execute("UPDATE receipts SET status='rejected',terminal=1 WHERE request_id=?", (request_id,))
                    response = self.admitted(rid, request_id, exc.refusal_message)
                    self.admitting.discard(request_id)
            else:
                with journal.lock, journal.db:
                    response = self.admitted(rid, request_id, str(exc)[:500])
                    self.admitting.discard(request_id)
            timed("journal", mark)
            return response
        timed("native", mark)
        mark = time.perf_counter()
        status = "rejected" if result.get("status") == "rejected" else "accepted"
        # Steering already joins the running task, and native session.steer answers "queued" when it
        # accepts, so only a new task's answer says whether its turn started. A refusal has no turn.
        turn = None if steering or status == "rejected" else admission_turn(result)
        # A typed stop admitted nothing, so nothing will settle its receipt: it is settled now, and
        # never holds up the next send as a task Hermes is finishing.
        settled = steering or status == "rejected" or turn == "none"
        if turn == "none":
            # Hermes answers a typed stop before it reads the session, so this request's images stay staged and the
            # next turn would take them (methods_prompt.py:835-836 at ed1afb0, :580 at b9cb268 and d23cc6b). An
            # unknown answer keeps them: a turn Hermes started takes them on its own thread after it answers.
            self.unstage_images(sid, staged)
        if staged and turn in ("queued", "joined") and (unsent := self.photos_not_sent(sid, staged, turn, text)):
            # A turn that was running when the prompt arrived: the photos did not go with it. Said in the receipt below.
            logging.getLogger(__name__).warning("A send Hermes answered %s went without %d of its %d photos", result.get("status"), len(unsent), len(staged))
            journal.note_images_missing(request_id, len(unsent))
        if not steering:
            self.turn_started(sid, native_rid, result.get("status") == "streaming")
        with journal.lock, journal.db:
            journal.db.execute("UPDATE receipts SET status=?,row_id=COALESCE(?,row_id),terminal=CASE WHEN ? THEN 1 ELSE terminal END WHERE request_id=?", (status, result.get("user_row_id"), settled, request_id))
            if interrupted and status == "accepted" and turn != "none":
                journal.db.execute("DELETE FROM interruptions WHERE profile=? AND stored_session=?", (profile, stored))
            if steering and status == "accepted":
                self.steered.value = (profile, sid, actor, text)
            if turn == "joined" and status == "accepted" and self.server._sessions.get(sid, {}).get("running"):
                # The turn it joined is the one running now; one that ended already has no completion to wait for.
                with self.joined_lock:
                    self.joined.setdefault(sid, []).append(request_id)
            response = self.admitted(rid, request_id, "Hermes ended its voice chat. Nothing was sent to the assistant." if turn == "none" else None, turn=turn)
            self.admitting.discard(request_id)
        timed("journal", mark)
        return response

    def submit_from_app(self, rid, params):
        """An app message. Once it is durably admitted as steering, the asks it answers instead close.

        A blocked tool returns only when its ask settles, and native steering drains after that
        tool returns, so the message would otherwise wait behind the ask. This runs after every
        lock is released: closing wakes the waiting tool thread, which may need them.

        A fresh admission's answer reports ``app_timing`` in milliseconds, as an open does: the
        canonical open, the wait for a background compaction to stop, the wait for other
        admissions, journal statements, image staging, Hermes's admission call and the whole call.
        A replay answers what was saved, without timings.
        """
        started = time.perf_counter()
        phases = dict.fromkeys(SUBMIT_PHASES, 0.0)
        self.steered.value = None
        try:
            response = self.submit(rid, params, phases)
        finally:
            steered, self.steered.value = self.steered.value, None
            hook = getattr(self.journal, "steering_admitted", None)
            if steered and hook:
                try:
                    hook(*steered)
                except Exception:
                    logging.getLogger(__name__).exception("Could not close the asks a steering message answered")
        if phases.pop("fresh", False) and isinstance(response.get("result"), dict):
            phases["total"] = time.perf_counter() - started
            response["result"]["app_timing"] = {name: round(seconds * 1000, 1) for name, seconds in phases.items()}
        return response

    def receipt(self, rid, params):
        with self.journal.lock:
            return self.server._ok(rid, {"receipt": self.journal.receipt(params.get("request_id", ""))})

    # Discovery: app-visible events, including routine runs outside this gateway.

    def scan_routines(self, full):
        # Runs outside this gateway still have an official durable execution ledger.
        # Discover its actual terminal attempts, with explicit routine identities.
        from hermes_cli.web_routers.cron import _owner_home_scope, _list_cron_jobs_sync
        from cron.executions import list_executions
        # Upstream supports only before_claimed_at (backwards pagination), not a
        # since filter. Observe the execution DB and WAL, not job metadata: a
        # terminal ledger write can arrive later or without a job-row change.
        with self.discovery_lock:
            now = time.monotonic()
            present = set()
            for profile in self.native("profiles.list", {"include_sessions": False})["profiles"]:
                name = profile["name"]
                present.add(name)
                with _owner_home_scope(name):
                    from cron import executions
                    ledger = executions.EXECUTIONS_FILE or Path(self.get_hermes_home()).resolve() / "cron" / "executions.db"
                    def stamp(path):
                        try:
                            info = path.stat()
                            return (info.st_size, info.st_mtime_ns, info.st_ino)
                        except FileNotFoundError:
                            return None
                    signature = tuple(stamp(path) for path in (ledger, ledger.with_name(ledger.name + "-wal")))
                    previous = self.routine_scans.get(name)
                    if not full and previous and previous[0] == signature and now - previous[1] < 60:
                        continue
                    for job in _list_cron_jobs_sync(name):
                        job_id = job.get("id") or job["job_id"]
                        ledger_rows = list_executions(job_id=job_id, limit=100)
                        for execution in ledger_rows:
                            status = execution.get("status")
                            if status not in ("completed", "failed", "unknown"):
                                continue
                            execution_id = str(execution.get("execution_id") or execution.get("id") or execution.get("claimed_at"))
                            run_id = f"routine:{name}:{job_id}:{execution_id}"
                            kind = "completed" if status == "completed" else "failed" if status == "failed" else "interrupted"
                            event_key = f"{run_id}:{status}"
                            # Each run is read once, when it is first seen, for its notification preview.
                            if self.journal.has_event(event_key):
                                continue
                            body = routine_run_body(self.get_hermes_home(), job_id, execution, ledger_rows)
                            self.journal.event(name, str(execution.get("session_id") or ""), kind, job.get("name") or "Routine result", run_id, body=body, event_key=event_key, routine_id=job_id)
                        # Record only after the scan succeeds, so failed reads retry next tick.
                    self.routine_scans[name] = (signature, now)
            for key in list(self.routine_scans):
                if key not in present:
                    del self.routine_scans[key]

    def discover(self, rid, params):
        server = self.server
        try:
            cursor = int(params.get("cursor") or 0)
        except (ValueError, TypeError):
            return server._err(rid, -32602, "Invalid discovery cursor")
        self.scan_routines(params.get("full") is True)
        with self.journal.lock:
            rows = self.journal.db.execute("SELECT id,profile,session_id,run_id,kind,title,body,occurred,routine_id,event_key FROM events WHERE id>? ORDER BY id LIMIT 250", (cursor,)).fetchall()
        ready = []
        for row in rows:
            if row[4] == "completed" and server._sessions.get(row[2], {}).get("running") and not self.compaction.owns(row[2]):
                # A turn boundary can precede queued guidance/goal continuation.
                break
            ready.append(row)
        events = [{"id": str(r[0]), "botId": r[1], "sessionId": r[2], "requestId": r[3], "runId": r[3], "routineId": r[8], "kind": r[4], "title": r[5], "body": r[6], "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r[7])),
                   **({"approvalId": approval_id(r)} if approval_id(r) else {})} for r in ready]
        return server._ok(rid, {"cursor": str(ready[-1][0] if ready else cursor), "events": events})

    def rpc_methods(self):
        """The agent-interface RPCs that read or admit app work, by registered name."""
        methods = {"open": self.open_bot, "submit": self.submit_from_app, "receipt": self.receipt, "discover": self.discover}
        if self.delegation.installed:
            methods["delegation"] = self.delegation.rpc(self.server)
        methods["routine_deliveries"] = self.delegation.deliveries_rpc(self.server)
        return {"agent-interface." + name: handler for name, handler in methods.items()}

    # Bot Chat delivery: routines and bot messages arrive as canonical chat turns.

    @contextlib.contextmanager
    def delivery_admission(self, sid):
        # Same order as submit: no delivery starts beside an unsettled app task or maintenance.
        with self.submission_lock:
            self.compaction.preempt(sid)
            with self.maintenance_lock:
                closed = bool(self.maintenance_state())
            with self.journal.lock:
                unsettled = self.journal.db.execute("SELECT 1 FROM receipts WHERE session_id=? AND terminal=0 LIMIT 1", (sid,)).fetchone()
            yield not closed and unsettled is None

    def install_delivery(self):
        # A Hermes whose native delivery only reaches the gateway authority gets the
        # add-on producer. The consumer always runs: after a rollback it still owes
        # queued add-on receipts.
        import tools.bot_live_delivery as mailbox
        bot_delivery = sibling_module("bot_delivery")
        native_records = bot_delivery.bridge_required(mailbox, self.server)
        if native_records:
            bot_delivery.install_producer(mailbox)
        from tools.bot_failure_reasons import classify_agent_error
        self.journal.bot_delivery = bot_delivery.Consumer(self.server, mailbox, bot_delivery.profile_homes(self.get_hermes_home()),
                                                          self.open_canonical, self.delivery_admission, classify=classify_agent_error,
                                                          native_records=native_records)
        self.journal.bot_delivery.start()

    def install_automation(self):
        sibling_module("automation").install_runtime(self.server, self.native, self.open_bot, self.submission_lock,
                                                     self.maintenance_lock, self.maintenance_state, self.journal, self.submit,
                                                     preempt=self.compaction.preempt)

def install(path=None):
    actual_revision, patch_hash = source_state()
    from tui_gateway import server
    from hermes_constants import get_hermes_home, profile_name_for_home
    computer = sibling_module("computer")
    computer.install(server)
    journal = Journal(path or Path(get_hermes_home()) / "runtime" / "agent-interface.db")
    computer.bind_journal(journal)
    sibling_module("integrations").install_requests(server, journal)
    bridge = Bridge(server, journal, get_hermes_home=get_hermes_home, profile_name_for_home=profile_name_for_home,
                    maintenance_file=os.environ.get("HERMES_AGENT_INTERFACE_MAINTENANCE_FILE"))
    from hermes_cli.backend_retirement import retirement
    bridge.install_maintenance(retirement)
    bridge.install_native_seams()
    # A Hermes without message_agent gets no roster or gate, and says so.
    delegation = bridge.delegation.install()
    from agent.skill_utils import ESSENTIAL_SKILLS
    server.register_method("agent-interface.capabilities", lambda rid, _: server._ok(rid, {"revision": actual_revision, "tracked_patch_sha256": patch_hash, "executor_epoch": journal.epoch, "durable_admission": True, "durable_events": True, "canonical_open": True, "explicit_credentials": True, "canonical_submit": True, "incremental_discovery": True, "delegation": delegation, "delegation_version": sibling_module("delegation").PROTOCOL if delegation else 0, "essential_skills": sorted(ESSENTIAL_SKILLS), "steering_decision": True, "admission_turn": True, "approval_settings": True, "maintenance_deadline": True, "idle_compaction_seconds": bridge.compaction.delay}))
    for name, handler in bridge.rpc_methods().items():
        server.register_method(name, handler)
    bridge.install_delivery()
    bridge.install_automation()
    if bridge.compaction.enabled:
        bridge.compaction.start()
    bridge.start_warmup()
    return journal

if __name__ == "__main__":
    import hermes_cli.web_server as web
    from tui_gateway import server
    source_state()
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=19119)
    args = parser.parse_args()
    journal = install()
    sibling_module("experience").install(web, journal, server._history_to_messages)
    sibling_module("automation").install(web, journal)
    sibling_module("vault").install(web, journal)
    sibling_module("integrations").install(web)
    sibling_module("mac").register()
    sibling_module("service_auth").install_service_auth(web, os.environ["HERMES_AGENT_INTERFACE_TOKEN"])
    web.start_server(host="127.0.0.1", port=args.port, open_browser=False, headless=True, isolated=True)
