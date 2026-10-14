"""Host programs held in tool strings compile as executed and use only defined names.

compileall cannot see code inside strings, and CI has no pyflakes. This finds every
module-level REMOTE* constant in .agents/tools, composes it exactly as it is sent and
checks it with the standard library. Tool scripts get the same undefined-name check.
"""
import ast
import builtins
import importlib.util
import os
from pathlib import Path
import subprocess
import symtable
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".agents/tools"
sys.path.insert(0, str(TOOLS))
import deploy_common  # noqa: E402
MODULE_NAMES = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__spec__", "__loader__",
                                     "__package__", "__builtins__", "__cached__"}


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release_app = load(TOOLS / "release-app.py")


def undefined_globals(source, filename):
    """Global names a program reads but never binds, other than builtins."""
    top = symtable.symtable(source, filename, "exec")
    defined = {symbol.get_name() for symbol in top.get_symbols()
               if symbol.is_assigned() or symbol.is_imported() or symbol.is_namespace()}
    used = set()
    def visit(table):
        for symbol in table.get_symbols():
            if symbol.is_referenced() and (table is top or symbol.is_global()):
                used.add(symbol.get_name())
            if table is not top and symbol.is_declared_global() and symbol.is_assigned():
                defined.add(symbol.get_name())
        for child in table.get_children():
            visit(child)
    visit(top)
    return sorted(used - defined - MODULE_NAMES)


def sends_with_prelude(tree):
    """A tool that calls release-app's remote() sends programs after REMOTE_PRELUDE and PAYLOAD."""
    return any(isinstance(node, ast.Call) and "remote" in (getattr(node.func, "id", None), getattr(node.func, "attr", None))
               for node in ast.walk(tree))


def host_programs():
    """(label, source exactly as executed) for every REMOTE* constant in the tools."""
    programs = []
    for path in sorted(TOOLS.glob("*.py")):
        tree = ast.parse(path.read_text())
        constants = {target.id: node.value for node in tree.body if isinstance(node, ast.Assign)
                     for target in node.targets if isinstance(target, ast.Name) and target.id.startswith("REMOTE")}
        constants.pop("REMOTE_PRELUDE", None)  # Compiled as the head of every composed program.
        module = None
        for name, node in constants.items():
            if isinstance(node, ast.Constant):
                value = node.value
            else:
                # A composed constant needs its module. Such tools keep their work under main().
                module = module or load(path)
                value = getattr(module, name)
            source = release_app.remote_source(value, {}) if sends_with_prelude(tree) else value
            programs.append((f"{path.name}:{name}", source))
    return programs


class CheckerTests(unittest.TestCase):
    def test_flags_names_read_but_never_bound(self):
        self.assertEqual(undefined_globals("import os\nx = os.sep + missing_at_top\n", "t"), ["missing_at_top"])
        self.assertEqual(undefined_globals("def f():\n    return later_typo\n", "t"), ["later_typo"])
        self.assertEqual(undefined_globals("rows = [shared for _ in range(2)]\n", "t"), ["shared"])
        self.assertEqual(undefined_globals("try:\n    pass\nexcept Missing:\n    pass\n", "t"), ["Missing"])
        self.assertEqual(undefined_globals("def f(a):\n    def g():\n        return a, len(b)\n    return g\nb = 1\n", "t"), [])


class HostProgramTests(unittest.TestCase):
    def test_discovers_every_program_release_tools_send(self):
        labels = {label for label, _ in host_programs()}
        self.assertLessEqual({"release-app.py:REMOTE_BUILD", "release-app.py:REMOTE_LIVE", "release-app.py:REMOTE_VERIFY",
                              "qualify-app-release.py:REMOTE", "stage-recovery-tools.py:REMOTE",
                              "archive-app-qualification.py:REMOTE"}, labels)

    def test_every_program_sent_to_the_host_is_a_discovered_constant(self):
        # A program passed to remote() under another name would escape these checks.
        for path in sorted(TOOLS.glob("*.py")):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.Call) and "remote" in (getattr(node.func, "id", None), getattr(node.func, "attr", None)) and len(node.args) >= 2:
                    program = node.args[1]
                    name = getattr(program, "id", None) or getattr(program, "attr", None)
                    self.assertTrue(name and name.startswith("REMOTE"), f"{path.name}:{node.lineno} sends {ast.unparse(program)}")

    def test_programs_compile_and_use_only_defined_names_as_executed(self):
        for label, source in host_programs():
            with self.subTest(program=label):
                compile(source, label, "exec")
                self.assertEqual(undefined_globals(source, label), [])


    def test_every_program_refuses_to_run_with_assert_guards_stripped(self):
        refusal = ast.dump(ast.parse(deploy_common.OPTIMIZED_REFUSAL).body[0])
        for label, source in host_programs():
            with self.subTest(program=label):
                self.assertEqual(ast.dump(ast.parse(source).body[0]), refusal, "The -O refusal must run first")
        live = release_app.remote_source(release_app.REMOTE_LIVE, {"appBase": "/nonexistent"})
        for argv, environment in ((["-O", "-"], {}), (["-"], {"PYTHONOPTIMIZE": "1"})):
            with self.subTest(argv=argv, environment=environment):
                done = subprocess.run([sys.executable, *argv], input=live, capture_output=True, text=True,
                                      env={**os.environ, **environment})
                self.assertNotEqual(done.returncode, 0)
                self.assertIn("need their assert guards", done.stderr)
                self.assertEqual(done.stdout, "")


class ToolScriptTests(unittest.TestCase):
    def test_tool_scripts_use_only_defined_names(self):
        for path in sorted(TOOLS.glob("*.py")):
            with self.subTest(tool=path.name):
                self.assertEqual(undefined_globals(path.read_text(), path.name), [])


if __name__ == "__main__":
    unittest.main()
