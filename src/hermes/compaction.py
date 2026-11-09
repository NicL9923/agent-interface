"""Background compaction of each assistant's canonical Bot Chat after it goes idle.

A long Bot Chat makes every model call slower, because each request carries the whole
transcript. Hermes compacts automatically only near its context threshold, inside a turn
someone is waiting on, and at production's size that took 220 to 290 seconds. This
compacts an idle canonical session instead, through Hermes's own ``session.compress``, so
the next message starts from a small transcript.

Nobody waits on it. Every input this add-on admits calls ``preempt`` first, and input another
client queues in Hermes directly is watched for: a running background compaction is cancelled
through its own commit fence, and the input runs as an ordinary turn on the uncompacted
transcript. See docs/HermesCapabilityMatrix.md, "Idle compaction".
"""
import contextlib
import logging
import os
import threading
import time

log = logging.getLogger(__name__)

SETTING = "HERMES_AGENT_INTERFACE_IDLE_COMPACT_SECONDS"
# Ten minutes, long after a typical exchange ends. An input during a compaction cancels it, so the
# delay bounds only wasted summary work, never anyone's wait. It also outlasts OpenAI's 5 to 10
# minute in-memory prompt cache, where that applies, so a quick follow-up keeps its warm prefix.
DEFAULT_DELAY = 600
POLL_SECONDS = 30
# How long an input waits for a cancelled compaction to let go of the session. Hermes abandons
# a cancelled summary within a poll of its cancel check; this bounds a commit already under way.
PREEMPT_WAIT = 30

# Native session state that means work is running or about to run.
BUSY = ("running", "queued_prompt", "queued_prompts", "pending_steer", "_auto_continue_scheduled",
        "_compute_host_open_request", "_compute_host_active", "resume_hydrating", "_closing", "_finalized")
# Input another client sent straight to Hermes, which queued it behind the compaction.
NATIVE_QUEUE = ("queued_prompt", "queued_prompts", "pending_steer")
WATCH_SECONDS = 0.25
# Hermes publishes this on the compressor when a compaction's summary call begins. A cancel before then
# leaves the transcript unchanged, which Hermes takes for no progress and answers with a 300-second
# backoff on its own automatic compaction. A cancel during the summary rolls back without one.
WORKING = "_compression_working_attempt_generation"
# How long a cancel waits for the session lock before preempt rechecks its deadline.
LOCK_SECONDS = 0.05
# The thread whose session.compress Hermes is running, while it holds the session for it.
OWNER = "_agent_interface_compaction_thread"


def delay_from(environ=os.environ):
    """The idle delay in seconds; 0 turns compaction off. An unreadable value turns it off loudly."""
    raw = environ.get(SETTING)
    if raw is None or raw.strip() == "":
        return DEFAULT_DELAY
    try:
        value = int(raw.strip())
    except ValueError:
        value = -1
    if value < 0:
        log.error("%s must be a whole number of seconds, or 0 to turn idle compaction off; it is off.", SETTING)
        return 0
    return value


def supported(server):
    """Whether this Hermes holds the session for a whole manual compaction.

    Older revisions compacted without marking the session running, so an input admitted
    meanwhile could lose its reply (Hermes #133504). Never compact there.
    """
    try:
        from agent.conversation_compression import CompressionCommitFence
        from agent.model_metadata import estimate_request_tokens_rough  # noqa: F401
    except ImportError:
        return False
    return callable(getattr(CompressionCommitFence, "try_cancel_before_commit", None)) and all(callable(getattr(server, name, None)) for name in ("_manual_compress_turn", "_session_uses_compute_host"))


def request_size(session):
    """(estimated request tokens, budget) for the session's next turn, or None when unknown.

    The budget is what Hermes's own compactor aims to leave behind: the system prompt and tools,
    its kept tail up to the 1.5x soft ceiling it allows, and its summary ceiling. Production's
    compactor (500K window, 0.75 threshold, 0.2 target ratio) keeps a 75K tail and a 10K summary,
    so with about 32K of prompt and tools the budget is near 155K.
    """
    from agent.model_metadata import estimate_request_tokens_rough
    agent = session.get("agent")
    compressor = getattr(agent, "context_compressor", None)
    tail, summary = getattr(compressor, "tail_token_budget", None), getattr(compressor, "max_summary_tokens", None)
    if type(tail) is not int or type(summary) is not int or tail <= 0 or summary <= 0:
        return None
    with session["history_lock"]:
        history = list(session.get("history") or [])
    prompt, tools = getattr(agent, "_cached_system_prompt", "") or "", getattr(agent, "tools", None) or None
    overhead = estimate_request_tokens_rough([], system_prompt=prompt, tools=tools)
    return estimate_request_tokens_rough(history, system_prompt=prompt, tools=tools), overhead + tail * 3 // 2 + summary


class Attempt:
    """One background compaction."""

    def __init__(self, working=None):
        self.done = threading.Event()
        self.thread = threading.get_ident()
        # Its commit fence has answered a cancel: cancelled, or already committing.
        self.cancelled = False
        # The fence last seen, and the compressor's working-attempt marker before that fence's
        # summary. A stall fallback publishes a fresh fence for a summary that has not started yet.
        self.fence, self.working = None, working


class IdleCompaction:
    """Compacts canonical Bot Chats once each has been idle for ``delay`` seconds.

    Order: submission_lock, then ``lock`` or a session's history_lock. An attempt never takes
    submission_lock or maintenance_lock after it registers, so ``preempt`` may wait for it under
    submission_lock. It must not wait under maintenance_lock: Hermes's release takes it.
    """

    def __init__(self, server, native, canonical, journal, submission_lock, maintenance_state, delay,
                 clock=time.time, monotonic=time.monotonic, size=request_size):
        self.server, self.native, self.canonical, self.journal = server, native, canonical, journal
        self.submission_lock, self.maintenance_state, self.delay = submission_lock, maintenance_state, delay
        self.clock, self.monotonic, self.size = clock, monotonic, size
        self.lock = threading.Lock()
        self.attempts = {}
        # When each session last showed activity, and the history each was last compacted at.
        self.activity = {}
        self.settled = {}
        # The estimated request size each session's last committed compaction left.
        self.after = {}

    @property
    def enabled(self):
        return self.delay > 0

    def owns(self, sid):
        """Whether a background compaction holds this session. Its running flag is not a task."""
        with self.lock:
            return sid in self.attempts

    def touch(self, sid):
        """Record activity: a native frame or an admitted input. A compaction's own frames do not count."""
        if sid and self.enabled and not self.owns(sid):
            self.activity[sid] = self.clock()

    def blocker(self, profile, sid, session, now):
        """Why this session must not be compacted now, or None. Callers hold submission_lock."""
        if session is None or self.canonical.get(profile) != sid:
            return "not canonical"
        if self.owns(sid):
            return "compacting"
        if session.get("agent") is None or "history_lock" not in session:
            return "agent not built"
        if self.server._session_uses_compute_host(session):
            return "compute host"
        if any(session.get(key) for key in BUSY):
            return "busy"
        if self.maintenance_state():
            return "maintenance"
        from tui_gateway import server_requests
        with server_requests._lock:
            if any(getattr(request, "sid", None) == sid for request in server_requests._open.values()):
                return "open request"
        with self.journal.lock:
            if self.journal.db.execute("SELECT 1 FROM receipts WHERE session_id=? AND terminal=0 LIMIT 1", (sid,)).fetchone():
                return "unsettled receipt"
            if self.journal.db.execute("SELECT 1 FROM interruptions WHERE profile=? AND stored_session=?", (profile, session.get("session_key"))).fetchone():
                return "interruption under review"
        last = max(self.activity.setdefault(sid, now), float(session.get("last_active") or 0))
        if now - last < self.delay:
            return "recent activity"
        if self.settled.get(sid) == (session.get("session_key"), session.get("history_version")):
            return "already compacted"
        size = self.size(session)
        if size is None:
            return "size unknown"
        # Hermes's kept head and oversized anchors can leave a compaction above the budget. It is
        # due again only once the transcript has doubled since, so it can never compact in a loop.
        if size[0] <= max(size[1], 2 * self.after.get(sid, 0)):
            return "within budget"
        return None

    def poll(self):
        live = set(self.canonical.copy().values())
        for state in (self.activity, self.settled, self.after):
            for sid in [sid for sid in list(state) if sid not in live]:
                state.pop(sid, None)
        for profile, sid in list(self.canonical.copy().items()):
            try:
                self.compact(profile, sid)
            except Exception:
                log.warning("Idle compaction failed for profile %s", profile, exc_info=True)

    def compact(self, profile, sid):
        """Compact one canonical session if it is due. Returns the native result, or None."""
        with self.submission_lock:
            session = self.server._sessions.get(sid)
            if self.blocker(profile, sid, session, self.clock()) is not None:
                return None
            before = self.size(session)[0]
            attempt = Attempt(getattr(session["agent"].context_compressor, WORKING, None))
            with self.lock:
                self.attempts[sid] = attempt
        result = None
        watcher = threading.Thread(target=self.watch, args=(sid, attempt), name="agent-interface-compaction-watch", daemon=True)
        watcher.start()
        try:
            result = self.native("session.compress", {"session_id": sid, "profile": profile})
        except Exception as exc:
            # A refusal (4009 when another turn won the session) or a failed summary. Either
            # way the transcript is unchanged; try again after the next turn.
            log.info("Idle compaction of profile %s did not run: %s", profile, str(exc)[:300])
        finally:
            self.settled[sid] = (session.get("session_key"), session.get("history_version"))
            with self.lock:
                self.attempts.pop(sid, None)
            attempt.done.set()
        # A cancelled compaction can still report "compressed"; only a smaller transcript counts.
        size = self.size(session)
        if size is not None and size[0] < before:
            self.after[sid] = size[0]
        if isinstance(result, dict):
            log.info("Idle compaction of profile %s: %s, about %s to %s tokens", profile, result.get("status"),
                     result.get("before_tokens"), result.get("after_tokens"))
        return result

    def preempt(self, sid, wait=None):
        """Cancel this session's background compaction and wait for it to let go.

        Returns whether a compaction was running. Called before every admitted input, with
        or without submission_lock held.
        """
        with self.lock:
            attempt = self.attempts.get(sid)
        if attempt is None:
            return False
        wait = PREEMPT_WAIT if wait is None else wait
        deadline = self.monotonic() + wait
        while not attempt.done.wait(0.02):
            self.stop(sid, attempt)
            if self.monotonic() >= deadline:
                log.warning("Idle compaction did not stop within %s seconds; the input proceeds while it runs.", wait)
                break
        return True

    def stop(self, sid, attempt):
        """Cancel this compaction through its own commit fence, never blocking for long.

        Hermes ends a manual compaction and admits the next turn under the session's
        history_lock, and ``owned_turn`` names the thread a compaction runs for while Hermes holds
        the session. Holding the lock and matching that thread means the fence on the agent is
        this compaction's own, never a later turn's or another client's. The fence answers None
        while a commit holds it; that commit finishes on its own. The lock is taken with a short
        timeout so preempt keeps its deadline while Hermes holds it.
        """
        session = self.server._sessions.get(sid)
        if session is None or attempt.cancelled:
            return
        lock = session["history_lock"]
        if not lock.acquire(timeout=LOCK_SECONDS):
            return
        try:
            # Rechecked under the lock: the poll thread that ran a finished attempt may run the next one.
            if attempt.done.is_set() or session.get(OWNER) != attempt.thread:
                return
            agent = session.get("agent")
            fence = getattr(agent, "__dict__", {}).get("_active_compression_commit_fence")
            working = getattr(getattr(agent, "context_compressor", None), WORKING, None)
            if fence is None:
                return
            if fence is not attempt.fence:
                if attempt.fence is not None:
                    # A stall fallback's fresh fence: its own summary has not been seen to start.
                    attempt.working = working
                attempt.fence = fence
            # CompressionCommitFence.progress_observed is a property: provider progress for this fence.
            if working == attempt.working and getattr(fence, "progress_observed", False) is not True:
                return
            cancel = getattr(fence, "try_cancel_before_commit", None)
            if callable(cancel) and cancel() is not None:
                attempt.cancelled = True
        finally:
            lock.release()

    def watch(self, sid, attempt):
        """Stop the compaction once another client's input waits in Hermes's own queue for it."""
        while not attempt.done.wait(WATCH_SECONDS):
            session = self.server._sessions.get(sid) or {}
            if any(session.get(key) for key in NATIVE_QUEUE):
                self.stop(sid, attempt)
                if attempt.cancelled:
                    return

    def owned_turn(self, original):
        """Hermes's manual-compaction hold, naming the thread it holds the session for."""
        @contextlib.contextmanager
        def turn(sid, session):
            with original(sid, session):
                session[OWNER] = threading.get_ident()
                try:
                    yield
                finally:
                    # Cleared before Hermes releases the session and admits the next turn.
                    session.pop(OWNER, None)
        return turn

    def start(self, interval=None):
        # Hermes's session.compress resolves this seam on the server module, as other wrapped seams do.
        self.server._manual_compress_turn = self.owned_turn(self.server._manual_compress_turn)
        # A short delay, as in a qualification probe, is checked proportionally more often.
        interval = interval or min(POLL_SECONDS, max(1, self.delay // 4))
        def loop():
            while True:
                time.sleep(interval)
                self.poll()
        thread = threading.Thread(target=loop, name="agent-interface-idle-compaction", daemon=True)
        thread.start()
        return thread
