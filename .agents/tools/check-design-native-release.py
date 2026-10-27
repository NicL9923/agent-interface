#!/usr/bin/env python3
"""Verify scoped native cleanup and the existing shared lock before a design handback."""
import argparse
import datetime
import fcntl
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('reservation', type=Path)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--lock', type=Path, required=True)
parser.add_argument('--derived-data', required=True)
parser.add_argument('--owned-device', action='append', required=True)
args = parser.parse_args()
receipt = json.loads(args.reservation.read_text())
if receipt.get('cleanup', {}).get('errors') != []:
    parser.error('The worker did not report successful cleanup')
requested = set(args.owned_device)
run_devices = {run['uuid'] for run in receipt['runs']}
if not run_devices or not run_devices.issubset(requested):
    parser.error('Every runtime device must be explicitly owned by this task')
inventory = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j'], timeout=20))
devices = [row for group in inventory['devices'].values() for row in group if row['udid'] in requested]
if len(devices) != len(requested) or any(row['state'] != 'Shutdown' for row in devices):
    parser.error('An owned device is missing or is not Shutdown')
processes = []
for line in subprocess.check_output(['ps', '-axo', 'pid=,comm=,args='], text=True, timeout=10).splitlines():
    fields = line.strip().split(None, 2)
    if len(fields) == 3 and Path(fields[1]).name == 'xcodebuild' and (
        args.derived_data in fields[2] or any(uuid in fields[2] for uuid in requested)
    ):
        processes.append(line)
if processes:
    parser.error(f'Task-matching xcodebuild processes remain: {processes}')
before = args.lock.stat().st_ino
with args.lock.open('r+') as lease:
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    fcntl.flock(lease, fcntl.LOCK_UN)
if args.lock.stat().st_ino != before:
    parser.error('The coordinated lock was replaced')
now = datetime.datetime.now(datetime.timezone.utc)
receipt.update(verifiedReleaseObservedAt=now.isoformat(), lockProbe='free', lockInode=before,
               ownedXcodebuildProcesses=processes,
               verifiedOwnedDevices=[{'uuid': row['udid'], 'state': row['state']} for row in devices],
               verificationWithinDeadline=now.timestamp() <= receipt['cleanupDeadline'])
# This is a scoped check of the declared devices and matching xcodebuild commands, not an OS census.
temporary = args.output.with_name(args.output.name + '.partial')
temporary.write_text(json.dumps(receipt, indent=2) + '\n')
temporary.replace(args.output)
print(json.dumps(receipt))
