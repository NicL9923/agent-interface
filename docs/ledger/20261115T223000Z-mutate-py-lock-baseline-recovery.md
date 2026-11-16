# November 15 mutate-py lock, batch baseline and recovery bytecode

Branch `t3/fix-mutator-races-baseline-recovery` from `origin/main` at `92b3fadc`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10.
No product code changed: `.agents/tools/mutate-py.py`, `tests/mutate_py_test.py` and `.agents/tools/README.md`.

## Change

GPT-6.1 Sol reviewed merged PR #361 and found three P2 defects in the tool.

- Two runs on one file could both pass the ownership check before either saved its record, so one could snapshot the other's mutant and
  restore it as the original. A per-file `fcntl.flock` on `<key>.lock` in the private record directory, keyed like the record by the file's
  resolved path, is now held from the ownership check through the snapshot, mutation and restore. Recovery takes the same lock per record and
  skips a record whose lock is held. A second run fails at once with `error: another mutate-py run (pid N) is mutating this file`, as it did
  before for a run that had saved its record: the holder can keep the file for a whole suite, and a silent wait looks hung.
- `--baseline` checked only the first batch entry's command. It now runs every distinct (command, repository) pair once before any mutation
  and names the command that failed.
- Dead-run recovery restored the source but left the repository's bytecode. A same-size mutant compiled under `--keep-mtime` before a SIGKILL
  kept a valid `.pyc`, so an ordinary import ran the mutant. Recovery now clears that repository's `__pycache__` directories after a restore.

## Red runs

The tool cannot run red steps on itself, so each was a temporary local edit, restored byte for byte with `cmp` against the fixed file.

| Break | Test | Failure |
| --- | --- | --- |
| The whole tool reverted to `origin/main`, 3 runs | the three new tests | all three failed in each run, as in the rows below |
| Lock holder ignored (`if holder is not None` to `if False`) | `test_two_runs_started_together_on_one_file_let_only_one_mutate_it` | both runs mutated: two `failed: exit 1` rows, no refusal |
| Baseline over `specs[:1]` only | `test_a_baseline_runs_every_distinct_batch_command_and_stops_on_a_later_one_that_fails` | exit 1, the mutants ran |
| Baseline pairs kept as a list, not deduplicated | same test | `'aab' != 'ab'` |
| Recovery's `clear_pycache` removed | `test_recovery_clears_bytecode_a_killed_run_compiled_from_its_same_size_mutant` | import printed `2`, expected `1` |

## Checks

`python3 scripts/run-python-tests.py tests/mutate_py_test.py` passed, 35 tests, and `.agents/tools/check-all` passed (see the PR).
Not exercised: macOS, where `fcntl.flock` has the same semantics; the Mac mini was not needed for a Python tool change.


## CI follow-up: a lock owner that is still publishing its PID

Python CI at documentation-only head `65f793b9` failed the concurrent-run test because
it required a numeric PID. The tool had already acquired the kernel lock, but had not
published its PID bytes yet, so the second run correctly refused with `pid unknown`.
The rejection reason was correct; the diagnostic assumption was not.

This test-only follow-up was implemented by GPT-6.1 Sol. A deterministic test holds the
real per-file flock with an empty PID file, invokes the real CLI, and verifies the exact
unknown-owner refusal, no command execution, unchanged source bytes/mtime/mode, and no
pending backup. The concurrent-run assertion accepts that valid diagnostic while still
requiring one refused run, exactly one executed mutation, and byte-for-byte restoration.

All 35 tests in `tests/mutate_py_test.py` passed in 9.9 s. The new test failed when the
held-lock rejection was disabled. That mutation ran through the primary worktree's
committed mutate-py helper, so the tool under test could be restored safely; its source
was restored and has no diff. Ruff and `git diff --check` passed.

The source fingerprint before this ledger update is
`sha256:12120536746330616d7def6b1ab3b551a7d62aefd612a583a89c06c4ead1fc7e`.
Logs: `.private/mutator-pid-window-green.log` and `.private/mutator-pid-window-mutation.log`.
The production implementation remains the Claude-authored code reviewed by Sol at `35dcbee8`.
Independent review of this new OpenAI-authored test scope is incomplete because Anthropic
is usage-limited and Grok has exhausted its balance. Keep the PR unmerged until it is reviewed.
