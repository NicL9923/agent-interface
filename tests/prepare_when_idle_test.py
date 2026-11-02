"""Busy preflights retry; unrelated release failures stop without another attempt."""
import subprocess
import sys
import unittest
from unittest.mock import patch

from support import ROOT, load_source

sys.path.insert(0, str(ROOT / ".agents/tools"))

idle = load_source('.agents/tools/prepare-when-idle.py', 'prepare_when_idle')


class IdlePreparationTests(unittest.TestCase):
    def invoke(self, results, reports=None, interval='120', extra=(), restart=None):
        # A fake clock that only sleeping advances, so waits are exact and instant.
        now = [0.0]
        def sleep(seconds): now[0] += seconds
        argv = ['prepare-when-idle.py', 'commit', '--host', 'host', '--app-base', '/app', '--interval', interval, *extra]
        with patch.object(sys, 'argv', argv), \
                patch.object(idle.subprocess, 'run', side_effect=results) as run, \
                patch.object(idle, 'gateway_report', side_effect=reports or (lambda *_: None)), \
                patch.object(idle, 'restart_gateway', side_effect=restart or (lambda host: True)) as restarted, \
                patch.object(idle.time, 'monotonic', side_effect=lambda: now[0]), \
                patch.object(idle.time, 'sleep', side_effect=sleep) as slept:
            result = idle.main()
        self.restarted = restarted
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

    REFUSED = subprocess.CompletedProcess([], 1, '', 'deploy_common.Fence: gateway reports no active agents or work\nDiscard with: release-app.py discard release-test')
    DISCARDED = subprocess.CompletedProcess([], 0, '', '')
    READY = subprocess.CompletedProcess([], 0, 'Prepared release-next\n', '')

    def test_a_leaked_count_restarts_the_gateway_once_after_a_quiet_window(self):
        # Ten-minute attempts: counted at 0, 10 and 20 minutes with no message written for longer.
        leaked = {'agents': 1, 'work': [], 'quiet': 3600.0}
        with patch('sys.stdout') as out:
            result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 3 + [self.READY], [leaked] * 3, interval='600')
        printed = ''.join(call.args[0] for call in out.write.call_args_list)
        self.assertEqual(result, 0)
        self.restarted.assert_called_once_with('host')
        self.assertIn('Attempt 1: messaging gateway busy (gateway: 1 active agent, last assistant message 60 min ago)', printed)
        self.assertIn('Restarted hermes-gateway.service', printed)

    def test_a_working_turn_that_keeps_writing_is_never_restarted(self):
        working = {'agents': 1, 'work': [], 'quiet': 45.0}
        with patch('sys.stdout'):
            result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 4 + [self.READY], [working] * 4, interval='600')
        self.assertEqual(result, 0)
        self.restarted.assert_not_called()

    def test_household_idle_shortens_the_window_and_no_restart_only_reports(self):
        leaked = {'agents': 1, 'work': [], 'quiet': 400.0}
        with patch('sys.stdout'):
            result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 4 + [self.READY], [leaked] * 4, extra=['--household-idle'])
        self.assertEqual(result, 0)
        self.restarted.assert_called_once()
        with patch('sys.stdout'), patch('sys.stderr') as err:
            result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 4 + [self.READY], [leaked] * 4,
                                             extra=['--household-idle', '--no-restart'])
        self.restarted.assert_not_called()
        self.assertEqual(''.join(call.args[0] for call in err.write.call_args_list).count('a leaked count'), 1)

    def test_a_count_that_drops_resets_the_window(self):
        leaked, idle_now = {'agents': 1, 'work': [], 'quiet': 3600.0}, {'agents': 0, 'work': [], 'quiet': 3600.0}
        with patch('sys.stdout'):
            result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 4 + [self.READY],
                                             [leaked, leaked, idle_now, leaked], interval='600')
        self.assertEqual(result, 0)
        self.restarted.assert_not_called()

    def test_integrity_failure_stops_without_discard_or_retry(self):
        failed = subprocess.CompletedProcess([], 1, '', 'Fence: household profile settings unchanged\nDiscard with: release-app.py discard release-test')
        result, run, sleep = self.invoke([failed])
        self.assertEqual(result, 1)
        run.assert_called_once()
        sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
