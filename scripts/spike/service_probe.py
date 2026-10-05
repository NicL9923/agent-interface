"""Exercise the private service bridge against real Google-gated native routes.

Uses a verified-session provider double, no Google credentials/network and a fresh marked home.
Run with the constrained Hermes interpreter and PYTHONPATH set to the qualified source checkout.
"""
import json
import importlib.util
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import threading
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
home = Path(tempfile.mkdtemp(prefix="agent-interface-service-probe-"))
(home / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
(home / "config.yaml").write_text("dashboard:\n  public_url: https://fixture.example.test\n")
os.environ["HERMES_HOME"] = str(home)
os.environ["HERMES_SKIP_UPDATE_CHECK"] = "1"
# Set the complete process identity before any native web/gateway imports.
# A PM bootstrap may already have pinned its launch identity; explicitly use
# the native embedding seam for this entirely disposable fixture process.
from hermes_constants import pin_process_hermes_home, set_hermes_home_override
pin_process_hermes_home(home)
set_hermes_home_override(str(home))
sys.path.insert(0, str(REPO / "src/hermes"))

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from hermes_cli import web_server as web
from hermes_cli.dashboard_auth import DashboardAuthProvider, Session, register_provider
from hermes_cli.dashboard_auth.registry import clear_providers
from hermes_cli.dashboard_auth.ws_tickets import consume_ticket, TicketInvalid
from extension import install, source_state
from service_auth import install_service_auth, validate_secret, PREFIX, TICKET_PATH

secret = secrets.token_urlsafe(32)
os.environ["HERMES_AGENT_INTERFACE_TOKEN"] = secret
os.environ["HERMES_AGENT_INTERFACE_MAINTENANCE_FILE"] = str(home / "maintenance.json")


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


from hermes_constants import get_hermes_home, get_default_hermes_root, get_process_hermes_home
assert get_hermes_home().resolve() == home.resolve(), "Native fixture home escaped its marker"
assert get_process_hermes_home().resolve() == home.resolve(), "Native fixture process home escaped its marker"
assert get_default_hermes_root().resolve() == home.resolve(), "Native fixture profile root escaped its marker"
revision, patch = source_state()
clear_providers(); register_provider(VerifiedGoogleFixture())
web.app.state.auth_required = True
web.app.state.bound_host = "127.0.0.1"
web.app.state.trusted_public_hosts = frozenset({"fixture.example.test", "127.0.0.1"})
journal = install()
from vault import install as install_vault
install_vault(web, journal)
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

from dashboard import hand_updates_to_app, UPDATE_HANDOFF_MESSAGE
google = {"Authorization": "Bearer verified-google-fixture"}
assert client.get("/api/status", headers=google).json()["can_update_hermes"] is True
assert hand_updates_to_app(), "This Hermes revision has no switch for its native updater"
assert client.get("/api/status", headers=google).json()["can_update_hermes"] is False
assert client.get("/api/hermes/update/check", headers=google).json()["message"] == UPDATE_HANDOFF_MESSAGE
refused = client.post("/api/hermes/update", headers=google).json()
assert (refused["ok"], refused["pid"], refused["error"]) == (False, None, "dashboard_update_managed_externally"), refused
checks["native_dashboard_updater_handed_to_app"] = True

for extra in [{"Origin": "https://fixture.example.test"}, {"Cookie": "hermes_session_at=verified-google-fixture"}, {"X-Forwarded-For": "127.0.0.1"}]:
    assert client.post(TICKET_PATH, headers={**headers, **extra}).status_code == 401
assert client.post(TICKET_PATH).status_code == 401
assert client.post(TICKET_PATH, headers={"Authorization": "Bearer wrong"}).status_code == 401
remote = TestClient(web.app, base_url="http://127.0.0.1", client=("198.51.100.9", 40000))
assert remote.post(TICKET_PATH, headers=headers).status_code == 401
checks["credential_origin_cookie_and_direct_peer_guards"] = True

# Reach the real native handlers using only early input validation. This proves
# the finite voice bridge without invoking a speech provider or installing an
# optional SDK. Client-direct voice config returns provider keys and must stay
# outside the service capability.
for path, payload in [("audio/transcribe", {"data_url": "", "mime_type": "audio/webm"}), ("audio/speak", {"text": ""})]:
    response = client.post(PREFIX + path, headers=headers, json=payload)
    assert response.status_code == 400, response.text
assert client.get(PREFIX + "audio/voice-config", headers=headers).status_code == 404
assert client.post(PREFIX + "audio/voice-config", headers=headers, json={}).status_code == 404
assert client.post(PREFIX + "audio/transcribe/extra", headers=headers, json={}).status_code == 404
checks["finite_native_voice_bridge_without_secret_configuration"] = True

from vault_probe import exercise
checks.update(exercise(client, headers, journal))

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

# Run the exact installer transport against real native HTTP/WS listeners. The
# TestClient checks above do not exercise the subprocess helper's upgrade URL.
import hermes_cli
import uvicorn
spec = importlib.util.spec_from_file_location("qualified_linux_hooks", REPO / "scripts/hermes-upgrade-linux.py")
linux = importlib.util.module_from_spec(spec); spec.loader.exec_module(linux)
listener = socket.socket(); listener.bind(("127.0.0.1", 0))
origin = "http://127.0.0.1:" + str(listener.getsockname()[1])
server = uvicorn.Server(uvicorn.Config(web.app, log_level="error", lifespan="off"))
thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
thread.start()
try:
    deadline = time.monotonic() + 10
    while not server.started:
        assert thread.is_alive() and time.monotonic() < deadline, "Native HTTP/WS listener did not start"
        time.sleep(.02)
    operation = "qualification-service-lease"
    source = str(Path(hermes_cli.__file__).resolve().parents[1])
    def installer_rpc(action, *, key=secret, owner=operation, code=linux.NATIVE, success=True):
        payload = {"action": "rpc", "source": source, "home": str(home), "origin": origin,
                   "key": key, "method": action, "operation": owner}
        result = subprocess.run([sys.executable, "-I", "-c", code], input=json.dumps(payload),
            text=True, capture_output=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=30)
        if not success:
            assert result.returncode != 0, "An unauthorized installer maintenance request succeeded"
            return
        assert result.returncode == 0, "Installer maintenance transport failed; inspect the private disposable probe"
        return json.loads(result.stdout)
    assert installer_rpc("status")["active"] is False
    installer_rpc("acquire", key="wrong-service-key", success=False)
    assert not (home / "maintenance.json").exists()
    acquired = installer_rpc("acquire")
    assert acquired == {"active": True, "operationId": operation, "busy": []}
    assert installer_rpc("status")["active"] is True
    installer_rpc("release", owner="qualification-other-owner", success=False)
    assert json.loads((home / "maintenance.json").read_text())["operationId"] == operation
    installer_rpc("release", code=linux.NATIVE.replace("/api/ws?ticket=", "/ws?ticket="), success=False)
    assert (home / "maintenance.json").exists(), "The wrong native URL released admission"
    for path in ("/api/profiles", "/api/config"):
        assert client.get(path, headers={"Authorization": "Bearer verified-google-fixture"}).status_code == 200
    assert installer_rpc("release")["active"] is False
    assert not (home / "maintenance.json").exists()
    checks["installer_service_ticket_native_maintenance_status_acquire_release"] = True
    checks["installer_wrong_route_key_and_owner_cannot_release_lease"] = True
    checks["original_google_http_reads_preserved_under_maintenance"] = True
finally:
    server.should_exit = True
    thread.join(timeout=10)
    assert not thread.is_alive(), "Disposable native HTTP/WS listener did not stop"
    listener.close()

report = {"kind": "Actual native gated HTTP and WS, verified Google-session fixture, fresh isolated home, no production mutation",
    "revision": revision, "tracked_patch_sha256": patch, "checks": checks}
destination = Path(os.environ.get("HERMES_SPIKE_EVIDENCE_DIR", str(REPO / "docs/evidence"))) / ("hermes-service-probe-upgrade-route-" + revision[:3] + ".json")
destination.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"evidence": str(destination), "checks": checks}))
client.close(); remote.close()
