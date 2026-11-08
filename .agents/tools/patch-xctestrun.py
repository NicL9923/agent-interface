#!/usr/bin/env python3
"""Copy an .xctestrun so its UI test targets wait only briefly for crash reports.

Usage: patch-xctestrun.py SOURCE.xctestrun DESTINATION.xctestrun SECONDS

XCTest waits for crash reports after every UI test. On the Mac mini that wait reached about
300 seconds per test. The copy sets XCTCrashReportCollectionTimeout for every UI test target,
both as a launch argument and in the environment. The copy must sit beside the original,
because an .xctestrun locates the built products relative to its own directory.
"""
import pathlib
import plistlib
import sys

SETTING = "XCTCrashReportCollectionTimeout"


def test_targets(run):
    version = run.get("__xctestrun_metadata__", {}).get("FormatVersion", 1)
    if version == 1:
        return [value for key, value in run.items() if not key.startswith("__") and isinstance(value, dict)]
    if version == 2:
        return [target for configuration in run.get("TestConfigurations", []) for target in configuration.get("TestTargets", [])]
    raise SystemExit(f"Unsupported xctestrun FormatVersion {version}.")


def patch(run, seconds):
    """Set the crash-report wait on every UI test target and return their names."""
    targets = [target for target in test_targets(run) if target.get("IsUITestBundle")]
    if not targets:
        raise SystemExit("The xctestrun has no UI test target to patch.")
    flag = "-" + SETTING
    for target in targets:
        arguments = target.get("CommandLineArguments", [])
        # Drop an earlier value so repeated patching keeps one setting.
        kept = []
        skip = False
        for argument in arguments:
            if skip:
                skip = False
            elif argument == flag:
                skip = True
            else:
                kept.append(argument)
        target["CommandLineArguments"] = [*kept, flag, str(seconds)]
        target.setdefault("EnvironmentVariables", {})[SETTING] = str(seconds)
    return [target.get("BlueprintName", "?") for target in targets]


def main(argv):
    if len(argv) != 4:
        raise SystemExit(__doc__.split("\n\n")[1])
    source, destination = pathlib.Path(argv[1]), pathlib.Path(argv[2])
    seconds = int(argv[3])
    if seconds <= 0:
        raise SystemExit("SECONDS must be positive.")
    if source.resolve().parent != destination.resolve().parent or source.resolve() == destination.resolve():
        raise SystemExit("Write the copy beside the original, under a different name.")
    with source.open("rb") as handle:
        run = plistlib.load(handle)
    names = patch(run, seconds)
    with destination.open("wb") as handle:
        plistlib.dump(run, handle)
    print(f"{SETTING}={seconds} for {', '.join(names)}")


if __name__ == "__main__":
    main(sys.argv)
