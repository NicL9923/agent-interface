"""The xctestrun copy that limits XCTest's crash-report wait for UI test targets."""
import plistlib
import tempfile
import unittest
from pathlib import Path

from support import load_source

patch_xctestrun = load_source(".agents/tools/patch-xctestrun.py")


def ui_target(**extra):
    return {"BlueprintName": "AgentInterfaceUITests", "IsUITestBundle": True, **extra}


class PatchXctestrunTests(unittest.TestCase):
    def test_version_one_patches_only_ui_targets_and_keeps_their_settings(self):
        run = {
            "__xctestrun_metadata__": {"FormatVersion": 1},
            "AgentInterfaceTests": {"BlueprintName": "AgentInterfaceTests", "CommandLineArguments": ["-unit"]},
            "AgentInterfaceUITests": ui_target(CommandLineArguments=["-keep"], EnvironmentVariables={"KEEP": "1"}),
        }
        self.assertEqual(patch_xctestrun.patch(run, 15), ["AgentInterfaceUITests"])
        ui = run["AgentInterfaceUITests"]
        self.assertEqual(ui["CommandLineArguments"], ["-keep", "-XCTCrashReportCollectionTimeout", "15"])
        self.assertEqual(ui["EnvironmentVariables"], {"KEEP": "1", "XCTCrashReportCollectionTimeout": "15"})
        self.assertEqual(run["AgentInterfaceTests"], {"BlueprintName": "AgentInterfaceTests", "CommandLineArguments": ["-unit"]})

    def test_version_two_and_a_second_patch_keep_one_setting(self):
        run = {"__xctestrun_metadata__": {"FormatVersion": 2}, "TestConfigurations": [{"TestTargets": [ui_target()]}]}
        patch_xctestrun.patch(run, 30)
        patch_xctestrun.patch(run, 15)
        target = run["TestConfigurations"][0]["TestTargets"][0]
        self.assertEqual(target["CommandLineArguments"], ["-XCTCrashReportCollectionTimeout", "15"])
        self.assertEqual(target["EnvironmentVariables"]["XCTCrashReportCollectionTimeout"], "15")

    def test_refuses_a_plan_without_ui_targets_or_an_unknown_format(self):
        with self.assertRaises(SystemExit):
            patch_xctestrun.patch({"AgentInterfaceTests": {"BlueprintName": "AgentInterfaceTests"}}, 15)
        with self.assertRaises(SystemExit):
            patch_xctestrun.patch({"__xctestrun_metadata__": {"FormatVersion": 3}}, 15)

    def test_writes_the_copy_beside_the_original_only(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "App.xctestrun"
            source.write_bytes(plistlib.dumps({"AgentInterfaceUITests": ui_target()}))
            copy = Path(directory) / "App-crash-wait.xctestrun"
            patch_xctestrun.main(["patch", str(source), str(copy), "15"])
            self.assertEqual(plistlib.loads(copy.read_bytes())["AgentInterfaceUITests"]["EnvironmentVariables"],
                             {"XCTCrashReportCollectionTimeout": "15"})
            self.assertNotIn("EnvironmentVariables", plistlib.loads(source.read_bytes())["AgentInterfaceUITests"])
            (Path(directory) / "elsewhere").mkdir()
            for destination in (Path(directory) / "elsewhere" / "App.xctestrun", source):
                with self.assertRaises(SystemExit):
                    patch_xctestrun.main(["patch", str(source), str(destination), "15"])


if __name__ == "__main__":
    unittest.main()
