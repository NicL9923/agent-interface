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
    def invoke(self, results, reports=None, interval='120'):
        # A fake clock that only sleeping advances, so waits are exact and instant.
        now = [0.0]
        def sleep(seconds): now[0] += seconds
        with patch.object(sys, 'argv', ['prepare-when-idle.py', 'commit', '--host', 'host', '--app-base', '/app', '--interval', interval]), \
                patch.object(idle.subprocess, 'run', side_effect=results) as run, \
                patch.object(idle, 'gateway_report', side_effect=reports or (lambda *_: None)), \
                patch.object(idle.time, 'monotonic', side_effect=lambda: now[0]), \
                patch.object(idle.time, 'sleep', side_effect=sleep) as slept:
            result = idle.main()
        return result, run, slept

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

    def test_busy_attempts_name_the_gateway_work_and_flag_a_long_unexplained_count_once(self):
        refused = subprocess.CompletedProcess([], 1, '', 'deploy_common.Fence: gateway reports no active agents or work\nDiscard with: release-app.py discard release-test')
        discarded = subprocess.CompletedProcess([], 0, '', '')
        ready = subprocess.CompletedProcess([], 0, 'Prepared release-next\n', '')
        stuck = {'agents': 1, 'work': []}
        # Ten-minute attempts: unexplained at 0, 10 and 20 minutes, then real work appears.
        reports = [stuck, stuck, stuck, {'agents': 1, 'work': [{'profile': 'kimberly'}]}]
        with patch('sys.stdout') as out, patch('sys.stderr') as err:
            result, run, sleep = self.invoke([refused, discarded] * 4 + [ready], reports, interval='600')
        printed = ''.join(call.args[0] for call in out.write.call_args_list)
        warned = ''.join(call.args[0] for call in err.write.call_args_list)
        self.assertEqual(result, 0)
        self.assertIn('gateway: 1 active agent, no listed work', printed)
        self.assertIn('gateway: 1 active agent, kimberly', printed)
        self.assertEqual(warned.count('a turn is likely stuck'), 1)

    def test_integrity_failure_stops_without_discard_or_retry(self):
        failed = subprocess.CompletedProcess([], 1, '', 'Fence: household profile settings unchanged\nDiscard with: release-app.py discard release-test')
        result, run, sleep = self.invoke([failed])
        self.assertEqual(result, 1)
        run.assert_called_once()
        sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
