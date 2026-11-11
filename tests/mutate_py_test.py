#!/usr/bin/env python3
"""`.agents/tools/mutate-py.py` against real files and real child processes, never a patched function of its own."""
import json
import os
import py_compile
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / ".agents" / "tools" / "mutate-py.py"

# The tool sets these for its command, and this suite can run under the tool, so every child here starts without them.
ENV = {key: value for key, value in os.environ.items() if key not in ("PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX")}
MODULE = "def value():\n    return 1\n"
CHECK = "import unittest, m\nclass T(unittest.TestCase):\n    def test_value(self): self.assertEqual(m.value(), 1)\nunittest.main()\n"


def wait_for(condition, what, seconds=15):
    """A hang detector, not a speed limit: the condition normally holds within milliseconds."""
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError(f"never saw {what}")
        time.sleep(0.01)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class ToolTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.repo = Path(directory.name)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        self.write("m.py", MODULE)
        self.write("check.py", CHECK)
        # Records are keyed by absolute path, so a leftover from another test never matches these temp paths.
        self.addCleanup(self.stop_children)
        self.children = []

    def stop_children(self):
        for child in self.children:
            try:
                os.killpg(child, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def write(self, name, text, newline=None):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode() if newline is None else text.replace("\n", newline).encode())
        return path

    def tool(self, *args, check_exit=None, timeout=60):
        result = subprocess.run([sys.executable, str(TOOL), *args], cwd=self.repo, env=ENV, capture_output=True, text=True, timeout=timeout, check=False)
        if check_exit is not None:
            self.assertEqual(result.returncode, check_exit, result.stdout + result.stderr)
        return result

    def rows(self, result):
        return [line for line in result.stdout.splitlines() if line.startswith("|")][2:]

    def snapshot(self, name):
        path = self.repo / name
        stat = path.stat()
        return path.read_bytes(), stat.st_mtime_ns, stat.st_mode

    def test_a_mutant_the_test_catches_is_a_failed_row_and_the_file_comes_back_exactly(self):
        before = self.snapshot("m.py")
        result = self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", sys.executable, "check.py", check_exit=0)
        self.assertEqual(result.stdout.splitlines()[:2], ["| Mutation | Result |", "| --- | --- |"])
        self.assertEqual(self.rows(result), ["| m.py: 'return 1' | failed: test_value (exit 1) |"])
        self.assertEqual(self.snapshot("m.py"), before)

    def test_a_mutant_nothing_catches_survives_and_the_tool_exits_1(self):
        result = self.tool("m.py", "--old", "return 1", "--new", "return 1 + 0", "--", sys.executable, "check.py", check_exit=1)
        self.assertEqual(self.rows(result), ["| m.py: 'return 1' | survived |"])

    def test_a_line_mutation_replaces_the_whole_line_and_keeps_its_crlf(self):
        self.write("m.py", MODULE, newline="\r\n")
        self.write("show.py", "print(repr(open('m.py', 'rb').read()))\n")
        before = self.snapshot("m.py")
        # The command prints the mutated file and fails, so the table's note carries what it saw.
        script = "import sys; data = open('m.py', 'rb').read(); sys.exit(0 if data == b'def value():\\r\\n    return 7\\r\\n' else 1)"
        result = self.tool("m.py", "--line", "2", "--new", "    return 7", "--", sys.executable, "-c", script, check_exit=1)
        self.assertEqual(self.rows(result), ["| m.py: line 2 | survived |"])
        self.assertEqual(self.snapshot("m.py"), before)

    def test_a_line_with_old_text_replaces_only_that_text_and_it_must_be_unique_in_the_line(self):
        self.write("m.py", "a = 1; b = 1\nc = 1\n")
        seen = "import sys; sys.exit(0 if open('m.py').read() == 'a = 1; b = 2\\nc = 1\\n' else 1)"
        # `1` occurs twice in line 1, so the line is refused; the longer text is unique there.
        refused = self.tool("m.py", "--line", "1", "--old", "1", "--new", "2", "--", sys.executable, "-c", seen, check_exit=2)
        self.assertEqual(self.rows(refused), ["| m.py: line 1 | error: line 1 holds the text 2 times, not once |"])
        self.tool("m.py", "--line", "1", "--old", "b = 1", "--new", "b = 2", "--", sys.executable, "-c", seen, check_exit=1)
        self.assertEqual((self.repo / "m.py").read_text(), "a = 1; b = 1\nc = 1\n")

    def test_a_mutation_that_cannot_apply_is_an_error_row_that_never_runs_the_command(self):
        marker = self.repo / "ran"
        command = [sys.executable, "-c", f"open({str(marker)!r}, 'w')"]
        for args, why in (
            (["--old", "missing", "--new", "x"], "the text occurs 0 times, not once"),
            (["--old", "return", "--new", "x", "--line", "9"], "line 9 is outside the file's 2 lines"),
            (["--old", "return 1", "--new", "return 1"], "the replacement changes nothing"),
        ):
            with self.subTest(why=why):
                before = self.snapshot("m.py")
                result = self.tool("m.py", *args, "--", *command, check_exit=2)
                self.assertIn(f"error: {why} |", self.rows(result)[0])
                self.assertEqual(self.snapshot("m.py"), before)
        self.write("m.py", "x = 1\nx = 1\n")
        again = self.tool("m.py", "--old", "x = 1", "--new", "x = 2", "--", *command, check_exit=2)
        self.assertIn("error: the text occurs 2 times, not once", again.stdout)
        self.assertFalse(marker.exists())
        missing = self.tool("nope.py", "--old", "a", "--new", "b", "--", *command, check_exit=2)
        self.assertIn("nope.py", missing.stdout)

    def test_a_command_that_does_not_exist_is_an_error_row_and_the_file_is_restored(self):
        before = self.snapshot("m.py")
        result = self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", "definitely-not-a-command", check_exit=2)
        self.assertIn("error: cannot run the command: definitely-not-a-command not found", result.stdout)
        self.assertEqual(self.snapshot("m.py"), before)

    def test_a_batch_prints_one_row_per_mutation_in_order_with_pipes_escaped_and_per_mutation_commands(self):
        self.write("batch.json", json.dumps([
            {"name": "Return 2 | caught", "file": "m.py", "old": "return 1", "new": "return 2"},
            {"name": "Equivalent", "file": "m.py", "line": 2, "new": "    return 1 + 0"},
            {"name": "Its own command", "file": "m.py", "old": "def value", "new": "def other",
             "command": f"{sys.executable} -c 'import sys; sys.exit(3)'"},
        ]))
        before = self.snapshot("m.py")
        result = self.tool("--batch", "batch.json", "--", sys.executable, "check.py", check_exit=1)
        self.assertEqual(self.rows(result), [
            "| Return 2 \\| caught | failed: test_value (exit 1) |",
            "| Equivalent | survived |",
            "| Its own command | failed: exit 3 |",
        ])
        self.assertEqual(self.snapshot("m.py"), before)

    def test_a_batch_is_checked_before_anything_runs(self):
        marker = self.repo / "ran"
        self.write("batch.json", json.dumps([{"file": "m.py", "new": "x"}]))
        result = self.tool("--batch", "batch.json", "--", sys.executable, "-c", f"open({str(marker)!r}, 'w')", check_exit=1)
        self.assertEqual(result.returncode, 1)
        self.assertIn("needs file, new, and old or line", result.stderr + result.stdout)
        self.assertFalse(marker.exists())
        self.write("batch.json", "not json")
        self.assertIn("cannot read the batch file", self.tool("--batch", "batch.json", "--", "true").stderr)

    def test_a_baseline_that_fails_stops_the_run_before_any_mutation(self):
        marker = self.repo / "mutated-run"
        script = f"import sys; open({str(marker)!r}, 'a').write('x'); sys.exit(1)"
        result = self.tool("m.py", "--old", "return 1", "--new", "return 2", "--baseline", "--", sys.executable, "-c", script, check_exit=2)
        self.assertIn("the unmutated command did not pass", result.stderr)
        self.assertEqual(marker.read_text(), "x")  # the baseline ran once; the mutant never did
        self.assertEqual((self.repo / "m.py").read_text(), MODULE)

    def test_a_child_killed_by_a_signal_is_a_failed_row_and_the_file_is_restored(self):
        before = self.snapshot("m.py")
        script = "import os, signal; os.kill(os.getpid(), signal.SIGKILL)"
        result = self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", sys.executable, "-c", script, check_exit=0)
        self.assertEqual(self.rows(result), ["| m.py: 'return 1' | failed: killed by SIGKILL |"])
        self.assertEqual(self.snapshot("m.py"), before)

    def test_a_command_that_outlives_the_timeout_is_an_error_row_and_its_children_die_with_it(self):
        pids = self.repo / "pids"
        script = ("import os, subprocess, sys, time\n"
                  "grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])\n"
                  f"open({str(pids)!r}, 'w').write(f'{{os.getpid()}} {{grandchild.pid}}')\n"
                  "time.sleep(600)\n")
        before = self.snapshot("m.py")
        result = self.tool("m.py", "--old", "return 1", "--new", "return 2", "--timeout", "1.5", "--", sys.executable, "-c", script, check_exit=2)
        self.assertEqual(self.rows(result), ["| m.py: 'return 1' | error: timed out after 1.5 s |"])
        child, grandchild = map(int, pids.read_text().split())
        wait_for(lambda: not alive(child) and not alive(grandchild), "the command's process group ending")
        self.assertEqual(self.snapshot("m.py"), before)

    def start_hanging_run(self, *extra):
        """The tool, running a command that reports its pid and then waits; returns once the mutant is on disk."""
        pids = self.repo / "hang.pids"
        pids.unlink(missing_ok=True)
        script = f"import os, time; open({str(pids)!r}, 'w').write(str(os.getpid())); time.sleep(600)"
        tool = subprocess.Popen([sys.executable, str(TOOL), "m.py", "--old", "return 1", "--new", "return 2", *extra, "--", sys.executable, "-c", script],
                                cwd=self.repo, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: tool.poll() is None and tool.kill())
        wait_for(lambda: pids.exists() and pids.read_text(), "the command starting")
        child = int(pids.read_text())
        self.children.append(child)
        self.assertEqual((self.repo / "m.py").read_text(), MODULE.replace("return 1", "return 2"))
        return tool, child

    def test_ctrl_c_stops_the_command_restores_the_file_and_exits_130(self):
        before = self.snapshot("m.py")
        tool, child = self.start_hanging_run()
        tool.send_signal(signal.SIGINT)
        out, err = tool.communicate(timeout=30)
        self.assertEqual(tool.returncode, 130)
        self.assertIn("stopped by SIGINT; the file was restored", err)
        wait_for(lambda: not alive(child), "the command stopping")
        self.assertEqual(self.snapshot("m.py"), before)

    def test_sigterm_restores_the_file_too(self):
        before = self.snapshot("m.py")
        tool, child = self.start_hanging_run()
        tool.send_signal(signal.SIGTERM)
        tool.communicate(timeout=30)
        self.assertEqual(tool.returncode, 128 + signal.SIGTERM)
        wait_for(lambda: not alive(child), "the command stopping")
        self.assertEqual(self.snapshot("m.py"), before)

    def test_a_killed_tool_leaves_the_mutant_and_the_next_run_restores_it_first(self):
        before = self.snapshot("m.py")
        tool, child = self.start_hanging_run()
        tool.kill()
        tool.communicate(timeout=30)
        # SIGKILL cannot be caught: the mutant stays, and the original waits in the private record.
        self.assertEqual((self.repo / "m.py").read_text(), MODULE.replace("return 1", "return 2"))
        os.killpg(child, signal.SIGKILL)
        result = self.tool("m.py", "--old", "return 1", "--new", "return 3", "--", sys.executable, "check.py", check_exit=0)
        self.assertIn("restored", result.stderr)
        self.assertEqual(self.rows(result), ["| m.py: 'return 1' | failed: test_value (exit 1) |"])
        self.assertEqual(self.snapshot("m.py"), before)

    def test_a_second_run_on_a_file_another_live_run_is_mutating_is_refused(self):
        tool, child = self.start_hanging_run()
        result = self.tool("m.py", "--old", "return 2", "--new", "return 3", "--", sys.executable, "check.py", check_exit=2)
        self.assertIn("error: another mutate-py run", result.stdout)
        # The refused run touched nothing: the first run's mutant is still what is on disk.
        self.assertEqual((self.repo / "m.py").read_text(), MODULE.replace("return 1", "return 2"))
        tool.send_signal(signal.SIGINT)
        tool.communicate(timeout=30)
        self.assertEqual((self.repo / "m.py").read_text(), MODULE)

    def test_a_same_size_mutant_in_the_same_second_runs_even_when_stale_bytecode_would_hide_it(self):
        source = self.write("stale.py", "x = 1\n")
        self.write("use.py", "import stale, sys\nsys.exit(0 if stale.x == 1 else 1)\n")
        stat = source.stat()
        # Beside the source, as an ordinary import writes it, whatever prefix this process runs under.
        pyc = self.repo / "__pycache__" / f"stale.{sys.implementation.cache_tag}.pyc"
        py_compile.compile(str(source), cfile=str(pyc), doraise=True)
        self.assertTrue(pyc.exists())
        # The trap, reproduced by hand: a same-size mutant with the original's mtime runs the old bytecode.
        source.write_text("x = 2\n")
        os.utime(source, ns=(stat.st_mtime_ns, stat.st_mtime_ns))
        self.assertEqual(subprocess.run([sys.executable, "use.py"], cwd=self.repo, env=ENV, check=False).returncode, 0, "the stale bytecode should hide the mutant")
        source.write_text("x = 1\n")
        os.utime(source, ns=(stat.st_mtime_ns, stat.st_mtime_ns))
        # The tool, on the same situation, sees the mutant and leaves no bytecode behind.
        result = self.tool("stale.py", "--old", "x = 1", "--new", "x = 2", "--keep-mtime", "--", sys.executable, "use.py", check_exit=0)
        self.assertEqual(self.rows(result), ["| stale.py: 'x = 1' | failed: exit 1 |"])
        self.assertEqual(source.read_text(), "x = 1\n")
        self.assertEqual(list(self.repo.rglob("__pycache__")), [])

    def test_every_pycache_under_the_repository_is_cleared_but_not_node_modules_or_git(self):
        for name in ("a/__pycache__/x.pyc", "a/b/__pycache__/y.pyc", "node_modules/pkg/__pycache__/z.pyc"):
            self.write(name, "stale")
        result = self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", sys.executable, "check.py", check_exit=0)
        self.assertEqual(result.returncode, 0)
        left = sorted(str(path.relative_to(self.repo)) for path in self.repo.rglob("__pycache__"))
        self.assertEqual(left, ["node_modules/pkg/__pycache__"])

    def test_the_command_runs_with_no_bytecode_writing_and_a_private_pycache_prefix(self):
        report = self.repo / "env.json"
        script = ("import json, os, sys; sys.dont_write_bytecode = False\n"
                  "sys.path.insert(0, os.getcwd()); import m\n"
                  f"open({str(report)!r}, 'w').write(json.dumps({{'env': os.environ['PYTHONDONTWRITEBYTECODE'], "
                  "'flag': sys.flags.dont_write_bytecode, 'prefix': os.environ['PYTHONPYCACHEPREFIX']}))\n")
        self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", sys.executable, "-c", script, check_exit=1)
        seen = json.loads(report.read_text())
        self.assertEqual((seen["env"], seen["flag"]), ("1", 1))
        self.assertFalse(Path(seen["prefix"]).exists())  # a fresh directory per run, removed after
        # Even a child that turns writing back on put its bytecode in that prefix, not beside the source.
        self.assertEqual(list(self.repo.rglob("__pycache__")), [])

    # A command that starts its own Python without the private prefix, as a wrapper script or `env -u` would.
    UNPREFIXED = ("import os, subprocess, sys\n"
                  "env = {k: v for k, v in os.environ.items() if k not in ('PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX')}\n"
                  "sys.exit(subprocess.run([sys.executable, *sys.argv[1:]], env=env).returncode)\n")

    def test_clearing_before_the_run_defeats_stale_bytecode_for_a_command_that_ignores_the_private_prefix(self):
        source = self.write("stale.py", "x = 1\n")
        self.write("use.py", "import stale, sys\nsys.exit(0 if stale.x == 1 else 1)\n")
        self.write("unprefixed.py", self.UNPREFIXED)
        stat = source.stat()
        pyc = self.repo / "__pycache__" / f"stale.{sys.implementation.cache_tag}.pyc"
        py_compile.compile(str(source), cfile=str(pyc), doraise=True)
        result = self.tool("stale.py", "--old", "x = 1", "--new", "x = 2", "--keep-mtime", "--", sys.executable, "unprefixed.py", "use.py", check_exit=0)
        self.assertEqual(self.rows(result), ["| stale.py: 'x = 1' | failed: exit 1 |"])
        self.assertEqual(source.stat().st_mtime_ns, stat.st_mtime_ns)

    def test_clearing_after_the_restore_removes_bytecode_a_command_compiled_from_the_mutant(self):
        self.write("unprefixed.py", self.UNPREFIXED)
        self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", sys.executable, "unprefixed.py", "check.py", check_exit=0)
        self.assertEqual(list(self.repo.rglob("__pycache__")), [])

    def test_dash_b_reaches_a_python_that_ignores_the_environment(self):
        report = self.repo / "flag"
        script = f"import sys; open({str(report)!r}, 'w').write(str(sys.flags.dont_write_bytecode))"
        # -I ignores PYTHON* variables, so only the -B the tool adds can set the flag.
        self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", sys.executable, "-I", "-c", script, check_exit=1)
        self.assertEqual(report.read_text(), "1")

    def test_a_file_the_command_deleted_comes_back_with_its_bytes_mode_and_mtime(self):
        path = self.repo / "m.py"
        path.chmod(0o640)
        os.utime(path, ns=(1_700_000_000_123_456_789,) * 2)
        before = self.snapshot("m.py")
        script = "import os; os.remove('m.py')"
        self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", sys.executable, "-c", script, check_exit=1)
        self.assertEqual(self.snapshot("m.py"), before)

    def test_a_restore_that_fails_exits_3_names_the_saved_original_and_the_next_run_finishes_it(self):
        path = self.repo / "m.py"
        before = self.snapshot("m.py")
        script = "import os; os.chmod('m.py', 0o444)"
        result = self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", sys.executable, "-c", script, check_exit=3)
        self.assertIn("could not be restored", result.stderr)
        self.assertIn("the original bytes are in", result.stderr)
        self.assertEqual(path.read_text(), MODULE.replace("return 1", "return 2"))
        path.chmod(0o644)
        again = self.tool("m.py", "--old", "missing", "--new", "x", "--", "true", check_exit=2)
        self.assertIn("restored", again.stderr)
        self.assertEqual(path.read_bytes(), before[0])

    def test_the_mode_and_mtime_come_back_with_the_bytes(self):
        path = self.repo / "m.py"
        path.chmod(0o640)
        os.utime(path, ns=(1_700_000_000_123_456_789,) * 2)
        before = self.snapshot("m.py")
        self.tool("m.py", "--old", "return 1", "--new", "return 2", "--", sys.executable, "check.py", check_exit=0)
        self.assertEqual(self.snapshot("m.py"), before)
        self.assertEqual(before[1], 1_700_000_000_123_456_789)


if __name__ == "__main__":
    unittest.main()
