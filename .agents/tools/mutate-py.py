#!/usr/bin/env python3
"""Break one line of Python source by hand, run a test command, restore the file, and print one result row.

    python3 .agents/tools/mutate-py.py FILE --old 'exact text' --new 'replacement' -- python3 tests/x_test.py
    python3 .agents/tools/mutate-py.py FILE --line 42 --new '    return None' -- python3 scripts/run-python-tests.py tests/x_test.py
    python3 .agents/tools/mutate-py.py --batch mutations.json [--baseline] [-- default command]

`--old` must occur exactly once in the file. `--line N` alone replaces the whole of line N, keeping its line ending;
with `--old` it replaces that text inside line N, which must hold it exactly once. A batch file is a JSON list of
{"name", "file", "new", "line" and/or "old", "command"}. A `command` is a list, or a string split like a shell
would, and a mutation without one uses the command after `--`. The output is a Markdown table, ready for
`docs/ledger/`, with one row per mutation: `failed: ...` when the command failed (the test caught the mutant),
`survived` when it passed, `error: ...` when the tool could not apply the mutation or run the command.
Exit codes: 0 every mutant failed, 1 a mutant survived, 2 usage or an error row, 3 a restore could not be verified.

The stale bytecode trap. Python reuses a `.pyc` whose recorded source mtime (whole seconds) and size match the
source. A mutant of the same size, written in the same second as the file's last change, runs the old bytecode and
reads as "survived"; the file restored in the same second as a mutant run runs the mutant's. So the tool
  - deletes every `__pycache__` under the repository before and after each run,
  - runs the command with `PYTHONDONTWRITEBYTECODE=1` and `-B` (added after a `python` command),
  - points `PYTHONPYCACHEPREFIX` at an empty directory for each run, so even a stale `.pyc` the clearing missed is
    never read, and
  - restores the file byte for byte, with its mode and mtime, then reads it back and compares.
`--keep-mtime` writes the mutant with the original's mtime, which reproduces the same-second trap on demand.

Restore on every exit path. The mutation is undone in a `finally`, and SIGINT, SIGTERM and SIGHUP stop the command's
process group and then restore. SIGKILL cannot be caught, so before touching a file the tool records its original
bytes in a private directory under the system temp directory, written to a temporary file and renamed so a kill mid-write
leaves no half record. Every run starts by restoring every file whose record names a dead process, whichever file this
run targets, and says so. A record whose directory is gone is discarded. It refuses a file another live run is mutating. An unreadable record is reported and kept,
because its saved original may be the only copy; it blocks a run on that file only. A mutant that does not compile is an
`error:` row, not a caught mutant, because every test would fail on the import.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "venv"})
EXIT_SURVIVED, EXIT_ERROR, EXIT_RESTORE = 1, 2, 3
# Signals that stop a run. SIGINT is Ctrl-C. SIGKILL cannot be caught and is covered by the pending record.
STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
FAILURE_LINE = re.compile(r"^(?:FAIL|ERROR): (\S+)|^(\S+) \.\.\. (?:FAIL|ERROR)|^(?:FAILED|E +)\S.*|^AssertionError.*", re.MULTILINE)


class ToolError(Exception):
    """The mutation could not be set up. The message becomes the row's `error:` text."""


class Interrupted(BaseException):
    """A stop signal arrived. A BaseException so no `except Exception` in this file swallows it."""

    def __init__(self, signum: int):
        super().__init__(signum)
        self.signum = signum


class RestoreFailure(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------------
# The mutation itself.

def apply_text(original: bytes, old: str | None, new: str, line: int | None) -> bytes:
    """The file's bytes with the mutation applied, or a ToolError saying why it cannot be."""
    new_bytes = new.encode()
    if line is not None:
        pieces = original.splitlines(keepends=True)
        if not 1 <= line <= len(pieces):
            raise ToolError(f"line {line} is outside the file's {len(pieces)} lines")
        target = pieces[line - 1]
        ending = target[len(target.rstrip(b"\r\n")):]
        body = target[:len(target) - len(ending)]
        if old is None:
            pieces[line - 1] = new_bytes + ending
        else:
            found = body.count(old.encode())
            if found != 1:
                raise ToolError(f"line {line} holds the text {found} times, not once")
            pieces[line - 1] = body.replace(old.encode(), new_bytes) + ending
        mutated = b"".join(pieces)
    else:
        if old is None:
            raise ToolError("give --old, --line, or both")
        found = original.count(old.encode())
        if found != 1:
            raise ToolError(f"the text occurs {found} times, not once")
        mutated = original.replace(old.encode(), new_bytes)
    if mutated == original:
        raise ToolError("the replacement changes nothing")
    return mutated


# ---------------------------------------------------------------------------------------------------------------
# Pending records, so a killed run's file is restored by the next run.

def pending_dir() -> Path:
    directory = Path(tempfile.gettempdir()) / f"mutate-py-{os.getuid()}"
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def write_atomic(path: Path, data: bytes | str) -> None:
    """Write beside the destination and rename over it, so a kill mid-write leaves the old file or the new one, never half."""
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with open(temporary, "wb") as handle:
        handle.write(data.encode() if isinstance(data, str) else data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_record(record: Path) -> dict:
    """The pending record's fields, or a ValueError when the file is not a record this tool wrote."""
    info = json.loads(record.read_text())
    if not isinstance(info, dict) or not all(isinstance(info.get(key), kind) for key, kind in
                                             (("pid", int), ("path", str), ("mode", int), ("mtime_ns", int))):
        raise ValueError("it lacks pid, path, mode and mtime_ns")
    return info


def pending_names(path: Path) -> tuple[Path, Path]:
    key = hashlib.sha256(str(path).encode()).hexdigest()[:24]
    return pending_dir() / f"{key}.json", pending_dir() / f"{key}.orig"


def recover_dead_runs() -> list[str]:
    """Restore every file a dead run left mutated, whichever file this run targets. Returns one note per record.

    A record of a live run is left alone. An unreadable record is reported and kept, because its `.orig` may be the only copy."""
    notes = []
    for record in sorted(pending_dir().glob("*.json")):
        backup = record.with_suffix(".orig")
        try:
            info = read_record(record)
        except (OSError, ValueError) as error:
            notes.append(f"the pending record {record} is unreadable ({error}); its original bytes may be in {backup}, so check them and delete both")
            continue
        if alive(info["pid"]):
            continue
        path = Path(info["path"])
        if not path.parent.is_dir():
            # A throwaway checkout deleted after a killed run: nothing can be restored, and the record would warn forever.
            record.unlink(missing_ok=True)
            backup.unlink(missing_ok=True)
            notes.append(f"discarded the record of {path}: its directory no longer exists")
            continue
        if backup.exists():
            try:
                write_original(path, backup.read_bytes(), info["mode"], info["mtime_ns"])
            except OSError as error:
                notes.append(f"{path} could not be restored from the unfinished run of pid {info['pid']} ({error}); the original bytes are in {backup}")
                continue
        record.unlink(missing_ok=True)
        backup.unlink(missing_ok=True)
        notes.append(f"restored {path} from the unfinished run of pid {info['pid']}")
    return notes


class Pending:
    """The original bytes of the file being mutated, kept outside the repository until the restore is verified."""

    def __init__(self, path: Path, original: bytes, stat: os.stat_result):
        self.record, self.backup = pending_names(path)
        self.path, self.original, self.stat = path, original, stat

    @staticmethod
    def guard(path: Path) -> None:
        """Refuse to mutate a file that still has a record after recover_dead_runs: another live run owns it, or its record cannot be trusted."""
        record, backup = pending_names(path)
        if not record.exists():
            return
        try:
            info = read_record(record)
        except (OSError, ValueError) as error:
            raise ToolError(f"the pending record for this file is unreadable ({error}); its original bytes may be in {backup}, so check the file against them, then delete both") from None
        if alive(info["pid"]):
            raise ToolError(f"another mutate-py run (pid {info['pid']}) is mutating this file")
        raise ToolError(f"an earlier run of pid {info['pid']} left this file mutated and could not restore it; the original bytes are in {backup}")

    def save(self) -> None:
        write_atomic(self.backup, self.original)
        write_atomic(self.record, json.dumps({"pid": os.getpid(), "path": str(self.path), "mode": self.stat.st_mode,
                                              "mtime_ns": self.stat.st_mtime_ns}))

    def drop(self) -> None:
        self.record.unlink(missing_ok=True)
        self.backup.unlink(missing_ok=True)


def write_original(path: Path, data: bytes, mode: int, mtime_ns: int) -> None:
    with open(path, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(path, mode & 0o7777)
    os.utime(path, ns=(mtime_ns, mtime_ns))


# ---------------------------------------------------------------------------------------------------------------
# Bytecode.

def clear_pycache(root: Path) -> int:
    """Delete every __pycache__ under root, without entering .git, node_modules or virtual environments."""
    removed = 0
    for current, directories, _ in os.walk(root):
        directories[:] = [name for name in directories if name not in SKIP_DIRS]
        for name in [name for name in directories if name == "__pycache__"]:
            shutil.rmtree(Path(current) / name, ignore_errors=True)
            directories.remove(name)
            removed += 1
    return removed


def repository_root(path: Path) -> Path:
    result = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=path.parent, capture_output=True, text=True, check=False)
    return Path(result.stdout.strip()) if result.returncode == 0 and result.stdout.strip() else path.parent


def python_command(command: list[str]) -> list[str]:
    """The command, with -B after a leading python so the interpreter writes no bytecode either way."""
    first = Path(command[0]).name
    if (first == "python" or re.fullmatch(r"python3(\.\d+)?", first) or command[0] == sys.executable) and "-B" not in command[1:2]:
        return [command[0], "-B", *command[1:]]
    return command


# ---------------------------------------------------------------------------------------------------------------
# Running the command.

class Result:
    def __init__(self, kind: str, detail: str = ""):
        self.kind, self.detail = kind, detail

    def cell(self) -> str:
        return f"{self.kind}: {self.detail}" if self.detail else self.kind


def summarize(output: str, code: int) -> str:
    """The first failing test or assertion the output names, and the exit code or signal."""
    match = FAILURE_LINE.search(output)
    named = ""
    if match:
        named = next((group for group in match.groups() if group), match.group(0))
        named = re.sub(r"\s+", " ", named).strip()[:100]
    if code < 0:
        how = f"killed by {signal.Signals(-code).name}"
        return f"{named} ({how})" if named else how
    return f"{named} (exit {code})" if named else f"exit {code}"


def run_command(command: list[str], cwd: Path, timeout: float | None, root: Path, state: dict) -> Result:
    prefix = tempfile.mkdtemp(prefix="mutate-py-pycache-")
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPYCACHEPREFIX": prefix}
    try:
        # Its own process group, so a stop signal ends the command and whatever it started.
        child = subprocess.Popen(python_command(command), cwd=cwd, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, errors="replace", start_new_session=True)
        state["child"] = child
        try:
            output, _ = child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            stop_group(child)
            child.communicate()
            return Result("error", f"timed out after {timeout:g} s")
        finally:
            state["child"] = None
            stop_group(child)
    except FileNotFoundError as error:
        return Result("error", f"cannot run the command: {error.filename or command[0]} not found")
    finally:
        shutil.rmtree(prefix, ignore_errors=True)
    if child.returncode == 0:
        return Result("survived")
    return Result("failed", summarize(output or "", child.returncode))


def stop_group(child: subprocess.Popen) -> None:
    """Kill what is left of the command's process group, which is only its own descendants."""
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def mutate_once(path: Path, root: Path, old: str | None, new: str, line: int | None, command: list[str], timeout: float | None,
                keep_mtime: bool) -> Result:
    """Apply one mutation, run the command, and restore the file whatever happens."""
    Pending.guard(path)
    if not path.is_file():
        return Result("error", f"{path} is not a file")
    stat = path.stat()
    original = path.read_bytes()
    try:
        mutated = apply_text(original, old, new, line)
    except ToolError as error:
        return Result("error", str(error))
    try:
        compile(mutated, str(path), "exec", dont_inherit=True)
    except (SyntaxError, ValueError) as error:
        # A mutant that cannot be imported fails every test, which would read as a caught mutant.
        where = f"line {error.lineno}: {error.msg}" if isinstance(error, SyntaxError) and error.lineno else str(error)
        return Result("error", f"the mutant does not compile ({where})")
    pending = Pending(path, original, stat)
    state: dict = {"child": None}
    previous = {sig: signal.getsignal(sig) for sig in STOP_SIGNALS}

    def stop(signum, _frame):
        # First, so a second stop signal cannot interrupt the restore that this one starts.
        for sig in STOP_SIGNALS:
            signal.signal(sig, signal.SIG_IGN)
        child = state.get("child")
        if child is not None:
            stop_group(child)
        raise Interrupted(signum)

    for sig in STOP_SIGNALS:
        signal.signal(sig, stop)
    interrupted: Interrupted | None = None
    result = Result("error", "not run")
    try:
        pending.save()
        clear_pycache(root)
        path.write_bytes(mutated)
        if keep_mtime:
            os.utime(path, ns=(stat.st_mtime_ns, stat.st_mtime_ns))
        result = run_command(command, root, timeout, root, state)
    except Interrupted as stopped:
        interrupted = stopped
    finally:
        # Signals that arrive from here on wait until the restore is done.
        for sig in STOP_SIGNALS:
            signal.signal(sig, signal.SIG_IGN)
        try:
            try:
                write_original(path, original, stat.st_mode, stat.st_mtime_ns)
            except OSError as error:
                raise RestoreFailure(f"{path} could not be restored ({error}); the original bytes are in {pending.backup}, and the next run restores them") from error
            clear_pycache(root)
            if path.read_bytes() != original:
                raise RestoreFailure(f"{path} does not match its original after the restore; the original bytes are in {pending.backup}")
            pending.drop()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    if interrupted is not None:
        raise interrupted
    return result


# ---------------------------------------------------------------------------------------------------------------
# The table and the command line.

def cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def table(rows: list[tuple[str, Result]]) -> str:
    lines = ["| Mutation | Result |", "| --- | --- |"]
    lines += [f"| {cell(name)} | {cell(result.cell())} |" for name, result in rows]
    return "\n".join(lines)


def label(spec: dict) -> str:
    if spec.get("name"):
        return spec["name"]
    where = f"line {spec['line']}" if spec.get("line") else repr(spec.get("old", ""))[:60]
    return f"{spec['file']}: {where}"


def parse_command(value, fallback: list[str] | None) -> list[str]:
    if value is None:
        if not fallback:
            raise ToolError("no test command: give one after `--`, or a `command` on the mutation")
        return list(fallback)
    command = shlex.split(value) if isinstance(value, str) else list(value)
    if not command:
        raise ToolError("the test command is empty")
    return command


def load_batch(path: Path) -> list[dict]:
    try:
        specs = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise SystemExit(f"mutate-py: cannot read the batch file: {error}") from None
    if not isinstance(specs, list) or not all(isinstance(spec, dict) for spec in specs):
        raise SystemExit("mutate-py: the batch file must be a JSON list of objects")
    for index, spec in enumerate(specs, 1):
        missing = [key for key in ("file", "new") if key not in spec]
        if missing or ("old" not in spec and "line" not in spec):
            raise SystemExit(f"mutate-py: mutation {index} needs file, new, and old or line")
    return specs


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mutate-py.py", description="Apply a hand-made mutation to a Python file, run a test command, restore the file, and print a result row.",
                                     usage="mutate-py.py FILE (--old TEXT | --line N [--old TEXT]) --new TEXT [options] -- COMMAND...\n       mutate-py.py --batch FILE.json [options] [-- COMMAND...]")
    parser.add_argument("file", nargs="?", help="the Python file to mutate")
    parser.add_argument("--old", help="exact text to replace; it must occur once in the file, or once in --line")
    parser.add_argument("--new", help="the replacement; with --line and no --old it replaces the whole line")
    parser.add_argument("--line", type=int, help="1-based line number")
    parser.add_argument("--name", help="the Mutation column for this row")
    parser.add_argument("--batch", help="JSON list of mutations")
    parser.add_argument("--baseline", action="store_true", help="run the command once unmutated first and stop if it fails, so a red suite cannot read as a caught mutant")
    parser.add_argument("--timeout", type=float, help="seconds a command may run before it counts as an error")
    parser.add_argument("--keep-mtime", action="store_true", help="write the mutant with the original's mtime, to reproduce the same-second bytecode trap")
    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    # Everything after the first `--` is the test command; argparse would otherwise mix it with FILE.
    command = None
    if "--" in argv:
        split = argv.index("--")
        command, argv = argv[split + 1:] or None, argv[:split]
    args = parser.parse_args(argv)
    if args.batch:
        if args.file or args.old or args.new or args.line:
            parser.error("--batch takes its mutations from the file")
        specs = load_batch(Path(args.batch))
    else:
        if not args.file or args.new is None or (args.old is None and args.line is None):
            parser.error("give FILE, --new, and --old or --line")
        specs = [{"file": args.file, "old": args.old, "new": args.new, "line": args.line, "name": args.name}]
    specs = [{**spec, "path": Path(spec["file"]).resolve()} for spec in specs]
    for note in recover_dead_runs():
        print(f"mutate-py: {note}", file=sys.stderr)
    status = 0
    if args.baseline:
        try:
            first = parse_command(specs[0].get("command"), command)
        except ToolError as error:
            print(f"mutate-py: {error}", file=sys.stderr)
            return EXIT_ERROR
        root = repository_root(specs[0]["path"])
        clear_pycache(root)
        base = run_command(first, root, args.timeout, root, {"child": None})
        clear_pycache(root)
        if base.kind != "survived":
            print(f"mutate-py: the unmutated command did not pass ({base.cell()}); no mutation was run", file=sys.stderr)
            return EXIT_ERROR
    rows: list[tuple[str, Result]] = []
    try:
        for spec in specs:
            path = spec["path"]
            try:
                run = parse_command(spec.get("command"), command)
                result = mutate_once(path, repository_root(path), spec.get("old"), spec["new"], spec.get("line"), run, args.timeout, args.keep_mtime)
            except ToolError as error:
                result = Result("error", str(error))
            except RestoreFailure as error:
                rows.append((label(spec), Result("error", "the file could not be restored")))
                print(table(rows))
                print(f"mutate-py: {error}", file=sys.stderr)
                return EXIT_RESTORE
            rows.append((label(spec), result))
    except Interrupted as stopped:
        # The file is already restored. Print what ran, so a long batch is not lost to Ctrl-C.
        if rows:
            print(table(rows))
        print(f"mutate-py: stopped by {signal.Signals(stopped.signum).name}; the file was restored", file=sys.stderr)
        return 128 + stopped.signum
    print(table(rows))
    if any(result.kind == "error" for _, result in rows):
        status = EXIT_ERROR
    elif any(result.kind == "survived" for _, result in rows):
        status = EXIT_SURVIVED
    return status


if __name__ == "__main__":
    # Never write bytecode for this tool's own imports either.
    sys.dont_write_bytecode = True
    sys.exit(main(sys.argv[1:]))
