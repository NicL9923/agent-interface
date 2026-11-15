# November 14 GitHub-hosted CI

Branch `t3/ci-github-hosted` from `origin/main` at `65ed9eb`, on the Mac mini with Node 24.22.2. Nothing was
deployed by this entry.

## Change

Nicolas re-enabled GitHub Actions for this public repository on November 14, 2026, on the condition that it uses
GitHub's runners so it stays free. The repository settings now allow only GitHub-owned actions and require each to be
pinned to a full commit SHA. `tests/workflows.test.ts` fails when a workflow names a `runs-on` label outside GitHub's
standard hosted runners, such as a larger runner or a self-hosted one, or a `uses` that is not a GitHub-owned action
pinned to a SHA. `Checks` gained a manual trigger so main can be rechecked without a push.

## Red runs

| Break | Test | Failure |
| --- | --- | --- |
| `audit.yml` `runs-on: ubuntu-latest-4-cores` | `run only on free GitHub-hosted runners with pinned GitHub-owned actions` | `audit.yml: runs on ubuntu-latest-4-cores, which is not a free GitHub-hosted runner` |
| Removing the guard's refusal of `runs-on` or `uses` it cannot read | `refuses a flow-style job beside an allowed one`, `refuses an action wrapped onto the next line`, `refuses a self-hosted runner` | 3 failed |

Each file was restored from a copy and the tests passed again (9 of 9).

GPT-6.1 Sol reviewed the first version and found two ways past it: a flow-style job such as
`costly: {runs-on: ubuntu-latest-4-cores, ...}` beside an allowed job, and a `uses:` whose value sits on the next
line. The guard now reads only the plain one-line block form of each key and fails on any other appearance.

## Not exercised

- GitHub's billing for this repository. The rule rests on GitHub's billing documentation, which lists standard
  hosted runners as free in public repositories and larger runners as always billed.
