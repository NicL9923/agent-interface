# November 14 disk readiness and release pruning

Branch `t3/disk-space-floor` from `origin/main` at `fa0243ee`, run on the Mac mini (Node 24.22.2, Python 3.14.7).
Nothing was deployed by this entry.

## Change

- `src/server/health.ts` adds a `disk` readiness check that warns, and never fails readiness, when free space is below
  the Hermes update worker's floor. It reads `minimumFreeBytes` and `stageRoot` from `HERMES_UPGRADE_CONFIG`, measures
  the stage root's filesystem with `fs.statfs`, and falls back to the app's data directory and 20 GiB.
- `.agents/tools/release-app.py` `REMOTE_PRUNE` drops the 7-day age rule. It keeps the ten newest releases, the live
  one, its deploy configuration's rollback target, any release named in its `dist/previous-release.json`, releases this
  checkout's manifests record as unsettled, and releases with an active or unreadable qualification stage marker. It
  then clears `release.tar.gz` and the qualification stage subdirectories of `operations/release-*` dirs whose release
  is gone and that hold a `deploy-config.json`. The review fixes below add the host-side settled rule.

## Application tests

`tests/ops.test.ts` runs the real Fastify app with an injected `statfs` that calls the real one on the same path, then
reports the chosen free space. `tests/release_app_test.py` runs the host program against temporary directories.
`.agents/tools/check-all --keep-going`: typecheck, lint, ruff and build pass. Vitest fails only the three tests that
need the `127.0.0.2` loopback alias, which this machine lacks. The first run was stopped during e2e by a 10-minute
shell timeout, so e2e and py were rerun with `--only`. e2e failed one smoke test once (`a reply keeps growing across
a tool call`, an SVG `<rect>` negative-height console error in client code this change does not touch) and passed all
55 on a rerun. py fails `deploy_common_test.py`, `mutate_py_test.py` and `release_app_test.py`. The same three fail on
`origin/main` at `fa0243ee` on this machine; in `release_app_test.py` they are the two `serviceRuntime` facts tests.
Every prune test passes.

## Red runs

TypeScript: each broke one line of `src/server/health.ts`, ran `tests/ops.test.ts`, then restored the file.

| Break | Test that failed |
| --- | --- |
| warn at the floor, not below it | `warns below the worker's own floor on its stage root's filesystem, and alerts administrators` |
| ignore the worker's minimumFreeBytes | same |
| measure the app data directory, not the stage root | same |
| stop walking up from a missing stage root | same |
| drop the non-object guard | `warns with the default floor when the worker's configuration is not an object` |
| drop the number guard on minimumFreeBytes | `... sets a floor that is not a number` |
| an unreadable config stays ok | all four configuration cases |
| a statfs error fails the check | `warns when it cannot measure free space, without failing readiness` |
| leave disk out of readiness | every disk test and `reports detail only to direct loopback callers` |

Python: `python3 .agents/tools/mutate-py.py --batch ... --baseline -- sh -c 'cd tests && python3 -B release_app_test.py -k prune'`.

| Mutation | Result |
| --- | --- |
| keep only the newest, not live | failed: test_prune_keeps_the_newest_the_live_release_its_rollback_targets_and_releases_in_flight |
| ignore releases this checkout has not settled | failed: same |
| ignore the deploy config's rollback target | failed: same |
| ignore previous-release.json | failed: same |
| keep every release with a stage marker, whatever its state | failed: test_prune_clears_archives_and_stage_checkouts_only_from_operations_whose_release_is_gone |
| an unreadable stage marker does not protect | failed: test_prune_keeps_the_newest_... |
| skip the still-qualifying check | failed: test_prune_keeps_the_newest_... |
| keep twice as many newest | failed: test_prune_clears_archives_... |
| stop after the first removal error | failed: test_prune_reports_a_release_it_cannot_remove_and_still_clears_the_rest |
| plain rmtree for read-only stage directories | failed: test_prune_clears_archives_... |
| strip an operation whose release exists | failed: test_prune_clears_archives_... |
| strip a protected release's operation | failed: test_prune_clears_archives_... |
| strip an operation without a deploy configuration | failed: test_prune_clears_archives_... |
| strip continued-* operations too | survived |
| keep the archive | failed: test_prune_clears_archives_... |
| remove stage files too | failed: test_prune_clears_archives_... |
| only the first qualification stage | failed: test_prune_clears_archives_... |
| protect every manifest | failed: test_prune_protects_releases_this_checkout_has_not_settled |
| drop the needs-review status | failed: same |
| a malformed manifest stops the scan | failed: same |
| send no protected names | failed: same |
| swallow pruning errors silently | failed: same |

The surviving mutant widens the `operations/release-*` glob. It is equivalent on every real host layout: only a
release's own operation dir holds a `deploy-config.json`, and the strip step skips any dir without one. `continued-*`
holds `result.json`, and `native-recovery-config-*` holds `config.json`.

## Review fixes

GPT-6.1 Sol reviewed `932748d8` and reproduced two defects against a temporary host layout:

1. Pruning trusted only this checkout's manifests, so a stage another checkout was preparing or holding was deleted
   once it fell outside the newest ten, with or without a deploy configuration.
2. Stripping a gone release's operation deleted the source and runtime of a qualification stage still marked
   `active`, or with an unreadable marker.

The fix keeps any release the host cannot prove settled. The guarded deploy writes
`operations/continued-<operationId>/result.json` only when an activation completes, and `discard` deletes the release
and its operation, so that file is the only host-side proof. A release without it stays until its release dir, its
operation dir and its `continued-<operationId>` dir have all gone 3 days without a change, or while any of their times
cannot be read. The strip step skips an operation with an active or unreadable stage marker. `activate` now refuses a
stage whose build was pruned, before changing anything, instead of failing in the guarded tool's `cd` and marking it
needs-review. `REMOTE_LIVE` reports `releaseBuilt` for that.

The final versions of the two tests that reproduce Sol's scenarios, run against `932748d8`'s `.agents/tools`:

| Test | Result before the fix |
| --- | --- |
| `test_prune_keeps_a_release_the_host_cannot_prove_settled_until_it_has_been_idle_for_days` | failed: removed all eleven releases, expected only the activated and the abandoned one |
| `test_prune_leaves_a_gone_release_s_operation_alone_while_its_qualification_runs_or_cannot_be_read` | failed: stripped the running and unreadable operations too |

Both pass after the fix. Red runs:
`python3 .agents/tools/mutate-py.py --batch ... --baseline -- sh -c 'cd tests && python3 -B release_app_test.py -k prune'`.

| Mutation | Result |
| --- | --- |
| remove releases the host cannot prove settled (the earlier rule) | failed: test_prune_keeps_a_release_the_host_cannot_prove_settled_until_it_has_been_idle_for_days |
| no activation proof, age only | failed: test_prune_clears_archives_and_stage_checkouts_only_from_operations_whose_release_is_gone |
| no age-out, activation proof only | failed: test_prune_keeps_a_release_the_host_cannot_prove_settled_... |
| a continued dir alone counts as activated | failed: same |
| idle ignores the operation dir | failed: same |
| idle ignores continued-<op> | failed: same |
| hours, not days | failed: same |
| a time it cannot read does not keep it | failed: same |
| drop the config dict guard | failed: same |
| drop the operationId string guard | failed: same, after its case moved from a null to a numeric `operationId`; null survived because it short-circuits before the guard |
| an unparseable config stops the prune | failed: same |
| strip an operation whose qualification runs or cannot be read | failed: test_prune_leaves_a_gone_release_s_operation_alone_... |
| send a different window | failed: test_prune_protects_releases_this_checkout_has_not_settled |

`-k releaseBuilt -k pruned -k still_built`:

| Mutation | Result |
| --- | --- |
| activate a stage whose build is gone | failed: test_refuses_a_stage_whose_build_was_pruned_and_leaves_it_discardable |
| report every release as built | failed: test_live_facts_say_whether_the_release_is_still_built |
| send no release to the live check | failed: test_refuses_a_stage_whose_build_was_pruned_and_leaves_it_discardable |

Checks on the fix merged with `origin/main` at `2144c0b8`, Node 24.22.2, Python 3.14.7:
`.agents/tools/check-all --keep-going` passed typecheck, lint, ruff, build and e2e (55). Vitest failed only the three
tests that need the `127.0.0.2` loopback alias. py failed `release_docs_pr_test.py`, whose prepared manifest lacked the
`release` path that `activate` now reads; the fixture now carries it, as every real manifest does from the start of
prepare. It also failed one `hermes_upgrade_linux_test.py` maintenance RPC case once with a `ConnectionResetError`;
that file passed all 81 tests run alone. `check-all --only py,ruff` then passed all 52 Python files, including the two
`serviceRuntime` facts tests that #398 fixed on main.

## Second review fixes

GPT-6.1 Sol reviewed the first fixes at `9a783b53` and reproduced three defects with the real host program:

1. `activated()` took any `continued-<op>/result.json` as proof. A recent, unsettled release whose result held only
   `{` was deleted at once.
2. The idle check read only directory times. With the release and operation dirs aged four days, rewriting the
   existing `build.log` left both times alone, and the release was deleted. A retry that overwrites
   `continued-<op>/commands.log` is the same case.
3. Stripping kept a stage only for malformed JSON or `state: active`. A gone release with the marker `{}` lost its
   qualification `source`.

The fixes:

1. Proof is now the two records `deploy-guarded-app-release.py` leaves as its last steps of a completed activation,
   both present since the tool was added in `bee48c89`: a `result.json` object whose `webBuild` and `hermesRevision`
   equal the release's deploy configuration, and a `phase.json` with `phase: complete` and the configuration's
   `operationId`. The configuration must name a string `webBuild`. A result written just before a failed final print
   leaves the phase at needs-review, so that release falls back to the idle rule.
2. Activity is the newest time of every file and directory under the operation dir and `continued-<op>`, plus the
   release dir's own time. I chose this over an activity stamp because other checkouts release with older copies of
   this tool, and the guarded deploy, qualification and the update worker would all have to write the stamp; a
   writer that skips it would make a live stage look idle. The walk is bounded: it skips the subdirectories of
   qualification stages, which hold the checkouts and runtimes, because a stage in use is not marked completed and
   keeps its release regardless. It does not walk the release's own build tree, which holds `node_modules`, because
   prepare writes the operation's `build.log` for as long as it builds. It runs only for releases outside the kept
   set that lack proof. An entry that vanishes mid-walk, such as an atomic write's temporary file, counts as a change
   now instead of dropping that directory's times.
3. A stage counts as finished only when its marker is an object with `schemaVersion` 1, `state` `completed` and the
   stage's own `operationId`, which is what `qualify-app-release.py` `prune_stage` and the update worker write, and
   what the worker's own retention requires. A missing, cut-off, empty or unknown marker keeps both the release and
   the operation. A list marker used to crash the whole prune with `AttributeError`; it now keeps the stage.

The test fixtures now write those records: `completed_activation()` writes the guarded deploy's result fields and
phase, and `stage_marker()` writes a schema 1 marker named for the stage's UUID. The `{}` success results and
markers are gone.

New tests, each run against `9a783b53`'s `.agents/tools` in a temporary detached worktree:

| Test | Result before the fix |
| --- | --- |
| `test_prune_takes_only_a_completed_activation_of_the_release_s_own_operation_as_proof` | failed: removed all ten releases, expected only `release-completed` |
| `test_prune_counts_a_rewritten_file_under_an_aged_operation_as_activity` | failed: removed `release-rebuilt`, `release-retried` and `release-qualified` too |
| `test_prune_strips_a_gone_release_s_operation_only_once_every_stage_is_marked_completed` | failed: the prune exited with `AttributeError` on the list marker. Without that case it stripped the `{}`, unknown-state, other-stage, later-schema and marker-less operations too |
| `test_prune_keeps_the_newest_...` with a new `{}` marker case | failed: removed `release-old-06` |

All pass after the fix. Red runs:
`python3 .agents/tools/mutate-py.py --batch ... --baseline -- sh -c 'cd tests && python3 -B release_app_test.py -k prune'`.

| Mutation | Result |
| --- | --- |
| any result.json is proof (the earlier rule) | failed: test_prune_takes_only_a_completed_activation_of_the_release_s_own_operation_as_proof |
| a result that does not parse counts | failed: same |
| a result that is not an object counts | failed: same |
| skip the build match | failed: same |
| skip the revision match | failed: same |
| a config without a build matches | failed: same |
| a missing phase counts | failed: same |
| any phase counts | failed: same |
| another operation's phase counts | failed: same |
| directory times only (the earlier rule) | failed: test_prune_counts_a_rewritten_file_under_an_aged_operation_as_activity |
| no descent below the operation | failed: same |
| descend into stage subdirectories | failed: same |
| idle ignores continued-<op> | failed: same |
| only an active marker keeps a stage (the earlier rule) | failed: test_prune_strips_a_gone_release_s_operation_only_once_every_stage_is_marked_completed |
| any state but active is done | failed: same |
| skip the schema check | failed: same |
| skip the stage identity check | failed: same |
| a marker that is not an object stops the prune | failed: same |
| a stage without a marker is done | failed: same |
| only the first stage counts | failed: same |

No test covers the vanished-entry branch, because making a file disappear between `scandir` and `stat` needs a
mocked filesystem call.

Checks on `978aee15` merged with `origin/main` at `907eb1ca`, Node 24.22.2, Python 3.14.7:
`.agents/tools/check-all --keep-going --py always` passed typecheck, lint, ruff, build and e2e (55). Vitest failed only
the three tests that need the `127.0.0.2` loopback alias (`direct-routes` twice, `native-contract`). py passed 51 of 52
files; `hermes_upgrade_linux_test.py` failed its maintenance RPC case with the same `ConnectionResetError` as the first
round, and passed all 81 tests run alone.

## Not exercised

The production host. Nothing here ran over SSH, and the prune has not run against the live `releases/` and
`operations/` trees, so how many releases the 3-day rule keeps there is not measured. Directory times on the host's
filesystem were not checked against what prepare, qualification and activation write, and the walk's run time over
the host's real operation dirs is not measured. The first `release-app.py activate` after merge is that run; its
output reports what it removed and the host's free space. `fs.statfs` on Linux ext4 was not measured against `shutil.disk_usage` on the host.

## Third review round

GPT-6.1 Sol found that activation proof accepted a missing Hermes revision when both the deploy configuration and the
result omitted it, or both held null: the comparison matched `None` to `None`, and a fresh release was deleted at once.
Each compared field (`operationId`, `webBuild`, `hermesRevision`) must now be a non-empty string in the configuration.

| Mutation | Result |
| --- | --- |
| Drop `hermesRevision` from the required fields | failed: `test_prune_takes_only_a_completed_activation_of_the_release_s_own_operation_as_proof` |
