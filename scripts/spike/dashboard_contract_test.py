"""Startup safety checks independent of the Hermes dependency environment."""
import hashlib
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2] / "src/hermes"

def load(name, path=None):
    spec = importlib.util.spec_from_file_location("contract_" + name, path or ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class DashboardContract(unittest.TestCase):
    def exercise(self, failure=None):
        events = []
        def step(name):
            events.append(name)
            if name == failure:
                if name in ("extension", "integrations"): raise RuntimeError("Hook installation failed")
                raise SystemExit("Integration unavailable")
        extension = types.SimpleNamespace(source_state=lambda: step("qualify"), install=lambda: step("extension"))
        def validate(secret):
            events.append(("secret", secret))
            if failure == "secret": raise SystemExit("Invalid service key")
        service = types.SimpleNamespace(validate_secret=validate, install_service_auth=lambda web, secret: events.append(("service", web, secret)))
        integrations = types.SimpleNamespace(install=lambda web: step("integrations"))
        cli = types.ModuleType("hermes_cli.main")
        cli.main = lambda: events.append(("cli", list(sys.argv)))
        web = types.ModuleType("hermes_cli.web_server")
        package = types.ModuleType("hermes_cli"); package.__path__ = []; package.main = cli
        argv = ["wrapper", "dashboard", "--host", "127.0.0.1", "--port", "9119", "--no-open"]
        with tempfile.TemporaryDirectory() as directory:
            link = Path(directory) / "agent_interface_dashboard.py"; link.symlink_to(ROOT / "dashboard.py")
            dashboard = load("dashboard", link)
            def sibling_spec(name, path):
                self.assertEqual(Path(path).parent, ROOT)
                module = extension if name.endswith("extension") else integrations if name.endswith("integrations") else service
                return importlib.util.spec_from_loader(name, types.SimpleNamespace(create_module=lambda spec: types.ModuleType(name), exec_module=lambda target: target.__dict__.update(vars(module))))
            with patch.object(sys, "argv", argv), patch.dict(os.environ, {"HERMES_AGENT_INTERFACE_TOKEN": "private", "HERMES_SERVE_HEADLESS": ""}), patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.main": cli, "hermes_cli.web_server": web}), patch.object(dashboard.importlib.util, "spec_from_file_location", sibling_spec):
                if failure in ("extension", "integrations"):
                    with self.assertRaises(RuntimeError): dashboard.main()
                else: dashboard.main()
        return events, argv, web

    def test_original_cli_receives_unchanged_dashboard_arguments_after_install(self):
        events, argv, web = self.exercise()
        self.assertEqual(events, [("secret", "private"), "qualify", "extension", "integrations", ("service", web, "private"), ("cli", argv)])

    def test_source_or_key_failure_preserves_native_dashboard_without_installing_hooks(self):
        for failure in ["qualify", "secret"]:
            with self.subTest(failure=failure):
                events, argv, _ = self.exercise(failure)
                self.assertEqual(events[-1], ("cli", argv))
                self.assertNotIn("extension", events)
                self.assertFalse(any(isinstance(event, tuple) and event[0] == "service" for event in events))

    def test_partial_install_failure_never_continues_native_cli(self):
        for failure in ("extension", "integrations"):
            events, _, _ = self.exercise(failure)
            self.assertEqual(events[-1], failure)
            self.assertFalse(any(isinstance(event, tuple) and event[0] == "cli" for event in events))

    def test_headless_isolated_and_wrong_command_fail_before_install(self):
        dashboard = load("dashboard")
        for argv, headless in [(["wrapper", "serve"], ""), (["wrapper", "dashboard", "--isolated"], ""), (["wrapper", "dashboard"], "1")]:
            with self.subTest(argv=argv, headless=headless), patch.object(sys, "argv", argv), patch.dict(os.environ, {"HERMES_SERVE_HEADLESS": headless}):
                with self.assertRaises(SystemExit): dashboard.main()

    def test_source_gate_accepts_only_qualified_revision_and_exact_repair(self):
        extension = load("extension")
        package = types.ModuleType("hermes_cli"); package.__file__ = "/private/checkout/hermes_cli/__init__.py"
        known_repair = b"private repair fixture"
        with patch.dict(sys.modules, {"hermes_cli": package}), patch.object(extension, "QUALIFIED_OAUTH_PATCH", hashlib.sha256(known_repair).hexdigest()):
            for revision in extension.QUALIFIED_REVISIONS:
                for repair in [b"", known_repair]:
                    with patch.object(extension.subprocess, "check_output", side_effect=[revision, repair]):
                        self.assertEqual(extension.source_state(), (revision, hashlib.sha256(repair).hexdigest() if repair else None))
            for revision, repair in [("unknown", b""), (extension.REVISION, b"unqualified tracked edit")]:
                with patch.object(extension.subprocess, "check_output", side_effect=[revision, repair]):
                    with self.assertRaises(SystemExit): extension.source_state()

if __name__ == "__main__": unittest.main()
