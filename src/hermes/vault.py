"""Finite model-blind credential bridge. Native Hermes owns storage and fills.

Secret-bearing input goes only to native vault handlers or a verified live
server request. No payload is written to the application/add-on journal.
"""
import ipaddress
import json
import re
import threading
import uuid
from urllib.parse import urlsplit

METHODS = frozenset(("vault.save_login", "vault.code", "vault.unlock_prompt", "secret"))
MANAGERS = frozenset(("onepassword", "bitwarden"))
TOOL = "vault_save_login"
# Control, zero-width and bidirectional characters can disguise what a card shows.
HIDDEN = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁠-⁯﻿]")
LABEL = re.compile(r"(?!-)[a-z0-9-]{1,63}(?<!-)")
# The display context of the explicit-origin request this agent thread is about to send.
_context = threading.local()
# Native request ID -> what the requesting tool asked for, while that request can be answered.
_explicit_lock = threading.Lock()
_explicit = {}


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
            return dict(status="expired")
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
    resolved = server_requests.resolve_response({"jsonrpc": "2.0", "id": data["requestId"], "result": {"value": value}})
    return dict(status="ok" if resolved else "expired")


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
    if re.fullmatch(r"[0-9.]+", host):
        try:
            ipaddress.IPv4Address(host)
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


def bind_requests(server_requests, journal):
    """Records each explicit-origin request's context under its native request ID as it is sent.

    The native save-login prompt carries only origin and site. Hermes sends it on the
    calling thread, so the request this tool's thread registers is the one it asked for.
    """
    original = server_requests._register
    if getattr(original, "_agent_interface_explicit", False):
        return
    def register(request):
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
        return original(request)
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
        return failure("prompt_unavailable", "This session has no trusted masked prompt, as in a scheduled, messaging "
                       "or API run. Nothing was saved. Do not ask for the login in chat or with clarify. Ask the user to "
                       f"add it for {origin} in WildBots assistant settings > Logins, or with `hermes vault add`.")
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
            return failure("not_saved", "The login was not saved: the user cancelled, the request expired or nobody "
                           "answered. Do not ask again this turn, and never ask for it in chat.")
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
                           "saved. Tell the user. Do not ask for the password in chat.")
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
    "Save a website or device login for an explicit address. Use it when you need credentials you cannot capture "
    "from an open login page: a private network device, a service you cannot reach, or a login with no browser form. "
    "The user types the username and password into a masked prompt outside the conversation, and Hermes stores them "
    "in this profile's encrypted vault. You receive a handle and the username, never the password. Saving does not "
    "open, check or sign in to the address; browser_vault action=fill later uses the login only on a page whose origin "
    "matches exactly. On an open login page, use browser_vault action=save_login instead. API keys and tokens are not "
    "logins. Never ask for, type or repeat a password in chat or clarify, and never pass one to this tool. Stop on "
    "not_saved or prompt_unavailable."),
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
    journal.explicit_credential = explicit_metadata
    register_tool()
