"""The suite stops only the exact gateway Hermes recorded for its disposable home."""
import importlib.util
import json
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("spike_run", HERE / "run.py")
run = importlib.util.module_from_spec(spec); spec.loader.exec_module(run)


class StopHomeGatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.signals = []

    def tearDown(self):
        self.temp.cleanup()

    def stop(self, record, live_start):
        (self.home / "gateway.pid").write_text(json.dumps(record))
        starts = iter([live_start, None])
        with patch.object(run, "process_start_time", lambda pid: next(starts, None)), \
             patch.object(run.os, "kill", lambda pid, sig: self.signals.append((pid, sig))):
            return run.stop_home_gateway(self.home)

    def record(self, **changes):
        return {"pid": 4242, "kind": "hermes-gateway", "start_time": 900, "hermes_home": str(self.home), **changes}

    def test_recorded_gateway_of_this_home_is_stopped(self):
        self.assertEqual(self.stop(self.record(), 900), 4242)
        self.assertEqual(self.signals, [(4242, signal.SIGTERM)])

    def test_reused_pid_foreign_home_or_other_kind_is_left_alone(self):
        self.assertIsNone(self.stop(self.record(), 901))
        self.assertIsNone(self.stop(self.record(hermes_home="/home/nicolas/.hermes"), 900))
        self.assertIsNone(self.stop(self.record(kind="hermes-dashboard"), 900))
        self.assertIsNone(self.stop(self.record(start_time=None), 900))
        self.assertEqual(self.signals, [])


if __name__ == "__main__":
    unittest.main()
