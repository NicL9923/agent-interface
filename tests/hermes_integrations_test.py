"""Security/ownership checks with no native dependency or live credential requirement."""
import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("integrations", Path(__file__).resolve().parents[1] / "src/hermes/integrations.py")
integrations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrations)


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve() / "hermes"
        self.home.mkdir()
        integrations.FLOWS.clear()

    def tearDown(self):
        self.temp.cleanup()

    def flow(self, *, profile="one", state="safe-state", status="pending", expires=None):
        value = dict(kind="google", profile=profile, home=str(self.home), state=state, status=status, expires=expires or integrations.time.time()+60, flow=types.SimpleNamespace(redirect_uri="https://app.example/integrations/google/callback"))
        integrations.FLOWS["flow"] = value
        return value

    def test_callback_requires_exact_state_profile_redirect_and_single_use(self):
        entry = self.flow()
        for address, profile in [("https://app.example/integrations/google/callback?state=wrong&code=code", "one"), ("https://app.example/integrations/google/callback?state=safe-state&code=code", "two"), ("https://other.example/integrations/google/callback?state=safe-state&code=code", "one"), ("https://app.example/integrations/google/callback?state=safe-state&state=wrong&code=code", "one")]:
            with self.assertRaises(integrations.IntegrationError):
                integrations.google_callback(address, "flow", profile)
        self.assertEqual(entry["status"], "pending")
        result = integrations.google_callback("https://app.example/integrations/google/callback?state=safe-state&error=access_denied", "flow", "one")
        self.assertEqual(result["status"], "error")
        with self.assertRaises(integrations.IntegrationError):
            integrations.google_callback("https://app.example/integrations/google/callback?state=safe-state&code=code", "flow", "one")

    def test_expired_cancelled_flow_cannot_exchange(self):
        for state in ("cancelled", "approved", "exchanging"):
            self.flow(status=state)
            with self.assertRaises(integrations.IntegrationError):
                integrations.google_callback("https://app.example/integrations/google/callback?state=safe-state&code=code", "flow", "one")
        self.flow(expires=integrations.time.time()-1)
        with self.assertRaises(integrations.IntegrationError):
            integrations.google_callback("https://app.example/integrations/google/callback?state=safe-state&code=code", "flow", "one")

    def test_pending_flow_preserves_browser_code_and_manual_callback_on_poll(self):
        entry = self.flow()
        entry.update(public_url="https://accounts.google.com/authorize?state=safe-state", flow_kind="redirect", callbackInput=True)
        result = integrations.flow_summary("flow", entry)
        self.assertEqual(result["url"], entry["public_url"])
        self.assertTrue(result["callbackInput"])
        self.assertEqual(result["kind"], "redirect")
        entry.update(flow_kind="device_code", userCode="ONE-TWO")
        self.assertEqual(integrations.flow_summary("flow", entry)["userCode"], "ONE-TWO")
        entry["status"] = "approved"
        settled = integrations.flow_summary("flow", entry)
        self.assertNotIn("url", settled)
        self.assertNotIn("userCode", settled)
        self.assertNotIn("callbackInput", settled)

    def test_expired_legacy_grant_reconnects_with_explicit_verified_account(self):
        token = self.home / "google_token.json"
        original = json.dumps({"token": "expired", "refresh_token": "revoked", "scopes": []}).encode()
        token.write_bytes(original)
        token.chmod(0o600)
        entry = self.flow()
        credentials = types.SimpleNamespace(token="new", granted_scopes=[integrations.SCOPES["calendar"][1]], to_json=lambda: json.dumps({"token": "new", "refresh_token": "new-offline-grant"}))
        entry.update(original_token=original, expected_account="member@example.test", flow=types.SimpleNamespace(redirect_uri="https://app.example/integrations/google/callback", fetch_token=lambda **kwargs: None, credentials=credentials, oauth2session=types.SimpleNamespace(token={"scope": integrations.SCOPES["calendar"][1]})))
        requests = types.ModuleType("requests")
        requests.get = lambda *args, **kwargs: types.SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"email": "member@example.test"})
        retirement = types.ModuleType("hermes_cli.backend_retirement")
        calls = []
        retirement.retirement = types.SimpleNamespace(prepare=lambda: {"ok": True, "token": "permit"}, cancel=lambda value: calls.append(value))
        with patch.dict(sys.modules, {"requests": requests, "hermes_cli.backend_retirement": retirement}):
            result = integrations.google_callback("https://app.example/integrations/google/callback?state=safe-state&code=new-code", "flow", "one")
        self.assertEqual(result["status"], "approved")
        self.assertEqual(json.loads(token.read_text())["account"], "member@example.test")
        self.assertEqual(calls, ["permit"])

    def test_disconnect_during_first_google_exchange_cannot_create_grant(self):
        entry = self.flow()
        started, resume = threading.Event(), threading.Event()
        def exchange(**kwargs):
            started.set()
            self.assertTrue(resume.wait(2))
        credentials = types.SimpleNamespace(token="new", granted_scopes=[], to_json=lambda: json.dumps({"token": "new", "refresh_token": "new-grant"}))
        entry.update(original_token=None, expected_account="member@example.test", flow=types.SimpleNamespace(redirect_uri="https://app.example/integrations/google/callback", fetch_token=exchange, credentials=credentials, oauth2session=types.SimpleNamespace(token={})))
        requests = types.ModuleType("requests")
        requests.get = lambda *args, **kwargs: types.SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"email": "member@example.test"})
        retirement = types.ModuleType("hermes_cli.backend_retirement")
        retirement.retirement = types.SimpleNamespace(prepare=lambda: {"ok": True, "token": "permit"}, cancel=lambda value: None)
        errors = []
        def callback():
            try:
                integrations.google_callback("https://app.example/integrations/google/callback?state=safe-state&code=new-code", "flow", "one")
            except integrations.IntegrationError as error:
                errors.append(error)
        with patch.dict(sys.modules, {"requests": requests, "hermes_cli.backend_retirement": retirement}):
            worker = threading.Thread(target=callback)
            worker.start()
            self.assertTrue(started.wait(2))
            self.assertEqual(entry["status"], "exchanging")
            integrations.disconnect_google(self.home)
            resume.set()
            worker.join(2)
            self.assertFalse(worker.is_alive())
        self.assertEqual(entry["status"], "cancelled")
        self.assertEqual(len(errors), 1)
        self.assertFalse((self.home / "google_token.json").exists())

    def test_mcp_disconnect_cancels_external_worker_and_waits_or_refuses(self):
        done = threading.Event()
        flow = types.SimpleNamespace(server_name="server", hermes_home=str(self.home), flow_id="external", worker_done=False, _worker_done=done)
        flow.mark_error = lambda message, cancelled: done.set()
        native = types.SimpleNamespace(_mcp_oauth_flows_lock=threading.Lock(), _mcp_oauth_flows={"external": flow})
        # Native worker signals only after its writes finish. A still-active
        # registry entry must refuse removal even if an event was spurious.
        with self.assertRaises(integrations.IntegrationError):
            integrations.cancel_mcp_workers(native, "server", self.home, timeout=0)
        def cancelled(message, cancelled):
            flow.worker_done = True
            done.set()
        flow.mark_error = cancelled
        integrations.cancel_mcp_workers(native, "server", self.home, timeout=0)
        self.assertTrue(done.is_set())

    def test_lost_flow_is_expired_but_known_other_profile_stays_denied(self):
        self.assertIsNone(integrations.lookup_flow("missing", "one"))
        self.flow(profile="two")
        with self.assertRaises(integrations.IntegrationError):
            integrations.lookup_flow("flow", "one")

    def test_private_file_and_durable_check_fingerprint(self):
        token = self.home / "google_token.json"
        token.write_text("original")
        token.chmod(0o600)
        result = dict(id="test", status="connected", detail="Checked", checkedAt="now")
        integrations.cache_check(self.home, result)
        self.assertEqual(integrations.apply_checks(self.home, [dict(id="test", status="configured")])[0]["status"], "connected")
        token.write_text("rotated")
        self.assertEqual(integrations.apply_checks(self.home, [dict(id="test", status="configured")])[0]["status"], "configured")
        token.chmod(0o644)
        with self.assertRaises(integrations.IntegrationError):
            integrations.private_json(token)
        target = self.home / "linked.json"
        target.symlink_to(token)
        with self.assertRaises(integrations.IntegrationError):
            integrations.private_json(target)

    def test_remote_url_fixed_hosts_safe_scope_and_secrets(self):
        with patch.dict(os.environ, {"HERMES_AGENT_INTERFACE_MCP_HOSTS": "local.example"}):
            self.assertEqual(integrations.validate_remote_url("https://local.example/mcp"), "https://local.example/mcp")
            for value in ("http://local.example/mcp", "https://user:secret@local.example/mcp", "https://local.example/mcp?token=secret", "https://untrusted.example/mcp", "https://mcp.supabase.com/mcp?read_only=false", "https://mcp.supabase.com/mcp?api_key=secret"):
                with self.assertRaises(integrations.IntegrationError):
                    integrations.validate_remote_url(value)
        self.assertIsNone(integrations.clean_url("https://idp.example/authorize?client_secret=secret"))
        self.assertIsNone(integrations.clean_url("https://user:secret@idp.example/authorize"))
        self.assertEqual(integrations.clean_url("https://idp.example/authorize?state=state&code_challenge=challenge"), "https://idp.example/authorize?state=state&code_challenge=challenge")

    def test_selected_read_refuses_parent_symlink_and_sensitive_file(self):
        folder = self.home.parent / "folder"
        folder.mkdir()
        (folder / "note.txt").write_text("safe text")
        (folder / ".env").write_text("secret")
        (folder / "escape").symlink_to(self.home)
        config = types.ModuleType("hermes_cli.config")
        config.load_config = lambda: {"agent_interface_file_roots": [str(folder)]}
        constants = types.ModuleType("hermes_constants")
        constants.get_default_hermes_root = lambda **kwargs: self.home
        safety = types.ModuleType("agent.file_safety")
        safety.get_read_block_error = lambda path: None
        with patch.dict(sys.modules, {"hermes_cli.config": config, "hermes_constants": constants, "agent.file_safety": safety}):
            self.assertEqual(integrations.selected_file(self.home, "0/note.txt"), {"text": "safe text"})
            for value in ("0/../folder/note.txt", "0/escape/folder/note.txt", "0/.env", "/etc/passwd"):
                with self.assertRaises((ValueError, OSError)):
                    integrations.selected_file(self.home, value)
            moved = self.home.parent / "moved"
            folder.rename(moved)
            folder.symlink_to(moved)
            with self.assertRaises(OSError):
                integrations.selected_file(self.home, "0/note.txt")


if __name__ == "__main__":
    unittest.main()
