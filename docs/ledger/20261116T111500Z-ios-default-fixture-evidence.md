# Record validation with the default iOS fixtures

The normal iOS runner exports each repository design fixture before checking whether
a successful run can publish reusable evidence. The recorder rejected every
`TEST_RUNNER_` input, so the default full suite could pass without publishing its receipt.
Build 28 required recovery from the original passing result bundle, as recorded in the
[release ledger](20261116T104911Z-household-build-28.md).

The recorder now accepts only absolute paths resolving to the default fixture for that
variable. It hashes default fixture contents, including ignored local JSON files that
the shell runner exports. External, missing, blank and relative paths remain ineligible.
Custom variant selection remains ineligible. A fixture edit invalidates earlier evidence.
The release gate still requires an unfiltered passing scheme and unchanged native inputs.

## Validation

Commit `4cd51029` contains the final implementation and tests. Their diff has SHA256
`be030d2c6154d12abe77f92150c00965a0ee82309a384a7b5faa827740e886a2`
against `origin/main` at `087dd60e613420995b1b64d87be3335a250930f5`.
The helper file SHA256 is
`29cdb06293c5caa8e8cf826c6b262ac2f5e5577a6784010da4db26077d235ef7`.

| Check                                                                                                  | Result                                                                                                                                                                           | Evidence on the Mac mini                                      |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Regression before the default-fixture fix, through `mutate-py.py --baseline`                           | Failed because the passing default run published no evidence                                                                                                                     | `/Volumes/DevSSD/scratch/ios-evidence-regression-detail.log`  |
| Ignored-fixture regression before the fix, through `mutate-py.py --baseline`                           | Failed because a changed ignored fixture left stale evidence valid                                                                                                               | `/Volumes/DevSSD/scratch/ios-evidence-ignored-red-detail.log` |
| Six deliberate guard mutations through `mutate-py.py --batch ... --baseline`                           | Every mutated guard made its targeted test fail, and the tool restored the helper byte for byte                                                                                  | `/Volumes/DevSSD/scratch/ios-evidence-final-mutations.log`    |
| `python3 tests/ios_validation_test.py` on final helper and test bytes                                  | Unit-passed, 29 tests                                                                                                                                                            | `/Volumes/DevSSD/scratch/ios-evidence-final-tests.log`        |
| `.agents/tools/check-all --keep-going`                                                                 | Typecheck, lint, Ruff and build passed. All 52 Python files passed. Vitest had 4,075 passed and three host failures. Browser checks had 170 passed, three skipped and one failed | `/Volumes/DevSSD/scratch/ios-evidence-check-all.log`          |
| Fresh real-Xcode simulator run of `NativeContractTests/testAnOlderConversationReadCannotUndoANewerOne` | Runtime-exercised, one test passed, automatic receipt published                                                                                                                  | `/Volumes/DevSSD/scratch/ios-evidence-final-sdk-smoke.log`    |
| Identical filtered simulator command without `IOS_VALIDATION_FRESH=1`                                  | Reused the automatically published receipt                                                                                                                                       | `/Volumes/DevSSD/scratch/ios-evidence-final-sdk-reuse.log`    |
| `ios-validation-state.py full-run` after the real filtered run                                         | Rejected with "Only a partial run" and exit 1                                                                                                                                    | `/Volumes/DevSSD/scratch/ios-evidence-final-partial-gate.log` |
| Isolated Chromium 390 px light accessibility case                                                      | Failed on a timeout awaiting the conversation reply                                                                                                                              | `/Volumes/DevSSD/scratch/ios-evidence-browser-rerun.log`      |

`check-all` started from `bdffe3ac` with working changes. The ignored-fixture fix was
complete before its Python runner reached the affected module. The separate 29-test
run also covers the final helper and test bytes. The web inputs did not change.

The three Vitest failures require `127.0.0.2`, which this Mac cannot bind without its
loopback alias. They affect two direct-route cases and the native-contract case. This
same host limitation was present before this branch. The full browser run timed out
waiting for local sign-in in its first Chromium accessibility case. Its isolated rerun
timed out later, awaiting a reply. Neither browser run is reported as passed.

The final real simulator run used native source fingerprint
`6333724f8a3b7898b7239391757c5598b2f43d6f91ab4fd0dbc28382f10f141c`.
Its result bundle is `.private/ios-test-20261116T111426Z-10970.xcresult` in the
`/Volumes/DevSSD/scratch/ios-default-fixture-evidence` worktree. The recorder published
this receipt automatically. The one-test run does not replace build 28's full scheme
validation and cannot authorize a future archive of these changed tooling inputs.

## Scope and review

The runner's source fingerprint, normal receipt publication, reuse and release lookup
were checked through real helper processes with fake tool executables at the I/O edge.
Tests cover the reverse state after default fixture bytes change and rejected custom
inputs. No compiled iOS or web application source changed in this branch.

Independent review is incomplete. Grok 4.7 rejected the review launch with HTTP 402,
exhausted balance. Claude was unavailable under a recorded weekly limit until November 17
at 06:00 UTC. No same-provider review substitutes for those attempts.
