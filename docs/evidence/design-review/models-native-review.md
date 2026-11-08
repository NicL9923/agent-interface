# 38 Models native retry recheck (Opus 5.5 High, independent of the OpenAI implementer)

`R=/Volumes/DevSSD/scratch/wildbots-design-review`. Worktree `t3-d1b42c2a`.

Scope: only M1 from `37-models-native-review.md`, the stale capability-load banner after a successful Tools retry. Composer, Skills and web stay as 37 accepted them. I made no app edits. I ran no build, test, simulator, browser or lock, and started no child agents. I used offline scripts only: Pillow through `uv`, plus `source-state.py`.

## Verdict

**M1 is fixed. The full Models/capabilities gate can close at 9.0 or above with no obvious blockers.**

| Screen | iPhone | iPad | Basis |
| --- | --- | --- | --- |
| Tools | **9.0** | **9.0** | Fresh 38 frames for the 4 `models-errors` states, plus the 37-reviewed `loaded-tools` and `unavailable-tools` |
| Composer | 9.0 | 9.0 | Carried from 37. Inputs unchanged |
| Skills | 9.0 | 9.0 | Carried from 37. Inputs unchanged |

Each score comes from frames. None is an average or a projection.

## M1 verification

**Frames.** In `models-native-retry-captures/after/{ios,ipad}/models-errors-tools-retried.png`, the banner is gone. The "Tools" section header sits directly under the tab row. All three tools load with their switches, the footer reads "Save to apply your changes.", and Save tools is enabled and prominent. Nothing contradicts anything else on screen. The matching `-tools` frame still shows the banner, Retry loading tools and a disabled Save, so the failure state remains intact. See `38-collages/{ios,ipad}-tools-retry.png`, which shows the 37 failed/retried pair next to the 38 pair.

**Source.** `38-source` matches the worktree byte for byte, and the manifest hashes match. `37-caption-source` → `38-source` produces exactly the lines in `38-retry-delta.patch`. `ModelPickerView.swift` is unchanged since 37.

- `retryTab()` (`BotSettingsView.swift:887-890`) sets `error = nil` synchronously, then starts `Task { await loadTab() }`.
- There are exactly two callers: Retry settings (`:199`) and Retry loading tools/skills (`:618`). Retry settings moved from an inline closure to `Button(action: retryTab)` with the same `Text` label, `minHeight: 44`, `contentShape` and `.accentProminent`. The behavior is identical. The capability Retry keeps its plain `Button("Retry loading \(kind.rawValue)", …)` form.
- The other `loadTab()` callers (`.task(id: tab)` at `:220`, post-save reloads at `:255` and `:683`, and the routine `onSaved` closures) are not user retries. Leaving their errors alone is correct.
- A failed retry still shows its error, because the `catch` in `loadTab` sets `self.error` when `loadId == currentId`. Retry is hidden while `catalogLoading` contains the kind, so a double tap can't stack loads.
- This matches web, where `use-catalog-draft.ts` clears the error on retry.

**Would the test fail on old code? Yes.** The `error` element is the same `app.staticTexts[original["capabilityLoadError"]]` query that `bannerVisible(error)` proved present before the `-tools` capture. The banner renders under `if let error, detailLoaded` (`:95-96`), pinned outside the `Form`, so `.exists` has no virtualization escape. Under old code, `loadTab` success never clears `error`, so `XCTAssertFalse(error.exists)` fails every time, not just on unlucky timing. Under new code, the clear happens before the load begins, so by the time the `Web search` switch exists the banner is already gone. The assertion runs before `capture(name + "-tools-retried")`, so a stale frame can't be captured.

## Evidence integrity

My script is `38-scripts/verify.py`.

- `source-state.py ios .agents/tools/validate-ios.sh .agents/tools/patch-xctestrun.py .agents/tools/with-native-admission.py` gives `sha256:649a3b8b…11e6` over 242 files. That matches the retry evidence, the final composite's `currentSource`, and `models-native-retry-source.txt`.
- `models-native-retry-evidence.json`: iPhone 17 (`ChatUX-I1`) and iPad Pro 11-inch (M5), both iOS 27.0. Each run reports Passed with 1 passed, 0 failed and 0 skipped. Both logs show `testModelsDesignReview passed` and only the four `models-errors*` states.
- All 8 images: the sha256 matches, the recorded mtime matches, and every mtime falls inside its run's start and finish window.
- The two changed source files have mtime 08:47:08, about 55 s before the iPhone run started. They are the newest files under `ios/`, so no app code changed after these runs.
- `models-native-final-evidence.json`: 26 images per device split 16/6/4 across after/caption/retry, and every hash matches. Compared with the preserved `-v2.json`, which was the 37 composite at `8a91e0c2…`, only the four `models-errors-*` entries per device changed. The other 22 are identical.

**Rerun of the 3 unchanged error variants.** I pixel-diffed `errors-catalog`, `errors-retried` and `errors-tools` against their 37 frames, excluding the status bar (`38-scripts/pixdiff.py`). The only differences are anti-aliasing on the background avatar behind the dimmed sheet: a 44×5 px strip on iPhone and the header avatar column on iPad (`38-collages/background-diff-crops.png`). The sheet content is pixel-identical, so 37's acceptance of those states carries over.

## Annotated comparisons

`annotated/models-{ios,ipad}-tools-retry.png` and their specs point at the right files: the smoke "before" `models-errors-tools-retried` and the 38 retry capture. The captions are accurate. On the after side, the marker points at the "Tools" header, where the banner used to be. That's acceptable, though "where the banner was" isn't self-evident without the before panel next to it. Cosmetic only. I did not re-review the other 24 annotated comparisons. Their pointer tweaks don't feed any score.

## Not verified

The 37 limitations still apply: physical devices, VoiceOver, hardware keyboard, the iOS 17 fallback, iPad compact width and AX5. I make no new claims about runtime or network behavior. 37's should-fix items 1 to 5 remain open and non-blocking. Test success served as integrity evidence only. The scores come from the frames.

## Artifacts

- `reviews/38-collages/{ios,ipad}-tools-retry.png`: the 37 and 38 failed/retried frames.
- `reviews/38-collages/{ios,ipad}-catalog-rerun.png`: the rerun catalog states next to the 37 frames.
- `reviews/38-collages/background-diff-crops.png`: the only pixel differences in the unchanged reruns.
- `reviews/38-scripts/verify.py` and `pixdiff.py`.
- `reviews/38-own-diff.txt`: snapshot diff, which matches the delta patch.
