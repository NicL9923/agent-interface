"""Finite model-blind credential bridge. Native Hermes owns storage and fills.

Secret-bearing input goes only to native vault handlers or a verified live
server request. No payload is written to the application/add-on journal.
"""
import contextlib
import collections
import functools
import ipaddress
import json
import re
import threading
import uuid
from urllib.parse import urlsplit

METHODS = frozenset(("vault.save_login", "vault.code", "vault.unlock_prompt", "secret"))
MANAGERS = frozenset(("onepassword", "bitwarden"))
TOOL = "vault_save_login"
# computer.py's household computer handoff ask. Kept here so a chat reply can close it too.
HANDOFF = "agent_interface.computer_handoff"
# Native asks the app shows and a chat message closes, so the waiting tool returns and the
# message, already admitted as steering, reaches the assistant. Approvals keep their own decision.
CHAT_CLOSES = METHODS | {"clarify", HANDOFF}
CHAT_REPLY = ("The user sent a chat message instead of answering this request, so Hermes closed it. Nothing was "
              "entered, saved or filled. Their message is the next user message: read it before doing anything else. "
              "If they still want this, ask again with the details they corrected. Never ask for passwords, codes "
              "or other secrets in chat.")
CLARIFY_REPLY = ("The user sent a chat message instead of finishing these questions, so Hermes closed them. Answers "
                 "they had already chosen are included. Their message is the next user message: treat it as their reply.")
# Control, zero-width and bidirectional characters can disguise what a card shows.
HIDDEN = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁠-⁯﻿]")
LABEL = re.compile(r"(?!-)[a-z0-9-]{1,63}(?<!-)")
# The display context of the explicit-origin request this agent thread is about to send.
_context = threading.local()
# Native request ID -> what the requesting tool asked for, while that request can be answered.
_explicit_lock = threading.Lock()
_explicit = {}
# Native request IDs the current tool call on this thread opened. See watched_asks.
_dispatch = threading.local()
# Requests an answer is settling now, and those a chat reply closes if that answer does not.
# Lock order: _answer_lock, then the native server_requests lock, then _replies_lock.
_answer_lock = threading.Lock()
_answering = set()
_close_after_answer = set()
# Native request ID -> True for asks a chat reply closed, until the tool call that opened it reads it.
_replies_lock = threading.Lock()
_replies = {}
# Session ID -> [(member, message text)] for chat messages admitted as steering there that may not have
# reached the model yet. An ask a tool opens meanwhile is out of date the moment it registers. Each entry
# lasts while its text is still in the native agent's steer buffer. Under _answer_lock.
_steered = {}


class VaultError(Exception):
    def __init__(self, status=409):
        self.status = status
        super().__init__("Hermes could not confirm this credential operation. Refresh its status before trying again.")


def text(value, limit=20000):
    if not isinstance(value, str) or not 1 <= len(value) <= limit:
        raise VaultError(400)
    return value


def fields(data, allowed, required):
    if not isinstance(data, dict) or set(data) - set(allowed) or set(required) - set(data):
        raise VaultError(400)


def native(server, method, profile, **params):
    result = server._methods[method]("credential-" + uuid.uuid4().hex, {"profile": profile, **params})
    if not isinstance(result, dict) or "error" in result:
        raise VaultError()
    return result.get("result", {})


def overview(server, profile):
    items = native(server, "vault.list", profile).get("items", [])
    sources = native(server, "vault.sources", profile).get("sources", [])
    return dict(botId=profile, profile=profile, scope="profile", owner="Hermes",
        notice="Logins belong to this shared Hermes profile. Usernames and site names are visible to the assistant. Passwords stay in the native vault and are filled only on their saved sites. Named API secrets use Hermes's native credential store.",
        items=[dict(id=row["id"], kind="login", label=row["label"], origin=row.get("origin") or "",
                    createdAt=row.get("created_at") or "", identifier=row.get("identifier") or "",
                    identifierType=row.get("identifier_type") or "username", hasOtp=row.get("has_otp") is True,
                    backend=row["backend"], canRemove=row["backend"] == "local")
               for row in items if row.get("kind") == "login" and row.get("backend") in MANAGERS | {"local"}],
        sources=[dict(name=row["name"], displayName=row["display_name"], enabled=row["enabled"],
                      needsUnlock=row["needs_unlock"], unlocked=row["unlocked"], installed=row["installed"],
                      canToggle=row["name"] in MANAGERS and row["installed"],
                      canUnlock=row["name"] in MANAGERS and row["installed"] and row["enabled"] and not row["unlocked"],
                      canLock=row["name"] in MANAGERS and row["unlocked"])
                 for row in sources if row.get("name") in MANAGERS | {"local"}])


def answer_request(server, journal, data):
    from tui_gateway import server_requests
    answer = data["answer"]
    if not isinstance(answer, dict) or answer.get("method") not in METHODS:
        raise VaultError(400)
    method = answer["method"]
    # A retried or late answer learns only that the request is settled, whatever it carries.
    with server_requests._lock:
        if data["requestId"] not in server_requests._open:
            return dict(status="expired")
    # A chat reply arriving while this answer settles waits for it, so a submitted value is never
    # discarded. If this answer fails, the reply then closes the request.
    with _answer_lock:
        _answering.add(data["requestId"])
    resolved = False
    try:
        resolved = settle_answer(server_requests, journal, data, answer, method)
        return dict(status="ok" if resolved else "expired")
    finally:
        with _answer_lock:
            _answering.discard(data["requestId"])
            later = data["requestId"] in _close_after_answer
            _close_after_answer.discard(data["requestId"])
        if later and not resolved:
            with server_requests._lock:
                request = server_requests._open.get(data["requestId"])
            if request is not None:
                close_requests(server_requests, [request])


def settle_answer(server_requests, journal, data, answer, method):
    explicit = explicit_request(data["requestId"]) if method == "vault.save_login" else None
    owner = ("epoch", "sessionId", "method")
    if answer.get("cancel") is True:
        fields(answer, (*owner, "cancel"), (*owner, "cancel"))
        value = ""
    elif method == "vault.save_login":
        # An explicit-origin card repeats the destination it showed, so a card for
        # another address can never settle this request.
        names = (*owner, "identifier", "password", *(("origin",) if explicit else ()))
        fields(answer, names, names)
        value = json.dumps(dict(identifier=text(answer["identifier"], 1000), password=text(answer["password"])))
    else:
        fields(answer, (*owner, "value"), (*owner, "value"))
        value = text(answer["value"])
    sid = text(answer["sessionId"], 200)
    if answer["epoch"] != journal.epoch or journal.canonical_session(data["profile"]) != sid:
        raise VaultError()
    if explicit:
        # Only the household member whose task asked may answer or cancel it.
        if explicit["actor"] is not None and data.get("actor") != explicit["actor"]:
            raise VaultError()
        if "origin" in answer and answer["origin"] != explicit["origin"]:
            raise VaultError()
    with server_requests._lock:
        request = server_requests._open.get(data["requestId"])
        if request is None:
            return False
        if request.sid != sid or request.method != method or journal.live_profile_for_session(sid) != data["profile"]:
            raise VaultError()
        if explicit and (request.sid != explicit["sid"] or request.params.get("origin") != explicit["origin"]):
            raise VaultError()
        # The origin/backend/env var comes from the actual native request. The
        # caller supplies only values, never an origin override or result object.
        if method == "vault.save_login":
            origin = urlsplit(text(request.params.get("origin"), 2048))
            if origin.scheme not in ("https", "http") or not origin.hostname or origin.username or origin.password:
                raise VaultError()
        elif method == "vault.unlock_prompt" and request.params.get("backend") not in MANAGERS:
            raise VaultError()
        elif method == "secret" and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,199}", str(request.params.get("env_var") or "")):
            raise VaultError()
    # Native UUID request IDs and immutable owner fields are never repurposed.
    # A cancel/answer racing after validation can only yield expired. Do not
    # hold the non-reentrant native lock while native settlement reacquires it.
    if value:
        # Native exact-value egress guard is profile-scoped, bounded, memory-only
        # and mandatory even when general regex redaction is disabled. Register
        # before waking the native tool so captured opaque values cannot echo
        # through a subsequent browser/terminal result into model context.
        from agent.redact import register_vault_redaction_value
        register_vault_redaction_value(answer["password"] if method == "vault.save_login" else value)
    return server_requests.resolve_response({"jsonrpc": "2.0", "id": data["requestId"], "result": {"value": value}})


@contextlib.contextmanager
def watched_asks():
    """Collects the native request IDs this thread opens until it exits, for replied_in_chat."""
    previous = getattr(_dispatch, "requests", None)
    mine = []
    _dispatch.requests = mine
    try:
        yield mine
    finally:
        _dispatch.requests = previous
        if previous is not None:
            previous.extend(mine)


def replied_in_chat(request_ids):
    """Whether a chat reply closed any of these requests."""
    with _replies_lock:
        return any(request_id in _replies for request_id in request_ids)


def close_requests(server_requests, requests, reason="user_replied"):
    """Withdraw these exact open requests as native ``cancel`` would, marking each as closed by a chat reply.

    Native cancel selects by session and method; a chat reply must leave another member's login,
    and an answer that is settling, untouched. A request settled meanwhile is skipped: the native
    lock decides between an answer and this close, so each request has one outcome.
    """
    with server_requests._lock:
        targets = [request for request in requests if server_requests._open.get(request.id) is request]
        for request in targets:
            server_requests._open.pop(request.id, None)
            if request.qids is not None:
                request.result, request.answered = server_requests.settle_batch(request.locked, ended="cancelled"), True
            else:
                request.result, request.answered = None, False
            if request.writing:
                request.withdrawn = reason
            with _replies_lock:
                _replies[request.id] = True
                while len(_replies) > 1000:
                    _replies.pop(next(iter(_replies)))
        announced = {request.id for request in targets if not request.writing}
    for request in targets:
        if request.on_result is not None:
            request.on_result(None)
        request.event.set()
        if request.id in announced:
            server_requests._emit_cancel(request, reason)
    return len(targets)


def close_for_chat(sid, actor, text=None):
    """A member's message was admitted as steering for ``sid``: close the asks it answers instead.

    Only that session's app-answerable asks close. A login an assistant asked for by address stays
    open unless the message comes from the member whose task asked for it, because only they may
    answer or cancel it; another member's message waits behind it. Returns how many closed now.
    """
    from tui_gateway import server_requests
    chosen = []
    with _answer_lock:
        # Recorded before the scan, so an ask that registers after it closes on registration instead.
        _steered.setdefault(sid, []).append((actor, text.strip() if isinstance(text, str) else None))
        with server_requests._lock:
            candidates = [request for request in server_requests._open.values()
                          if request.sid == sid and request.method in CHAT_CLOSES]
        for request in candidates:
            if not closes_for(request, actor):
                continue
            if request.id in _answering:
                _close_after_answer.add(request.id)
                continue
            chosen.append(request)
    return close_requests(server_requests, chosen) if chosen else 0


def closes_for(request, actor):
    """Whether a chat message from ``actor`` closes this ask. A login asked for by address stays with its requester."""
    explicit = explicit_request(request.id) if request.method == "vault.save_login" else None
    return not (explicit and explicit["actor"] is not None and explicit["actor"] != actor)


def steer_waiting(sid):
    """The members whose admitted messages have not reached the model in ``sid`` yet: an empty set if none.

    Reads the native agent's own steer buffer, the one record of whether the message was delivered.
    A member counts while their message's text is still in it, so one drained earlier does not count
    for a later batch. A Hermes without that buffer gives an empty set: nothing is closed on a guess.
    """
    with _answer_lock:
        if sid not in _steered:
            return set()
    try:
        from tui_gateway import server
        agent = (server._sessions.get(sid) or {}).get("agent")
        pending = getattr(agent, "_pending_steer", None) if agent is not None and hasattr(agent, "_pending_steer") else None
        parts = vars(agent).get("_pending_steer_parts") if pending else None
    except Exception:
        pending, parts = None, None
    with _answer_lock:
        if not pending:
            _steered.pop(sid, None)
            return set()
        held = buffered_messages(pending, parts)
        # The buffer drains oldest first, so the newest entries with a text are the ones it still holds.
        # A message without its text on record can only be timed by the buffer emptying.
        waiting = []
        for actor, text in reversed(_steered.get(sid, ())):
            if text is None:
                waiting.append((actor, text))
            elif held[text] > 0:
                held[text] -= 1
                waiting.append((actor, text))
        waiting.reverse()
        _steered[sid] = waiting
        return {actor for actor, _ in waiting}


def buffered_messages(pending, parts):
    """How many times each whole message is in the native steer buffer.

    Native ``steer`` stores each message's stripped text as one part and joins them with newlines.
    Without consistent parts, a message counts only where it fills whole lines of the joined text,
    so "yes" never matches inside "yes, keep checking".
    """
    if isinstance(parts, list) and "\n".join(str(part[1]) for part in parts if isinstance(part, tuple) and len(part) == 2) == pending:
        return collections.Counter(text for _, text in parts)
    return _LineCounts(pending)


class _LineCounts(dict):
    """Occurrences of a text as whole lines of ``pending``, counted on first lookup."""
    def __init__(self, pending):
        super().__init__()
        self.lines = pending.split("\n")

    def __missing__(self, text):
        size = text.count("\n") + 1
        found, index = 0, 0
        while index + size <= len(self.lines):
            if "\n".join(self.lines[index:index + size]) == text:
                found, index = found + 1, index + size
            else:
                index += 1
        self[text] = found
        return found


def close_if_steered(server_requests, request):
    """Closes an ask that registered after a chat message for its session was admitted but before the model read it."""
    if request.method not in CHAT_CLOSES:
        return
    # Any waiting member's message closes it, except that a login asked for by address waits for its requester's.
    if any(closes_for(request, actor) for actor in steer_waiting(request.sid)):
        close_requests(server_requests, [request])


def chat_reply_result(result):
    """Rewrites a tool result whose ask a chat reply closed, so the model reads that message next."""
    try:
        value = json.loads(result) if isinstance(result, str) else None
    except ValueError:
        value = None
    if not isinstance(value, dict):
        return (result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)) + "\n\n" + CHAT_REPLY
    if value.get("error_type") == "user_replied_in_chat":
        return result
    value["user_replied_in_chat"] = True
    if "responses" in value and "outcome" in value:
        value["notice"] = CLARIFY_REPLY
    elif value.get("success") is False:
        # Native refusals such as "Do not ask again this turn" contradict asking again after a correction.
        value.update(error_type="user_replied_in_chat", error=CHAT_REPLY)
    else:
        value["notice"] = CHAT_REPLY
    return json.dumps(value, ensure_ascii=False)


def bind_dispatch(registry):
    """Every tool result whose ask a chat reply closed says so, whichever native tool asked."""
    native = registry.dispatch
    if getattr(native, "_agent_interface_chat_reply", False):
        return

    @functools.wraps(native)
    def dispatch(name, args, **kwargs):
        with watched_asks() as asks:
            result = native(name, args, **kwargs)
        if not asks:
            return result
        with _replies_lock:
            replied = [_replies.pop(request_id, None) for request_id in asks]
        return chat_reply_result(result) if any(replied) else result

    dispatch._agent_interface_chat_reply = True
    registry.dispatch = dispatch


def operate(server, journal, data):
    operation, profile = data.get("operation"), data["profile"]
    common = ("operation", "profile")
    if operation == "overview":
        fields(data, common, common)
        return overview(server, profile)
    if operation == "answer":
        # The app adds the signed-in member it authenticated; clients never supply it.
        fields(data, (*common, "requestId", "answer", "actor"), (*common, "requestId", "answer"))
        text(data["requestId"], 200)
        if "actor" in data:
            text(data["actor"], 200)
        return answer_request(server, journal, data)
    if operation == "add_login":
        fields(data, (*common, "login"), (*common, "login"))
        login = data["login"]
        names = ("label", "origin", "identifierType", "identifier", "password", "otpSecret")
        fields(login, names, names[:-1])
        origin = urlsplit(text(login["origin"], 2048))
        if origin.scheme not in ("https", "http") or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ("", "/"):
            raise VaultError(400)
        if login["identifierType"] not in ("email", "phone", "username"):
            raise VaultError(400)
        secret = dict(identifier_type=login["identifierType"], identifier=text(login["identifier"], 1000), password=text(login["password"]))
        if login.get("otpSecret"):
            secret["otp_secret"] = text(login["otpSecret"], 4000)
        return native(server, "vault.add", profile, kind="login", label=text(login["label"], 200), origin=login["origin"], secret=secret)
    if operation == "remove_login":
        fields(data, (*common, "itemId"), (*common, "itemId"))
        text(data["itemId"], 200)
        items = native(server, "vault.list", profile).get("items", [])
        item = next((row for row in items if row.get("id") == data["itemId"]), None)
        if item is None or item.get("backend") != "local" or item.get("kind") != "login":
            raise VaultError()
        return native(server, "vault.remove", profile, id=data["itemId"])
    if operation in ("source", "unlock", "lock"):
        extra = ("enabled",) if operation == "source" else ("password",) if operation == "unlock" else ()
        fields(data, (*common, "source", *extra), (*common, "source", *extra))
        manager = data.get("source")
        if manager not in MANAGERS:
            raise VaultError(400)
        row = next((row for row in native(server, "vault.sources", profile).get("sources", []) if row.get("name") == manager), None)
        if row is None or not row.get("installed"):
            raise VaultError()
        if operation == "source":
            if type(data["enabled"]) is not bool:
                raise VaultError(400)
            native(server, "vault.source.set", profile, name=manager, enabled=data["enabled"])
        elif operation == "unlock":
            if not row.get("enabled"):
                raise VaultError()
            native(server, "vault.unlock", profile, name=manager, password=text(data["password"]))
        else:
            native(server, "vault.lock", profile, name=manager)
        return dict(ok=True)
    raise VaultError(400)


class CredentialRequestError(Exception):
    def __init__(self, error_type, message):
        self.error_type = error_type
        super().__init__(message)


def explicit_origin(value):
    """The exact ``scheme://host[:port]`` a login is saved for, never a URL with a path or credentials.

    Hosts are ASCII DNS names or IPv4 addresses, so a card cannot show a look-alike
    Unicode name. IPv6 literals are refused because the native origin normalizer
    drops their brackets and the saved origin would then match no page.
    """
    invalid = CredentialRequestError("invalid_origin", "Use an exact origin such as https://device.example.net or "
                                     "https://192.0.2.10:8443: http or https, a host and an optional port, with no "
                                     "path, query, fragment, credentials or non-ASCII characters.")
    if not isinstance(value, str) or not 1 <= len(value) <= 2048 or not value.isascii() or HIDDEN.search(value) \
            or value != value.strip() or any(char in value for char in "?#@\\ "):
        raise invalid
    parts = urlsplit(value)
    try:
        port = parts.port
    except ValueError:
        raise invalid from None
    host = parts.hostname or ""
    if parts.scheme not in ("https", "http") or parts.path not in ("", "/") or port == 0 or not host or len(host) > 253:
        raise invalid
    # Browsers read a host ending in a numeric label as IPv4 (0x7f000001 is 127.0.0.1), so only
    # the canonical dotted form can match the page a login is later filled on.
    if re.fullmatch(r"0x[0-9a-f]*|[0-9]+", host.rsplit(".", 1)[-1]):
        try:
            if str(ipaddress.IPv4Address(host)) != host:
                raise invalid
        except ValueError:
            raise invalid from None
    elif not all(LABEL.fullmatch(label) for label in host.split(".")):
        raise invalid
    from agent.vault_store import normalize_origin
    try:
        return normalize_origin(value)
    except Exception:
        raise invalid from None


def display_text(value, limit, name):
    text = " ".join(value.split()) if isinstance(value, str) else ""
    if not 1 <= len(text) <= limit or HIDDEN.search(text):
        raise CredentialRequestError("invalid_" + name, f"Give a {name} of 1 to {limit} visible characters.")
    return text


def explicit_request(request_id):
    with _explicit_lock:
        value = _explicit.get(request_id)
        return dict(value) if value else None


def explicit_metadata(request_id):
    """What an explicit-origin card shows besides the native destination. None for other requests."""
    value = explicit_request(request_id)
    if not value:
        return None
    return dict(label=value["label"], purpose=value["purpose"], profile=value["profile"], requesterId=value["actor"])


def bind_prompt_waits(server, journal):
    """Keep a person's app login entry open until native answer/cancel/interrupt.

    Native login prompts expire after 180 seconds, even while the person is
    finding their password. The app shows no deadline. Other chats and prompt
    kinds retain their native timeouts.
    """
    original = server._ask
    if getattr(original, "_agent_interface_login_wait", False):
        return

    @functools.wraps(original)
    def ask(method, sid, params, timeout=300):
        if method == "vault.save_login":
            profile = journal.live_profile_for_session(sid)
            if profile is not None and journal.canonical_session(profile) == sid:
                with journal.lock:
                    receipt = journal.db.execute("SELECT 1 FROM receipts WHERE session_id=? AND terminal=0 AND steering=0 LIMIT 1", (sid,)).fetchone()
                if receipt:
                    timeout = None
        return original(method, sid, params, timeout=timeout)

    ask._agent_interface_login_wait = True
    server._ask = ask


def bind_requests(server_requests, journal):
    """Records each explicit-origin request's context under its native request ID as it is sent.

    The native save-login prompt carries only origin and site. Hermes sends it on the
    calling thread, so the request this tool's thread registers is the one it asked for.
    """
    original = server_requests._register
    if getattr(original, "_agent_interface_explicit", False):
        return
    def register(request):
        requests = getattr(_dispatch, "requests", None)
        if requests is not None:
            requests.append(request.id)
        context = getattr(_context, "value", None)
        if context is not None and request.method == "vault.save_login" and request.params.get("origin") == context["origin"]:
            # The member who started this app task owns its credential request.
            with journal.lock:
                row = journal.db.execute("SELECT actor FROM receipts WHERE session_id=? AND terminal=0 AND steering=0 "
                                         "ORDER BY created DESC LIMIT 1", (request.sid,)).fetchone()
            with _explicit_lock:
                _explicit[request.id] = dict(origin=context["origin"], label=context["label"], purpose=context["purpose"],
                                             profile=context["profile"], actor=row[0] if row else None, sid=request.sid)
            context["requests"].append(request.id)
        result = original(request)
        # The native caller waits on this request next; closed now, that wait returns at once.
        close_if_steered(server_requests, request)
        return result
    register._agent_interface_explicit = True
    server_requests._register = register


def failure(error_type, message):
    return json.dumps({"success": False, "error_type": error_type, "error": message})


def save_explicit_login(args, **_kwargs):
    """Asks the user for a login on the session's trusted masked prompt and saves it for an explicit origin.

    Uses the same native save-login callback as a browser login page, so every surface
    with that prompt supports it and every surface without one refuses. Only a handle
    and non-secret metadata return to the model.
    """
    try:
        if not isinstance(args, dict) or set(args) - {"origin", "label", "purpose"}:
            raise CredentialRequestError("invalid_arguments", "Pass only origin, label and purpose. Never pass a "
                                         "username, password or other credential to this tool.")
        origin = explicit_origin(args.get("origin"))
        label = display_text(args.get("label"), 80, "label")
        purpose = display_text(args.get("purpose"), 300, "purpose")
    except CredentialRequestError as error:
        return failure(error.error_type, str(error))
    from agent.vault_backends.unlock import can_prompt_here, get_save_login_prompt_callback
    prompt = get_save_login_prompt_callback()
    if prompt is None or not can_prompt_here():
        return failure("prompt_unavailable", "Nobody can answer a secure prompt in this session, as in a scheduled, "
                       "messaging or API run, so nothing was saved. Do not ask for the login in chat or with clarify. "
                       f"Tell the user to add it for {origin} in WildBots assistant settings > Logins, or with "
                       "`hermes vault add`, then continue once they say it is saved.")
    from hermes_constants import get_hermes_home, profile_name_for_home
    context = dict(origin=origin, label=label, purpose=purpose,
                   profile=profile_name_for_home(get_hermes_home()) or "default", requests=[])
    previous, _context.value = getattr(_context, "value", None), context
    try:
        # The prompt names the destination by host, as for a browser login page.
        answer = prompt(origin, origin.split("://", 1)[1])
    except Exception:
        answer = None
    finally:
        _context.value = previous
        with _explicit_lock:
            for request_id in context["requests"]:
                _explicit.pop(request_id, None)
    try:
        identifier = answer.get("identifier") if isinstance(answer, dict) else None
        password = answer.get("password") if isinstance(answer, dict) else None
        if not isinstance(identifier, str) or not isinstance(password, str) or not identifier.strip() \
                or not password or len(identifier) > 1000 or len(password) > 20000:
            if replied_in_chat(context["requests"]):
                return failure("user_replied_in_chat", CHAT_REPLY)
            return failure("not_saved", "The login was not saved: the user cancelled, the request expired or nobody "
                           "answered. Do not ask again unless the user asks you to. They can also add it in WildBots "
                           "assistant settings > Logins. Never ask for it in chat.")
        identifier = identifier.strip()
        from agent.redact import register_vault_redaction_value
        from agent.vault_store import get_vault_store
        # Before storage, so no later tool result can echo the value to the model.
        register_vault_redaction_value(password)
        kind = "email" if "@" in identifier else "phone" if identifier.lstrip("+").isdigit() else "username"
        try:
            meta = get_vault_store().add_item("login", label, dict(identifier_type=kind, identifier=identifier,
                                                                   password=password), origin=origin)
        except Exception:
            return failure("save_failed", "Hermes could not save this login in the profile vault, so nothing was "
                           "saved. Tell the user, and suggest adding it in WildBots assistant settings > Logins. Do not "
                           "ask for the password in chat.")
    finally:
        if isinstance(answer, dict):
            answer.clear()
        password = None
    return json.dumps({"success": True, "status": "saved", "handle": meta.id, "backend": "local", "label": meta.label,
                       "origin": meta.origin, "identifier": identifier, "identifier_type": kind,
                       "stored_in": "This profile's encrypted Hermes vault", "used": False,
                       "next": f"Saved only. Nothing was opened, checked or filled. browser_vault action=fill with this "
                               f"handle fills it only on a page whose origin is exactly {meta.origin}."}, ensure_ascii=False)


SCHEMA = dict(name=TOOL, description=(
    "Ask the user to save a login for an exact address. You can then sign in later without seeing the password. "
    "Use it only for a login you cannot capture from an open login page: a private network device, a "
    "service you cannot reach yet, or a login with no browser form. On an open login page, use browser_vault "
    "action=save_login instead. API keys and tokens are not logins. "
    "The user sees a card in WildBots with the address, your label and your purpose, and types the username and "
    "password into masked fields outside the chat. The call waits until they answer. Hermes stores the login in this "
    "profile's encrypted vault; you get a handle and the username, never the password. "
    "Results: status saved with a handle (saving does not open, check or sign in; browser_vault action=fill uses the "
    "handle only on a page whose origin matches exactly). error_type user_replied_in_chat: the user sent a message "
    "instead, so nothing was saved; read their message next, and if they still want this, call again with what they "
    "corrected. not_saved: they cancelled, it expired or nobody answered; do not ask again unless they ask you to. "
    "prompt_unavailable: nobody can answer here; tell them to add it in WildBots assistant settings > Logins. "
    "invalid_origin, invalid_label, invalid_purpose or invalid_arguments: fix that argument and call again. "
    "save_failed: tell the user. Never ask for, type or repeat a password in chat or clarify, and never pass one to "
    "this tool."),
    parameters=dict(type="object", additionalProperties=False, required=["origin", "label", "purpose"], properties=dict(
        origin=dict(type="string", description="Exact scheme, host and optional port, such as https://device.example.net "
                    "or https://192.0.2.10:8443. No path, query, fragment or credentials."),
        label=dict(type="string", description="Short recognizable name the user sees, such as Comet KVM. At most 80 "
                   "characters."),
        purpose=dict(type="string", description="One sentence telling the user why you need this login. At most 300 "
                     "characters."))))


def register_tool():
    from tools.registry import registry
    # An ask-the-user tool: it rides with clarify, and a session nobody can answer refuses at call time.
    registry.register(name=TOOL, toolset="clarify", schema=SCHEMA, handler=save_explicit_login, emoji="🔐")


def install(web, journal):
    from fastapi import Request
    from starlette.responses import JSONResponse
    from hermes_cli.backend_retirement import retirement
    from hermes_cli.web_routers._common import config_scoped_to_thread
    from tui_gateway import server
    async def endpoint(request: Request):
        try:
            if not getattr(request.state, "agent_interface_service_authenticated", False):
                raise VaultError(401)
            raw = await request.body()
            if len(raw) > 128 * 1024:
                raise VaultError(400)
            data = json.loads(raw)
            if not isinstance(data, dict) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", str(data.get("profile") or "")):
                raise VaultError(400)
            roster = native(server, "profiles.list", data["profile"], include_sessions=False).get("profiles", [])
            if not any(row.get("name") == data["profile"] for row in roster):
                raise VaultError(404)
            if data.get("operation") == "overview":
                result = await config_scoped_to_thread(data["profile"], lambda: operate(server, journal, data))
            else:
                with retirement.work() as admitted:
                    if not admitted:
                        raise VaultError()
                    result = await config_scoped_to_thread(data["profile"], lambda: operate(server, journal, data))
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception as error:
            return JSONResponse({"error": "Hermes could not confirm this credential operation. Refresh its status before trying again."},
                status_code=error.status if isinstance(error, VaultError) else 502, headers={"Cache-Control": "no-store"})
    globals()["Request"] = Request
    web.app.add_api_route("/api/agent-interface/credentials", endpoint, methods=["POST"])
    from tui_gateway import server_requests
    bind_requests(server_requests, journal)
    bind_prompt_waits(server, journal)
    journal.explicit_credential = explicit_metadata
    # The add-on calls this after durably admitting a member's message as steering.
    journal.steering_admitted = lambda _profile, sid, actor, text=None: close_for_chat(sid, actor, text)
    from tools.registry import registry
    bind_dispatch(registry)
    register_tool()
