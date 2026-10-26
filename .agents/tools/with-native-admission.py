#!/usr/bin/env python3
"""Run a native command only while holding the coordinators' shared machine lock."""
import argparse
import fcntl
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--lock', required=True, type=Path, help='Exact shared fcntl.flock admission file')
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if not command or not args.lock.is_absolute():
    parser.error('Supply an absolute lock path and a command after --')
# Do not make a missing volume or coordination directory into an internal fallback.
fd = os.open(args.lock, os.O_RDWR | os.O_CREAT, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    os.close(fd)
    print(f'Machine admission is held: {args.lock}. No command started.', file=sys.stderr)
    raise SystemExit(75) from None
# Exec replaces this process. The command keeps the lease even if its launcher exits.
os.set_inheritable(fd, True)
os.execvp(command[0], command)
