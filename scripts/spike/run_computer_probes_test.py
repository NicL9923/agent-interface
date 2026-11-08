"""Qualification runs browser policy coverage when possible and records any skip."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))
from support import load_source

sys.path.insert(0, str(Path(__file__).resolve().parent))
runner = load_source("scripts/spike/run.py", "spike_runner")


class ComputerProbeRunnerTests(unittest.TestCase):
    def test_chrome_probe_gets_own_marked_home_and_receipt_is_collected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {"HOME": str(root), "HERMES_HOME": str(root), "HERMES_SPIKE_EVIDENCE_DIR": str(root),
                   "HERMES_COMPUTER_PROBE_BROWSER": sys.executable, "HERMES_SPIKE_REVISION": "a" * 40}
            def run(command, **kwargs):
                if command[-1].endswith("computer_local_network_probe.py"):
                    probe_env = kwargs["env"]
                    home = Path(probe_env["HOME"])
                    self.assertEqual(str(home), probe_env["HERMES_HOME"])
                    self.assertNotEqual(home, root)
                    self.assertEqual((home / ".agent-interface-isolated").read_text(), "agent-interface-disposable-spike")
                    (home / "computer-local-network-probe.json").write_text('{"status":"passed"}')
            with patch.object(runner.subprocess, "run", side_effect=run) as invoked:
                runner.run_computer_probes(Path(sys.executable), env)
            self.assertEqual([Path(call.args[0][-1]).name for call in invoked.call_args_list],
                             ["computer_probe.py", "computer_local_network_probe.py"])
            self.assertTrue(all(call.kwargs["check"] for call in invoked.call_args_list))
            self.assertEqual(json.loads((root / "hermes-computer-local-network-probe.json").read_text())["status"], "passed")
            self.assertEqual(env["HOME"], str(root))

    def test_no_chrome_records_skip_and_still_runs_coordination_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {"HERMES_SPIKE_EVIDENCE_DIR": directory, "HERMES_SPIKE_REVISION": "a" * 40, "PATH": ""}
            with patch.object(runner.subprocess, "run") as invoked, patch.dict(os.environ, {"PATH": ""}):
                runner.run_computer_probes(Path(sys.executable), env)
            self.assertEqual(invoked.call_count, 1)
            receipt = json.loads((Path(directory) / "hermes-computer-local-network-probe.json").read_text())
            self.assertEqual(receipt["status"], "skipped")
            self.assertIn("Chrome", receipt["reason"])

    def test_browser_probe_failure_is_fatal(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {"HERMES_HOME": directory, "HERMES_SPIKE_EVIDENCE_DIR": directory,
                   "HERMES_COMPUTER_PROBE_BROWSER": sys.executable}
            with patch.object(runner.subprocess, "run", side_effect=[None, runner.subprocess.CalledProcessError(1, "probe")]):
                with self.assertRaises(runner.subprocess.CalledProcessError):
                    runner.run_computer_probes(Path(sys.executable), env)


if __name__ == "__main__":
    unittest.main()
