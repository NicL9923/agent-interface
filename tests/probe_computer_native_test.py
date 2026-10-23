"""The computer probe stages every add-on module beside the probe it runs."""
import ast
import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from support import ROOT, load_source

sys.path.insert(0, str(ROOT / ".agents/tools"))
tool = load_source(".agents/tools/probe-computer-native.py", "probe_computer_native_under_test")


class StageFilesTests(unittest.TestCase):
    def test_a_new_sibling_module_is_staged_without_editing_the_tool(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src/hermes").mkdir(parents=True)
            (root / "scripts/spike").mkdir(parents=True)
            for name in ("computer.py", "private_fs.py", "added_later.py"):
                (root / "src/hermes" / name).write_text("# " + name + "\n")
            (root / "scripts/spike/computer_probe.py").write_text("# probe\n")
            files = tool.stage_files("scripts/spike/computer_probe.py", root)
        self.assertEqual(set(files), {"src/hermes/computer.py", "src/hermes/private_fs.py", "src/hermes/added_later.py",
                                      "scripts/spike/computer_probe.py"})
        self.assertEqual(base64.b64decode(files["src/hermes/added_later.py"]), b"# added_later.py\n")

    def test_the_run_ships_every_repository_module_and_the_selected_probe(self):
        with patch.object(tool.host_access.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                self.assertRaises(SystemExit):
            tool.main(["--python", "/opt/hermes/bin/python"])
        command, sent = run.call_args.args[0], run.call_args.kwargs["input"]
        self.assertIn("BatchMode=yes", command)
        payload = json.loads(ast.literal_eval(sent.splitlines()[1].removeprefix("payload=json.loads(").removesuffix(")")))
        expected = {str(path.relative_to(ROOT)) for path in ROOT.glob("src/hermes/*.py")} | {"scripts/spike/computer_probe.py"}
        self.assertEqual(set(payload["files"]), expected)
        self.assertEqual(payload["probe"], "scripts/spike/computer_probe.py")


if __name__ == "__main__":
    unittest.main()
