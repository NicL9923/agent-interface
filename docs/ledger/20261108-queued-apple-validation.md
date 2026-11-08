# Queued Apple validation

The shared agent-memory lock remains single-slot. Native helpers probe verified
ancestor ownership and fail fast with an older shared helper. The main runner
checks reusable evidence before queuing and after acquiring the lock, fingerprints
uncommitted iOS inputs, and invalidates an earlier pass when a fresh attempt fails.
Live checks, captures, repetitions and external custom inputs run fresh.

On the script state committed at `698bbdbc4f92292a14ad8862dd5c4daf56b72cd8`,
`python3 -m unittest discover -s .agents/tools -p test_ios_validation.py -v`
passed all 12 tests. These run the real runner and evidence helper against strict
fake external tools, with real Git and filesystem state. No native app was run by
this suite. Shell syntax checks passed for all four changed native entry points.

The regression tests first exposed macOS Bash 3.2's empty-array behavior under
`set -u`; the portable array expansions fixed it. Two deliberate mutations were
rejected: replacing the source digest with a constant failed the dirty-input
reuse test, and removing receipt invalidation failed the forced-rerun failure
test. Both mutations were restored before committing. Logs live under
`/Volumes/DevSSD/scratch/apple-validation-rollout-20261108/`.

Native validation is recorded separately after installing the reviewed shared
helper. This offline suite is not evidence of simulator UI or signed-device behavior.
