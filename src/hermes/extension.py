"""Revision-bound Hermes gateway add-on, without changes to core execution or state.db.

Launch from the tested Hermes environment with HERMES_HOME set by its supervisor:
python src/hermes/extension.py --port 19119
See docs/HermesCapabilityMatrix.md. Journal contains private runtime data, never commit it.
"""
import argparse
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
from pathlib import Path

REVISION = "b9cb268deffc97946ec11645aa622a7353dd0591"


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
    from tui_gateway import server
    from tui_gateway.transport import Transport
    from hermes_constants import get_hermes_home, profile_name_for_home
    journal = Journal(path or Path(get_hermes_home()) / "runtime" / "agent-interface.db")
    canonical_lock = threading.RLock()
    submission_lock = threading.RLock()
    keepers = {}
    canonical = {}
    settlement = {}

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
    def write(frame):
        params = frame.get("params") or {}
        sid = params.get("session_id")
        kind = params.get("type")
        payload = params.get("payload") or {}
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
                journal.db.execute("INSERT INTO tools(profile,stored_session,run_id,tool_id,result,artifacts) VALUES(?,?,?,?,?,?)", (profile_for(sid), session.get("session_key", sid), run[0] if run else None, payload.get("tool_id"), json.dumps(payload.get("result")), json.dumps(artifacts(payload.get("result"), session))))
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
                    tool = journal.db.execute("SELECT result,artifacts FROM tools WHERE profile=? AND stored_session=? AND tool_id=? AND (run_id=? OR ? IS NULL) ORDER BY id DESC LIMIT 1", (profile, server._sessions[sid].get("session_key", sid), message.get("tool_call_id"), current_run, current_run)).fetchone()
                    if tool:
                        message["app_tool_result"] = json.loads(tool[0])
                        message["app_artifacts"] = json.loads(tool[1] or "[]")
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
    server.register_method("agent-interface.capabilities", lambda rid, _: server._ok(rid, {"revision": REVISION, "executor_epoch": journal.epoch, "durable_admission": True, "durable_events": True, "canonical_open": True, "essential_skills": sorted(ESSENTIAL_SKILLS)}))
    for name, handler in {"open": open_bot, "submit": submit, "receipt": receipt, "discover": discover}.items():
        server.register_method("agent-interface." + name, handler)
    return journal


if __name__ == "__main__":
    import subprocess
    import hermes_cli.web_server as web
    source = Path(web.__file__).resolve().parents[1]
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if actual != REVISION:
        raise SystemExit("Hermes source revision differs from the verified add-on. Run compatibility probes before changing REVISION.")
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=19119)
    args = parser.parse_args()
    install()
    web.start_server(host="127.0.0.1", port=args.port, open_browser=False, headless=True, isolated=True)
