"""Profile memory and scheduler previews using Hermes's native stores and locks.

The adapter owns only duplicate-safe manual-trigger receipts. Memory, timezones,
job claims, agent execution and canonical delivery stay in Hermes.
"""
import asyncio
import contextlib
import copy
import datetime
import hashlib
import json
import re
import threading
import time
import uuid
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


class MemoryRefresh:
    """App-requested refreshes for canonical Bot Chats, never native tool writes.

    An intent is durable before the native CAS writes its replacement. A crash
    before its completion receipt conservatively refreshes at the next boundary.
    Neither status reads nor native memory drift create another refresh request.
    """
    def __init__(self, journal, server, sessions_for):
        self.journal, self.server, self.sessions_for = journal, server, sessions_for
        self.supported = all(callable(getattr(server, method, None)) for method in ("_invoke_agent", "_persist_live_session_system_prompt"))
        with journal.lock, journal.db:
            journal.db.executescript("""
                CREATE TABLE IF NOT EXISTS memory_refresh_edits(id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile TEXT NOT NULL, revision TEXT NOT NULL UNIQUE, state TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS memory_refresh_edit_profile ON memory_refresh_edits(profile,id);
                CREATE TABLE IF NOT EXISTS memory_refresh_sessions(profile TEXT NOT NULL, session_id TEXT NOT NULL,
                    revision TEXT, error TEXT, prompt_digest TEXT, PRIMARY KEY(profile,session_id));
            """)
            if "prompt_digest" not in {row[1] for row in journal.db.execute("PRAGMA table_info(memory_refresh_sessions)")}:
                journal.db.execute("ALTER TABLE memory_refresh_sessions ADD COLUMN prompt_digest TEXT")

    @contextlib.contextmanager
    def snapshot(self, store):
        # Lock both native documents in one fixed order while reloading/building.
        # Checked reads reject native load_from_disk's fail-open empty fallback.
        with contextlib.ExitStack() as locks:
            for target in ("memory", "user"):
                locks.enter_context(store._file_lock(store._path_for(target)))
            def read():
                values = []
                for target in ("memory", "user"):
                    raw, ok = store._read_raw_checked(store._path_for(target))
                    if not ok:
                        raise RuntimeError("Memory could not be read safely")
                    values.append((target, store.target_enabled(target), raw))
                return digest(values)
            yield read(), read

    def mutate(self, profile, store, target, update):
        """Stage only a validated app edit, inside the native memory CAS lock.

        There is no atomic transaction spanning native files and this journal.
        A prepared intent survives a process crash on either side of the write;
        an explicit refusal removes only its own intent. An exceptional write
        has an unknown outcome, so its intent remains recoverable.
        """
        revision = None
        def prepare(entries, limit):
            nonlocal revision
            replacement = update(entries, limit)
            revision = uuid.uuid4().hex
            with self.journal.lock, self.journal.db:
                self.journal.db.execute("INSERT INTO memory_refresh_edits(profile,revision,state) VALUES(?,?,'prepared')", (profile, revision))
            return replacement
        result = store._mutate(target, prepare)
        if not result.get("success"):
            self.cancel(revision)
        elif revision is not None:
            with self.journal.lock, self.journal.db:
                self.journal.db.execute("UPDATE memory_refresh_edits SET state='saved' WHERE revision=?", (revision,))
        return result

    def cancel(self, revision):
        if revision is not None:
            with self.journal.lock, self.journal.db:
                self.journal.db.execute("DELETE FROM memory_refresh_edits WHERE revision=?", (revision,))

    def latest(self, profile):
        with self.journal.lock:
            row = self.journal.db.execute("SELECT revision FROM memory_refresh_edits WHERE profile=? ORDER BY id DESC LIMIT 1", (profile,)).fetchone()
        return row[0] if row else None

    def acknowledgement(self, profile, sid):
        with self.journal.lock:
            return self.journal.db.execute("SELECT revision,error,prompt_digest FROM memory_refresh_sessions WHERE profile=? AND session_id=?", (profile, sid)).fetchone()

    def status(self, profile):
        revision = self.latest(profile)
        sessions = list(self.sessions_for(profile))
        applied = [self.acknowledgement(profile, session.get("session_key")) for session in sessions]
        waiting = [session for session, ack in zip(sessions, applied) if not ack or ack[0] != revision]
        failed = any(ack and ack[1] for ack in applied)
        busy = revision is not None and any(session.get("running") for session in waiting)
        state = "applied" if revision is None else "pending" if not self.supported or failed or busy else "next_turn" if waiting or not sessions else "applied"
        message = {
            "pending": "Saved in Hermes. Refresh pending. The active turn keeps its current memory; Hermes will retry at the next safe turn boundary." if busy else "Saved in Hermes. Refresh pending because the native prompt could not be refreshed. Reload after the next turn to check again.",
            "next_turn": "Saved in Hermes. Applies to the next turn. Existing chat history is preserved.",
            "applied": "Saved in Hermes. Applied to the current chat memory. Existing chat history is preserved." if revision else "Saved in Hermes. No app memory refresh is pending.",
        }[state]
        return dict(revision=revision or "", state=state, busy=busy, message=message)

    def before_turn(self, profile, session, agent):
        """Run at native invocation, only for the app's canonical Bot Chat.

        Acknowledged restored agents retain native prompt restore and caching.
        User, queued steering and goal followups share this boundary; approvals,
        native task roots, tool state and history are never replaced.
        """
        if not any(candidate is session for candidate in self.sessions_for(profile)):
            return
        revision = self.latest(profile)
        if revision is None:
            return
        sid = session.get("session_key")
        old_agent = old_store = None
        try:
            db = getattr(agent, "_session_db", None)
            if not sid or session.get("agent") is not agent or not callable(getattr(db, "get_session", None)):
                raise RuntimeError("Native memory prompt cannot be verified")
            ack = self.acknowledgement(profile, sid)
            if ack and ack[0] == revision:
                row = db.get_session(getattr(agent, "session_id", None) or sid)
                prompt = (row or {}).get("system_prompt")
                if isinstance(prompt, str) and prompt and digest(prompt) == ack[2]:
                    # A restore may have a stale in-memory cache. Let Hermes restore
                    # the verified persisted bytes rather than rebuilding the prefix.
                    cached = getattr(agent, "_cached_system_prompt", None)
                    if cached is not None and cached != prompt:
                        agent._cached_system_prompt = None
                        agent._cached_system_prompt_static = None
                    if ack[1]:
                        self.clear_error(profile, sid)
                    return
                # Native model switches can rewrite the persisted prompt. Its
                # old digest no longer acknowledges this prompt; rebuild and
                # verify below, then replace the receipt for the same app edit.
            store = getattr(agent, "_memory_store", None)
            persist = getattr(self.server, "_persist_live_session_system_prompt", None)
            if store is None or not all(callable(fn) for fn in (
                    getattr(agent, "_invalidate_system_prompt", None), getattr(agent, "_build_system_prompt", None),
                    persist, getattr(db, "update_system_prompt", None))):
                raise RuntimeError("Native memory refresh methods are unavailable")
            with self.snapshot(store) as (snapshot, reread):
                # The pending app revision is independent of disk content. Load
                # the latest native files, including tool writes since the edit.
                old_store = copy.deepcopy(vars(store))
                old_agent = {key: value for key, value in vars(agent).items() if key.startswith(("_cached_system_prompt", "_plugin_system_prompt_sections", "_static_rebuild_failed"))}
                agent._invalidate_system_prompt()
                persist(session)
                prompt = getattr(agent, "_cached_system_prompt", None)
                row = db.get_session(getattr(agent, "session_id", None) or sid)
                if not isinstance(prompt, str) or not prompt or not row or row.get("system_prompt") != prompt or reread() != snapshot:
                    raise RuntimeError("Native memory prompt persistence was not verified")
                with self.journal.lock, self.journal.db:
                    self.journal.db.execute("INSERT INTO memory_refresh_sessions(profile,session_id,revision,error,prompt_digest) VALUES(?,?,?,NULL,?) ON CONFLICT(profile,session_id) DO UPDATE SET revision=excluded.revision,error=NULL,prompt_digest=excluded.prompt_digest", (profile, sid, revision, digest(prompt)))
        except Exception:
            if old_agent is not None:
                for key in list(vars(agent)):
                    if key.startswith(("_cached_system_prompt", "_plugin_system_prompt_sections", "_static_rebuild_failed")):
                        delattr(agent, key)
                vars(agent).update(old_agent)
                vars(store).clear()
                vars(store).update(old_store)
            with self.journal.lock, self.journal.db:
                self.journal.db.execute("INSERT INTO memory_refresh_sessions(profile,session_id,revision,error) VALUES(?,?,NULL,?) ON CONFLICT(profile,session_id) DO UPDATE SET error=excluded.error", (profile, sid or "", "Native memory refresh pending"))
            __import__("logging").getLogger(__name__).warning("Native memory refresh pending for profile %s", profile, exc_info=True)

    def clear_error(self, profile, sid):
        with self.journal.lock, self.journal.db:
            self.journal.db.execute("UPDATE memory_refresh_sessions SET error=NULL WHERE profile=? AND session_id=? AND error IS NOT NULL", (profile, sid))


def profile_memory(profile, refresh=None):
    from tools.memory_tool import load_on_disk_store
    store = load_on_disk_store()
    return dict(botId=profile, profile=profile, scope="profile", owner="Hermes",
        documents=[memory_document(store, profile, target) for target in ("memory", "user")],
        **(dict(refresh=refresh.status(profile)) if refresh else {}),
        notice="These memories belong to this shared Hermes profile. Saved edits refresh at the next safe turn boundary without changing chat history.")


def mutate_memory(data, refresh=None):
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
    result = refresh.mutate(profile, store, target, update) if refresh else store._mutate(target, update)
    if not result.get("success"):
        raise ExperienceError("Hermes refused this memory edit because its on-disk content needs review in the native dashboard.", 409)
    return profile_memory(profile, refresh)


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


def store_unwritten(profile):
    """Whether no conversation or run has written this profile's store yet.

    Hermes writes a profile's store with its first session. Since the unified
    runtime, a read no longer creates it and refuses instead, so callers answer
    "no history" themselves.
    """
    from hermes_cli.web_server_sessions import _session_db_path_for_profile
    store = Path(_session_db_path_for_profile(profile))
    return not store.is_file() or store.stat().st_size == 0


def routine_results(data):
    """Read only this profile's native run sessions and cron output documents.

    The dashboard's cross-profile owner fallback is inappropriate here. Keep the
    requested owner even after a one-time job has disappeared from jobs.json.
    """
    from inspect import signature
    from hermes_cli.web_routers.cron import (
        _owner_home_scope, _open_session_db_for_profile, _call_cron_for_profile,
        _list_cron_output_runs, _reconcile_cron_runs, _cron_output_runs_dir)
    from hermes_cli.web_routers.sessions import _project_for_display
    from hermes_constants import get_hermes_home
    profile, job_id = data["profile"], data.get("routineId")
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", job_id):
        raise ExperienceError("Invalid routine ID.")
    # Script-only runs write output documents without session history.
    unwritten = store_unwritten(profile)
    with _owner_home_scope(profile):
        db = None if unwritten else _open_session_db_for_profile(profile, read_only=True)
        try:
            sessions = [] if db is None else db.list_cron_job_runs(job_id, limit=100, offset=0)
            job = _call_cron_for_profile(profile, "get_job", job_id)
            directory = _cron_output_runs_dir(profile, job_id)
            expected = get_hermes_home().resolve() / "cron" / "output" / job_id
            native_runs = _list_cron_output_runs(job, job_id, profile, 100) if directory.resolve() == expected else []
            # New Hermes returns the execution ledger beside the documents.
            docs, attempts = native_runs if isinstance(native_runs, tuple) else (native_runs, [])
            # Native history previews follow symlinks. Keep those documents out
            # of both the picker and the output reader, including their previews.
            def safe_document(row):
                stem = row["id"].removeprefix(f"cron_output:{job_id}:")
                path = directory / (stem + ".md")
                if (stem == "latest" or re.fullmatch(r"exec:\d+", stem)) and not path.exists() and not path.is_symlink():
                    return True
                return bool(re.fullmatch(r"[A-Za-z0-9_-]{1,200}", stem) and path.is_file() and not path.is_symlink() and path.resolve().parent == expected)
            docs = [row for row in docs if safe_document(row)]
            arguments = (sessions, docs, attempts, job_id, 100)
            try:
                signature(_reconcile_cron_runs).bind(*arguments)
            except TypeError:
                arguments = (sessions, docs, 100)
            rows = _reconcile_cron_runs(*arguments)
            # Ledger reconciliation can add metadata-only cron_output rows.
            rows = [row for row in rows if row.get("source") != "cron_output" or safe_document(row)]
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
            if db is None:
                raise ExperienceError("This run is no longer in the routine history. Refresh the results.", 404)
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
            if db is not None:
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


def history_pointer(db, sid, identities, *, projector, profile_home):
    """Find a visible stable identity in native display order, including compression ancestors."""
    identities = {str(value) for value in identities}
    lineage = db._resume_lineage_ids(sid)
    # FTS and the live transcript can name an older representative row. Its immutable
    # message UID survives compression and maps onto the current display generation.
    for identity in list(identities):
        row = db._read_one("SELECT message_uid FROM messages WHERE id=? AND session_id IN (" + ",".join("?" for _ in lineage) + ")", (identity, *lineage))
        if row and row["message_uid"]:
            identities.add(row["message_uid"])
    # Native compression merges the whole lineage before applying a page. Read it
    # once so locating a recent reply does not repeat that work for every page.
    rows = db.get_messages(sid, include_ancestors=True, include_compacted=True)
    for index, candidate in enumerate(rows):
        if str(candidate["id"]) not in identities and candidate.get("message_uid") not in identities:
            continue
        offset = index // 100 * 100
        raw = rows[offset:offset + 100]
        visible = projector([dict(row, _row_id=row["id"]) for row in raw], profile_home=profile_home, image_urls=False)
        if any(row.get("row_id") == candidate["id"] and row.get("display_kind") != "hidden" for row in visible):
            return {"messageId": str(candidate.get("message_uid") or candidate["id"]), "offset": offset}
    return None


def enrich_search_pointers(db, hits, files, sessions, profile, query):
    """Optional cheap candidates; opening a hit resolves its current visible page."""
    try:
        prefix_query = " ".join(token if token.startswith('"') or token.endswith("*") else token + "*" for token in __import__("re").findall(r'"[^"]*"|\S+', query.strip()))
        matches = db.search_messages(query=prefix_query, fields=("id", "session_id"), limit=100)
    except Exception:
        matches = []  # Older native search contracts still return useful session hits.
    for hit in hits:
        try:
            resolved = sessions._timeline_session_id(db, hit["sessionId"], profile)
            lineage = set(db._resume_lineage_ids(resolved))
            identities = [row["id"] for row in matches if row["session_id"] in lineage]
            identities += [row[2] for row in files if row[0] in lineage and row[2] is not None]
            if identities:
                hit["messageId"] = str(identities[0])
                continue
            tools = {row[3] for row in files if row[0] in lineage and row[3] is not None}
            if tools:
                # Reused tool IDs must not point an attachment hit at another run.
                rows = db._read_all("SELECT COALESCE(message_uid,CAST(id AS TEXT)) AS identity FROM messages WHERE session_id IN (" + ",".join("?" for _ in lineage) + ") AND tool_call_id IN (" + ",".join("?" for _ in tools) + ") AND (active=1 OR compacted=1) GROUP BY COALESCE(message_uid,CAST(id AS TEXT)) LIMIT 2", (*lineage, *tools))
                if len(rows) == 1:
                    hit["messageId"] = str(rows[0]["identity"])
        except Exception:
            continue  # A retired session or optional pointer failure cannot erase search hits.


def discovery(data, journal, projector):
    """Read native profile-owned history without opening or resuming a chat."""
    import asyncio
    from hermes_cli.web_routers import sessions, analytics
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    profile = data["profile"]
    operation = data["operation"]
    unwritten = store_unwritten(profile)
    if operation == "search":
        query = data.get("query")
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 200:
            raise ExperienceError("Enter a search of up to 200 characters.")
        if unwritten:
            return []
        value = asyncio.run(sessions.search_sessions(q=query, limit=20, profile=profile, source=None, sources=None, exclude_sources=None))
        hits = [{"botId": profile, "botName": profile, "sessionId": row.get("session_id") or row["id"], "title": row.get("title") or "Conversation", "snippet": row.get("snippet") or row.get("preview") or ""} for row in value["results"]]
        # Attachment names belong to the existing admission/artifact journal;
        # native FTS does not index image-only attachment metadata.
        pattern = "%" + query.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        with journal.lock:
            files = journal.db.execute("SELECT r.stored_session AS sid,json_extract(f.value,'$.name') AS name,r.row_id AS message_row_id,NULL AS tool_id FROM receipts r,json_each(r.attachments) f WHERE r.profile=? AND r.status='accepted' AND lower(json_extract(f.value,'$.name')) LIKE ? ESCAPE '\\' UNION ALL SELECT t.stored_session AS sid,json_extract(f.value,'$.name') AS name,NULL AS message_row_id,t.tool_id AS tool_id FROM tools t,json_each(t.artifacts) f WHERE t.profile=? AND lower(json_extract(f.value,'$.name')) LIKE ? ESCAPE '\\' LIMIT 40", (profile, pattern, profile, pattern)).fetchall()
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
            enrich_search_pointers(db, hits, files, sessions, profile, query)
        finally:
            db.close()
        return hits
    usage_notice = "Recorded main-session usage. Auxiliary calls and provider invoices may differ. Costs are unknown where Hermes did not record them."
    if operation == "usage" and data.get("days", 30) not in (7, 30, 90):
        raise ExperienceError("Choose a 7, 30 or 90 day period.")
    sid = data.get("sessionId")
    offset = data.get("offset", 0)
    if operation != "usage" and (not isinstance(sid, str) or not 1 <= len(sid) <= 200 or not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 100000):
        raise ExperienceError("Invalid history page.")
    if unwritten:
        if operation == "usage":
            return {"botId": profile, "days": data.get("days", 30), "sessions": 0, "inputTokens": 0, "outputTokens": 0, "actualCost": None, "estimatedCost": None, "partial": False, "notice": usage_notice}
        raise ExperienceError("History not found.", 404)
    db = _open_session_db_for_profile(profile, read_only=True)
    try:
        if operation == "usage":
            days = data.get("days", 30)
            import time
            counts = db._read_one("SELECT COUNT(*) AS sessions, COUNT(actual_cost_usd) AS actual, COUNT(estimated_cost_usd) AS estimated FROM sessions WHERE started_at >= ?", (time.time() - days * 86400,))
            totals = analytics._get_usage_analytics(days=days, profile=profile)["totals"]
            return {"botId": profile, "days": days, "sessions": counts["sessions"], "inputTokens": (totals.get("total_input") or 0), "outputTokens": (totals.get("total_output") or 0), "actualCost": totals.get("total_actual_cost", 0) if counts["actual"] else None, "estimatedCost": totals.get("total_estimated_cost", 0) if counts["estimated"] else None, "partial": counts["actual"] < counts["sessions"], "notice": usage_notice}
        sessions._timeline_session_id(db, sid, profile)
    finally:
        db.close()
    db = _open_session_db_for_profile(profile, read_only=True)
    try:
        resolved = sessions._timeline_session_id(db, sid, profile)
        lineage = db._resume_lineage_ids(resolved)
        target = None
        if data.get("messageId") is not None:
            if not isinstance(data["messageId"], str) or not 1 <= len(data["messageId"]) <= 200:
                raise ExperienceError("Invalid message identity.")
            target = history_pointer(db, resolved, [data["messageId"]], projector=projector, profile_home=sessions._history_profile_home(profile))
            if target is None:
                raise ExperienceError("The original message is no longer available in Hermes.", 404)
            offset = target["offset"]
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
    prior_prompt = None
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
            prior_prompt = dict(prior_user)
            prior = history_receipt(journal, profile, lineage, next((row for row in previous if row["id"] == prior_user.get("row_id")), None))
            if prior:
                current_run = prior[2]
                prior_prompt["app_sender_id"] = prior[1]
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
    return {"botId": profile, "sessionId": value["session_id"], "messages": rows, "offset": offset, "hasMore": len(raw) == 100, **({"targetMessageId": target["messageId"]} if target else {}), **({"app_prior_prompt": prior_prompt} if prior_prompt else {})}


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
                result = await config_scoped_to_thread(profile, lambda: profile_memory(profile, getattr(journal, "memory_refresh", None)))
            elif operation == "preview":
                result = await config_scoped_to_thread(profile, lambda: preview_schedule(profile, data.get("schedule")))
            elif operation in ("routine_results", "routine_output"):
                result = await config_scoped_to_thread(profile, lambda: routine_results(data))
            elif operation in ("save_memory", "delete_memory"):
                with retirement.work() as admitted:
                    if not admitted:
                        raise ExperienceError("Hermes is being upgraded. Memory edits are paused.", 409)
                    result = await config_scoped_to_thread(profile, lambda: mutate_memory(data, getattr(journal, "memory_refresh", None)))
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
