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
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def source_state():
    paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).split(b'\0')
    entries = []
    for name in sorted(set(paths)):
        if not name:
            continue
        relative = os.fsdecode(name)
        if not (relative.startswith('ios/') or relative in {
            '.agents/tools/validate-ios.sh', '.agents/tools/ios-validation-state.py',
            '.agents/tools/source-state.py', '.agents/tools/patch-xctestrun.py',
        }):
            continue
        path = ROOT / relative
        # Missing tracked files and symlink targets are part of the fingerprint.
        if path.is_symlink():
            entries.append([relative, 'symlink', os.readlink(path), hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None])
        elif path.is_file():
            entries.append([relative, 'file', path.stat().st_mode & 0o111, hashlib.sha256(path.read_bytes()).hexdigest()])
        else:
            entries.append([relative, 'missing'])
    if not any(row[0].startswith('ios/') for row in entries):
        raise ValueError('No iOS source inputs found')
    return digest(entries)


def cacheable(operation, options):
    if operation != 'test':
        return False
    # Capture/design inputs and live children may depend on external files or a
    # server. Their side effects must happen on every explicit invocation.
    if any(value and (key.startswith(('AGENT_INTERFACE_', 'TEST_RUNNER_', 'SIMCTL_CHILD_', 'DYLD_', 'SWIFT_', 'XCODE_')) or key in {'CFLAGS', 'CXXFLAGS', 'LDFLAGS'})
           for key, value in os.environ.items()):
        return False
    scalar_options = {
        '-only-testing', '-skip-testing', '-parallel-testing-enabled',
        '-parallel-testing-worker-count', '-maximum-parallel-testing-workers',
        '-maximum-concurrent-test-simulator-destinations', '-maximum-concurrent-test-device-destinations',
        '-test-timeouts-enabled', '-default-test-execution-time-allowance',
        '-maximum-test-execution-time-allowance', '-collect-test-diagnostics',
    }
    remaining = iter(options)
    for option in remaining:
        if option.startswith(('-only-testing:', '-skip-testing:')):
            continue
        if option not in scalar_options:
            return False
        value = next(remaining, None)
        if value is None or value.startswith('@'):
            return False
    return True


def identity(operation, simulator, options):
    devices = json.loads(command('xcrun', 'simctl', 'list', 'devices', 'available', '--json'))['devices']
    matches = [(runtime, device) for runtime, group in devices.items() for device in group if device['udid'] == simulator]
    if len(matches) != 1:
        raise ValueError('Choose exactly one available simulator UUID')
    runtime_id, device = matches[0]
    runtimes = json.loads(command('xcrun', 'simctl', 'list', 'runtimes', '--json'))['runtimes']
    runtime = next((r for r in runtimes if r['identifier'] == runtime_id), None)
    if not runtime:
        raise ValueError('Simulator runtime metadata is unavailable')
    environment = {k: v for k, v in os.environ.items() if k in {'LANG', 'LC_ALL', 'TZ', 'DEVELOPER_DIR', 'SDKROOT', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS'}
                   or k.startswith(('LC_', 'SWIFT_', 'XCODE_', 'DYLD_', 'AGENT_INTERFACE_', 'TEST_RUNNER_', 'SIMCTL_CHILD_'))}
    return digest({'schema': 1, 'source': source_state(), 'operation': operation, 'options': options,
                   'xcode': command('xcodebuild', '-version'), 'developer': command('xcode-select', '-p'),
                   'sdk': command('xcrun', '--sdk', 'iphonesimulator', '--show-sdk-build-version'),
                   'host': command('sw_vers', '-buildVersion'), 'architecture': platform.machine(), 'timezone': time.tzname,
                   'simulator': simulator, 'device_type': device.get('deviceTypeIdentifier'),
                   'runtime': {k: runtime.get(k) for k in ['identifier', 'version', 'buildversion']},
                   'environment': environment})


def cache_path(key):
    if len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
        raise ValueError('Invalid validation key')
    common = Path(command('git', 'rev-parse', '--git-common-dir'))
    if not common.is_absolute():
        common = ROOT / common
    return common.resolve().parent / '.private' / 'ios-validation-cache' / (key + '.json')


def lookup(key):
    try:
        record = json.loads(cache_path(key).read_text())
        if (isinstance(record, dict) and record.get('key') == key and record.get('schema') == 1 and record.get('exit') == 0
                and Path(record['result']).is_dir() and Path(record['summary']).is_file()):
            print('Reused successful iOS validation:', record['summary'])
            print('Validated inputs:', key)
            print('Result bundle:', record['result'])
            return 0
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return 1


def record(key, result, summary):
    result, summary = Path(result).resolve(), Path(summary).resolve()
    evidence = json.loads(command('xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(result), '--compact'))
    if (not isinstance(evidence, dict) or evidence.get('result') != 'Passed' or evidence.get('failedTests') != 0
            or not isinstance(evidence.get('passedTests'), int) or evidence['passedTests'] <= 0
            or evidence.get('testFailures') or not summary.is_file()):
        raise ValueError('Only completed, passing, nonempty test results can be reused')
    path = cache_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    value = {'schema': 1, 'key': key, 'exit': 0, 'result': str(result), 'summary': str(summary)}
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.receipt-', delete=False) as f:
        json.dump(value, f, sort_keys=True)
        temporary = Path(f.name)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    action, *args = sys.argv[1:]
    if action == 'key':
        operation, simulator, *options = args
        print(identity(operation, simulator, options))
    elif action == 'eligible':
        operation, *options = args
        return 0 if cacheable(operation, options) else 1
    elif action == 'lookup':
        return lookup(*args)
    elif action == 'invalidate':
        cache_path(*args).unlink(missing_ok=True)
    elif action == 'record':
        record(*args)
    else:
        raise ValueError('Unknown validation-state action')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print('iOS validation evidence:', error, file=sys.stderr)
        sys.exit(2)
