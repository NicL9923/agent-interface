"""Crash-safe writes, owner-only checks and the one sibling loader shared by the add-on."""
import ast
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from support import ROOT, load_source

private_fs = load_source("src/hermes/private_fs.py")


class AtomicWriteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(os.umask, os.umask(0o022))

    def test_replaces_the_file_with_the_requested_mode_and_leaves_no_temporary(self):
        target = self.root / "state.json"
        target.write_text("old")
        private_fs.atomic_json(target, {"phase": "ready"})
        self.assertEqual(json.loads(target.read_text()), {"phase": "ready"})
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        private_fs.atomic_write(target, "text", mode=0o644)
        self.assertEqual((target.read_text(), stat.S_IMODE(target.stat().st_mode)), ("text", 0o644))
        private_fs.atomic_write(target, b"\x00bytes")
        self.assertEqual(target.read_bytes(), b"\x00bytes")
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["state.json"])

    def test_a_failed_write_keeps_the_old_file_removes_its_temporary_and_a_retry_succeeds(self):
        target = self.root / "computer.env"
        target.write_text("old")
        for failing in ("fsync", "replace"):
            with self.subTest(failing=failing), patch.object(private_fs.os, failing, side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    private_fs.atomic_write(target, "new")
                self.assertEqual(target.read_text(), "old")
                self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["computer.env"])
        private_fs.atomic_write(target, "new")
        self.assertEqual(target.read_text(), "new")

    def test_the_directory_is_synced_after_the_rename(self):
        target = self.root / "lease.json"
        synced = []
        real_fsync = os.fsync
        def fsync(fd):
            synced.append(stat.S_ISDIR(os.fstat(fd).st_mode) and target.exists())
            real_fsync(fd)
        with patch.object(private_fs.os, "fsync", fsync):
            private_fs.atomic_json(target, {})
        self.assertEqual(synced, [False, True])


class OwnerPrivateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)
        self.file = self.root / "config.json"
        self.file.write_text("{}")
        self.file.chmod(0o600)
        self.folder = self.root / "state"
        self.folder.mkdir(mode=0o700)

    def test_accepts_owner_only_files_directories_and_descriptors(self):
        self.assertEqual(private_fs.owner_private(self.file).st_size, 2)
        self.assertTrue(private_fs.owner_private(self.file, max_bytes=2))
        self.assertTrue(private_fs.owner_private(self.folder, "dir"))
        fd = os.open(self.file, os.O_RDONLY | os.O_NOFOLLOW)
        self.addCleanup(os.close, fd)
        self.assertTrue(private_fs.owner_private(fd, max_bytes=4096))

    def test_refuses_other_types_links_shared_modes_and_oversize(self):
        fifo = self.root / "fifo"
        os.mkfifo(fifo, 0o600)
        link = self.root / "link"
        link.symlink_to(self.file)
        folder_link = self.root / "folder-link"
        folder_link.symlink_to(self.folder)
        shared = self.root / "shared.json"
        shared.write_text("{}")
        shared.chmod(0o640)
        open_folder = self.root / "open"
        open_folder.mkdir(mode=0o700)
        open_folder.chmod(0o750)
        for path, kind, limit in ((fifo, "file", None), (self.folder, "file", None), (self.file, "dir", None),
                                  (link, "file", None), (folder_link, "dir", None), (shared, "file", None),
                                  (open_folder, "dir", None), (self.file, "file", 1)):
            with self.subTest(path=path.name, kind=kind, limit=limit):
                self.assertIsNone(private_fs.owner_private(path, kind, limit))
        with self.assertRaises(FileNotFoundError):
            private_fs.owner_private(self.root / "missing")


def sibling_loaders():
    for path in sorted((ROOT / "src/hermes").glob("*.py")):
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.FunctionDef) and node.name == "sibling_module":
                yield path.name, ast.dump(node)


class SiblingLoaderTests(unittest.TestCase):
    def test_every_add_on_copy_of_the_loader_is_identical(self):
        loaders = dict(sibling_loaders())
        self.assertGreaterEqual(set(loaders), {"extension.py", "gateway_guard.py", "dashboard.py", "computer_host.py", "computer.py", "integrations.py"})
        self.assertEqual(len(set(loaders.values())), 1, sorted(loaders))

    def add_on_copy(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name in ("computer.py", "private_fs.py"):
            shutil.copy(ROOT / "src/hermes" / name, directory.name)
        return Path(directory.name)

    def test_one_instance_per_process_and_a_second_tree_fails_loudly(self):
        with patch.dict(sys.modules):
            sys.modules.pop("agent_interface_private_fs", None)
            computer = load_source("src/hermes/computer.py", "private_fs_test_computer")
            self.assertIs(computer.sibling_module("private_fs"), computer.private_fs)
            self.assertIs(sys.modules["agent_interface_private_fs"], computer.private_fs)
            with self.assertRaisesRegex(ImportError, "agent_interface_private_fs is already loaded from"):
                load_source(self.add_on_copy() / "computer.py", "private_fs_test_other_tree")

    def test_a_module_that_fails_to_load_is_not_cached(self):
        copy = self.add_on_copy()
        (copy / "broken.py").write_text("raise RuntimeError('broken add-on module')\n")
        with patch.dict(sys.modules):
            sys.modules.pop("agent_interface_private_fs", None)
            computer = load_source(copy / "computer.py", "private_fs_test_copy")
            with self.assertRaisesRegex(RuntimeError, "broken add-on module"):
                computer.sibling_module("broken")
            self.assertNotIn("agent_interface_broken", sys.modules)


class ShippedInputTests(unittest.TestCase):
    def test_every_add_on_and_upgrade_module_is_a_qualification_input(self):
        # A receipt binds only listed files. An unlisted module the add-on loads could
        # change after qualification without invalidating the receipt.
        inputs = set(json.loads((ROOT / "src/shared/qualification-inputs.json").read_text()))
        shipped = {str(path.relative_to(ROOT)) for path in (*ROOT.glob("src/hermes/*.py"), *ROOT.glob("scripts/hermes-*.py"))
                   if not path.name.endswith("-test.py")}
        self.assertEqual(shipped - inputs, set())


if __name__ == "__main__":
    unittest.main()
