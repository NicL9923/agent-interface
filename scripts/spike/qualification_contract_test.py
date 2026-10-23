"""Dependency-free checks of the private production and disposable probe gates."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))
from support import load_source

APP = Path(__file__).resolve().parents[2]
def module(name, path):
    return load_source(path, name)
qualification = module("qualification_contract", APP / "src/hermes/qualification.py")
extension = module("extension_contract", APP / "src/hermes/extension.py")

class BrowserSelectionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.browser = self.root / "chrome"
        self.browser.write_bytes(b"\x7fELFfixture"); self.browser.chmod(0o700)

    def test_selection_preserves_pm_browser_and_legacy_default(self):
        environment = {"AGENT_BROWSER_EXECUTABLE_PATH": "/pm/chromium"}
        self.assertIsNone(qualification.computer_probe_browser(None))
        self.assertIsNone(qualification.receipt_computer_probe_browser({}, rebind=True))
        self.assertEqual(qualification.computer_probe_environment(environment, None), environment)
        descriptor = qualification.computer_probe_browser(str(self.browser))
        self.assertEqual(descriptor, dict(requested=str(self.browser), executable=str(self.browser),
                                          sha256=hashlib.sha256(self.browser.read_bytes()).hexdigest()))
        self.assertEqual(qualification.computer_probe_environment(environment, descriptor),
                         {**environment, "HERMES_COMPUTER_PROBE_BROWSER": str(self.browser)})

    def test_invalid_explicit_browser_fails_with_specific_error(self):
        wrapper = self.root / "launcher"; wrapper.write_text("#!/bin/sh\n"); wrapper.chmod(0o700)
        disabled = self.root / "disabled"; disabled.write_bytes(b"\x7fELFfixture"); disabled.chmod(0o600)
        for requested, message in (("chrome", "absolute host path"),
                                   (str(self.root / "missing"), "path is unavailable"),
                                   (str(self.root), "executable regular file"),
                                   (str(disabled), "executable regular file"),
                                   (str(wrapper), "direct ELF executable, not a launcher script")):
            with self.subTest(requested=requested), self.assertRaisesRegex(ValueError, message):
                qualification.computer_probe_browser(requested)

    def test_malformed_selection_is_never_treated_as_legacy(self):
        descriptor = qualification.computer_probe_browser(str(self.browser))
        for value in (None, {}, "chrome", {**descriptor, "requested": "chrome"},
                      {**descriptor, "executable": 7}, {**descriptor, "sha256": "invalid"}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "malformed computer probe browser"):
                qualification.receipt_computer_probe_browser({"computerProbeBrowser": value}, rebind=True)

    def test_rebind_allows_content_update_but_refuses_missing_or_retargeted_selection(self):
        link = self.root / "selected"; link.symlink_to(self.browser)
        descriptor = qualification.computer_probe_browser(str(link))
        receipt = {"computerProbeBrowser": descriptor}
        self.browser.write_bytes(b"\x7fELFupdated")
        rebound = qualification.receipt_computer_probe_browser(receipt, rebind=True)
        self.assertEqual(rebound["executable"], descriptor["executable"])
        self.assertNotEqual(rebound["sha256"], descriptor["sha256"])
        # Reading historical metadata must not demand today's binary hash.
        self.assertEqual(qualification.receipt_computer_probe_browser(receipt), descriptor)
        other = self.root / "other"; other.write_bytes(self.browser.read_bytes()); other.chmod(0o700)
        link.unlink(); link.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "resolved path changed since selection"):
            qualification.receipt_computer_probe_browser(receipt, rebind=True)
        other.unlink()
        with self.assertRaisesRegex(ValueError, "path is unavailable"):
            qualification.receipt_computer_probe_browser(receipt, rebind=True)


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agent-interface-qualification-")
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        (self.source / "hermes_cli").mkdir(parents=True)
        (self.source / "hermes_cli/__init__.py").write_text("")
        def git(*args):
            return subprocess.check_output(["git", "-C", str(self.source), *args], stderr=subprocess.DEVNULL).decode().strip()
        git("init", "-q"); git("-c", "user.name=Qualification", "-c", "user.email=qualification@example.invalid", "add", ".")
        git("-c", "user.name=Qualification", "-c", "user.email=qualification@example.invalid", "commit", "-qm", "Disposable source")
        self.revision = git("rev-parse", "HEAD")
        self.fake = types.ModuleType("hermes_cli")
        self.fake.__file__ = str(self.source / "hermes_cli/__init__.py")
        self.env = patch.dict(os.environ, {}, clear=True); self.env.start()
        self.modules = patch.dict(sys.modules, {"hermes_cli": self.fake}); self.modules.start()
    def tearDown(self):
        self.modules.stop(); self.env.stop(); self.temporary.cleanup()
    def test_unknown_source_requires_a_complete_private_receipt(self):
        with self.assertRaises(SystemExit): extension.source_state()
        receipt = self.root / "qualification.json"
        row = {"schemaVersion":1,"revision":self.revision,"trackedPatchSha256":None,
               "integrationDigest":qualification.integration_digest(APP),"qualifiedAt":"2026-09-30T00:00:00Z",
               "checks":{"realIntegration":True,"hostRegressions":True}}
        receipt.write_text(json.dumps(row)); receipt.chmod(0o600)
        os.environ["HERMES_AGENT_INTERFACE_QUALIFICATION_FILE"] = str(receipt)
        self.assertEqual(extension.source_state(), (self.revision, None))
        (self.source / "hermes_cli/__init__.py").write_text("# unqualified repair\n")
        with self.assertRaises(SystemExit): extension.source_state()
    def test_shared_receipt_or_wrong_integration_cannot_admit_source(self):
        receipt = self.root / "qualification.json"
        row = {"schemaVersion":1,"revision":self.revision,"trackedPatchSha256":None,
               "integrationDigest":qualification.integration_digest(APP),"qualifiedAt":"2026-09-30T00:00:00Z",
               "checks":{"realIntegration":True,"hostRegressions":True}}
        receipt.write_text(json.dumps(row)); receipt.chmod(0o644)
        os.environ["HERMES_AGENT_INTERFACE_QUALIFICATION_FILE"] = str(receipt)
        with self.assertRaises(SystemExit): extension.source_state()
        receipt.chmod(0o600); row["integrationDigest"] = "0"*64; receipt.write_text(json.dumps(row))
        with self.assertRaises(SystemExit): extension.source_state()
        row["integrationDigest"] = qualification.integration_digest(APP)
        row["checks"] = {"realIntegration": 1, "hostRegressions": 1}
        receipt.write_text(json.dumps(row))
        with self.assertRaises(SystemExit): extension.source_state()
    def test_provisional_revision_never_admits_a_supervised_home(self):
        home = self.root / "home"; home.mkdir()
        (home / ".agent-interface-isolated").write_text("agent-interface-disposable-spike")
        os.environ.update(HERMES_HOME=str(home), HERMES_AGENT_INTERFACE_QUALIFICATION_REVISION=self.revision)
        with self.assertRaises(SystemExit): extension.source_state()
        os.environ["HERMES_SERVE_HEADLESS"] = "1"
        self.assertEqual(extension.source_state(), (self.revision, None))
        (home / ".agent-interface-isolated").write_text("not a disposable home")
        with self.assertRaises(SystemExit): extension.source_state()

if __name__ == "__main__": unittest.main()
