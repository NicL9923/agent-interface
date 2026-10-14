#!/usr/bin/env python3
"""Merge origin/main into the checked-out docs branch, resolving ledger conflicts.

Every release PR adds its entry at the top of docs/ValidationLedger.md, so two open
release PRs always conflict there. The resolved ledger is main's, with this branch's
own entries (any main lacks) on top in their original order. Any other conflict
aborts the merge untouched. Pass --push to push the merge commit.
"""
import subprocess
import sys

LEDGER = "docs/ValidationLedger.md"
TITLE = "# Validation ledger\n\n"


def git(*args, check=True):
    return subprocess.run(["git", *args], check=check, capture_output=True, text=True)


def sections(text):
    """Entries keyed by heading, in order and verbatim, after the title."""
    if not text.startswith(TITLE): raise SystemExit("The ledger no longer starts with its title")
    lines = text[len(TITLE):].splitlines(keepends=True)
    starts = [index for index, line in enumerate(lines) if line.startswith("## ")] + [len(lines)]
    if starts[0] != 0: raise SystemExit("The ledger has text before its first entry")
    return [(lines[a].rstrip("\n"), "".join(lines[a:b])) for a, b in zip(starts, starts[1:])]


def main():
    branch = git("branch", "--show-current").stdout.strip()
    if not branch.startswith("docs/"): raise SystemExit("Check out the docs branch to merge first")
    if git("status", "--porcelain", "--untracked-files=no").stdout.strip(): raise SystemExit("The checkout has uncommitted changes")
    git("fetch", "-q", "origin", "main")
    if git("merge", "--no-edit", "origin/main", check=False).returncode == 0:
        print("Merged origin/main without conflicts")
    else:
        conflicted = git("diff", "--name-only", "--diff-filter=U").stdout.split()
        if conflicted != [LEDGER]:
            git("merge", "--abort")
            raise SystemExit("Conflicts beyond the ledger need review: " + ", ".join(conflicted))
        main_entries = sections(git("show", "origin/main:" + LEDGER).stdout)
        # Identity is the entry's text: two releases of one commit on one day share a heading.
        known = {entry.strip() for _, entry in main_entries}
        own = [entry for _, entry in sections(git("show", "HEAD:" + LEDGER).stdout) if entry.strip() not in known]
        with open(LEDGER, "w") as output:
            output.write(TITLE + "".join(own + [entry for _, entry in main_entries]))
        git("add", LEDGER)
        git("commit", "--no-edit", "-q")
        print("Merged origin/main; the ledger keeps main's entries with this branch's %d on top" % len(own))
    if "--push" in sys.argv[1:]:
        git("push", "-q", "origin", "HEAD:refs/heads/" + branch)
        print("Pushed " + branch)


if __name__ == "__main__":
    main()
