# 82 Work W2a web recheck and native proposal diff

- Reviewer: Claude Opus 5.5, high effort. Independent Anthropic recheck of OpenAI root fixes. No children.
- Worktree `t3-d1b42c2a`, HEAD `1efdced` plus the uncommitted W2 state.
- Main scope: review 80 F1 to F5 and S1 to S3, the 19 R6 web frames, and the 7 R6 annotations.
- Secondary scope: the 6 changed native lines that apply review 81 B1 and F1. Source only.
- No build, browser, simulator, lock, service, or source edit. I wrote only this file and the crops in `reviews/82-collages/`.
- Settled and not rerun: controller and W1 guards, review 78 native guards, the 35 prior tests reused for unaffected logic, W2b create and edit.

## Verdict

- **Web W2a: accepted. All 19 frames score 9 or higher.** F1 to F5 and S1 to S3 are fixed as specified. I found no new product defect that blocks 9.
- **Annotations: 6 of 7 are accurate.** `work-w2a-web-r6-board-desktop.png` points at the intro paragraph instead of a group heading (A1). It's a one-number spec fix, and no recapture is needed.
- **Native: source is ready for a fresh bounded canary.** No score. The patch has not been compiled or rendered yet.

## Provenance checks

| Check | Result |
| --- | --- |
| `source-state.py src capture-design.js capture-design.py work-tasks.json` | `ec6b1f4d…6eaef` (226 files). Matches the evidence, reservation and receipt |
| Fixture sha256 | `e8fee514…e744`. Matches |
| 19 PNG sha256 and mtime against `work-w2a-web-after-r6-evidence.json` | All 19 match |
| PNG mtimes against the R6 receipt | 16:00:09.9Z to 16:00:44.9Z. All inside admission at 16:00:05.578Z and release at 16:00:48.859Z |
| R6 receipt | build and capture exit 0, 43.28 s, released 16:00:48.859321Z, verified release 16:00:48.905473Z, lock probe free, port 3044 closed |
| `captures-r5` folder label | Created 11:00:07 local, which is 16:00:07Z inside R6. `work-w2a-web-after-r5-no-admission.json` records no admission and no runtime. The disclosure is accurate. These are fresh R6 images, not reused ones |
| Review 80 snapshot, 4 files | All 4 sha256 values match `manifest.json` |
| 7 annotated images | All sha256 values match. Each AFTER path is an R6 frame |
| Capture log | 19 screenshots, no overflow |
| Native fingerprint, `validate-ios.sh` inputs | `613c0685…524b` (243 files). Matches |
| Native candidates | Proposal files still hash `6fe5c9a7…` and `918e7fc0…`. The diff against current is exactly the 6 lines below |
| Recorded, not rerun | 31 web UI tests (the file has 31 `it` blocks). I found no R6 Vitest log in the scratch folder, so this rests on the root's record |

## Review 80 findings

| Item | Status | Evidence |
| --- | --- | --- |
| F1 label margin | Fixed | `automation.css:82` zeroes `margin-bottom` only under `.automation-task-add`, `.automation-task-move` and `.automation-task-note`. The W2b create form is untouched. Add dependency now aligns with its select. The block field to its buttons gap drops from 44px to about 26px |
| F2 duplicate metadata | Fixed | `automation.css:68` hides `small` only in an open summary. It wins over `.automation-item > summary small`. Closed rows keep the caption. At 200% the meta now takes 2 lines instead of 3 |
| F3 note affordance | Fixed | `display: list-item` brings back the triangle, and the text is ink colored. `automation.css:77` still applies `min-height: 44px` to this summary, so the target holds |
| F4 Reviewer clip | Fixed | "Choose one" fits at 200% in `review-form-large-text` |
| F5 focus | Fixed | The effect focuses the card's result `<p tabIndex={-1}>` with `preventScroll`, then scrolls that element into view. It falls back to the summary, then the heading. Start is never focused. `:focus-visible` gets a 2px accent ring. `refused-card` shows the ring after keyboard activation, and `started-phone` correctly shows none after a mouse click |
| F5 tests | Correct | 3 assertions now expect the result. The late-result test still expects the second card's summary. That's right, because `openTaskRef` blocks a focus move for a task that isn't open. The harness `waitResult` expects the focused result. The refusal path focuses Start, then Tab, Shift+Tab, Enter, and asserts `:focus-visible`. Landing rects are measured before any harness scroll |
| S1 dependency results | Fixed | `source: "move" \| "dependency"` is set on all three feedback paths. Exactly one copy renders in each state. A dependency result renders in Dependencies even on a running card, and move results never do. The new test covers add and remove, placement and focus. No frame covers it, and the root makes no screenshot claim |
| S2 expanded opener | Fixed | Accent border and soft fill, visible in `block-form-phone` and `review-form-large-text` |
| S3 harness | Fixed | `shot` moves the mouse to (0,0) before every capture, including `preserveFocus` ones, and both `anchorShot` and `subjectShot` go through it. There's no stray hover in any frame. `refused-alert` became `refused-goal-controls`, and the count stays at 19 |

## Scores

Bar 9. Each score covers only the frame named. Paths are relative to `work-w2a-after-web-captures-r5/work-tasks-a-after/web-work-task-`.

| Frame | Score | What decides it |
| --- | --- | --- |
| board-desktop | 9.0 | Unchanged. Clear groups and captions |
| board-phone | 9.0 | Unchanged. Clean wrapping and rhythm |
| board-large-text | 9.0 | Unchanged. Scales without clipping |
| detail-desktop | 9.0 | Single meta row, aligned dependency controls, and a note disclosure that reads as a control |
| detail-dark | 9.0 | Same fixes. Good contrast, and the ink note text holds up in dark |
| detail-phone-top | 9.0 | No duplicate. About a 10px gap from the select to Add dependency |
| detail-phone-actions | 9.0 | 2+1 wrap, with a triangle on the start note |
| detail-narrow-actions | 9.0 | Clean 1+1+1 at 320 |
| detail-large-text-top | 9.0 | Meta drops to 2 lines. Readable hierarchy |
| detail-large-text-actions | 9.0 | Large targets. The two-line note keeps its triangle |
| refused-card | 9.5 | The result sits right under the actions with a clear focus ring. No hover. Goal controls stay out of the way |
| refused-goal-controls | 9.0 | Shows Resume, Replace and Clear enabled. It replaces the old duplicate with a meaningful state. Only the harness proves it comes after a refusal, which the evidence says |
| running | 9.0 | No duplicate meta. A clear read-only note |
| review | 9.0 | Neutral Start and a useful review hint |
| empty | 9.0 | Unchanged |
| unsupported | 9.0 | Unchanged |
| started-phone | 9.0 | "Moved to Ready." sits under the actions. Start is neutral. No ring after a mouse click, which is correct |
| block-form-phone | 9.0 | The expanded Block task… is visibly distinct. The focus ring on Request review… is the deliberate Tab from the harness, so the frame shows the expanded and focused states apart. Gaps are fixed, and there's no hover |
| review-form-large-text | 9.0 | "Choose one" fits. The expanded opener is marked. Even label spacing |

## Annotations

| Image | Result |
| --- | --- |
| board-desktop | **A1, needs a fix.** The AFTER marker at fraction y 0.30 points at the intro line "review.", about 55 source px above "Blocked · 2". The caption is about named groups. Move it to about y 0.345. The "Done" claim from review 80 is gone, and the marker no longer covers text. Crop: `reviews/82-collages/board-desktop-after-marker.png` |
| board-phone | Accurate. The marker halo now clears "B" by about 3px. Crop: `board-phone-after-marker.png` |
| detail-desktop | Accurate. AFTER points at the callout, and the BEFORE marker no longer covers "B" |
| detail-phone-actions | Accurate. The caption now claims only what the frame shows |
| detail-large-text-actions | Accurate. Optional nit: the BEFORE marker sits on the disabled Block task, between the Start and Unblock rows that the caption names. It's still readable |
| refused-alert | Accurate, and it pairs the BEFORE alert with the AFTER `refused-card`. The marker halo touches the focus ring's left edge but covers no text. Crop: `refused-after-marker.png` |
| running | Accurate |

## Non-blocking notes

- **N1. Open card title gap.** With the caption hidden, a single-line open title has about 37px of space above the meta chips. That comes from the 44px summary min-height plus the 12px detail padding. The chip-to-body gap is about 18px. It reads as a header break and doesn't cost a point. If you touch this CSS again, `.automation-task[open] > summary { min-height: 0 }` or a smaller `padding-top` would tighten it. Closed rows still need the 44px.
- **N2. Uncertain path, pre-existing.** When `changeTask` returns null, `runTask` sets the "Not confirmed" feedback but never sets `focusTask`. So there's no focus move and no scroll-into-view. The result renders right under the actions, so it is usually in view anyway. This existed before review 80 and isn't part of this gate.

## Native proposal diff, source only

```
AutomationViews.swift:855-859
  Task { @MainActor in
    await Task.yield()
    guard !control.busy, control.taskFeedback?.taskId == initial.id else { return }
    scroll.scrollTo(resultID, anchor: .bottom)
  }
ScreenshotTourTests.swift:964-966
  let homeIndicatorClearance: CGFloat = 34
  XCTAssertLessThanOrEqual(resultFrame.maxY, visible.maxY - homeIndicatorClearance, "…clear the home indicator…")
```

- Review 81 F1: applied as specified. It matches the accepted Memory precedent at `ExperienceViews.swift:394-396`, which captures the proxy in the same way. The re-check after the yield blocks a stale scroll.
- Review 81 B1: applied with a named constant, and only in the phone tour path (`:956`). The iPad path at `:1125` is unchanged. A no-op scroll should now fail at about 1962 against a limit of about 1922.
- Timing: the assertion reads the frame after `start` turns enabled. The scroll runs one main-actor turn later. XCUITest's idle wait should cover that. If it doesn't, the test fails red instead of passing falsely, which is the safe direction.
- Nothing else changed in either file.
- **Ready for a bounded native canary.** This is not design acceptance. The canary still needs `task-refused`, `task-started` and the AX variants, then visual review of the actual PNGs.

## Gate

- Web W2a: **accepted at 9 or above for all 19 frames.** Fix A1 before showing the board-desktop annotation as proof. No recapture is needed.
- Native: pending. Run the bounded canary on fingerprint `613c0685…524b`.
