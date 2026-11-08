"""validate-ios.sh routes xcodebuild options to the right phase and records them in its summary.

Each test copies the script into a throwaway git repository and runs it with fake xcodebuild,
xcrun first on PATH and a fake machine lock. Nothing here touches a simulator, the shared lock or Xcode.
Set VALIDATE_IOS_SCRIPT to run the tests against another copy of the script.
"""
import json
import os
import plistlib
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

from support import ROOT

SCRIPT = Path(os.environ.get("VALIDATE_IOS_SCRIPT", ROOT / ".agents/tools/validate-ios.sh"))
SIMULATOR = "11111111-2222-3333-4444-555555555555"

FAKE_XCODEBUILD = """#!/usr/bin/env python3
import json, os, plistlib, sys
from pathlib import Path

args = sys.argv[1:]
if args == ["-version"]:
    print("Xcode 27.0\\nBuild version FAKE")
    sys.exit(0)
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps({"tool": "xcodebuild", "argv": args}) + "\\n")
if "build-for-testing" in args or args[-1] == "build":
    derived = Path(args[args.index("-derivedDataPath") + 1])
    products = derived / "Build" / "Products"
    products.mkdir(parents=True, exist_ok=True)
    if "build-for-testing" in args:
        run = {"__xctestrun_metadata__": {"FormatVersion": 1}, "UITests": {"IsUITestBundle": True}}
        (products / "Fake.xctestrun").write_bytes(plistlib.dumps(run))
if "test-without-building" in args:
    sys.exit(int(os.environ.get("FAKE_TEST_STATUS", "0")))
"""

FAKE_XCRUN = """#!/usr/bin/env python3
import json, os, sys

args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps({"tool": "xcrun", "argv": args}) + "\\n")
if args[:3] == ["simctl", "list", "devices"]:
    sim = os.environ["FAKE_SIMULATOR"]
    if "booted" in args:
        for index in range(int(os.environ.get("FAKE_OTHER_BOOTED", "0"))):
            print(f"    Other {index} (0000000{index}-0000-0000-0000-000000000000) (Booted)")
        if os.environ.get("FAKE_SIMULATOR_BOOTED"):
            print(f"    iPhone ({sim}) (Booted)")
    else:
        print(f"-- iOS 27.0 --\\n    iPhone ({sim}) (Shutdown)")
elif args[:1] == ["xcresulttool"] or args[:2] == ["xcresulttool", "get"]:
    print("{}")
"""

# Execute the wrapped command without touching the host's lock.
FAKE_HEAVY_LOCK = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps({"tool": "mac-heavy-lock", "argv": sys.argv[1:]}) + "\\n")
os.execvp(sys.argv[1], sys.argv[1:])
"""


def write_executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


class ValidateIosTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.repo = root / "repo"
        tools = self.repo / ".agents" / "tools"
        tools.mkdir(parents=True)
        (tools / "validate-ios.sh").write_bytes(SCRIPT.read_bytes())
        (tools / "patch-xctestrun.py").write_bytes((ROOT / ".agents/tools/patch-xctestrun.py").read_bytes())
        (tools / "native-smoke.mjs").write_text("")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"],
            cwd=self.repo,
            check=True,
        )
        bin_dir = root / "bin"
        bin_dir.mkdir()
        write_executable(bin_dir / "xcodebuild", FAKE_XCODEBUILD)
        write_executable(bin_dir / "xcrun", FAKE_XCRUN)
        home = root / "home"
        lock_tools = home / ".agents" / "tools"
        lock_tools.mkdir(parents=True)
        write_executable(lock_tools / "mac-heavy-lock.sh", FAKE_HEAVY_LOCK)
        self.log = root / "calls.jsonl"
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(home),
            "FAKE_LOG": str(self.log),
            "FAKE_SIMULATOR": SIMULATOR,
        }
        self.env.pop("WILDBOTS_NATIVE_LOCKED", None)
        self.env.pop("IOS_DERIVED_DATA", None)

    def run_script(self, *args, **env):
        return subprocess.run(
            ["bash", str(self.repo / ".agents/tools/validate-ios.sh"), SIMULATOR, *args],
            check=False,
            cwd=self.repo,
            env={**self.env, **env},
            capture_output=True,
            text=True,
            timeout=60,
        )

    def calls(self, tool="xcodebuild", phase=None):
        entries = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return [e["argv"] for e in entries if e["tool"] == tool and (phase is None or phase in e["argv"])]

    def summary(self, result):
        line = next(line for line in result.stdout.splitlines() if line.startswith("Summary: "))
        text = (self.repo / line.removeprefix("Summary: ")).read_text()
        return {key: value for key, _, value in (row.partition(": ") for row in text.splitlines())}

    def test_worker_limits_run_with_the_tests_and_options_keep_their_values(self):
        space_value = "OTHER_SWIFT_FLAGS=-Xfrontend -warn-long-function-bodies=500"
        result = self.run_script(
            "test",
            "-parallel-testing-worker-count", "2",
            "-maximum-parallel-testing-workers", "3",
            "-maximum-concurrent-test-simulator-destinations", "1",
            "-only-testing:AgentInterfaceUITests/Suite/test with space",
            "-configuration", "Release",
            space_value,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        [build] = self.calls(phase="build-for-testing")
        [test] = self.calls(phase="test-without-building")
        for limit in ("-parallel-testing-worker-count", "-maximum-parallel-testing-workers", "-maximum-concurrent-test-simulator-destinations"):
            self.assertNotIn(limit, build)
            self.assertIn(limit, test)
        self.assertEqual(test[test.index("-parallel-testing-worker-count") + 1], "2")
        self.assertEqual(test[test.index("-maximum-parallel-testing-workers") + 1], "3")
        self.assertEqual(test[test.index("-maximum-concurrent-test-simulator-destinations") + 1], "1")
        self.assertEqual(test[test.index("-parallel-testing-enabled") + 1], "NO")
        self.assertIn("-only-testing:AgentInterfaceUITests/Suite/test with space", test)
        self.assertEqual(test[test.index("-collect-test-diagnostics") + 1], "never")
        # The build phase keeps the build options, each value as one argument.
        self.assertEqual(build[build.index("-configuration") + 1], "Release")
        self.assertIn(space_value, build)
        for build_only in ("-configuration", "Release", space_value):
            self.assertNotIn(build_only, test)
        self.assertNotIn("-only-testing:AgentInterfaceUITests/Suite/test with space", build)
        # The tests run from the patched copy with the short crash-report wait.
        patched = self.repo / test[test.index("-xctestrun") + 1]
        self.assertEqual(patched.name, "Fake-crash-wait.xctestrun")
        run = plistlib.loads(patched.read_bytes())
        self.assertEqual(run["UITests"]["EnvironmentVariables"]["XCTCrashReportCollectionTimeout"], "15")

    def test_a_worker_option_without_a_value_is_rejected_before_building(self):
        result = self.run_script("test", "-maximum-parallel-testing-workers")
        self.assertEqual(result.returncode, 2)
        self.assertIn("-maximum-parallel-testing-workers needs a value", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_summary_records_the_effective_build_and_test_options(self):
        default = self.summary(self.run_script("test"))
        flags = "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG CUSTOM"
        release = self.summary(
            self.run_script("test", "-configuration", "Release", flags, "-parallel-testing-worker-count", "2")
        )
        default_build = shlex.split(default["build options"])
        release_build = shlex.split(release["build options"])
        self.assertEqual(default_build, ["CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "DEVELOPMENT_TEAM="])
        self.assertEqual(release_build, [*default_build, "-configuration", "Release", flags])
        self.assertNotEqual(default["build options"], release["build options"])
        self.assertEqual(shlex.split(default["test options"]), ["-parallel-testing-enabled", "NO", "-collect-test-diagnostics", "never"])
        self.assertEqual(
            shlex.split(release["test options"]),
            ["-parallel-testing-enabled", "NO", "-parallel-testing-worker-count", "2", "-collect-test-diagnostics", "never"],
        )
        # The other inputs that decide whether a result applies to a later run.
        self.assertEqual(release["operation"], "test")
        self.assertEqual(release["project"], "ios/AgentInterface.xcodeproj, scheme: AgentInterface")
        self.assertEqual(release["destination"], f"platform=iOS Simulator,id={SIMULATOR}")
        self.assertEqual(release["derived data"], ".private/ios-build")

    def test_summary_records_the_live_compiler_conditions_and_derived_data(self):
        result = self.run_script("live", "-configuration", "Release", IOS_DERIVED_DATA=".private/custom-build")
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = self.summary(result)
        self.assertEqual(
            shlex.split(summary["build options"])[-3:],
            ["SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG LIVE_HERMES_UI_TESTS", "-configuration", "Release"],
        )
        self.assertIn("-only-testing:AgentInterfaceUITests/LiveConnectionTests", shlex.split(summary["test options"]))
        self.assertEqual(summary["operation"], "live")
        self.assertEqual(summary["derived data"], ".private/custom-build")

    def test_a_failing_test_run_keeps_its_exit_status_in_the_summary(self):
        result = self.run_script("test", FAKE_TEST_STATUS="65")
        self.assertEqual(result.returncode, 65)
        self.assertEqual(self.summary(result)["exit status"], "65")

    def test_machine_lock_wraps_the_complete_simulator_lifetime(self):
        result = self.run_script("test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls("mac-heavy-lock")), 1)
        entries = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual(entries[0]["tool"], "mac-heavy-lock")
        self.assertIn(["simctl", "shutdown", "all"], self.calls("xcrun"))
        self.assertIn(["simctl", "boot", SIMULATOR], self.calls("xcrun"))
        self.assertIn(["simctl", "bootstatus", SIMULATOR, "-b"], self.calls("xcrun"))
        self.assertEqual(entries[-1], {"tool": "xcrun", "argv": ["simctl", "shutdown", SIMULATOR]})

    def test_failed_test_stage_still_shuts_down_the_simulator(self):
        # A failing test stage must also leave its simulator stopped.
        result = self.run_script("test", FAKE_TEST_STATUS="65")
        self.assertEqual(result.returncode, 65)
        self.assertEqual(self.calls("xcrun")[-1], ["simctl", "shutdown", SIMULATOR])


if __name__ == "__main__":
    unittest.main()
