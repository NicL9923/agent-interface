"""Crash-safe private writes and owner-only checks for the add-on, upgrade scripts and host tools.

Standard library only. Releases ship it beside the add-on, and
src/shared/qualification-inputs.json lists it, so a qualification receipt binds its
bytes like the code that calls it. Load it through sibling_module("private_fs") or
hermes_module("private_fs"), which keep one instance per process.

Three callers keep their own copy because this file is not beside them on the host:
qualification.py (tools run it from other release trees), hermes-qualified-python.py
(frozen into the candidate stage) and recover-app-after-native-update.py (staged alone).
"""
import json
import os
import stat
import uuid
from pathlib import Path

KINDS = {"file": stat.S_ISREG, "dir": stat.S_ISDIR}


def atomic_write(path, data, mode=0o600):
    """Replace ``path`` with ``data``, bytes or text, so a crash leaves the old or the new file.

    Writes a uniquely named sibling with ``mode`` (less the umask), syncs it, renames it
    over ``path`` and syncs the directory so the rename survives power loss. A failure
    removes the sibling, so a retry never trips over it.
    """
    path = Path(path)
    if isinstance(data, str):
        data = data.encode()
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def atomic_json(path, value, mode=0o600):
    """atomic_write of ``value`` as compact JSON, with no trailing newline."""
    atomic_write(path, json.dumps(value), mode)


def owner_private(path, kind="file", max_bytes=None):
    """Return the status of an owner-only ``kind`` this user owns, otherwise None.

    ``kind`` is "file" or "dir". ``path`` may be an open descriptor, checked with fstat.
    A path is never followed: a symbolic link fails like any other wrong type. Group or
    other permission bits, another owner or more than ``max_bytes`` also fail. A missing
    path raises FileNotFoundError.
    """
    info = os.fstat(path) if isinstance(path, int) else os.lstat(path)
    if (not KINDS[kind](info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077
            or max_bytes is not None and info.st_size > max_bytes):
        return None
    return info
