"""WildBots for Mac tools: identity from the session, refusals before the network, and the app's answers."""
import base64
import http.server
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from support import load_source

mac = load_source("src/hermes/mac.py", "mac_tools")
KEY = "k" * 21 + "K" * 22
PNG = b"\x89PNG\r\n\x1a\n" + b"fixture-image"


class App:
    """The WildBots app server's link route, played over real HTTP on loopback."""

    def __init__(self, status=200, reply=None):
        self.requests, self.status, self.reply = [], status, reply or {"ok": True, "value": {}}
        app = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                app.requests.append(dict(path=self.path, headers=dict(self.headers), body=body))
                payload = json.dumps(app.reply).encode()
                self.send_response(app.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.environ = {mac.KEY_ENV: KEY, mac.URL_ENV: f"http://127.0.0.1:{self.server.server_port}"}

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class MacToolTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.context = dict(assistant="patch", home=self.home, scheduled=False)

    def app(self, **options):
        app = App(**options)
        self.addCleanup(app.close)
        return app

    def call(self, app, tool, args, context=None):
        return json.loads(mac.handle(tool, args, environ=app.environ, context=context or self.context))

    def test_configuration_requires_a_key_and_a_loopback_app_address(self):
        good = {mac.KEY_ENV: KEY, mac.URL_ENV: "http://127.0.0.1:3000"}
        self.assertEqual(mac.configured(good), ("http://127.0.0.1:3000", KEY))
        self.assertEqual(mac.configured({**good, mac.URL_ENV: "http://[::1]:3000/"}), ("http://[::1]:3000", KEY))
        for change in [{mac.KEY_ENV: ""}, {mac.KEY_ENV: KEY[:-1]}, {mac.KEY_ENV: KEY[:-1] + "!"}, {mac.URL_ENV: ""},
                       {mac.URL_ENV: "https://127.0.0.1:3000"}, {mac.URL_ENV: "http://agentui.example:3000"},
                       {mac.URL_ENV: "http://10.0.0.5:3000"}, {mac.URL_ENV: "http://127.0.0.1"},
                       {mac.URL_ENV: "http://127.0.0.1:3000/api"}, {mac.URL_ENV: "http://user@127.0.0.1:3000"},
                       {mac.URL_ENV: "http://127.0.0.1:3000?x=1"}, {mac.URL_ENV: "http://127.0.0.1:99999"}]:
            with self.subTest(change=change):
                self.assertIsNone(mac.configured({**good, **change}))
        self.assertEqual(json.loads(mac.handle("mac_list", {}, environ={}, context=self.context))["error"]["code"], "link_unavailable")

    def test_sends_the_sessions_assistant_with_the_link_key_and_only_the_actions_arguments(self):
        app = self.app(reply={"ok": True, "value": {"exitCode": 0}})
        result = self.call(app, "mac_run", {"command": "make test", "timeoutSeconds": 30, "device": "Studio"},
                           context=dict(self.context, scheduled=True))
        self.assertEqual(result, {"ok": True, "value": {"exitCode": 0}})
        [request] = app.requests
        self.assertEqual(request["path"], "/api/agent-link/mac")
        self.assertEqual(request["headers"]["Authorization"], "Bearer " + KEY)
        self.assertNotIn("Cookie", request["headers"])
        body = request["body"]
        self.assertRegex(body.pop("invocationId"), r"^inv-[0-9a-f]{32}$")
        self.assertEqual(body, {"assistantId": "patch", "scheduled": True, "action": "run", "device": "Studio",
                                "args": {"command": "make test", "timeoutSeconds": 30}})

    def test_refuses_before_the_network_what_the_tool_does_not_take(self):
        app = self.app()
        cases = [("mac_run", {"command": "ls", "assistantId": "someone-else"}, "invalid_arguments", "Pass only"),
                 ("mac_list", {"path": "/"}, "invalid_arguments", "Pass only"),
                 ("mac_run", {"command": "ls", "timeoutSeconds": 0}, "invalid_arguments", "timeoutSeconds"),
                 ("mac_run", {"command": "ls", "timeoutSeconds": 601}, "invalid_arguments", "timeoutSeconds"),
                 ("mac_run", {"command": "ls", "timeoutSeconds": True}, "invalid_arguments", "timeoutSeconds"),
                 ("mac_read_file", {"path": "a", "device": ""}, "invalid_arguments", "device"),
                 ("mac_read_file", ["path"], "invalid_arguments", "Pass only")]
        for tool, args, code, reason in cases:
            with self.subTest(tool=tool, args=args):
                error = self.call(app, tool, args)["error"]
                self.assertEqual(error["code"], code)
                self.assertIn(reason, error["message"])
        self.assertEqual(app.requests, [])

    def test_explains_a_refused_key_a_malformed_request_and_a_silent_app(self):
        refused = self.app(status=401, reply={"error": "Mac link authentication required"})
        self.assertEqual(self.call(refused, "mac_list", {})["error"]["code"], "link_misconfigured")
        malformed = self.app(status=400, reply={"error": "Invalid Mac link request", "issues": ["args.path"]})
        error = self.call(malformed, "mac_read_file", {"path": "a"})["error"]
        self.assertEqual(error["code"], "invalid_arguments")
        self.assertIn("args.path", error["message"])
        gone = App()
        gone.close()
        error = self.call(gone, "mac_list", {})["error"]
        self.assertEqual(error["code"], "link_unreachable")
        self.assertIn("unknown", error["message"])

    def test_passes_the_macs_refusals_through_unchanged(self):
        reply = {"ok": False, "error": {"code": "unattended_not_allowed", "message": "Not while unattended"}}
        self.assertEqual(self.call(self.app(reply=reply), "mac_list_dir", {"path": "~/dev"}), reply)

    def test_saves_a_screenshot_privately_and_returns_its_path_not_its_bytes(self):
        folder = self.home / "cache" / "mac-screenshots"
        folder.mkdir(parents=True)
        stale, fresh = folder / "old.png", folder / "recent.png"
        for path in (stale, fresh):
            path.write_bytes(PNG)
        os.utime(stale, (time.time() - mac.SCREENSHOT_TTL_SECONDS - 5,) * 2)
        app = self.app(reply={"ok": True, "value": {"pngBase64": base64.b64encode(PNG).decode(), "width": 1920, "height": 1200}})
        raw = mac.handle("mac_screenshot", {}, environ=app.environ, context=self.context)
        self.assertNotIn(base64.b64encode(PNG).decode(), raw)
        value = json.loads(raw)["value"]
        saved = Path(value["path"])
        self.assertEqual((saved.parent, saved.read_bytes(), value["width"], value["height"]), (folder, PNG, 1920, 1200))
        self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        self.assertIn("vision_analyze", value["next"])
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_refuses_an_image_that_is_not_a_png(self):
        app = self.app(reply={"ok": True, "value": {"pngBase64": base64.b64encode(b"GIF89a").decode()}})
        self.assertEqual(self.call(app, "mac_screenshot", {})["error"]["code"], "failed")
        self.assertEqual(list((self.home / "cache" / "mac-screenshots").glob("*.png")), [])


class SessionContextTest(unittest.TestCase):
    """The assistant and attendance come from Hermes's session context, played by stand-in modules."""

    def context(self, env, home="/hermes/profiles/patch"):
        modules = {
            "gateway": types.ModuleType("gateway"),
            "gateway.session_context": types.SimpleNamespace(get_session_env=lambda name, default="": env.get(name, default)),
            "hermes_constants": types.SimpleNamespace(get_hermes_home=lambda: home,
                                                      profile_name_for_home=lambda path: Path(path).name if "profiles" in str(path) else None),
        }
        with patch.dict(sys.modules, modules):
            return mac.session_context()

    def test_only_an_unscheduled_wildbots_chat_counts_as_attended(self):
        self.assertEqual(self.context({"HERMES_UI_SESSION_ID": "sid-1"}), dict(assistant="patch", home=Path("/hermes/profiles/patch"), scheduled=False))
        for env in [{}, {"HERMES_UI_SESSION_ID": "sid-1", "HERMES_CRON_SESSION": "1"}, {"HERMES_CRON_SESSION": "1"}]:
            with self.subTest(env=env):
                self.assertTrue(self.context(env)["scheduled"])
        self.assertEqual(self.context({}, home="/hermes")["assistant"], "default")


class RegistrationTest(unittest.TestCase):
    def test_registers_every_tool_in_its_own_toolset_with_closed_arguments(self):
        registered, catalog = [], []
        modules = {
            "tools": types.ModuleType("tools"),
            "tools.registry": types.SimpleNamespace(registry=types.SimpleNamespace(register=lambda **entry: registered.append(entry))),
            "hermes_cli": types.ModuleType("hermes_cli"),
            "hermes_cli.tools_config": types.SimpleNamespace(CONFIGURABLE_TOOLSETS=catalog),
        }
        with patch.dict(sys.modules, modules):
            mac.register()
            mac.register()
        self.assertEqual(catalog[0][0], "wildbots_mac")
        self.assertEqual(len(catalog), 1)
        names = sorted({entry["name"] for entry in registered})
        self.assertEqual(names, sorted(mac.ARGUMENTS))
        for entry in registered:
            parameters = entry["schema"]["parameters"]
            self.assertEqual((entry["toolset"], parameters["additionalProperties"]), ("wildbots_mac", False))
            self.assertNotIn("assistantId", parameters["properties"])
            self.assertEqual(set(parameters["properties"]) - {"device"}, mac.ARGUMENTS[entry["name"]][1])
        with patch.dict(os.environ, {mac.KEY_ENV: "", mac.URL_ENV: ""}):
            self.assertFalse(registered[0]["check_fn"]())
        with patch.dict(os.environ, {mac.KEY_ENV: KEY, mac.URL_ENV: "http://127.0.0.1:3000"}):
            self.assertTrue(registered[0]["check_fn"]())


if __name__ == "__main__":
    unittest.main()
