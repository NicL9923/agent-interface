# Review 101: W2b iPad final-scroll-check fix and R2 prep

Reviewer: Claude Opus 5.5, high effort, independent of the OpenAI Sol implementer.
Scope: saved files only. No build, browser, device, simulator, signing, lock, or runtime probes. Offline hashing and Python AST-level reads only.

## Verdict

No blockers. No mediums. This exact R2 preparation is safe to admit under the conditional peer grant, provided the source stays at `35bc7afb…b477` until launch. The batch re-checks that at admission anyway (runner line 66).

## Delta verified

- Patch `work-w2b-pad-final-scroll-check.patch` SHA256 `c27e34f0e1040acfd5688661e700945cec5300298e912fd9a9019b8ccee9da6e` matches the prep.
- `diff` of the saved prior UITest against the live `ios/AgentInterfaceUITests/ScreenshotTourTests.swift` shows only the three patch lines: the comment, `0..<attempts` → `0...attempts` (line 546), and `if attempt == attempts { break }` (line 556).
- Drag count is unchanged. Attempts `0..<attempts` each check, then drag. The added attempt `attempts` checks, then breaks before the `upward`/`distance`/drag code. That gives 12 drags for Models and 24 for Memory, with no 13th or 25th drag.
- Nothing is relaxed. The containment test at line 553 (`minY >= top && maxY <= bottom`) is unchanged, and so are the band math, gesture start, distance, `press(forDuration: 0.3 … .slow … 0.2)`, the "list did not move" check after each drag, and the final `XCTFail` at line 575.
- Existing returned states are unchanged. Every path that returned before still returns at the same attempt with the same code above the new line. The change can only turn a final-position false failure into a pass. A target that still misses the band after the last drag reaches the same `XCTFail` message as before. One cosmetic difference: on the extra iteration, the "taller than viewport" check is skipped, so an oversized target that exhausts its attempts reports the generic "did not fit" message. It still fails. Not a finding.
- Sixteen call sites share the helper. Phone R6/R7 passed on 8b416, so their reveals returned before the attempts ran out and are unaffected.

## Old false failure confirmed fixed

- R1 log `ios-work-w2b-after-pad-r1-task-create-large-text.log`, attempts 0–10: "New task" does not exist. Attempt 11 (log line 1839): frame `y900.5, h78`, so `maxY = 978.5`, outside band `407…923`.
- The 12th drag ran at t=70.30s with distance -196.1. The post-drag cell snapshot puts a 78pt cell at `y721.5`. The loop then exited and failed at old line 573, which matches the saved prior file's `XCTFail` line, without re-checking.
- The retained failure hierarchy `1FD974EE…txt` line 129 shows `Button 'New task' {{143.0, 721.5}, {548.0, 78.0}}`. The form `automation.work` is at `{{127,395},{580,540}}` (line 81). The popover nav bar is at `285…339` (line 68), which does not intersect the form, so `top = 395+12 = 407` and `bottom = 935-12 = 923`. The hierarchy has no keyboard. `721.5 ≥ 407` and `799.5 ≤ 923`, so the new final check would have returned `DESIGN_MODELS_TARGET`. Slack is about 124pt at the bottom.

## Source and carry proof

- I recomputed `source-state.py` live over the 4 prefixes: `sha256:35bc7afbf17954a05a03a8b7950978ee4ac3f6ec18a63dfc8697db8d9b98b477 (243 source files)`. This equals `work-native-w2b-after-pad-r2-source.txt`.
- I independently rebuilt the digest with only `ScreenshotTourTests.swift` swapped for the saved prior file (`7b3cc305…1746`). It reproduces `8b416af9…cb7` over 243 files. The carry proof lists exactly one changed path, the UITest file, and `appSourceUnchanged: true`. That is consistent, and phone R6/R7 bindings stay on 8b416.
- Fixture `.agents/fixtures/work-tasks.json` hashes to `e8fee514…e744`, which equals `work-w2a-after-fixture-sha256.txt`.

## R2 runner

- `.private/work-native-w2b-after-pad-r2-batch.py` SHA256 `67fb567a…9dd0` matches the prep. `diff` against the R1 runner shows only 4 lines: STEM, source pin file, phase prefix, and verifier selector `pad-after-b-r2`.
- `.private/check-work-w2-release.py` accepts `pad-after-b-r2` and derives stem `work-native-w2b-after-pad-r2`, which matches the runner STEM.
- I confirmed these runner settings by reading the code:
  - Owned device `A068DC6D-AB48-467D-A9D0-0564DE3D3840` agrees with `design-session.json`.
  - Lock path agrees, and the live inode is 17430620. Admission uses a single `LOCK_NB` attempt, with no queueing or retry.
  - Budget is 1080s work plus 120s cleanup, with a 240s start floor per variant.
  - `-jobs 2`, a 300s test allowance, and only the single `testWorkTaskEditorDesignReviewAfter` selector. The `regressions` branch exists, but `regressions` is not in `variants`, so the 38-test repeat cannot run.
  - Order is `task-create-large-text` (4 frames), `task-edit` (2), `task-create-refreshed` (1), `task-create-dark` (1), `task-create` (1), for 9 frames total. Exact frame-name equality is enforced.
  - The first nonzero status breaks the loop (line 131), and the runner has no retry or extension logic.
  - Source and fixture are re-fingerprinted after each run.
  - Scoped cleanup shuts down only the owned device, and the lock is released only when no owned child is alive.
  - The verifier runs after release, before any pixels are inspected.
  - Launch requires `--execute-after-handback` and a detached session.
- All new R2 output paths are unused: reservation, launch, supervisor log, verifier result, heavy-release, the `work-native-w2b-after-pad-r2-*-captures` directories, and the `ios-work-w2b-after-pad-r2-*.log` files. The only existing `*pad-r2*` files are W2a (a different stem) plus this prep's own source pin and carry proof. `captures.mkdir(exist_ok=False)` and `log.open('x')` would refuse reuse anyway. `task-tmp` exists.
- R1 artifacts are preserved and untouched: reservation, heavy-release (`errors: []`, owned device Shutdown, lock free, inode 17430620), supervisor log, verifier result, and the attachments.

## Residual notes, non-blocking

- The R2 pass depends on the 12th drag landing close to R1's position (`y721.5`). The ~124pt margin to the band edge makes this robust, but it is still runtime behavior, not proven offline.
- The other four variants have not run on iPad after W2b. Reviews 94 and 98 cover their prep. Under the runner's no-retry rule, the batch stops at the first variant that fails.
