"""check-all: the ports, the machine-wide lock, the node_modules and ruff guards, the Python decision, the
summary parsing and the whole command, run against real processes, real sockets, real git and fake executables
on PATH. Nothing here touches the network or the real check battery."""
import ast
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".agents/tools"
sys.path.insert(0, str(TOOLS))
import check_all  # noqa: E402

# Test ports sit away from the tool's own range, and each test process gets its own window of them, so test
# processes started together (CI shards, an agent running the file twice) never fight over a real socket.
BASE, PAIRS = 28000 + (os.getpid() % 140) * 32, 8


def script(path, body):
    path.write_text("#!" + sys.executable + "\n" + textwrap.dedent(body))
    path.chmod(0o700)
    return path


# A process that takes a lock, says so, and keeps it until stdin closes or it is killed.
HOLDER = """
import os, sys
sys.path.insert(0, sys.argv[1])
import check_all
from pathlib import Path
kind, directory = sys.argv[2], Path(sys.argv[3])
if kind == "slot":
    held, _ = check_all.acquire_slot(directory, int(sys.argv[4]), {"pid": os.getpid(), "check": sys.argv[5], "worktree": sys.argv[6]}, 5)
else:
    held, port = check_all.pick_e2e_port(directory, sys.argv[4], base=int(sys.argv[5]), pairs=int(sys.argv[6]))
    print(port, flush=True)
print("held", flush=True)
sys.stdin.read()
"""


class Holder:
    def __init__(self, case, *args):
        self.process = subprocess.Popen([sys.executable, "-I", "-c", HOLDER, str(TOOLS), *map(str, args)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True)
        case.addCleanup(self.stop)
        self.lines = []
        while not self.lines or self.lines[-1] != "held":
            line = self.process.stdout.readline()
            if not line:
                raise AssertionError("holder exited before holding: " + repr(self.lines))
            self.lines.append(line.strip())

    def release(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)

    def kill(self):
        self.process.kill()
        self.process.wait(timeout=5)

    def stop(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=5)
        for stream in (self.process.stdin, self.process.stdout):
            stream.close()


class TempCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()


class HeavySlotTest(TempCase):
    def info(self, check="test", worktree="/w/one"):
        return {"pid": os.getpid(), "check": check, "worktree": worktree}

    def test_second_process_waits_until_the_first_releases(self):
        holder = Holder(self, "slot", self.tmp, 1, "e2e", "/w/other")
        waits = []
        threading_release = threading.Timer(0.6, holder.release)
        threading_release.start()
        self.addCleanup(threading_release.cancel)
        held, waited = check_all.acquire_slot(self.tmp, 1, self.info(), 10, note=waits.append)
        self.addCleanup(held.release)
        self.assertGreaterEqual(waited, 0.5)
        self.assertEqual(len(waits), 1)
        self.assertIn("e2e in /w/other", waits[0])

    def test_a_holder_killed_without_cleanup_frees_the_slot_at_once(self):
        holder = Holder(self, "slot", self.tmp, 1, "py", "/w/other")
        with self.assertRaises(check_all.LockTimeout):
            check_all.acquire_slot(self.tmp, 1, self.info(), 0.2)
        holder.kill()
        held, waited = check_all.acquire_slot(self.tmp, 1, self.info(), 0.2)
        held.release()
        self.assertLess(waited, 0.2)

    def test_timeout_names_the_holder_and_the_knob(self):
        Holder(self, "slot", self.tmp, 1, "py", "/w/other")
        with self.assertRaises(check_all.LockTimeout) as raised:
            check_all.acquire_slot(self.tmp, 1, self.info(), 0.2)
        self.assertIn("py in /w/other", str(raised.exception))
        self.assertIn("CHECK_ALL_HEAVY_SLOTS", str(raised.exception))

    def test_two_slots_admit_two_runs_and_queue_the_third(self):
        Holder(self, "slot", self.tmp, 2, "test", "/w/a")
        Holder(self, "slot", self.tmp, 2, "py", "/w/b")
        with self.assertRaises(check_all.LockTimeout):
            check_all.acquire_slot(self.tmp, 2, self.info(), 0.2)

    def test_a_run_with_one_slot_does_not_use_a_second_slot_another_run_allows(self):
        Holder(self, "slot", self.tmp, 2, "test", "/w/a")
        with self.assertRaises(check_all.LockTimeout):
            check_all.acquire_slot(self.tmp, 1, self.info(), 0.2)

    def test_a_process_holding_a_copy_of_the_descriptor_keeps_the_slot_after_release(self):
        # run_process hands the descriptors to the suite. Releasing the run's own copy must not unlock them, or a
        # suite that outlives its run would stop holding its slot.
        held, _ = check_all.acquire_slot(self.tmp, 1, self.info(), 1)
        inherited = os.dup(held.fd)
        self.addCleanup(lambda: os.close(inherited) if inherited is not None else None)
        held.release()
        with self.assertRaises(check_all.LockTimeout) as raised:
            check_all.acquire_slot(self.tmp, 1, self.info(), 0.2)
        self.assertIn("a process a run left behind", str(raised.exception))
        os.close(inherited)
        inherited = None
        again, _ = check_all.acquire_slot(self.tmp, 1, self.info(), 0.2)
        again.release()

    def test_a_released_slot_leaves_no_stale_holder_for_the_next_waiter_to_read(self):
        held, _ = check_all.acquire_slot(self.tmp, 1, self.info(), 1)
        held.release()
        self.assertIsNone(check_all.read_info(self.tmp / "heavy-0.lock"))


class PortTest(TempCase):
    def listen(self, port):
        sock = socket.socket()
        self.addCleanup(sock.close)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
        sock.listen()

    def pick(self, seed="w", **kwargs):
        held, port = check_all.pick_e2e_port(self.tmp, seed, base=BASE, pairs=PAIRS, **kwargs)
        self.addCleanup(held.release)
        return port

    def test_a_free_pair_is_chosen_from_the_candidates_for_this_worktree(self):
        self.assertEqual(self.pick(), check_all.port_candidates("w", BASE, PAIRS)[0])

    def test_the_same_worktree_gets_the_same_start_and_different_worktrees_usually_do_not(self):
        self.assertEqual(check_all.port_candidates("w", BASE, PAIRS), check_all.port_candidates("w", BASE, PAIRS))
        starts = {check_all.port_candidates(f"/worktrees/{name}", BASE, PAIRS)[0] for name in "abcdefgh"}
        self.assertGreater(len(starts), 3)

    def test_candidates_are_disjoint_pairs_covering_the_whole_range(self):
        ports = check_all.port_candidates("w", BASE, PAIRS)
        self.assertEqual(sorted(ports), [BASE + 2 * index for index in range(PAIRS)])

    def test_a_busy_app_port_is_skipped(self):
        first = check_all.port_candidates("w", BASE, PAIRS)[0]
        self.listen(first)
        self.assertNotIn(self.pick(), (first, first + 1))

    def test_a_busy_control_port_skips_the_pair_though_the_app_port_is_free(self):
        first = check_all.port_candidates("w", BASE, PAIRS)[0]
        self.listen(first + 1)
        self.assertNotIn(first + 1, (chosen := self.pick(), chosen + 1))
        self.assertNotEqual(chosen, first)

    def test_a_pair_another_run_holds_is_skipped_even_though_nothing_is_listening_yet(self):
        # The window the lock closes: the other run has chosen its port but its server has not bound it.
        holder = Holder(self, "port", self.tmp, "w", BASE, PAIRS)
        theirs = int(holder.lines[0])
        mine = self.pick()
        self.assertNotEqual(mine, theirs)
        self.assertEqual(theirs, check_all.port_candidates("w", BASE, PAIRS)[0])

    def test_two_runs_that_start_together_get_different_pairs_that_share_no_port(self):
        first, second = Holder(self, "port", self.tmp, "w", BASE, PAIRS), Holder(self, "port", self.tmp, "w", BASE, PAIRS)
        a, b = int(first.lines[0]), int(second.lines[0])
        self.assertTrue({a, a + 1}.isdisjoint({b, b + 1}))

    def test_a_dead_runs_pair_can_be_chosen_again(self):
        holder = Holder(self, "port", self.tmp, "w", BASE, PAIRS)
        theirs = int(holder.lines[0])
        holder.kill()
        self.assertEqual(self.pick(), theirs)

    def test_no_pair_free_is_an_error_that_says_so(self):
        for port in check_all.port_candidates("w", BASE, 1):
            self.listen(port)
        with self.assertRaises(check_all.Refusal) as raised:
            check_all.pick_e2e_port(self.tmp, "w", base=BASE, pairs=1)
        self.assertIn("No free app and control port pair", str(raised.exception))

    def test_a_requested_port_is_used_when_free(self):
        self.assertEqual(self.pick(requested=BASE + 20), BASE + 20)

    def test_a_requested_port_that_is_busy_is_refused_rather_than_replaced(self):
        self.listen(BASE + 21)  # the control port
        with self.assertRaises(check_all.Refusal) as raised:
            check_all.pick_e2e_port(self.tmp, "w", requested=BASE + 20)
        self.assertIn(f"port {BASE + 21} is in use", str(raised.exception))

    def test_a_requested_port_another_run_holds_is_refused_with_that_reason(self):
        held, _ = check_all.pick_e2e_port(self.tmp, "w", requested=BASE + 20)
        self.addCleanup(held.release)
        with self.assertRaises(check_all.Refusal) as raised:
            check_all.pick_e2e_port(self.tmp, "w", requested=BASE + 20)
        self.assertIn("locked by another check-all", str(raised.exception))

    def test_binding_is_checked_for_real_on_loopback(self):
        self.assertTrue(check_all.can_bind(BASE + 30))
        self.listen(BASE + 30)
        self.assertFalse(check_all.can_bind(BASE + 30))


class NodeModulesTest(TempCase):
    def lock(self, packages):
        return {"packages": {"": {"name": "app"}, **packages}}

    def test_drift_cases(self):
        wanted = self.lock({"node_modules/a": {"version": "1.0.0"}, "node_modules/native": {"version": "2.0.0", "optional": True}})
        cases = {
            "identical, with the other platform's optional binary left out": (wanted, self.lock({"node_modules/a": {"version": "1.0.0"}}), []),
            "a version moved": (wanted, self.lock({"node_modules/a": {"version": "0.9.0"}}), ["node_modules/a is 0.9.0 but package-lock.json has 1.0.0"]),
            "a package was added to the lock": (self.lock({"node_modules/a": {"version": "1.0.0"}, "node_modules/b": {"version": "1.0.0"}}),
                                               self.lock({"node_modules/a": {"version": "1.0.0"}}), ["node_modules/b is in package-lock.json but not installed"]),
            "a package was removed from the lock": (self.lock({}), self.lock({"node_modules/a": {"version": "1.0.0"}}), ["node_modules/a is installed but not in package-lock.json"]),
        }
        for name, (lock, installed, expected) in cases.items():
            with self.subTest(name):
                self.assertEqual(check_all.lock_drift(lock, installed), expected)

    def checkout(self, lock=None, installed=None, link=False):
        root = self.tmp / "checkout"
        root.mkdir(exist_ok=True)
        lock = lock or self.lock({"node_modules/a": {"version": "1.0.0"}})
        (root / "package-lock.json").write_text(json.dumps(lock))
        if installed is not False:
            home = (self.tmp / "shared") if link else root
            (home / "node_modules").mkdir(parents=True, exist_ok=True)
            (home / "node_modules/.package-lock.json").write_text(json.dumps(installed or lock))
            if link:
                (root / "node_modules").symlink_to(home / "node_modules")
        return root

    def refusal(self, root):
        with self.assertRaises(check_all.Refusal) as raised:
            check_all.check_install(root)
        return str(raised.exception)

    def test_a_missing_node_modules_is_refused_with_the_fix(self):
        message = self.refusal(self.checkout(installed=False))
        self.assertIn("node_modules is missing", message)
        self.assertIn("npm ci", message)

    def test_a_symlink_to_nothing_is_called_missing_and_says_where_it_pointed(self):
        root = self.checkout(installed=False)
        (root / "node_modules").symlink_to(self.tmp / "gone")
        message = self.refusal(root)
        self.assertIn("node_modules is missing", message)
        self.assertIn(str(self.tmp / "gone"), message)

    def test_an_install_npm_did_not_make_is_refused(self):
        root = self.checkout()
        (root / "node_modules/.package-lock.json").unlink()
        self.assertIn("did not install it", self.refusal(root))

    def test_a_lockfile_changed_since_install_is_refused_with_the_package_and_the_fix(self):
        root = self.checkout(installed=self.lock({"node_modules/a": {"version": "0.9.0"}}))
        message = self.refusal(root)
        self.assertIn("package-lock.json changed since node_modules was installed", message)
        self.assertIn("node_modules/a is 0.9.0", message)
        self.assertIn("npm ci", message)

    def test_a_long_drift_list_is_cut_short_with_a_count(self):
        installed = self.lock({f"node_modules/p{index}": {"version": "1.0.0"} for index in range(6)})
        self.assertIn("and 3 more", self.refusal(self.checkout(lock=self.lock({}), installed=installed)))

    def test_an_unreadable_lockfile_is_refused_not_crashed_on(self):
        root = self.checkout()
        (root / "package-lock.json").write_text("{not json")
        self.assertIn("Could not read the lockfiles", self.refusal(root))

    def test_a_matching_plain_install_passes_without_a_warning(self):
        self.assertEqual(check_all.check_install(self.checkout()), [])

    def test_a_symlinked_node_modules_that_matches_runs_with_a_warning_naming_the_target(self):
        warnings = check_all.check_install(self.checkout(link=True))
        self.assertEqual(len(warnings), 1)
        self.assertIn("symlink", warnings[0])
        self.assertIn(str(self.tmp / "shared/node_modules"), warnings[0])

    def test_a_symlinked_node_modules_from_a_checkout_with_another_lock_is_refused(self):
        root = self.checkout(installed=self.lock({"node_modules/a": {"version": "9.9.9"}}), link=True)
        self.assertIn("package-lock.json changed", self.refusal(root))


class FakeBootstrap(TempCase):
    """A python3 that "makes" a venv whose pip "installs" a ruff reporting a chosen version, with no network."""

    def setUp(self):
        super().setUp()
        self.calls = self.tmp / "bootstrap-calls"
        pip = script(self.tmp / "pip-template", """
            import os, sys
            from pathlib import Path
            version = os.environ.get("FAKE_INSTALLS") or sys.argv[-1].split("==")[1]
            ruff = Path(__file__).resolve().parent / "ruff"
            ruff.write_text(f"#!{sys.executable}\\nprint('ruff {version}')\\n")
            ruff.chmod(0o700)
        """)
        self.python = script(self.tmp / "fake-python", """
            import os, shutil, sys
            from pathlib import Path
            with open("@CALLS@", "a") as log:
                log.write(" ".join(sys.argv[1:]) + "\\n")
            if sys.argv[1:3] != ["-m", "venv"]:
                print("unexpected fake python call", sys.argv, file=sys.stderr); sys.exit(97)
            if os.environ.get("FAKE_VENV_FAILS"):
                print("no ensurepip", file=sys.stderr); sys.exit(1)
            bin = Path(sys.argv[3]) / "bin"; bin.mkdir(parents=True)
            shutil.copy("@PIP@", bin / "pip")
        """.replace("@CALLS@", str(self.calls)).replace("@PIP@", str(pip)))

    def made(self):
        return len(self.calls.read_text().splitlines()) if self.calls.exists() else 0


class RuffTest(FakeBootstrap):
    def setUp(self):
        super().setUp()
        (self.tmp / "repo/.github").mkdir(parents=True)
        (self.tmp / "repo/.github/requirements-ci.txt").write_text("pip-audit==2.10.1\nruff==0.17.3\n")
        self.root, self.cache = self.tmp / "repo", self.tmp / "cache"
        self.bin = self.tmp / "bin"
        self.bin.mkdir()

    def path_ruff(self, version):
        script(self.bin / "ruff", f"print('ruff {version}')\n")

    def find(self, **env):
        return check_all.find_ruff(self.root, self.cache, {"PATH": str(self.bin), **env}, bootstrap_python=str(self.python))

    def test_the_pin_comes_from_the_requirements_file_ci_installs(self):
        self.assertEqual(check_all.pinned_ruff(self.root), "0.17.3")

    def test_a_missing_pin_is_refused(self):
        (self.root / ".github/requirements-ci.txt").write_text("pip-audit==2.10.1\n")
        with self.assertRaisesRegex(check_all.Refusal, "ruff==VERSION"):
            check_all.pinned_ruff(self.root)

    def test_the_ruff_on_path_is_used_when_it_has_the_pinned_version(self):
        self.path_ruff("0.17.3")
        self.assertEqual(self.find(), str(self.bin / "ruff"))
        self.assertEqual(self.made(), 0)

    def test_a_ruff_on_path_of_another_version_is_never_run_and_the_pinned_one_comes_from_a_cached_venv(self):
        self.path_ruff("0.18.0")
        found = self.find()
        self.assertEqual(found, str(self.cache / "ruff-0.17.3/bin/ruff"))
        self.assertEqual(check_all.ruff_version(found), "0.17.3")
        self.assertEqual(self.made(), 1)

    def test_the_venv_is_made_once_and_reused_by_the_next_run(self):
        self.find()
        self.find()
        self.assertEqual(self.made(), 1)

    def test_an_install_that_yields_another_version_is_refused_and_leaves_no_venv(self):
        with self.assertRaisesRegex(check_all.Refusal, "reports 0.18.0, and this repository pins 0.17.3"):
            self.find(FAKE_INSTALLS="0.18.0")
        self.assertFalse((self.cache / "ruff-0.17.3").exists())

    def test_a_failed_venv_creation_is_refused_with_the_reason_and_a_manual_fix(self):
        with self.assertRaises(check_all.Refusal) as raised:
            self.find(FAKE_VENV_FAILS="1")
        self.assertIn("no ensurepip", str(raised.exception))
        self.assertIn("ruff==0.17.3", str(raised.exception))
        self.assertFalse((self.cache / "ruff-0.17.3").exists())

    def test_a_venv_left_half_built_by_a_dead_run_is_rebuilt_not_trusted(self):
        (self.cache / "ruff-0.17.3/bin").mkdir(parents=True)
        script(self.cache / "ruff-0.17.3/bin/ruff", "print('ruff 0.17.3')\n")  # no .complete mark
        self.assertEqual(check_all.ruff_version(self.find()), "0.17.3")
        self.assertEqual(self.made(), 1)

    def test_a_cached_venv_whose_ruff_changed_version_is_refused_with_the_fix(self):
        self.find()
        script(self.cache / "ruff-0.17.3/bin/ruff", "print('ruff 0.19.0')\n")
        with self.assertRaisesRegex(check_all.Refusal, r"reports 0\.19\.0.*rm -rf"):
            self.find()


class PythonDecisionTest(TempCase):
    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", *args],
                              cwd=self.tmp, check=True, capture_output=True, text=True).stdout

    def commit(self, name, text="x"):
        path = self.tmp / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        self.git("add", name)
        self.git("commit", "-m", name)

    def repo(self):
        self.git("init", "-q", "-b", "main")
        self.commit("README.md")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("checkout", "-q", "-b", "feature")

    def test_which_paths_count_as_python(self):
        cases = [
            ("a Python file", ["tests/x_test.py"], True), ("the Hermes add-on", ["src/hermes/journal.txt"], True),
            ("a script", ["scripts/build-worker.mjs"], True), ("a web-only change", ["src/App.tsx", "e2e/smoke.spec.ts", "package.json"], False),
            ("nothing", [], False), ("a name that only contains the directory", ["docs/scripts/readme.md", "src/hermesx/a.ts"], False),
            ("a tool the tests run", [".agents/tools/validate-ios.sh"], True), ("a shared file the tests read", ["src/shared/voice.ts"], True),
            ("the voice previews the voice test lists", ["public/voice-previews/nova.mp3"], True),
            ("neighbors of those inputs that no test reads", ["src/server/app.ts", "src/sharedx/a.ts", "public/icons/a.svg", "tests/app.test.ts"], False),
        ]
        for name, paths, expected in cases:
            with self.subTest(name):
                self.assertEqual(check_all.python_touched(paths), expected)

    def test_decisions(self):
        cases = [
            ("never wins over a Python diff", "never", ["a.py"], False, False), ("always runs on a web diff", "always", ["a.ts"], False, True),
            ("auto runs on a Python diff", "auto", ["a.py"], False, True), ("auto skips a web diff", "auto", ["a.ts"], False, False),
            ("auto runs when git cannot say", "auto", None, False, True), ("naming py in --only beats auto's skip", "auto", ["a.ts"], True, True),
            ("never still beats naming py", "never", ["a.py"], True, False),
        ]
        for name, mode, paths, explicit, expected in cases:
            with self.subTest(name):
                run, reason = check_all.decide_py(mode, paths, "origin/main", explicit)
                self.assertEqual(run, expected)
                self.assertTrue(reason)

    def test_the_reason_for_skipping_names_the_base_so_a_stale_ref_is_noticed(self):
        self.assertIn("origin/main", check_all.decide_py("auto", ["a.ts"], "origin/main")[1])

    def test_changed_paths_cover_committed_staged_unstaged_and_untracked_work(self):
        self.repo()
        self.commit("web/App.tsx")
        self.commit("src/hermes/a.py")
        self.commit("docs/old.md")
        (self.tmp / "docs/old.md").write_text("changed, not staged")
        self.commit("staged.txt")
        (self.tmp / "staged2.txt").write_text("y")
        self.git("add", "staged2.txt")
        (self.tmp / "scratch.py").write_text("untracked")
        self.assertEqual(check_all.changed_paths(self.tmp, "origin/main"),
                         ["docs/old.md", "scratch.py", "src/hermes/a.py", "staged.txt", "staged2.txt", "web/App.tsx"])

    def test_changes_on_the_base_after_the_branch_left_it_are_not_this_branchs(self):
        self.repo()
        self.commit("web/App.tsx")
        self.git("checkout", "-q", "main")
        self.commit("scripts/other.py", "a different file, so git cannot read this as a rename")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("checkout", "-q", "feature")
        self.assertEqual(check_all.changed_paths(self.tmp, "origin/main"), ["web/App.tsx"])

    def test_moving_a_python_file_away_still_counts_as_touching_python(self):
        self.repo()
        self.commit("src/hermes/journal.py", "def journal(): return 1\n")
        self.commit("tests/second.py", "def second(): return 2\n")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("checkout", "-q", "-b", "move")
        (self.tmp / "docs").mkdir()
        self.git("mv", "src/hermes/journal.py", "docs/journal.txt")
        self.git("commit", "-m", "move")
        self.git("mv", "tests/second.py", "docs/second.txt")  # staged, not committed
        paths = check_all.changed_paths(self.tmp, "origin/main")
        self.assertIn("src/hermes/journal.py", paths)
        self.assertIn("tests/second.py", paths)
        self.assertTrue(check_all.python_touched(paths))

    def test_a_base_ref_git_does_not_know_gives_none_not_an_empty_diff(self):
        self.repo()
        self.assertIsNone(check_all.changed_paths(self.tmp, "origin/nowhere"))


def _text(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _tidy(path):
    """A normalized posix path with "" for the repository root, or None when it leaves the repository."""
    path = posixpath.normpath(path) if path else "."
    return "" if path == "." else None if path == ".." or path.startswith("../") else path


def _up(path, steps=1):
    for _ in range(steps):
        if path is None or path == "":
            return None
        path = posixpath.dirname(path)
    return path


def _resolver(tree, location, read_module, importing=()):
    """A function naming the repository path an expression stands for (relative to the root, "" for the root, None when
    unknown), with the base names this file defines or imports from a sibling module of the tests."""
    bases = {}

    def resolve(node):
        if isinstance(node, ast.Name):
            return bases.get(node.id)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Path" and len(node.args) == 1 and not node.keywords:
            argument = node.args[0]
            return location if isinstance(argument, ast.Name) and argument.id == "__file__" else None
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "resolve" and not node.args:
            return resolve(node.func.value)
        if isinstance(node, ast.Attribute) and node.attr == "parent":
            return _up(resolve(node.value))
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == "parents" \
                and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, int) and node.slice.value >= 0:
            return _up(resolve(node.value.value), node.slice.value + 1)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            left, right = resolve(node.left), _text(node.right)
            return None if left is None or not right or right.startswith("/") else _tidy(posixpath.join(left, right))
        return None

    for node in ast.walk(tree):  # `from support import ROOT` means the ROOT that support.py defines
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module and "." not in node.module:
            for folder in (posixpath.dirname(location), "tests"):
                module = posixpath.join(folder, node.module + ".py")
                source = read_module(module) if module not in importing and module != location else None
                if source is not None:
                    imported = _resolver(ast.parse(source), module, read_module, (*importing, location))[1]
                    for alias in node.names:
                        if alias.name in imported:
                            bases[alias.asname or alias.name] = imported[alias.name]
                    break
    assignments = [(target.id, node.value) for node in ast.walk(tree) if isinstance(node, ast.Assign)
                   for target in node.targets if isinstance(target, ast.Name)]
    for _ in range(len(assignments)):  # a base may be defined from another that comes later in the walk
        for name, value in assignments:
            path = resolve(value)
            if path is not None:
                if bases.setdefault(name, path) != path:
                    raise ValueError(f"{location} assigns {name} two different repository paths; give them different names")
    return resolve, bases


READ_METHODS = ("read_text", "read_bytes", "open", "exists", "is_file", "is_dir", "iterdir", "stat")


def repository_reads(source, location, read_module=lambda path: None):
    """Repository paths a Python test source reads, relative to the repository root. `location` is the source file's
    own path under the root, which decides what its base names mean: a name assigned from `Path(__file__)` (for
    example `ROOT = Path(__file__).resolve().parents[2] / "src/hermes"`, or `TOOLS = ROOT / ".agents/tools"`) is the
    directory that expression names in this file, not a fixed one, and a name imported from a sibling module
    (`from support import ROOT`) is what that module defines (`read_module(path)` returns its source, or None).
    Seen: `/` chains from such a base or from `Path(__file__)`, `.glob()` and `.rglob()` with a literal pattern on
    one, `load_source("path")`, and a relative literal in `open("x")` or `Path("x").read_text()` (the tests run with the root as
    the working directory). Not seen: a path that is computed (a variable or f-string part, `os.path.join`). Paths
    built under a temporary directory (`root / ...`, `self.repo / ...`) never derive from `__file__`, so they are
    fixtures and are left out."""
    tree = ast.parse(source)
    resolve, _ = _resolver(tree, location, read_module)
    chain_parts = {id(node.left) for node in ast.walk(tree) if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div)}
    found = set()
    for node in ast.walk(tree):
        path = None
        if isinstance(node, ast.Call) and node.args and _text(node.args[0]):
            function, argument = node.func, _text(node.args[0])
            if isinstance(function, ast.Name) and function.id == "load_source":
                path = argument
            elif isinstance(function, ast.Name) and function.id == "open" and not argument.startswith("/"):
                path = _tidy(argument)
            elif isinstance(function, ast.Attribute) and function.attr in ("glob", "rglob") and resolve(function.value) is not None:
                path = _tidy(posixpath.join(resolve(function.value), argument))
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div) and id(node) not in chain_parts:  # the whole chain only
            path = resolve(node)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in READ_METHODS:
            made = node.func.value  # Path("package.json").read_text(): a literal that names no base is relative to the root
            if isinstance(made, ast.Call) and isinstance(made.func, ast.Name) and made.func.id == "Path" and len(made.args) == 1 and _text(made.args[0]) \
                    and not _text(made.args[0]).startswith("/"):
                path = _tidy(_text(made.args[0]))
        if path:
            found.add(path)
    return found


class PythonInputsTest(unittest.TestCase):
    def test_the_scan_finds_reads_of_this_repository_and_skips_fixtures(self):
        source = textwrap.dedent("""
            from support import load_source
            ROOT = Path(__file__).resolve().parents[1]
            TOOLS = ROOT / ".agents/tools"
            module = load_source("src/hermes/voice.py", "voice")
            names = (ROOT / "src" / "shared" / "voice.ts").read_text(), (TOOLS / "validate-ios.sh").read_text()
            previews = sorted(ROOT.glob("public/voice-previews/*"))
            fixture = self.repo / "src/app.ts"
            temp = root / "package.json"
            computed = ROOT / name
        """)
        self.assertEqual(repository_reads(source, "tests/voice_test.py"), {"src/hermes/voice.py", "src/shared/voice.ts", ".agents/tools/validate-ios.sh",
                                                                           ".agents/tools", "public/voice-previews/*"})

    def test_a_read_through_any_base_name_or_a_relative_literal_is_seen(self):
        source = textwrap.dedent("""
            APP = Path(__file__).resolve().parents[1]
            HERE = Path(__file__).resolve().parent
            config = (APP / "package.json").read_text()
            sibling = (HERE / "fixtures" / "a.json").read_text()
            inline = (Path(__file__).resolve().parents[1] / "src" / "shared" / "x.json").read_text()
            opened = open("tsconfig.json")
            relative = Path("docs/Dependencies.md").read_text()
            named = Path("docs/ValidationLedger.md")
            fixture_file = self.repo / named
            listed = list(APP.rglob("*.mjs"))
            computed = APP / name
            absolute = open("/etc/hosts")
            fixture = self.repo / "package-lock.json"
        """)
        self.assertEqual(repository_reads(source, "tests/some_test.py"), {"package.json", "tests/fixtures/a.json", "src/shared/x.json", "tsconfig.json",
                                                                          "docs/Dependencies.md", "*.mjs"})

    def test_a_base_that_points_below_the_root_is_read_from_there_and_a_name_means_what_its_own_file_says(self):
        # scripts/spike/dashboard_contract_test.py sets ROOT to src/hermes; the same name in tests/ is the root.
        spike = 'ROOT = Path(__file__).resolve().parents[2] / "src/hermes"\nsource = (ROOT / "dashboard.py").read_text()\n'
        self.assertEqual(repository_reads(spike, "scripts/spike/dashboard_contract_test.py"), {"src/hermes", "src/hermes/dashboard.py"})
        top = 'ROOT = Path(__file__).resolve().parents[1]\nsource = (ROOT / "dashboard.py").read_text()\n'
        self.assertEqual(repository_reads(top, "tests/dashboard_test.py"), {"dashboard.py"})
        self.assertEqual(repository_reads('ROOT = Path(__file__).resolve().parents[1]\n(ROOT / "package.json").read_text()\n', "scripts/x_test.py"),
                         {"package.json"})

    def test_a_base_imported_from_a_sibling_module_means_what_that_module_defines(self):
        modules = {"tests/support.py": 'ROOT = Path(__file__).resolve().parents[1]\n', "scripts/spike/support.py": 'ROOT = Path(__file__).resolve().parents[2] / "src/hermes"\n'}
        source = 'from support import ROOT as REPO, missing\nfrom elsewhere import ROOT\n(REPO / "package.json").read_text()\n(ROOT / "x").read_text()\n'
        self.assertEqual(repository_reads(source, "tests/a_test.py", modules.get), {"package.json"})
        self.assertEqual(repository_reads(source, "scripts/spike/a_test.py", modules.get), {"src/hermes/package.json"})
        self.assertEqual(repository_reads(source, "scripts/b_test.py", modules.get), {"package.json"})  # no support.py beside it: the one in tests/

    def test_a_base_that_climbs_out_of_the_repository_or_is_assigned_two_ways_is_not_guessed_at(self):
        self.assertEqual(repository_reads('ROOT = Path(__file__).resolve().parents[5]\n(ROOT / "x.json").read_text()\n', "tests/x_test.py"), set())
        outside = 'ROOT = Path(__file__).resolve().parents[1]\nopen("../elsewhere.json")\n(ROOT / ".." / "sibling").read_text()\n(ROOT / "a" / ".." / "b.json").read_text()\n'
        self.assertEqual(repository_reads(outside, "tests/x_test.py"), {"b.json"})
        with self.assertRaisesRegex(ValueError, "ROOT two different"):
            repository_reads('ROOT = Path(__file__).resolve().parents[1]\nROOT = Path(__file__).resolve().parent\n', "tests/x_test.py")

    def test_every_repository_path_a_python_test_reads_is_an_input_that_makes_auto_run_py(self):
        # A test that reads src/shared/voice.ts must run when only that file changes. A new read outside the list
        # fails here, naming the test: add its directory to PYTHON_INPUT_DIRS in check_all.py.
        files = sorted({path for pattern in ("tests/*.py", "scripts/*test*.py", "scripts/spike/*test*.py") for path in ROOT.glob(pattern)})
        reads = {}

        def read_module(relative):
            return (ROOT / relative).read_text() if (ROOT / relative).is_file() else None

        for path in files:
            for read in repository_reads(path.read_text(), path.relative_to(ROOT).as_posix(), read_module):
                reads.setdefault(read, path.name)
        # The scan still sees reads, so it cannot pass by finding none.
        self.assertGreaterEqual(set(reads), {"src/shared/voice.ts", "public/voice-previews", ".agents/tools/validate-ios.sh", "src/hermes/voice.py"})
        uncovered = []
        for read, name in sorted(reads.items()):
            if read == "tests":
                continue  # put on sys.path to import support.py; the .py files in it already count
            if "*" not in read and not (ROOT / read).exists():
                continue  # a fragment joined to something other than the repository root
            represent = read.replace("*", "x") if "*" in read else read + "/x" if (ROOT / read).is_dir() else read
            if not check_all.python_touched([represent]):
                uncovered.append(f"{read} (read by {name})")
        self.assertEqual(uncovered, [])


# The summary parts of each tool's real output, captured from this repository's own runs.
VITEST_PASS = """
 RUN  v5.1.0 /work/agent-interface

 Test Files  196 passed (196)
      Tests  3296 passed (3296)
   Start at  19:02:30
   Duration  15.78s (tests 48%, transform 23%, environment 14%, import 13%, setup 2%)
"""
VITEST_FAIL = """
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 8 passed | 1 skipped (10)
   Start at  19:07:25
"""
VITEST_FAIL_COLORED = "\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m1 passed\x1b[39m\x1b[22m\x1b[90m (2)\x1b[39m\n"
PLAYWRIGHT_PASS = "  ✓  24 [chromium] › e2e/smoke.spec.ts:333:3 › a transcript image (668ms)\n\n  24 passed (44.8s)\n"
PLAYWRIGHT_FAIL = "  1 failed\n    [chromium] › e2e/zz-tmp.spec.ts:3:1 › fails on purpose ──────\n  1 skipped\n  1 passed (2.3s)\n"
PLAYWRIGHT_FLAKY = "  1 flaky\n    [chromium] › e2e/smoke.spec.ts:10:1 › something\n  23 passed (50s)\n"
PY_PASS = "PASS tests/validate_ios_test.py (7.2s)\n\n44 passed, 0 skipped, 0 failed in 217.6s (Python 3.14.10)\n"
PY_FAIL = "FAIL tests/zz_tmp_test.py (0.1s)\nPASS tests/deploy_common_test.py (3.5s)\n\n1 passed, 2 skipped, 1 failed in 3.5s (Python 3.14.10)\nFailed:\n  tests/zz_tmp_test.py\n"
BUILD_PASS = "vite v8.3.5 building client environment for production...\n✓ 886 modules transformed.\n✓ built in 644ms\nBuilt service worker 79a0897ff2877210 with 64 installed files.\n"
LINT_FAIL = """
tests/zz-tmp-lint.test.ts:2:7: warning eslint(no-unused-vars): Variable 'unused' is declared but never used.
tests/zz-tmp-lint.test.ts:1:1: warning eslint(no-debugger): `debugger` statement is not allowed help: Remove the debugger statement
src/a.ts:3:1: error eslint(no-undef): 'x' is not defined
"""
TSC_FAIL = "src/zz-tmp.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(2,1): error TS2304: Cannot find name 'y'.\n"
RUFF_FAIL = "F821 Undefined name `undefined_name`\n --> scripts/zz_tmp.py:2:7\n\nFound 2 errors.\n[*] 1 fixable with `--fix`.\n"
RUFF_ONE = "F821 Undefined name `x`\n\nFound 1 error.\n"


class SummaryParsingTest(unittest.TestCase):
    def test_each_tools_real_output_gives_its_counts(self):
        cases = [
            ("test", VITEST_PASS, {"files": 196, "tests": 3296, "files_failed": 0, "files_skipped": 0, "tests_failed": 0, "tests_skipped": 0}, "196 files, 3296 tests"),
            ("test", VITEST_FAIL, {"files": 2, "tests": 10, "files_failed": 1, "files_skipped": 0, "tests_failed": 1, "tests_skipped": 1}, "2 files, 10 tests, 1 failed, 1 skipped"),
            ("test", VITEST_FAIL_COLORED, {"files": 2, "files_failed": 1, "files_skipped": 0}, ""),
            ("e2e", PLAYWRIGHT_PASS, {"passed": 24, "tests": 24}, "24 tests"),
            ("e2e", PLAYWRIGHT_FAIL, {"failed": 1, "skipped": 1, "passed": 1, "tests": 3}, "3 tests, 1 failed, 1 skipped"),
            ("e2e", PLAYWRIGHT_FLAKY, {"flaky": 1, "passed": 23, "tests": 24}, "24 tests, 1 flaky"),
            ("py", PY_PASS, {"files": 44, "passed": 44, "skipped": 0, "failed": 0}, "44 files"),
            ("py", PY_FAIL, {"files": 4, "passed": 1, "skipped": 2, "failed": 1}, "4 files, 1 failed, 2 skipped"),
            ("build", BUILD_PASS, {"modules": 886}, "886 modules"),
            ("lint", LINT_FAIL, {"errors": 1, "warnings": 2}, "1 error, 2 warnings"),
            ("typecheck", TSC_FAIL, {"errors": 2}, "2 errors"),
            ("ruff", RUFF_FAIL, {"errors": 2}, "2 errors"),
            ("ruff", RUFF_ONE, {"errors": 1}, "1 error"),
        ]
        for check, output, counts, text in cases:
            with self.subTest(check=check, output=output[:40]):
                self.assertEqual(check_all.parse_counts(check, output), counts)
                if text:
                    self.assertEqual(check_all.describe_counts(check, counts), text)

    def test_clean_runs_and_unrecognized_output_have_no_counts(self):
        for check, output in (("lint", "\n> oxlint\n\n"), ("typecheck", ""), ("ruff", "All checks passed!\n"), ("test", "unrelated"), ("e2e", "Error: no browsers"),
                              ("py", "Not a discovered Python test file:\n  x"), ("build", "Error: failed")):
            with self.subTest(check):
                self.assertEqual(check_all.parse_counts(check, output), {})
                self.assertEqual(check_all.describe_counts(check, {}), "")

    def test_a_line_in_a_test_name_that_looks_like_a_summary_is_not_one(self):
        output = "  ✓  1 [chromium] › a › 3 passed through the gate (10ms)\n  1 passed (1s)\n"
        self.assertEqual(check_all.parse_counts("e2e", output), {"passed": 1, "tests": 1})


class CacheDirTest(unittest.TestCase):
    def test_the_override_wins_and_the_default_is_per_user_outside_any_checkout(self):
        self.assertEqual(check_all.cache_dir({"CHECK_ALL_HOME": "/x/y"}, home="/h"), Path("/x/y"))
        default = check_all.cache_dir({}, home="/h")
        self.assertTrue(str(default).startswith("/h/"))
        self.assertTrue(str(default).endswith("agent-interface/check-all"))
        if sys.platform != "darwin":
            self.assertEqual(check_all.cache_dir({"XDG_CACHE_HOME": "/x/cache"}, home="/h"), Path("/x/cache/agent-interface/check-all"))


# What Playwright's web server is to the browser suite: a process in a session of its own that listens on E2E_PORT
# and writes its pid once it does.
SERVER = """
import os, socket, sys, time
sock = socket.socket()
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", int(sys.argv[1])))
sock.listen()
open(sys.argv[2], "w").write(str(os.getpid()))
time.sleep(600)
"""

FAKE_NPM = """
    import json, os, signal, subprocess, sys, time
    key = " ".join(sys.argv[1:])
    with open(os.environ["FAKE_LOG"], "a") as log:
        log.write(json.dumps({"call": key, "port": os.environ.get("E2E_PORT"), "no_color": os.environ.get("NO_COLOR"), "cwd": os.getcwd(), "at": time.time(), "pid": os.getpid()}) + "\\n")
    plan = json.load(open(os.environ["FAKE_PLAN"]))
    if key not in plan:
        print("UNPLANNED npm call: " + key); sys.exit(97)
    step = plan[key]
    if step.get("ignore_sigint"):
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    if step.get("pidfile"):
        open(step["pidfile"], "w").write(str(os.getpid()))
    if step.get("server"):
        # Like Playwright: start the web server detached, and on SIGINT shut it down (after a delay that makes an
        # early release of the locks visible) before exiting. SIGKILL gives it no chance, and leaks the server.
        server = subprocess.Popen([sys.executable, "-c", step["server_source"], os.environ["E2E_PORT"], step["server"]], start_new_session=True)
        def shut_down(signum, frame):
            time.sleep(step.get("shutdown_delay", 0))
            server.terminate()
            server.wait()
            sys.exit(130)
        signal.signal(signal.SIGINT, shut_down)
    time.sleep(step.get("sleep", 0))
    sys.stdout.write(step.get("out", ""))
    with open(os.environ["FAKE_LOG"], "a") as log:
        log.write(json.dumps({"done": key, "at": time.time()}) + "\\n")
    sys.exit(step.get("rc", 0))
"""

# A launcher that leaves descriptors 3 to 20 open, as some terminals and agent harnesses do, then runs the driver.
LEAKY_LAUNCHER = """
import os, sys
null = os.open("/dev/null", os.O_RDONLY)
for number in range(3, 21):
    os.dup2(null, number)
    os.set_inheritable(number, True)
if null > 20:
    os.close(null)
os.execv(sys.executable, [sys.executable, "-I", "-c", *sys.argv[1:]])
"""

# Which descriptors above 2 are lock files (told from the process's own by inode).
LOCK_PROBE = """
import json, os, sys
from pathlib import Path
locks = {(path.stat().st_dev, path.stat().st_ino) for path in Path(sys.argv[1]).glob("*.lock")}
found = []
for number in range(3, 256):
    try:
        stat = os.fstat(number)
    except OSError:
        continue
    if (stat.st_dev, stat.st_ino) in locks:
        found.append(number)
print(json.dumps(found))
"""

# The real Node as npm, since the claim is about what Node does with descriptors it inherits: it records which lock
# descriptors it holds, then which a child it spawns holds.
NODE_NPM = """
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const locks = path.join(process.env.CHECK_ALL_HOME, "locks");
const identities = new Set(fs.readdirSync(locks).map((name) => { const s = fs.statSync(path.join(locks, name)); return s.dev + ":" + s.ino; }));
let own = [];
for (let fd = 3; fd < 256; fd++) { try { const s = fs.fstatSync(fd); if (identities.has(s.dev + ":" + s.ino)) own.push(fd); } catch (_) {} }
const child = spawnSync(process.env.FAKE_PROBE, [locks], { encoding: "utf8" });
fs.writeFileSync(process.env.FAKE_REPORT, JSON.stringify({ npm: own, grandchild: JSON.parse(child.stdout) }));
console.log("  4 passed (3s)");
"""
PASSING = {
    "run typecheck": {"out": ""}, "run lint": {"out": ""},
    "test": {"out": " Test Files  3 passed (3)\n      Tests  12 passed (12)\n"},
    "run build": {"out": "✓ 10 modules transformed.\n"}, "run test:e2e": {"out": "  4 passed (3s)\n"},
    "run test:py": {"out": "2 passed, 0 skipped, 0 failed in 1.0s (Python 3.14.0)\n"},
}


class CommandTest(TempCase):
    """The whole command against a fake checkout and fake npm, node and ruff on PATH."""

    def setUp(self):
        super().setUp()
        self.root, self.cache, self.bin = self.tmp / "checkout", self.tmp / "cache", self.tmp / "bin"
        for path in (self.root / ".github", self.root / "node_modules", self.root / "dist/client", self.bin):
            path.mkdir(parents=True)
        (self.root / ".github/requirements-ci.txt").write_text("ruff==0.17.3\n")
        lock = json.dumps({"packages": {"": {}, "node_modules/a": {"version": "1.0.0"}}})
        (self.root / "package-lock.json").write_text(lock)
        (self.root / "node_modules/.package-lock.json").write_text(lock)
        (self.root / "dist/client/index.html").write_text("<html>")
        self.log = self.tmp / "calls.log"
        self.plan = self.tmp / "plan.json"
        self.set_plan(PASSING)
        script(self.bin / "npm", FAKE_NPM)
        self.fake_node(True, "v24.0.0")
        script(self.bin / "ruff", """
            import json, os, sys
            if sys.argv[1:] == ["--version"]: print("ruff 0.17.3"); sys.exit(0)
            if sys.argv[1:] != ["check", "."]: print("UNPLANNED ruff call: " + " ".join(sys.argv[1:]), file=sys.stderr); sys.exit(97)
            with open(os.environ["FAKE_LOG"], "a") as log: log.write(json.dumps({"call": "ruff check .", "port": None}) + "\\n")
            print(os.environ.get("FAKE_RUFF_OUT", "All checks passed!")); sys.exit(int(os.environ.get("FAKE_RUFF_RC", "0")))
        """)
        self.git("init", "-q", "-b", "main")
        (self.root / "README.md").write_text("x")
        self.git("add", "README.md")
        self.git("commit", "-q", "-m", "init")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")

    def fake_node(self, ok, version):
        """The one call the tool makes: `node --input-type=module -e SCRIPT`. Any other arguments exit 97."""
        script(self.bin / "node", f"""
            import json, sys
            if sys.argv[1:3] != ["--input-type=module", "-e"] or len(sys.argv) != 4:
                print("UNPLANNED node call: " + " ".join(sys.argv[1:]), file=sys.stderr); sys.exit(97)
            print(json.dumps({{'ok': {ok!r}, 'version': {version!r}, 'range': '^24'}}))
        """)

    def git(self, *args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", *args], cwd=self.root, check=True, capture_output=True)

    def set_plan(self, plan):
        self.plan.write_text(json.dumps(plan))

    def env(self, **extra):
        return {"PATH": f"{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin", "FAKE_LOG": str(self.log), "FAKE_PLAN": str(self.plan),
                "HOME": str(self.tmp), "CHECK_ALL_HOME": str(self.cache), **extra}

    def run_main(self, *argv, root=None, **extra):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, self.env(**extra), clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = check_all.main(list(argv), root=root or self.root, cache=self.cache, close_inherited=False)
        return code, out.getvalue(), err.getvalue()

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if '"call"' in line]

    def names(self):
        return [call["call"] for call in self.calls()]

    def row(self, out, name):
        return next(line for line in out.splitlines() if line.startswith(name + " "))

    def test_every_check_runs_in_order_and_one_table_summarizes_them(self):
        code, out, _ = self.run_main("--py", "always")
        self.assertEqual(code, 0)
        self.assertEqual(self.names(), ["run typecheck", "run lint", "ruff check .", "test", "run build", "run test:e2e", "run test:py"])
        self.assertIn("3 files, 12 tests", self.row(out, "test"))
        self.assertIn("4 tests", self.row(out, "e2e"))
        self.assertIn("2 files", self.row(out, "py"))
        self.assertIn("10 modules", self.row(out, "build"))
        self.assertIn("All 7 checks passed", out)
        self.assertEqual({call["cwd"] for call in self.calls() if "cwd" in call}, {str(self.root)})
        self.assertEqual({call["no_color"] for call in self.calls() if "cwd" in call}, {"1"})

    def test_a_failure_stops_the_rest_shows_the_output_tail_and_exits_nonzero(self):
        self.set_plan({**PASSING, "run lint": {"rc": 1, "out": "src/a.ts:3:1: error eslint(no-undef): 'x' is not defined\n"}})
        code, out, err = self.run_main("--py", "always")
        self.assertEqual(code, 1)
        self.assertEqual(self.names(), ["run typecheck", "run lint"])
        self.assertIn("FAIL", self.row(out, "lint"))
        self.assertIn("1 error", self.row(out, "lint"))
        for name in ("ruff", "test", "build", "e2e", "py"):
            self.assertIn("an earlier check failed", self.row(out, name))
        self.assertIn("no-undef", err)
        self.assertIn("FAILED: lint", out)

    def test_keep_going_runs_the_rest_but_not_an_e2e_whose_build_failed(self):
        self.set_plan({**PASSING, "run build": {"rc": 1, "out": "boom\n"}, "run typecheck": {"rc": 2, "out": "src/zz.ts(1,7): error TS2322: bad\n"}})
        code, out, _ = self.run_main("--keep-going", "--py", "always")
        self.assertEqual(code, 1)
        self.assertEqual(self.names(), ["run typecheck", "run lint", "ruff check .", "test", "run build", "run test:py"])
        self.assertIn("build did not pass", self.row(out, "e2e"))
        self.assertIn("FAILED: typecheck, build", out)

    def test_only_and_skip_pick_checks_but_keep_the_order(self):
        self.run_main("--only", "test,lint")
        self.assertEqual(self.names(), ["run lint", "test"])
        self.log.unlink()
        self.run_main("--skip", "e2e,py,ruff,build")
        self.assertEqual(self.names(), ["run typecheck", "run lint", "test"])

    def test_unknown_check_names_and_an_empty_selection_are_refused_with_the_valid_names(self):
        for argv, message in ((("--only", "tset"), "--only takes names from"), (("--skip", "lint,nope"), "--skip takes names from"),
                              (("--only", "lint", "--skip", "lint"), "Nothing to run")):
            with self.subTest(argv):
                code, _, err = self.run_main(*argv)
                self.assertEqual(code, 2)
                self.assertIn(message, err)
        self.assertEqual(self.names(), [])

    def test_py_auto_skips_on_a_web_only_diff_and_says_why_in_the_table(self):
        code, out, _ = self.run_main("--skip", "typecheck,lint,ruff,build,e2e")
        self.assertEqual(code, 0)
        self.assertEqual(self.names(), ["test"])
        self.assertIn("skipped", self.row(out, "py"))
        self.assertIn("no changes to Python or a file the Python tests read against origin/main", self.row(out, "py"))
        self.assertIn("All 1 checks passed", out)

    def test_py_auto_runs_when_the_diff_touches_scripts(self):
        (self.root / "scripts").mkdir()
        (self.root / "scripts/tool.mjs").write_text("x")
        self.git("add", "scripts/tool.mjs")
        self.git("commit", "-q", "-m", "script")
        self.run_main("--skip", "typecheck,lint,ruff,test,build,e2e")  # py is not named, so only the diff can run it
        self.assertEqual(self.names(), ["run test:py"])

    def test_py_auto_runs_when_the_diff_touches_a_file_the_python_tests_read(self):
        (self.root / "src/shared").mkdir(parents=True)
        (self.root / "src/shared/voice.ts").write_text("x")
        self.git("add", "src/shared/voice.ts")
        self.git("commit", "-q", "-m", "voice")
        self.run_main("--skip", "typecheck,lint,ruff,test,build,e2e")
        self.assertEqual(self.names(), ["run test:py"])

    def test_py_never_skips_even_when_named_and_always_runs_on_a_web_diff(self):
        self.run_main("--only", "py", "--py", "never")
        self.assertEqual(self.names(), [])
        self.run_main("--only", "py", "--py", "always")
        self.assertEqual(self.names(), ["run test:py"])

    def test_ruff_is_never_left_out_by_the_py_switch(self):
        self.run_main("--py", "never", "--skip", "typecheck,lint,test,build,e2e")
        self.assertEqual(self.names(), ["ruff check ."])

    def test_a_ruff_failure_is_reported_with_its_count(self):
        code, out, _ = self.run_main("--only", "ruff", FAKE_RUFF_RC="1", FAKE_RUFF_OUT="F821 bad\n\nFound 2 errors.")
        self.assertEqual(code, 1)
        self.assertIn("2 errors", self.row(out, "ruff"))

    def test_e2e_gets_a_free_port_and_no_other_check_gets_one(self):
        self.run_main()
        ports = {call["call"]: call["port"] for call in self.calls() if "cwd" in call}
        port = int(ports.pop("run test:e2e"))
        self.assertTrue(check_all.PORT_BASE <= port < check_all.PORT_BASE + 2 * check_all.PORT_PAIRS)
        self.assertEqual(set(ports.values()), {None})
        # Both leases are let go with the run: the next one can take the same pair and the only heavy slot.
        lease, _ = check_all.pick_e2e_port(self.cache / "locks", str(self.root), requested=port)
        lease.release()
        slot, _ = check_all.acquire_slot(self.cache / "locks", 1, {"check": "x"}, 0.2)
        slot.release()

    def test_a_pass_whose_counts_cannot_be_read_says_so_but_a_clean_lint_has_nothing_to_count(self):
        self.set_plan({**PASSING, "test": {"out": "the output changed shape\n"}})
        code, out, _ = self.run_main("--only", "lint,test")
        self.assertEqual(code, 0)
        self.assertTrue(self.row(out, "test").endswith("counts unknown"), self.row(out, "test"))
        self.assertTrue(self.row(out, "lint").endswith("-"), self.row(out, "lint"))
        self.assertNotIn("counts unknown", self.row(out, "lint"))

    def test_a_port_the_caller_set_is_honored_when_free_and_refused_when_not(self):
        free = BASE + 24  # past the candidate pairs, so it is only ever used because the caller asked
        self.run_main("--only", "e2e", E2E_PORT=str(free))
        self.assertEqual([call["port"] for call in self.calls()], [str(free)])
        with socket.socket() as busy:
            busy.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            busy.bind(("127.0.0.1", free))
            busy.listen()
            code, out, err = self.run_main("--only", "e2e", E2E_PORT=str(free))
        self.assertEqual(code, 1)
        self.assertIn("FAIL", self.row(out, "e2e"))
        self.assertIn(f"E2E_PORT={free} is not usable", err)

    def test_a_malformed_port_is_refused_before_anything_runs(self):
        for value in ("abc", "80", "65535"):
            with self.subTest(value):
                code, _, err = self.run_main("--only", "e2e", E2E_PORT=value)
                self.assertEqual(code, 2)
                self.assertIn("from 1024 to 65534", err)
        self.assertEqual(self.names(), [])

    def test_e2e_without_a_build_is_refused_when_nothing_will_build_it(self):
        (self.root / "dist/client/index.html").unlink()
        code, _, err = self.run_main("--only", "e2e")
        self.assertEqual(code, 2)
        self.assertIn("npm run build", err)
        self.assertEqual(self.run_main("--only", "build,e2e")[0], 0)

    def test_a_missing_node_modules_refuses_before_running_any_check(self):
        (self.root / "node_modules/.package-lock.json").unlink()
        code, _, err = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("npm ci", err)
        self.assertEqual(self.names(), [])

    def test_a_symlinked_node_modules_runs_and_the_warning_is_in_the_summary_too(self):
        real = self.tmp / "shared-modules"
        (self.root / "node_modules").rename(real)
        (self.root / "node_modules").symlink_to(real)
        code, out, err = self.run_main("--only", "lint")
        self.assertEqual(code, 0)
        self.assertIn("symlink", err)
        self.assertIn("Warning: node_modules is a symlink", out)

    def test_a_node_outside_the_supported_range_is_refused_with_the_switch_command(self):
        self.fake_node(False, "v22.1.0")
        code, _, err = self.run_main("--only", "lint")
        self.assertEqual(code, 2)
        self.assertIn("node v22.1.0 is outside", err)
        self.assertIn("fnm use", err)

    def test_a_hung_check_is_killed_and_reported_as_a_timeout_with_its_lock_released(self):
        pidfile = self.tmp / "hung.pid"
        self.set_plan({**PASSING, "test": {"sleep": 30, "pidfile": str(pidfile)}})
        code, out, _ = self.run_main("--only", "test", "--check-timeout", "1.5")
        self.assertEqual(code, 1)
        self.assertIn("TIMEOUT", self.row(out, "test"))
        pid = int(pidfile.read_text())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        held, _ = check_all.acquire_slot(self.cache / "locks", 1, {"check": "x"}, 0.2)
        held.release()

    def test_a_run_queues_behind_a_heavy_holder_and_shows_the_wait_apart_from_the_run(self):
        holder = Holder(self, "slot", self.cache / "locks", 1, "e2e", "/w/other")
        timer = threading.Timer(1.0, holder.release)
        timer.start()
        self.addCleanup(timer.cancel)
        code, out, err = self.run_main("--only", "test")
        self.assertEqual(code, 0)
        self.assertIn("test: queued for a heavy slot (1 total), held by e2e in /w/other", err)
        queued, run = self.row(out, "test").split()[2:4]
        self.assertTrue(queued.endswith("s") and float(queued[:-1]) >= 0.8, queued)
        self.assertLess(0 if run == "-" else float(run[:-1]), 0.8)  # the fake test is quick; the wait is not counted as run time

    def test_light_checks_do_not_queue_behind_a_heavy_holder(self):
        Holder(self, "slot", self.cache / "locks", 1, "e2e", "/w/other")
        code, _, _ = self.run_main("--only", "typecheck,lint,ruff,build", "--lock-timeout", "0.2")
        self.assertEqual(code, 0)

    def test_giving_up_the_queue_exits_75_and_names_the_holder_and_runs_nothing(self):
        Holder(self, "slot", self.cache / "locks", 1, "py", "/w/other")
        code, out, err = self.run_main("--only", "test", "--lock-timeout", "0.3")
        self.assertEqual(code, check_all.EXIT_LOCK_TIMEOUT)
        self.assertIn("NOT QUEUED", self.row(out, "test"))
        self.assertIn("py in /w/other", err)
        self.assertEqual(self.names(), [])

    def test_heavy_slots_can_be_raised_by_flag_or_environment(self):
        Holder(self, "slot", self.cache / "locks", 2, "py", "/w/other")
        self.assertEqual(self.run_main("--only", "test", "--lock-timeout", "0.3", "--heavy-slots", "2")[0], 0)
        self.assertEqual(self.run_main("--only", "test", "--lock-timeout", "0.3", CHECK_ALL_HEAVY_SLOTS="2")[0], 0)
        self.assertEqual(self.run_main("--only", "test", "--heavy-slots", "0")[0], 2)

    def spawn(self, *argv, **extra):
        driver = ("import sys; sys.path.insert(0, sys.argv[1]); import check_all; "
                  "sys.exit(check_all.main(sys.argv[4:], root=__import__('pathlib').Path(sys.argv[2]), cache=__import__('pathlib').Path(sys.argv[3])))")
        process = subprocess.Popen([sys.executable, "-I", "-c", driver, str(TOOLS), str(self.root), str(self.cache), *argv], env=self.env(**extra),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        return process

    def intervals(self, call):
        starts = [entry["at"] for entry in map(json.loads, self.log.read_text().splitlines()) if entry.get("call") == call]
        ends = [entry["at"] for entry in map(json.loads, self.log.read_text().splitlines()) if entry.get("done") == call]
        return sorted(zip(starts, ends))

    def test_two_runs_started_together_never_run_heavy_suites_at_the_same_time(self):
        self.set_plan({**PASSING, "test": {"sleep": 1.0}})
        runs = [self.spawn("--only", "test"), self.spawn("--only", "test")]
        outputs = [run.communicate(timeout=30) for run in runs]
        self.assertEqual([run.returncode for run in runs], [0, 0])
        (first_start, first_end), (second_start, _) = self.intervals("test")
        self.assertGreaterEqual(second_start, first_end)
        queued = [next(line for line in out.splitlines() if line.startswith("test ")).split()[2] for out, _ in outputs]
        self.assertEqual(sorted(value == "-" for value in queued), [False, True])  # exactly one waited
        self.assertGreater(first_end - first_start, 0.9)

    def test_two_runs_with_room_for_both_overlap_but_pick_different_browser_ports(self):
        self.set_plan({**PASSING, "run test:e2e": {"sleep": 1.0, "out": "  4 passed (1s)\n"}})
        runs = [self.spawn("--only", "e2e", CHECK_ALL_HEAVY_SLOTS="2") for _ in range(2)]
        for run in runs:
            run.communicate(timeout=30)
        self.assertEqual([run.returncode for run in runs], [0, 0])
        ports = [int(call["port"]) for call in self.calls()]
        self.assertTrue({ports[0], ports[0] + 1}.isdisjoint({ports[1], ports[1] + 1}), ports)
        (a_start, a_end), (b_start, b_end) = self.intervals("run test:e2e")
        self.assertLess(b_start, a_end)  # they really overlapped, so the ports were chosen under contention

    def test_a_terminated_run_kills_its_check_and_frees_its_locks(self):
        pidfile = self.tmp / "e2e.pid"
        self.set_plan({**PASSING, "run test:e2e": {"sleep": 30, "pidfile": str(pidfile)}})
        process = self.spawn("--only", "e2e")
        deadline = time.monotonic() + 15
        while not pidfile.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        pid = int(pidfile.read_text())
        process.send_signal(signal.SIGTERM)
        _, err = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 130)
        self.assertIn("stopped by SIGTERM", err)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        held, _ = check_all.acquire_slot(self.cache / "locks", 1, {"check": "x"}, 0.2)
        held.release()
        port_lock, _ = check_all.pick_e2e_port(self.cache / "locks", str(self.root))
        port_lock.release()

    def start_e2e_with_server(self, *argv, **step):
        """Run the e2e check through a fake that starts a listening web server in its own session, as Playwright does.
        Returns (process, server pid, port, the lock files of the port pair and the heavy slot)."""
        pidfile = self.tmp / "server.pid"
        self.set_plan({**PASSING, "run test:e2e": {"sleep": 60, "server": str(pidfile), "server_source": SERVER, **step}})
        process = self.spawn("--only", "e2e", *argv)
        self.wait_for(lambda: pidfile.exists() and pidfile.read_text(), "the web server to listen")
        port = int(self.calls()[0]["port"])
        locks = self.cache / "locks"
        self.addCleanup(lambda: pidfile.exists() and self.kill_quietly(int(pidfile.read_text())))
        return process, int(pidfile.read_text()), port, [locks / f"e2e-port-{port}.lock", locks / "heavy-0.lock"]

    def wait_for(self, condition, what, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.02)
        self.fail(f"timed out waiting for {what}")

    def kill_quietly(self, pid, number=signal.SIGKILL):
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, number)

    def alive(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True

    def assert_locks_free_only_after_the_server_is_gone(self, locks, pid, port):
        """Poll every lock file together: each must be seen held first, so an instant release cannot pass, and the
        first moment any can be taken the web server must already be dead and its port free."""
        seen_held, deadline = set(), time.monotonic() + 20
        while True:
            for lock in locks:
                held = check_all.try_lock(lock)
                if held:
                    held.release()
                    self.assertIn(lock, seen_held, f"{lock.name} was free before the stop began")
                    self.assertFalse(self.alive(pid), f"{lock.name} was released while the web server still ran")
                    self.assertTrue(check_all.can_bind(port), f"{lock.name} was released while the web server still listened")
                    return
                seen_held.add(lock)
            self.assertLess(time.monotonic(), deadline, "the locks were never released")
            time.sleep(0.02)

    def test_ctrl_c_stops_the_suite_gracefully_so_the_web_server_goes_too_and_the_locks_free_after(self):
        process, pid, port, locks = self.start_e2e_with_server(shutdown_delay=1.0)
        process.send_signal(signal.SIGINT)
        self.assert_locks_free_only_after_the_server_is_gone(locks, pid, port)
        _, err = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 130)
        self.assertIn("stopped by SIGINT", err)

    def test_sigterm_stops_the_suite_gracefully_so_the_web_server_goes_too_and_the_locks_free_after(self):
        process, pid, port, locks = self.start_e2e_with_server(shutdown_delay=1.0)
        process.send_signal(signal.SIGTERM)
        self.assert_locks_free_only_after_the_server_is_gone(locks, pid, port)
        _, err = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 130)
        self.assertIn("stopped by SIGTERM", err)

    def test_a_check_timeout_stops_the_suite_gracefully_so_the_web_server_goes_too_and_the_locks_free_after(self):
        process, pid, port, locks = self.start_e2e_with_server("--check-timeout", "1.5", shutdown_delay=1.0)
        self.assert_locks_free_only_after_the_server_is_gone(locks, pid, port)
        out, _ = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 1)
        self.assertIn("TIMEOUT", self.row(out, "e2e"))

    def test_a_second_ctrl_c_does_not_wait_out_the_grace_for_a_suite_that_ignores_the_first(self):
        pidfile = self.tmp / "stubborn.pid"
        self.set_plan({**PASSING, "test": {"sleep": 60, "pidfile": str(pidfile), "ignore_sigint": True}})
        process = self.spawn("--only", "test")
        self.wait_for(lambda: pidfile.exists() and pidfile.read_text(), "the suite to start")
        pid = int(pidfile.read_text())
        self.addCleanup(self.kill_quietly, pid)
        process.send_signal(signal.SIGINT)
        time.sleep(0.5)
        self.assertTrue(self.alive(pid))  # still inside the ten-second grace
        process.send_signal(signal.SIGINT)
        process.communicate(timeout=5)
        self.wait_for(lambda: not self.alive(pid), "the suite to be killed")

    def test_killing_check_all_with_sigkill_leaves_its_suite_holding_the_slot_and_ports_until_the_suite_ends(self):
        # Only the suite's own process (npm, here the fake) is handed the descriptors; Node does not pass them on to
        # Playwright's runner or its web server. That is enough, since npm lives until the runner exits.
        process, pid, port, locks = self.start_e2e_with_server()
        suite = int(self.calls()[0]["pid"])  # the fake npm, started in a session of its own
        process.kill()
        process.communicate(timeout=5)
        locks_dir = self.cache / "locks"
        with self.assertRaises(check_all.LockTimeout):
            check_all.acquire_slot(locks_dir, 1, {"check": "second run"}, 0.3)
        with self.assertRaisesRegex(check_all.Refusal, "locked by another check-all"):
            check_all.pick_e2e_port(locks_dir, "w", requested=port)
        os.kill(suite, signal.SIGKILL)
        self.wait_for(lambda: not self.alive(suite), "the suite to die")
        held, _ = check_all.acquire_slot(locks_dir, 1, {"check": "second run"}, 2)
        held.release()
        lease = check_all.try_lock(locks[0])  # the port pair's lock; the orphaned web server still listens, as no flock can stop
        self.assertIsNotNone(lease)
        lease.release()

    def run_with_leaky_launcher(self, *argv):
        """Run check-all's main in a process whose launcher left descriptors 3 to 20 open, under the real Node as npm.
        Returns what Node and a child of Node's held of the locks."""
        node = shutil.which("node")
        if node is None:
            self.skipTest("needs a real node on PATH")
        npm = self.bin / "npm"
        npm.write_text(f"#!{node}\n" + textwrap.dedent(NODE_NPM))
        npm.chmod(0o700)
        probe, report = script(self.tmp / "probe", LOCK_PROBE), self.tmp / "report.json"
        driver = ("import sys; sys.path.insert(0, sys.argv[1]); import check_all; "
                  "sys.exit(check_all.main(sys.argv[4:], root=__import__('pathlib').Path(sys.argv[2]), cache=__import__('pathlib').Path(sys.argv[3])))")
        result = subprocess.run([sys.executable, "-I", "-c", LEAKY_LAUNCHER, driver, str(TOOLS), str(self.root), str(self.cache), *argv],
                                env=self.env(FAKE_PROBE=str(probe), FAKE_REPORT=str(report)), capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(report.read_text())

    def test_the_locks_stay_below_descriptor_16_whatever_the_launcher_left_open_so_only_npm_holds_them(self):
        # libuv marks descriptors 0 to 15 close-on-exec, so a lock at 3 or 4 stays with npm. With 3 to 20 inherited
        # open, locks opened after them land at 21 and up, which Node hands to every child: the runner, its workers and
        # Playwright's web server, any of which could hold the slot for good.
        report = self.run_with_leaky_launcher("--only", "e2e")
        self.assertEqual(report["npm"], [3, 4])  # the heavy slot and the port pair, the lowest numbers there are
        self.assertEqual(report["grandchild"], [], "a child of npm still holds a lock")

    def test_a_lock_descriptor_node_would_pass_on_is_refused_before_anything_starts(self):
        marker = self.tmp / "started"
        script(self.tmp / "suite", "from pathlib import Path\nPath(%r).write_text('x')\n" % str(marker))
        held = check_all.try_lock(self.tmp / "x.lock")
        self.addCleanup(held.release)
        high = fcntl.fcntl(held.fd, fcntl.F_DUPFD, 16)  # the same lock file at the first descriptor number Node would pass on
        self.addCleanup(os.close, high)
        with self.assertRaisesRegex(RuntimeError, rf"\[{high}\] are 16 or higher"):
            check_all.run_process([str(self.tmp / "suite")], self.tmp, dict(os.environ), self.tmp / "log", 5, False, inherit=[held.fd, high])
        self.assertFalse(marker.exists())

    def test_a_slot_held_by_a_killed_run_names_the_live_suite_not_the_dead_run(self):
        process, _, port, locks = self.start_e2e_with_server()
        suite = int(self.calls()[0]["pid"])
        process.kill()
        process.communicate(timeout=5)
        self.assertNotEqual(process.pid, suite)
        with self.assertRaises(check_all.LockTimeout) as caught:
            check_all.acquire_slot(self.cache / "locks", 1, {"check": "second run"}, 0.3)
        named = int(re.search(r"pid (\d+)", str(caught.exception)).group(1))
        self.assertEqual(named, suite)
        self.assertTrue(self.alive(named))
        self.assertFalse(self.alive(process.pid))
        # The port pair's lock file names the suite too.
        self.assertEqual(check_all.read_info(locks[0])["pid"], suite)
        self.assertEqual(check_all.read_info(locks[1])["check"], "e2e")  # the rest of the holder's description is kept

    def test_a_stop_that_the_suite_ignores_kills_it_only_after_the_grace(self):
        script(self.tmp / "stubborn", """
            import signal, sys, time
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            print("ready", flush=True)
            time.sleep(60)
        """)
        with mock.patch.object(check_all, "STOP_GRACE", 1.0):
            started = time.monotonic()
            code, output = check_all.run_process([str(self.tmp / "stubborn")], self.tmp, dict(os.environ), self.tmp / "log", 0.3, False)
            took = time.monotonic() - started
        self.assertIsNone(code)
        self.assertIn("ready", output)
        self.assertGreaterEqual(took, 1.2)  # the 0.3s timeout, then the whole 1s grace
        self.assertLess(took, 5)

    def test_a_stop_returns_only_when_a_descendant_that_ignores_it_and_closed_its_output_is_gone_too(self):
        # No pipe holds run_process open for this one, so only the stop itself can make it wait for the group.
        script(self.tmp / "parent", """
            import signal, subprocess, sys, time
            from pathlib import Path
            child = subprocess.Popen([sys.executable, "-c", "import signal, time; signal.signal(signal.SIGINT, signal.SIG_IGN); time.sleep(60)"],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            Path(sys.argv[1]).write_text(str(child.pid))
            signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
            time.sleep(60)
        """)
        pidfile = self.tmp / "descendant.pid"
        self.addCleanup(lambda: pidfile.exists() and self.kill_quietly(int(pidfile.read_text())))
        with mock.patch.object(check_all, "STOP_GRACE", 1.0):
            check_all.run_process([str(self.tmp / "parent"), str(pidfile)], self.tmp, dict(os.environ), self.tmp / "log", 0.5, False)
        self.assertFalse(self.alive(int(pidfile.read_text())))

    def test_a_stop_that_the_suite_honors_ends_at_once_with_its_own_cleanup_not_a_kill(self):
        script(self.tmp / "polite", """
            import signal, sys, time
            from pathlib import Path
            def clean(signum, frame):
                Path(sys.argv[1]).write_text("cleaned up")
                sys.exit(0)
            signal.signal(signal.SIGINT, clean)
            print("ready", flush=True)
            time.sleep(60)
        """)
        marker = self.tmp / "cleanup-marker"
        with mock.patch.object(check_all, "STOP_GRACE", 10.0):
            started = time.monotonic()
            code, _ = check_all.run_process([str(self.tmp / "polite"), str(marker)], self.tmp, dict(os.environ), self.tmp / "log", 0.3, False)
            took = time.monotonic() - started
        self.assertIsNone(code)
        self.assertEqual(marker.read_text(), "cleaned up")
        self.assertLess(took, 3)

    def test_the_command_file_runs_and_describes_itself(self):
        result = subprocess.run([str(TOOLS / "check-all"), "--help"], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0)
        text = " ".join(result.stdout.split())
        self.assertIn("--heavy-slots", text)
        self.assertIn("typecheck, lint, ruff, test, build, e2e, py", text)

    def test_old_logs_are_pruned_but_the_current_run_and_newer_ones_stay(self):
        logs = self.cache / "logs"
        for index in range(35):
            (logs / f"2026010{index // 10}T0{index % 10}0000-1-old").mkdir(parents=True)
        self.run_main("--only", "lint")
        remaining = sorted(path.name for path in logs.iterdir())
        self.assertEqual(len(remaining), 31)  # 30 kept plus this run's
        self.assertTrue(any(name.endswith(f"-{self.root.name}") for name in remaining))


if __name__ == "__main__":
    unittest.main()
