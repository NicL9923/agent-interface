"""Background compaction of each assistant's canonical Bot Chat after it goes idle.

A long Bot Chat makes every model call slower, because each request carries the whole
transcript. Hermes compacts automatically only near its context threshold, inside a turn
someone is waiting on, and at production's size that took 220 to 290 seconds. This
compacts an idle canonical session instead, through Hermes's own ``session.compress``, so
the next message starts from a small transcript.

Nobody waits on it. Every input this add-on admits calls ``preempt`` first, and input another
client queues in Hermes directly is watched for: a running background compaction is cancelled
with Hermes's explicit stop, and the input runs as an ordinary turn on the uncompacted
transcript. See docs/HermesCapabilityMatrix.md, "Idle compaction".
"""
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
# How long an input waits for a cancelled compaction to let go of the session. Hermes stops
# a cancelled summary within a poll of its cancel check; this bounds a stuck one.
PREEMPT_WAIT = 30

# Native session state that means work is running or about to run.
BUSY = ("running", "queued_prompt", "queued_prompts", "pending_steer", "_auto_continue_scheduled",
        "_compute_host_open_request", "_compute_host_active", "resume_hydrating", "_closing", "_finalized")
# Input another client sent straight to Hermes, which queued it behind the compaction.
NATIVE_QUEUE = ("queued_prompt", "queued_prompts", "pending_steer")
WATCH_SECONDS = 0.25


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
        from agent.interrupt_compat import request_hard_interrupt  # noqa: F401
        from agent.model_metadata import estimate_request_tokens_rough  # noqa: F401
    except ImportError:
        return False
    return all(callable(getattr(server, name, None)) for name in ("_manual_compress_turn", "_session_uses_compute_host"))


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
    """One background compaction. ``lock`` orders the stop request against the attempt's end."""

    def __init__(self):
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.stopped = False
        self.finished = False


class IdleCompaction:
    """Compacts canonical Bot Chats once each has been idle for ``delay`` seconds.

    Order: submission_lock, then ``lock`` or an attempt's lock. An attempt never takes
    submission_lock after it registers, so ``preempt`` may wait for it under that lock.
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
            attempt = Attempt()
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
            with attempt.lock:
                attempt.finished = True
                if attempt.stopped:
                    # A stop must not outlive the compaction it stopped. Hermes's turn runner clears
                    # one as each turn starts too, and a turn Hermes drained from its own queue may
                    # already run: it owns the agent's stop state, so leave it alone.
                    with session["history_lock"]:
                        if not session.get("running"):
                            session["agent"].clear_interrupt()
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

    def preempt(self, sid, wait=PREEMPT_WAIT):
        """Cancel this session's background compaction and wait for it to let go.

        Returns whether a compaction was running. Called before every admitted input, with
        or without submission_lock held.
        """
        with self.lock:
            attempt = self.attempts.get(sid)
        if attempt is None:
            return False
        deadline = self.monotonic() + wait
        while not attempt.done.wait(0.02):
            self.stop(sid, attempt)
            if self.monotonic() >= deadline:
                log.warning("Idle compaction did not stop within %s seconds; the input proceeds while it runs.", wait)
                break
        return True

    def stop(self, sid, attempt):
        with attempt.lock:
            if attempt.finished or attempt.stopped:
                return
            session = self.server._sessions.get(sid) or {}
            # Before Hermes marks the compaction active, a stop would land on an idle agent.
            if not session.get("_manual_compress_active"):
                return
            from agent.interrupt_compat import request_hard_interrupt
            attempt.stopped = True
            request_hard_interrupt(session.get("agent"))

    def watch(self, sid, attempt):
        """Stop the compaction once another client's input waits in Hermes's own queue for it."""
        while not attempt.done.wait(WATCH_SECONDS):
            session = self.server._sessions.get(sid) or {}
            if any(session.get(key) for key in NATIVE_QUEUE):
                self.stop(sid, attempt)
                if attempt.stopped:
                    return

    def start(self, interval=None):
        # A short delay, as in a qualification probe, is checked proportionally more often.
        interval = interval or min(POLL_SECONDS, max(1, self.delay // 4))
        def loop():
            while True:
                time.sleep(interval)
                self.poll()
        thread = threading.Thread(target=loop, name="agent-interface-idle-compaction", daemon=True)
        thread.start()
        return thread
