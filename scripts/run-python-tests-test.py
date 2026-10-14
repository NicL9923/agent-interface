"""The Python test runner must not let a test silently not run."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("run_python_tests", ROOT / "scripts/run-python-tests.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Classification(unittest.TestCase):
    def test_passing_run_is_a_pass(self):
        self.assertEqual(runner.classify(0, "Ran 3 tests in 0.1s\n\nOK\n", False), ("PASS", ""))

    def test_partial_skips_still_pass_and_are_reported(self):
        self.assertEqual(runner.classify(0, "Ran 57 tests in 3s\n\nOK (skipped=1)\n", True), ("PASS", "1 skipped"))

    def test_all_skipped_is_a_skip_locally_and_a_failure_in_ci(self):
        summary = "Ran 1 test in 0.000s\n\nOK (skipped=1)\n"
        self.assertEqual(runner.classify(0, summary, False)[0], "SKIP")
        self.assertEqual(runner.classify(0, summary, True)[0], "FAIL")

    def test_exit_zero_without_unittest_summary_fails(self):
        self.assertEqual(runner.classify(0, "", True)[0], "FAIL")
        self.assertEqual(runner.classify(0, "Ran 0 tests in 0.000s\n\nNO TESTS RAN\n", False)[0], "FAIL")

    def test_nonzero_exit_fails_even_with_a_summary(self):
        self.assertEqual(runner.classify(1, "Ran 2 tests in 0.1s\n\nFAILED (failures=1)\n", False)[0], "FAIL")

    def test_nested_summary_text_does_not_hide_the_final_one(self):
        summary = "Ran 5 tests in 1s\nOK\nRan 2 tests in 1s\n\nOK (skipped=2)\n"
        self.assertEqual(runner.classify(0, summary, False)[0], "SKIP")


class Discovery(unittest.TestCase):
    def test_tests_in_any_directory_are_found_unless_ignored_by_git(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / ".gitignore").write_text("dist/\n")
            for name in ("tests/build/test_example.py", "tests/ios/example_test.py", "scripts/known-test.py", "dist/ignored_test.py", "src/plain.py"):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text("")
            found = runner.stray_tests([root / "scripts/known-test.py"], root)
            self.assertEqual(found, [root / "tests/build/test_example.py", root / "tests/ios/example_test.py"])


if __name__ == "__main__":
    unittest.main()
