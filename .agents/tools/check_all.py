"""Run this repository's full check battery the same way in every worktree.

The command is `.agents/tools/check-all`. It runs typecheck, lint, ruff, test, build, e2e and py in that order,
stops at the first failure unless told to keep going, and prints one summary table. Around the checks it handles
the traps agents kept hitting by hand:

- A browser-suite port that another worktree holds: it picks a free app port and control port and holds a lock
  on the pair while the suite runs, so two runs never choose the same one between the check and the bind.
- Heavy suites timing out under each other: at most `--heavy-slots` of test, e2e and py share the machine.
- A node_modules that is missing, or older than package-lock.json: it refuses to run and prints the fix.
- ruff: it needs the exact version in .github/requirements-ci.txt, from PATH or a cached venv, never another.

Locks are flock(2) locks on small files in a per-user cache directory, so a holder that dies, even by SIGKILL,
frees its lock the moment its process ends. Nothing here needs a package outside the standard library.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

CHECKS = ("typecheck", "lint", "ruff", "test", "build", "e2e", "py")
HEAVY = frozenset({"test", "e2e", "py"})
# e2e serves dist/client, which only a build produces.
NEEDS = {"e2e": "build"}
PY_MODES = ("auto", "always", "never")
# The app port and its control port (port + 1) come from pairs in this range. It sits above the ports the
# measuring tools default to and below the ephemeral range (32768 and up on Linux, 49152 on macOS), so an
# outgoing connection cannot take a port between the check and the bind.
PORT_BASE = 24100
PORT_PAIRS = 400
EXIT_USAGE = 2
EXIT_LOCK_TIMEOUT = 75
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


class Refusal(Exception):
    """A precondition failed. The message says what is wrong and the command that fixes it."""


class LockTimeout(Refusal):
    pass


def strip_ansi(text):
    return ANSI.sub("", text)


# ---------------------------------------------------------------------------------------------------------------
# Where the tool keeps its locks, logs and ruff venv.


def cache_dir(env=None, home=None):
    """A per-user directory outside every checkout, shared by every worktree on the machine."""
    env = os.environ if env is None else env
    if env.get("CHECK_ALL_HOME"):
        return Path(env["CHECK_ALL_HOME"])
    home = Path(home) if home else Path.home()
    if sys.platform == "darwin":
        return home / "Library/Caches/agent-interface/check-all"
    return Path(env.get("XDG_CACHE_HOME") or home / ".cache") / "agent-interface/check-all"


# ---------------------------------------------------------------------------------------------------------------
# Locks. A held lock is an open file descriptor with flock(LOCK_EX); the kernel drops it when the process dies.


class Held:
    """A flock held on a file until `release()` or the end of the process."""

    def __init__(self, fd, path):
        self.fd, self.path = fd, path

    def write_info(self, info):
        os.ftruncate(self.fd, 0)
        os.pwrite(self.fd, json.dumps(info).encode(), 0)

    def release(self):
        if self.fd is None:
            return
        try:
            os.ftruncate(self.fd, 0)
        finally:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release()


def try_lock(path):
    """The lock on `path`, or None when another process holds it. The descriptor is not inherited by children."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return Held(fd, path)


def wait_for(path, poll=0.2):
    """Block until the lock on `path` is free. Used for short critical sections that other runs may also need."""
    while True:
        held = try_lock(path)
        if held:
            return held
        time.sleep(poll)


def read_info(path):
    try:
        info = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return info if isinstance(info, dict) else None


def describe_holder(info, now):
    if not info:
        return "another run"
    seconds = max(0, int(now - info.get("since", now)))
    return f"{info.get('check', '?')} in {info.get('worktree', '?')} (pid {info.get('pid', '?')}, {seconds}s)"


def acquire_slot(directory, slots, info, timeout, poll=0.25, note=None, clock=time.monotonic, sleep=time.sleep):
    """Take one of `slots` machine-wide heavy slots, waiting up to `timeout` seconds. Returns (Held, seconds waited).

    `note(message)` is called when the wait starts and every 30 seconds, naming who holds the slots.
    """
    started = clock()
    announced = None
    while True:
        for index in range(slots):
            held = try_lock(directory / f"heavy-{index}.lock")
            if held:
                held.write_info({**info, "since": time.time()})
                return held, clock() - started
        waited = clock() - started
        holders = ", ".join(describe_holder(read_info(directory / f"heavy-{index}.lock"), time.time()) for index in range(slots))
        if waited >= timeout:
            raise LockTimeout(f"Gave up after {int(waited)}s waiting for a heavy slot; {slots} in use by {holders}. Raise --lock-timeout or CHECK_ALL_HEAVY_SLOTS.")
        if note and (announced is None or waited - announced >= 30):
            announced = waited
            note(f"queued for a heavy slot ({slots} total), held by {holders}")
        sleep(poll)


# ---------------------------------------------------------------------------------------------------------------
# The browser suite's ports.


def can_bind(port, host="127.0.0.1"):
    """Whether a server could listen on `port` now. Node sets SO_REUSEADDR, so this does too."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def port_candidates(seed, base=PORT_BASE, pairs=PORT_PAIRS):
    """App ports to try, each owning itself and the next port. The start depends on the worktree, so repeat runs
    reuse a port and parallel worktrees begin apart. The order then wraps through every pair."""
    start = int(hashlib.sha256(str(seed).encode()).hexdigest(), 16) % pairs
    return [base + 2 * ((start + step) % pairs) for step in range(pairs)]


def pick_e2e_port(directory, seed, requested=None, base=PORT_BASE, pairs=PORT_PAIRS, bindable=can_bind):
    """Lock a free app port and control port pair for the browser suite. Returns (Held, port).

    With `requested` (the caller's own E2E_PORT) only that pair is considered, and a busy one is an error rather
    than a quiet move to another port. The lock file is named for the app port; candidates never overlap, so two
    runs cannot hold pairs that share a control port.
    """
    candidates = [requested] if requested else port_candidates(seed, base, pairs)
    busy = []
    for port in candidates:
        held = try_lock(directory / f"e2e-port-{port}.lock")
        if not held:
            busy.append(f"{port} (locked by another check-all)")
            continue
        taken = [number for number in (port, port + 1) if not bindable(number)]
        if not taken:
            held.write_info({"pid": os.getpid(), "port": port, "since": time.time()})
            return held, port
        held.release()
        busy.append(f"{port} (port {taken[0]} is in use)")
    if requested:
        raise Refusal(f"E2E_PORT={requested} is not usable: {busy[0]}. Unset E2E_PORT to let check-all choose, or free that port and the next one.")
    raise Refusal(f"No free app and control port pair in {base}-{base + 2 * pairs - 1}.")


# ---------------------------------------------------------------------------------------------------------------
# node_modules.


def lock_drift(lock, installed):
    """Differences between package-lock.json's packages and the hidden lockfile npm wrote at install time.

    A package the lock lists but the install lacks is fine when it is optional: npm leaves out the binaries for
    other platforms.
    """
    wanted, present = lock.get("packages", {}), installed.get("packages", {})
    problems = []
    for path, entry in present.items():
        if not path:
            continue
        if path not in wanted:
            problems.append(f"{path} is installed but not in package-lock.json")
        elif entry.get("version") != wanted[path].get("version"):
            problems.append(f"{path} is {entry.get('version')} but package-lock.json has {wanted[path].get('version')}")
    for path, entry in wanted.items():
        if path and path not in present and not entry.get("optional"):
            problems.append(f"{path} is in package-lock.json but not installed")
    return problems


def check_install(root):
    """Refuse when node_modules is missing or older than package-lock.json. Returns warnings to print."""
    modules = root / "node_modules"
    fix = "Fix: npm ci"
    if not modules.exists():
        where = f" (a symlink to {os.readlink(modules)}, which does not exist)" if modules.is_symlink() else ""
        raise Refusal(f"node_modules is missing{where}. {fix}")
    installed_path = modules / ".package-lock.json"
    if not installed_path.is_file():
        raise Refusal(f"node_modules has no .package-lock.json, so npm did not install it. {fix}")
    try:
        lock = json.loads((root / "package-lock.json").read_text())
        installed = json.loads(installed_path.read_text())
    except (OSError, ValueError) as error:
        raise Refusal(f"Could not read the lockfiles to compare them ({error}). {fix}") from error
    drift = lock_drift(lock, installed)
    if drift:
        shown = "; ".join(drift[:3]) + (f"; and {len(drift) - 3} more" if len(drift) > 3 else "")
        raise Refusal(f"package-lock.json changed since node_modules was installed: {shown}. {fix}")
    if modules.is_symlink():
        return [f"node_modules is a symlink to {os.readlink(modules)}. It matches package-lock.json, but a shared install lets"
                " the other checkout change what this one tests; run npm ci here to own one."]
    return []


def check_node(root, env=None):
    """Refuse when the node on PATH is outside package.json's engines, as the test suite itself would."""
    script = ("import { readFileSync } from 'node:fs'; import { satisfiesEngine } from './scripts/node-engine.mjs';"
              "const range = JSON.parse(readFileSync('package.json', 'utf8')).engines.node;"
              "console.log(JSON.stringify({ ok: satisfiesEngine(process.version, range), version: process.version, range }));")
    try:
        result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=root, env=env, capture_output=True, text=True, check=False)
    except FileNotFoundError as error:
        raise Refusal('node is not on PATH. Fix: export PATH="$HOME/.local/share/fnm:$PATH"; eval "$(fnm env)"') from error
    if result.returncode != 0:
        raise Refusal(f"node could not read scripts/node-engine.mjs: {result.stderr.strip()[-300:]}")
    info = json.loads(result.stdout)
    if not info["ok"]:
        wanted = (root / ".node-version").read_text().strip() if (root / ".node-version").is_file() else info["range"]
        raise Refusal(f"node {info['version']} is outside this repository's supported range ({info['range']}). Fix: fnm use {wanted}")


# ---------------------------------------------------------------------------------------------------------------
# ruff.


def pinned_ruff(root):
    """The ruff version CI installs, from .github/requirements-ci.txt, so the pin has one home."""
    text = (root / ".github/requirements-ci.txt").read_text()
    match = re.search(r"^ruff==(\S+)\s*$", text, re.MULTILINE)
    if not match:
        raise Refusal("Could not find a `ruff==VERSION` line in .github/requirements-ci.txt.")
    return match.group(1)


def ruff_version(executable, env=None):
    try:
        result = subprocess.run([str(executable), "--version"], capture_output=True, text=True, check=False, env=env)
    except OSError:
        return None
    match = re.fullmatch(r"ruff (\S+)", result.stdout.strip()) if result.returncode == 0 else None
    return match.group(1) if match else None


def find_ruff(root, cache, env=None, bootstrap_python=sys.executable, note=None):
    """The path of a ruff at the version CI pins. Looks on PATH, then in a cached venv, then makes that venv once.

    A ruff of any other version is never run: it would lint to a different rule set than CI.
    """
    env = os.environ if env is None else env
    wanted = pinned_ruff(root)
    seen = []
    on_path = shutil.which("ruff", path=env.get("PATH"))
    if on_path:
        found = ruff_version(on_path, env)
        if found == wanted:
            return on_path
        seen.append(f"{on_path} is {found or 'not a working ruff'}")
    venv = cache / f"ruff-{wanted}"
    cached, done = venv / "bin/ruff", venv / ".complete"

    def from_cache():
        if not done.exists():
            return None
        found = ruff_version(cached, env)
        if found != wanted:
            raise Refusal(f"Refusing the cached ruff at {cached}: it reports {found}, and this repository pins {wanted}. Fix: rm -rf {venv}")
        return str(cached)

    if from_cache():
        return str(cached)
    cache.mkdir(parents=True, exist_ok=True)
    # A venv is not relocatable, so it is built where it will live, under a lock, and marked complete last.
    # A directory without the mark is the leftover of a run that died, and is rebuilt.
    with wait_for(cache / "ruff-install.lock"):
        if from_cache():  # another worktree finished while this one waited
            return str(cached)
        if note:
            note(f"installing ruff=={wanted} into {venv} once ({'; '.join(seen) or 'none on PATH'})")
        shutil.rmtree(venv, ignore_errors=True)
        try:
            for argv in ([bootstrap_python, "-m", "venv", str(venv)], [str(venv / "bin/pip"), "install", "--disable-pip-version-check", "--quiet", f"ruff=={wanted}"]):
                result = subprocess.run(argv, capture_output=True, text=True, check=False, env=env)
                if result.returncode != 0:
                    tail_text = (result.stderr or result.stdout).strip()[-400:]
                    raise Refusal(f"Could not install ruff=={wanted} ({' '.join(argv[:3])} failed: {tail_text}). Fix: put ruff {wanted} on PATH, for example pip install ruff=={wanted}.")
            found = ruff_version(cached, env)
            if found != wanted:
                raise Refusal(f"The installed ruff reports {found}, and this repository pins {wanted}; refusing to use it.")
            done.write_text(found + "\n")
        except BaseException:
            shutil.rmtree(venv, ignore_errors=True)
            raise
    return str(cached)


# ---------------------------------------------------------------------------------------------------------------
# Whether the Python suite is worth running.


def python_touched(paths):
    return any(path.endswith(".py") or path.startswith("src/hermes/") or path.startswith("scripts/") for path in paths)


def changed_paths(root, base):
    """Paths changed on this branch since it left `base`, plus uncommitted and untracked ones. None if git cannot say.

    Renames are listed as a delete and an add, so moving a Python file away still counts as touching Python."""
    def lines(*argv):
        result = subprocess.run(["git", *argv], cwd=root, capture_output=True, text=True, check=False)
        return None if result.returncode != 0 else [part for part in result.stdout.split("\0") if part]
    committed = lines("diff", "--name-only", "--no-renames", "-z", f"{base}...HEAD")
    working = lines("diff", "--name-only", "--no-renames", "-z", "HEAD")
    untracked = lines("ls-files", "--others", "--exclude-standard", "-z")
    if committed is None or working is None or untracked is None:
        return None
    return sorted(set(committed + working + untracked))


def decide_py(mode, paths, base, explicit=False):
    """Whether to run the Python suite and why. `explicit` means the caller named py in --only."""
    if mode == "never":
        return False, "--py never"
    if mode == "always":
        return True, "--py always"
    if explicit:
        return True, "named in --only"
    if paths is None:
        return True, f"cannot diff against {base}, so it runs"
    if python_touched(paths):
        return True, f"the diff against {base} touches Python, src/hermes or scripts/"
    return False, f"no Python, src/hermes or scripts/ changes against {base}"


# ---------------------------------------------------------------------------------------------------------------
# Counts each tool reports.


def numbers(line):
    """{'passed': 3, 'failed': 1} from text like '1 failed | 3 passed (4)'."""
    return {label: int(count) for count, label in re.findall(r"(\d+) (passed|failed|skipped|todo|flaky|interrupted|did not run)", line)}


def parse_counts(check, output):
    """The counts a tool printed, as a dict of integers. An unrecognized output gives an empty dict."""
    text = strip_ansi(output)
    counts = {}
    if check == "test":
        for key, label in (("files", "Test Files"), ("tests", "Tests")):
            match = re.search(rf"^\s*{label}\s+(.+)$", text, re.MULTILINE)
            if match:
                parts = numbers(match.group(1))
                total = re.search(r"\((\d+)\)", match.group(1))
                counts[key] = int(total.group(1)) if total else sum(parts.values())
                counts[f"{key}_failed"] = parts.get("failed", 0)
                counts[f"{key}_skipped"] = parts.get("skipped", 0)
    elif check == "e2e":
        for label in ("passed", "failed", "flaky", "skipped", "interrupted", "did not run"):
            match = re.search(rf"^\s*(\d+) {label}\b", text, re.MULTILINE)
            if match:
                counts[label.replace(" ", "_")] = int(match.group(1))
        if counts:
            counts["tests"] = sum(counts.values())
    elif check == "py":
        match = re.search(r"^(\d+) passed, (\d+) skipped, (\d+) failed in ", text, re.MULTILINE)
        if match:
            passed, skipped, failed = map(int, match.groups())
            counts.update(files=passed + skipped + failed, passed=passed, skipped=skipped, failed=failed)
    elif check == "build":
        match = re.search(r"✓ (\d+) modules transformed", text)
        if match:
            counts["modules"] = int(match.group(1))
    elif check == "lint":
        # oxlint prints one `file:line:col: warning|error rule: message` line per problem when piped, and no total.
        problems = re.findall(r"^\S+:\d+:\d+: (warning|error)\b", text, re.MULTILINE)
        if problems:
            counts.update(errors=problems.count("error"), warnings=problems.count("warning"))
    elif check == "typecheck":
        errors = len(re.findall(r"\berror TS\d+", text))
        if errors:
            counts["errors"] = errors
    elif check == "ruff":
        match = re.search(r"^Found (\d+) errors?\.?$", text, re.MULTILINE)
        if match:
            counts["errors"] = int(match.group(1))
    return counts


def describe_counts(check, counts):
    def plural(number, word):
        return f"{number} {word}{'' if number == 1 else 's'}"

    def extras(*pairs):
        return [f"{counts[key]} {label}" for key, label in pairs if counts.get(key)]

    parts = []
    if check == "test" and "tests" in counts:
        parts = [plural(counts.get("files", 0), "file"), plural(counts["tests"], "test")] + extras(("tests_failed", "failed"), ("tests_skipped", "skipped"))
    elif check == "e2e" and "tests" in counts:
        parts = [plural(counts["tests"], "test")] + extras(("failed", "failed"), ("flaky", "flaky"), ("skipped", "skipped"))
    elif check == "py" and "files" in counts:
        parts = [plural(counts["files"], "file")] + extras(("failed", "failed"), ("skipped", "skipped"))
    elif check == "build" and "modules" in counts:
        parts = [plural(counts["modules"], "module")]
    elif check in ("typecheck", "lint", "ruff") and (counts.get("errors") or counts.get("warnings")):
        parts = ([plural(counts["errors"], "error")] if counts.get("errors") else []) + ([plural(counts["warnings"], "warning")] if counts.get("warnings") else [])
    return ", ".join(parts)


# ---------------------------------------------------------------------------------------------------------------
# Running one check.


class Result:
    """`note` is the table's last cell when there are no counts, such as why a check was skipped.
    `detail` is the output tail printed under a failure, and `log` is where the full output went."""

    def __init__(self, name, status, queued=0.0, seconds=0.0, counts=None, note="", detail="", log=None):
        self.name, self.status, self.queued, self.seconds = name, status, queued, seconds
        self.counts, self.note, self.detail, self.log = counts or {}, note, detail, log


def kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_process(argv, cwd, env, log_path, timeout, verbose):
    """Run `argv` in its own process group, saving its output. Returns (returncode or None on timeout, output)."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, errors="replace", start_new_session=True)
    expired = threading.Event()

    def expire():
        expired.set()
        kill_group(process)

    timer = threading.Timer(timeout, expire)
    timer.start()
    chunks = []
    try:
        with log_path.open("w") as log:
            for line in process.stdout:
                chunks.append(line)
                log.write(line)
                if verbose:
                    sys.stderr.write(line)
        process.wait()
    except BaseException:
        kill_group(process)
        raise
    finally:
        timer.cancel()
        process.stdout.close()
    return (None if expired.is_set() else process.returncode), "".join(chunks)


def tail(output, lines=40):
    return "\n".join(strip_ansi(output).rstrip().splitlines()[-lines:])


def format_seconds(seconds):
    if seconds < 60:
        return f"{seconds:.1f}s"
    return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"


def format_queued(seconds):
    """Queue time, or a dash when the run did not wait."""
    return format_seconds(seconds) if seconds >= 0.05 else "-"


def render_table(results):
    labels = {"pass": "pass", "fail": "FAIL", "timeout": "TIMEOUT", "locked": "NOT QUEUED", "skip": "skipped"}
    rows = [("check", "result", "queued", "run", "counts")]
    for result in results:
        text = describe_counts(result.name, result.counts) or result.note or "-"
        rows.append((result.name, labels[result.status], format_queued(result.queued), format_seconds(result.seconds) if result.status != "skip" else "-", text))
    widths = [max(len(row[column]) for row in rows) for column in range(4)]
    return "\n".join("  ".join(cell.ljust(widths[column]) for column, cell in enumerate(row[:4])) + "  " + row[4] for row in rows)


# ---------------------------------------------------------------------------------------------------------------
# Choosing and running the battery.


def parse_names(value, option):
    names = [name for name in value.split(",") if name]
    unknown = [name for name in names if name not in CHECKS]
    if unknown or not names:
        raise Refusal(f"{option} takes names from {', '.join(CHECKS)}; got {value!r}.")
    return names


def build_parser():
    parser = argparse.ArgumentParser(prog="check-all", description="Run typecheck, lint, ruff, test, build, e2e and py, in that order.",
                                     epilog=f"Checks: {', '.join(CHECKS)}. Heavy (machine-wide slot): {', '.join(sorted(HEAVY))}.")
    parser.add_argument("--only", metavar="LIST", help="run only these checks, comma separated")
    parser.add_argument("--skip", metavar="LIST", help="leave out these checks, comma separated")
    parser.add_argument("--py", choices=PY_MODES, default="auto", help="auto runs py when the diff against --base touches Python, src/hermes or scripts/")
    parser.add_argument("--keep-going", "--continue", dest="keep_going", action="store_true", help="run the rest after a failure")
    parser.add_argument("--verbose", action="store_true", help="stream each check's output as it runs")
    parser.add_argument("--base", default="origin/main", help="ref the auto Python decision diffs against (default origin/main)")
    parser.add_argument("--heavy-slots", type=int, metavar="N", help="heavy suites allowed at once on this machine (default $CHECK_ALL_HEAVY_SLOTS or 1)")
    parser.add_argument("--lock-timeout", type=float, default=3600, metavar="SECONDS", help="how long to queue for a heavy slot (default 3600)")
    parser.add_argument("--check-timeout", type=float, default=1800, metavar="SECONDS", help="kill a check that runs longer (default 1800)")
    return parser


def select(args):
    """The checks to run, in order, and whether py was named explicitly."""
    chosen = parse_names(args.only, "--only") if args.only else list(CHECKS)
    skipped = set(parse_names(args.skip, "--skip")) if args.skip else set()
    return [name for name in CHECKS if name in chosen and name not in skipped], bool(args.only and "py" in chosen)


def prune_logs(directory, keep, current):
    if directory.is_dir():
        old = sorted((path for path in directory.iterdir() if path.is_dir() and path != current), key=lambda path: path.name)
        for path in old[:max(0, len(old) - keep)]:
            shutil.rmtree(path, ignore_errors=True)


def run_battery(root, args, cache, log=None, env=None):
    """Run the checks. Returns (results, warnings). Preconditions are checked before anything runs."""
    log = log or (lambda message: print(f"check-all: {message}", file=sys.stderr, flush=True))
    env = dict(os.environ if env is None else env)
    names, py_explicit = select(args)
    if not names:
        raise Refusal("Nothing to run after --only and --skip.")
    try:
        slots = args.heavy_slots if args.heavy_slots is not None else int(env.get("CHECK_ALL_HEAVY_SLOTS") or 1)
    except ValueError:
        raise Refusal(f"CHECK_ALL_HEAVY_SLOTS={env['CHECK_ALL_HEAVY_SLOTS']!r} must be a whole number.") from None
    if slots < 1:
        raise Refusal("The heavy slot count must be at least 1.")

    warnings = []
    if names != ["ruff"]:
        check_node(root, env)
        warnings = check_install(root)
        for warning in warnings:
            log(f"warning: {warning}")
    ruff = find_ruff(root, cache, env, note=log) if "ruff" in names else None
    if "e2e" in names and "build" not in names and not (root / "dist/client/index.html").is_file():
        raise Refusal("e2e serves dist/client, which is not built. Fix: npm run build, or do not --skip build.")
    requested = None
    if "e2e" in names and env.get("E2E_PORT"):
        if not env["E2E_PORT"].isdigit() or not 1024 <= int(env["E2E_PORT"]) <= 65534:
            raise Refusal(f"E2E_PORT={env['E2E_PORT']!r} must be a whole number from 1024 to 65534.")
        requested = int(env["E2E_PORT"])
    run_py, py_reason = False, ""
    if "py" in names:
        paths = changed_paths(root, args.base) if args.py == "auto" and not py_explicit else []
        run_py, py_reason = decide_py(args.py, paths, args.base, py_explicit)

    child_env = {**env, "NO_COLOR": "1"}
    commands = {"typecheck": ["npm", "run", "typecheck"], "lint": ["npm", "run", "lint"], "test": ["npm", "test"], "build": ["npm", "run", "build"],
                "e2e": ["npm", "run", "test:e2e"], "py": ["npm", "run", "test:py"]}
    if ruff:
        commands["ruff"] = [ruff, "check", "."]
    logs = cache / "logs" / f"{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}-{root.name}"
    prune_logs(cache / "logs", keep=30, current=logs)

    results, failed = [], {}
    for index, name in enumerate(names, 1):
        if name == "py" and not run_py:
            results.append(Result(name, "skip", note=py_reason))
        elif NEEDS.get(name) in failed:
            results.append(Result(name, "skip", note=f"{NEEDS[name]} did not pass"))
        elif failed and not args.keep_going:
            results.append(Result(name, "skip", note="an earlier check failed"))
        else:
            log(f"[{index}/{len(names)}] {name}" + (f" ({py_reason})" if name == "py" else ""))
            result = run_one(root, name, commands[name], child_env, logs, cache, slots, args, requested, log)
            results.append(result)
            log(f"{name}: {result.status} in {format_seconds(result.seconds)}" + (f" after {format_seconds(result.queued)} queued" if result.queued >= 0.05 else ""))
            if result.status != "pass":
                failed[name] = result
                if result.detail:
                    print(f"\n--- {name}: last lines (full output: {result.log}) ---\n{result.detail}\n", file=sys.stderr, flush=True)
    return results, warnings


def run_one(root, name, argv, env, logs, cache, slots, args, requested, log):
    held = port_lease = None
    queued = 0.0
    try:
        if name in HEAVY:
            try:
                held, queued = acquire_slot(cache / "locks", slots, {"pid": os.getpid(), "check": name, "worktree": str(root)}, args.lock_timeout,
                                            note=lambda message: log(f"{name}: {message}"))
            except LockTimeout as error:
                return Result(name, "locked", args.lock_timeout, 0.0, note="gave up queueing for a heavy slot", detail=str(error))
        if name == "e2e":
            port_lease, port = pick_e2e_port(cache / "locks", root, requested)
            env = {**env, "E2E_PORT": str(port)}
            log(f"e2e: app port {port}, control port {port + 1}")
        started = time.monotonic()
        log_path = logs / f"{name}.log"
        code, output = run_process(argv, root, env, log_path, args.check_timeout, args.verbose)
        seconds = time.monotonic() - started
    except Refusal as error:
        return Result(name, "fail", queued, 0.0, note="refused", detail=str(error))
    finally:
        for lease in (port_lease, held):
            if lease:
                lease.release()
    counts = parse_counts(name, output)
    if code is None:
        return Result(name, "timeout", queued, seconds, counts, f"killed after {int(args.check_timeout)}s", f"killed after {int(args.check_timeout)}s\n{tail(output)}", log_path)
    return Result(name, "pass" if code == 0 else "fail", queued, seconds, counts, "", tail(output) if code else "", log_path)


class Interrupted(BaseException):
    pass


def main(argv, root=ROOT, cache=None):
    cache = cache or cache_dir()

    def interrupt(signum, _frame):
        raise Interrupted(signal.Signals(signum).name)

    previous = {number: signal.signal(number, interrupt) for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    started = time.monotonic()
    try:
        args = build_parser().parse_args(argv)
        results, warnings = run_battery(root, args, cache)
    except Refusal as error:
        print(f"check-all: refusing to run. {error}", file=sys.stderr)
        return EXIT_USAGE
    except Interrupted as error:
        print(f"check-all: stopped by {error}; its checks were killed and its locks released", file=sys.stderr)
        return 130
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
    print("\n" + render_table(results))
    for warning in warnings:
        print(f"\nWarning: {warning}")
    bad = [result.name for result in results if result.status in ("fail", "timeout", "locked")]
    ran = [result for result in results if result.status != "skip"]
    verdict = "FAILED: " + ", ".join(bad) if bad else f"All {len(ran)} checks passed"
    print(f"\n{verdict} ({format_seconds(time.monotonic() - started)} total, {format_seconds(sum(r.queued for r in ran))} of it queued for heavy slots)")
    if any(result.status == "locked" for result in results):
        return EXIT_LOCK_TIMEOUT
    return 1 if bad else 0
