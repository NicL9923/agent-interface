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
