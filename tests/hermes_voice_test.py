"""Live voice add-on and plugin: validation, error mapping and loading through the plugins link."""
import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from support import ROOT, load_source

voice = load_source("src/hermes/voice.py", "voice_addon")
realtime = load_source("src/hermes/wildbots_voice/realtime.py", "voice_realtime")
plugin = load_source("src/hermes/wildbots_voice/__init__.py", "voice_plugin")
REQUEST = {"model": "gpt-realtime-2.1", "voice": "marin", "instructions": "You are the voice of Ranch.",
           "tools": [{"type": "function", "name": "ask_assistant", "description": "Ask Ranch.",
                      "parameters": {"type": "object", "properties": {"request": {"type": "string"}}, "required": ["request"]}}]}


class Response:
    def __init__(self, status, payload=None, raises=False):
        self.status, self.payload, self.raises = status, payload, raises

    def json(self):
        if self.raises:
            raise ValueError("not json")
        return self.payload


class FakeHermes:
    """hermes_cli.plugin_provider_requests, recording which file made each call, as Hermes checks."""

    class ProviderNotSignedIn(Exception):
        pass

    def __init__(self, answer):
        self.answer, self.calls, self.callers = answer, [], []
        self.module = types.ModuleType("hermes_cli.plugin_provider_requests")
        self.module.ProviderNotSignedIn = self.ProviderNotSignedIn
        self.module.credentialed_provider_request = self.request

    def request(self, provider, method, url, **kwargs):
        self.callers.append(sys._getframe(1).f_code.co_filename)
        self.calls.append((provider, method, url, kwargs))
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer

    def modules(self):
        package = types.ModuleType("hermes_cli")
        package.__path__ = []
        return {"hermes_cli": package, "hermes_cli.plugin_provider_requests": self.module}


class SessionValidationTests(unittest.TestCase):
    def test_the_session_fixes_everything_but_voice_persona_and_tools(self):
        session = voice.build_session(REQUEST)
        self.assertEqual(session["model"], "gpt-realtime-2.1")
        self.assertEqual(session["audio"]["output"], {"voice": "marin"})
        self.assertEqual(session["audio"]["input"]["turn_detection"]["type"], "semantic_vad")
        self.assertEqual(session["audio"]["input"]["transcription"], {"model": "gpt-4o-mini-transcribe"})
        self.assertEqual((session["tools"], session["tool_choice"]), (REQUEST["tools"], "auto"))

    def test_requests_outside_the_allowlists_are_refused(self):
        tool = REQUEST["tools"][0]
        for change in ({"model": "gpt-4o-realtime"}, {"voice": "nova"}, {"instructions": ""}, {"instructions": "x" * 6001},
                       {"tools": [tool] * 5}, {"tools": [dict(tool, type="web_search")]}, {"tools": [dict(tool, name="no spaces")]},
                       {"tools": [dict(tool, parameters={"type": "string"})]}, {"tools": [dict(tool, extra=True)]},
                       {"tools": [dict(tool, description="x" * 9000)]}, {"turn_detection": None}):
            with self.subTest(change=change), self.assertRaises(voice.VoiceError) as caught:
                voice.build_session({**REQUEST, **change})
            self.assertEqual(caught.exception.status, 400)

    def test_manifest_declares_the_codex_sign_in_in_either_yaml_style(self):
        shipped = (ROOT / "src/hermes/wildbots_voice/plugin.yaml").read_text()
        self.assertTrue(voice.declares_codex(shipped))
        try:
            import yaml
        except ImportError:
            yaml = None
        if yaml:
            parsed = yaml.safe_load(shipped)
            self.assertEqual((parsed["name"], parsed["requires_auth"], parsed["manifest_version"]), ("wildbots-voice", ["openai-codex"], 1))
        self.assertTrue(voice.declares_codex("name: x\nrequires_auth: [other, 'openai-codex']\n"))
        self.assertFalse(voice.declares_codex("name: x\nrequires_auth:\n  - other\n"))
        self.assertFalse(voice.declares_codex("name: x\ndescription: requires_auth openai-codex\n"))

    def test_voices_plugin_name_and_samples_agree_across_the_app(self):
        # The app offers, saves and previews the same voices the add-on accepts.
        import re
        shared = (ROOT / "src/shared/voice.ts").read_text()
        listed = re.search(r"TALK_VOICES = \[([^\]]*)\]", shared).group(1)
        self.assertEqual(tuple(re.findall(r'"([a-z]+)"', listed)), voice.VOICES)
        self.assertEqual(sorted(path.stem for path in (ROOT / "public/voice-previews").glob("*.m4a")), sorted(voice.VOICES))
        deploy = load_source(".agents/tools/deploy_common.py", "voice_deploy_common")
        self.assertEqual(deploy.VOICE_PLUGIN, voice.PLUGIN)

    def test_the_plugin_registers_nothing(self):
        context = types.SimpleNamespace()
        self.assertIsNone(plugin.register(context))
        self.assertEqual(vars(context), {})


class PluginLinkTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "plugins"
        self.root.mkdir()
        self.link = self.root / "wildbots-voice"

    def state(self):
        with patch.dict(sys.modules, FakeHermes(Response(200, {})).modules()), \
                patch.object(voice.importlib.util, "find_spec", lambda name: object()):
            return voice.plugin_state(self.root)

    def test_status_names_a_missing_broken_or_foreign_link(self):
        available, reason = self.state()
        self.assertFalse(available)
        self.assertIn("not linked", reason)
        self.link.symlink_to(self.root / "gone")
        self.assertIn("broken", self.state()[1])
        self.link.unlink()
        other = self.root.parent / "older-release"
        other.mkdir()
        (other / "plugin.yaml").write_text((voice.PLUGIN_SOURCE / "plugin.yaml").read_text())
        self.link.symlink_to(other)
        self.assertIn("different release", self.state()[1])
        self.link.unlink()
        self.link.symlink_to(voice.PLUGIN_SOURCE)
        self.assertEqual(self.state(), (True, None))

    def test_an_older_hermes_without_shared_sign_in_is_named(self):
        self.link.symlink_to(voice.PLUGIN_SOURCE)
        with patch.object(voice.importlib.util, "find_spec", lambda name: None):
            available, reason = voice.plugin_state(self.root)
        self.assertFalse(available)
        self.assertIn("Update Hermes", reason)

    def test_minting_calls_hermes_from_realtime_py_under_the_plugins_root(self):
        # Hermes checks the calling frame's file against the plugins root, before resolving links.
        self.link.symlink_to(voice.PLUGIN_SOURCE)
        hermes = FakeHermes(Response(200, {"client_secret": {"value": "ek_test_secret", "expires_at": 1790000000}}))
        with patch.dict(sys.modules, hermes.modules()), patch.object(voice.importlib.util, "find_spec", lambda name: object()):
            result = voice.mint(REQUEST, self.root)
        self.assertEqual(result, {"clientSecret": "ek_test_secret", "expiresAt": 1790000000, "model": "gpt-realtime-2.1", "voice": "marin"})
        self.assertEqual(hermes.callers, [str(self.link / "realtime.py")])
        provider, method, url, kwargs = hermes.calls[0]
        self.assertEqual((provider, method, url), ("openai-codex", "POST", "https://api.openai.com/v1/realtime/client_secrets"))
        self.assertEqual(kwargs["json"], {"session": voice.build_session(REQUEST)})

    def test_mint_errors_map_to_plain_statuses_without_upstream_text(self):
        self.link.symlink_to(voice.PLUGIN_SOURCE)
        secret_body = {"error": {"message": "ek_leaked_value in your request"}}
        for answer, status, words in ((FakeHermes.ProviderNotSignedIn("token detail"), 409, "Sign in to ChatGPT"),
                                      (PermissionError("frame detail"), 503, "hermes plugins enable wildbots-voice"),
                                      (Response(401, secret_body), 502, "HTTP 401"),
                                      (Response(200, {"value": "short"}), 502, "did not issue"),
                                      (Response(200, raises=True), 502, "did not issue"),
                                      (RuntimeError("socket detail ek_leaked_value"), 502, "did not issue")):
            with self.subTest(answer=answer), patch.dict(sys.modules, FakeHermes(answer).modules()), \
                    patch.object(voice.importlib.util, "find_spec", lambda name: object()), self.assertRaises(voice.VoiceError) as caught:
                voice.mint(REQUEST, self.root)
            self.assertEqual(caught.exception.status, status)
            self.assertIn(words, str(caught.exception))
            self.assertNotIn("leaked", str(caught.exception))
            self.assertNotIn("detail", str(caught.exception))

    def test_a_missing_link_refuses_before_contacting_hermes(self):
        hermes = FakeHermes(Response(200, {"value": "ek_test_secret", "expires_at": 1}))
        with patch.dict(sys.modules, hermes.modules()), self.assertRaises(voice.VoiceError) as caught:
            voice.mint(REQUEST, self.root)
        self.assertEqual((caught.exception.status, hermes.calls), (503, []))


class SecretParsingTests(unittest.TestCase):
    def test_flat_and_nested_secrets_are_read_and_malformed_ones_refused(self):
        for payload in ({"value": "ek_flat_secret", "expires_at": 5}, {"client_secret": {"value": "ek_flat_secret", "expires_at": 5}}):
            self.assertEqual(realtime._secret(payload), {"value": "ek_flat_secret", "expires_at": 5})
        for payload in ([], {"value": "ek with space", "expires_at": 5}, {"value": "ek_flat_secret", "expires_at": True},
                        {"value": "ek_flat_secret"}, {"client_secret": "ek_flat_secret"}):
            with self.subTest(payload=payload), self.assertRaises(realtime.UpstreamFailure):
                realtime._secret(payload)


class RouteTests(unittest.TestCase):
    """The installed routes, with FastAPI stood in by recording doubles."""

    def setUp(self):
        self.routes = {}
        fastapi = types.ModuleType("fastapi")
        fastapi.Request = object
        responses = types.ModuleType("starlette.responses")
        responses.JSONResponse = lambda value, status_code=200, headers=None: (status_code, value, headers)
        starlette = types.ModuleType("starlette")
        starlette.__path__ = []
        self.modules = {"fastapi": fastapi, "starlette": starlette, "starlette.responses": responses}
        web = types.SimpleNamespace(app=types.SimpleNamespace(add_api_route=lambda path, endpoint, methods: self.routes.update({(methods[0], path): endpoint})))
        with patch.dict(sys.modules, self.modules):
            voice.install(web)

    def call(self, key, body=b"", service=True):
        async def read():
            return body
        request = types.SimpleNamespace(state=types.SimpleNamespace(agent_interface_service_authenticated=service), body=read)
        return asyncio.run(self.routes[key](request))

    def test_routes_need_the_service_credential_and_never_cache(self):
        self.assertEqual(set(self.routes), {("GET", "/api/agent-interface/voice/status"), ("POST", "/api/agent-interface/voice/client-secret")})
        for key in self.routes:
            status, _, headers = self.call(key, service=False)
            self.assertEqual((status, headers), (401, {"Cache-Control": "no-store"}))

    def test_status_and_mint_answers(self):
        with patch.object(voice, "plugin_state", lambda root=None: (False, "The WildBots voice plugin is not linked.")):
            self.assertEqual(self.call(("GET", "/api/agent-interface/voice/status"))[:2], (200, {"available": False, "reason": "The WildBots voice plugin is not linked."}))
        with patch.object(voice, "plugin_state", lambda root=None: (True, None)):
            self.assertEqual(self.call(("GET", "/api/agent-interface/voice/status"))[:2], (200, {"available": True}))
        key = ("POST", "/api/agent-interface/voice/client-secret")
        self.assertEqual(self.call(key, b"not json")[0], 400)
        self.assertEqual(self.call(key, b"x" * 40000)[0], 400)
        minted = {"clientSecret": "ek_test_secret", "expiresAt": 9, "model": "gpt-realtime-2.1", "voice": "marin"}
        with patch.object(voice, "mint", lambda data: minted):
            self.assertEqual(self.call(key, json.dumps(REQUEST).encode())[:2], (200, minted))
        def broken(data):
            raise RuntimeError("upstream said ek_leaked_value")
        with patch.object(voice, "mint", broken):
            status, value, _ = self.call(key, json.dumps(REQUEST).encode())
        self.assertEqual((status, value), (502, {"error": "Hermes could not start a voice session."}))


if __name__ == "__main__":
    unittest.main()
