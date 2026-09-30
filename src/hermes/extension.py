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
from pathlib import Path

REVISION = "b9cb268deffc97946ec11645aa622a7353dd0591"
QUALIFIED_REVISIONS = {REVISION, "d23cc6b06455b8551fb6f61d3cad040a0e82f5b6"}
QUALIFIED_OAUTH_PATCH = "2b8335c692f100640e375ffd338f26f6d86195a4ff91c2000e3306bcea9d671c"


def qualification_module():
    spec = importlib.util.spec_from_file_location("agent_interface_qualification", Path(__file__).with_name("qualification.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def source_state():
    """Qualify imported Hermes, including tracked local repairs, without logging their contents."""
    import hermes_cli
    source = Path(hermes_cli.__file__).resolve().parents[1]
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    patch = subprocess.check_output(["git", "-C", str(source), "diff", "HEAD"])
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
        for column in ("stored_session", "attachments"):
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
        with self.db:
            for request_id, profile, sid, stored in self.db.execute("SELECT COALESCE(run_id,request_id),profile,session_id,stored_session FROM receipts WHERE terminal=0 AND status IN ('accepted','uncertain')").fetchall():
                self.event(profile, sid, "interrupted", "Hermes restarted. Review before retrying.", request_id, event_key=f"{request_id}:interrupted")
                if stored:
                    self.db.execute("INSERT OR REPLACE INTO interruptions(profile,stored_session,request_id,created) VALUES(?,?,?,?)", (profile, stored, request_id, time.time()))
            self.db.execute("UPDATE receipts SET status='interrupted',terminal=1 WHERE terminal=0 AND status IN ('accepted','uncertain')")

    def event(self, profile, sid, kind, title, run_id=None, body=None, event_key=None, routine_id=None):
        with self.lock, self.db:
            self.db.execute("INSERT OR IGNORE INTO events(profile,session_id,run_id,kind,title,body,occurred,epoch,event_key,routine_id) VALUES(?,?,?,?,?,?,?,?,?,?)", (profile, sid, run_id, kind, title, body, time.time(), self.epoch, event_key, routine_id))

    def receipt(self, request_id):
        row = self.db.execute("SELECT status,COALESCE(run_id,request_id),row_id,actor FROM receipts WHERE request_id=?", (request_id,)).fetchone()
        return None if row is None else {"requestId": request_id, "status": row[0], "runId": row[1], "userRowId": row[2], "senderId": row[3]}


def install(path=None):
    actual_revision, patch_hash = source_state()
    from tui_gateway import server
    from tui_gateway.transport import Transport
    from hermes_constants import get_hermes_home, profile_name_for_home
    journal = Journal(path or Path(get_hermes_home()) / "runtime" / "agent-interface.db")
    canonical_lock = threading.RLock()
    submission_lock = threading.RLock()
    keepers = {}
    canonical = {}
    settlement = {}
    maintenance_lock = threading.RLock()
    maintenance_file = os.environ.get("HERMES_AGENT_INTERFACE_MAINTENANCE_FILE")
    from hermes_cli.backend_retirement import retirement
    maintenance_read = contextvars.ContextVar("agent_interface_maintenance_read", default=False)

    def maintenance_state():
        if not maintenance_file:
            return None
        path = Path(maintenance_file)
        if not path.is_absolute():
            raise RuntimeError("Maintenance lease requires an absolute private path.")
        if not path.exists():
            return None
        info = path.lstat()
        if path.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("Maintenance lease is not private.")
        return json.loads(path.read_text())

    def busy_sessions():
        # Native workers can reserve admission while holding _sessions_lock.
        # Snapshot the dictionary without taking that lock in the reverse order;
        # native reservations cover work queued after this snapshot.
        sessions = server._sessions.copy()
        return [{"sessionId": sid, "profile": profile_for(sid), "state": "running"}
                for sid, session in sessions.items()
                if session.get("running") or session.get("queued_prompt") or session.get("queued_prompts")
                or session.get("pending_steer") or session.get("_auto_continue_scheduled")]

    def maintenance(rid, params):
        secret = os.environ.get("HERMES_AGENT_INTERFACE_TOKEN", "")
        supplied = params.get("service_key", "")
        if not secret or not isinstance(supplied, str) or not hmac.compare_digest(supplied, secret):
            return server._err(rid, 403, "Private maintenance authentication required")
        if not maintenance_file:
            return server._err(rid, 409, "Host maintenance lease is not configured")
        with maintenance_lock:
            lease = maintenance_state()
            action = params.get("action", "status")
            operation = params.get("operation_id")
            if action not in ("status", "acquire", "release"):
                return server._err(rid, 400, "Unknown maintenance action")
            if action != "status" and (not isinstance(operation, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", operation)):
                return server._err(rid, 400, "Invalid maintenance operation")
            if lease and lease.get("operationId") != operation and action != "status":
                return server._err(rid, 409, "Another maintenance operation owns this lease")
            busy = busy_sessions()
            if action == "acquire":
                # This request holds one native reservation. Queued RPCs and
                # deferred work reserve before execution and must also be idle.
                if busy or retirement.active_count() > 1:
                    return server._err(rid, 409, "Hermes still has active work; no maintenance lease acquired")
                path = Path(maintenance_file)
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                temporary = path.with_name(path.name + "." + uuid.uuid4().hex)
                fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "w") as handle:
                    json.dump({"operationId": operation}, handle)
                    handle.flush()
                    os.fsync(handle.fileno())
                temporary.replace(path)
                lease = {"operationId": operation}
            elif action == "release" and lease:
                Path(maintenance_file).unlink()
                lease = None
            return server._ok(rid, {"active": lease is not None, "operationId": (lease or {}).get("operationId"), "busy": busy})

    original_handle = server.handle_request
    original_dispatch = server.dispatch
    original_acquire = retirement.acquire
    maintenance_reads = {"agent-interface.maintenance", "agent-interface.capabilities", "agent-interface.receipt", "agent-interface.discover",
                         "client.capabilities", "profiles.list", "profiles.describe", "session.list", "session.history", "session.info", "session.events.since"}
    def guarded_acquire():
        with maintenance_lock:
            if maintenance_state() and not maintenance_read.get():
                return False
            return original_acquire()
    retirement.acquire = guarded_acquire

    def guarded_call(call, request, *args, **kwargs):
        method = request.get("method", "")
        read = method in maintenance_reads
        token = maintenance_read.set(read)
        try:
            with maintenance_lock:
                if not read and maintenance_state():
                    return server._err(request.get("id"), 409, "Hermes is being upgraded. Your current work and drafts are preserved.")
            # Native admission takes the same gate atomically. Never hold our
            # lock across a native handler's own session/profile locks.
            return call(request, *args, **kwargs)
        finally:
            maintenance_read.reset(token)

    # Native dispatch reserves pool work before queueing. Fencing only the
    # synchronous handler misses native shell/configuration/image RPCs.
    server.handle_request = lambda request: guarded_call(original_handle, request)
    server.dispatch = lambda request, *args, **kwargs: guarded_call(original_dispatch, request, *args, **kwargs)
    server.register_method("agent-interface.maintenance", maintenance)

    # Keep the canonical native projection, adding only details present in its
    # original tool rows. The compact native view otherwise omits most outputs.
    original_history = server._history_to_messages
    def detailed_history(history, **kwargs):
        messages = original_history(history, **kwargs)
        tool_rows = {}
        for row in history:
            if not isinstance(row, dict) or row.get("role") != "tool":
                continue
            # Native compaction and hidden scaffolding must stay hidden. A model
            # can reuse a call ID later, so identity also includes native time.
            visible = original_history([row], **kwargs)
            projected = server.project_compaction_message_for_display(row)
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
    server._history_to_messages = detailed_history

    class Keeper:
        closed = False
        def write(self, _frame):
            return True
        def close(self):
            self.closed = True

    def native(method, params):
        response = server.handle_request({"jsonrpc": "2.0", "id": "extension-native", "method": method, "params": params})
        if "error" in response:
            raise RuntimeError(json.dumps(response["error"]))
        return response["result"]

    def profile_for(sid):
        session = server._sessions.get(sid, {})
        home = session.get("profile_home") or session.get("hermes_home")
        # Receipt ownership is authoritative for app-started turns, including default.
        row = journal.db.execute("SELECT profile FROM receipts WHERE session_id=? ORDER BY created DESC LIMIT 1", (sid,)).fetchone()
        return row[0] if row else profile_name_for_home(home or get_hermes_home())

    def artifacts(result, session):
        # Only actual native tool results can register outputs. Never scan user text.
        root = Path(server._session_cwd(session)).resolve()
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

    original_write = server.write_json
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

    def write(frame):
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
            with journal.lock:
                run = journal.db.execute("SELECT COALESCE(run_id,request_id) FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created DESC LIMIT 1", (sid,)).fetchone()
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
                run = journal.db.execute("SELECT COALESCE(run_id,request_id) FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created DESC LIMIT 1", (sid,)).fetchone()
                journal.db.execute("INSERT INTO tools(profile,stored_session,run_id,tool_id,result,artifacts,detail) VALUES(?,?,?,?,?,?,?)", (profile_for(sid), session.get("session_key", sid), run[0] if run else None, payload.get("tool_id"), json.dumps(payload.get("result")), json.dumps(artifacts(payload.get("result"), session)), json.dumps(session.get("app_live_tools", {}).get(payload.get("tool_id")))))
        if sid and event_kind == "approval":
            with journal.lock:
                row = journal.db.execute("SELECT COALESCE(run_id,request_id) FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created DESC LIMIT 1", (sid,)).fetchone()
                root = row[0] if row else None
                identity = f"{root}:{event_kind}:{frame.get('id') if event_kind == 'approval' else ''}" if root else None
                journal.event(profile_for(sid), sid, event_kind, "Approval requested" if event_kind == "approval" else "Hermes " + event_kind, root, event_key=identity)
        elif sid and event_kind:
            # A native message.complete closes one turn, before steering/goal queue drain.
            # The post-followup seam below is the task boundary.
            settlement[sid] = event_kind
        return original_write(frame)
    server.write_json = write

    original_followups = server._run_post_turn_followups
    def followups(rid, sid, session, result, goal_followup):
        # Inline queue drains can themselves wait for approvals. Keep admission live
        # during that execution; the unresolved-root guard fences the idle seam.
        original_followups(rid, sid, session, result, goal_followup)
        with submission_lock:
            if session.get("running") or session.get("queued_prompt"):
                return
            kind = settlement.pop(sid, None)
            if kind:
                with journal.lock, journal.db:
                    row = journal.db.execute("SELECT COALESCE(run_id,request_id),profile FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created LIMIT 1", (sid,)).fetchone()
                    if row:
                        journal.event(row[1], sid, kind, "Hermes " + kind, row[0], event_key=f"{row[0]}:{kind}")
                        journal.db.execute("UPDATE receipts SET terminal=1,status=CASE WHEN ? THEN 'interrupted' ELSE status END WHERE COALESCE(run_id,request_id)=? AND terminal=0", (kind == "interrupted", row[0]))
    server._run_post_turn_followups = followups

    # Disable native automatic retry narrowly for canonical sessions admitted through this app.
    original_marker = server._record_turn_marker
    def record_marker(session, text, **kwargs):
        if session.get("app_manual_recovery"):
            kwargs["auto_continue"] = False
        return original_marker(session, text, **kwargs)
    server._record_turn_marker = record_marker
    original_auto_continue = server._maybe_schedule_auto_continue
    def maybe_continue(sid, session, stored_key):
        with maintenance_lock:
            if maintenance_state():
                return None
        profile = profile_name_for_home(session.get("profile_home") or get_hermes_home())
        with journal.lock:
            owned = journal.db.execute("SELECT 1 FROM receipts WHERE profile=? AND stored_session=? LIMIT 1", (profile, stored_key)).fetchone()
        if owned:
            session["app_manual_recovery"] = True
            return None
        return original_auto_continue(sid, session, stored_key)
    server._maybe_schedule_auto_continue = maybe_continue

    def open_bot(rid, params):
        profile = params.get("profile", "default")
        with canonical_lock:
            if profile in canonical and canonical[profile] in server._sessions:
                value = native("session.activate", {"session_id": canonical[profile], "profile": profile})
            else:
                roster = native("profiles.list", {"include_sessions": True})["profiles"]
                bot = next((x for x in roster if x["name"] == profile), None)
                if bot is None:
                    return server._err(rid, 4040, "Unknown Hermes profile")
                saved = bot.get("canonical_session")
                if saved:
                    value = native("session.resume", {"session_id": saved["resolved_id"], "profile": profile, "close_on_disconnect": False, "inline_images": False})
                else:
                    value = native("session.create", {"profile": profile, "title": "Bot Chat", "hidden": True, "follow_profile_config": True, "close_on_disconnect": False})
                    try:
                        native("session.title", {"session_id": value["session_id"], "profile": profile, "title": "Bot Chat"})
                    except RuntimeError:
                        # Another official writer acquired the unique canonical title. Adopt it.
                        roster = native("profiles.list", {"include_sessions": True})["profiles"]
                        saved = next(x for x in roster if x["name"] == profile)["canonical_session"]
                        if not saved:
                            raise
                        value = native("session.resume", {"session_id": saved["resolved_id"], "profile": profile, "close_on_disconnect": False})
                canonical[profile] = value["session_id"]
            value.setdefault("open_requests", [])
            sid = value["session_id"]
            session = server._sessions[sid]
            if session.get("running") and session.get("app_exposed_reasoning"):
                value.setdefault("inflight", {})
                if value["inflight"] is None:
                    value["inflight"] = {}
                value["inflight"]["reasoning"] = session["app_exposed_reasoning"]
            server._sessions[sid]["app_manual_recovery"] = True
            keeper = keepers.setdefault(sid, Keeper())
            server._attach_session_transport(server._sessions[sid], keeper)
            value["executor_epoch"] = journal.epoch
            value["canonical_stored_session_id"] = server._sessions[sid].get("session_key")
            interruption = journal.db.execute("SELECT request_id,created FROM interruptions WHERE profile=? AND stored_session=?", (profile, value["canonical_stored_session_id"])).fetchone()
            value["app_interruption"] = {"requestId": interruption[0], "runId": interruption[0], "detail": "Hermes restarted during this task. Review its results before retrying."} if interruption else None
            current = journal.db.execute("SELECT COALESCE(run_id,request_id) FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created DESC LIMIT 1", (sid,)).fetchone()
            value["app_run_id"] = current[0] if current else None
            terminal = journal.db.execute("SELECT kind FROM events WHERE profile=? AND session_id=? AND kind IN ('completed','failed','interrupted') ORDER BY id DESC LIMIT 1", (profile, sid)).fetchone()
            # Cold resume has a new runtime SID; use the canonical journal owner.
            if not terminal:
                latest = journal.db.execute("SELECT COALESCE(run_id,request_id) FROM receipts WHERE profile=? AND stored_session=? AND steering=0 ORDER BY created DESC LIMIT 1", (profile, value["canonical_stored_session_id"])).fetchone()
                terminal = journal.db.execute("SELECT kind FROM events WHERE run_id=? AND kind IN ('completed','failed','interrupted') ORDER BY id DESC LIMIT 1", (latest[0],)).fetchone() if latest else None
            value["app_task_state"] = {"completed": "done", "failed": "failed", "interrupted": "interrupted"}.get(terminal[0]) if terminal and not current else None
            # App attribution follows Hermes's durable row identity, never a rewritten body.
            current_run = None
            for message in value.get("messages", []):
                if message.get("role") == "user":
                    current_run = None
                if message.get("role") == "user" and message.get("row_id") is not None:
                    # Native steering persists a correction later, without an admission row ID.
                    # Pair equal corrections in admission order within this canonical owner.
                    candidate = journal.db.execute("SELECT request_id FROM receipts WHERE profile=? AND stored_session=? AND steering=1 AND status='accepted' AND row_id IS NULL AND input_text=? AND created<=? AND (SELECT row_id FROM receipts root WHERE root.request_id=receipts.run_id)<? ORDER BY created LIMIT 1", (profile, value["canonical_stored_session_id"], message.get("text"), float(message.get("timestamp") or time.time()) + 1, message["row_id"])).fetchone()
                    if candidate:
                        with journal.db:
                            journal.db.execute("UPDATE receipts SET row_id=? WHERE request_id=?", (message["row_id"], candidate[0]))
                if message.get("role") == "user" and message.get("row_id") is not None:
                    # Recovery for image-only turns completed before this binding hook.
                    # Match the official persisted image-ref representation within the
                    # admitted owner and time window, never arbitrary marker text.
                    candidates = journal.db.execute("SELECT request_id,input_text,attachments FROM receipts WHERE profile=? AND stored_session=? AND status='accepted' AND steering=0 AND row_id IS NULL AND created<=? ORDER BY created", (profile, value["canonical_stored_session_id"], float(message.get("timestamp") or time.time()) + 1)).fetchall()
                    for request_id, input_text, raw_attachments in candidates:
                        images = [x["path"] for x in json.loads(raw_attachments or "[]") if str(x.get("mime", "")).startswith("image/")]
                        if images and server._build_persist_message_with_image_refs(input_text, images) == message.get("text"):
                            with journal.lock, journal.db:
                                journal.db.execute("UPDATE receipts SET row_id=? WHERE request_id=?", (message["row_id"], request_id))
                            break
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
                if message.get("role") == "tool":
                    recorded = journal.db.execute("SELECT result,artifacts,detail FROM tools WHERE profile=? AND stored_session=? AND tool_id=? AND run_id=? ORDER BY id", (profile, server._sessions[sid].get("session_key", sid), message.get("tool_call_id"), current_run)).fetchall() if current_run else []
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
            # Standard native tools flush before completion; Codex can expose
            # completion before its turn flush. Keep those results until their
            # exact call appears in visible canonical history. Reused old IDs
            # cannot suppress a new call, and uncertain boundaries keep detail.
            value["app_tool_calls"] = []
            if session.get("running"):
                for tool_id, call in session.get("app_live_tools", {}).items():
                    represented = False
                    if call.get("status") != "running":
                        floor = session.get("app_live_tool_row_floors", {}).get(tool_id)
                        try:
                            arguments = json.loads(call.get("arguments", "{}"))
                        except (ValueError, TypeError):
                            arguments = None
                        for message in value.get("messages", []):
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
                        value["app_tool_calls"].append(call)
            return server._ok(rid, value)

    def submit(rid, params):
        request_id = params.get("request_id")
        actor = params.get("sender_id")
        profile = params.get("profile", "default")
        text = params.get("text", "")
        sid = params.get("session_id")
        attachments = params.get("attachments") or []
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 200 or not isinstance(actor, str) or not actor or not isinstance(text, str) or (not text.strip() and not attachments):
            return server._err(rid, -32602, "request_id, sender_id and non-empty text required")
        digest = hashlib.sha256(json.dumps([profile, actor, text, attachments], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        with submission_lock, journal.lock:
            if canonical.get(profile) != sid:
                return server._err(rid, -32602, "Open this profile's canonical conversation before admission")
            stored = server._sessions[sid].get("session_key")
            interrupted = journal.db.execute("SELECT 1 FROM interruptions WHERE profile=? AND stored_session=?", (profile, stored)).fetchone()
            if interrupted and params.get("reviewed_interruption") is not True:
                return server._err(rid, 4094, "Review the interrupted task before starting another turn")
            previous = journal.db.execute("SELECT digest FROM receipts WHERE request_id=?", (request_id,)).fetchone()
            if previous:
                if previous[0] != digest:
                    return server._err(rid, 4093, "Request ID already belongs to a different input")
                return server._ok(rid, journal.receipt(request_id))
            current = journal.db.execute("SELECT COALESCE(run_id,request_id) FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created DESC LIMIT 1", (sid,)).fetchone()
            if current and not server._sessions[sid].get("running"):
                # Native releases running before draining its followup queue. No new root
                # may be admitted in that interval or retired with the preceding task.
                with journal.db:
                    journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,terminal,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (request_id, digest, profile, sid, stored, actor, journal.epoch, request_id, text, json.dumps(attachments), False, "rejected", 1, time.time()))
                return server._ok(rid, {**journal.receipt(request_id), "message": "Hermes is finishing the preceding task. Your input was not admitted; send it again after the task settles."})
            steering = bool(params.get("steer")) or bool(server._sessions.get(sid, {}).get("running"))
            if steering and any(str(x.get("mime", "")).startswith("image/") for x in attachments):
                with journal.db:
                    journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,terminal,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (request_id, digest, profile, sid, stored, actor, journal.epoch, request_id, text, json.dumps(attachments), False, "rejected", 1, time.time()))
                return server._ok(rid, {**journal.receipt(request_id), "message": "Hermes cannot inject image bytes into an active turn. Wait for it to finish before sending this image."})
            current = journal.db.execute("SELECT COALESCE(run_id,request_id) FROM receipts WHERE session_id=? AND terminal=0 ORDER BY created DESC LIMIT 1", (sid,)).fetchone()
            run_id = current[0] if steering and current else request_id
            # FULL-synchronous intent is durable before native execution may be admitted.
            with journal.db:
                journal.db.execute("INSERT INTO receipts(request_id,digest,profile,session_id,stored_session,actor,epoch,run_id,input_text,attachments,steering,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (request_id, digest, profile, sid, stored, actor, journal.epoch, run_id, text, json.dumps(attachments), steering, "uncertain", time.time()))
            staged = []
            try:
                if not steering:
                    for attachment in attachments:
                        if str(attachment.get("mime", "")).startswith("image/"):
                            prior = list(server._sessions[sid].get("attached_images", []))
                            try:
                                attached = native("image.attach", {"session_id": sid, "profile": profile, "path": attachment["path"]})
                            finally:
                                # Native image.attach can append before its result formatter fails.
                                remaining = list(prior)
                                for image in server._sessions[sid].get("attached_images", []):
                                    if image in remaining:
                                        remaining.remove(image)
                                    else:
                                        staged.append(image)
            except Exception as exc:
                # No prompt invocation occurred. Remove only additions from this preparation,
                # preserve pre-existing staged images, and definitely reject this receipt.
                with server._sessions[sid]["history_lock"]:
                    images = list(server._sessions[sid].get("attached_images", []))
                    for image in reversed(staged):
                        if image in images:
                            images.pop(len(images) - 1 - images[::-1].index(image))
                    server._sessions[sid]["attached_images"] = images
                with journal.db:
                    journal.db.execute("UPDATE receipts SET status='rejected',terminal=1 WHERE request_id=?", (request_id,))
                return server._ok(rid, {**journal.receipt(request_id), "message": "Image preparation failed before admission: " + str(exc)[:400]})
            try:
                method = "session.steer" if steering else "prompt.submit"
                result = native(method, {"session_id": sid, "profile": profile, "text": text})
            except Exception as exc:
                # Once native admission is invoked, failures remain conservative.
                return server._ok(rid, {**journal.receipt(request_id), "message": str(exc)[:500]})
            status = "rejected" if result.get("status") == "rejected" else "accepted"
            with journal.db:
                journal.db.execute("UPDATE receipts SET status=?,row_id=COALESCE(?,row_id),terminal=CASE WHEN ? THEN 1 ELSE terminal END WHERE request_id=?", (status, result.get("user_row_id"), steering or status == "rejected", request_id))
                if interrupted and status == "accepted":
                    journal.db.execute("DELETE FROM interruptions WHERE profile=? AND stored_session=?", (profile, stored))
            return server._ok(rid, journal.receipt(request_id))

    def receipt(rid, params):
        with journal.lock:
            return server._ok(rid, {"receipt": journal.receipt(params.get("request_id", ""))})

    def discover(rid, params):
        try:
            cursor = int(params.get("cursor") or 0)
        except (ValueError, TypeError):
            return server._err(rid, -32602, "Invalid discovery cursor")
        # Runs outside this gateway still have an official durable execution ledger.
        # Discover its actual terminal attempts, with explicit routine identities.
        from hermes_cli.web_routers.cron import _owner_home_scope, _list_cron_jobs_sync
        from cron.executions import list_executions
        for profile in native("profiles.list", {"include_sessions": False})["profiles"]:
            name = profile["name"]
            # The dashboard reader avoids tool-facing machine-wide liveness probes.
            jobs = _list_cron_jobs_sync(name)
            with _owner_home_scope(name):
                for job in jobs:
                    job_id = job.get("id") or job["job_id"]
                    for execution in list_executions(job_id=job_id, limit=100):
                        status = execution.get("status")
                        if status not in ("completed", "failed", "unknown"):
                            continue
                        execution_id = str(execution.get("execution_id") or execution.get("id") or execution.get("claimed_at"))
                        run_id = f"routine:{name}:{job_id}:{execution_id}"
                        kind = "completed" if status == "completed" else "failed" if status == "failed" else "interrupted"
                        journal.event(name, str(execution.get("session_id") or ""), kind, job.get("name") or "Routine result", run_id, event_key=f"{run_id}:{status}", routine_id=job_id)
        with journal.lock:
            rows = journal.db.execute("SELECT id,profile,session_id,run_id,kind,title,body,occurred,routine_id FROM events WHERE id>? ORDER BY id LIMIT 250", (cursor,)).fetchall()
        ready = []
        for row in rows:
            if row[4] == "completed" and server._sessions.get(row[2], {}).get("running"):
                # A turn boundary can precede queued guidance/goal continuation.
                break
            ready.append(row)
        events = [{"id": str(r[0]), "botId": r[1], "sessionId": r[2], "requestId": r[3], "runId": r[3], "routineId": r[8], "kind": r[4], "title": r[5], "body": r[6], "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r[7]))} for r in ready]
        return server._ok(rid, {"cursor": str(ready[-1][0] if ready else cursor), "events": events})

    from agent.skill_utils import ESSENTIAL_SKILLS
    server.register_method("agent-interface.capabilities", lambda rid, _: server._ok(rid, {"revision": actual_revision, "tracked_patch_sha256": patch_hash, "executor_epoch": journal.epoch, "durable_admission": True, "durable_events": True, "canonical_open": True, "essential_skills": sorted(ESSENTIAL_SKILLS)}))
    for name, handler in {"open": open_bot, "submit": submit, "receipt": receipt, "discover": discover}.items():
        server.register_method("agent-interface." + name, handler)
    return journal


if __name__ == "__main__":
    import hermes_cli.web_server as web
    source_state()
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=19119)
    args = parser.parse_args()
    install()
    web.start_server(host="127.0.0.1", port=args.port, open_browser=False, headless=True, isolated=True)
