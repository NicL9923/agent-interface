#!/usr/bin/env python3
"""Stage exact merged recovery tools in a new private host audit directory."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
FILES = ("recover-app-after-native-update.py", "deploy-app-release.py")
REMOTE = """
import base64, hashlib, json, os, pathlib, stat, sys, uuid
request = json.load(sys.stdin)
os.umask(0o077)
base = pathlib.Path(request['appBase'])
assert base.is_absolute()
operations = base / 'operations'
info = operations.lstat()
assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
destination = operations / ('reviewed-native-recovery-' + request['commit'][:8] + '-' + str(uuid.uuid4()))
destination.mkdir(mode=0o700)
for name, item in request['files'].items():
    assert name in ('recover-app-after-native-update.py', 'deploy-app-release.py')
    data = base64.b64decode(item['data'], validate=True)
    assert hashlib.sha256(data).hexdigest() == item['sha256']
    with (destination / name).open('xb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    assert hashlib.sha256((destination / name).read_bytes()).hexdigest() == item['sha256']
receipt = {'sourceCommit': request['commit'], 'files': {name: item['sha256'] for name, item in request['files'].items()}}
with (destination / 'provenance.json').open('x') as output:
    json.dump(receipt, output, indent=2)
print(json.dumps({'toolsDirectory': str(destination), **receipt}))
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit")
    parser.add_argument("--host", required=True)
    parser.add_argument("--app-base", required=True)
    args = parser.parse_args()
    assert not args.host.startswith("-") and re.fullmatch(r"[A-Za-z0-9_.@-]+", args.host)
    assert Path(args.app_base).is_absolute()
    subprocess.run(["git", "fetch", "--quiet", "origin", "main"], cwd=ROOT, check=True)
    commit = subprocess.check_output(["git", "rev-parse", "--verify", args.commit + "^{commit}"], cwd=ROOT, text=True).strip()
    subprocess.run(["git", "merge-base", "--is-ancestor", commit, "origin/main"], cwd=ROOT, check=True)
    files = {}
    for name in FILES:
        data = subprocess.check_output(["git", "show", commit + ":.agents/tools/" + name], cwd=ROOT)
        files[name] = {"data": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()}
    payload = {"commit": commit, "appBase": args.app_base, "files": files}
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", args.host, "python3 -c " + shlex.quote(REMOTE)],
                            input=json.dumps(payload), text=True, capture_output=True, check=True)
    receipt = json.loads(result.stdout)
    assert receipt["sourceCommit"] == commit and receipt["files"] == {name: item["sha256"] for name, item in files.items()}
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
