# November 11 one tool for Python hand-break runs

Branch `t3/python-mutation-tool`, started from `origin/main` at `08c8f96` on NicolasLaptop (Fedora 44, Linux x64, 32 cores), Python 3.14.10,
Node 24.22.2. No product code changed: the change is `.agents/tools/mutate-py.py`, its tests in `tests/mutate_py_test.py`, a line in
`.agents/tools/README.md` and one in `AGENTS.md`.

## The trap

Python reuses a `.pyc` when the recorded source mtime (whole seconds) and size match the source. A same-size mutant written in the same second
as the file's last change runs the old bytecode and reads as "survived", and a file restored in the same second as a mutant run runs the
mutant's bytecode. `tests/mutate_py_test.py` reproduces it by hand (a mutant with the original's mtime and size, over a compiled `.pyc`, runs
the old code), then shows the tool seeing the mutant.

## What the tool does

`python3 .agents/tools/mutate-py.py FILE (--old TEXT | --line N [--old TEXT]) --new TEXT [--baseline] [--timeout S] -- COMMAND...`, or
`--batch mutations.json`. It applies one exact mutation, deletes every `__pycache__` under the repository (not `.git`, `node_modules` or
virtual environments) before and after, runs the command with `PYTHONDONTWRITEBYTECODE=1`, `-B` after a leading `python`, and a fresh empty
`PYTHONPYCACHEPREFIX` per run, restores the file byte for byte with its mode and mtime, reads it back and compares, and prints a Markdown table
row. Ctrl-C, SIGTERM and SIGHUP stop the command's process group and then restore. After SIGKILL, the next run restores from a record in a
private directory under the system temp directory and says so, and a live run's record refuses a second run on the same file. Exit codes: 0
every mutant failed, 1 a mutant survived, 2 an error row, 3 a restore failed.

## `scripts/run-python-tests.py` and `PYTHONDONTWRITEBYTECODE`

Not set there. `PYTHONDONTWRITEBYTECODE` stops writes only; Python still reads a stale `.pyc`, so it would not close the trap for a runner
that shares a checkout with edits. The trap needs a same-size change in the same second as the previous compile, which a person's edit does not
produce and a scripted mutation does. The tool closes it with the cache prefix and the clearing, which is where the mutation is. The runner keeps
its bytecode for speed: `tests/hermes_extension_journal_test.py` through the runner took 3.3 s and 6.3 s with a warm cache and 8.6 s and 9.1 s
with bytecode writing off, after clearing every `__pycache__` each time, on a machine running other jobs (4 runs, so a direction, not a number).

## Evidence

`python3 tests/mutate_py_test.py`: 24 tests against real files and real child processes, none through a patched function of the tool. They
cover a caught mutant, a surviving one (exit 1), a whole-line replacement keeping CRLF, a line and text together, each refusal (text absent,
twice, line out of range, no-op, missing file, missing command) leaving the file and never running the command, a batch with a pipe in a name and
a per-mutation command, a batch refused before anything runs, a failing baseline, a child killed by SIGKILL, a timeout that kills the child's
own child, Ctrl-C and SIGTERM mid-run (exit 130 and 143, file restored, child gone), SIGKILL of the tool then recovery by the next run, a second
run refused while the first is live, the same-second trap, pycache clearing before and after for a command that ignores the private prefix,
`-B` reaching a `python -I` that ignores the environment, a file the command deleted coming back with its mode and mtime, and a restore that
fails (exit 3, original named, next run finishes it).

### Red runs

The tool run on itself: `python3 .agents/tools/mutate-py.py --batch mutations.json --baseline --timeout 120 -- python3 tests/mutate_py_test.py`.
Each protecting line broken, the suite run, the file restored. The batch ran as one command and the table below is its output.

| Mutation | Result |
| --- | --- |
| No clearing before the run | failed: test_clearing_before_the_run_defeats_stale_bytecode_for_a_command_that_ignores_the_private_prefix (exit 1) |
| No clearing after the restore | failed: test_clearing_after_the_restore_removes_bytecode_a_command_compiled_from_the_mutant (exit 1) |
| No private pycache prefix | failed: test_the_command_runs_with_no_bytecode_writing_and_a_private_pycache_prefix (exit 1) |
| No PYTHONDONTWRITEBYTECODE | failed: test_the_command_runs_with_no_bytecode_writing_and_a_private_pycache_prefix (exit 1) |
| No -B after python | failed: test_dash_b_reaches_a_python_that_ignores_the_environment (exit 1) |
| Restore skips mtime | failed: test_a_batch_prints_one_row_per_mutation_in_order_with_pipes_escaped_and_per_mutation_commands (exit 1) |
| Restore skips mode | failed: test_a_file_the_command_deleted_comes_back_with_its_bytes_mode_and_mtime (exit 1) |
| Stop signal leaves the command running | survived |
| SIGTERM not handled | failed: test_sigterm_restores_the_file_too (exit 1) |
| No pending record saved | failed: test_a_killed_tool_leaves_the_mutant_and_the_next_run_restores_it_first (exit 1) |
| A live run's record is ignored | failed: test_a_second_run_on_a_file_another_live_run_is_mutating_is_refused (exit 1) |
| A dead run's record is not restored | failed: test_a_killed_tool_leaves_the_mutant_and_the_next_run_restores_it_first (exit 1) |
| Non-unique text accepted | failed: test_a_mutation_that_cannot_apply_is_an_error_row_that_never_runs_the_command (exit 1) |
| Line replacement drops its line ending | failed: test_a_line_mutation_replaces_the_whole_line_and_keeps_its_crlf (exit 1) |
| No-op replacement accepted | failed: test_a_mutation_that_cannot_apply_is_an_error_row_that_never_runs_the_command (exit 1) |
| Survivors exit 0 | failed: test_a_batch_prints_one_row_per_mutation_in_order_with_pipes_escaped_and_per_mutation_commands (exit 1) |
| Pipes not escaped | failed: test_a_batch_prints_one_row_per_mutation_in_order_with_pipes_escaped_and_per_mutation_commands (exit 1) |
| Timeout does not kill the group | failed: test_a_command_that_outlives_the_timeout_is_an_error_row_and_its_children_die_with_it (exit 1) |
| Baseline ignored | failed: test_a_baseline_that_fails_stops_the_run_before_any_mutation (exit 1) |
| Restore not verified | survived |
| Restore failure raised as a bare OSError | failed: test_a_restore_that_fails_exits_3_names_the_saved_original_and_the_next_run_finishes_it (exit 1) |

Two survivors, both equivalent. "Stop signal leaves the command running" removes the handler's own kill of the process group, and the
`finally` in `run_command` kills the same group a moment later, so a stop ends the command either way. "Restore not verified" removes the
read-back after a restore that already wrote the bytes; it can only differ when a write succeeds and stores other bytes, which the
failing-restore test cannot produce without a broken filesystem. Both lines stay because each is the second guard of a pair.

Before those tests existed the same batch left six survivors (no clearing before the run, no clearing after, no `-B`, the restore's mode,
the stop handler's kill, the read-back); the tests for pycache clearing before and after, `-B` under `python -I`, and a deleted file's mode and mtime killed four of them.

## Checks

`.agents/tools/check-all --py always --keep-going` on this tree:

check      result  queued  run    counts
typecheck  pass    -       1.8s   -
lint       pass    -       0.3s   -
ruff       pass    -       0.0s   -
test       pass    5m51s   18.4s  205 files, 3665 tests
build      pass    -       2.1s   892 modules
e2e        pass    5m27s   1m25s  40 tests
py         pass    -       4m41s  47 files

All 7 checks passed (17m49s total, 11m19s of it queued for heavy slots)

The first run failed `ruff` on an unused `import time`, fixed before the run above.

## Not exercised

Windows and macOS: the tool uses process groups, `os.killpg`, `SIGHUP` and `/proc`-free liveness through `os.kill`, which exist on both Unix
families, but only Linux ran. A command that starts a new session (`setsid`) escapes the process-group kill on a timeout or a stop.
