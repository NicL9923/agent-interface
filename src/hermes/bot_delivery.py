"""Bot Chat deliveries into the canonical conversations this add-on owns.

Routines (`deliver: bot-chat:<profile>`) and bot-to-bot messages reach a bot as an
inbound turn in its canonical "Bot Chat". Hermes up to 6ebd92d hands each delivery
to the Bot Chat's live owner through an owner-pinned mailbox
(tools/bot_live_delivery.py), and the dashboard's tui_gateway poller runs it as a
turn. The unified gateway runtime (eb75627) retired that consumer. Producers now
call the gateway's session authority only, which refuses a Bot Chat held by
another process ("runtime_coordination_required"). When the chat is not held, it
adopts the household's conversation away from this add-on.

The add-on runs every household Bot Chat inside the dashboard. On a Hermes without
the native consumer, this module keeps that mailbox handoff for chats the add-on
owns. The producer half runs in each process that delivers (gateway and
dashboard). The consumer half runs in the dashboard beside agent-interface.open.
Records keep the native receipt format, so native readers and waiters still see
queued, claimed and terminal states. A claim is never replayed: a crash leaves it
claimed for review, exactly like the native consumer.
"""
import contextlib
import logging
import threading
import time
import uuid
from pathlib import Path

CONSUMER = "agent-interface"
# Pin for "the canonical Bot Chat the add-on opens", before the profile has one.
UNOPENED = "agent-interface:canonical-bot-chat"
POLL_SECONDS = 2.0
_OWNER_KEYS = ("profile_home", "session_id", "lease_id", "live_session_id")
_BUSY = ("running", "_closing", "_finalized", "queued_prompt", "queued_prompts", "_auto_continue_scheduled")
_MAILBOX_SEAMS = ("_root", "_locked", "_read", "_write", "_scan_read", "_next_sequence", "_delivery_id",
                  "has_mailbox", "complete_delivery", "find_canonical_live_owner", "deliver_to_live_owner")
log = logging.getLogger("agent_interface.bot_delivery")


def bridge_required(mailbox, server=None):
    """Whether native delivery reaches only a gateway authority, never this add-on's chats.

    With ``server``, also require the dashboard's native consumer to agree. A Hermes
    with neither or both halves is a delivery design this add-on has not qualified.
    """
    authority = callable(getattr(mailbox, "authority_delivery", None))
    if server is not None and authority == callable(getattr(server, "_poll_bot_live_delivery_once", None)):
        raise RuntimeError("Native Bot Chat delivery seams require qualification")
    if authority and not all(callable(getattr(mailbox, name, None)) for name in _MAILBOX_SEAMS):
        raise RuntimeError("Native Bot Chat mailbox seams require qualification")
    return authority


def open_session_db(home):
    from hermes_state import SessionDB
    return SessionDB(db_path=Path(home) / "state.db", read_only=True)


def canonical_target(home, open_db=open_session_db):
    """``(present, tip, authority_owned)`` for the profile's exact "Bot Chat" title."""
    if not (Path(home) / "state.db").is_file():
        return False, None, False
    db = open_db(home)
    try:
        row = db.get_session_by_title("Bot Chat")
        if row is None:
            return True, None, False
        tip = db.get_compression_tip(row["id"]) or row["id"]
        target = db.get_session(tip) or {}
    finally:
        db.close()
    # Authority-bound sessions carry a route; the add-on's in-process chats never do.
    return True, tip, any(target.get(key) for key in ("session_key", "chat_id", "origin_json"))


def owned_owner(home, open_db=open_session_db):
    """The add-on owner pin for ``home``, or None when native delivery must decide."""
    home = Path(home).resolve()
    present, tip, authority_owned = canonical_target(home, open_db)
    if not present or authority_owned:
        return None
    return {"profile_home": str(home), "session_id": tip or UNOPENED, "lease_id": CONSUMER,
            "live_session_id": CONSUMER, "consumer": CONSUMER}


def admit(mailbox, profile_home, owner, message, *, delivery_id=None, author=None, notification_category="result"):
    """Queue one delivery for the add-on consumer. A replayed id returns its receipt."""
    home = Path(profile_home).resolve()
    pinned = {key: owner.get(key) for key in _OWNER_KEYS}
    if not all(isinstance(value, str) and value for value in pinned.values()) or pinned["profile_home"] != str(home):
        raise ValueError("owner belongs to a different profile home")
    if not isinstance(message, str):
        raise ValueError("message must be a string")
    if notification_category not in ("result", "diagnostic"):
        raise ValueError("invalid notification category")
    key = mailbox._delivery_id(delivery_id if delivery_id is not None else uuid.uuid4().hex)
    with mailbox._locked(home) as root:
        path = root / f"{key}.json"
        existing = mailbox._read(path)
        if existing is not None:
            # The pin may move from UNOPENED to the created chat between replays.
            if (existing.get("consumer") != CONSUMER or existing.get("message") != message or existing.get("author") != author
                    or existing.get("notification_category", "result") != notification_category):
                raise ValueError("delivery id already belongs to a different payload")
            return existing
        record = dict(delivery_id=key, id=key, owner=pinned, **pinned, consumer=CONSUMER, message=message,
                      status="queued", created_at=time.time_ns(), sequence=mailbox._next_sequence(root),
                      **({"author": dict(author)} if author else {}))
        if notification_category == "diagnostic":
            record["notification_category"] = notification_category
        mailbox._write(path, record)
        return record


def install_producer(mailbox, open_db=open_session_db):
    """Route deliveries for add-on chats to the add-on mailbox. Returns whether installed."""
    if not bridge_required(mailbox):
        return False
    if getattr(mailbox, "_agent_interface_bridge", False):
        return True
    native_find, native_deliver = mailbox.find_canonical_live_owner, mailbox.deliver_to_live_owner

    def find_canonical_live_owner(profile_home):
        owner = owned_owner(profile_home, open_db)
        return owner if owner is not None else native_find(profile_home)

    def deliver_to_live_owner(profile_home, owner, message, *, delivery_id=None, author=None, notification_category="result"):
        if isinstance(owner, dict) and owner.get("consumer") == CONSUMER:
            return admit(mailbox, profile_home, owner, message, delivery_id=delivery_id, author=author,
                         notification_category=notification_category)
        return native_deliver(profile_home, owner, message, delivery_id=delivery_id, author=author,
                              notification_category=notification_category)

    mailbox.find_canonical_live_owner = find_canonical_live_owner
    mailbox.deliver_to_live_owner = deliver_to_live_owner
    mailbox._agent_interface_bridge = True
    return True


def _pending(mailbox, root, stored, open_db, home):
    """Queued add-on records this canonical session may run, oldest first."""
    found, tips = [], {}
    for path in root.glob("*.json"):
        record = mailbox._scan_read(path)
        if record is None or record.get("consumer") != CONSUMER or record.get("status") != "queued":
            continue
        pinned = record["owner"]["session_id"]
        if pinned not in (UNOPENED, stored):
            # Follow compression only. A replaced or renamed chat keeps its input queued.
            if pinned not in tips:
                db = open_db(home)
                try:
                    tips[pinned] = db.get_compression_tip(pinned)
                finally:
                    db.close()
            if tips[pinned] != stored:
                continue
        found.append(record)
    return sorted(found, key=lambda item: (item.get("sequence", item["created_at"]), item["delivery_id"]))


def claim(mailbox, home, stored, open_db=open_session_db):
    """Claim the oldest runnable record exactly once, or return None."""
    if not mailbox.has_mailbox(home):
        return None
    with mailbox._locked(home) as root:
        pending = _pending(mailbox, root, stored, open_db, home)
        if not pending:
            return None
        record = pending[0]
        record.update(status="claimed", claimed_at=time.time_ns())
        mailbox._write(root / f"{record['delivery_id']}.json", record)
        return record


class Consumer:
    """Run queued deliveries as turns in the dashboard's canonical sessions."""

    def __init__(self, server, mailbox, homes, open_canonical, admission, open_db=open_session_db, classify=None):
        self.server, self.mailbox, self.homes = server, mailbox, homes
        self.open_canonical, self.admission, self.open_db = open_canonical, admission, open_db
        self.classify = classify
        self.idle = {}
        self.warned = 0.0

    def has_work(self, home):
        """Cheap pre-check. Atomic receipt writes change the directory's mtime."""
        if not self.mailbox.has_mailbox(home):
            return False
        root = self.mailbox._root(home)
        try:
            stamp = root.stat().st_mtime_ns
        except OSError:
            return False
        if self.idle.get(home) == stamp:
            return False
        for path in root.glob("*.json"):
            record = self.mailbox._scan_read(path)
            if record is not None and record.get("consumer") == CONSUMER and record.get("status") == "queued":
                return True
        self.idle[home] = stamp
        return False

    def deliver_once(self, profile, home):
        """Start at most one delivery turn for ``profile``. Returns whether one started."""
        if not self.has_work(home):
            return False
        sid = self.open_canonical(profile)
        session = self.server._sessions.get(sid) if sid else None
        if session is None:
            return False
        with self.admission(sid) as allowed:
            if not allowed:
                return False
            with self.server._session_turn_admission(session) as admitted:
                if not admitted or any(session.get(key) for key in _BUSY) or session.get("agent") is None:
                    return False
                claimed = claim(self.mailbox, home, session.get("session_key"), self.open_db)
                if claimed is None:
                    return False
                session["running"] = True
            return self.run(claimed, sid, session, home)

    def run(self, claimed, sid, session, home):
        delivery_id = str(claimed["id"])

        def terminal_receipt(terminal):
            status = str(terminal.get("status") or "failed")
            error = str(terminal.get("error") or "")
            reason = "cancelled" if status == "cancelled" else ""
            if status not in ("settled", "cancelled"):
                reason = self.classify(error) if self.classify else ""
            # A failed write propagates: the turn keeps its crash marker without a receipt.
            self.mailbox.complete_delivery(home, delivery_id, status=status,
                                           reply=str(terminal.get("text") or "") if status == "settled" else "",
                                           error=error, reason=reason)

        extra = {"display_metadata": {"notification_category": "diagnostic"}} if claimed.get("notification_category") == "diagnostic" else {}
        try:
            started = self.server._run_prompt_submit(f"__bot_dm__{delivery_id}", sid, session, claimed["message"],
                                                     image_paths=[], terminal_callback=terminal_receipt,
                                                     turn_author=claimed.get("author") or None, **extra)
        except Exception as exc:
            self.server._notif_release_turn(session)
            terminal_receipt({"status": "failed", "error": str(exc)})
            raise
        if not started:
            self.server._notif_release_turn(session)
            terminal_receipt({"status": "failed", "error": "The bot's conversation could not start this delivery turn."})
        return bool(started)

    def poll(self):
        for profile, home in self.homes():
            try:
                self.deliver_once(profile, home)
            except Exception:
                now = time.monotonic()
                if now - self.warned >= 60:
                    self.warned = now
                    log.warning("Bot Chat delivery poll failed for profile %s", profile, exc_info=True)

    def start(self, interval=POLL_SECONDS):
        def loop():
            while True:
                self.poll()
                time.sleep(interval)
        thread = threading.Thread(target=loop, name="agent-interface-bot-delivery", daemon=True)
        thread.start()
        return thread


def profile_homes(root):
    """Every served profile home: the root as default, plus each named profile."""
    root = Path(root).resolve()
    def homes():
        yield "default", root
        with contextlib.suppress(OSError):
            for path in sorted((root / "profiles").iterdir()):
                if path.is_dir() and not path.is_symlink():
                    yield path.name, path
    return homes
