"""Activation opens its docs PR from a temporary worktree, using fake gh and git on PATH."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".agents/tools"))
spec = importlib.util.spec_from_file_location("release_app", ROOT / ".agents/tools/release-app.py")
release_app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_app)

NAME = "release-7fac68e4-20261013T181252Z"
BRANCH = "docs/record-" + NAME
REAL_GIT = shutil.which("git")
# Records every call. "pr list --head" answers with that branch's PRs; a "fail-gh" file fails "pr create".
FAKE_GH = """
import json, pathlib, sys
state = pathlib.Path(__file__).with_name("gh-state")
state.mkdir(exist_ok=True)
with (state / "calls.jsonl").open("a") as calls: calls.write(json.dumps(sys.argv[1:]) + "\\n")
prs = state / "prs.json"
known = json.loads(prs.read_text()) if prs.exists() else {}
flags = dict(zip(sys.argv[3::2], sys.argv[4::2]))
if sys.argv[1:3] == ["pr", "list"]:
    print(known.get(flags["--head"], ""))
elif sys.argv[1:3] == ["pr", "create"]:
    if (state / "fail-gh").exists():
        print("GraphQL: could not create pull request", file=sys.stderr); raise SystemExit(1)
    url = "https://github.com/owner/repo/pull/" + str(99 + len(known))
    prs.write_text(json.dumps({**known, flags["--head"]: url})); print(url)
"""
# Real git, logging each call, except that a "fail-push" file makes every push fail.
FAKE_GIT = f"""
import json, os, pathlib, sys
with pathlib.Path(__file__).with_name("git-calls.jsonl").open("a") as calls: calls.write(json.dumps(sys.argv[1:]) + "\\n")
if "push" in sys.argv[1:] and pathlib.Path(__file__).with_name("fail-push").exists():
    print("fatal: unable to access remote", file=sys.stderr); raise SystemExit(128)
os.execv({REAL_GIT!r}, [{REAL_GIT!r}, *sys.argv[1:]])
"""


class DocsPullRequest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        work = Path(temporary.name)
        self.bin = work / "bin"
        self.bin.mkdir()
        for name, body in (("gh", FAKE_GH), ("git", FAKE_GIT)):
            (self.bin / name).write_text("#!" + sys.executable + "\n" + body)
            (self.bin / name).chmod(0o700)
        empty = work / "gitconfig"
        empty.write_text("")
        environment = mock.patch.dict(os.environ, {
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"], "GIT_CONFIG_GLOBAL": str(empty),
            # Only local file remotes: a stray command can never reach a real repository.
            "GIT_ALLOW_PROTOCOL": "file",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "Operator", "GIT_AUTHOR_EMAIL": "operator@example.test",
            "GIT_COMMITTER_NAME": "Operator", "GIT_COMMITTER_EMAIL": "operator@example.test"})
        environment.start()
        self.addCleanup(environment.stop)
        self.origin = work / "origin.git"
        self.git("init", "--quiet", "--bare", "--initial-branch=main", str(self.origin))
        seed = work / "seed"
        self.git("clone", "--quiet", str(self.origin), str(seed))
        (seed / "docs/evidence").mkdir(parents=True)
        (seed / "docs/evidence/earlier.json").write_text("{}\n")
        (seed / "docs/ValidationLedger.md").write_text("# Validation ledger\n\n## Earlier release\n")
        (seed / ".gitignore").write_text(".private/\n")
        self.git("-C", str(seed), "add", ".")
        self.git("-C", str(seed), "commit", "--quiet", "-m", "Seed")
        self.git("-C", str(seed), "push", "--quiet", "origin", "HEAD:main")
        # The operator's checkout sits on an unrelated branch with its own edits.
        self.checkout = work / "checkout"
        self.git("clone", "--quiet", str(self.origin), str(self.checkout))
        self.git("-C", str(self.checkout), "switch", "--quiet", "-c", "feature")
        (self.checkout / "notes.txt").write_text("work in progress\n")
        self.seed = seed
        saved = (release_app.ROOT, release_app.MANIFESTS, release_app.guarded, release_app.verify_release, release_app.remote)
        def restore():
            (release_app.ROOT, release_app.MANIFESTS, release_app.guarded, release_app.verify_release, release_app.remote) = saved
        self.addCleanup(restore)
        release_app.ROOT, release_app.MANIFESTS = self.checkout, work / "manifests"
        release_app.remote = lambda host, program, payload: {"current": "/srv/app/releases/old", "workerSha256": "worker"}
        release_app.guarded = lambda host, manifest, check: {"webBuild": "b" * 16}
        release_app.verify_release = lambda manifest: ({"maintenanceCleared": True}, None)
        self.prepare(NAME)

    def prepare(self, name):
        release_app.save_manifest({"name": name, "status": "prepared", "host": "host",
            "commit": "7fac68e44e7d" + "0" * 28, "origin": "https://app.example.test", "webBuild": "b" * 16,
            "archiveSha256": "f" * 64, "hermesRevision": "1298c8e7" + "0" * 32, "qualification": "reused",
            "pullRequest": 73, "helperChanged": True, "appBase": "/srv/app", "operationId": "op",
            "expectedRelease": "/srv/app/releases/old", "workerSha256": "worker"})

    def worktree_paths(self):
        calls = [json.loads(line) for line in (self.bin / "git-calls.jsonl").read_text().splitlines()]
        return [Path(call[call.index("--detach") + 1]) for call in calls if call[:2] == ["worktree", "add"]]

    def git(self, *args):
        return subprocess.run([REAL_GIT, *args], check=True, capture_output=True, text=True).stdout.strip()

    def run_tool(self, *argv):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            release_app.main(list(argv))
        return output.getvalue()

    def gh_calls(self):
        calls = self.bin / "gh-state/calls.jsonl"
        return [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    def creates(self):
        return [call for call in self.gh_calls() if call[:2] == ["pr", "create"]]

    def branch_files(self, path):
        return self.git("--git-dir", str(self.origin), "show", f"{BRANCH}:{path}")

    def assert_checkout_untouched(self):
        self.assertEqual(self.git("-C", str(self.checkout), "branch", "--show-current"), "feature")
        self.assertEqual(len(self.git("-C", str(self.checkout), "worktree", "list").splitlines()), 1)
        self.assertEqual((self.checkout / "notes.txt").read_text(), "work in progress\n")

    def test_activation_opens_one_docs_pr_from_the_latest_main(self):
        # Main moved on after the operator's clone; the PR must start from its latest tip.
        (self.seed / "docs/evidence/later.json").write_text("{}\n")
        self.git("-C", str(self.seed), "add", ".")
        self.git("-C", str(self.seed), "commit", "--quiet", "-m", "Later")
        self.git("-C", str(self.seed), "push", "--quiet", "origin", "HEAD:main")
        main = self.git("--git-dir", str(self.origin), "rev-parse", "main")
        output = self.run_tool("activate", NAME)
        self.assertIn("Opened the docs PR: https://github.com/owner/repo/pull/99", output)
        self.assertEqual(release_app.load_manifest(NAME)["status"], "recorded")
        [create] = self.creates()
        flags = dict(zip(create[2::2], create[3::2]))
        self.assertEqual((flags["--base"], flags["--head"], flags["--title"]), ("main", BRANCH, "Record the #73 deployment"))
        self.assertTrue(flags["--body"].startswith(f"Records the production release of #73 (`{NAME}`)."))
        self.assertIn("`--accept-helper-change`", flags["--body"])
        self.assertIn("Hermes stayed at `1298c8e7`.", flags["--body"])
        self.assertTrue(flags["--body"].endswith("\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n"))
        self.assertEqual(self.git("--git-dir", str(self.origin), "rev-parse", BRANCH + "^"), main)
        self.assertEqual(self.git("--git-dir", str(self.origin), "log", "-1", "--format=%s", BRANCH), "Record the #73 deployment")
        self.assertEqual(sorted(self.git("--git-dir", str(self.origin), "diff", "--name-only", main, BRANCH).splitlines()),
                         ["docs/ValidationLedger.md", f"docs/evidence/production-{NAME}.json"])
        ledger = self.branch_files("docs/ValidationLedger.md")
        self.assertTrue(ledger.startswith("# Validation ledger\n\n## "))
        self.assertEqual(ledger.count("app release 7fac68e"), 1)
        self.assertEqual(json.loads(self.branch_files(f"docs/evidence/production-{NAME}.json"))["release"], NAME)
        self.assert_checkout_untouched()
        # The worktree lived in the checkout's ignored .private, and is gone.
        worktrees = self.checkout / ".private/docs-pr-worktrees"
        [path] = self.worktree_paths()
        self.assertEqual(path.parent.parent, worktrees)
        self.assertEqual(list(worktrees.iterdir()), [])
        self.assertNotIn(".private", self.git("-C", str(self.checkout), "status", "--porcelain", "--untracked-files=all"))
        # Rerunning finds the PR instead of pushing or opening another.
        self.assertIn("already exists: https://github.com/owner/repo/pull/99", self.run_tool("record", NAME))
        self.assertEqual(len(self.creates()), 1)

    def test_a_failed_push_warns_keeps_the_release_recorded_and_can_be_retried(self):
        (self.bin / "fail-push").touch()
        output = self.run_tool("activate", NAME)
        self.assertIn("Warning: the docs PR was not opened", output)
        self.assertIn(f"Retry with: release-app.py record {NAME}", output)
        self.assertIn(f"gh pr create --base main --head {BRANCH} --title 'Record the #73 deployment'", output)
        self.assertEqual(release_app.load_manifest(NAME)["status"], "recorded")
        self.assertEqual(self.creates(), [])
        self.assertTrue((self.checkout / f"docs/evidence/production-{NAME}.json").is_file())
        self.assert_checkout_untouched()
        (self.bin / "fail-push").unlink()
        self.assertIn("Opened the docs PR", self.run_tool("record", NAME))
        self.assertEqual(len(self.creates()), 1)

    def test_a_pushed_branch_without_its_pr_is_reused(self):
        (self.bin / "gh-state").mkdir()
        (self.bin / "gh-state/fail-gh").touch()
        self.assertIn("could not create pull request", self.run_tool("activate", NAME))
        pushed = self.git("--git-dir", str(self.origin), "rev-parse", BRANCH)
        (self.bin / "gh-state/fail-gh").unlink()
        self.assertIn("Opened the docs PR", self.run_tool("record", NAME))
        self.assertEqual(self.git("--git-dir", str(self.origin), "rev-parse", BRANCH), pushed)
        self.assertEqual(len(self.creates()), 2, "The failed attempt and its retry")
        self.assertEqual(json.loads((self.bin / "gh-state/prs.json").read_text()), {BRANCH: "https://github.com/owner/repo/pull/99"})

    def test_records_already_on_main_need_no_pr(self):
        self.run_tool("activate", NAME, "--no-docs-pr")
        self.assertEqual(self.gh_calls(), [])
        # Recorded by hand and merged under another branch name.
        manifest = release_app.load_manifest(NAME)
        release_app.write_records(self.seed, manifest)
        self.git("-C", str(self.seed), "add", ".")
        self.git("-C", str(self.seed), "commit", "--quiet", "-m", "Record by hand")
        self.git("-C", str(self.seed), "push", "--quiet", "origin", "HEAD:main")
        self.assertIn("origin/main already records this release", self.run_tool("record", NAME))
        self.assertEqual(self.creates(), [])
        self.assertEqual(self.git("--git-dir", str(self.origin), "branch", "--list", BRANCH), "")
        self.assert_checkout_untouched()

    def test_a_second_release_of_the_same_commit_on_the_same_day_gets_its_own_pr_and_entry(self):
        self.assertIn("pull/99", self.run_tool("activate", NAME))
        second = NAME[:-7] + "235959Z"
        self.prepare(second)
        self.assertIn("Opened the docs PR: https://github.com/owner/repo/pull/100", self.run_tool("activate", second))
        heads = [dict(zip(call[2::2], call[3::2]))["--head"] for call in self.creates()]
        self.assertEqual(heads, [BRANCH, "docs/record-" + second])
        ledger = self.git("--git-dir", str(self.origin), "show", f"docs/record-{second}:docs/ValidationLedger.md")
        self.assertIn(f"(evidence/production-{second}.json)", ledger)
        local = (self.checkout / "docs/ValidationLedger.md").read_text()
        self.assertEqual((local.count(f"(evidence/production-{NAME}.json)"), local.count(f"(evidence/production-{second}.json)")), (1, 1))

    def test_the_ledger_write_skips_only_an_entry_for_the_same_receipt(self):
        ledger = self.seed / "docs/ValidationLedger.md"
        entry = lambda receipt: f"## October 13 app release 7fac68e\n\n[production receipt](evidence/{receipt})\n"
        self.assertTrue(release_app.insert_ledger_entry(ledger, entry("first.json"), "first.json"))
        self.assertFalse(release_app.insert_ledger_entry(ledger, entry("first.json"), "first.json"))
        self.assertTrue(release_app.insert_ledger_entry(ledger, entry("second.json"), "second.json"))
        self.assertEqual(ledger.read_text(), "# Validation ledger\n\n" + entry("second.json") + "\n" + entry("first.json")
                         + "\n## Earlier release\n")


if __name__ == "__main__":
    unittest.main()
