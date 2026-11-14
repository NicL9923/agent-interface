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
  is gone and that hold a `deploy-config.json`.

## Application tests

`tests/ops.test.ts` runs the real Fastify app with an injected `statfs` that calls the real one on the same path, then
reports the chosen free space. `tests/release_app_test.py` runs the host program against temporary directories.
`.agents/tools/check-all --keep-going` results are in the PR.

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

## Not exercised

The production host. Nothing here ran over SSH, and the prune has not run against the live `releases/` and
`operations/` trees. The first `release-app.py activate` after merge is that run; its output reports what it removed and
the host's free space. `fs.statfs` on Linux ext4 was not measured against `shutil.disk_usage` on the host.
