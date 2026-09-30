"""Exercise the private service bridge against real Google-gated native routes.

Uses a verified-session provider double, no Google credentials/network and a fresh marked home.
Run with the constrained Hermes interpreter and PYTHONPATH set to the qualified source checkout.
"""
import json
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
home = Path(tempfile.mkdtemp(prefix="agent-interface-service-probe-"))
(home / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
(home / "config.yaml").write_text("dashboard:\n  public_url: https://fixture.example.test\n")
os.environ["HERMES_HOME"] = str(home)
os.environ["HERMES_SKIP_UPDATE_CHECK"] = "1"
sys.path.insert(0, str(REPO / "src/hermes"))

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from hermes_cli import web_server as web
from hermes_cli.dashboard_auth import DashboardAuthProvider, Session, register_provider
from hermes_cli.dashboard_auth.registry import clear_providers
from hermes_cli.dashboard_auth.ws_tickets import consume_ticket, TicketInvalid
from extension import install, source_state
from service_auth import install_service_auth, validate_secret, PREFIX, TICKET_PATH


class VerifiedGoogleFixture(DashboardAuthProvider):
    name = "google-family-fixture"
    display_name = "Google fixture"
    def start_login(self, *, redirect_uri): raise NotImplementedError
    def complete_login(self, **kwargs): raise NotImplementedError
    def verify_session(self, *, access_token):
        if access_token != "verified-google-fixture": return None
        return Session(user_id="household-person", email="household@example.test", display_name="Household", org_id="",
            provider=self.name, expires_at=int(time.time()) + 300, access_token=access_token, refresh_token="")
    def refresh_session(self, *, refresh_token): raise NotImplementedError
    def revoke_session(self, *, refresh_token): pass


revision, patch = source_state()
clear_providers(); register_provider(VerifiedGoogleFixture())
web.app.state.auth_required = True
web.app.state.bound_host = "127.0.0.1"
web.app.state.trusted_public_hosts = frozenset({"fixture.example.test", "127.0.0.1"})
install()
secret = secrets.token_urlsafe(32)
install_service_auth(web, secret)
client = TestClient(web.app, base_url="http://127.0.0.1", client=("127.0.0.1", 40000))
headers = {"Authorization": "Bearer " + secret}
checks = {}

def rpc(ticket, method, params=None):
    with client.websocket_connect("ws://127.0.0.1/api/ws?ticket=" + ticket) as socket:
        socket.send_json({"jsonrpc": "2.0", "id": 123, "method": method, "params": params or {}})
        for _ in range(100):
            frame = socket.receive_json()
            if frame.get("id") == 123:
                assert "error" not in frame, frame.get("error")
                return frame["result"]
        raise AssertionError("No native RPC response")

assert client.get("/api/profiles").status_code == 401
assert client.get("/api/config", headers={"X-Hermes-Session-Token": secret}).status_code == 401
for auth in [{"Authorization": "Bearer verified-google-fixture"}, {"Cookie": "hermes_session_at=verified-google-fixture; hermes_session_provider=google-family-fixture"}]:
    response = client.get("/api/profiles", headers=auth)
    assert response.status_code == 200, response.text
    ticket = client.post("/api/auth/ws-ticket", headers=auth).json()["ticket"]
    try:
        assert rpc(ticket, "profiles.list")["profiles"]
    except WebSocketDisconnect as exc:
        raise AssertionError("Original fixture WS rejected: " + str(exc.code) + " " + exc.reason + " auth=" + str(list(auth))) from None
checks["original_google_cookie_and_native_http_ws_unchanged"] = True

for extra in [{"Origin": "https://fixture.example.test"}, {"Cookie": "hermes_session_at=verified-google-fixture"}, {"X-Forwarded-For": "127.0.0.1"}]:
    assert client.post(TICKET_PATH, headers={**headers, **extra}).status_code == 401
assert client.post(TICKET_PATH).status_code == 401
assert client.post(TICKET_PATH, headers={"Authorization": "Bearer wrong"}).status_code == 401
remote = TestClient(web.app, base_url="http://127.0.0.1", client=("198.51.100.9", 40000))
assert remote.post(TICKET_PATH, headers=headers).status_code == 401
checks["credential_origin_cookie_and_direct_peer_guards"] = True

response = client.post(TICKET_PATH, headers=headers)
assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
ticket = response.json()["ticket"]
assert rpc(ticket, "agent-interface.capabilities")["revision"] == revision
try:
    consume_ticket(ticket)
    raise AssertionError("Used service ticket was reusable")
except TicketInvalid:
    pass
checks["one_time_native_gateway_ticket_and_actual_revision"] = True

response = client.get(PREFIX + "profiles", headers=headers)
assert response.status_code == 200, response.text
assert Path(next(row for row in response.json()["profiles"] if row["name"] == "default")["path"]).resolve() == home.resolve()
assert client.get(PREFIX + "cron/jobs?profile=default", headers=headers).status_code == 200
for method, path in [("POST", "profiles"), ("DELETE", "cron/jobs"), ("GET", "config"), ("GET", "profiles/default"), ("GET", "profiles/%2fconfig"), ("DELETE", "profiles/%252e%252e"), ("GET", "cron/jobs/abc/resume")]:
    assert client.request(method, PREFIX + path, headers=headers).status_code == 404
checks["finite_native_handler_allowlist_and_encoded_path_guards"] = True

# Test actual native profile removal and files policy rather than proxy-shaped success doubles.
ticket = client.post(TICKET_PATH, headers=headers).json()["ticket"]
rpc(ticket, "profiles.create", {"name": "service-probe", "no_alias": True})
assert client.delete(PREFIX + "profiles/service-probe", headers=headers).status_code == 200
fixture = home / "synthetic-download.txt"
fixture.write_text("Synthetic private file")
original = client.get("/api/files/download", params={"path": str(fixture)}, headers={"Authorization": "Bearer verified-google-fixture"})
service = client.get(PREFIX + "files/download", params={"path": str(fixture)}, headers=headers)
assert service.status_code == original.status_code
assert service.content == original.content
missing = client.get(PREFIX + "files/download", params={"path": str(home / "missing-file.txt")}, headers=headers)
assert missing.status_code in (400, 403, 404)
checks["native_profile_mutation_and_file_policy_preserved"] = True

for weak in ["", "a" * 43, "short", "x" * 44]:
    try:
        validate_secret(weak); raise AssertionError("Weak service key accepted")
    except SystemExit:
        pass
checks["strong_private_key_requirement"] = True

report = {"kind": "Actual native gated HTTP and WS, verified Google-session fixture, fresh isolated home, no production mutation",
    "revision": revision, "tracked_patch_sha256": patch, "checks": checks}
destination = REPO / "docs/evidence" / ("hermes-service-probe-" + revision[:3] + ".json")
destination.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"evidence": str(destination.relative_to(REPO)), "checks": checks}))
client.close(); remote.close()
