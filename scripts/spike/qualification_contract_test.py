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

APP = Path(__file__).resolve().parents[2]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
qualification = module("qualification_contract", APP / "src/hermes/qualification.py")
extension = module("extension_contract", APP / "src/hermes/extension.py")

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
