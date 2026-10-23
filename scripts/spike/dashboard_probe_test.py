"""The managed dashboard probe ships every add-on module and never waits on an ssh prompt."""
import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))
from support import ROOT, load_source  # noqa: E402

probe = load_source("scripts/spike/dashboard_probe.py", "dashboard_probe_under_test")


class DashboardProbeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.evidence = Path(directory.name) / "evidence.json"

    def probe(self, outcome):
        with patch.object(probe.host_access.subprocess, "run", side_effect=outcome) as run:
            probe.main(["--ssh-host", "home-hermes-vps"], self.evidence)
        return run.call_args

    def test_bundles_every_add_on_module(self):
        self.assertEqual(set(probe.bundle()), {path.name for path in (ROOT / "src/hermes").glob("*.py")})
        self.assertEqual(base64.b64decode(probe.bundle()["private_fs.py"]), (ROOT / "src/hermes/private_fs.py").read_bytes())

    def test_ssh_refuses_prompts_and_bounds_the_run(self):
        call = self.probe(lambda command, **kwargs: subprocess.CompletedProcess(command, 0, '{"checks": {"ready": true}}', ""))
        self.assertEqual(call.args[0][:2], ["ssh", "-o"])
        self.assertIn("BatchMode=yes", call.args[0])
        self.assertEqual(call.args[0][-2], "home-hermes-vps")
        self.assertEqual(call.kwargs["timeout"], probe.TIMEOUT)
        self.assertEqual(set(json.loads(call.kwargs["input"])["files"]), set(probe.bundle()))
        self.assertEqual(json.loads(self.evidence.read_text()), {"checks": {"ready": True}})

    def test_a_stalled_host_ends_with_a_message_and_writes_no_evidence(self):
        def stall(command, **kwargs):
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        with self.assertRaisesRegex(SystemExit, "did not finish within 600 seconds"):
            self.probe(stall)
        self.assertFalse(self.evidence.exists())

if __name__ == "__main__":
    unittest.main()
