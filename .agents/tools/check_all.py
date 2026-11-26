"""Run this repository's full check battery the same way in every worktree.

The command is `.agents/tools/check-all`. It runs typecheck, lint, ruff, test, build, e2e and py in that order,
stops at the first failure unless told to keep going, and prints one summary table. Around the checks it handles
the traps agents kept hitting by hand:

- A browser-suite port that another worktree holds: it picks a free app port and control port and holds a lock
  on the pair while the suite runs, so two runs never choose the same one between the check and the bind.
- Heavy suites timing out under each other: at most `--heavy-slots` of test, e2e and py share the machine.
- A node_modules that is missing, or older than pnpm-lock.yaml: it refuses to run and prints the fix.
- ruff: it needs the exact version in .github/requirements-ci.txt, from PATH or a cached venv, never another.

Locks are flock(2) locks on small files in a per-user cache directory. The check's own process (the pnpm
wrapper) inherits the lock descriptors and waits for the suite it started, so a lock lasts as long as the suite
does: check-all killed by SIGKILL leaves its suite running with its slot and ports still held, and they free
when the suite ends. The lock files name the check's pid once it starts, so a waiter is told about a live process.

Only pnpm should hold the locks, and that depends on the descriptor numbers. When Node starts, libuv marks
descriptors 0 to 15 close-on-exec (and goes on past 15 only until it meets a closed number), so a descriptor
below 16 is not passed to the runner, its children or Playwright's web server. That does not matter, because pnpm
waits for the runner and the runner stops the server when it exits. A descriptor of 17 or more is passed on to
every process in the suite tree, and a leaked child, or a web server in a session of its own, would then hold the
slot for good. A launcher that leaves descriptors 3 to 20 open puts the locks at 21 and up, which is how 207
processes once held one slot. So `main` closes every inherited descriptor above 2 before it opens a lock, which
puts the locks at 3 and 4, and `run_process` refuses to pass on one that is 16 or more. A stopped run (Ctrl-C, SIGTERM or --check-timeout) sends its check SIGINT first, as Ctrl-C would, so Playwright
can shut down the web server it started in a process group of its own, and kills what is left after ten
seconds. Nothing here needs a package outside the standard library.

WebKit needs system libraries that some Linux hosts lack (Fedora has no libicu74 or libjpeg-turbo8). Before e2e,
check-all launches WebKit once, in a process group of its own that is stopped whole when it ends. When WebKit starts, e2e
runs both browser projects on the host as one check. When it cannot, the e2e check runs in two steps under the
same slot and ports: Chromium on the host, then WebKit under podman in Playwright's container for the installed
@playwright/test. It names the image by tag, which CI's Browser smoke job pins by digest. The table shows a row
for each step. Without podman it refuses to run, so WebKit is never skipped silently. The container's network is
its own, so two worktrees' containers never share a port. The lock descriptors are never passed to podman, whose
helpers could outlive the run: check-all holds them while it waits for the container, and on every stop removes
the container before it lets them go. A removal that fails is reported with the container's name. A check's output
is read for at most a few seconds after the check exits or is stopped, since a process outside its group, such as
a container its client left behind, can hold it open; past that the check is stopped as a timeout would stop it,
its log is closed with what it printed, and the table says the output was cut short.
check-all killed by SIGKILL frees the locks while the container runs on; podman's --timeout ends that container
after --check-timeout.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import functools
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
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

CHECKS = ("typecheck", "lint", "ruff", "test", "build", "e2e", "py")
HEAVY = frozenset({"test", "e2e", "py"})
# e2e serves dist/client, which only a build produces.
NEEDS = {"e2e": "build"}
# Checks whose passing output always has counts. A pass without them means the tool's output changed, which the
# table says, where for the others a clean run has nothing to count.
COUNTED = frozenset({"test", "build", "e2e", "py"})
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
    return (
        Path(env.get("XDG_CACHE_HOME") or home / ".cache") / "agent-interface/check-all"
    )


# ---------------------------------------------------------------------------------------------------------------
# Locks. A held lock is an open file descriptor with flock(LOCK_EX). The lock belongs to the open file description,
# so it lasts until every process holding a copy of the descriptor has closed it or died.


class Held:
    """A flock held on a file until `release()` or the end of the process.

    Processes that inherited the descriptor keep the lock after `release()`, which closes the descriptor without
    unlocking it, so a check that outlives its run still holds its slot."""

    def __init__(self, fd, path):
        self.fd, self.path = fd, path
        self.info = {}

    @property
    def fds(self):
        return () if self.fd is None else (self.fd,)

    def write_info(self, info):
        self.info = dict(info)
        os.ftruncate(self.fd, 0)
        os.pwrite(self.fd, json.dumps(self.info).encode(), 0)

    def update_info(self, **changes):
        self.write_info({**self.info, **changes})

    def release(self):
        if self.fd is None:
            return
        try:
            os.ftruncate(self.fd, 0)
        finally:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release()


class HeldPorts:
    """The individual locks for an app port and its adjacent control port."""

    def __init__(self, app, control):
        self.locks = (app, control)

    @property
    def fds(self):
        return tuple(fd for held in self.locks for fd in held.fds)

    def write_info(self, info):
        for held in self.locks:
            held.write_info(info)

    def update_info(self, **changes):
        for held in self.locks:
            held.update_info(**changes)

    def release(self):
        try:
            self.locks[0].release()
        finally:
            self.locks[1].release()


def try_lock(path):
    """The lock on `path`, or None when another process holds it. The descriptor is not inherited by a child unless
    the caller passes it on, as `run_process` does for the check it runs."""
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
        return "another run, or a process a run left behind"
    seconds = max(0, int(now - info.get("since", now)))
    return f"{info.get('check', '?')} in {info.get('worktree', '?')} (pid {info.get('pid', '?')}, {seconds}s)"


def acquire_slot(
    directory,
    slots,
    info,
    timeout,
    poll=0.25,
    note=None,
    clock=time.monotonic,
    sleep=time.sleep,
):
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
        holders = ", ".join(
            describe_holder(read_info(directory / f"heavy-{index}.lock"), time.time())
            for index in range(slots)
        )
        if waited >= timeout:
            raise LockTimeout(
                f"Gave up after {int(waited)}s waiting for a heavy slot; {slots} in use by {holders}. Raise --lock-timeout or CHECK_ALL_HEAVY_SLOTS."
            )
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


def pick_e2e_port(
    directory, seed, requested=None, base=PORT_BASE, pairs=PORT_PAIRS, bindable=can_bind
):
    """Lock a free app port and control port pair for the browser suite. Returns (HeldPorts, port).

    With `requested` (the caller's own E2E_PORT) only that pair is considered, and a busy one is an error rather
    than a quiet move to another port. Each number has its own lock because requested pairs may overlap.
    Both descriptors stay with the suite, and both are released together.
    """
    candidates = [requested] if requested else port_candidates(seed, base, pairs)
    busy = []
    for port in candidates:
        app = try_lock(directory / f"e2e-port-{port}.lock")
        if not app:
            busy.append(f"{port} (locked by another check-all)")
            continue
        try:
            control = try_lock(directory / f"e2e-port-{port + 1}.lock")
        except BaseException:
            app.release()
            raise
        if not control:
            app.release()
            busy.append(f"{port} (locked by another check-all)")
            continue
        held = HeldPorts(app, control)
        try:
            taken = [number for number in (port, port + 1) if not bindable(number)]
            if not taken:
                held.write_info(
                    {"pid": os.getpid(), "port": port, "since": time.time()}
                )
                return held, port
        except BaseException:
            held.release()
            raise
        held.release()
        busy.append(f"{port} (port {taken[0]} is in use)")

    if requested:
        raise Refusal(
            f"E2E_PORT={requested} is not usable: {busy[0]}. Unset E2E_PORT to let check-all choose, or free that port and the next one."
        )
    raise Refusal(
        f"No free app and control port pair in {base}-{base + 2 * pairs - 1}."
    )


# ---------------------------------------------------------------------------------------------------------------
# node_modules.


def _unquote_yaml_key(raw):
    key = raw.strip()
    if len(key) >= 2 and key[0] == key[-1] and key[0] in ("'", '"'):
        return key[1:-1]
    return key


def _split_pkg_key(key):
    base = key.split("(", 1)[0]
    at = base.rfind("@")
    if at <= 0:
        return base, ""
    return base[:at], base[at + 1 :]


def parse_pnpm_lock(text):
    """Parse pnpm-lock.yaml (v9) package keys and optionality using the standard library."""
    has_version = False
    section = None
    current_pkg = None
    current_snap = None
    packages = {}
    optional_snaps = set()
    for line in text.splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if indent == 0:
            if stripped.startswith("lockfileVersion:"):
                value = stripped.split(":", 1)[1].strip()
                if not value:
                    raise ValueError("empty lockfileVersion")
                has_version = True
                section = None
            elif stripped.endswith(":"):
                section = stripped[:-1]
            else:
                section = None
            current_pkg = None
            current_snap = None
            continue
        if section == "packages":
            if indent == 2 and stripped.endswith(":"):
                current_pkg = _unquote_yaml_key(stripped[:-1])
                packages[current_pkg] = {"optional": False}
            elif indent == 4 and current_pkg is not None:
                if stripped.startswith(("os:", "cpu:", "libc:")):
                    packages[current_pkg]["optional"] = True
        elif section == "snapshots":
            if indent == 2 and stripped.endswith(":"):
                current_snap = _unquote_yaml_key(stripped[:-1]).split("(", 1)[0]
            elif (
                indent == 4
                and current_snap is not None
                and stripped == "optional: true"
            ):
                optional_snaps.add(current_snap)
    if not has_version:
        raise ValueError("not a pnpm lockfile (missing lockfileVersion)")
    for key in optional_snaps:
        if key in packages:
            packages[key]["optional"] = True
    return {"packages": packages}


def lock_drift(lock, installed):
    """Differences between pnpm-lock.yaml's packages and the hidden lockfile pnpm wrote at install time.

    A package the lock lists but the install lacks is fine when it is optional: pnpm leaves out the binaries for
    other platforms.
    """
    wanted, present = lock.get("packages", {}), installed.get("packages", {})
    wanted_by_name = {}
    for key in wanted:
        name, version = _split_pkg_key(key)
        wanted_by_name.setdefault(name, set()).add(version)
    problems = []
    reported_names = set()
    for key in present:
        if key not in wanted:
            name, version = _split_pkg_key(key)
            wanted_versions = wanted_by_name.get(name, set())
            if len(wanted_versions) == 1:
                problems.append(
                    f"{name} is {version} but pnpm-lock.yaml has {next(iter(wanted_versions))}"
                )
                reported_names.add(name)
            else:
                problems.append(f"{key} is installed but not in pnpm-lock.yaml")
    for key, entry in wanted.items():
        name, _ = _split_pkg_key(key)
        if (
            key not in present
            and not entry.get("optional")
            and name not in reported_names
        ):
            problems.append(f"{key} is in pnpm-lock.yaml but not installed")
    return problems


def check_install(root):
    """Refuse when node_modules is missing or older than pnpm-lock.yaml. Returns warnings to print."""
    modules = root / "node_modules"
    fix = "Fix: pnpm install --frozen-lockfile"
    if not modules.exists():
        where = (
            f" (a symlink to {os.readlink(modules)}, which does not exist)"
            if modules.is_symlink()
            else ""
        )
        raise Refusal(f"node_modules is missing{where}. {fix}")
    installed_path = modules / ".pnpm/lock.yaml"
    if not installed_path.is_file():
        raise Refusal(
            f"node_modules has no .pnpm/lock.yaml, so pnpm did not install it. {fix}"
        )
    try:
        lock = parse_pnpm_lock((root / "pnpm-lock.yaml").read_text())
        installed = parse_pnpm_lock(installed_path.read_text())
    except (OSError, ValueError) as error:
        raise Refusal(
            f"Could not read the lockfiles to compare them ({error}). {fix}"
        ) from error
    drift = lock_drift(lock, installed)
    if drift:
        shown = "; ".join(drift[:3]) + (
            f"; and {len(drift) - 3} more" if len(drift) > 3 else ""
        )
        raise Refusal(
            f"pnpm-lock.yaml changed since node_modules was installed: {shown}. {fix}"
        )
    if modules.is_symlink():
        return [
            f"node_modules is a symlink to {os.readlink(modules)}. It matches pnpm-lock.yaml, but a shared install lets"
            " the other checkout change what this one tests; run pnpm install --frozen-lockfile here to own one."
        ]
    return []


def check_node(root, env=None):
    """Refuse when the node on PATH is outside package.json's engines, as the test suite itself would."""
    script = (
        "import { readFileSync } from 'node:fs'; import { satisfiesEngine } from './scripts/node-engine.mjs';"
        "const range = JSON.parse(readFileSync('package.json', 'utf8')).engines.node;"
        "console.log(JSON.stringify({ ok: satisfiesEngine(process.version, range), version: process.version, range }));"
    )
    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as error:
        raise Refusal(
            'node is not on PATH. Fix: export PATH="$HOME/.local/share/fnm:$PATH"; eval "$(fnm env)"'
        ) from error
    if result.returncode != 0:
        raise Refusal(
            f"node could not read scripts/node-engine.mjs: {result.stderr.strip()[-300:]}"
        )
    info = json.loads(result.stdout)
    if not info["ok"]:
        wanted = (
            (root / ".node-version").read_text().strip()
            if (root / ".node-version").is_file()
            else info["range"]
        )
        raise Refusal(
            f"node {info['version']} is outside this repository's supported range ({info['range']}). Fix: fnm use {wanted}"
        )


# ---------------------------------------------------------------------------------------------------------------
# ruff.


def pinned_ruff(root):
    """The ruff version CI installs, from .github/requirements-ci.txt, so the pin has one home."""
    text = (root / ".github/requirements-ci.txt").read_text()
    match = re.search(r"^ruff==(\S+)\s*$", text, re.MULTILINE)
    if not match:
        raise Refusal(
            "Could not find a `ruff==VERSION` line in .github/requirements-ci.txt."
        )
    return match.group(1)


def ruff_version(executable, env=None):
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )
    except OSError:
        return None
    match = (
        re.fullmatch(r"ruff (\S+)", result.stdout.strip())
        if result.returncode == 0
        else None
    )
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
            raise Refusal(
                f"Refusing the cached ruff at {cached}: it reports {found}, and this repository pins {wanted}. Fix: rm -rf {venv}"
            )
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
            note(
                f"installing ruff=={wanted} into {venv} once ({'; '.join(seen) or 'none on PATH'})"
            )
        shutil.rmtree(venv, ignore_errors=True)
        try:
            for argv in (
                [bootstrap_python, "-m", "venv", str(venv)],
                [
                    str(venv / "bin/pip"),
                    "install",
                    "--disable-pip-version-check",
                    "--quiet",
                    f"ruff=={wanted}",
                ],
            ):
                result = subprocess.run(
                    argv, capture_output=True, text=True, check=False, env=env
                )
                if result.returncode != 0:
                    tail_text = (result.stderr or result.stdout).strip()[-400:]
                    raise Refusal(
                        f"Could not install ruff=={wanted} ({' '.join(argv[:3])} failed: {tail_text}). Fix: put ruff {wanted} on PATH, for example pip install ruff=={wanted}."
                    )
            found = ruff_version(cached, env)
            if found != wanted:
                raise Refusal(
                    f"The installed ruff reports {found}, and this repository pins {wanted}; refusing to use it."
                )
            done.write_text(found + "\n")
        except BaseException:
            shutil.rmtree(venv, ignore_errors=True)
            raise
    return str(cached)


# ---------------------------------------------------------------------------------------------------------------
# Where WebKit runs.

# Playwright starts the browser in a process group of its own, which stopping Node's group does not reach, so the
# probe hands the launch Playwright's own timeout: when it expires, Playwright kills the browser's group itself,
# even one paused at launch. Node then exits as soon as the answer is written instead of lingering.
WEBKIT_LAUNCH_TIMEOUT = 45
WEBKIT_PROBE = f"""
import {{ webkit }} from "@playwright/test";
let message = null;
try {{
  await (await webkit.launch({{ timeout: {WEBKIT_LAUNCH_TIMEOUT * 1000} }})).close();
}} catch (error) {{
  message = String(error?.message ?? error);
}}
process.stdout.write(JSON.stringify({{ ok: message === null, message }}) + "\\n", () => process.exit(0));
"""
# The probe's own limit, for a Node that hangs outside the launch.
WEBKIT_PROBE_TIMEOUT = 60


def first_sentence(message):
    """Playwright's launch error without its box drawing and `browserType.launch:` prefix, to its first full stop."""
    text = " ".join(re.sub(r"[╔╗╚╝║═]", " ", message).split())
    text = re.sub(r"^browserType\.launch:\s*", "", text)
    match = re.match(r"(.+?\.)(\s|$)", text)
    return (match.group(1) if match else text)[:300]


# How long a probe that timed out gets to stop the browser it launched after SIGINT before its group is killed.
WEBKIT_PROBE_GRACE = 5.0


def webkit_failure(
    root, env=None, timeout=WEBKIT_PROBE_TIMEOUT, grace=WEBKIT_PROBE_GRACE
):
    """Why WebKit cannot start on this host, or None when it starts. It launches the browser once, as a test would.

    Node runs in a process group of its own, which is stopped once Node is done, every time: SIGINT, so Playwright
    closes a browser it still has, then SIGKILL after `grace` for anything left in the group. A Node that hangs
    is stopped the same way at `timeout`. The browser's own group is left to Playwright's launch timeout (see
    WEBKIT_PROBE); if WebKit hangs past it as well, one idle browser process can be left behind.

    `grace` is waited out only when something in the group ignores SIGINT."""
    process = subprocess.Popen(
        ["node", "--input-type=module", "-e", WEBKIT_PROBE],
        cwd=root,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        stop_group(process, grace)
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.communicate(timeout=1)
        return f"it did not start within {timeout}s"
    except BaseException:
        stop_group(process, grace)
        raise
    # A child that closed its output can outlive Node in the group.
    stop_group(process, grace)
    try:
        info = json.loads(stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        return f"the launch check failed: {(stderr or stdout).strip()[-300:]}"
    return None if info.get("ok") else first_sentence(str(info.get("message")))


def playwright_image(root):
    """Playwright's image for the installed @playwright/test. tests/workflows.test.ts reads the same file."""
    path = root / "node_modules/@playwright/test/package.json"
    try:
        version = json.loads(path.read_text())["version"]
    except (OSError, ValueError, KeyError) as error:
        raise Refusal(
            f"Could not read the @playwright/test version from {path} ({error}). Fix: pnpm install --frozen-lockfile"
        ) from error
    return f"mcr.microsoft.com/playwright:v{version}-noble"


def find_podman(env=None):
    """podman from PATH, or None. Docker is not used: a rootful container outlives a killed run, since docker has no
    --timeout, and rootless docker maps --user to a subordinate ID that cannot write the checkout."""
    return shutil.which("podman", path=(os.environ if env is None else env).get("PATH"))


def container_command(podman, root, image, name, timeout, argv):
    """`argv` in `image` with the checkout mounted at its own path, as this user, so the files the suite writes stay
    this user's. E2E_PORT and NO_COLOR come through from the environment the command runs in. --timeout ends a
    container that check-all, killed by SIGKILL, could not remove."""
    return [
        podman, "run", "--rm", "--init", "--name", name, f"--timeout={int(timeout) + 60}",
        "--userns=keep-id", "--security-opt", "label=disable", "--ipc=host",
        "-v", f"{root}:{root}", "-w", str(root),
        "-e", "HOME=/tmp", "-e", "E2E_PORT", "-e", "NO_COLOR",
        image, *argv,
    ]  # fmt: skip


REMOVE_TIMEOUT = 30


def remove_container(podman, name):
    """Remove the container, running or not. Returns None once it is gone, including when it already removed itself,
    or why podman could not remove it."""
    try:
        result = subprocess.run(
            [podman, "rm", "--force", "--ignore", "--time", "5", name],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            timeout=REMOVE_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return f"podman rm did not finish within {REMOVE_TIMEOUT}s"
    except OSError as error:
        return f"podman rm could not run: {error}"
    if result.returncode:
        return f"podman rm exited {result.returncode}: {(result.stderr or result.stdout).strip()[-300:]}"
    return None


# ---------------------------------------------------------------------------------------------------------------
# Whether the Python suite is worth running.


# Beyond .py files: the directories whose files the Python tests run or read. src/hermes and scripts/ hold the code
# under test, .agents/tools holds the tools and shell scripts the tests run, src/shared holds the TypeScript and
# JSON the voice, delegation and qualification tests read, and public/voice-previews is listed by the voice test.
# tests/check_all_test.py scans the Python tests and fails when one reads a path outside this list, for the reads it
# can see: a literal path joined to a base name defined from `Path(__file__)` (in the file or in `support.py`), a
# `load_source` argument, a literal glob, or a relative literal given to `open` or `Path(...).read_text()`. A path
# that is computed at run time is not seen, so a test that builds one is on its author to list the directory here.
PYTHON_INPUT_DIRS = (
    "scripts/",
    ".agents/tools/",
    "src/shared/",
    "public/voice-previews/",
)
PYTHON_INPUTS = "Python or a file the Python tests read"


def python_touched(paths):
    return any(
        path.endswith(".py") or path.startswith(PYTHON_INPUT_DIRS) for path in paths
    )


def changed_paths(root, base):
    """Paths changed on this branch since it left `base`, plus uncommitted and untracked ones. None if git cannot say.

    Renames are listed as a delete and an add, so moving a Python file away still counts as touching Python."""

    def lines(*argv):
        result = subprocess.run(
            ["git", *argv], cwd=root, capture_output=True, text=True, check=False
        )
        return (
            None
            if result.returncode != 0
            else [part for part in result.stdout.split("\0") if part]
        )

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
        return True, f"the diff against {base} touches {PYTHON_INPUTS}"
    return False, f"no changes to {PYTHON_INPUTS} against {base}"


# ---------------------------------------------------------------------------------------------------------------
# Counts each tool reports.


def numbers(line):
    """{'passed': 3, 'failed': 1} from text like '1 failed | 3 passed (4)'."""
    return {
        label: int(count)
        for count, label in re.findall(
            r"(\d+) (passed|failed|skipped|todo|flaky|interrupted|did not run)", line
        )
    }


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
        for label in (
            "passed",
            "failed",
            "flaky",
            "skipped",
            "interrupted",
            "did not run",
        ):
            match = re.search(rf"^\s*(\d+) {label}\b", text, re.MULTILINE)
            if match:
                counts[label.replace(" ", "_")] = int(match.group(1))
        if counts:
            counts["tests"] = sum(counts.values())
    elif check == "py":
        match = re.search(
            r"^(\d+) passed, (\d+) skipped, (\d+) failed in ", text, re.MULTILINE
        )
        if match:
            passed, skipped, failed = map(int, match.groups())
            counts.update(
                files=passed + skipped + failed,
                passed=passed,
                skipped=skipped,
                failed=failed,
            )
    elif check == "build":
        match = re.search(r"✓ (\d+) modules transformed", text)
        if match:
            counts["modules"] = int(match.group(1))
    elif check == "lint":
        # oxlint prints one `file:line:col: warning|error rule: message` line per problem when piped, and no total.
        problems = re.findall(r"^\S+:\d+:\d+: (warning|error)\b", text, re.MULTILINE)
        if problems:
            counts.update(
                errors=problems.count("error"), warnings=problems.count("warning")
            )
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
        parts = [
            plural(counts.get("files", 0), "file"),
            plural(counts["tests"], "test"),
        ] + extras(("tests_failed", "failed"), ("tests_skipped", "skipped"))
    elif check == "e2e" and "tests" in counts:
        parts = [plural(counts["tests"], "test")] + extras(
            ("failed", "failed"), ("flaky", "flaky"), ("skipped", "skipped")
        )
    elif check == "py" and "files" in counts:
        parts = [plural(counts["files"], "file")] + extras(
            ("failed", "failed"), ("skipped", "skipped")
        )
    elif check == "build" and "modules" in counts:
        parts = [plural(counts["modules"], "module")]
    elif check in ("typecheck", "lint", "ruff") and (
        counts.get("errors") or counts.get("warnings")
    ):
        parts = (
            [plural(counts["errors"], "error")] if counts.get("errors") else []
        ) + ([plural(counts["warnings"], "warning")] if counts.get("warnings") else [])
    return ", ".join(parts)


# ---------------------------------------------------------------------------------------------------------------
# Running one check.


class Result:
    """`note` is the table's last cell when there are no counts, such as why a check was skipped.
    `detail` is the output tail printed under a failure, and `log` is where the full output went."""

    def __init__(
        self,
        name,
        status,
        queued=0.0,
        seconds=0.0,
        counts=None,
        note="",
        detail="",
        log=None,
        check=None,
    ):
        self.name, self.status, self.queued, self.seconds = (
            name,
            status,
            queued,
            seconds,
        )
        self.counts, self.note, self.detail, self.log = counts or {}, note, detail, log
        # The check a row belongs to, which says how to read its counts. A step's row is named apart from it.
        self.check = check or name
        # Something a person must act on that the result itself does not show, such as a container left running.
        self.warning = None
        # The output was cut off while another process still held it, so a summary and its counts may be missing.
        self.cut_short = False


# How long a stopped check gets to shut itself down after SIGINT before its group is killed.
STOP_GRACE = 10.0
# How long the output of a stopped check is read after the stop, for a pipe that a process outside the group holds.
OUTPUT_GRACE = 5.0


def signal_group(pgid, number):
    try:
        os.killpg(pgid, number)
    except (ProcessLookupError, PermissionError):
        pass


def group_alive(pgid):
    """Whether any process is left in the group. A leader that has exited but was not reaped still counts."""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


def wait_for_group(process, seconds):
    """Reap the group's leader and wait up to `seconds` for the rest of the group to be gone. True when it is."""
    deadline = time.monotonic() + seconds
    while True:
        process.poll()
        if not group_alive(process.pid):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def stop_group(process, grace=None):
    """Stop the check's process group, returning once it is gone: SIGINT first, as Ctrl-C would send it, then SIGKILL
    for whatever is left after `grace` seconds. SIGINT is how Playwright and vitest shut down cleanly, and it is the
    only thing that reaches the web server Playwright starts in a process group of its own. An interrupt that arrives
    during the wait skips the rest of it."""
    signal_group(process.pid, signal.SIGINT)
    try:
        wait_for_group(process, STOP_GRACE if grace is None else grace)
    finally:
        if group_alive(process.pid):
            signal_group(process.pid, signal.SIGKILL)
            wait_for_group(process, 5)


# Node's libuv marks descriptors 0 to 15 close-on-exec at startup, so those are not passed on to its children.
NODE_KEEPS_BELOW = 16


def run_process(
    argv, cwd, env, log_path, timeout, verbose, inherit=(), on_start=None, on_stop=None
):
    """Run `argv` in its own process group, saving its output. Returns (returncode or None on timeout, output, and
    whether the output was cut short because another process still held the pipe).

    The descriptors in `inherit` (the lock files) go to the child, so the locks last as long as it does, even if
    this process is killed. They must be below 16: Node keeps those from its own children, so only the pnpm wrapper
    holds the locks, where a higher descriptor reaches every process in the suite tree (see the module docstring).
    `on_start(pid)` runs once the child exists, for a caller that records who now holds the locks. `on_stop()` runs
    after a timeout or an interrupt has stopped the group, for what the group does not contain, such as a container
    that holds the output open after its client is gone."""
    too_high = [fd for fd in inherit if fd >= NODE_KEEPS_BELOW]
    if too_high:
        raise RuntimeError(
            f"Lock descriptors {too_high} are {NODE_KEEPS_BELOW} or higher, so Node would pass them to every process in the suite; "
            "main() closes inherited descriptors above 2 so the locks land low."
        )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        start_new_session=True,
        pass_fds=tuple(inherit),
    )
    expired = threading.Event()
    stops = []

    def stop():
        stops.append(True)
        try:
            stop_group(process)
        finally:
            if on_stop:
                on_stop()

    def expire():
        expired.set()
        stop()

    chunks = []
    log = log_path.open("w")
    log_lock = threading.Lock()

    def read():
        for line in process.stdout:
            with log_lock:
                if log.closed:
                    return
                chunks.append(line)
                log.write(line)
                if verbose:
                    sys.stderr.write(line)

    # The output is read on its own thread. A process outside the check's group can hold the pipe open after the
    # check has exited or been stopped, such as a web server in a session of its own or a container whose client is
    # gone, so the output is read for at most OUTPUT_GRACE after either. Past that, the check counts as stopped: the
    # stop a timeout makes runs for what is left, and the locks are freed when this returns.
    reader = threading.Thread(target=read, daemon=True)
    timer = threading.Timer(timeout, expire)
    timer.start()
    try:
        if on_start:
            on_start(process.pid)
        reader.start()
        process.wait()
        reader.join(OUTPUT_GRACE)
    except BaseException:
        stop()
        raise
    finally:
        timer.cancel()
        timer.join()  # a timeout's stop finishes before the caller releases its locks
        if reader.ident is not None and reader.is_alive():
            if not stops:
                stop()
            reader.join(OUTPUT_GRACE)
        with log_lock:
            cut_short = reader.is_alive()
            if cut_short:
                note = f"\ncheck-all: stopped reading the output {OUTPUT_GRACE:g}s after the check ended; a process outside the check's group still holds it\n"
                chunks.append(note)
                log.write(note)
            # Closed here however the reading ended, so what the check printed is on disk.
            log.close()
        if not cut_short:
            process.stdout.close()
    return (
        None if expired.is_set() else process.returncode,
        "".join(chunks),
        cut_short,
    )


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
    labels = {
        "pass": "pass",
        "fail": "FAIL",
        "timeout": "TIMEOUT",
        "locked": "NOT QUEUED",
        "skip": "skipped",
    }
    rows = [("check", "result", "queued", "run", "counts")]
    for result in results:
        text = (
            describe_counts(result.check, result.counts)
            or result.note
            or (
                "counts unknown"
                if result.status == "pass" and result.check in COUNTED
                else "-"
            )
        )
        if result.cut_short:
            text = "output cut short" + (f": {text}" if text != "-" else "")
        rows.append(
            (
                result.name,
                labels[result.status],
                format_queued(result.queued),
                format_seconds(result.seconds) if result.status != "skip" else "-",
                text,
            )
        )
    widths = [max(len(row[column]) for row in rows) for column in range(4)]
    return "\n".join(
        "  ".join(cell.ljust(widths[column]) for column, cell in enumerate(row[:4]))
        + "  "
        + row[4]
        for row in rows
    )


# ---------------------------------------------------------------------------------------------------------------
# Choosing and running the battery.


def parse_names(value, option):
    names = [name for name in value.split(",") if name]
    unknown = [name for name in names if name not in CHECKS]
    if unknown or not names:
        raise Refusal(f"{option} takes names from {', '.join(CHECKS)}; got {value!r}.")
    return names


def build_parser():
    parser = argparse.ArgumentParser(
        prog="check-all",
        description="Run typecheck, lint, ruff, test, build, e2e and py, in that order.",
        epilog=f"Checks: {', '.join(CHECKS)}. Heavy (machine-wide slot): {', '.join(sorted(HEAVY))}.",
    )
    parser.add_argument(
        "--only", metavar="LIST", help="run only these checks, comma separated"
    )
    parser.add_argument(
        "--skip", metavar="LIST", help="leave out these checks, comma separated"
    )
    parser.add_argument(
        "--py",
        choices=PY_MODES,
        default="auto",
        help="auto runs py when the diff against --base touches Python or a file the Python tests read",
    )
    parser.add_argument(
        "--keep-going",
        "--continue",
        dest="keep_going",
        action="store_true",
        help="run the rest after a failure",
    )
    parser.add_argument(
        "--verbose", action="store_true", help="stream each check's output as it runs"
    )
    parser.add_argument(
        "--base",
        default="origin/main",
        help="ref the auto Python decision diffs against (default origin/main)",
    )
    parser.add_argument(
        "--heavy-slots",
        type=int,
        metavar="N",
        help="heavy suites allowed at once on this machine (default $CHECK_ALL_HEAVY_SLOTS or 1)",
    )
    parser.add_argument(
        "--lock-timeout",
        type=float,
        default=3600,
        metavar="SECONDS",
        help="how long to queue for a heavy slot (default 3600)",
    )
    parser.add_argument(
        "--check-timeout",
        type=float,
        default=1800,
        metavar="SECONDS",
        help="kill a check that runs longer (default 1800)",
    )
    return parser


def select(args):
    """The checks to run, in order, and whether py was named explicitly."""
    chosen = parse_names(args.only, "--only") if args.only else list(CHECKS)
    skipped = set(parse_names(args.skip, "--skip")) if args.skip else set()
    return [name for name in CHECKS if name in chosen and name not in skipped], bool(
        args.only and "py" in chosen
    )


def prune_logs(directory, keep, current):
    if directory.is_dir():
        old = sorted(
            (path for path in directory.iterdir() if path.is_dir() and path != current),
            key=lambda path: path.name,
        )
        for path in old[: max(0, len(old) - keep)]:
            shutil.rmtree(path, ignore_errors=True)


def plan_e2e(root, env, check_timeout, log):
    """The browser suite's steps: one on the host when WebKit starts here, else Chromium here and WebKit in a
    container. Refuses when WebKit cannot start and podman is absent, rather than skip it."""
    failure = webkit_failure(root, env)
    if failure is None:
        return [Step("e2e", ["pnpm", "run", "test:e2e"])]
    podman = find_podman(env)
    if not podman:
        raise Refusal(
            f"WebKit cannot start on this host: {failure.rstrip('.')}. podman is not on PATH to run it in"
            " Playwright's container, and check-all does not skip WebKit. Fix: install podman (on Fedora, sudo dnf"
            " install podman), or give the host what WebKit needs (pnpm exec playwright install webkit, and on Debian or"
            " Ubuntu sudo pnpm exec playwright install-deps webkit)."
        )
    image = playwright_image(root)
    container = f"check-all-webkit-{os.getpid()}"
    log(
        f"e2e: WebKit cannot start on this host: {failure.rstrip('.')}. Chromium runs here and WebKit in {image} under podman."
    )
    return [
        Step("e2e:chromium", ["pnpm", "run", "test:e2e", "--project=chromium"]),
        Step(
            "e2e:webkit (podman)",
            container_command(
                podman,
                root,
                image,
                container,
                check_timeout,
                ["./node_modules/.bin/playwright", "test", "--project=webkit"],
            ),
            container=(podman, container),
        ),
    ]


def run_battery(root, args, cache, log=None, env=None):
    """Run the checks. Returns (results, warnings). Preconditions are checked before anything runs."""
    log = log or (
        lambda message: print(f"check-all: {message}", file=sys.stderr, flush=True)
    )
    env = dict(os.environ if env is None else env)
    names, py_explicit = select(args)
    if not names:
        raise Refusal("Nothing to run after --only and --skip.")
    try:
        slots = (
            args.heavy_slots
            if args.heavy_slots is not None
            else int(env.get("CHECK_ALL_HEAVY_SLOTS") or 1)
        )
    except ValueError:
        raise Refusal(
            f"CHECK_ALL_HEAVY_SLOTS={env['CHECK_ALL_HEAVY_SLOTS']!r} must be a whole number."
        ) from None
    if slots < 1:
        raise Refusal("The heavy slot count must be at least 1.")

    warnings = []
    if names != ["ruff"]:
        check_node(root, env)
        warnings = check_install(root)
        for warning in warnings:
            log(f"warning: {warning}")
    ruff = find_ruff(root, cache, env, note=log) if "ruff" in names else None
    if (
        "e2e" in names
        and "build" not in names
        and not (root / "dist/client/index.html").is_file()
    ):
        raise Refusal(
            "e2e serves dist/client, which is not built. Fix: pnpm run build, or do not --skip build."
        )
    requested = None
    if "e2e" in names and env.get("E2E_PORT"):
        if not env["E2E_PORT"].isdigit() or not 1024 <= int(env["E2E_PORT"]) <= 65534:
            raise Refusal(
                f"E2E_PORT={env['E2E_PORT']!r} must be a whole number from 1024 to 65534."
            )
        requested = int(env["E2E_PORT"])
    # Decided before anything runs, so a host that can run no WebKit is refused up front.
    e2e_steps = plan_e2e(root, env, args.check_timeout, log) if "e2e" in names else []
    run_py, py_reason = False, ""
    if "py" in names:
        paths = (
            changed_paths(root, args.base)
            if args.py == "auto" and not py_explicit
            else []
        )
        run_py, py_reason = decide_py(args.py, paths, args.base, py_explicit)

    child_env = {**env, "NO_COLOR": "1"}
    commands = {
        "typecheck": ["pnpm", "run", "typecheck"],
        "lint": ["pnpm", "run", "lint"],
        "test": ["pnpm", "test"],
        "build": ["pnpm", "run", "build"],
        "py": ["pnpm", "run", "test:py"],
    }
    if ruff:
        commands["ruff"] = [ruff, "check", "."]
    steps = {name: [Step(name, argv)] for name, argv in commands.items()}
    steps["e2e"] = e2e_steps
    logs = (
        cache / "logs" / f"{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}-{root.name}"
    )
    prune_logs(cache / "logs", keep=30, current=logs)

    results, failed = [], {}

    def report(result):
        """Record a step's result and say how it went, as soon as it is known."""
        results.append(result)
        log(
            f"{result.name}: {result.status} in {format_seconds(result.seconds)}"
            + (
                f" after {format_seconds(result.queued)} queued"
                if result.queued >= 0.05
                else ""
            )
        )
        if result.status != "pass":
            failed[result.check] = result
            if result.detail:
                print(
                    f"\n--- {result.name}: last lines (full output: {result.log}) ---\n{result.detail}\n",
                    file=sys.stderr,
                    flush=True,
                )

    for index, name in enumerate(names, 1):
        if name == "py" and not run_py:
            results.append(Result(name, "skip", note=py_reason))
        elif NEEDS.get(name) in failed:
            results.append(Result(name, "skip", note=f"{NEEDS[name]} did not pass"))
        elif failed and not args.keep_going:
            results.append(Result(name, "skip", note="an earlier check failed"))
        else:
            log(
                f"[{index}/{len(names)}] {name}"
                + (f" ({py_reason})" if name == "py" else "")
            )
            run_one(
                root,
                name,
                steps[name],
                child_env,
                logs,
                cache,
                slots,
                args,
                requested,
                log,
                report,
            )
    return results, warnings


@dataclass
class Step:
    """One command of a check, with its own row in the table. A step with `container` set, as (runtime, name), runs
    in that container: it gets no lock descriptors, and check-all removes the container when the step ends."""

    label: str
    argv: list
    container: tuple | None = None


def step_result(
    name, step, code, output, cut_short, seconds, log_path, queued, timeout
):
    counts = parse_counts(name, output)
    if code is None:
        result = Result(
            step.label,
            "timeout",
            queued,
            seconds,
            counts,
            f"killed after {int(timeout)}s",
            f"killed after {int(timeout)}s\n{tail(output)}",
            log_path,
            name,
        )
    else:
        result = Result(
            step.label,
            "pass" if code == 0 else "fail",
            queued,
            seconds,
            counts,
            "",
            tail(output) if code else "",
            log_path,
            name,
        )
    result.cut_short = cut_short
    return result


def run_one(root, name, steps, env, logs, cache, slots, args, requested, log, report):
    """Run a check's steps in order, under one heavy slot and, for e2e, one port lease, and `report(Result)` for
    each step as it ends. The queue time goes on the first step's row."""
    held = port_lease = None
    queued = 0.0
    try:
        if name in HEAVY:
            try:
                held, queued = acquire_slot(
                    cache / "locks",
                    slots,
                    {"pid": os.getpid(), "check": name, "worktree": str(root)},
                    args.lock_timeout,
                    note=lambda message: log(f"{name}: {message}"),
                )
            except LockTimeout as error:
                report(
                    Result(
                        name,
                        "locked",
                        args.lock_timeout,
                        0.0,
                        note="gave up queueing for a heavy slot",
                        detail=str(error),
                    )
                )
                return
        if name == "e2e":
            port_lease, port = pick_e2e_port(cache / "locks", root, requested)
            env = {**env, "E2E_PORT": str(port)}
            log(f"e2e: app port {port}, control port {port + 1}")
        leases = [lease for lease in (held, port_lease) if lease]

        def name_the_child(pid):
            # The lock outlives this process when it is killed, so it names the check that keeps it, not this run.
            for lease in leases:
                lease.update_info(pid=pid)

        for step in steps:
            if len(steps) > 1:
                log(f"{step.label}: started")
            started = time.monotonic()
            left_running = None
            log_path = logs / f"{step.label.split(' ')[0].replace(':', '-')}.log"
            try:
                code, output, cut_short = run_process(
                    step.argv,
                    root,
                    env,
                    log_path,
                    args.check_timeout,
                    args.verbose,
                    inherit=()
                    if step.container
                    else [fd for lease in leases for fd in lease.fds],
                    on_start=name_the_child,
                    on_stop=functools.partial(remove_container, *step.container)
                    if step.container
                    else None,
                )
            finally:
                if step.container:
                    podman, container = step.container
                    problem = remove_container(podman, container)
                    if problem:
                        left_running = f"could not remove the container {container} ({problem}). Remove it with: {podman} rm --force {container}"
                        log(f"{step.label}: {left_running}")
            result = step_result(
                name,
                step,
                code,
                output,
                cut_short,
                time.monotonic() - started,
                log_path,
                queued if step is steps[0] else 0.0,
                args.check_timeout,
            )
            result.warning = left_running
            report(result)
    except Refusal as error:
        report(Result(name, "fail", queued, 0.0, note="refused", detail=str(error)))
    finally:
        for lease in (port_lease, held):
            if lease:
                lease.release()


class Interrupted(BaseException):
    pass


def close_inherited_descriptors():
    """Close every descriptor above 2, so the locks this process opens next get the lowest numbers (3 and 4)."""
    try:
        highest = os.sysconf("SC_OPEN_MAX")
    except (ValueError, OSError):
        highest = 4096
    os.closerange(3, max(highest, 4096))


def main(argv, root=ROOT, cache=None, close_inherited=True):
    """Run the command. `close_inherited` closes every inherited descriptor above 2 first, as the module docstring
    explains; only a caller that lives on in the same process (a test) turns it off."""
    if close_inherited:
        close_inherited_descriptors()
    cache = cache or cache_dir()

    def interrupt(signum, _frame):
        raise Interrupted(signal.Signals(signum).name)

    previous = {
        number: signal.signal(number, interrupt)
        for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
    }
    started = time.monotonic()
    try:
        args = build_parser().parse_args(argv)
        results, warnings = run_battery(root, args, cache)
    except Refusal as error:
        print(f"check-all: refusing to run. {error}", file=sys.stderr)
        return EXIT_USAGE
    except Interrupted as error:
        print(
            f"check-all: stopped by {error}; its checks were killed and its locks released",
            file=sys.stderr,
        )
        return 130
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
    print("\n" + render_table(results))
    for warning in warnings + [result.warning for result in results if result.warning]:
        print(f"\nWarning: {warning}")
    bad = [
        result.name
        for result in results
        if result.status in ("fail", "timeout", "locked")
    ]
    ran = [result for result in results if result.status != "skip"]
    verdict = "FAILED: " + ", ".join(bad) if bad else f"All {len(ran)} checks passed"
    print(
        f"\n{verdict} ({format_seconds(time.monotonic() - started)} total, {format_seconds(sum(r.queued for r in ran))} of it queued for heavy slots)"
    )
    if any(result.status == "locked" for result in results):
        return EXIT_LOCK_TIMEOUT
    return 1 if bad else 0
