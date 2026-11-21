# The iOS validator tells the machine lock what it uses

Recorded 2026-11-21. The Mac mini's lock now has two simulator slots and a build slot
(agent-memory pull request 49). A job shares the Mac only when it names its simulators with `--sim` or marks
itself `--build`. A job that declares nothing waits for the whole Mac, which is what `validate-ios.sh` did.

## What changed

- A `test` run asks the lock for `--sim SIMULATOR_UUID`, and a `build` run asks for `--build`.
- A `live` run declares nothing, because it binds port 3004.
- A `test` run with parallel testing, a worker count or a caller's own `-destination` declares nothing, because
  it boots devices the helper cannot name. The lock refuses those options in a scoped job.
- The ownership check passes the same scope as the request. Under a hold that does not cover the scope the
  check fails, and the lock then refuses the nested request at once and says how to fix the caller.

The helper needs the new lock. With the old one, a scoped `--check-held` is not understood and the helper stops
with its "Update agent-memory" message.

## Red runs

Each line was broken by hand in `.agents/tools/validate-ios.sh`, the two new tests in
`tests/validate_ios_test.py` were run, and the file was restored byte for byte. Unmutated: 2 tests, OK.

| Mutant                                              | Failing subtests                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| A test does not name its simulator                  | `operation='test'`; `-parallel-testing-enabled NO`                      |
| A build does not mark itself                        | `operation='build'`                                                     |
| The ownership check drops the scope                 | `operation='test'`; `operation='build'`; `-parallel-testing-enabled NO` |
| The request drops the scope                         | `operation='test'`; `operation='build'`; `-parallel-testing-enabled NO` |
| Cloning options keep the scope                      | `-parallel-testing-worker-count 2`; `-destination`                      |
| Parallel testing `yes` keeps the scope              | `-parallel-testing-enabled yes`                                         |
| The parallel value is compared without folding case | `-parallel-testing-enabled yes`                                         |
| Parallel testing `NO` drops the scope               | `-parallel-testing-enabled NO`                                          |

## Checks

- `python3 tests/validate_ios_test.py`: 9 tests passed on Linux, with a fake lock that accepts the two scopes
  and fails on any other call.
- Not run: the helper against the real lock on the Mac mini. The new lock is not deployed at the time of writing.
