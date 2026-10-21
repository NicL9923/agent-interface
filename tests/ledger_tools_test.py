"""The ledger-aware tools, run against throwaway git repositories."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".agents/tools"
ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_ALLOW_PROTOCOL": "file",
       "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.test",
       "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.test"}


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True, capture_output=True, text=True).stdout.strip()


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class SourceState(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        git(self.repo, "init", "--quiet")
        (self.repo / ".agents/tools").mkdir(parents=True)
        # The tool finds the repository from its own location.
        shutil.copy(TOOLS / "source-state.py", self.repo / ".agents/tools/source-state.py")
        write(self.repo / "src/app.ts", "export {};\n")
        write(self.repo / "docs/ValidationLedger.md", "# Validation ledger\n")

    def fingerprint(self, *prefixes):
        out = subprocess.run([sys.executable, "-I", ".agents/tools/source-state.py", *prefixes], cwd=self.repo, env=ENV,
                             check=True, capture_output=True, text=True).stdout.strip()
        return re.fullmatch(r"(sha256:[0-9a-f]{64}) \((\d+) source files\)", out).groups()

    def test_the_ledger_archive_and_entries_do_not_change_the_fingerprint(self):
        before = self.fingerprint()
        write(self.repo / "docs/ValidationLedger.md", "# Validation ledger\n\n## More\n")
        write(self.repo / "docs/ledger/20261021T190417Z-app-release-f257cc09.md", "# Entry\n")
        write(self.repo / "docs/ledger/README.md", "# Entries\n")
        # Tracked or untracked, the ledger stays out.
        git(self.repo, "add", "docs/ledger")
        self.assertEqual(self.fingerprint(), before)

    def test_other_docs_and_source_still_change_it(self):
        before, count = self.fingerprint()
        write(self.repo / "docs/ledgers.md", "not the ledger directory\n")
        self.assertEqual(self.fingerprint()[1], str(int(count) + 1))
        self.assertNotEqual(self.fingerprint()[0], before)
        changed = self.fingerprint()[0]
        write(self.repo / "src/app.ts", "export const changed = 1;\n")
        self.assertNotEqual(self.fingerprint()[0], changed)
        self.assertEqual(self.fingerprint("src/")[1], "1")


class MergeLedgerMain(unittest.TestCase):
    """A docs branch cut before the archive gained its header still merges cleanly."""

    def test_the_archive_conflict_keeps_mains_header_and_the_branchs_own_entries(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        work = Path(temporary.name)
        origin = work / "origin.git"
        git(work, "init", "--quiet", "--bare", "--initial-branch=main", str(origin))
        main = work / "main"
        git(work, "clone", "--quiet", str(origin), str(main))
        archive = Path("docs/ValidationLedger.md")
        write(main / archive, "# Validation ledger\n\n## Old release\n\nOld text.\n")
        git(main, "add", ".")
        git(main, "commit", "--quiet", "-m", "Seed")
        git(main, "push", "--quiet", "origin", "HEAD:main")
        branch = work / "branch"
        git(work, "clone", "--quiet", str(origin), str(branch))
        git(branch, "switch", "--quiet", "-c", "docs/record-x")
        write(branch / archive, "# Validation ledger\n\n## Branch release\n\nBranch text.\n\n## Old release\n\nOld text.\n")
        git(branch, "commit", "--quiet", "-am", "Record branch release")
        # Main froze the archive and moved on after the branch was cut.
        write(main / archive, "# Validation ledger\n\n> Frozen archive.\n\n## Newer release\n\nNewer text.\n\n## Old release\n\nOld text.\n")
        git(main, "commit", "--quiet", "-am", "Freeze archive")
        git(main, "push", "--quiet", "origin", "HEAD:main")
        output = subprocess.run([sys.executable, "-I", str(TOOLS / "merge-ledger-main.py")], cwd=branch, env=ENV,
                                check=True, capture_output=True, text=True).stdout
        self.assertIn("this branch's 1 on top", output)
        self.assertEqual((branch / archive).read_text(),
                         "# Validation ledger\n\n> Frozen archive.\n\n## Branch release\n\nBranch text.\n\n"
                         "## Newer release\n\nNewer text.\n\n## Old release\n\nOld text.\n")
        self.assertEqual(git(branch, "status", "--porcelain"), "")


if __name__ == "__main__":
    unittest.main()
