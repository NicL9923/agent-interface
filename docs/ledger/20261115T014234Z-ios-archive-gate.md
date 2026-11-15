# November 15 iOS archive gate

Branch `t3/require-ios-validation-before-archive` over `origin/main` dcc4d50c, on the Mac mini, Node 24.22.2,
Python 3. Nothing was archived, uploaded or distributed, and no signing material or App Store Connect call was used.

## Why

`publish-ios.mjs archive` checked only a clean tree and a build number above Apple's latest. It passed the typed
BUILD as `CURRENT_PROJECT_VERSION`, so the signed number could differ from `ios/tools/generate-project.py`, and nothing
required a passing iOS run. Build 27 shipped with the full UI suite listed under "Not exercised"
(`20261112T235241Z-household-build-27.md`).

## Change

- `archive` refuses unless the typed VERSION and BUILD equal the generator's `MARKETING_VERSION` and
  `CURRENT_PROJECT_VERSION`. The arguments stay because upload and distribute use them to find the artifact.
- `archive` refuses unless `ios-validation-state.py full-run` finds a passing, unfiltered `validate-ios.sh ... test`
  receipt for the current iOS source fingerprint. Receipts now carry `source`, `full` and test counts; a receipt without
  them is rerun, not reused. Skipped tests and expected failures do not block; failures do.
- Both checks run before the host check, credentials and Apple requests. The found receipt goes into `release.json`.
- No override: a gate that the person blocked by it can switch off protects nothing, and a broken suite is fixed in a
  reviewed commit.

## Red runs

Each guard was broken by hand, its test run, and the file restored. Python mutants ran through
`python3 .agents/tools/mutate-py.py --batch`. That tool compiles every file as Python, so the `.mjs` and `.sh` mutants ran
through the same replace, test, restore loop by hand. All 21 failed the test named for them.

| Mutation | Test that caught it |
| --- | --- |
| build guard dropped | gate: build number higher or lower |
| version guard dropped | gate: version the repository does not hold |
| unreadable generator accepted | gate: cannot read the release |
| tool refusal reason dropped | gate: relays the tool's reason |
| refusal omits the command | gate: relays the tool's reason |
| read failure reported as no run | gate: evidence cannot be read |
| failing counts accepted | gate: not usable evidence or records failure |
| missing counts accepted | gate: not usable evidence or records failure |
| archive skips the release check | publish-ios archive: build number the repository does not hold |
| archive skips the validation check | publish-ios archive: no full validation passed |
| `-only-testing` or `-skip-testing` not treated as partial (two mutants) | filtered run refused |
| record always says full | filtered run refused |
| full-run accepts partial records | filtered run refused |
| full-run ignores the source | inputs change after the run |
| full-run accepts failed exit, failing counts, zero passed, or a missing result bundle (four mutants) | failed runs and incomplete receipts |
| lookup reuses a receipt without scope | receipt from before scope was recorded |
| wrapper stops passing options to `record` | filtered run refused |

## Not exercised

Real `archive`, `upload` and `distribute`: they sign and call Apple. The two end-to-end tests run a copy of the tool in a
throwaway repository with no receipts, so they stop at the gate. The `validation` field written to `release.json` has no
test. A full UI run on this change was not run; the change touches no Swift source.
# November 15 iOS archive gate review fixes

The four regression tests ran against the unchanged iOS validation files from PR head `b82f0cfd` (also unchanged by the merge of main). The red runs used `python3 .agents/tools/mutate-py.py --batch` with a harmless docstring whitespace mutation, so the original production behavior remained intact. Each test failed on the reported behavior:

| Finding | Red result |
| --- | --- |
| Source changes during summary | `test_summary_source_change_never_certifies_new_source` failed |
| Edited scope or counts | `test_filtered_scope_and_bundle_counts_are_checked` failed |
| Incomplete receipt reuse | `test_incomplete_counts_are_not_reused` failed |
| Documentation and evidence fingerprint | `test_documentation_and_evidence_do_not_invalidate` failed |

After the fix, the iOS validation suite passed 26 tests using fake Xcode tools. The strengthened scope and count test passed separately. The code and test diff at that point had SHA-256 `7b08139b84e5e231e1130ac69fc2fc3efd74921adb4e8dd87ff6cac44a56d8d3` from `git diff` over the three changed implementation and test files. No archive, signing, App Store Connect, or real iOS validation was run.

On the final code and test diff, `.agents/tools/check-all` passed typecheck, lint, and ruff. Vitest passed 4,029 of 4,032 tests across 218 files; three failed because `127.0.0.2` is unavailable on this Mac (two direct-route tests and one native-contract test). The command stopped at that failure. `.agents/tools/check-all --only build,e2e,py --keep-going` then passed the build (896 modules), browser suite (79 tests), and Python suite (52 files). Node 24.22.2 was used. No simulator or physical device was exercised.
