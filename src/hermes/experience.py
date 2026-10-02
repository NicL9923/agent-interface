"""Profile memory and scheduler previews using Hermes's native stores and locks.

The adapter owns only duplicate-safe manual-trigger receipts. Memory, timezones,
job claims, agent execution and canonical delivery stay in Hermes.
"""
import asyncio
import datetime
import hashlib
import json
import re
import threading
import time
from pathlib import Path


class ExperienceError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def memory_document(store, profile, target):
    from tools.memory_tool_store import ENTRY_DELIMITER
    def snapshot(entries, limit):
        return dict(success=True, document=dict(target=target, label="Assistant notes" if target == "memory" else "About you",
            revision=digest(profile, target, entries), enabled=store.target_enabled(target),
            entries=[dict(id=digest(profile, target, entry), text=entry) for entry in entries],
            charLimit=limit, charCount=len(ENTRY_DELIMITER.join(entries))))
    result = store._mutate(target, snapshot, skip_drift=True)
    if not result.get("success"):
        raise ExperienceError("Hermes could not read this memory document. Check the native memory store.", 409)
    return result["document"]


def profile_memory(profile):
    from tools.memory_tool import load_on_disk_store
    store = load_on_disk_store()
    return dict(botId=profile, profile=profile, scope="profile", owner="Hermes",
        documents=[memory_document(store, profile, target) for target in ("memory", "user")],
        notice="These memories belong to this shared Hermes profile. Edits are saved in Hermes. Existing conversations keep their memory snapshot until Hermes starts a new session.")


def mutate_memory(data):
    from tools.memory_tool import load_on_disk_store
    from tools.memory_tool_store import ENTRY_DELIMITER, _scan_memory_content
    profile, target = data["profile"], data.get("target")
    if target not in ("memory", "user"):
        raise ExperienceError("Unknown memory document.")
    store = load_on_disk_store()
    if not store.target_enabled(target):
        raise ExperienceError("This memory surface is disabled in the Hermes profile.", 409)
    def update(entries, limit):
        if data.get("revision") != digest(profile, target, entries):
            raise ExperienceError("Hermes memory changed since you opened it. Reload and review the new entries before saving.", 409)
        if data["operation"] == "delete_memory":
            index = next((index for index, entry in enumerate(entries) if digest(profile, target, entry) == data.get("entryId")), None)
            if index is None:
                raise ExperienceError("This memory entry no longer exists. Reload before forgetting it.", 409)
            replacement = entries[:index] + entries[index + 1:]
        else:
            requested = data.get("entries")
            if not isinstance(requested, list) or len(requested) > 100:
                raise ExperienceError("Expected at most 100 memory entries.")
            known = {digest(profile, target, entry) for entry in entries}
            replacement = []
            seen_ids = set()
            for row in requested:
                if not isinstance(row, dict) or not isinstance(row.get("text"), str):
                    raise ExperienceError("Every memory entry needs text.")
                identity = row.get("id")
                if identity is not None and (identity not in known or identity in seen_ids):
                    raise ExperienceError("Memory entry identity changed. Reload before saving.", 409)
                seen_ids.add(identity)
                text = row["text"].strip()
                if ENTRY_DELIMITER in text:
                    raise ExperienceError("A memory entry cannot contain Hermes's entry separator.")
                if not text or len(text) > 50000:
                    raise ExperienceError("Memory entries cannot be empty or exceed 50,000 characters.")
                if _scan_memory_content(text):
                    raise ExperienceError("Hermes refused unsafe memory content. Review this entry.")
                replacement.append(text)
            if len(set(replacement)) != len(replacement):
                raise ExperienceError("Memory entries must be unique.")
        if len(ENTRY_DELIMITER.join(replacement)) > limit:
            raise ExperienceError(f"This document exceeds Hermes's {limit:,} character limit. Shorten or remove an entry.")
        return replacement, "Memory updated."
    # CAS occurs inside Hermes's own file lock, after its disk reread. Native
    # tools and household edits therefore cannot silently overwrite each other.
    result = store._mutate(target, update)
    if not result.get("success"):
        raise ExperienceError("Hermes refused this memory edit because its on-disk content needs review in the native dashboard.", 409)
    return profile_memory(profile)


def preview_schedule(profile, schedule):
    from cron.jobs import parse_schedule, compute_next_run
    from hermes_time import now, get_timezone
    if not isinstance(schedule, str) or not 1 <= len(schedule) <= 500:
        raise ExperienceError("Enter a schedule.")
    try:
        parsed = parse_schedule(schedule)
        anchor = None
        values = []
        for _ in range(3):
            value = compute_next_run(parsed, anchor)
            if not value or value in values:
                break
            values.append(value)
            anchor = value
            if parsed["kind"] == "once":
                break
    except ValueError:
        raise ExperienceError("Hermes could not parse this schedule. Use a duration, five-field cron expression, or ISO date and time.") from None
    if not values:
        raise ExperienceError("This schedule has no future run. Check its date and Hermes timezone.")
    zone = get_timezone() or now().tzinfo
    return dict(botId=profile, schedule=schedule, timezone=str(zone), nextRuns=values, kind=parsed["kind"])


def routine_results(data):
    """Read only this profile's native run sessions and cron output documents.

    The dashboard's cross-profile owner fallback is inappropriate here. Keep the
    requested owner even after a one-time job has disappeared from jobs.json.
    """
    from hermes_cli.web_routers.cron import (
        _owner_home_scope, _open_session_db_for_profile, _call_cron_for_profile,
        _list_cron_output_runs, _reconcile_cron_runs, _cron_output_runs_dir)
    from hermes_cli.web_routers.sessions import _project_for_display
    from hermes_constants import get_hermes_home
    profile, job_id = data["profile"], data.get("routineId")
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", job_id):
        raise ExperienceError("Invalid routine ID.")
    with _owner_home_scope(profile):
        db = _open_session_db_for_profile(profile, read_only=True)
        try:
            sessions = db.list_cron_job_runs(job_id, limit=100, offset=0)
            job = _call_cron_for_profile(profile, "get_job", job_id)
            directory = _cron_output_runs_dir(profile, job_id)
            expected = get_hermes_home().resolve() / "cron" / "output" / job_id
            docs = _list_cron_output_runs(job, job_id, profile, 100) if directory.resolve() == expected else []
            # Native history previews follow symlinks. Keep those documents out
            # of both the picker and the output reader, including their previews.
            def safe_document(row):
                stem = row["id"].removeprefix(f"cron_output:{job_id}:")
                path = directory / (stem + ".md")
                if (stem == "latest" or re.fullmatch(r"exec:\d+", stem)) and not path.exists() and not path.is_symlink():
                    return True
                return bool(re.fullmatch(r"[A-Za-z0-9_-]{1,200}", stem) and path.is_file() and not path.is_symlink() and path.resolve().parent == expected)
            docs = [row for row in docs if safe_document(row)]
            rows = _reconcile_cron_runs(sessions, docs, 100)
            if data["operation"] == "routine_results":
                return [dict(id=row["id"], title=row.get("title") or "Routine run",
                    startedAt=datetime.datetime.fromtimestamp(row["started_at"], datetime.timezone.utc).isoformat() if row.get("started_at") else None,
                    preview=row.get("preview"), previewOnly=row.get("source") == "cron_output") for row in rows]
            result_id = data.get("resultId")
            row = next((row for row in rows if row["id"] == result_id), None)
            if row is None:
                raise ExperienceError("This run is no longer in the routine history. Refresh the results.", 404)
            if row.get("source") == "cron_output":
                stem = result_id.removeprefix(f"cron_output:{job_id}:")
                # A real document must be one of the native history's listed rows.
                # Synthetic ledger/status rows have no document and remain previews.
                if re.fullmatch(r"[A-Za-z0-9_-]{1,200}", stem):
                    directory = _cron_output_runs_dir(profile, job_id)
                    path = directory / (stem + ".md")
                    expected = get_hermes_home().resolve() / "cron" / "output" / job_id
                    if path.is_file() and not path.is_symlink() and directory.resolve() == expected and path.resolve().parent == expected:
                        with path.open(encoding="utf-8", errors="replace") as source:
                            text = source.read(500001)
                        if len(text) > 500000:
                            text = text[:500000] + "\n\n[Output truncated after 500,000 characters.]"
                        return dict(previewOnly=False, messages=[dict(id=result_id, role="assistant", text=text)])
                return dict(previewOnly=True, messages=[dict(id=result_id, role="system", text=row.get("preview") or row.get("title") or "No output document was saved.")])
            sid = db.resolve_resume_session_id(result_id)
            messages = db.get_messages(sid, limit=500, latest=True, include_ancestors=True)
            projected = _project_for_display(messages, inline_images=False)
            output = []
            for index, message in enumerate(projected):
                if message.get("role") != "assistant" or message.get("display_kind") == "hidden":
                    continue
                text = message.get("content", message.get("text", ""))
                if isinstance(text, list):
                    text = "\n".join(part.get("text", "") for part in text if isinstance(part, dict) and part.get("type") == "text")
                if isinstance(text, str) and text:
                    output.append(dict(id=str(message.get("id") or message.get("row_id") or index), role="assistant", text=text))
            if len(messages) == 500:
                output.insert(0, dict(id="history-limit", role="system", text="Showing the latest 500 transcript rows. Earlier output remains in Hermes."))
            return dict(previewOnly=False, messages=output)
        finally:
            db.close()


class RoutineRuns:
    def __init__(self, journal):
        self.journal = journal
        with journal.lock, journal.db:
            journal.db.execute("CREATE TABLE IF NOT EXISTS experience_runs(request_id TEXT PRIMARY KEY,profile TEXT NOT NULL,routine_id TEXT NOT NULL,actor TEXT NOT NULL,receipt TEXT NOT NULL)")
            rows = journal.db.execute("SELECT request_id,receipt FROM experience_runs").fetchall()
            for key, raw in rows:
                receipt = json.loads(raw)
                if receipt["status"] == "accepted":
                    receipt.update(status="uncertain", message="Hermes restarted during this trial. Review its canonical results before trying again.")
                    journal.db.execute("UPDATE experience_runs SET receipt=? WHERE request_id=?", (json.dumps(receipt), key))

    def lookup(self, data):
        with self.journal.lock:
            row = self.journal.db.execute("SELECT profile,routine_id,actor,receipt FROM experience_runs WHERE request_id=?", (data["requestId"],)).fetchone()
        if not row:
            return None
        if row[:3] != (data["profile"], data["routineId"], data["senderId"]):
            raise ExperienceError("This trial request ID belongs to a different routine or person.", 409)
        return json.loads(row[3])

    def reconcile(self, data):
        receipt = self.lookup(data)
        if receipt is None:
            return None
        if receipt.get("executionId") and receipt["status"] in ("accepted", "uncertain"):
            from hermes_cli.web_server_cron import _cron_profile_home, _cron_store_scope
            from cron.executions import get_execution
            _, home = _cron_profile_home(data["profile"])
            with _cron_store_scope(home):
                execution = get_execution(receipt["executionId"])
            if execution:
                receipt["ownerStatus"] = execution["status"]
                if execution["status"] in ("completed", "failed", "unknown"):
                    receipt.update(status={"completed": "completed", "failed": "failed", "unknown": "uncertain"}[execution["status"]],
                        finishedAt=execution.get("finished_at") or timestamp(),
                        message="Hermes finished this trial. Open View results to read its output." if execution["status"] == "completed" else "Review the native trial results before trying again.")
                with self.journal.lock, self.journal.db:
                    self.journal.db.execute("UPDATE experience_runs SET receipt=? WHERE request_id=? AND json_extract(receipt,'$.status') IN ('accepted','uncertain')", (json.dumps(receipt), data["requestId"]))
        return receipt

    def start(self, data):
        from hermes_cli.backend_retirement import retirement
        from hermes_cli.web_routers.cron import _call_cron_for_profile
        with self.journal.lock:
            previous = self.lookup(data)
            if previous:
                return previous
            if any(json.loads(row[0])["status"] == "accepted" for row in self.journal.db.execute(
                    "SELECT receipt FROM experience_runs WHERE profile=? AND routine_id=?", (data["profile"], data["routineId"]))):
                raise ExperienceError("This routine already has a trial running. Wait for its result.", 409)
            job = _call_cron_for_profile(data["profile"], "get_job", data["routineId"])
            if not job or job.get("id") != data["routineId"]:
                raise ExperienceError("Routine not found in this Hermes profile.", 404)
            if not retirement.acquire():
                raise ExperienceError("Hermes is being upgraded. Try this routine after maintenance.", 409)
            receipt = dict(requestId=data["requestId"], routineId=data["routineId"], botId=data["profile"], status="accepted", startedAt=timestamp(),
                message="Hermes accepted this trial. Open View results after it finishes.")
            try:
                with self.journal.db:
                    self.journal.db.execute("INSERT INTO experience_runs VALUES(?,?,?,?,?)", (data["requestId"], data["profile"], data["routineId"], data["senderId"], json.dumps(receipt)))
                worker = threading.Thread(target=self.execute, args=(dict(data), dict(job)), daemon=True, name="hermes-routine-trial")
                worker.start()
            except Exception:
                # Admission already recorded stays uncertain. Never resend it.
                with self.journal.db:
                    receipt.update(status="uncertain", message="The trial could not start reliably. Review before trying again.")
                    self.journal.db.execute("UPDATE experience_runs SET receipt=? WHERE request_id=?", (json.dumps(receipt), data["requestId"]))
                retirement.release()
                raise
            return receipt

    def execute(self, data, before):
        from hermes_cli.backend_retirement import retirement
        from hermes_cli.web_server_cron import _cron_profile_home, _cron_store_scope
        from cron.scheduler_provider import resolve_cron_scheduler
        from cron.executions import get_execution
        from cron import jobs
        from hermes_time import now
        status, message = "failed", "Hermes could not start this trial. Review the routine before trying again."
        try:
            _, home = _cron_profile_home(data["profile"])
            with _cron_store_scope(home):
                provider = resolve_cron_scheduler()
                if not callable(getattr(provider, "claim_fire", None)) or not callable(getattr(provider, "fire_claimed", None)):
                    raise ExperienceError("This Hermes scheduler cannot expose an owned trial receipt.", 409)
                paused = before.get("enabled") is False or before.get("state") == "paused"
                fields = ("name", "prompt", "schedule", "deliver", "context_from", "enabled_toolsets", "skill", "skills", "script", "no_agent", "model", "provider", "base_url", "workdir", "enabled", "state", "paused_at", "paused_reason", "next_run_at", "repeat")
                def admit(jobs_list, index, current):
                    if any(current.get(field) != before.get(field) for field in fields):
                        raise ExperienceError("The routine changed before trial admission. Review its current settings.", 409)
                    claimed = provider.claim_fire(data["routineId"], force=paused, manual=True)
                    if not isinstance(claimed, dict):
                        raise ExperienceError("The native scheduler already owns this routine.", 409)
                    if paused:
                        def restore(current_jobs, current_index, updated):
                            updated.update(enabled=False, state="paused", paused_at=now().isoformat(), paused_reason=before.get("paused_reason"))
                            jobs.save_jobs(current_jobs)
                        # Native claim_fire re-reads and persists under this same
                        # reentrant jobs lock. Read THAT new claim before saving
                        # the paused state, preserving its ownership token.
                        jobs._with_job(data["routineId"], restore)
                    return claimed
                # Follow the native lock order: per-job fire fence, then jobs
                # file lock. It is reentrant for claim_fire in the same thread.
                # Compare original settings, claim and restore pause atomically;
                # even an explicit native resume before this claim stays intact.
                claimed = jobs._under_fire_fence(data["routineId"], lambda: jobs._with_job(data["routineId"], admit))
                if not isinstance(claimed, dict):
                    raise ExperienceError("Hermes could not acquire this routine's trial ownership.", 409)
                # Never acquire the journal lock while holding native jobs locks:
                # another admission takes journal before reading the native job.
                with self.journal.lock, self.journal.db:
                    receipt = self.lookup(data)
                    receipt["executionId"] = claimed["execution_id"]
                    self.journal.db.execute("UPDATE experience_runs SET receipt=? WHERE request_id=?", (json.dumps(receipt), data["requestId"]))
                provider.fire_claimed(claimed, adapters=None, loop=None)
            # The native provider may detach a restart-safe worker. Its HTTP
            # return only proves dispatch; the durable execution ledger proves
            # completion. Keep maintenance admission reserved until that owner
            # reaches a terminal state, without holding the profile config lock.
            while True:
                with _cron_store_scope(home):
                    execution = get_execution(claimed["execution_id"])
                if execution is None:
                    status, message = "uncertain", "Hermes lost the native execution receipt. Review canonical results before trying again."
                    break
                native_status = execution.get("status")
                if native_status in ("completed", "failed", "unknown"):
                    status = {"completed": "completed", "failed": "failed", "unknown": "uncertain"}[native_status]
                    message = "Hermes finished this trial. Open the assistant for its results." if status == "completed" else "Hermes could not confirm a completed trial. Review the native results before trying again."
                    break
                time.sleep(.25)
        except ExperienceError as exc:
            message = str(exc)
        except Exception:
            status, message = "uncertain", "The native trial outcome is uncertain. Review canonical results before trying again."
        finally:
            try:
                with self.journal.lock, self.journal.db:
                    receipt = self.lookup(data)
                    receipt.update(status=status, finishedAt=timestamp(), message=message)
                    self.journal.db.execute("UPDATE experience_runs SET receipt=? WHERE request_id=?", (json.dumps(receipt), data["requestId"]))
            finally:
                retirement.release()



def history_receipt(journal, profile, lineage, native_row):
    """Resolve an exact user occurrence, including its native compaction clones."""
    if native_row is None or native_row.get("role") != "user":
        return None
    def read(ids):
        with journal.lock:
            return journal.db.execute("SELECT request_id,actor,COALESCE(run_id,request_id),attachments,input_text,stored_session FROM receipts WHERE profile=? AND stored_session IN (" + ",".join("?" for _ in lineage) + ") AND row_id IN (" + ",".join("?" for _ in ids) + ") ORDER BY created DESC LIMIT 1", (profile, *lineage, *ids)).fetchone()
    receipt = read([native_row["id"]])
    if receipt or not native_row.get("message_uid"):
        return receipt
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    db = _open_session_db_for_profile(profile, read_only=True)
    try:
        clones = db._read_all("SELECT id FROM messages WHERE message_uid=? AND role='user' AND (active=1 OR compacted=1) AND session_id IN (" + ",".join("?" for _ in lineage) + ")", (native_row["message_uid"], *lineage))
    finally:
        db.close()
    return read([row["id"] for row in clones]) if clones else None


def discovery(data, journal, projector):
    """Read native profile-owned history without opening or resuming a chat."""
    import asyncio
    from hermes_cli.web_routers import sessions, analytics
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    profile = data["profile"]
    operation = data["operation"]
    if operation == "search":
        query = data.get("query")
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 200:
            raise ExperienceError("Enter a search of up to 200 characters.")
        value = asyncio.run(sessions.search_sessions(q=query, limit=20, profile=profile, source=None, sources=None, exclude_sources=None))
        hits = [{"botId": profile, "botName": profile, "sessionId": row.get("session_id") or row["id"], "title": row.get("title") or "Conversation", "snippet": row.get("snippet") or row.get("preview") or ""} for row in value["results"]]
        # Attachment names belong to the existing admission/artifact journal;
        # native FTS does not index image-only attachment metadata.
        pattern = "%" + query.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        with journal.lock:
            files = journal.db.execute("SELECT r.stored_session AS sid,json_extract(f.value,'$.name') AS name FROM receipts r,json_each(r.attachments) f WHERE r.profile=? AND r.status='accepted' AND lower(json_extract(f.value,'$.name')) LIKE ? ESCAPE '\\' UNION ALL SELECT t.stored_session AS sid,json_extract(f.value,'$.name') AS name FROM tools t,json_each(t.artifacts) f WHERE t.profile=? AND lower(json_extract(f.value,'$.name')) LIKE ? ESCAPE '\\' LIMIT 40", (profile, pattern, profile, pattern)).fetchall()
        db = _open_session_db_for_profile(profile, read_only=True)
        try:
            known = {hit["sessionId"] for hit in hits}
            for row in files:
                try:
                    sid = sessions._timeline_session_id(db, row[0], profile)
                except __import__("fastapi").HTTPException:
                    continue
                if sid not in known:
                    known.add(sid)
                    hits.append({"botId": profile, "botName": profile, "sessionId": sid, "title": row[1] or "Attachment", "snippet": "Matching attachment name"})
        finally:
            db.close()
        return hits
    db = _open_session_db_for_profile(profile, read_only=True)
    try:
        if operation == "usage":
            days = data.get("days", 30)
            if days not in (7, 30, 90):
                raise ExperienceError("Choose a 7, 30 or 90 day period.")
            import time
            counts = db._read_one("SELECT COUNT(*) AS sessions, COUNT(actual_cost_usd) AS actual, COUNT(estimated_cost_usd) AS estimated FROM sessions WHERE started_at >= ?", (time.time() - days * 86400,))
            totals = analytics._get_usage_analytics(days=days, profile=profile)["totals"]
            return {"botId": profile, "days": days, "sessions": counts["sessions"], "inputTokens": (totals.get("total_input") or 0), "outputTokens": (totals.get("total_output") or 0), "actualCost": totals.get("total_actual_cost", 0) if counts["actual"] else None, "estimatedCost": totals.get("total_estimated_cost", 0) if counts["estimated"] else None, "partial": counts["actual"] < counts["sessions"], "notice": "Recorded main-session usage. Auxiliary calls and provider invoices may differ. Costs are unknown where Hermes did not record them."}
        sid = data.get("sessionId")
        offset = data.get("offset", 0)
        if not isinstance(sid, str) or not 1 <= len(sid) <= 200 or not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 100000:
            raise ExperienceError("Invalid history page.")
        sessions._timeline_session_id(db, sid, profile)
    finally:
        db.close()
    db = _open_session_db_for_profile(profile, read_only=True)
    try:
        resolved = sessions._timeline_session_id(db, sid, profile)
        lineage = db._resume_lineage_ids(resolved)
        raw = db.get_messages(resolved, limit=100, offset=offset, include_ancestors=True, include_compacted=True)
        for row in raw:
            row["_row_id"] = row["id"]
    finally:
        db.close()
    native_rows = projector(raw, profile_home=sessions._history_profile_home(profile), image_urls=False)
    # Read attribution from durable admission rows only. Historical reads never
    # adopt a canonical session, bind missing receipts, or replay native input.
    current_run = None
    # Recover only the nearest preceding *native* user in display order. A
    # later desktop turn breaks app attribution, even if it reuses a tool id.
    before = offset
    while before > 0:
        chunk_start = max(0, before - 100)
        db = _open_session_db_for_profile(profile, read_only=True)
        try:
            previous = db.get_messages(resolved, limit=before - chunk_start, offset=chunk_start, include_ancestors=True, include_compacted=True)
        finally:
            db.close()
        visible = projector([dict(row, _row_id=row["id"]) for row in previous], profile_home=sessions._history_profile_home(profile), image_urls=False)
        prior_user = next((row for row in reversed(visible) if row.get("role") == "user"), None)
        if prior_user is not None:
            prior = history_receipt(journal, profile, lineage, next((row for row in previous if row["id"] == prior_user.get("row_id")), None))
            if prior:
                current_run = prior[2]
            break
        before = chunk_start
    for message in native_rows:
        if message.get("role") == "user":
            current_run = None
        row = history_receipt(journal, profile, lineage, next((row for row in raw if row["id"] == message.get("row_id")), None))
        with journal.lock:
            if row:
                current_run = row[2]
                message["app_attachments"] = json.loads(row[3] or "[]")
                message["app_display_text"] = row[4] or ""
                message["app_sender_id"] = row[1]
            if message.get("role") == "tool" and current_run:
                records = journal.db.execute("SELECT result,artifacts FROM tools WHERE profile=? AND stored_session IN (" + ",".join("?" for _ in lineage) + ") AND tool_id=? AND run_id=? ORDER BY id", (profile, *lineage, message.get("tool_call_id"), current_run)).fetchall()
                matching = next((item for item in records if json.loads(item[0]) == message.get("app_tool_result")), None)
                if matching:
                    message["app_artifacts"] = json.loads(matching[1] or "[]")
    value = {"session_id": resolved, "messages": native_rows}
    native_ids = {row["id"]: row.get("message_uid") or str(row["id"]) for row in raw}
    rows = []
    for index, row in enumerate(value["messages"]):
        if row.get("display_kind") == "hidden":
            continue
        text = row.get("app_display_text", row.get("text", row.get("content", "")))
        if not isinstance(text, str):
            text = json.dumps(text)
        # Keep the native projector's attachment fields for the server's signed registrar.
        rows.append({**row, "id": str(native_ids.get(row.get("row_id")) or row.get("row_id") or row.get("id") or f"{sid}-{offset + index}"), "role": row.get("role", "system"), "text": text, "toolName": row.get("name"), **({"createdAt": __import__("datetime").datetime.fromtimestamp(row["timestamp"], __import__("datetime").timezone.utc).isoformat()} if isinstance(row.get("timestamp"), (float, int)) else {})})
    return {"botId": profile, "sessionId": value["session_id"], "messages": rows, "offset": offset, "hasMore": len(raw) == 100}


def install(web, journal, projector):
    if not callable(projector):
        raise TypeError("Native history renderer is required before installing experience routes.")
    from fastapi import Request
    from starlette.responses import JSONResponse
    from hermes_cli.web_routers._common import config_scoped_to_thread
    from hermes_cli.backend_retirement import retirement
    runs = RoutineRuns(journal)
    original_require_token = web._require_token
    def require_token(request):
        principal = getattr(request.state, "token_principal", None)
        if (request.scope.get("path") == "/api/agent-interface/experience"
                and getattr(request.state, "agent_interface_service_authenticated", False) is True
                and getattr(request.state, "token_authenticated", False) is True
                and getattr(principal, "provider", None) == "agent-interface-service"
                and getattr(principal, "principal", None) == "agent-interface"):
            return
        return original_require_token(request)
    web._require_token = require_token
    async def endpoint(request: Request):
        try:
            # This adapter is intentionally private. Original Google routes and
            # their token restrictions stay unchanged.
            if not getattr(request.state, "agent_interface_service_authenticated", False):
                raise ExperienceError("Private service authentication required.", 401)
            data = await request.json()
            if not isinstance(data, dict) or not isinstance(data.get("profile"), str):
                raise ExperienceError("Expected a profile experience request.")
            profile = data["profile"]
            operation = data.get("operation")
            if operation in ("search", "history", "usage"):
                result = await config_scoped_to_thread(profile, lambda: discovery(data, journal, projector))
            elif operation == "memory":
                result = await config_scoped_to_thread(profile, lambda: profile_memory(profile))
            elif operation == "preview":
                result = await config_scoped_to_thread(profile, lambda: preview_schedule(profile, data.get("schedule")))
            elif operation in ("routine_results", "routine_output"):
                result = await config_scoped_to_thread(profile, lambda: routine_results(data))
            elif operation in ("save_memory", "delete_memory"):
                with retirement.work() as admitted:
                    if not admitted:
                        raise ExperienceError("Hermes is being upgraded. Memory edits are paused.", 409)
                    result = await config_scoped_to_thread(profile, lambda: mutate_memory(data))
            elif operation in ("run", "run_receipt"):
                if not all(isinstance(data.get(key), str) and 1 <= len(data[key]) <= 200 for key in ("routineId", "requestId", "senderId")):
                    raise ExperienceError("Routine ID, request ID and person are required.")
                # Native config scope validates the profile before any receipt or
                # native scheduler operation, including background admission.
                result = await config_scoped_to_thread(profile, lambda: runs.start(data) if operation == "run" else runs.reconcile(data))
                if result is None:
                    raise ExperienceError("Trial receipt not found.", 404)
            else:
                raise ExperienceError("Unknown experience operation.")
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except __import__("fastapi").HTTPException as exc:
            return JSONResponse({"error": "History not found." if exc.status_code == 404 else "The native read failed."}, status_code=exc.status_code, headers={"Cache-Control": "no-store"})
        except ExperienceError as exc:
            return JSONResponse({"error": str(exc)}, status_code=exc.status, headers={"Cache-Control": "no-store"})
        except Exception:
            __import__("logging").getLogger(__name__).exception("Profile experience operation failed")
            return JSONResponse({"error": "Hermes could not complete this profile operation. Review its native configuration."}, status_code=502, headers={"Cache-Control": "no-store"})
    globals()["Request"] = Request
    web.app.add_api_route("/api/agent-interface/experience", endpoint, methods=["POST"])
