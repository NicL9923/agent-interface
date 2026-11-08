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


def _epoch(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) or None
    if isinstance(value, str) and value.strip():
        try:
            return datetime.datetime.fromisoformat(value.strip()).timestamp()
        except ValueError:
            return None
    return None


def _iso(value):
    at = _epoch(value)
    return datetime.datetime.fromtimestamp(at, datetime.timezone.utc).isoformat() if at else None


# Hermes job and ledger words, normalized for the app. A delivery failure still ran.
# A run stopped on request, or one Hermes skipped while it was off, is neither a success nor a failure.
# A trial's native execution states that end it. Stop run cancels one, which must end the
# trial's wait and release its maintenance reservation; it reads as a failed trial with its own message.
_TRIAL_OUTCOME = {"completed": "completed", "failed": "failed", "cancelled": "failed", "unknown": "uncertain"}
# Attempts that ended, which a run's history row names exactly (exec:N). A stopped or missed one ended too.
_FINISHED_ATTEMPTS = ("completed", "failed", "cancelled", "missed")
_LEDGER_STATUS = {"completed": "succeeded", "failed": "failed", "claimed": "running", "running": "running",
                  "cancelled": "stopped", "missed": "missed"}
_JOB_STATUS = {"ok": "succeeded", "delivery_queued": "succeeded", "delivery_failed": "succeeded",
               "error": "failed", "failed": "failed", "interrupted": "failed", "blocked_config": "failed",
               "cancelled": "stopped", "missed": "missed"}
# How long a never-closed session without a ledger counts as live, as Hermes's own is_active.
_ACTIVE_SECONDS = 300.0


def routine_ledger(job_id):
    """This job's execution attempts by ID, and its live in-flight attempt, or nothing on Hermes
    without the ledger. Call inside the owner's home scope."""
    try:
        from cron.executions import list_executions
        rows = {str(row.get("id")): row for row in list_executions(job_id=job_id, limit=100) if isinstance(row, dict) and row.get("id")}
    except Exception:
        return {}, None
    try:
        from cron.executions import live_inflight_execution
        live = live_inflight_execution(job_id)
    except Exception:
        live = None
    return rows, live if isinstance(live, dict) else None


def run_outcome(row, attempts, ledger, job, newest, now=None):
    """One reconciled run's normalized status and times.

    A unified-runtime session names its execution; a legacy session started just after its claim;
    a script-only document was written inside its attempt's window, as `_execution_contains` reads
    it; `exec:N` rows index the native attempts list. Without a ledger, only the newest run can borrow
    the job's own last status, and only when the job's last run time falls inside it. Anything
    else is `unknown`, never a guess.
    """
    now = time.time() if now is None else now
    started, ended = _epoch(row.get("started_at")), _epoch(row.get("ended_at"))
    stem = str(row.get("id") or "").rsplit(":", 1)[-1] if row.get("source") == "cron_output" else None
    attempt = None
    if row.get("source") != "cron_output":
        attempt = ledger.get(str(row.get("cron_execution_id") or "")) if row.get("cron_execution_id") else None
        if attempt is None and not row.get("cron_execution_id") and started:
            # Newest first: the latest claim at or just before the session began.
            attempt = next((a for a in sorted(ledger.values(), key=lambda a: _epoch(a.get("claimed_at")) or 0, reverse=True)
                            if (_epoch(a.get("claimed_at")) or 0) <= started + 5), None)
            if attempt is not None and _epoch(attempt.get("finished_at")) and started > _epoch(attempt.get("finished_at")):
                attempt = None
    elif row.get("id", "").endswith(":running"):
        attempt = ledger.get(str(row.get("execution_id") or ""))
    elif re.fullmatch(r"\d+", stem or "") and ":exec:" in row.get("id", ""):
        # Native `exec:N` is N's position in the whole attempts list, unknown attempts included.
        index = int(stem)
        picked = attempts[index] if index < len(attempts) and isinstance(attempts[index], dict) else None
        if picked is not None and picked.get("status") in _FINISHED_ATTEMPTS:
            attempt = ledger.get(str(picked.get("id"))) or picked
    elif started and stem != "latest":
        candidates = []
        for a in attempts:
            claimed, finished = _epoch(a.get("claimed_at")), _epoch(a.get("finished_at"))
            # Only runs that wrote a result pair by time here. Hermes pairs each document with one
            # attempt; a stopped run overlapping a finished one would otherwise take its document.
            if a.get("status") not in ("completed", "failed") or claimed is None or started + 0.001 < int(claimed):
                continue
            if finished is not None and started > finished + 300:
                continue
            candidates.append((finished is not None and started > finished, -claimed, a))
        if candidates:
            chosen = min(candidates, key=lambda c: c[:2])[2]
            attempt = ledger.get(str(chosen.get("id"))) or chosen
    status, delivery_failed, error = "unknown", False, None
    if attempt is not None:
        status = _LEDGER_STATUS.get(str(attempt.get("status") or ""), "unknown")
        delivery_failed = attempt.get("delivery_outcome") == "failed"
        error = str(attempt.get("error") or "").strip() or None
        if row.get("source") == "cron_output":
            started = _epoch(attempt.get("claimed_at")) or started
        ended = _epoch(attempt.get("finished_at")) or ended
    elif row.get("source") != "cron_output" and ended is None:
        last = _epoch(row.get("last_active")) or started
        status = "running" if last and now - last < _ACTIVE_SECONDS else "unknown"
    if status == "unknown" and newest and isinstance(job, dict):
        last_run = _epoch(job.get("last_run_at"))
        known = _JOB_STATUS.get(str(job.get("last_status") or ""))
        end = ended or _epoch(row.get("last_active")) or started
        if known and last_run and started and started - 300 <= last_run <= (end or started) + 300:
            status = known
            delivery_failed = job.get("last_status") == "delivery_failed"
            error = str(job.get("last_error") or "").strip() or None if known == "failed" else None
    if row.get("source") == "cron_output" and status != "running" and ended is None:
        # A script document is written as its run finishes.
        ended = started
    if status == "running":
        ended = None
    return dict(status=status, startedAt=_iso(started), finishedAt=_iso(ended),
        deliveryFailed=delivery_failed, error=error[:500] if error and status == "failed" else None)


MAX_ACCOUNT_ROUTES = 8
MAX_ACCOUNTS = 20
# Hermes's usage lines end with CLI instructions such as "/usage reset" or "/topup". The app offers its
# own actions, so those lines are dropped rather than shown as commands nobody can type here.
_CLI_HINTS = ("/usage", "/topup", "(or run", "Top up via", "Top up:")
_ACCOUNT_KEY = re.compile(r"^[0-9a-f]{32}$")
_REQUEST_ID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# A token this close to expiry is refreshed before it is used, rather than retried after a 401.
_EXPIRY_MARGIN_S = 120
# Hermes's own reset messages can quote the provider's response, so the app sends only these.
_RESET_MESSAGES = {
    "reset": "ChatGPT reset this account's limits.",
    "nothing_to_reset": "ChatGPT reports nothing to reset. No reset was spent.",
    "no_credit": "ChatGPT reports no banked reset on this account.",
    "already_redeemed": "This reset was already used. No other reset was spent.",
    "not_exhausted": "No limit is used up yet, so Hermes did not spend a reset.",
    "no_credits_banked": "This account has no banked resets.",
    "unavailable": "ChatGPT did not confirm the reset. Refresh to see whether it went through before trying again.",
    "uncertain": "ChatGPT did not answer after the reset was sent. Try again: it goes as the same request, so it cannot spend a second reset.",
}
# What ChatGPT's consume answers that settle a request; anything else leaves it uncertain.
_CONSUME_ANSWERS = ("reset", "nothing_to_reset", "no_credit", "already_redeemed")
_account_locks = {}
_account_locks_guard = threading.Lock()


def _digest(*parts):
    return hashlib.sha256("\0".join(("wildbots-account", *parts)).encode()).hexdigest()[:32]


def _hermes(module, name):
    """A Hermes helper that older revisions may not have, or None."""
    try:
        return getattr(__import__(module, fromlist=[name]), name)
    except (ImportError, AttributeError):
        return None


def _account_routes():
    """(provider, role, base_url, explicit key) for the main route, then Hermes's effective fallback chain.

    "auto" resolves the way Hermes picks a provider, without selecting a credential. A fallback entry
    keeps its own base URL and inline or ``key_env`` key, as the fallback client uses them.
    """
    from hermes_cli.config import load_config_readonly
    from hermes_cli.runtime_provider import resolve_requested_provider
    config = load_config_readonly()
    main = resolve_requested_provider(None)
    if main == "auto":
        resolve = _hermes("hermes_cli.auth", "resolve_provider")
        try:
            main = resolve("auto") if resolve else ""
        except Exception:
            main = ""
    routes = [(main, "main", None, None)]
    chain = _hermes("hermes_cli.fallback_config", "get_fallback_chain")
    entry_key = _hermes("hermes_cli.fallback_config", "resolve_entry_api_key")
    if chain:
        entries = chain(config)
    else:
        legacy = config.get("fallback_model")
        entries = [entry for entry in (legacy if isinstance(legacy, list) else [legacy]) if isinstance(entry, dict)]
    for entry in entries:
        base_url = str(entry.get("base_url") or "").strip().rstrip("/") or None
        key = entry_key(entry) if entry_key else (str(entry.get("api_key") or "").strip() or None)
        routes.append((entry.get("provider"), "fallback", base_url, key))
    found = []
    for provider, role, base_url, key in routes:
        provider = provider.strip().lower() if isinstance(provider, str) else ""
        if provider and provider != "auto" and len(provider) <= 100:
            found.append((provider, role, base_url, key))
    return found[:MAX_ACCOUNT_ROUTES]


def _identity(provider, token):
    """Hermes's account identity for a credential: the decoded ChatGPT principal, else a token fingerprint."""
    if provider == "openai-codex":
        principal_of = _hermes("agent.credential_pool", "_codex_principal_identity")
        principal = principal_of(token) if principal_of else None
        if principal:
            return f"codex:{principal[0]}:{principal[1]}"
    return "fp:" + hashlib.sha256(token.encode()).hexdigest()[:16]


def _route_base(provider, base_url):
    if provider == "openai-codex":
        route = _hermes("hermes_cli.auth_codex", "_codex_pool_route_base_url")
        if route:
            return route(base_url)
    return base_url or None


def _credentials(provider, base_url, explicit):
    """Each credential a route can run on, read from the pool without selecting, rotating or refreshing one."""
    if explicit:
        return [(explicit, base_url, False)]
    from agent.credential_pool import STATUS_DEAD, load_pool
    try:
        entries = load_pool(provider).entries()
    except Exception:
        return []
    found = []
    for entry in entries:
        token = str(getattr(entry, "runtime_api_key", "") or "").strip()
        if token and getattr(entry, "last_status", None) != STATUS_DEAD:
            found.append((token, base_url or getattr(entry, "runtime_base_url", None), True))
    return found


def _accounts():
    """This profile's accounts, one per provider account, with the exact credential each is read and spent with.

    Several credentials Hermes identifies as one account are one account. A route with no usable credential
    still appears, so the app can say why it shows nothing. Nous Portal is read through its account endpoint,
    which finds its own login, so it is one account per profile.
    """
    accounts = {}
    for provider, role, base_url, explicit in _account_routes():
        if provider == "nous":
            # The Portal login is found when it is read, so until then the account is this profile's.
            from hermes_constants import get_hermes_home
            found = [dict(key=_digest("nous", "portal", str(get_hermes_home().resolve())), provider="nous", role=role, token=None, base_url=None, identity=None, pooled=False)]
        else:
            found = []
            for token, base, pooled in _credentials(provider, base_url, explicit):
                identity = _identity(provider, token)
                # A pooled ChatGPT credential goes to its pool route; an explicit fallback key goes where the fallback names.
                route = _route_base(provider, base) if pooled else base
                found.append(dict(key=_digest(provider, (route or "").lower(), identity), provider=provider, role=role,
                                  token=token, base_url=route, identity=identity, pooled=pooled))
            if not found:
                found = [dict(key=_digest(provider, "none", base_url or ""), provider=provider, role=role, token=None, base_url=None, identity=None, pooled=False)]
        # The main route comes first, so an account it shares with a fallback keeps the main role.
        for account in found:
            accounts.setdefault(account["key"], account)
    return list(accounts.values())[:MAX_ACCOUNTS]


def account_list():
    return dict(accounts=[dict(key=row["key"], provider=row["provider"], role=row["role"]) for row in _accounts()])


def _account_for(key):
    if not isinstance(key, str) or not _ACCOUNT_KEY.match(key):
        raise ExperienceError("Invalid account.")
    for account in _accounts():
        if account["key"] == key:
            return account
    raise ExperienceError("This assistant no longer uses that account.", 404)


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and value not in (float("inf"), float("-inf"))


def _usage_document(provider, key, snapshot, reason, transient=False):
    """The app's account shape. ``transient`` marks a failed read the app should try again soon, not keep."""
    if snapshot is None:
        return dict(key=key, provider=provider, plan=None, title="Account limits", fetchedAt=timestamp(), windows=[], details=[],
                    unavailableReason=reason, bankedResets=0, identity=None, transient=transient)
    windows = []
    for window in getattr(snapshot, "windows", ())[:12]:
        used = getattr(window, "used_percent", None)
        reset = getattr(window, "reset_at", None)
        scope = getattr(window, "scope", "account")
        windows.append(dict(label=str(window.label)[:100], usedPercent=max(0.0, min(100.0, float(used))) if _finite(used) else None,
                            resetsAt=reset.isoformat() if isinstance(reset, datetime.datetime) else None,
                            detail=str(window.detail)[:300] if getattr(window, "detail", None) else None,
                            scope=scope if scope in ("account", "model") else "account"))
    raw = getattr(snapshot, "raw", None)
    banked = 0
    if provider == "openai-codex" and isinstance(raw, dict):
        count = (raw.get("rate_limit_reset_credits") or {}).get("available_count")
        banked = max(0, int(count)) if _finite(count) else 0
    # The banked-reset line ends in "/usage reset", so it goes with the CLI hints; bankedResets carries the count.
    details = [str(line)[:300] for line in getattr(snapshot, "details", ()) if not any(hint in str(line) for hint in _CLI_HINTS)][:12]
    identity = getattr(snapshot, "identity", None)
    fetched = getattr(snapshot, "fetched_at", None)
    unavailable = getattr(snapshot, "unavailable_reason", None)
    return dict(key=key, provider=provider, plan=str(snapshot.plan)[:100] if getattr(snapshot, "plan", None) else None,
                title=str(getattr(snapshot, "title", None) or "Account limits")[:100],
                fetchedAt=fetched.isoformat() if isinstance(fetched, datetime.datetime) else timestamp(),
                windows=windows, details=details, unavailableReason=str(unavailable)[:500] if unavailable else None,
                bankedResets=banked, identity=_digest(provider, "identity", identity) if isinstance(identity, str) and identity else None,
                transient=False)


def _expiring(token):
    """Whether a JWT access token expires within the margin. A token that is not a readable JWT is left as it is."""
    try:
        payload = token.split(".")[1]
        claims = json.loads(__import__("base64").urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return isinstance(claims.get("exp"), (int, float)) and claims["exp"] - time.time() < _EXPIRY_MARGIN_S
    except Exception:
        return False


def _fresh(account):
    """The account with a usable ChatGPT token, or None. An expiring pooled token is refreshed through the pool entry
    that holds that exact key, and the new token must decode to the same account. Nothing else is ever selected:
    Hermes's own usage resolver can fall back to another pool account when a refresh fails, so it is never used here.
    The destination stays the one the account was listed with.
    """
    if account["provider"] != "openai-codex" or not _expiring(account["token"]):
        return account
    if not account["pooled"]:
        return None
    from agent.credential_pool import load_pool
    try:
        entry = load_pool("openai-codex").try_refresh_matching(api_key_hint=account["token"])
    except Exception:
        return None
    token = str(getattr(entry, "runtime_api_key", "") or "").strip() if entry is not None else ""
    if not token or _identity("openai-codex", token) != account["identity"]:
        return None
    return dict(account, token=token)


def account_usage(data):
    """One account's limits, read with that account's own credential and never repaired on failure."""
    from agent import account_usage as usage
    account = _account_for(data.get("key"))
    provider, key = account["provider"], account["key"]
    if provider == "nous":
        # The Portal resolver finds a singleton, OAuth-pool or inference-key login itself.
        try:
            info = usage._fetch_portal_account(10.0)
        except Exception:
            return _usage_document(provider, key, None, "Hermes could not read this account's credits right now.", transient=True)
        if info is None or not getattr(info, "logged_in", False):
            return _usage_document(provider, key, None, "Sign in to Nous Portal in Hermes to see its credits.")
        document = _usage_document(provider, key, usage.build_nous_credits_snapshot(info), "Hermes could not read this account's credits right now.", transient=True)
        # Profiles signed in to one Portal account show as one account.
        who = getattr(info, "user_id", None) or getattr(info, "email", None)
        if isinstance(who, str) and who:
            document["identity"] = _digest("nous", "identity", who, str(getattr(info, "org_id", None) or ""))
        return document
    supported = _hermes("agent.account_usage_cache", "has_account_usage")
    if supported is None:
        # Hermes before the usage cache (late September 2026) has only the built-in fetchers.
        def supported(slug):
            return slug in getattr(usage, "_USAGE_FETCHERS", {})
    if not supported(provider):
        return _usage_document(provider, key, None, "This provider does not report plan limits or credits to Hermes.")
    if account["token"] is None:
        return _usage_document(provider, key, None, "Hermes has no signed-in account for this provider.")
    accepted = __import__("inspect").signature(usage.fetch_account_usage).parameters
    if provider == "openai-codex" and "read_only" not in accepted:
        # Without a read-only fetch, a 401 sends Hermes's resolver looking for any pooled ChatGPT account.
        return _usage_document(provider, key, None, "Update Hermes to read ChatGPT limits here.")
    fresh = _fresh(account)
    if fresh is None:
        return _usage_document(provider, key, None, "Hermes could not renew this ChatGPT sign-in. Sign in again in Hermes.", transient=True)
    options = dict(base_url=fresh["base_url"], api_key=fresh["token"])
    # Read-only: a failed read is reported, never repaired by Hermes picking or refreshing a credential itself.
    options.update({name: value for name, value in (("read_only", True), ("identity_id", fresh["identity"])) if name in accepted})
    snapshot = usage.fetch_account_usage(provider, **options)
    return _usage_document(provider, key, snapshot, "Hermes could not read this account's limits right now.", transient=snapshot is None)


class AccountResets:
    """Banked ChatGPT resets, spent at most once per request ID and once at a time per account.

    The request ID is ChatGPT's own ``redeem_request_id``, so ChatGPT answers a repeat with ``already_redeemed``
    instead of spending again. The receipt is written before ChatGPT is asked and marked ``sent`` before the
    consume goes out. A request with a recorded answer returns it. One that may have been consumed is only ever
    settled by sending that same consume again: a later preflight read or Hermes's guard never decides it,
    because the first consume may already have changed what they see.
    The spend uses Hermes's own guard and outcome mapping with the account's own token, never Hermes's
    resolver, which can fall back to another pooled account when a refresh fails.
    """
    def __init__(self, journal):
        self.journal = journal
        with journal.lock, journal.db:
            journal.db.execute("CREATE TABLE IF NOT EXISTS account_resets(request_id TEXT PRIMARY KEY,account TEXT NOT NULL,result TEXT,sent INTEGER NOT NULL DEFAULT 0)")
            if "sent" not in {row[1] for row in journal.db.execute("PRAGMA table_info(account_resets)")}:
                journal.db.execute("ALTER TABLE account_resets ADD COLUMN sent INTEGER NOT NULL DEFAULT 0")
                # A receipt from before this column with no answer may stand for a consume that went out.
                journal.db.execute("UPDATE account_resets SET sent=1 WHERE result IS NULL")

    def spend(self, data):
        request_id, force = data.get("requestId"), data.get("force")
        if not isinstance(request_id, str) or not _REQUEST_ID.match(request_id):
            raise ExperienceError("A reset needs its request ID.")
        if not isinstance(force, bool):
            raise ExperienceError("Choose whether to use a reset before the limit is reached.")
        account = _account_for(data.get("key"))
        if account["provider"] != "openai-codex" or account["token"] is None:
            raise ExperienceError("Only ChatGPT accounts have banked resets.", 409)
        owner = _digest(account["provider"], "identity", account["identity"])
        with _account_locks_guard:
            lock = _account_locks.setdefault(owner, threading.Lock())
        if not lock.acquire(blocking=False):
            raise ExperienceError("A reset for this account is already in progress.", 409)
        try:
            with self.journal.lock, self.journal.db:
                row = self.journal.db.execute("SELECT account,result,sent FROM account_resets WHERE request_id=?", (request_id,)).fetchone()
                if row is None:
                    self.journal.db.execute("INSERT INTO account_resets(request_id,account) VALUES(?,?)", (request_id, owner))
            if row is not None:
                if row[0] != owner:
                    raise ExperienceError("That request ID belongs to another reset.", 409)
                if row[1] is not None:
                    return json.loads(row[1])
            result = self._redeem(account, request_id, force, sent=bool(row and row[2]))
            if result["status"] != "uncertain":
                with self.journal.lock, self.journal.db:
                    self.journal.db.execute("UPDATE account_resets SET result=? WHERE request_id=?", (json.dumps(result), request_id))
            return result
        finally:
            lock.release()

    @staticmethod
    def _result(status, available=0, windows=0):
        """``available`` None means the count left could not be read."""
        status = status if status in _RESET_MESSAGES else "unavailable"
        return dict(status=status, message=_RESET_MESSAGES[status], availableCount=None if available is None else max(0, int(available)),
                    windowsReset=max(0, int(windows)))

    def _mark_sent(self, request_id):
        with self.journal.lock, self.journal.db:
            self.journal.db.execute("UPDATE account_resets SET sent=1 WHERE request_id=?", (request_id,))

    def _redeem(self, account, request_id, force, sent):
        """Asks ChatGPT. ``sent`` means an earlier attempt may have consumed: then only the same consume is resent,
        and anything short of ChatGPT's answer to it leaves the request uncertain."""
        from agent import account_usage as usage
        import httpx
        helpers = ("_codex_backend_urls", "_codex_headers", "_codex_banked_resets", "_codex_reset_guard", "_codex_reset_outcome")
        undecided = "uncertain" if sent else "unavailable"
        if not all(callable(getattr(usage, name, None)) for name in helpers):
            return self._result(undecided)
        fresh = _fresh(account)
        if fresh is None:
            return self._result(undecided)
        usage_url, _credits_url, consume_url = usage._codex_backend_urls(fresh["base_url"] or "")
        headers = usage._codex_headers(fresh["token"], None)
        try:
            with httpx.Client(timeout=15.0) as client:
                if not sent:
                    response = client.get(usage_url, headers=headers)
                    response.raise_for_status()
                    payload = response.json() or {}
                    available = usage._codex_banked_resets(payload)
                    refused = usage._codex_reset_guard(payload, available, force)
                    if refused is not None:
                        return self._result(refused.status, refused.available_count)
                    self._mark_sent(request_id)
                    sent = True
                consumed = client.post(consume_url, headers={**headers, "Content-Type": "application/json"}, json={"redeem_request_id": request_id})
                consumed.raise_for_status()
                body = consumed.json() or {}
                # The count before this consume is unknown on a resend, so the count left is read afterwards.
                try:
                    after = client.get(usage_url, headers=headers)
                    after.raise_for_status()
                    left = usage._codex_banked_resets(after.json() or {})
                except Exception:
                    left = None
        except Exception:
            # Once the consume may have gone out its answer is unknown; only the same ID is ever sent for it.
            return self._result("uncertain" if sent else "unavailable")
        outcome = usage._codex_reset_outcome(body, (left + 1) if left is not None else 1)
        if outcome.status not in _CONSUME_ANSWERS:
            # An answer ChatGPT's consume does not document says nothing about whether it spent.
            return self._result("uncertain")
        return self._result(outcome.status, 0 if outcome.status == "no_credit" else left, outcome.windows_reset)


MAX_MODEL_NAMES = 4000


def model_names(data):
    """Display names for (provider, model) pairs, read only from Hermes's models.dev cache.

    ``allow_network=False`` keeps this off the network and cheap enough for a roster read. A model the
    cache does not know, or one it only echoes back as its own slug, gets ``name: None`` so the app
    can format the slug itself. Nothing here is profile configuration, so no profile scope is needed.
    """
    models = data.get("models")
    if not isinstance(models, list) or len(models) > MAX_MODEL_NAMES:
        raise ExperienceError(f"Expected at most {MAX_MODEL_NAMES} models.")
    pairs = []
    for row in models:
        if not isinstance(row, dict) or not all(isinstance(row.get(key), str) and 0 < len(row[key]) <= 300 for key in ("provider", "model")):
            raise ExperienceError("Each model needs a provider and a model.")
        pairs.append((row["provider"], row["model"]))
    from agent.models_dev import get_model_info
    found = {}
    for provider, model in dict.fromkeys(pairs):
        try:
            info = get_model_info(provider, model, allow_network=False)
            name = info.name.strip() if info is not None and isinstance(info.name, str) else ""
        except Exception:
            name = ""
        found[(provider, model)] = name if name and name != model else None
    names = [dict(provider=provider, model=model, name=found[(provider, model)]) for provider, model in pairs]
    return dict(names=names)


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
            ledger, live = routine_ledger(job_id)
            # A script-only run in flight has no session or document yet; its live claim stands for it.
            if live and not any(row.get("cron_execution_id") == live.get("id") or row.get("source") != "cron_output" and not row.get("cron_execution_id")
                                and row.get("ended_at") is None for row in rows):
                rows.insert(0, dict(id=f"cron_output:{job_id}:running", source="cron_output", execution_id=live.get("id"),
                    title="Running", preview="This run is still in progress.", started_at=_epoch(live.get("claimed_at"))))
            if data["operation"] == "routine_results":
                results = []
                for index, row in enumerate(rows):
                    result = dict(id=row["id"], title=row.get("title") or "Routine run",
                        startedAt=datetime.datetime.fromtimestamp(row["started_at"], datetime.timezone.utc).isoformat() if row.get("started_at") else None,
                        preview=row.get("preview"), previewOnly=row.get("source") == "cron_output")
                    # Additive fields; the ledger's claim time replaces a document's write time.
                    outcome = run_outcome(row, attempts, ledger, job, index == 0)
                    result.update({key: value for key, value in outcome.items() if key != "startedAt" or value})
                    results.append(result)
                return results
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
                if execution["status"] in _TRIAL_OUTCOME:
                    receipt.update(status=_TRIAL_OUTCOME[execution["status"]],
                        finishedAt=execution.get("finished_at") or timestamp(),
                        message="Hermes finished this trial. Open View results to read its output." if execution["status"] == "completed"
                            else "This trial was stopped before it finished." if execution["status"] == "cancelled"
                            else "Review the native trial results before trying again.")
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
                if native_status in _TRIAL_OUTCOME:
                    status = _TRIAL_OUTCOME[native_status]
                    message = ("Hermes finished this trial. Open the assistant for its results." if status == "completed"
                               else "This trial was stopped before it finished." if native_status == "cancelled"
                               else "Hermes could not confirm a completed trial. Review the native results before trying again.")
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
    if native_row is None:
        return None
    return history_receipts(journal, profile, lineage, [native_row]).get(native_row["id"])


def history_receipts(journal, profile, lineage, native_rows):
    """Resolve exact user occurrences by native row id, including native compaction clones.

    A page reads every receipt in one journal query, and every clone in one session store read,
    instead of one or two reads per message. Each occurrence takes its newest receipt.
    """
    users = [row for row in native_rows if row is not None and row.get("role") == "user"]
    if not users:
        return {}
    sessions = ",".join("?" for _ in lineage)
    def read(ids):
        with journal.lock:
            return journal.db.execute("SELECT row_id,request_id,actor,COALESCE(run_id,request_id),attachments,input_text,stored_session FROM receipts WHERE profile=? AND stored_session IN (" + sessions + ") AND row_id IN (SELECT value FROM json_each(?)) ORDER BY created DESC", (profile, *lineage, json.dumps(ids))).fetchall()
    found = {}
    for row in read([row["id"] for row in users]):
        found.setdefault(row[0], tuple(row[1:]))
    cloned = {row["id"]: row["message_uid"] for row in users if row["id"] not in found and row.get("message_uid")}
    if not cloned:
        return found
    from hermes_cli.web_server_sessions import _open_session_db_for_profile
    uids = sorted(set(cloned.values()))
    db = _open_session_db_for_profile(profile, read_only=True)
    try:
        clones = db._read_all("SELECT id,message_uid FROM messages WHERE message_uid IN (" + ",".join("?" for _ in uids) + ") AND role='user' AND (active=1 OR compacted=1) AND session_id IN (" + sessions + ")", (*uids, *lineage))
    finally:
        db.close()
    occurrence = {clone["id"]: clone["message_uid"] for clone in clones}
    newest = {}
    for row in read(list(occurrence)) if occurrence else []:
        newest.setdefault(occurrence[row[0]], tuple(row[1:]))
    for row_id, uid in cloned.items():
        if uid in newest:
            found[row_id] = newest[uid]
    return found


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
    # The page's receipts and tool records are read once, not per message.
    raw_rows = {row["id"]: row for row in raw}
    receipts = history_receipts(journal, profile, lineage, [raw_rows.get(message.get("row_id")) for message in native_rows])
    tool_ids = sorted({message["tool_call_id"] for message in native_rows if message.get("role") == "tool" and type(message.get("tool_call_id")) is str})
    tool_records = {}
    if tool_ids:
        with journal.lock:
            for record in journal.db.execute("SELECT tool_id,run_id,result,artifacts FROM tools WHERE profile=? AND stored_session IN (" + ",".join("?" for _ in lineage) + ") AND tool_id IN (SELECT value FROM json_each(?)) ORDER BY id", (profile, *lineage, json.dumps(tool_ids))):
                tool_records.setdefault((record[0], record[1]), []).append(record[2:])
    for message in native_rows:
        if message.get("role") == "user":
            current_run = None
        row = receipts.get(message.get("row_id"))
        if row:
            current_run = row[2]
            message["app_attachments"] = json.loads(row[3] or "[]")
            message["app_display_text"] = row[4] or ""
            message["app_sender_id"] = row[1]
        if message.get("role") == "tool" and current_run:
            if type(message.get("tool_call_id")) is str:
                records = tool_records.get((message["tool_call_id"], current_run), [])
            else:
                with journal.lock:
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
    resets = AccountResets(journal)
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
            elif operation == "accounts":
                result = await config_scoped_to_thread(profile, account_list)
            elif operation == "account_usage":
                result = await config_scoped_to_thread(profile, lambda: account_usage(data))
            elif operation == "account_reset":
                # Spending a reset changes the provider account, so it pauses with other writes during an upgrade.
                with retirement.work() as admitted:
                    if not admitted:
                        raise ExperienceError("Hermes is being upgraded. Try the reset again in a minute.", 409)
                    result = await config_scoped_to_thread(profile, lambda: resets.spend(data))
            elif operation == "model_names":
                # Cache-only reads need no profile scope, and an earlier add-on answers "Unknown experience operation."
                result = await asyncio.to_thread(model_names, data)
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
