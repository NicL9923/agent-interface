import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

path = Path(__file__).resolve().parents[1] / '.agents/tools/bind-work-task-captures.py'
spec = importlib.util.spec_from_file_location('work_bind', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.receipt = self.root / 'receipt.json'
        self.summary = self.root / 'summary.txt'
        self.log = self.root / 'run.log'
        self.folder = self.root / 'work-native-canary-captures/after/ios'
        self.folder.mkdir(parents=True)
        for name in ['task-one', 'task-two']:
            png = self.folder / (name + '.png')
            png.write_bytes(b'identical screenshot bytes')
            os.utime(png, (50, 50))
        self.source = 'sha256:tested'
        self.result = {'result': 'Passed', 'passedTests': 1, 'failedTests': 0, 'skippedTests': 0}
        self.log.write_text('DESIGN_WORK_W2A_AFTER_VARIANT canary complete\n')
        self.data = {'cleanup': {'errors': []}, 'ownedXcodebuildProcesses': [],
                     'verifiedReleaseObservedAt': 'verified', 'withinDeadline': True,
                     'verificationWithinDeadline': True, 'lockProbe': 'free', 'childExitCode': 0,
                     'verifiedOwnedDevices': [{'uuid': 'owned', 'state': 'Shutdown'}],
                     'admittedAt': '1970-01-01T00:00:00+00:00',
                     'releasedObservedAt': '1970-01-01T00:01:40+00:00',
                     'source': self.source, 'workFixtureSHA256': 'fixture',
                     'runs': [{'returncode': 0, 'variants': 'canary', 'device': 'iphone',
                               'phase': 'canary', 'log': str(self.log),
                               'validation': {'summary': 'summary.txt', 'screenshots': ['task-one', 'task-two']}}]}

    def bind(self):
        self.receipt.write_text(json.dumps(self.data))
        self.summary.write_text('ios inputs: ' + self.source + '\n' + json.dumps(self.result) + '\n')
        return module.bind(self.receipt, self.root)

    def test_duplicates_remain_honest_and_failed_runs_are_excluded(self):
        self.data['runs'].append({'returncode': 65, 'variants': 'failed', 'validation': None})
        self.data['childExitCode'] = 65
        result = self.bind()
        self.assertEqual((result['freshCount'], result['uniqueImageCount']), (2, 1))
        self.assertEqual(result['excludedRuns'][0]['variant'], 'failed')
        self.assertFalse(result['accepted'])

    def test_skips_source_drift_and_dirty_cleanup_fail(self):
        self.result['skippedTests'] = 1
        with self.assertRaises(ValueError): self.bind()
        self.result['skippedTests'] = 0
        self.source = 'sha256:different'
        with self.assertRaises(ValueError): self.bind()
        self.source = self.data['source']
        self.data['cleanup']['errors'] = ['not restored']
        with self.assertRaises(ValueError): self.bind()

    def test_out_of_window_png_or_missing_completion_marker_fails(self):
        png = self.folder / 'task-one.png'
        os.utime(png, (150, 150))
        with self.assertRaises(ValueError): self.bind()
        os.utime(png, (50, 50))
        self.log.write_text('partial run')
        with self.assertRaises(ValueError): self.bind()

    def test_unverified_resource_state_fails(self):
        for key, value in [('lockProbe', 'held'), ('childExitCode', None),
                           ('verificationWithinDeadline', False),
                           ('verifiedOwnedDevices', [{'uuid': 'owned', 'state': 'Booted'}])]:
            original = self.data[key]
            self.data[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): self.bind()
            self.data[key] = original


if __name__ == '__main__':
    unittest.main()
