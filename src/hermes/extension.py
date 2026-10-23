"""Revision-bound Hermes gateway add-on, without changes to core execution or state.db.

Launch from the tested Hermes environment with HERMES_HOME set by its supervisor:
python src/hermes/extension.py --port 19119
See docs/HermesCapabilityMatrix.md. Journal contains private runtime data, never commit it.
"""
import argparse
import contextvars
import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
import contextlib
import re
import mimetypes
import subprocess
import importlib.util
import hmac
import sys
from pathlib import Path

REVISION = "b9cb268deffc97946ec11645aa622a7353dd0591"
QUALIFIED_REVISIONS = {REVISION, "d23cc6b06455b8551fb6f61d3cad040a0e82f5b6"}
QUALIFIED_OAUTH_PATCH = "2b8335c692f100640e375ffd338f26f6d86195a4ff91c2000e3306bcea9d671c"


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


class Journal:
    def __init__(self, path):
        self.epoch = uuid.uuid4().hex
        self.lock = threading.RLock()
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
        for column in ("stored_session", "attachments", "admission_response"):
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
        self.db.execute("CREATE INDEX IF NOT EXISTS events_run ON events(run_id)")
        with self.db:
            for request_id, profile, sid, stored in self.db.execute("SELECT COALESCE(run_id,request_id),profile,session_id,stored_session FROM receipts WHERE terminal=0 AND status IN ('accepted','uncertain')").fetchall():
                self.event(profile, sid, "interrupted", "Hermes restarted. Review before retrying.", request_id, event_key=f"{request_id}:interrupted")
                if stored:
                    self.db.execute("INSERT OR REPLACE INTO interruptions(profile,stored_session,request_id,created) VALUES(?,?,?,?)", (profile, stored, request_id, time.time()))
            self.db.execute("UPDATE receipts SET status='interrupted',terminal=1 WHERE terminal=0 AND status IN ('accepted','uncertain')")

    @property
    def mutation(self):
        # SQLite counts every row mutation, including cursor/executemany writes in sibling
        # add-ons. A rollback may invalidate unnecessarily, but can never reuse stale rows.
        return getattr(self.db, "total_changes", None)

    def event(self, profile, sid, kind, title, run_id=None, body=None, event_key=None, routine_id=None):
        with self.lock, self.db:
            self.db.execute("INSERT OR IGNORE INTO events(profile,session_id,run_id,kind,title,body,occurred,epoch,event_key,routine_id) VALUES(?,?,?,?,?,?,?,?,?,?)", (profile, sid, run_id, kind, title, body, time.time(), self.epoch, event_key, routine_id))

    def receipt(self, request_id):
        row = self.db.execute("SELECT status,COALESCE(run_id,request_id),row_id,actor FROM receipts WHERE request_id=?", (request_id,)).fetchone()
        return None if row is None else {"requestId": request_id, "status": row[0], "runId": row[1], "userRowId": row[2], "senderId": row[3]}

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


def history_window(messages, sid, start=None, turns=0):
    """The app's history window, cut here so earlier rows never cross the socket.

    Mirrors historyWindow in src/shared/history.ts over the rows the app shows, with the
    app's own message IDs. Returns (rows, window). Rows before the window are kept only
    when the app still needs them: those carrying files, for its earlier-file count, and
    the prompt each such reply answers, for its origin. Each returned row carries its
    position among visible rows, so positional IDs stay the same. ``window`` is None,
    and every row is returned, when nothing is cut or the cut would start mid-turn.
    """
    visible = [row for row in messages if row.get("display_kind") != "hidden"]
    def identity(index):
        row = visible[index]
        for key in ("app_request_id", "row_id"):
            if row.get(key) is not None:
                return str(row[key])
        return f"{sid}-{index}"
    turns = turns if type(turns) is int and turns >= 0 else 0
    end = next((index for index in range(len(visible)) if identity(index) == start), -1) if isinstance(start, str) and start else -1
    if end < 0:
        end, turns = len(visible), max(turns, PAGE_TURNS)
    first = end
    while first > 0 and turns > 0:
        first -= 1
        if visible[first].get("role") == "user":
            turns -= 1
    if first == 0 or visible[first].get("role") != "user":
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
    rows = [dict(visible[index], app_index=index) for index in sorted(kept) + list(range(first, len(visible)))]
    return rows, {"earlier": first, "context": len(kept)}


def event_body(value):
    """A bounded, single-line excerpt for event bodies; the app shortens it further for display."""
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    text = " ".join(value.split())
    return text[:500] or None


class Keeper:
    """Holds a canonical session's transport open between app requests."""
    closed = False

    def write(self, _frame):
        return True

    def close(self):
        self.closed = True


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


def approval_id(row):
    # The approval's native request ID, which its event identity ends with, lets a notification decide it.
    prefix = f"{row[3]}:approval:"
    return row[9][len(prefix):] if row[4] == "approval" and row[3] and isinstance(row[9], str) and row[9].startswith(prefix) and len(row[9]) > len(prefix) else None


# The run a session's newest unsettled receipt belongs to.
OPEN_RUN = "SELECT COALESCE(run_id,request_id) FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created DESC LIMIT 1"
LATEST_TERMINAL = "SELECT kind FROM events WHERE profile=? AND session_id=? AND kind IN ('completed','failed','interrupted') ORDER BY id DESC LIMIT 1"
LATEST_ROOT = "SELECT COALESCE(run_id,request_id) FROM receipts WHERE profile=? AND stored_session=? AND steering=0 ORDER BY created DESC LIMIT 1"
RUN_TERMINAL = "SELECT kind FROM events WHERE run_id=? AND kind IN ('completed','failed','interrupted') ORDER BY id DESC LIMIT 1"
INSERT_REJECTED = "INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,terminal,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"


# Methods a held maintenance lease still admits: status, history and discovery reads.
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
        self.canonical_lock = threading.RLock()
        self.submission_lock = threading.RLock()
        self.maintenance_lock = threading.RLock()
        self.maintenance_read = contextvars.ContextVar("agent_interface_maintenance_read", default=False)
        self.keepers = {}
        self.canonical = {}
        self.decorated = {}
        self.settlement = {}
        self.discovery_lock = threading.RLock()
        self.routine_scans = {}
        journal.canonical_session = self.canonical.get
        journal.profile_for_session = self.profile_for
        journal.live_profile_for_session = self.live_profile_for

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

    def busy_sessions(self):
        # Native workers can reserve admission while holding _sessions_lock.
        # Snapshot the dictionary without taking that lock in the reverse order;
        # native reservations cover work queued after this snapshot.
        sessions = self.server._sessions.copy()
        return [{"sessionId": sid, "profile": self.profile_for(sid), "state": "running"}
                for sid, session in sessions.items()
                if session.get("running") or session.get("queued_prompt") or session.get("queued_prompts")
                or session.get("pending_steer") or session.get("_auto_continue_scheduled")]

    def maintenance(self, rid, params):
        server = self.server
        secret = os.environ.get("HERMES_AGENT_INTERFACE_TOKEN", "")
        supplied = params.get("service_key", "")
        if not secret or not isinstance(supplied, str) or not hmac.compare_digest(supplied, secret):
            return server._err(rid, 403, "Private maintenance authentication required")
        if not self.maintenance_file:
            return server._err(rid, 409, "Host maintenance lease is not configured")
        with self.maintenance_lock:
            lease = self.maintenance_state()
            action = params.get("action", "status")
            operation = params.get("operation_id")
            if action not in ("status", "acquire", "release"):
                return server._err(rid, 400, "Unknown maintenance action")
            if action != "status" and (not isinstance(operation, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", operation)):
                return server._err(rid, 400, "Invalid maintenance operation")
            if lease and lease.get("operationId") != operation and action != "status":
                return server._err(rid, 409, "Another maintenance operation owns this lease")
            busy = self.busy_sessions()
            if action == "acquire":
                # This request holds one native reservation. Queued RPCs and
                # deferred work reserve before execution and must also be idle.
                if busy or self.retirement.active_count() > 1:
                    return server._err(rid, 409, "Hermes still has active work; no maintenance lease acquired")
                path = Path(self.maintenance_file)
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                private_fs.atomic_json(path, {"operationId": operation})
                lease = {"operationId": operation}
            elif action == "release" and lease:
                Path(self.maintenance_file).unlink()
                lease = None
            return server._ok(rid, {"active": lease is not None, "operationId": (lease or {}).get("operationId"), "busy": busy})

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
        server.dispatch = lambda request, *args, **kwargs: self.guarded_call(original_dispatch, request, *args, **kwargs)
        server.register_method("agent-interface.maintenance", self.maintenance)


    # Native seams: tool detail, inline guidance, frames and turn settlement.

    def native(self, method, params):
        response = self.server.handle_request({"jsonrpc": "2.0", "id": "extension-native", "method": method, "params": params})
        if "error" in response:
            raise RuntimeError(json.dumps(response["error"]))
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
        messages = self.native_history(history, **kwargs)
        tool_rows = {}
        for row in history:
            if not isinstance(row, dict) or row.get("role") != "tool":
                continue
            # Native compaction and hidden scaffolding must stay hidden. A model
            # can reuse a call ID later, so identity also includes native time.
            visible = self.native_history([row], **kwargs)
            projected = self.server.project_compaction_message_for_display(row)
            if not visible or not isinstance(projected, dict):
                continue
            key = (visible[0].get("tool_call_id"), visible[0].get("timestamp"))
            tool_rows.setdefault(key, []).append(projected)
        for message in messages:
            if message.get("role") != "tool":
                continue
            matches = tool_rows.get((message.get("tool_call_id"), message.get("timestamp"))) or []
            if not matches:
                continue
            raw = matches.pop(0)
            if raw.get("_row_id") is not None:
                message["row_id"] = raw["_row_id"]
            result = raw.get("content")
            if result is not None:
                try:
                    result = json.loads(result) if isinstance(result, str) else result
                except (json.JSONDecodeError, TypeError):
                    pass
                message["app_tool_result"] = result
        return messages

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

    def with_inline_guidance(self, original, eligible, agent, *args, **kwargs):
        if not eligible or agent is None:
            return original(*args, **kwargs)
        prior = getattr(agent, "ephemeral_system_prompt", None)
        if self.inline_instructions not in (prior or ""):
            agent.ephemeral_system_prompt = "\n\n".join(part for part in (prior, self.inline_instructions) if part)
        try:
            return original(*args, **kwargs)
        finally:
            agent.ephemeral_system_prompt = prior

    def install_inline_guidance(self):
        # Add client rendering guidance at model-call time, without changing SOUL,
        # persisted user text, receipt digests, image recovery, or steering matches.
        server = self.server
        self.inline_instructions = json.loads((Path(__file__).resolve().parents[1] / "shared" / "inline-ui-instructions.json").read_text())
        # Newer Hermes splits the invocation from turn setup and model changes.
        # Older qualified revisions enter with an already-built session agent.
        if hasattr(server, "_invoke_agent"):
            original_invoke = server._invoke_agent
            def invoke(sid, session, turn, *args, **kwargs):
                text = kwargs.get("text", args[7] if len(args) > 7 else None)
                display_kind = kwargs.get("display_kind", args[4] if len(args) > 4 else None)
                author = kwargs.get("turn_author", args[6] if len(args) > 6 else None)
                return self.with_inline_guidance(original_invoke, self.app_prompt(sid, text, display_kind, author), turn.agent, sid, session, turn, *args, **kwargs)
            server._invoke_agent = invoke
        else:
            original_run = server._run_prompt_submit
            def run(rid, sid, session, *args, **kwargs):
                text = kwargs.get("text", args[0] if args else None)
                eligible = not str(rid).startswith("__") and self.app_prompt(sid, text, kwargs.get("display_kind"), kwargs.get("turn_author"))
                return self.with_inline_guidance(original_run, eligible, session.get("agent"), rid, sid, session, *args, **kwargs)
            server._run_prompt_submit = run

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
        if sid and kind == "message.complete" and type((payload.get("persisted_turn") or {}).get("user_row_id")) is int:
            # Image-only admission has no staged row. Native completion provides its
            # actual committed row identity, without any textual inference.
            with journal.lock, journal.db:
                pending = journal.db.execute("SELECT request_id FROM receipts WHERE session_id=? AND terminal=0 AND steering=0 AND row_id IS NULL ORDER BY created LIMIT 1", (sid,)).fetchone()
                if pending:
                    journal.db.execute("UPDATE receipts SET row_id=? WHERE request_id=?", (payload["persisted_turn"]["user_row_id"], pending[0]))
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
        self.install_inline_guidance()
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
        def stamp(path):
            try:
                info = path.stat()
                return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns, info.st_size)
            except FileNotFoundError:
                return None
        # Like the native change watcher, observe both DB and WAL: another native
        # connection can commit a display lineage without changing the warm history.
        # File replacement, checkpoint and profile commentary configuration invalidate too.
        return memory, tuple(stamp(path) for path in (db_path, db_path.with_name(db_path.name + "-wal"), home / "config.yaml"))

    def activate(self, profile, omit, skip_cache):
        """Activate or resume the profile's canonical session; None for an unknown profile.

        Returns (value, cached, identity, mutation). ``cached`` is decorated history this
        poll may reuse, already placed in ``value``. Callers hold canonical_lock.
        """
        server, journal, canonical, decorated = self.server, self.journal, self.canonical, self.decorated
        # Retain only live canonical sessions, with a bounded household cache.
        live_canonical = set(canonical.values()) & server._sessions.keys()
        for old in list(decorated):
            if old not in live_canonical:
                del decorated[old]
        cached = None
        identity = None
        mutation = None
        if profile in canonical and canonical[profile] in server._sessions:
            sid = canonical[profile]
            identity = None if omit else self.history_identity(server._sessions[sid])
            with journal.lock:
                mutation = journal.mutation
                entry = decorated.get(sid)
                if not omit and not skip_cache and identity is not None and mutation is not None and entry and entry[:2] == (identity, mutation) and time.monotonic() - entry[3] < 30:
                    cached = entry[2]
            value = self.native("session.activate", {"session_id": sid, "profile": profile, **({"omit_messages": True} if omit or cached is not None else {})})
            # Native activation takes its own snapshot. Never combine cached history with
            # a live payload that crossed a history or journal mutation.
            if cached is not None and (self.history_identity(server._sessions[sid]) != identity or entry[1] != journal.mutation):
                cached = None
                identity = self.history_identity(server._sessions[sid])
                value = self.native("session.activate", {"session_id": sid, "profile": profile})
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
                value = self.native("session.resume", {"session_id": saved["resolved_id"], "profile": profile, "close_on_disconnect": False, "inline_images": False})
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

    def last_terminal(self, profile, sid, stored):
        """The newest settled outcome of the session, or of its canonical owner after a cold resume."""
        db = self.journal.db
        terminal = db.execute(LATEST_TERMINAL, (profile, sid)).fetchone()
        if not terminal:
            latest = db.execute(LATEST_ROOT, (profile, stored)).fetchone()
            terminal = db.execute(RUN_TERMINAL, (latest[0],)).fetchone() if latest else None
        return terminal

    def describe_task(self, profile, sid, session, value):
        if session.get("running") and session.get("app_exposed_reasoning"):
            value.setdefault("inflight", {})
            if value["inflight"] is None:
                value["inflight"] = {}
            value["inflight"]["reasoning"] = session["app_exposed_reasoning"]
        session["app_manual_recovery"] = True
        keeper = self.keepers.setdefault(sid, Keeper())
        self.server._attach_session_transport(session, keeper)
        db = self.journal.db
        value["executor_epoch"] = self.journal.epoch
        value["canonical_stored_session_id"] = session.get("session_key")
        interruption = db.execute("SELECT request_id,created FROM interruptions WHERE profile=? AND stored_session=?", (profile, value["canonical_stored_session_id"])).fetchone()
        value["app_interruption"] = {"requestId": interruption[0], "runId": interruption[0], "detail": "Hermes restarted during this task. Review its results before retrying."} if interruption else None
        current = db.execute(OPEN_RUN, (sid,)).fetchone()
        value["app_run_id"] = current[0] if current else None
        # Cold resume has a new runtime SID; use the canonical journal owner.
        terminal = self.last_terminal(profile, sid, value["canonical_stored_session_id"])
        value["app_task_state"] = {"completed": "done", "failed": "failed", "interrupted": "interrupted"}.get(terminal[0]) if terminal and not current else None

    def attribute(self, profile, sid, value):
        """Bind app receipts, files and tool details to native history rows.

        Returns (messages, journal mutation after binding, whether the result is cacheable).
        App attribution follows Hermes's durable row identity, never a rewritten body.
        Read each journal table once per poll, not once per message. Binding only fills
        a NULL row_id, so the unbound snapshot can only overstate candidates, and only
        a row ID bound here needs a reread. Callers hold journal.lock, which native
        writers also take, so none lands mid-poll.
        """
        journal, server = self.journal, self.server
        stored = value["canonical_stored_session_id"]
        messages = value.get("messages", [])
        unbound = journal.db.execute("SELECT steering,input_text,attachments FROM receipts WHERE profile=? AND stored_session=? AND status='accepted' AND row_id IS NULL", (profile, stored)).fetchall()
        steering_texts = {text for steering, text, _ in unbound if steering}
        image_pending = any(not steering and any(str(x.get("mime", "")).startswith("image/") for x in json.loads(raw or "[]")) for steering, _, raw in unbound)
        attributed = {}
        for row in journal.db.execute("SELECT row_id,request_id,actor,COALESCE(run_id,request_id),attachments,input_text FROM receipts WHERE profile=? AND row_id IN (SELECT value FROM json_each(?)) ORDER BY created DESC", (profile, json.dumps([m["row_id"] for m in messages if type(m.get("row_id")) is int]))):
            attributed.setdefault(row[0], row[1:])
        tool_records = {}
        for row in journal.db.execute("SELECT tool_id,run_id,result,artifacts,detail FROM tools WHERE profile=? AND stored_session=? AND tool_id IN (SELECT value FROM json_each(?)) ORDER BY id", (profile, server._sessions[sid].get("session_key", sid), json.dumps([m["tool_call_id"] for m in messages if m.get("role") == "tool" and type(m.get("tool_call_id")) is str]))):
            tool_records.setdefault(row[:2], []).append(row[2:])
        rebound = set()
        current_run = None
        for message in messages:
            if message.get("role") == "user":
                current_run = None
            if message.get("role") == "user" and message.get("row_id") is not None and message.get("text") in steering_texts:
                # Native steering persists a correction later, without an admission row ID.
                # Pair equal corrections in admission order within this canonical owner.
                candidate = journal.db.execute("SELECT request_id FROM receipts WHERE profile=? AND stored_session=? AND steering=1 AND status='accepted' AND row_id IS NULL AND input_text=? AND created<=? AND (SELECT row_id FROM receipts root WHERE root.request_id=receipts.run_id)<? ORDER BY created LIMIT 1", (profile, stored, message.get("text"), float(message.get("timestamp") or time.time()) + 1, message["row_id"])).fetchone()
                if candidate:
                    with journal.db:
                        journal.db.execute("UPDATE receipts SET row_id=? WHERE request_id=?", (message["row_id"], candidate[0]))
                    rebound.add(message["row_id"])
            if message.get("role") == "user" and message.get("row_id") is not None and image_pending:
                # Recovery for image-only turns completed before this binding hook.
                # Match the official persisted image-ref representation within the
                # admitted owner and time window, never arbitrary marker text.
                candidates = journal.db.execute("SELECT request_id,input_text,attachments FROM receipts WHERE profile=? AND stored_session=? AND status='accepted' AND steering=0 AND row_id IS NULL AND created<=? ORDER BY created", (profile, stored, float(message.get("timestamp") or time.time()) + 1)).fetchall()
                for request_id, input_text, raw_attachments in candidates:
                    images = [x["path"] for x in json.loads(raw_attachments or "[]") if str(x.get("mime", "")).startswith("image/")]
                    if images and server._build_persist_message_with_image_refs(input_text, images) == message.get("text"):
                        with journal.lock, journal.db:
                            journal.db.execute("UPDATE receipts SET row_id=? WHERE request_id=?", (message["row_id"], request_id))
                        rebound.add(message["row_id"])
                        break
            if message.get("row_id") is None:
                row = None
            elif type(message["row_id"]) is int and message["row_id"] not in rebound:
                row = attributed.get(message["row_id"])
            else:
                row = journal.db.execute("SELECT request_id,actor,COALESCE(run_id,request_id),attachments,input_text FROM receipts WHERE row_id=? AND profile=? ORDER BY created DESC LIMIT 1", (message.get("row_id"), profile)).fetchone()
            if row:
                message["app_request_id"], message["app_sender_id"] = row[:2]
                current_run = row[2]
                message["app_attachments"] = json.loads(row[3] or "[]")
                display_text = row[4] or ""
                suffix = "\n".join("@file:" + json.dumps(x["path"], ensure_ascii=False) for x in message["app_attachments"] if not str(x.get("mime", "")).startswith("image/"))
                if suffix and display_text.endswith("\n" + suffix):
                    display_text = display_text[:-len(suffix)-1]
                message["app_display_text"] = display_text
            if current_run:
                message["app_run_id"] = current_run
            if message.get("role") == "tool":
                if not current_run:
                    recorded = []
                elif type(message.get("tool_call_id")) is str:
                    recorded = tool_records.get((message["tool_call_id"], current_run), [])
                else:
                    recorded = journal.db.execute("SELECT result,artifacts,detail FROM tools WHERE profile=? AND stored_session=? AND tool_id=? AND run_id=? ORDER BY id", (profile, server._sessions[sid].get("session_key", sid), message.get("tool_call_id"), current_run)).fetchall()
                tool = next((item for item in recorded if json.loads(item[0]) == message.get("app_tool_result")), None)
                if tool:
                    # The persisted native output remains authoritative.
                    message["app_artifacts"] = json.loads(tool[1] or "[]")
                    # Reused IDs within a run cannot identify one call's
                    # timestamps or arguments. Fall back to its native row.
                    if len(recorded) == 1 and tool[2]:
                        detail = json.loads(tool[2])
                        if isinstance(detail, dict) and detail.get("name") == message.get("name"):
                            try:
                                arguments = json.loads(detail.get("arguments", "{}"))
                            except (ValueError, TypeError):
                                arguments = None
                            if arguments == (message.get("args") or {}):
                                message["app_tool_call"] = detail
        return messages, journal.mutation, not unbound

    def unrepresented_tool_calls(self, session, messages):
        # Standard native tools flush before completion; Codex can expose
        # completion before its turn flush. Keep those results until their
        # exact call appears in visible canonical history. Reused old IDs
        # cannot suppress a new call, and uncertain boundaries keep detail.
        calls = []
        if not session.get("running"):
            return calls
        for tool_id, call in session.get("app_live_tools", {}).items():
            represented = False
            if call.get("status") != "running":
                floor = session.get("app_live_tool_row_floors", {}).get(tool_id)
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
        server, journal = self.server, self.journal
        profile = params.get("profile", "default")
        # Callers that need only the session, its run state and open requests skip the
        # native history read. A first open still resumes with history.
        omit = params.get("omit_messages") is True
        window = params.get("window") if isinstance(params.get("window"), dict) and not omit else None
        with self.canonical_lock:
            activated = self.activate(profile, omit, params.get("_skip_cache"))
            if activated is None:
                return server._err(rid, 4040, "Unknown Hermes profile")
            value, cached, identity, mutation = activated
            value.setdefault("open_requests", [])
            self.mark_local_requests(value)
            sid = value["session_id"]
            session = server._sessions[sid]
            self.describe_task(profile, sid, session, value)
            with journal.lock:
                if cached is None:
                    messages, bound_mutation, cacheable = self.attribute(profile, sid, value)
            # Never acquire history_lock while holding journal.lock: native flushes
            # emit frames under history_lock and the frame hook needs journal.lock.
            after = self.history_identity(session) if not omit else None
            if cached is not None and (after != identity or mutation != journal.mutation):
                return self.open_bot(rid, {**params, "_skip_cache": True})
            with journal.lock:
                if cached is None:
                    if not omit and identity is not None and after == identity and cacheable and mutation == bound_mutation == journal.mutation:
                        # Full binding preserves cursor identities and earlier file context.
                        self.decorated[sid] = (identity, journal.mutation, messages, time.monotonic())
                        while len(self.decorated) > 32:
                            del self.decorated[min(self.decorated, key=lambda key: self.decorated[key][3])]
                    else:
                        self.decorated.pop(sid, None)
            value["app_tool_calls"] = self.unrepresented_tool_calls(session, value.get("messages", []))
            if window is not None:
                value["messages"], cut = history_window(value.get("messages", []), sid, window.get("start"), window.get("turns", 0))
                if cut:
                    value["app_window"] = cut
            return server._ok(rid, value)

    def open_canonical(self, profile):
        with self.canonical_lock:
            if self.canonical.get(profile) in self.server._sessions:
                return self.canonical[profile]
            response = self.open_bot("agent-interface-delivery", {"profile": profile})
        return None if "error" in response else response["result"]["session_id"]

    # Admission: one durable receipt per app request, before native execution.

    def admitted(self, rid, request_id, message=None):
        # Save the complete response in the same transaction as its final
        # admission state. receipt() remains the mutable status projection.
        value = self.journal.receipt(request_id)
        value.update(app_run_id=value["runId"], admission="canonical")
        if message is not None:
            value["message"] = message
        self.journal.db.execute("UPDATE receipts SET admission_response=? WHERE request_id=?", (json.dumps(value), request_id))
        return self.server._ok(rid, value)

    def stage_images(self, sid, profile, attachments, staged):
        """Attach image attachments natively, recording each addition in ``staged``."""
        sessions = self.server._sessions
        for attachment in attachments:
            if str(attachment.get("mime", "")).startswith("image/"):
                prior = list(sessions[sid].get("attached_images", []))
                try:
                    self.native("image.attach", {"session_id": sid, "profile": profile, "path": attachment["path"]})
                finally:
                    # Native image.attach can append before its result formatter fails.
                    remaining = list(prior)
                    for image in sessions[sid].get("attached_images", []):
                        if image in remaining:
                            remaining.remove(image)
                        else:
                            staged.append(image)

    def unstage_images(self, sid, staged):
        # Remove only additions from this preparation and preserve pre-existing staged images.
        session = self.server._sessions[sid]
        with session["history_lock"]:
            images = list(session.get("attached_images", []))
            for image in reversed(staged):
                if image in images:
                    images.pop(len(images) - 1 - images[::-1].index(image))
            session["attached_images"] = images

    def submit(self, rid, params):
        server, journal = self.server, self.journal
        request_id = params.get("request_id")
        actor = params.get("sender_id")
        profile = params.get("profile", "default")
        text = params.get("text", "")
        sid = params.get("session_id")
        attachments = params.get("attachments") or []
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 200 or not isinstance(actor, str) or not actor or not isinstance(text, str) or (not text.strip() and not attachments):
            return server._err(rid, -32602, "request_id, sender_id and non-empty text required")
        digest = hashlib.sha256(json.dumps([profile, actor, text, attachments], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        with self.submission_lock:
            # Replays need neither fresh canonical activation nor interruption review.
            # Keep the submission fence until admission finishes so only one call owns
            # a request ID. Do not take canonical_lock while holding journal.lock.
            with journal.lock:
                previous = journal.db.execute("SELECT digest FROM receipts WHERE request_id=?", (request_id,)).fetchone()
                if previous:
                    if previous[0] != digest:
                        return server._err(rid, 4093, "Request ID already belongs to a different input")
                    return server._ok(rid, journal.admission_response(request_id))
            if sid is None:
                sid = self.open_canonical(profile)
            with journal.lock:
                if sid is None or self.canonical.get(profile) != sid:
                    return server._err(rid, -32602, "Open this profile's canonical conversation before admission")
                stored = server._sessions[sid].get("session_key")
                running = bool(server._sessions[sid].get("running"))
                current = journal.db.execute(OPEN_RUN, (sid,)).fetchone()
                interrupted = journal.db.execute("SELECT 1 FROM interruptions WHERE profile=? AND stored_session=?", (profile, stored)).fetchone()
                terminal = self.last_terminal(profile, sid, stored)
                inflight = server._sessions[sid].get("inflight_turn") or {}
                interrupted = bool(interrupted) or not running and not current and (bool(inflight.get("interrupted")) or bool(terminal and terminal[0] == "interrupted"))
                if interrupted and params.get("reviewed_interruption") is not True:
                    return server._err(rid, 4094, "Review the interrupted task before starting another turn")
                rejected = (request_id, digest, profile, sid, stored, actor, journal.epoch, request_id, text, json.dumps(attachments), False, "rejected", 1, time.time())
                if current and not server._sessions[sid].get("running"):
                    # Native releases running before draining its followup queue. No new root
                    # may be admitted in that interval or retired with the preceding task.
                    with journal.db:
                        journal.db.execute(INSERT_REJECTED, rejected)
                        return self.admitted(rid, request_id, "Hermes is finishing the preceding task. Your input was not admitted; send it again after the task settles.")
                steering = bool(params.get("steer")) or bool(server._sessions.get(sid, {}).get("running"))
                if steering and any(str(x.get("mime", "")).startswith("image/") for x in attachments):
                    with journal.db:
                        journal.db.execute(INSERT_REJECTED, rejected)
                        return self.admitted(rid, request_id, "Images cannot be added while Hermes is working. Keep this draft and send it after the task settles.")
                run_id = current[0] if steering and current else request_id
                # FULL-synchronous intent is durable before native execution may be admitted.
                with journal.db:
                    journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (request_id, digest, profile, sid, stored, actor, journal.epoch, run_id, text, json.dumps(attachments), steering, "uncertain", time.time()))
                staged = []
                try:
                    if not steering:
                        self.stage_images(sid, profile, attachments, staged)
                except Exception as exc:
                    # No prompt invocation occurred, so this receipt is definitely rejected.
                    self.unstage_images(sid, staged)
                    with journal.db:
                        journal.db.execute("UPDATE receipts SET status='rejected',terminal=1 WHERE request_id=?", (request_id,))
                        return self.admitted(rid, request_id, "Image preparation failed before admission: " + str(exc)[:400])
                try:
                    method = "session.steer" if steering else "prompt.submit"
                    result = self.native(method, {"session_id": sid, "profile": profile, "text": text})
                except Exception as exc:
                    # Once native admission is invoked, failures remain conservative.
                    with journal.db:
                        return self.admitted(rid, request_id, str(exc)[:500])
                status = "rejected" if result.get("status") == "rejected" else "accepted"
                with journal.db:
                    journal.db.execute("UPDATE receipts SET status=?,row_id=COALESCE(?,row_id),terminal=CASE WHEN ? THEN 1 ELSE terminal END WHERE request_id=?", (status, result.get("user_row_id"), steering or status == "rejected", request_id))
                    if interrupted and status == "accepted":
                        journal.db.execute("DELETE FROM interruptions WHERE profile=? AND stored_session=?", (profile, stored))
                    return self.admitted(rid, request_id)

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
                        for execution in list_executions(job_id=job_id, limit=100):
                            status = execution.get("status")
                            if status not in ("completed", "failed", "unknown"):
                                continue
                            execution_id = str(execution.get("execution_id") or execution.get("id") or execution.get("claimed_at"))
                            run_id = f"routine:{name}:{job_id}:{execution_id}"
                            kind = "completed" if status == "completed" else "failed" if status == "failed" else "interrupted"
                            self.journal.event(name, str(execution.get("session_id") or ""), kind, job.get("name") or "Routine result", run_id, event_key=f"{run_id}:{status}", routine_id=job_id)
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
            if row[4] == "completed" and server._sessions.get(row[2], {}).get("running"):
                # A turn boundary can precede queued guidance/goal continuation.
                break
            ready.append(row)
        events = [{"id": str(r[0]), "botId": r[1], "sessionId": r[2], "requestId": r[3], "runId": r[3], "routineId": r[8], "kind": r[4], "title": r[5], "body": r[6], "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r[7])),
                   **({"approvalId": approval_id(r)} if approval_id(r) else {})} for r in ready]
        return server._ok(rid, {"cursor": str(ready[-1][0] if ready else cursor), "events": events})

    def rpc_methods(self):
        """The agent-interface RPCs that read or admit app work, by registered name."""
        return {"agent-interface." + name: handler for name, handler in
                {"open": self.open_bot, "submit": self.submit, "receipt": self.receipt, "discover": self.discover}.items()}

    # Bot Chat delivery: routines and bot messages arrive as canonical chat turns.

    @contextlib.contextmanager
    def delivery_admission(self, sid):
        # Same order as submit: no delivery starts beside an unsettled app task or maintenance.
        with self.submission_lock:
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

def install(path=None):
    actual_revision, patch_hash = source_state()
    from tui_gateway import server
    from hermes_constants import get_hermes_home, profile_name_for_home
    sibling_module("computer").install(server)
    journal = Journal(path or Path(get_hermes_home()) / "runtime" / "agent-interface.db")
    bridge = Bridge(server, journal, get_hermes_home=get_hermes_home, profile_name_for_home=profile_name_for_home,
                    maintenance_file=os.environ.get("HERMES_AGENT_INTERFACE_MAINTENANCE_FILE"))
    from hermes_cli.backend_retirement import retirement
    bridge.install_maintenance(retirement)
    bridge.install_native_seams()
    from agent.skill_utils import ESSENTIAL_SKILLS
    server.register_method("agent-interface.capabilities", lambda rid, _: server._ok(rid, {"revision": actual_revision, "tracked_patch_sha256": patch_hash, "executor_epoch": journal.epoch, "durable_admission": True, "durable_events": True, "canonical_open": True, "explicit_credentials": True, "canonical_submit": True, "incremental_discovery": True, "essential_skills": sorted(ESSENTIAL_SKILLS)}))
    for name, handler in bridge.rpc_methods().items():
        server.register_method(name, handler)
    bridge.install_delivery()
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
    sibling_module("vault").install(web, journal)
    sibling_module("integrations").install(web)
    sibling_module("service_auth").install_service_auth(web, os.environ["HERMES_AGENT_INTERFACE_TOKEN"])
    web.start_server(host="127.0.0.1", port=args.port, open_browser=False, headless=True, isolated=True)
