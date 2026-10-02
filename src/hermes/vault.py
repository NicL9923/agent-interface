"""Finite model-blind credential bridge. Native Hermes owns storage and fills.

Secret-bearing input goes only to native vault handlers or a verified live
server request. No payload is written to the application/add-on journal.
"""
import json
import re
import uuid
from urllib.parse import urlsplit

METHODS = frozenset(("vault.save_login", "vault.code", "vault.unlock_prompt", "secret"))
MANAGERS = frozenset(("onepassword", "bitwarden"))


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
    owner = ("epoch", "sessionId", "method")
    if answer.get("cancel") is True:
        fields(answer, (*owner, "cancel"), (*owner, "cancel"))
        value = ""
    elif method == "vault.save_login":
        fields(answer, (*owner, "identifier", "password"), (*owner, "identifier", "password"))
        value = json.dumps(dict(identifier=text(answer["identifier"], 1000), password=text(answer["password"])))
    else:
        fields(answer, (*owner, "value"), (*owner, "value"))
        value = text(answer["value"])
    sid = text(answer["sessionId"], 200)
    if answer["epoch"] != journal.epoch or journal.canonical_session(data["profile"]) != sid:
        raise VaultError()
    with server_requests._lock:
        request = server_requests._open.get(data["requestId"])
        if request is None:
            return dict(status="expired")
        if request.sid != sid or request.method != method or journal.live_profile_for_session(sid) != data["profile"]:
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
        fields(data, (*common, "requestId", "answer"), (*common, "requestId", "answer"))
        text(data["requestId"], 200)
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
