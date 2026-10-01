"""Real native integration handlers in an isolated marked home, without live accounts."""
import importlib.util
import json
import os
import secrets
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

REPO = Path(__file__).resolve().parents[2]
home = Path(tempfile.mkdtemp(prefix="agent-interface-integrations-probe-")).resolve()
(home / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
(home / "config.yaml").write_text("dashboard:\n  public_url: https://fixture.example.test\n")
(home / ".env").write_text("EXA_API_KEY=synthetic-secret-exa\nDISCORD_BOT_TOKEN=synthetic-secret-discord\n")
(home / ".env").chmod(0o600)
os.environ["HERMES_HOME"] = str(home)
os.environ["HERMES_SKIP_UPDATE_CHECK"] = "1"
os.environ["HERMES_AGENT_INTERFACE_MAINTENANCE_FILE"] = str(home / "maintenance.json")
sys.path.insert(0, str(REPO / "src/hermes"))
from fastapi.testclient import TestClient
from hermes_cli import web_server as web
from hermes_cli.backend_retirement import retirement
from hermes_cli.config import load_config
from integrations import install, selected_file, FLOWS, FLOW_LOCK, workspace
from service_auth import install_service_auth, PREFIX, TICKET_PATH

secret = secrets.token_urlsafe(32)
web.app.state.auth_required = True
web.app.state.bound_host = "127.0.0.1"
install(web)
install_service_auth(web, secret)
client = TestClient(web.app, base_url="http://127.0.0.1", client=("127.0.0.1", 40000))
headers = {"Authorization": "Bearer " + secret}
route = PREFIX + "agent-interface/integrations"
checks = {}


def call(operation, **kwargs):
    return client.post(route, headers=headers, json=dict(operation=operation, profile="default", **kwargs))


def rpc(method, params):
    ticket = client.post(TICKET_PATH, headers=headers).json()["ticket"]
    with client.websocket_connect("ws://127.0.0.1/api/ws?ticket=" + ticket) as connection:
        connection.send_json(dict(jsonrpc="2.0", id=901, method=method, params=params))
        for _ in range(100):
            result = connection.receive_json()
            if result.get("id") == 901:
                assert "error" not in result, result.get("error")
                return result["result"]
        raise AssertionError("Native integration toolset RPC did not return")


assert client.post(route, json=dict(operation="list", profile="default")).status_code == 401
assert client.post(route, headers={**headers, "Origin": "https://fixture.example.test"}, json=dict(operation="list", profile="default")).status_code == 401
listed = call("list")
assert listed.status_code == 200, listed.text
rows = {row["id"]: row for row in listed.json()["connections"]}
assert rows["key:exa"]["status"] == "configured"
assert rows["google_workspace"]["status"] == "not_connected"
assert rows["apple"]["status"] == "unsupported"
assert "synthetic-secret" not in listed.text and "token_preview" not in listed.text and "redacted_value" not in listed.text
checks["native_inventory_and_no_secret_previews"] = True

# Real native env lifecycle, not a stub response.
connected = call("connect", id="key:exa", fields=dict(token="synthetic-secret-rotated"))
assert connected.status_code == 200, connected.text
assert "synthetic-secret-rotated" in (home / ".env").read_text()
assert "synthetic-secret-rotated" not in connected.text
removed = call("disconnect", id="key:exa")
assert removed.status_code == 200, removed.text
assert "EXA_API_KEY" not in (home / ".env").read_text()
checks["native_profile_key_rotation_and_disconnect"] = True

# Real native MCP CRUD delegated with validated fixed inputs. No outbound probe.
os.environ["HERMES_AGENT_INTERFACE_MCP_HOSTS"] = "fixture.example.test"
created = call("add_mcp", mcp=dict(name="fixture", url="https://fixture.example.test/mcp", auth="bearer", token="synthetic-mcp-secret"))
assert created.status_code == 200, created.text
assert "mcp:fixture" in {row["id"] for row in call("list").json()["connections"]}
assert "synthetic-mcp-secret" not in call("list").text
assert call("disconnect", id="mcp:fixture").status_code == 200
assert call("add_mcp", mcp=dict(name="bad", url="http://127.0.0.1/mcp", auth="none")).status_code == 400
assert call("add_mcp", mcp=dict(name="bad", url="https://unknown.example.test/mcp", auth="none")).status_code == 400
checks["native_mcp_crud_credential_owner_and_ssrf_rejection"] = True

# Literal native header credentials must rotate to the same owner-managed
# reference as app-created bearer connections.
from hermes_cli.web_routers import mcp as native_mcp
from hermes_cli.mcp_config import _save_mcp_server, _get_mcp_servers
with native_mcp._profile_secret_scope("default"):
    assert _save_mcp_server("literal", dict(url="https://fixture.example.test/mcp", headers={"Authorization": "Bearer synthetic-old-token", "X-Example": "preserved"}))
rotated = call("connect", id="mcp:literal", fields=dict(token="synthetic-new-token"))
assert rotated.status_code == 200, rotated.text
with native_mcp._profile_secret_scope("default"):
    updated = _get_mcp_servers()["literal"]
assert "synthetic-old-token" not in json.dumps(updated)
assert "MCP_LITERAL_API_KEY" in (home / "config.yaml").read_text()
assert updated["headers"]["Authorization"] == "Bearer synthetic-new-token"
assert updated["headers"]["X-Example"] == "preserved"
assert "synthetic-new-token" in (home / ".env").read_text()
assert call("disconnect", id="mcp:literal").status_code == 200
checks["native_literal_mcp_bearer_rotation_repoints_credential_owner"] = True

# A native OAuth worker may already have received its callback and be saving
# config when Disconnect arrives. Settle even a flow started outside this app,
# then remove so a late native save cannot resurrect the server.
from tools.mcp_dashboard_oauth import DashboardOAuthFlow
assert call("add_mcp", mcp=dict(name="pending", url="https://fixture.example.test/mcp", auth="none")).status_code == 200
external_flow = DashboardOAuthFlow(flow_id="external-flow-fixture", server_name="pending", profile="default", hermes_home=str(home), redirect_uri="https://fixture.example.test/callback")
with native_mcp._mcp_oauth_flows_lock:
    native_mcp._mcp_oauth_flows[external_flow.flow_id] = external_flow
worker_errors = []
def late_native_save():
    try:
        assert external_flow._callback_ready.wait(2)
        with native_mcp._profile_secret_scope("default"):
            assert _save_mcp_server("pending", dict(url="https://fixture.example.test/mcp", auth="oauth"))
    except BaseException as error:
        worker_errors.append(error)
    finally:
        external_flow.mark_worker_done()
worker = threading.Thread(target=late_native_save)
worker.start()
disconnected = call("disconnect", id="mcp:pending")
worker.join(2)
assert disconnected.status_code == 200, disconnected.text
assert not worker.is_alive() and not worker_errors
assert external_flow.cancelled and external_flow.worker_done
assert "mcp:pending" not in {row["id"] for row in call("list").json()["connections"]}
checks["native_external_mcp_worker_settles_before_disconnect_removal"] = True

# Native starts that race removal are refused by a per-server fence. A
# delayed worker with captured pre-removal config is also denied afterwards.
from integrations import MCP_LIFECYCLE_LOCK, MCP_DISCONNECTING
assert call("add_mcp", mcp=dict(name="fenced", url="https://fixture.example.test/mcp", auth="none")).status_code == 200
captured_config = dict(url="https://fixture.example.test/mcp", auth="oauth")
for during_removal in (True, False):
    racing = DashboardOAuthFlow(flow_id="racing-" + str(during_removal), server_name="fenced", profile="default", hermes_home=str(home), redirect_uri="https://fixture.example.test/callback")
    if during_removal:
        with MCP_LIFECYCLE_LOCK:
            MCP_DISCONNECTING.add((str(home), "fenced"))
    else:
        assert call("disconnect", id="mcp:fenced").status_code == 200
    try:
        native_mcp._run_dashboard_mcp_oauth(racing, captured_config)
        assert racing.cancelled and racing.worker_done
    finally:
        with MCP_LIFECYCLE_LOCK:
            MCP_DISCONNECTING.discard((str(home), "fenced"))
assert "mcp:fenced" not in {row["id"] for row in call("list").json()["connections"]}
checks["native_mcp_start_fenced_during_remove_and_after_stale_read"] = True

folder = home.parent / (home.name + "-selected")
folder.mkdir()
(folder / "note.txt").write_text("Synthetic selected note")
(folder / "escape").symlink_to(home)
os.environ["HERMES_AGENT_INTERFACE_FILE_BASES"] = str(folder)
selected = call("connect", id="selected_files", fields=dict(paths=str(folder)))
assert selected.status_code == 200, selected.text
assert selected_file(home, "0/note.txt")["text"] == "Synthetic selected note"
for path in ("0/../google_token.json", "0/escape/config.yaml", "/etc/passwd"):
    try:
        selected_file(home, path)
        raise AssertionError("Escaped selected root")
    except (ValueError, OSError):
        pass
# Broad installer bases cannot authorize caches or vaults anywhere under
# Hermes itself. Revalidate reads of previously configured roots too.
(home / "cache").mkdir(exist_ok=True)
(home / "cache" / "bws_cache.json").write_text('{"secret":"must-stay-private"}')
os.environ["HERMES_AGENT_INTERFACE_FILE_BASES"] = str(home.parent)
assert call("connect", id="selected_files", fields=dict(paths=str(home / "cache"))).status_code == 400
os.mkfifo(folder / "pipe")
try:
    selected_file(home, "0/pipe")
    raise AssertionError("Named pipe was accepted as a selected file")
except ValueError:
    pass
checks["hermes_credential_tree_and_special_file_reads_rejected"] = True

from tools.registry import registry
entry = next(entry for entry in registry._snapshot_entries() if entry.name == "integration_read_file")
assert "Synthetic selected note" in entry.handler(dict(path="0/note.txt"))
assert entry.toolset == "selected_files"
checks["native_tool_registry_selected_roots_no_symlinks_or_traversal"] = True
# The dedicated read adapter can be enabled without the native File toolset,
# which includes write_file and patch. Exercise actual native profile methods.
described = rpc("profiles.describe", dict(name="default"))
original_enabled = [row["name"] for row in described["toolsets"] if row["enabled"]]
assert {"selected_files", "google_tasks"}.issubset({row["name"] for row in described["toolsets"]})
configured = rpc("profiles.configure", dict(name="default", enabled_toolsets=["selected_files"]))
assert configured["ok"], configured
configured_sets = {row["name"]: row for row in rpc("profiles.describe", dict(name="default"))["toolsets"]}
assert configured_sets["selected_files"]["enabled"] is True
assert configured_sets["file"]["enabled"] is False
from toolsets import resolve_toolset
assert resolve_toolset("selected_files") == ["integration_read_file"]
assert resolve_toolset("google_tasks") == ["integration_google_tasks"]
assert rpc("profiles.configure", dict(name="default", enabled_toolsets=original_enabled))["ok"]
checks["native_dedicated_read_toolsets_toggle_without_write_tools"] = True

checked = call("check", id="selected_files")
assert checked.status_code == 200 and checked.json()["status"] == "connected", checked.text
assert {row["id"]: row for row in call("list").json()["connections"]}["selected_files"]["checkedAt"] == checked.json()["checkedAt"]
(home / ".env").write_text((home / ".env").read_text() + "UNRELATED=changed\n")
assert {row["id"]: row for row in call("list").json()["connections"]}["selected_files"]["status"] == "configured"
checks["durable_live_evidence_invalidated_by_configuration_change"] = True

# Fail closed with the persistent lease, and reserve native admission through mutation.
(home / "maintenance.json").write_text('{"operationId":"fixture-update"}')
assert call("connect", id="key:exa", fields=dict(token="must-not-save")).status_code == 400
assert call("list").status_code == 200
assert "must-not-save" not in (home / ".env").read_text()
(home / "maintenance.json").unlink()
assert retirement.active_count() == 0
checks["persistent_maintenance_and_native_reservation_released"] = True

# Real grant metadata recognizes broad Gmail permission and records missing Tasks.
(home / "google_token.json").write_text(json.dumps(dict(scopes=["https://mail.google.com/", "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/contacts.readonly"], account="synthetic@example.test")))
(home / "google_token.json").chmod(0o600)
workspace_row = workspace(home, "default")
assert workspace_row["status"] == "missing_permission"
assert next(p for p in workspace_row["permissions"] if p["id"] == "gmail")["granted"] is True
assert next(p for p in workspace_row["permissions"] if p["id"] == "tasks")["granted"] is False
setup = call("connect", id="google_workspace", redirectUri="https://fixture.example.test/integrations/google/callback")
assert setup.status_code == 200 and setup.json()["kind"] == "instructions", setup.text
assert (home / "google_token.json").exists()
assert call("callback", callbackUrl="https://fixture.example.test/integrations/google/callback?state=invalid&code=invalid").status_code == 400
checks["workspace_scope_truth_and_setup_preserves_existing_grant"] = True

# Construct the actual Google OAuth Flow with synthetic client metadata. No
# authorization/token endpoint is contacted by authorization_url().
client_file = home / "synthetic-google-web-client.json"
client_file.write_text(json.dumps(dict(web=dict(client_id="synthetic-client.apps.googleusercontent.com", client_secret="synthetic-client-secret", auth_uri="https://accounts.google.com/o/oauth2/auth", token_uri="https://oauth2.googleapis.com/token", redirect_uris=["https://fixture.example.test/integrations/google/callback"]))))
client_file.chmod(0o600)
os.environ["HERMES_AGENT_INTERFACE_GOOGLE_CLIENT_FILE"] = str(client_file)
started = call("connect", id="google_workspace", redirectUri="https://fixture.example.test/integrations/google/callback")
google_oauth_available = importlib.util.find_spec("google_auth_oauthlib") is not None
if google_oauth_available:
    assert started.status_code == 200 and started.json()["kind"] == "redirect", started.text
    flow = started.json()
    resumed = call("connect", id="google_workspace", redirectUri="https://fixture.example.test/integrations/google/callback")
    assert resumed.status_code == 200 and resumed.json()["flowId"] == flow["flowId"] and resumed.json()["url"] == flow["url"], resumed.text
    parameters = parse_qs(urlsplit(flow["url"]).query)
    assert parameters["redirect_uri"] == ["https://fixture.example.test/integrations/google/callback"]
    assert parameters.get("state") and parameters.get("code_challenge")
    assert parameters["code_challenge_method"] == ["S256"]
    assert "https://www.googleapis.com/auth/tasks" in parameters["scope"][0].split()
    assert "synthetic-client-secret" not in started.text
    polled = call("flow", flowId=flow["flowId"])
    assert polled.status_code == 200 and polled.json()["url"] == flow["url"], polled.text
    assert call("cancel", flowId=flow["flowId"]).json()["status"] == "cancelled"
    callback_url = "https://fixture.example.test/integrations/google/callback?state=" + parameters["state"][0] + "&code=not-exchanged"
    assert call("callback", flowId=flow["flowId"], callbackUrl=callback_url).status_code == 400
    assert (home / "google_token.json").exists()
    checks["actual_google_oauth_pkce_scopes_poll_and_cancel_without_network"] = True
else:
    assert started.status_code == 200 and started.json()["kind"] == "instructions", started.text
    assert "Google extra" in started.json()["message"]
    checks["missing_optional_google_extra_is_actionable"] = True

lost_flow = call("flow", flowId="lost-flow-after-native-restart")
assert lost_flow.status_code == 200 and lost_flow.json()["status"] == "expired", lost_flow.text
assert call("cancel", flowId="lost-flow-after-native-restart").json()["status"] == "expired"
for kind in ("mcp", "provider"):
    missing_native_id = "adapter-retained-native-gc-" + kind
    FLOWS[missing_native_id] = dict(kind=kind, profile="default", home=str(home), native_id="native-garbage-collected", provider="openai-codex", expires=time.time()+300, status="pending")
    missing_native = call("flow", flowId=missing_native_id)
    assert missing_native.status_code == 200 and missing_native.json()["status"] == "expired", missing_native.text
assert client.post("/api/providers/oauth/openai-codex/start", headers=headers).status_code == 401
assert client.post(PREFIX + "providers/oauth/openai-codex/start", headers=headers).status_code == 404
checks["finite_service_sensitive_native_gate_preserves_original_auth"] = True
checks["lost_native_flow_returns_terminal_expired_state"] = True

output = Path(os.environ.get("HERMES_SPIKE_EVIDENCE_DIR", str(REPO / "docs/evidence")))
output.mkdir(parents=True, exist_ok=True)
(output / "hermes-integrations-probe.json").write_text(json.dumps(dict(revision=os.environ.get("HERMES_SPIKE_REVISION"), checks=checks, googleOAuthLibrariesAvailable=google_oauth_available, note="Actual native handlers, env/MCP lifecycle and registered file tool exercised. No live third-party sign-in, OAuth token exchange or external service probes."), indent=2) + "\n")
print(json.dumps(dict(checks=checks, evidence=str(output / "hermes-integrations-probe.json"))))
