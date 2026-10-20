"""Busy preflights retry; unrelated release failures stop without another attempt."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare_when_idle', Path(__file__).resolve().parents[1] / '.agents/tools/prepare-when-idle.py')
idle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(idle)


class IdlePreparationTests(unittest.TestCase):
    def invoke(self, results):
        with patch.object(sys, 'argv', ['prepare-when-idle.py', 'commit', '--host', 'host', '--app-base', '/app']), \
                patch.object(idle.subprocess, 'run', side_effect=results) as run, \
                patch.object(idle.time, 'sleep') as sleep:
            result = idle.main()
        return result, run, sleep

    def test_each_busy_owner_discards_the_refused_stage_before_retrying(self):
        for reason in ['maintenance gate inactive with no busy work', 'gateway reports no active agents or work']:
            with self.subTest(reason=reason):
                refused = subprocess.CompletedProcess([], 1, '', f'deploy_common.Fence: {reason}\nDiscard with: release-app.py discard release-test')
                discarded = subprocess.CompletedProcess([], 0, '', '')
                ready = subprocess.CompletedProcess([], 0, 'Prepared release-next\n', '')
                result, run, sleep = self.invoke([refused, discarded, ready])
                self.assertEqual(result, 0)
                self.assertEqual(run.call_count, 3)
                self.assertEqual(run.call_args_list[1].args[0][2:4], ['discard', 'release-test'])
                sleep.assert_called_once_with(120)

    def test_integrity_failure_stops_without_discard_or_retry(self):
        failed = subprocess.CompletedProcess([], 1, '', 'Fence: household profile settings unchanged\nDiscard with: release-app.py discard release-test')
        result, run, sleep = self.invoke([failed])
        self.assertEqual(result, 1)
        run.assert_called_once()
        sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
