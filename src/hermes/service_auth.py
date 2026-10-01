"""Private service credential for a finite set of existing Hermes operations.

Original dashboard URLs and Google cookie/native authentication are untouched.
This middleware admits only a dedicated prefix, never a browser-origin request.
"""
import base64
import hmac
import ipaddress
import re

PREFIX = "/api/agent-interface/service/"
TICKET_PATH = "/api/agent-interface/service-ticket"
OPERATIONS = (
    ("POST", re.compile(r"/api/agent-interface/integrations")),
    ("GET", re.compile(r"/api/profiles")),
    ("DELETE", re.compile(r"/api/profiles/[A-Za-z0-9_-]{1,200}")),
    ("GET", re.compile(r"/api/files/download")),
    ("GET", re.compile(r"/api/cron/jobs")),
    ("POST", re.compile(r"/api/cron/jobs")),
    ("PUT", re.compile(r"/api/cron/jobs/[A-Za-z0-9_-]{1,200}")),
    ("DELETE", re.compile(r"/api/cron/jobs/[A-Za-z0-9_-]{1,200}")),
    ("POST", re.compile(r"/api/cron/jobs/[A-Za-z0-9_-]{1,200}/(?:pause|resume)")),
)


def validate_secret(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", value or ""):
        raise SystemExit("HERMES_AGENT_INTERFACE_TOKEN must be a generated 32-byte base64url service key.")
    decoded = base64.urlsafe_b64decode(value + "=")
    if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode().rstrip("=") != value or len(set(value)) < 16:
        raise SystemExit("HERMES_AGENT_INTERFACE_TOKEN must be a generated 32-byte base64url service key.")
    return value.encode()


class ServiceAuthMiddleware:
    def __init__(self, app, *, secret):
        self.app = app
        self.secret = validate_secret(secret)

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not (path.startswith(PREFIX) or path == TICKET_PATH):
            await self.app(scope, receive, send)
            return
        from starlette.responses import JSONResponse

        async def error(status, message):
            await JSONResponse({"error": message}, status_code=status, headers={"Cache-Control": "no-store"})(scope, receive, send)

        headers = scope.get("headers", [])
        names = [key.lower() for key, _ in headers]
        client = scope.get("client")
        try:
            local = bool(client) and ipaddress.ip_address(client[0]).is_loopback
        except ValueError:
            local = False
        authorizations = [value for key, value in headers if key.lower() == b"authorization"]
        if (not local or b"origin" in names or b"cookie" in names or len(authorizations) != 1
                or not hmac.compare_digest(authorizations[0], b"Bearer " + self.secret)):
            await error(401, "Service authentication required")
            return
        # Do not trust forwarded peer claims. Caddy also blocks this prefix publicly.
        if any(name.startswith(b"x-forwarded-") or name == b"forwarded" for name in names):
            await error(401, "Service access must be direct")
            return
        if path == TICKET_PATH:
            if scope["method"] != "POST" or scope.get("query_string"):
                await error(404, "Service operation not available")
                return
            from hermes_cli.dashboard_auth.ws_tickets import mint_ticket, TTL_SECONDS
            ticket = mint_ticket(user_id="agent-interface", provider="agent-interface-service")
            await JSONResponse({"ticket": ticket, "ttl_seconds": TTL_SECONDS}, headers={"Cache-Control": "no-store"})(scope, receive, send)
            return
        native_path = "/api/" + path[len(PREFIX):]
        raw_path = scope.get("raw_path", path.encode()).lower()
        if any(encoded in raw_path for encoded in (b"%2f", b"%5c", b"%25")) or not any(
                scope["method"] == method and pattern.fullmatch(native_path) for method, pattern in OPERATIONS):
            await error(404, "Service operation not available")
            return
        from hermes_cli.dashboard_auth.base import TokenPrincipal
        trusted = dict(scope)
        trusted["path"] = native_path
        trusted["raw_path"] = native_path.encode()
        trusted["state"] = dict(scope.get("state", {}), token_authenticated=True,
            agent_interface_service_authenticated=True,
            token_principal=TokenPrincipal(principal="agent-interface", provider="agent-interface-service", scopes=("executor",)))
        # Preserve method, body streaming and query bytes. Native dependencies and path policies run unchanged.
        await self.app(trusted, receive, send)


def install_service_auth(web, secret):
    validate_secret(secret)
    web.app.add_middleware(ServiceAuthMiddleware, secret=secret)
