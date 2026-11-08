# 51: Final iPad reload-error recheck

- Reviewer: Claude Opus 5.5, high effort, no subagents. Root OpenAI implemented the work, so this review is cross-provider.
- Scope: the three iPad frames from R11 (`memory-reload-error`, `memory-reload-failed` and `memory-reload-recovered`), the R11 receipt and evidence, the final candidate file, and the reload code and driver they exercise. The 49 frames that review 50 settled stay settled.
- Not run: builds, tests, simulators, browsers, locks or the ledger. I used Pillow through `uv` only for crops and pixel sampling.
- Artifacts: `reviews/51-collages/a-pad-r11-sheet-crops.png` and `sample.py`. I reused `reviews/50-collages/verify-evidence.py` and `collage-crop.py` without changing them.

## Verdict

**All three iPad frames score 9. The full native Memory gate can close.** Review 50 scored the other 49 frames at 9, and the source is unchanged since then. That makes 52 of 52 required frames at 9 or higher, 26 per device. I give no averages and no projected scores.

| Frame | What it shows | Score |
| --- | --- | --- |
| iPad `memory-reload-error` | The paused save failed. "Your edits are kept…" banner, gray Add, disabled Save, Discard enabled | 9 |
| iPad `memory-reload-failed` | The reload GET failed. The load error sits below the header, with "Try loading again". The draft count shows 362 | 9 |
| iPad `memory-reload-recovered` | The retry succeeded. The saved note 1 is back, the count shows 341, and Forget… is enabled | 9 |

## Evidence integrity, verified

- **Source:** `source-state.py` with the `validate-ios.sh` prefixes gives `cf30021c…bf3fb15` from 242 files. That matches review 50, the R11 receipt, the evidence and the `.private` summary (`ios inputs` line, `exit status: 0`). The web capture-driver change falls outside those prefixes, so native inputs are unchanged.
- **Fixture:** `.agents/fixtures/memory-design.json` hashes to `ce694ada…7634`, which matches all three JSON files.
- **Final candidate:** `verify-evidence.py` passes 52 of 52 images. It checks each sha256, each exact mtime, that each mtime falls inside its run's start and finish window, each Passed result with 0 failed and 0 skipped, and each summary.
- **Delta from the partial candidate:** the final file adds exactly the three iPad reload images. It removes nothing and changes nothing. All 26 iPhone entries and the other 23 iPad entries are byte-identical JSON. The only other changes are the `gate` text and the dropped `missing` key.
- **R11 provenance:** each of the three entries matches the R11 evidence segment by image, path, sha, mtime, result object, summary, fingerprint and phase. None is marked as reuse. The mtimes are 1793129242, …297 and …309. All fall inside the run window from 1793129161.965 to …310.979, and they appear in driver order.
- **R11 receipt:** one iPad run, `reload-error`, return code 0. Execution took 157 s and stayed within the deadline. Both owned simulators are shut down, with no cleanup errors. The lock probe reads free and no owned xcodebuild processes remain.
- **R11 log:** `testMemoryDesignReview` passed in 130.95 s.
  - There is no `DESIGN_MEMORY_REPLACE` line, so the first exact replacement succeeded.
  - `DESIGN_MEMORY_CONFLICT` logs the edited draft. `DESIGN_MEMORY_RELOAD` logs the saved "Trash and recycling…" text.
  - The 36 `kAXErrorServerNotFound` lines are all XCTest "Ignoring failure to get hierarchy for remote element" notices during springboard idle waits. They are benign.
  - Unlike R9, there is no `BUILD INTERRUPTED`.
- **Brief collage:** `memory-ipad-r11-reload.png` shows the same three frames. Its "Before retry" label on the first panel is loose, since that frame is the paused-save failure before the first reload. It is a review aid only.

## Reload and retry behavior, source plus frames

- **The failed reload keeps the exact draft.**
  - In `load()` (`ExperienceViews.swift:518-524`), `error` is cleared before the GET. On failure, `store.run` sets `error` and the guard returns before `value`, `drafts`, `conflicts` or `failures` are touched.
  - The driver asserts `field("memory") == editEntry` after the failure (`ScreenshotTourTests.swift:789`), and the run passed.
  - The frame confirms this independently. The "362 / 2,200 characters" count equals the fixture's draft joined with the edited entry. The saved document is 341.
- **The error is readable and its action is reachable.**
  - The load error banner renders #A33C32 on #F9F1F1, which is 5.81:1. "Try loading again" is white on #246F59, 6.01:1, with a 44 pt minimum height.
  - The error sits right under the header card and clears the navigation chrome. The driver asserts it lies fully between the nav bar's bottom edge and the form's bottom edge (`:786-787`).
  - `onChange(of: error)` scrolls to the banner and moves accessibility focus to it.
  - While `error` is set, the bottom "Reload profile memory" button is hidden, so only one reload action shows.
- **Retry protects the draft.** "Try loading again" calls `requestReload()`. Because the draft is still `changed`, the retry asks for the discard confirmation again before loading. That is correct, since the edits really are still there.
- **The retry restores the saved document and unlocks the form.**
  - A successful `load()` resets `value`, `drafts`, `conflicts`, `failures` and `notices`.
  - The driver asserts four things (`:793-797`):
    - the paused banner disappears
    - `memoryEntry.memory.1` is a `TextField` again
    - it becomes enabled
    - its value equals the first saved text
  - The frame shows the saved note 1, the 341 count, enabled red Forget… actions, and no failure banner in view.
- **Locking holds during the failed state.** `conflicts` survives the failed GET. Entries stay read-only text, while Add, Save and Forget stay locked and Discard stays available. The error frame shows Add as #697268, 4.99:1, matching B1. Save is disabled and Discard is #246F59.

## Visual notes, none blocking

- The failed frame shows only one error in view, but the paused banner further down still says "reload profile memory to continue". The visible button is "Try loading again". The two labels mean the same action, so this is a wording nit and not new.
- "Check the native memory store" is the fixture's server message. It does not come from app copy.
- These carried-over notes are still visible:
  - the half-width separator under the banner in the failed card
  - the short "Try loading again" pill
  - the system red "Forget…" at 3.57:1

  This delta introduces none of them.
- The iPad framing matches the iPhone reload frames that review 50 approved: the same driver, banner placement and actions. The sheet-in-sheet layout has no clipping, overlap or truncation apart from the intended scroll cut at the sheet's bottom edge.

## Limitations

- No frame shows the draft text itself during the failure. The proof comes from the in-frame character count, the source path and the passing driver assertion.
- The recovered frame starts at Assistant notes, so the top of the form is not visible. That the load error is gone rests on `load()` clearing `error` and on the driver passing.
- These remain unverified:
  - synthetic fixtures only, with no live Hermes reads or writes
  - the transient "Reloading profile memory…" spinner, which was not captured
  - VoiceOver focus on the banner, which was traced in code and not heard
  - physical devices, hardware keyboards, AX5, and the iOS 17 fallback
- Review 50's other unverified items still stand: the native Copy menu, VoiceOver speech for the quoted Forget message, and the `AssistantConfirmationSheet` branch before iOS 18.
- Should-fix items to batch with any later Memory change, not gate blockers:
  - N1: disabled Add ink is darker than its disabled siblings
  - N2: annotation dots overlap the first glyph of their targets
  - the "Reload profile memory" button lacks a `pendingForget` guard, so it looks enabled during the Forget dismissal
