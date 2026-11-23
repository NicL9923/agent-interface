#!/usr/bin/env python3
"""Key and reuse successful local iOS test evidence. Live/capture runs stay fresh."""

import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def design_fixtures():
    return [
        path
        for path in sorted((ROOT / ".agents/fixtures").glob("*.json"))
        if not path.name.startswith(".") and path.is_file()
    ]


def source_state():
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    ).split(b"\0")
    # The runner exports every default JSON fixture, including locally ignored files.
    paths.extend(os.fsencode(path.relative_to(ROOT)) for path in design_fixtures())
    entries = []
    for name in sorted(set(paths)):
        if not name:
            continue
        relative = os.fsdecode(name)
        if not (
            relative.startswith(("ios/", ".agents/fixtures/"))
            or relative
            in {
                ".agents/tools/validate-ios.sh",
                ".agents/tools/ios-validation-state.py",
                ".agents/tools/source-state.py",
                ".agents/tools/patch-xctestrun.py",
            }
        ):
            continue
        if relative.endswith(".md") or relative.startswith("ios/evidence/"):
            continue
        path = ROOT / relative
        # Missing tracked files and symlink targets are part of the fingerprint.
        if path.is_symlink():
            entries.append(
                [
                    relative,
                    "symlink",
                    os.readlink(path),
                    hashlib.sha256(path.read_bytes()).hexdigest()
                    if path.is_file()
                    else None,
                ]
            )
        elif path.is_file():
            entries.append(
                [
                    relative,
                    "file",
                    path.stat().st_mode & 0o111,
                    hashlib.sha256(path.read_bytes()).hexdigest(),
                ]
            )
        else:
            entries.append([relative, "missing"])
    if not any(row[0].startswith("ios/") for row in entries):
        raise ValueError("No iOS source inputs found")
    return digest(entries)


def cacheable(operation, options):
    if operation != "test":
        return False
    # The runner exports the repository's default design fixtures on every run.
    # Their contents are fingerprinted above. Custom files, capture switches and
    # variant selections must still run fresh and cannot certify the default suite.
    fixtures = {}
    for path in design_fixtures():
        name = path.stem.removesuffix("-design").upper().replace("-", "_")
        fixtures.setdefault(
            "TEST_RUNNER_AGENT_INTERFACE_DESIGN_" + name + "_PATH", path
        )
    for key, value in os.environ.items():
        if key in fixtures:
            try:
                if not Path(value).is_absolute() or Path(value).resolve(
                    strict=True
                ) != fixtures[key].resolve(strict=True):
                    return False
            except OSError:
                return False
        elif value and (
            key.startswith(
                (
                    "AGENT_INTERFACE_",
                    "TEST_RUNNER_",
                    "SIMCTL_CHILD_",
                    "DYLD_",
                    "SWIFT_",
                    "XCODE_",
                )
            )
            or key in {"CFLAGS", "CXXFLAGS", "LDFLAGS"}
        ):
            return False
    scalar_options = {
        "-only-testing",
        "-skip-testing",
        "-parallel-testing-enabled",
        "-parallel-testing-worker-count",
        "-maximum-parallel-testing-workers",
        "-maximum-concurrent-test-simulator-destinations",
        "-maximum-concurrent-test-device-destinations",
        "-test-timeouts-enabled",
        "-default-test-execution-time-allowance",
        "-maximum-test-execution-time-allowance",
        "-collect-test-diagnostics",
    }
    remaining = iter(options)
    for option in remaining:
        if option.startswith(("-only-testing:@", "-skip-testing:@")):
            return False
        if option.startswith(("-only-testing:", "-skip-testing:")):
            continue
        if option not in scalar_options:
            return False
        value = next(remaining, None)
        if value is None or value.startswith("@"):
            return False
    return True


def identity(operation, simulator, options):
    devices = json.loads(
        command("xcrun", "simctl", "list", "devices", "available", "--json")
    )["devices"]
    matches = [
        (runtime, device)
        for runtime, group in devices.items()
        for device in group
        if device["udid"] == simulator
    ]
    if len(matches) != 1:
        raise ValueError("Choose exactly one available simulator UUID")
    runtime_id, device = matches[0]
    runtimes = json.loads(command("xcrun", "simctl", "list", "runtimes", "--json"))[
        "runtimes"
    ]
    runtime = next((r for r in runtimes if r["identifier"] == runtime_id), None)
    if not runtime:
        raise ValueError("Simulator runtime metadata is unavailable")
    environment = {
        k: v
        for k, v in os.environ.items()
        if k
        in {
            "LANG",
            "LC_ALL",
            "TZ",
            "DEVELOPER_DIR",
            "SDKROOT",
            "CFLAGS",
            "CXXFLAGS",
            "LDFLAGS",
        }
        or k.startswith(
            (
                "LC_",
                "SWIFT_",
                "XCODE_",
                "DYLD_",
                "AGENT_INTERFACE_",
                "TEST_RUNNER_",
                "SIMCTL_CHILD_",
            )
        )
    }
    return digest(
        {
            "schema": 1,
            "source": source_state(),
            "operation": operation,
            "options": options,
            "xcode": command("xcodebuild", "-version"),
            "developer": command("xcode-select", "-p"),
            "sdk": command(
                "xcrun", "--sdk", "iphonesimulator", "--show-sdk-build-version"
            ),
            "host": command("sw_vers", "-buildVersion"),
            "architecture": platform.machine(),
            "timezone": time.tzname,
            "simulator": simulator,
            "device_type": device.get("deviceTypeIdentifier"),
            "runtime": {
                k: runtime.get(k) for k in ["identifier", "version", "buildversion"]
            },
            "environment": environment,
        }
    )


def cache_dir():
    common = Path(command("git", "rev-parse", "--git-common-dir"))
    if not common.is_absolute():
        common = ROOT / common
    return common.resolve().parent / ".private" / "ios-validation-cache"


def cache_path(key):
    if len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
        raise ValueError("Invalid validation key")
    return cache_dir() / (key + ".json")


def evidence_counts(result):
    evidence = json.loads(
        command(
            "xcrun",
            "xcresulttool",
            "get",
            "test-results",
            "summary",
            "--path",
            str(result),
            "--compact",
        )
    )
    if (
        not isinstance(evidence, dict)
        or evidence.get("result") != "Passed"
        or evidence.get("failedTests") != 0
        or type(evidence.get("passedTests")) is not int
        or evidence["passedTests"] <= 0
        or evidence.get("testFailures")
    ):
        raise ValueError("Only completed, passing, nonempty test results can be reused")
    fields = {
        "passed": "passedTests",
        "failed": "failedTests",
        "skipped": "skippedTests",
        "expectedFailures": "expectedFailures",
    }
    counts = {name: evidence.get(field) for name, field in fields.items()}
    if any(type(value) is not int or value < 0 for value in counts.values()):
        raise ValueError("Invalid test counts")
    return counts


def valid_receipt(value):
    try:
        args = value["arguments"]
        if not (
            isinstance(value, dict)
            and value.get("schema") == 2
            and value.get("exit") == 0
            and isinstance(value.get("source"), str)
            and isinstance(args, list)
            and all(isinstance(a, str) for a in args)
            and args.count("--test-invocation--") == 1
            and args.count("-scheme") == 1
            and args[args.index("-scheme") + 1] == "AgentInterface"
            and "build-for-testing" in args
            and "test-without-building" in args
            and value.get("full") is (not partial(args))
            and Path(value["result"]).is_dir()
            and Path(value["summary"]).is_file()
        ):
            return False
        return value.get("tests") == evidence_counts(value["result"])
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        IndexError,
        subprocess.CalledProcessError,
    ):
        return False


def lookup(key):
    try:
        record = json.loads(cache_path(key).read_text())
        if valid_receipt(record) and record.get("key") == key:
            print("Reused successful iOS validation:", record["summary"])
            print("Validated inputs:", key)
            print("Result bundle:", record["result"])
            return 0
    except OSError, ValueError, KeyError, TypeError:
        pass
    return 1


def partial(options):
    # A filter runs part of the scheme. The scheme's whole suite is what a release needs.
    return any(
        option.startswith(("-only-testing", "-skip-testing")) for option in options
    )


def record(key, source, result, summary, *arguments):
    result, summary = Path(result).resolve(), Path(summary).resolve()
    counts = evidence_counts(result)
    if source_state() != source:
        raise ValueError("iOS inputs changed while validation ran")
    value = {
        "schema": 2,
        "key": key,
        "exit": 0,
        "result": str(result),
        "summary": str(summary),
        "source": source,
        "full": not partial(arguments),
        "tests": counts,
        "arguments": list(arguments),
    }
    if not valid_receipt(value):
        raise ValueError("Invalid validation receipt")
    if source_state() != source:
        raise ValueError("iOS inputs changed while validation ran")
    path = cache_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, prefix=".receipt-", delete=False
    ) as f:
        json.dump(value, f, sort_keys=True)
        temporary = Path(f.name)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def full_run():
    """Print the newest passing whole-scheme record for the current iOS inputs, or say why there is none."""
    source = source_state()
    matching, partial_runs = [], 0
    for path in cache_dir().glob("*.json"):
        try:
            value = json.loads(path.read_text())
            if not valid_receipt(value) or value.get("source") != source:
                continue
            if value.get("full") is not True:
                partial_runs += 1
            elif (
                isinstance(value.get("tests"), dict)
                and value["tests"].get("failed") == 0
                and value["tests"].get("passed", 0) > 0
            ):
                matching.append((path.stat().st_mtime, value))
        except OSError, ValueError, KeyError, TypeError:
            continue
    if not matching:
        reason = (
            "Only a partial run (-only-testing or -skip-testing) passed"
            if partial_runs
            else "No passing iOS validation exists"
        )
        print(f"{reason} for the current iOS inputs ({source}).", file=sys.stderr)
        return 1
    value = max(matching, key=lambda item: item[0])[1]
    print(
        json.dumps(
            {
                "source": source,
                "key": value["key"],
                "summary": value["summary"],
                "result": value["result"],
                "tests": value["tests"],
            }
        )
    )
    return 0


def main():
    action, *args = sys.argv[1:]
    if action == "key":
        operation, simulator, *options = args
        print(identity(operation, simulator, options))
    elif action == "source":
        print(source_state())
    elif action == "eligible":
        operation, *options = args
        return 0 if cacheable(operation, options) else 1
    elif action == "lookup":
        return lookup(*args)
    elif action == "invalidate":
        cache_path(*args).unlink(missing_ok=True)
    elif action == "record":
        record(*args)
    elif action == "full-run":
        return full_run()
    else:
        raise ValueError("Unknown validation-state action")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print("iOS validation evidence:", error, file=sys.stderr)
        sys.exit(2)
