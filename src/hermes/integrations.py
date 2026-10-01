"""Finite profile-scoped integration adapter. Hermes retains every credential.

Only the private service-auth prefix admits these operations. No generic URL
proxy, shell installation, environment editor, or credential reveal is exposed.
"""
import asyncio
import datetime
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import secrets
import socket
import stat
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

class IntegrationError(ValueError):
    pass


FLOWS = {}
FLOW_LOCK = threading.RLock()
GOOGLE_LOCKS = {}
MCP_LIFECYCLE_LOCK = threading.Lock()
MCP_DISCONNECTING = set()
SCOPES = {
    "gmail": ("Gmail", "https://www.googleapis.com/auth/gmail.modify"),
    "calendar": ("Calendar", "https://www.googleapis.com/auth/calendar"),
    "drive": ("Drive", "https://www.googleapis.com/auth/drive"),
    "tasks": ("Tasks", "https://www.googleapis.com/auth/tasks"),
    "contacts": ("Contacts", "https://www.googleapis.com/auth/contacts.readonly"),
}
PRESETS = {
    "github": ("GitHub", "development"), "synology": ("Synology NAS", "files"),
    "supabase": ("Supabase", "development"), "cloudflare": ("Cloudflare", "development"),
    "vps": ("VPS health", "development"), "home_assistant": ("Home Assistant", "home"),
}
DEFAULT_URLS = {"github": "https://api.githubcopilot.com/mcp/readonly", "supabase": "https://mcp.supabase.com/mcp?read_only=true", "cloudflare": "https://observability.mcp.cloudflare.com/mcp"}
KEYS = {
    "openai": ("OpenAI", "OPENAI_API_KEY"), "anthropic_key": ("Anthropic API", "ANTHROPIC_API_KEY"),
    "gemini": ("Google Gemini", "GEMINI_API_KEY"), "openrouter": ("OpenRouter", "OPENROUTER_API_KEY"),
    "brave": ("Brave Search", "BRAVE_SEARCH_API_KEY"), "exa": ("Exa Search", "EXA_API_KEY"), "firecrawl": ("Firecrawl", "FIRECRAWL_API_KEY"),
    "fal": ("Fal image generation", "FAL_KEY"),
}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def card(identity, name, category, profile, status="not_connected", detail="Not connected to this Hermes profile.", **extra):
    result = dict(id=identity, name=name, category=category, owner="Hermes", profile=profile,
                  status=status, detail=detail, permissions=[], setup=[], capabilities=[],
                  botIds=[profile], actions=dict(connect=True, check=True, disconnect=False))
    result.update(extra)
    return result


def private_json(path):
    path = Path(path)
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
        raise IntegrationError("OAuth client file must be an owner-only regular file.")
    return json.loads(path.read_text())


def fingerprint(home):
    digest = hashlib.sha256()
    for name in ("google_token.json", ".env", "config.yaml"):
        path = Path(home) / name
        digest.update(name.encode())
        digest.update(path.read_bytes() if path.exists() else b"missing")
    return digest.hexdigest()


def cache_check(home, result):
    path = Path(home) / "agent_interface_integration_checks.json"
    try:
        cached = private_json(path)
    except (ValueError, OSError):
        cached = {}
    cached[result["id"]] = dict(fingerprint=fingerprint(home), checked=result)
    atomic_json(path, cached)


def apply_checks(home, rows):
    try:
        saved = private_json(Path(home) / "agent_interface_integration_checks.json")
    except (ValueError, OSError):
        return rows
    current = fingerprint(home)
    for row in rows:
        checked = saved.get(row["id"], {})
        if checked.get("fingerprint") == current:
            evidence = checked.get("checked", {})
            for field in ("status", "detail", "checkedAt", "account", "capabilities"):
                if field in evidence:
                    row[field] = evidence[field]
    return rows


def atomic_json(path, payload):
    path = Path(path)
    temp = path.with_name(path.name + "." + secrets.token_hex(8))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def maintenance():
    lease = os.environ.get("HERMES_AGENT_INTERFACE_MAINTENANCE_FILE")
    if lease:
        path = Path(lease)
        if not path.is_absolute():
            raise IntegrationError("Invalid native maintenance configuration.")
        if path.exists():
            # Even a corrupt lease must fail closed.
            raise IntegrationError("Hermes is being upgraded. Connections are paused until recovery finishes.")


def validate_remote_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise IntegrationError("Use an HTTPS MCP URL without credentials, query, or fragment.")
    query = parse_qs(parsed.query)
    if parsed.query and (parsed.hostname != "mcp.supabase.com" or any(key not in {"read_only", "project_ref", "features"} for key in query) or query.get("read_only", ["true"]) != ["true"] or any(not re.fullmatch(r"[A-Za-z0-9_,.-]{1,100}", value) for values in query.values() for value in values)):
        raise IntegrationError("Query parameters are allowed only for scoped read-only Supabase endpoints.")
    allowed = set(filter(None, os.environ.get("HERMES_AGENT_INTERFACE_MCP_HOSTS", "").split(",")))
    trusted = {"api.githubcopilot.com", "mcp.supabase.com", "mcp.cloudflare.com", "observability.mcp.cloudflare.com"}
    if parsed.hostname in allowed:
        return value
    if parsed.hostname not in trusted:
        raise IntegrationError("The installer must add this custom MCP hostname to HERMES_AGENT_INTERFACE_MCP_HOSTS before connecting.")
    # Existing native MCP transport owns redirects and OAuth. New app-managed
    # targets may never name a local/network-management address without installer opt-in.
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(entry[4][0]).is_global for entry in addresses):
        raise IntegrationError("Private MCP hosts require the installer's explicit host allowlist.")
    return value


def clean_url(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            return None
        # Authorization URLs intentionally carry OAuth state and challenge; never
        # accept access tokens, client secrets, or refresh tokens in a browser URL.
        query = parse_qs(parsed.query)
        if any(key.lower() in {"access_token", "refresh_token", "client_secret", "token", "api_key"} for key in query):
            return None
        return value
    except (ValueError, TypeError):
        return None


def permission_granted(key, granted):
    scope = SCOPES[key][1]
    equivalents = {"gmail": {"https://mail.google.com/"}, "contacts": {"https://www.googleapis.com/auth/contacts"}}
    return scope in granted or bool(equivalents.get(key, set()) & granted)


def scopes_from(payload):
    value = payload.get("scopes") or payload.get("scope") or []
    return set(value.split() if isinstance(value, str) else value)


def workspace(home, profile):
    token = Path(home) / "google_token.json"
    if not token.exists():
        return card("google_workspace", "Google Workspace", "productivity", profile,
                    capabilities=[label for label, _ in SCOPES.values()])
    try:
        payload = json.loads(token.read_text())
        granted = scopes_from(payload)
        permissions = [dict(id=key, name=name, granted=permission_granted(key, granted)) for key, (name, scope) in SCOPES.items()]
        # Unknown scope evidence is never a green grant.
        missing = any(not p["granted"] for p in permissions)
        status = "missing_permission" if missing else "configured"
        detail = "Saved Google grant. Check verifies live access." if not missing else "Saved Google grant lacks some requested permissions. Reconnect to review consent."
        return card("google_workspace", "Google Workspace", "productivity", profile, status, detail,
                    account=payload.get("account") if isinstance(payload.get("account"), str) else None,
                    permissions=permissions, capabilities=[label for label, _ in SCOPES.values()],
                    setup=[] if payload.get("account") else [dict(key="expectedAccount", label="Expected Google account email for this existing grant", kind="text", required=True)],
                    actions=dict(connect=True, check=True, disconnect=True))
    except (ValueError, OSError):
        return card("google_workspace", "Google Workspace", "productivity", profile, "expired", "The saved Google grant cannot be read. Reconnect this profile.")


def google_request():
    from google.auth.transport.requests import Request
    transport = Request()
    def bounded(*args, **kwargs):
        kwargs["timeout"] = 10
        return transport(*args, **kwargs)
    return bounded


def check_workspace(home, profile):
    result = workspace(home, profile)
    if result["status"] == "not_connected":
        return result
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        import requests
        path = Path(home) / "google_token.json"
        with FLOW_LOCK:
            lock = GOOGLE_LOCKS.setdefault(str(home), threading.RLock())
        with lock:
            credentials = Credentials.from_authorized_user_file(str(path))
            if not credentials.valid:
                # Live check refreshes in memory only. Native skill processes
                # remain the durable refresh writer for the existing owner.
                credentials.refresh(google_request())
            response = requests.get("https://www.googleapis.com/oauth2/v2/userinfo", headers={"Authorization": "Bearer " + credentials.token}, timeout=10)
            # Old grants lack userinfo scope. A calendar read proves live auth
            # while retaining account identity as unknown.
            if response.status_code == 200:
                identity = response.json()
                result["account"] = identity.get("email")
            probe = requests.get("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1", headers={"Authorization": "Bearer " + credentials.token}, timeout=10)
            if probe.status_code == 401:
                result.update(status="expired", detail="Google rejected the saved grant. Reconnect this profile.")
            elif probe.status_code == 403:
                result.update(status="missing_permission", detail="Google refused Calendar access. Review granted permissions and whether the Calendar API is enabled.")
            elif probe.status_code == 200:
                result.update(status="missing_permission" if any(not p["granted"] for p in result["permissions"]) else "connected", detail="Google accepted a live Calendar read. Permission indicators show the saved grant for other services.")
            else:
                result.update(status="unavailable", detail="Google could not complete the connection check. Retry later.")
    except ImportError:
        result.update(status="unavailable", detail="The Hermes Google dependencies are missing. Ask the installer to enable the Google extra.")
    except Exception as exc:
        revoked = any(word in str(exc).lower() for word in ("invalid_grant", "invalid_client", "revoked"))
        result.update(status="expired" if revoked else "unavailable", detail="Google authorization needs reconnecting." if revoked else "The Google connection check could not finish. Retry later.")
    result["checkedAt"] = now()
    return result


def disconnect_google(home):
    with FLOW_LOCK:
        lock = GOOGLE_LOCKS.setdefault(str(home), threading.RLock())
    # Same lock order as final grant commit: per-home Google lock, then flows.
    # Cancel exchanging first-consent flows even when no old grant exists.
    with lock, FLOW_LOCK:
        maintenance()
        for entry in FLOWS.values():
            if entry["home"] == str(home) and entry["kind"] == "google" and entry["status"] in ("pending", "exchanging"):
                entry["status"] = "cancelled"
        (Path(home) / "google_token.json").unlink(missing_ok=True)


def begin_google(home, profile, redirect_uri, fields=None):
    expected_account = (fields or {}).get("expectedAccount", "").strip().lower()
    token_path = Path(home) / "google_token.json"
    if token_path.exists():
        previous = json.loads(token_path.read_text())
        if previous.get("account"):
            expected_account = previous["account"].lower()
        elif not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", expected_account):
            return dict(kind="instructions", status="error", message="Enter the expected Google account email before reconnecting this legacy grant. The new authorization must match it; the old grant stays intact until success.")
    with FLOW_LOCK:
        for key, previous in FLOWS.items():
            if previous["profile"] == profile and previous["home"] == str(home) and previous["kind"] == "google" and previous["status"] in ("pending", "exchanging") and previous["expires"] > time.time():
                if expected_account != previous.get("expected_account", ""):
                    raise IntegrationError("Cancel the existing Google authorization before choosing another account.")
                return flow_summary(key, previous)
    client_path = os.environ.get("HERMES_AGENT_INTERFACE_GOOGLE_CLIENT_FILE") or str(Path(home) / "google_client_secret.json")
    try:
        client = private_json(client_path)
    except (ValueError, OSError):
        return dict(kind="instructions", status="error", message="The installer must supply an owner-only Google OAuth web client JSON and register " + redirect_uri + ". Existing Workspace credentials remain in this Hermes profile.")
    section = client.get("web") or client.get("installed")
    if not isinstance(section, dict):
        raise IntegrationError("Expected a Google OAuth web or installed client.")
    manual = "web" not in client
    if not manual and redirect_uri not in section.get("redirect_uris", []):
        return dict(kind="instructions", status="error", message="Register " + redirect_uri + " on the configured Google OAuth web client before connecting. Existing grants stay intact.")
    if urlsplit(section.get("auth_uri", "")).hostname != "accounts.google.com" or section.get("token_uri") != "https://oauth2.googleapis.com/token":
        raise IntegrationError("Use an official Google OAuth client with Google authorization and token endpoints.")
    actual_redirect = "http://localhost:1" if manual else redirect_uri
    try:
        from google_auth_oauthlib.flow import Flow
    except ImportError:
        return dict(kind="instructions", status="error", message="Ask the installer to enable Hermes's Google extra and restart the native service before connecting Google Workspace. Existing grants stay intact.")
    flow = Flow.from_client_config(client, scopes=[scope for _, scope in SCOPES.values()] + ["openid", "https://www.googleapis.com/auth/userinfo.email"], redirect_uri=actual_redirect, autogenerate_code_verifier=True)
    url, state = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true")
    flow_id = secrets.token_urlsafe(24)
    with FLOW_LOCK:
        for key, previous in list(FLOWS.items()):
            if previous["expires"] < time.time():
                del FLOWS[key]
        for existing_id, existing in FLOWS.items():
            if existing["profile"] == profile and existing["home"] == str(home) and existing["kind"] == "google" and existing["status"] in ("pending", "exchanging"):
                if expected_account != existing.get("expected_account", ""):
                    raise IntegrationError("Cancel the existing Google authorization before choosing another account.")
                return flow_summary(existing_id, existing)
        FLOWS[flow_id] = dict(kind="google", profile=profile, home=str(home), state=state, flow=flow, client=client, expires=time.time()+600, status="pending", manual=manual, public_url=url, flow_kind="redirect", callbackInput=manual, expected_account=expected_account, original_token=(Path(home) / "google_token.json").read_bytes() if (Path(home) / "google_token.json").exists() else None)
    return dict(kind="redirect", status="pending", flowId=flow_id, url=url, callbackInput=manual,
                message="Authorize Google, then return to check this connection." if not manual else "This existing installed OAuth client uses an advanced manual flow. Copy the entire localhost redirect URL and paste it here. A registered web client enables automatic completion.")


def google_callback(callback_url, flow_id=None, profile=None):
    parsed = urlsplit(callback_url)
    query = parse_qs(parsed.query)
    if any(len(query.get(key, [])) != 1 for key in ("state",)) or any(len(query.get(key, [])) > 1 for key in ("code", "error", "scope")):
        raise IntegrationError("Google callback parameters are ambiguous.")
    state = query.get("state", [""])[0]
    with FLOW_LOCK:
        selected = [(key, flow) for key, flow in FLOWS.items() if flow["kind"] == "google" and secrets.compare_digest(flow["state"], state) and (not flow_id or key == flow_id)]
        if len(selected) != 1:
            raise IntegrationError("Google authorization state is invalid or expired.")
        key, entry = selected[0]
        if entry["status"] != "pending" or entry["expires"] < time.time() or profile and profile != entry["profile"]:
            raise IntegrationError("Google authorization is expired, already used, or belongs to another profile.")
        expected = urlsplit(entry["flow"].redirect_uri)
        if (parsed.scheme, parsed.netloc, parsed.path) != (expected.scheme, expected.netloc, expected.path):
            raise IntegrationError("Google callback address does not match this authorization.")
        entry["status"] = "exchanging"
    if query.get("error"):
        entry["status"] = "error"
        return dict(kind="instructions", status="error", flowId=key, message="Google consent was declined. Your previous grant remains available.")
    if not query.get("code"):
        entry["status"] = "error"
        raise IntegrationError("The full Google callback URL must include its code and state.")
    maintenance()
    try:
        if query.get("scope"):
            entry["flow"].oauth2session.scope = query["scope"][0].split()
        entry["flow"].fetch_token(code=query["code"][0], timeout=15)
        credentials = entry["flow"].credentials
        # Identity is fetched from Google using the new grant, never accepted
        # from callback parameters or unverified JWT payloads.
        import requests
        response = requests.get("https://www.googleapis.com/oauth2/v2/userinfo", headers={"Authorization": "Bearer " + credentials.token}, timeout=10)
        response.raise_for_status()
        account = response.json().get("email")
        if not isinstance(account, str) or not account:
            raise IntegrationError("Google did not confirm the authorized account.")
        if entry.get("expected_account") and entry["expected_account"] != account.lower():
            raise IntegrationError("The authorized Google account does not match the account selected for this connection.")
        payload = json.loads(credentials.to_json())
        actual_scopes = entry["flow"].oauth2session.token.get("scope") or credentials.granted_scopes or []
        payload["scopes"] = actual_scopes.split() if isinstance(actual_scopes, str) else list(actual_scopes)
        payload["account"] = account
        if not payload.get("refresh_token"):
            raise IntegrationError("Google did not provide an offline grant. Reconnect with consent.")
        with FLOW_LOCK:
            lock = GOOGLE_LOCKS.setdefault(entry["home"], threading.RLock())
        with lock:
            maintenance()
            old_path = Path(entry["home"]) / "google_token.json"
            if old_path.exists():
                old_bytes = old_path.read_bytes()
                if old_bytes != entry["original_token"]:
                    raise IntegrationError("The Google grant changed during authorization. Start again to preserve the current owner.")
                old = json.loads(old_bytes)
                if old.get("account") and old["account"].lower() != account.lower():
                    raise IntegrationError("This profile already belongs to a different Google account. Disconnect it explicitly before changing accounts.")
            elif entry["original_token"] is not None:
                raise IntegrationError("The Google grant was removed during authorization. Start again.")
            # Freeze native dashboard admission only for the short disk commit,
            # after every network call. Native prepare checks sessions, cron and
            # pending human input; an ordinary work reservation is not exclusive.
            from hermes_cli.backend_retirement import retirement
            permit = retirement.prepare()
            if not permit.get("ok"):
                raise IntegrationError("Wait for native work to finish before saving the Google grant.")
            try:
                maintenance()
                if old_path.exists() and old_path.read_bytes() != entry["original_token"]:
                    raise IntegrationError("The Google grant changed during authorization. Start again.")
                with FLOW_LOCK:
                    if entry["status"] != "exchanging" or entry["expires"] < time.time():
                        raise IntegrationError("Google authorization was cancelled or expired before completion.")
                    atomic_json(old_path, payload)
                    entry["status"] = "approved"
            finally:
                retirement.cancel(permit["token"])
        return dict(kind="connected", status="approved", flowId=key, message="Google Workspace is connected to " + account + ". Enable the Google Tasks toolset on this bot to read its task lists and tasks.")
    except Exception:
        with FLOW_LOCK:
            if entry["status"] != "cancelled":
                entry["status"] = "error"
        raise IntegrationError("Google authorization could not be verified and saved. The previous grant is preserved. Retry or check the configured account and client.") from None


def validate_selected_root(root, home):
    from hermes_constants import get_default_hermes_root
    candidate = Path(root).resolve()
    protected = {Path(home).resolve(), Path(get_default_hermes_root(home=home)).resolve()}
    if any(candidate.is_relative_to(owner) or owner.is_relative_to(candidate) for owner in protected):
        raise IntegrationError("Selected folders cannot include Hermes credential homes or profile directories.")


def selected_file(home, relative):
    """Read only within explicitly selected roots, with symlinks refused."""
    from hermes_cli.config import load_config
    roots = load_config().get("agent_interface_file_roots", [])
    value = Path(relative)
    if value.is_absolute() or ".." in value.parts or not value.parts:
        raise IntegrationError("Use a root index and a relative path, without parent traversal.")
    root_index, *parts = value.parts
    if not root_index.isdecimal() or int(root_index) >= len(roots):
        raise IntegrationError("Unknown selected folder.")
    root = Path(roots[int(root_index)])
    validate_selected_root(root, home)
    from agent.file_safety import get_read_block_error
    if get_read_block_error(str(root.joinpath(*parts))):
        raise IntegrationError("Hermes protects this file from direct reads. Use the owning integration instead.")
    # Walk by descriptors to avoid symlink swapping between check and read.
    fd = os.open(root.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in root.parts[1:]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
    except BaseException:
        os.close(fd)
        raise
    try:
        for part in parts:
            if part.startswith(".") or re.search(r"(?:credential|secret|token|password)", part, re.I):
                raise IntegrationError("Credential files cannot be read through selected folders.")
            next_fd = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if stat.S_ISDIR(info.st_mode):
            return {"entries": sorted(name for name in os.listdir(fd) if not name.startswith(".") and not re.search(r"(?:credential|secret|token|password)", name, re.I))[:200]}
        if not stat.S_ISREG(info.st_mode) or info.st_size > 100000:
            raise IntegrationError("Select a regular text file of at most 100 KB.")
        return {"text": os.read(fd, 100001).decode("utf-8")}
    finally:
        os.close(fd)


def register_tool_catalog():
    from hermes_cli import tools_config
    # Native checklist metadata is a finite mutable catalog, while toolset
    # resolution itself already merges registered custom sets.
    for identity, label, description in [("selected_files", "Selected files", "Read-only selected folders and bounded UTF-8 text"), ("google_tasks", "Google Tasks", "Read-only task lists and tasks from the profile's Google grant")]:
        if not any(row[0] == identity for row in tools_config.CONFIGURABLE_TOOLSETS):
            tools_config.CONFIGURABLE_TOOLSETS.append((identity, label, description))


def register_google_tasks_tool():
    from tools.registry import registry
    schema = dict(name="integration_google_tasks", description="Read Google Tasks using this Hermes profile's existing Google Workspace grant. List task lists or tasks in one list. No changes are made.", parameters=dict(type="object", properties={"task_list_id": dict(type="string")}, additionalProperties=False))
    def handle(args, **kwargs):
        from hermes_constants import get_hermes_home
        try:
            from google.oauth2.credentials import Credentials
            from google.auth.transport.requests import Request
            import requests
            credentials = Credentials.from_authorized_user_file(str(Path(get_hermes_home()) / "google_token.json"))
            if not credentials.valid:
                credentials.refresh(google_request())
            identity = args.get("task_list_id")
            if identity and not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", identity):
                raise IntegrationError("Invalid task list.")
            url = "https://tasks.googleapis.com/tasks/v1/lists/" + identity + "/tasks?maxResults=100" if identity else "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100"
            result = requests.get(url, headers={"Authorization": "Bearer " + credentials.token}, timeout=10)
            result.raise_for_status()
            return json.dumps(result.json())
        except Exception:
            return json.dumps({"error": "Google Tasks could not be read. Check the profile's grant, Tasks permission and API availability."})
    def available():
        from hermes_constants import get_hermes_home
        path = Path(get_hermes_home()) / "google_token.json"
        try:
            return permission_granted("tasks", scopes_from(json.loads(path.read_text())))
        except (ValueError, OSError):
            return False
    registry.register(name="integration_google_tasks", toolset="google_tasks", schema=schema, handler=handle, check_fn=available)


def register_file_tool():
    from tools.registry import registry
    schema = dict(name="integration_read_file", description="List or read a text file within folders explicitly selected for this Hermes profile. Paths begin with the folder's zero-based index, such as 0/notes.txt. Read-only; no symlinks.", parameters=dict(type="object", properties={"path": dict(type="string")}, required=["path"]))
    def handle(args, **kwargs):
        from hermes_constants import get_hermes_home
        try:
            return json.dumps(selected_file(get_hermes_home(), args.get("path", "")))
        except Exception:
            return json.dumps({"error": "That path cannot be read from the selected folders. Use a regular UTF-8 text file, at most 100 KB, with no symlinks or parent traversal."})
    def available():
        from hermes_cli.config import load_config
        return bool(load_config().get("agent_interface_file_roots"))
    registry.register(name="integration_read_file", toolset="selected_files", schema=schema, handler=handle, check_fn=available)


async def inventory(profile):
    from hermes_cli.web_routers import mcp, config_env, oauth, messaging
    from hermes_cli.web_routers._common import config_scoped_to_thread
    from hermes_constants import get_hermes_home
    home, env, roots = await config_scoped_to_thread(profile, lambda: (str(get_hermes_home()), dict(__import__("hermes_cli.config", fromlist=["load_env"]).load_env()), __import__("hermes_cli.config", fromlist=["load_config"]).load_config().get("agent_interface_file_roots", [])))
    rows = [workspace(home, profile)]
    servers = (await mcp.list_mcp_servers(profile))["servers"]
    server_map = {row["name"]: row for row in servers}
    for key, (label, category) in PRESETS.items():
        native = server_map.get(key)
        rows.append(card(key, label, category, profile, "configured" if native else "not_connected",
                         "MCP server saved in this Hermes profile. Check verifies tool discovery." if native else "Connect this service's MCP endpoint. Credentials stay in Hermes.",
                         setup=[dict(key="url", label="HTTPS MCP endpoint", kind="url", required=key not in DEFAULT_URLS, defaultValue=DEFAULT_URLS.get(key, "")), dict(key="auth", label="Authentication", kind="text", required=True, defaultValue="bearer" if key in ("github", "home_assistant") else "oauth", options=[dict(value="oauth", label="Browser sign-in"), dict(value="bearer", label="Access token"), dict(value="none", label="No sign-in")]), dict(key="token", label="Bearer token", kind="secret", required=False)] if not native else [dict(key="token", label="New bearer token", kind="secret", required=True)] if native.get("auth") == "header" else [],
                         actions=dict(connect=not native or native.get("auth") in ("oauth", "header"), check=bool(native), disconnect=bool(native) and native.get("source") != "plugin"), capabilities=["Tools provided by the connected MCP server"] ))
    for native in servers:
        if native["name"] in PRESETS:
            continue
        rows.append(card("mcp:" + native["name"], native["name"], "custom", profile, "configured",
                         "Configured MCP server. A saved configuration does not prove live access.",
                         setup=[dict(key="token", label="New bearer token", kind="secret", required=True)] if native.get("auth") == "header" else [],
                         actions=dict(connect=native.get("auth") in ("oauth", "header") and native.get("source") != "plugin", check=True, disconnect=native.get("source") != "plugin"), capabilities=["Native MCP tools"]))
    rows.append(card("selected_files", "Selected files and folders", "files", profile, "configured" if roots else "not_connected",
                     "Read-only selected folder adapter is available to Hermes. Check verifies those folders." if roots else "Choose a server folder under an installer-approved base. Mounted NAS folders can use the same read-only adapter.",
                     setup=[dict(key="paths", label="Absolute server folder paths, one per line", kind="text", required=True)],
                     actions=dict(connect=True, check=bool(roots), disconnect=bool(roots)), capabilities=["List selected folders", "Read UTF-8 text files up to 100 KB"], account=", ".join(Path(p).name for p in roots)))
    rows.append(card("apple", "Apple device calendars and reminders", "devices", profile, "unsupported", "Use the iOS app to choose calendars or reminder lists on this iPhone and share a snapshot with a bot. The server has no Apple account grant.", actions=dict(connect=False, check=False, disconnect=False), owner="This iPhone", capabilities=["User-selected calendar and reminder snapshots in iOS"]))
    try:
        platforms = (await messaging.get_messaging_platforms(profile)).get("platforms", [])
        if isinstance(platforms, dict):
            platforms = list(platforms.values())
        discord = next((p for p in platforms if p.get("id") == "discord"), {})
        configured = bool(env.get("DISCORD_BOT_TOKEN"))
        rows.append(card("discord", "Discord", "messaging", profile, "configured" if configured else "not_connected", "Native Discord channel is configured. Check verifies its token." if configured else "Connect the Discord bot in the official Hermes Channels page.", actions=dict(connect=False, check=configured, disconnect=False), capabilities=["Native Discord messaging"]))
    except Exception:
        rows.append(card("discord", "Discord", "messaging", profile, "unavailable", "Native Discord status could not be read. Open Hermes Channels to review.", actions=dict(connect=False, check=False, disconnect=False)))
    for key, (label, env_key) in KEYS.items():
        configured = bool(env.get(env_key))
        rows.append(card("key:" + key, label, "providers", profile, "configured" if configured else "not_connected", "A provider key is saved. Check verifies it when Hermes supports a live probe." if configured else "Add a provider key to this Hermes profile.", setup=[dict(key="token", label="API key", kind="secret", required=True)], actions=dict(connect=True, check=configured, disconnect=configured), capabilities=["Search" if key in ("brave", "firecrawl", "exa") else "Image generation" if key == "fal" else "Models"]))
    providers = (await oauth.list_oauth_providers(profile)).get("providers", [])
    for provider in providers:
        status = provider.get("status") or {}
        connected = bool(status.get("logged_in") or status.get("connected") or status.get("authenticated"))
        rows.append(card("provider:" + provider["id"], provider["name"], "providers", profile, "configured" if connected else "not_connected",
                         "Hermes has provider credentials. Its native provider status is configuration evidence." if connected else "Authorize this model provider through its native Hermes flow." if provider["flow"] == "device_code" else "This provider's account is owned by its official CLI. Complete sign-in there, then refresh this list.",
                         actions=dict(connect=provider["flow"] == "device_code", check=False, disconnect=bool(provider.get("disconnectable") and connected)), capabilities=["Models"]))
    return dict(profile=profile, canManage=False, connections=apply_checks(home, rows))


def flow_summary(key, entry):
    expired = entry["expires"] < time.time()
    status = "expired" if expired else entry["status"]
    pending = status in ("pending", "exchanging")
    result = dict(kind=entry.get("flow_kind", "redirect") if pending else "connected" if status == "approved" else "instructions", status="pending" if status == "exchanging" else status,
                  flowId=key, expiresAt=datetime.datetime.fromtimestamp(entry["expires"], datetime.timezone.utc).isoformat(),
                  message="Authorization completed. Refresh the connection status." if status == "approved" else "Authorization expired. Start again." if status == "expired" else "Waiting for authorization." if pending else "Authorization cancelled. Refresh connection status." if status == "cancelled" else "Authorization did not complete. Check connection status before retrying.")
    if pending:
        for field in ("userCode", "callbackInput"):
            if field in entry:
                result[field] = entry[field]
        if clean_url(entry.get("public_url")):
            result["url"] = entry["public_url"]
    return result


def lookup_flow(key, profile):
    with FLOW_LOCK:
        entry = FLOWS.get(key)
        if entry and entry["profile"] != profile:
            raise IntegrationError("Authorization flow belongs to another profile.")
        return entry


def cancel_mcp_workers(native, server_name, home, timeout=5):
    """Cancel app and original-dashboard flows, then wait for their final writes."""
    with native._mcp_oauth_flows_lock:
        entries = [flow for flow in native._mcp_oauth_flows.values() if flow.server_name == server_name and flow.hermes_home == str(home) and not flow.worker_done]
        for flow in entries:
            flow.mark_error("Disconnected by user", cancelled=True)
    deadline = time.monotonic() + timeout
    for flow in entries:
        if not flow._worker_done.wait(max(0, deadline - time.monotonic())):
            raise IntegrationError("MCP authorization is still finishing. Retry disconnect after it settles; the connection has not been removed.")
    with native._mcp_oauth_flows_lock:
        if any(flow.server_name == server_name and flow.hermes_home == str(home) and not flow.worker_done for flow in native._mcp_oauth_flows.values()):
            raise IntegrationError("Another MCP authorization started. Cancel it before disconnecting this service.")
    with FLOW_LOCK:
        for entry in FLOWS.values():
            if entry["kind"] == "mcp" and entry["home"] == str(home) and entry.get("native_id") in {flow.flow_id for flow in entries}:
                entry["status"] = "cancelled"


def disconnect_mcp(native, server_name, home, profile):
    from hermes_cli.web_routers._common import config_write_scope
    from hermes_cli.mcp_config import _get_mcp_servers, _remove_mcp_server
    from tui_gateway.mcp_rpc_helpers import server_configs_with_sources
    key = (str(home), server_name)
    with MCP_LIFECYCLE_LOCK:
        if key in MCP_DISCONNECTING:
            raise IntegrationError("This MCP service is already disconnecting. Refresh its connection status.")
        MCP_DISCONNECTING.add(key)
    try:
        cancel_mcp_workers(native, server_name, home)
        # New native workers are refused by the same per-server fence until
        # removal finishes. Never hold the native registry lock over profile
        # locking or disk writes, which could block the native event loop.
        with config_write_scope(profile):
            maintenance()
            _, plugins = server_configs_with_sources(_get_mcp_servers())
            if plugins.get(server_name):
                raise IntegrationError("This MCP service is owned by a plugin. Disconnect it through its owner.")
            if not _remove_mcp_server(server_name):
                raise IntegrationError("This MCP connection was already removed. Refresh connection status.")
    finally:
        with MCP_LIFECYCLE_LOCK:
            MCP_DISCONNECTING.discard(key)


async def dispatch(data, request):
    from hermes_cli.web_routers import mcp, config_env, oauth, messaging
    from hermes_cli.web_routers._common import config_scoped_to_thread, config_write_scope
    from hermes_constants import get_hermes_home
    from hermes_cli.web_models import MCPServerCreate, EnvVarUpdate, EnvVarDelete
    operation, profile, identity = data.get("operation"), data.get("profile"), data.get("id", "")
    if operation == "callback":
        # Public callback has only native unguessable OAuth state as authority;
        # manual callbacks also require exact flow + profile from the app.
        return await asyncio.to_thread(google_callback, data.get("callbackUrl", ""), data.get("flowId"), profile if data.get("flowId") else None)
    if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", profile):
        raise IntegrationError("Choose an explicit Hermes profile.")
    home = await config_scoped_to_thread(profile, lambda: str(get_hermes_home().resolve()))
    if operation == "list":
        return await inventory(profile)
    if operation in ("flow", "cancel"):
        key = data.get("flowId", "")
        entry = lookup_flow(key, profile)
        if entry is None:
            return dict(kind="instructions", status="expired", flowId=key, message="This authorization expired or Hermes restarted. Start the connection again.")
        if operation == "cancel":
            maintenance()
            if entry["kind"] == "mcp":
                await mcp.cancel_mcp_oauth_flow(entry["native_id"], request)
            elif entry["kind"] == "provider":
                await oauth.cancel_oauth_session(entry["native_id"], request, profile)
            with FLOW_LOCK:
                if entry["status"] in ("pending", "exchanging"):
                    entry["status"] = "cancelled"
            return flow_summary(key, entry)
        if entry["expires"] < time.time() or entry["status"] in ("cancelled", "error", "expired", "approved"):
            return flow_summary(key, entry)
        try:
            if entry["kind"] == "mcp":
                result = await mcp.mcp_oauth_flow_status(entry["native_id"], request)
                entry["status"] = {"authorization_required": "pending", "approved": "approved", "error": "error", "cancelled": "cancelled"}.get(result.get("status"), "pending")
            elif entry["kind"] == "provider":
                result = await oauth.poll_oauth_session(entry["provider"], entry["native_id"], profile)
                entry["status"] = {"pending": "pending", "approved": "approved", "cancelled": "cancelled", "error": "error", "denied": "error"}.get(result.get("status"), "error")
        except Exception as error:
            if getattr(error, "status_code", None) != 404:
                raise
            entry["status"] = "expired"
        return flow_summary(key, entry)
    maintenance()
    if operation == "connect" and identity in PRESETS:
        existing = (await mcp.list_mcp_servers(profile))["servers"]
        if any(server["name"] == identity for server in existing):
            identity = "mcp:" + identity
    if operation == "add_mcp" or operation == "connect" and identity in PRESETS:
        supplied = data.get("mcp") or data.get("fields") or {}
        name = supplied.get("name") if operation == "add_mcp" else identity
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", name):
            raise IntegrationError("Use an MCP name containing letters, numbers, underscores, or hyphens.")
        auth = supplied.get("auth") or ("bearer" if name in ("github", "home_assistant") else "oauth")
        if auth == "bearer" and not (supplied.get("token") or "").strip():
            raise IntegrationError("Enter an access token for bearer authentication.")
        if auth not in ("none", "bearer", "oauth"):
            raise IntegrationError("Choose none, bearer, or oauth authentication.")
        url = await asyncio.to_thread(validate_remote_url, supplied.get("url") or DEFAULT_URLS.get(name, ""))
        await mcp.add_mcp_server(MCPServerCreate(name=name, url=url, auth="header" if auth == "bearer" else auth, bearer_token=supplied.get("token") if auth == "bearer" else None, profile=profile), profile)
        if auth != "oauth":
            return dict(kind="connected", status="approved", message="MCP configuration saved in Hermes. Check verifies live access.")
        identity = "mcp:" + name
        operation = "connect"
    if operation == "connect":
        if identity == "google_workspace":
            return await asyncio.to_thread(begin_google, home, profile, data.get("redirectUri", ""), data.get("fields"))
        if identity.startswith("mcp:"):
            name = identity[4:]
            # Check configured destinations on every probe, including servers
            # created outside this app. This surface grants no generic SSRF route.
            servers = (await mcp.list_mcp_servers(profile))["servers"]
            server = next((s for s in servers if s["name"] == name), None)
            if not server or not server.get("url"):
                raise IntegrationError("This server cannot use browser OAuth.")
            await asyncio.to_thread(validate_remote_url, server["url"])
            if server.get("auth") == "header":
                token = (data.get("fields") or {}).get("token", "")
                if not token or len(token) > 20000:
                    raise IntegrationError("Enter a new bearer token to reconnect this MCP service.")
                if server.get("source") == "plugin":
                    raise IntegrationError("This MCP service is owned by a plugin. Update it through its owner.")
                def rotate():
                    from hermes_cli.mcp_config import _save_bearer_auth_token
                    with config_write_scope(profile):
                        maintenance()
                        from hermes_cli.mcp_config import _get_mcp_servers, _save_mcp_server
                        from hermes_cli.config import read_user_config_raw
                        config = _get_mcp_servers(read_user_config_raw()).get(name)
                        if not config:
                            raise IntegrationError("This MCP connection changed. Refresh before reconnecting.")
                        headers = {key: value for key, value in (config.get("headers") or {}).items() if key.lower() != "authorization"}
                        headers.update(_save_bearer_auth_token(name, token))
                        config["headers"] = headers
                        if not _save_mcp_server(name, config):
                            raise IntegrationError("Hermes could not update this MCP credential reference.")
                await asyncio.to_thread(rotate)
                return dict(kind="connected", status="approved", message="MCP bearer token rotated in the existing Hermes credential store. Check verifies live access.")
            result = await mcp.auth_mcp_server(name, request, profile)
            key = secrets.token_urlsafe(24)
            with FLOW_LOCK:
                FLOWS[key] = dict(kind="mcp", profile=profile, home=home, native_id=result["flow_id"], public_url=clean_url(result.get("authorization_url")), flow_kind="redirect", expires=time.time()+600, status="pending")
            url = clean_url(result.get("authorization_url"))
            if not url:
                raise IntegrationError("Hermes did not return a safe authorization URL. Review the native MCP connection.")
            return dict(kind="redirect", status="pending", flowId=key, url=url, message="Authorize the MCP provider, then return to check its connection.")
        if identity.startswith("provider:"):
            provider = identity[9:]
            result = await oauth.start_oauth_login(provider, request, profile)
            key = secrets.token_urlsafe(24)
            with FLOW_LOCK:
                FLOWS[key] = dict(kind="provider", profile=profile, home=home, provider=provider, native_id=result["session_id"], public_url=clean_url(result.get("verification_url")), flow_kind="device_code", userCode=result.get("user_code"), expires=time.time()+min(result.get("expires_in", 600), 900), status="pending")
            url = clean_url(result.get("verification_url"))
            if not url:
                raise IntegrationError("The provider did not return a safe authorization URL.")
            return dict(kind="device_code", status="pending", flowId=key, url=url, userCode=result.get("user_code"), message="Enter this code at the provider, then return to Hermes.")
        if identity.startswith("key:"):
            key = KEYS.get(identity[4:])
            if not key:
                raise IntegrationError("Unknown provider key.")
            token = (data.get("fields") or {}).get("token", "")
            if not token or len(token) > 20000:
                raise IntegrationError("Enter a provider key.")
            await config_env.set_env_var(EnvVarUpdate(key=key[1], value=token, profile=profile), profile)
            return dict(kind="connected", status="approved", message="Provider key saved by Hermes. Check verifies it where supported.")
        if identity == "selected_files":
            paths = (data.get("fields") or {}).get("paths", "").splitlines()
            bases = [Path(p).resolve() for p in os.environ.get("HERMES_AGENT_INTERFACE_FILE_BASES", "").split(os.pathsep) if p]
            if not bases:
                raise IntegrationError("The installer must configure approved folder bases before selecting server files.")
            if not paths or len(paths) > 10:
                raise IntegrationError("Choose between one and ten server folders.")
            selected = []
            for value in paths:
                path = Path(value)
                if not path.is_absolute() or path.is_symlink() or not path.is_dir():
                    raise IntegrationError("Choose an existing absolute folder with no symlink.")
                resolved = path.resolve()
                if not any(resolved.is_relative_to(base) for base in bases):
                    raise IntegrationError("That folder is outside approved bases.")
                validate_selected_root(resolved, home)
                selected.append(str(resolved))
            def save_roots():
                from hermes_cli.config import load_config, save_config
                with config_write_scope(profile):
                    maintenance()
                    config = load_config()
                    config["agent_interface_file_roots"] = selected
                    save_config(config)
            await asyncio.to_thread(save_roots)
            return dict(kind="connected", status="approved", message="Read-only folders saved. Enable the Selected files toolset on this bot to read selected UTF-8 files.")
        raise IntegrationError("This connection must be configured through its owning interface.")
    if operation == "disconnect":
        if identity == "google_workspace":
            await asyncio.to_thread(disconnect_google, home)
            return dict(kind="instructions", status="approved", message="Removed this profile's local Google grant. Revoke Google account access separately if needed.")
        if identity.startswith("key:") and identity[4:] in KEYS:
            await config_env.remove_env_var(EnvVarDelete(key=KEYS[identity[4:]][1], profile=profile), profile)
        elif identity.startswith("provider:"):
            provider = identity[9:]
            native_profile = oauth._oauth_profile_name(profile)
            # Native workers lock this registry around their final save. Cancel
            # before clearing credentials, and release it before profile locks.
            with oauth._oauth_sessions_lock:
                for session in oauth._oauth_sessions.values():
                    if session.get("provider") == provider and session.get("profile") == native_profile:
                        session["cancelled"] = True
                        if session.get("status") == "pending":
                            session["status"] = "cancelled"
            await oauth.disconnect_oauth_provider(provider, request, profile)
        elif identity in PRESETS or identity.startswith("mcp:"):
            name = identity if identity in PRESETS else identity[4:]
            await asyncio.to_thread(disconnect_mcp, mcp, name, home, profile)
        elif identity == "selected_files":
            def clear_roots():
                from hermes_cli.config import load_config, save_config
                with config_write_scope(profile):
                    config = load_config()
                    config.pop("agent_interface_file_roots", None)
                    save_config(config)
            await asyncio.to_thread(clear_roots)
        else:
            raise IntegrationError("Unknown or externally owned connection.")
        return dict(kind="instructions", status="approved", message="Removed this Hermes profile's connection configuration.")
    if operation == "check":
        if identity == "google_workspace":
            result = await asyncio.to_thread(check_workspace, home, profile)
            await asyncio.to_thread(cache_check, home, result)
            return result
        rows = (await inventory(profile))["connections"]
        result = next((row for row in rows if row["id"] == identity), None)
        if not result:
            raise IntegrationError("Unknown connection.")
        if identity in PRESETS or identity.startswith("mcp:"):
            name = identity if identity in PRESETS else identity[4:]
            servers = (await mcp.list_mcp_servers(profile))["servers"]
            server = next((s for s in servers if s["name"] == name), None)
            if not server or not server.get("url"):
                raise IntegrationError("This app only checks remote MCP servers. Local process servers remain managed in Hermes.")
            await asyncio.to_thread(validate_remote_url, server["url"])
            checked = await mcp.test_mcp_server(name, profile)
            error = str(checked.get("error", "")).lower()
            failure_status = "expired" if any(word in error for word in ("401", "oauth authentication required", "unauthorized", "invalid_token")) else "missing_permission" if any(word in error for word in ("403", "forbidden", "permission")) else "unavailable"
            result.update(status="connected" if checked.get("ok") else failure_status, detail="Hermes connected and discovered the MCP tools." if checked.get("ok") else "MCP discovery failed. Review authentication and service availability in Hermes.", capabilities=[tool["name"] for tool in checked.get("tools", [])][:100])
        elif identity.startswith("key:") and identity[4:] in KEYS:
            env_key = KEYS[identity[4:]][1]
            def read_key():
                from hermes_cli.config import load_env
                return load_env().get(env_key, "")
            value = await config_scoped_to_thread(profile, read_key)
            checked = await config_env.validate_provider_credential(EnvVarUpdate(key=env_key, value=value, profile=profile), request)
            result.update(status="connected" if checked.get("ok") and checked.get("reachable") else "configured" if checked.get("ok") else "expired" if checked.get("reachable") else "unavailable", detail="The provider accepted a live credential check." if checked.get("ok") and checked.get("reachable") else "Hermes has no live probe for this provider. Configuration is saved." if checked.get("ok") else "The provider refused the key. Reconnect with a valid key." if checked.get("reachable") else "The provider could not be reached. Retry later.")
        elif identity == "discord":
            checked = await messaging.test_messaging_platform("discord", profile)
            result.update(status="connected" if checked.get("ok") else "unavailable", detail="Discord accepted the native bot token." if checked.get("ok") else "Discord verification failed. Review the native Channels page.")
        elif identity == "selected_files":
            def check_roots():
                from hermes_cli.config import load_config
                roots = load_config().get("agent_interface_file_roots", [])
                return bool(roots) and all(Path(p).is_dir() and os.access(p, os.R_OK) and not Path(p).is_symlink() for p in roots)
            valid = await config_scoped_to_thread(profile, check_roots)
            result.update(status="connected" if valid else "unavailable", detail="Selected server folders are readable." if valid else "A selected folder is missing or unreadable. Check the mount and permissions.")
        result["checkedAt"] = now()
        await asyncio.to_thread(cache_check, home, result)
        return result
    raise IntegrationError("Unknown integration operation.")


def install(web):
    from fastapi import Request
    from starlette.responses import JSONResponse
    # Native gated sensitive handlers require an interactive dashboard session
    # even for token-authenticated executors. This finite adapter has its own
    # authenticated, loopback-only service bridge; admit that exact invocation
    # without broadening any original dashboard route or trusting request input.
    if not getattr(web._require_token, "_agent_interface_integrations", False):
        original_require_token = web._require_token
        def integration_require_token(request):
            principal = getattr(request.state, "token_principal", None)
            if (request.scope.get("path") == "/api/agent-interface/integrations"
                    and getattr(request.state, "agent_interface_service_authenticated", False) is True
                    and getattr(request.state, "token_authenticated", False) is True
                    and getattr(principal, "provider", None) == "agent-interface-service"
                    and getattr(principal, "principal", None) == "agent-interface"):
                return
            return original_require_token(request)
        integration_require_token._agent_interface_integrations = True
        web._require_token = integration_require_token
    register_file_tool()
    register_google_tasks_tool()
    register_tool_catalog()
    from hermes_cli.backend_retirement import retirement
    # Native OAuth writes happen on background threads after the start request
    # returns. Reserve native admission until the worker settles or is cancelled.
    from hermes_cli.web_routers import mcp, oauth
    if not getattr(mcp, "_agent_interface_reserved", False):
        original_mcp_worker = mcp._run_dashboard_mcp_oauth
        def reserved_mcp_worker(flow, config):
            with retirement.work() as admitted:
                if not admitted:
                    flow.mark_error("Hermes maintenance prevents authorization.")
                    flow.mark_worker_done()
                    return
                # A native start request may have read config before a
                # concurrent disconnect, then register its worker afterwards.
                # Never let that captured configuration recreate a removed server.
                with MCP_LIFECYCLE_LOCK:
                    disconnecting = (flow.hermes_home, flow.server_name) in MCP_DISCONNECTING
                if disconnecting:
                    flow.mark_error("MCP connection is being removed.", cancelled=True)
                    flow.mark_worker_done()
                    return
                from hermes_cli.mcp_config import _get_mcp_servers
                with mcp._profile_secret_scope(flow.profile):
                    if flow.server_name not in _get_mcp_servers():
                        flow.mark_error("MCP connection was removed before authorization started.", cancelled=True)
                        flow.mark_worker_done()
                        return
                original_mcp_worker(flow, config)
        mcp._run_dashboard_mcp_oauth = reserved_mcp_worker
        original_start_poller = oauth._start_poller
        def reserved_poller(worker, session_id, **kwargs):
            def run(key):
                with retirement.work() as admitted:
                    if admitted:
                        worker(key)
            return original_start_poller(run, session_id, **kwargs)
        oauth._start_poller = reserved_poller
        mcp._agent_interface_reserved = True
    async def endpoint(request: Request):
        try:
            data = await request.json()
            if not isinstance(data, dict):
                raise IntegrationError("Expected an integration request.")
            from hermes_cli.backend_retirement import retirement
            # Native acquire uses the same maintenance lock as lease acquisition.
            # Holding a reservation keeps cutover from crossing this operation.
            if data.get("operation") in ("list", "flow", "callback"):
                result = await dispatch(data, request)
            else:
                with retirement.work() as admitted:
                    if not admitted:
                        raise IntegrationError("Hermes is being upgraded. Connection changes are paused.")
                    result = await dispatch(data, request)
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except IntegrationError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400, headers={"Cache-Control": "no-store"})
        except Exception:
            # Native errors can contain credential previews, URLs or HTTP body
            # fragments. Do not relay any unreviewed exception text.
            return JSONResponse({"error": "Hermes could not finish this connection operation. Check native configuration and retry."}, status_code=502, headers={"Cache-Control": "no-store"})
    # FastAPI's annotation resolver needs Request in module globals.
    globals()["Request"] = Request
    web.app.add_api_route("/api/agent-interface/integrations", endpoint, methods=["POST"])
