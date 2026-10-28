#!/usr/bin/env python3
"""Verify current owned resources after an interrupted launcher, without inventing its release."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('reservation', type=Path)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--lock', type=Path, required=True)
parser.add_argument('--expected-lock-inode', type=int, required=True)
parser.add_argument('--derived-data', required=True)
parser.add_argument('--launcher', required=True)
parser.add_argument('--owned-device', action='append', required=True)
args = parser.parse_args()
original = json.loads(args.reservation.read_text())
if original.get('releasedObservedAt') or args.output.exists():
    parser.error('Use the normal release verifier for a completed receipt; never overwrite recovery evidence')
owned = set(args.owned_device)
if not owned or not {row['uuid'] for row in original['runs']}.issubset(owned):
    parser.error('Every recorded runtime device must be explicitly owned')
inventory = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j'], timeout=20))
devices = [row for group in inventory['devices'].values() for row in group if row['udid'] in owned]
if len(devices) != len(owned) or any(row['state'] != 'Shutdown' for row in devices):
    parser.error('An owned device is missing or is not Shutdown; this verifier performs no cleanup')
matches = []
for line in subprocess.check_output(['ps', '-axo', 'pid=,comm=,args='], text=True, timeout=10).splitlines():
    parts = line.strip().split(None, 2)
    if len(parts) != 3 or int(parts[0]) == os.getpid():
        continue
    name = Path(parts[1]).name
    if (name == 'xcodebuild' and (args.derived_data in parts[2] or any(uuid in parts[2] for uuid in owned))) or (
        name.lower().startswith('python') and args.launcher in parts[2]
    ):
        matches.append(line)
if matches:
    parser.error(f'Task-owned launcher or xcodebuild processes remain: {matches}')
with args.lock.open('r+') as lease:
    inode = os.fstat(lease.fileno()).st_ino
    if inode != args.expected_lock_inode:
        parser.error('The shared lock inode changed')
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    fcntl.flock(lease, fcntl.LOCK_UN)
if args.lock.stat().st_ino != inode:
    parser.error('The shared lock was replaced')
now = datetime.datetime.now(datetime.timezone.utc)
proof = {
    'reservation': str(args.reservation), 'admittedAt': original['admittedAt'], 'source': original['source'],
    'originalActualUnlockAt': None, 'originalLauncherExitCode': None, 'originalReceiptIncomplete': True,
    'verifiedRecoveryObservedAt': now.isoformat(), 'lockInode': inode, 'lockProbe': 'free',
    'ownedDevices': [{'uuid': row['udid'], 'state': row['state']} for row in devices],
    'ownedMatchingProcesses': [], 'cleanupErrors': [], 'cleanupVerifiedNow': True,
    'verificationWithinOriginalDeadline': now.timestamp() <= original['cleanupDeadline'],
    'originalCleanupWithinDeadline': None,
    'scope': 'Current declared devices, task-matching launcher/xcodebuild and exact shared lock only. No signals, device control or OS-wide census. Original release and cleanup timing remain unknown.',
}
temporary = args.output.with_name(args.output.name + '.partial')
temporary.write_text(json.dumps(proof, indent=2) + '\n')
temporary.replace(args.output)
print(json.dumps(proof))
