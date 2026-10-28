import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from PIL import Image

path = Path(__file__).resolve().parents[1] / '.agents/tools/bind-work-editor-web.py'
spec = importlib.util.spec_from_file_location('editor_bind', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BindingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.receipt = root / 'release.json'
        self.report = root / 'work-tasks-b-after.json'
        folder = self.report.with_suffix(''); folder.mkdir()
        self.image = folder / 'web-work-task-edit.png'
        Image.new('RGB', (20, 30)).save(self.image)
        os.utime(self.image, (50, 50))
        self.release = {'status': 0, 'withinDeadline': True, 'cleanup': {'exitCode': 0},
                        'previewExitCode': -15, 'previewPort3044Closed': True,
                        'lockProbe': 'free', 'lockInode': 17430620,
                        'verifiedReleaseObservedAt': '1970-01-01T00:01:41+00:00',
                        'cleanupDeadline': 120,
                        'admittedAt': '1970-01-01T00:00:00+00:00',
                        'releasedObservedAt': '1970-01-01T00:01:40+00:00',
                        'source': 'tested-source', 'fixtureSHA256': 'tested-fixture',
                        'runs': [{'name': 'build', 'exitCode': 0}, {'name': 'capture', 'exitCode': 0}]}
        self.data = {'taskGate': 'b', 'workCase': 'tasks', 'browserErrors': [],
                     'paths': [str(self.image)], 'geometry': [{'name': 'task-edit',
                     'width': 20, 'height': 30, 'overflow': False,
                     'editorOverflow': {'document': False, 'section': False, 'scroller': False},
                     'editorLanding': {'focused': True, 'fullyVisible': True}}]}

    def bind(self):
        self.receipt.write_text(json.dumps(self.release))
        self.report.write_text(json.dumps(self.data))
        return module.bind(self.receipt, self.report, 1)

    def test_binds_passed_images_without_accepting_the_design(self):
        result = self.bind()
        self.assertEqual(result['freshCount'], 1)
        self.assertFalse(result['accepted'])
        self.assertIsNone(result['score'])

    def test_refuses_failed_capture_even_after_clean_release(self):
        self.release['runs'][1]['exitCode'] = 1
        with self.assertRaisesRegex(ValueError, 'passing build/capture'):
            self.bind()

    def test_resolves_report_paths_through_a_directory_alias(self):
        alias = self.image.parent.with_name('alias')
        alias.symlink_to(self.image.parent, target_is_directory=True)
        self.data['paths'] = [str(alias / self.image.name)]
        result = self.bind()
        self.assertEqual(result['screenshots'][0]['path'], str(self.image.resolve()))

    def test_refuses_an_image_from_an_earlier_run(self):
        os.utime(self.image, (-10, -10))
        with self.assertRaisesRegex(ValueError, 'outside'):
            self.bind()

    def test_refuses_verification_after_the_original_deadline(self):
        self.release['cleanupDeadline'] = 100
        with self.assertRaisesRegex(ValueError, 'original deadline'):
            self.bind()

    def test_refuses_extra_diagnostic_images(self):
        Image.new('RGB', (20, 30)).save(self.image.with_name('capture-error.png'))
        with self.assertRaisesRegex(ValueError, 'exactly the PNGs'):
            self.bind()

    def test_refuses_a_clipped_result(self):
        self.data['geometry'][0]['editorLanding']['fullyVisible'] = False
        with self.assertRaisesRegex(ValueError, 'visible focus'):
            self.bind()


if __name__ == '__main__':
    unittest.main()
