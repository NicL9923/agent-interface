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
                patch.object(idle, 'gateway_report', side_effect=self.host(reports, restart)) as report, \
                patch.object(idle.time, 'monotonic', side_effect=lambda: now[0]), \
                patch.object(idle.time, 'sleep', side_effect=sleep) as slept:
            result = idle.main()
        self.restarts = [call for call in report.call_args_list if call.kwargs.get('restart_after')]
        return result, run, slept

    @staticmethod
    def host(reports, restart):
        """Plays the host: one report per attempt, and a restart re-check answered by ``restart``."""
        queue = list(reports or [])
        def report(host, home, restart_after=0):
            if restart_after:
                return {**(restart() if restart else {'agents': 1, 'work': [], 'quiet': 9999.0, 'routines': 0}), 'restarted': restart is None}
            return queue.pop(0) if queue else None
        return report

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

    LEAKED = {'agents': 1, 'work': [], 'quiet': 3600.0, 'routines': 0}

    def test_a_leaked_count_is_reported_once_and_restarted_only_with_household_idle(self):
        with patch('sys.stdout'), patch('sys.stderr') as err:
            result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 5 + [self.READY], [self.LEAKED] * 5)
        self.assertEqual(result, 0)
        self.assertEqual(self.restarts, [])
        self.assertEqual(''.join(call.args[0] for call in err.write.call_args_list).count('looks like a leaked count'), 1)
        with patch('sys.stdout') as out:
            result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 4 + [self.READY], [self.LEAKED] * 4, extra=['--household-idle'])
        printed = ''.join(call.args[0] for call in out.write.call_args_list)
        self.assertEqual(result, 0)
        # Watched at 0, 2 and 4 minutes, then the five-minute window has passed at 6.
        self.assertEqual(len(self.restarts), 1)
        self.assertIn('Attempt 1: messaging gateway busy (gateway: 1 active agent, last assistant message 60 min ago)', printed)
        self.assertIn('Restarted hermes-gateway.service', printed)

    def test_silence_is_not_enough_while_a_routine_runs_or_a_store_is_unreadable(self):
        for report in ({**self.LEAKED, 'routines': 1}, {**self.LEAKED, 'quiet': None}, {**self.LEAKED, 'quiet': 45.0}):
            with self.subTest(report=report), patch('sys.stdout'), patch('sys.stderr'):
                result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 5 + [self.READY], [report] * 5, extra=['--household-idle'])
                self.assertEqual(result, 0)
                self.assertEqual(self.restarts, [])

    def test_new_work_seen_by_the_host_recheck_prevents_the_restart(self):
        with patch('sys.stdout'), patch('sys.stderr') as err:
            result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 4 + [self.READY], [self.LEAKED] * 4,
                                             extra=['--household-idle'], restart=lambda: {**self.LEAKED, 'quiet': 3.0})
        self.assertEqual(result, 0)
        self.assertIn('Did not restart the gateway', ''.join(call.args[0] for call in err.write.call_args_list))

    def test_a_count_that_drops_resets_the_window(self):
        idle_now = {**self.LEAKED, 'agents': 0}
        with patch('sys.stdout'):
            result, run, sleep = self.invoke([self.REFUSED, self.DISCARDED] * 4 + [self.READY],
                                             [self.LEAKED, self.LEAKED, idle_now, self.LEAKED], extra=['--household-idle'])
        self.assertEqual(result, 0)
        self.assertEqual(self.restarts, [])

    def test_integrity_failure_stops_without_discard_or_retry(self):
        failed = subprocess.CompletedProcess([], 1, '', 'Fence: household profile settings unchanged\nDiscard with: release-app.py discard release-test')
        result, run, sleep = self.invoke([failed])
        self.assertEqual(result, 1)
        run.assert_called_once()
        sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
