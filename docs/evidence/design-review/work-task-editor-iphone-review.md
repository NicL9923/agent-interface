# 100. Work W2b task editor: iPhone AFTER render review

Reviewer: Anthropic Claude Opus 5.5, high effort. Independent of the OpenAI implementers, GPT-6.1 Terra and Sol. No children.
Method: saved source, logs, receipts, hashes and saved images only. Offline Pillow crops and contrast sampling on the authoritative originals. I ran no builds, browsers, simulators, devices, locks, signing, services or probes. I read no current iPad screenshots. I edited no app, tool, doc, fixture or ledger file. Files written: this review and `100-collages/` (`crop.py`, `contrast.py`, `measure.py`, `kb-button-crop.png`, `dark-kb-button-crop.png`, `ax3-middle-bottom.png`, `ax3-bottom-top.png`, `delta-button-r5-vs-r6.png`).

## Verdict

- **iPhone W2b gate: passes.** All 13 actual frames score 9. No averaging and no projection.
- **No blockers. No mediums.** Four lows, none of which blocks the gate.
- **No source or data defect forces a fresh phone run or a stop of the iPad capture.**
- The style delta changes the accessibility and hit frame only. Its rendered pixels match R5.
- This is a reviewer score, not an acceptance record. The ledger still needs to record it.

## Proof I verified

| Item | Result |
| --- | --- |
| Selection `work-w2b-native-phone-final-selection.json` | Exactly 13 names: R6 4 AX, R7 9. Every path is an `-r6-` or `-r7-` capture. No R1 image is included |
| 13 image sha256 and mtime | All match the selection and both evidence files. All are 1206×2622 |
| Source pin | `8b416af9…cb7 (243)` in the selection, both evidence files, both receipts, both `-source.txt` pins and all 5 run summaries |
| Fixture | `e8fee514…e744` in both evidence files and both receipts |
| Style patch | sha256 `839b5bb8…928` matches. The worktree `AutomationViews.swift:812-819` matches the patch exactly |
| R6 receipt | 1 run, rc 0, 1 passed and 0 skipped, 4 named PNGs, devices Shutdown, `errors: []`, lock free, released 22:42:30.780368Z, verified 22:42:30.967281Z, within deadline |
| R7 receipt | 4 runs, each rc 0 with 1 passed and 0 skipped, 3+1+2+3 = 9 named PNGs, devices Shutdown, `errors: []`, lock free, no owned xcodebuild. Actual release 22:53:27.296684Z, scoped verification 22:53:27.573330Z, within deadline. The supervisor log records `actualUnlock`, `verifiedRelease: true` and the verifier path |
| Variant markers | `DESIGN_WORK_TASK_EDITOR_VARIANT … complete` once for each of the 5 variants |
| Target measurement | R5 log `:1604`: `width=46 height=36`. R6 log `:1598`: `width=44 height=44 frame=(337.0, 500.0, 44.0, 44.0)`. R7 `task-create` log: the same 44×44. The `>= 44` guard is unchanged at `ScreenshotTourTests.swift:1172` |

**R7 timing disclosure.** The saved records show the terminal state above. The image mtimes (22:47:17Z to 22:53:18Z) precede the release. The original foreground session was lost after an interruption, and the parent relayed the saved release record on resumption, before it relayed the current images and hashes. I can verify the saved records. I cannot verify when they were relayed, and nothing here claims a live foreground drain.

## Style delta and its callers

`AutomationViews.swift:812-819`:

```
ToolbarItemGroup(placement: .keyboard) {
  Spacer()
  Button { focusedField = nil } label: {
    Image(systemName: "keyboard.chevron.compact.down").font(.body).frame(width: 44, height: 44)
      .contentShape(Rectangle())
  }.buttonStyle(.plain).foregroundStyle(Palette.muted).accessibilityLabel("Hide keyboard")
```

- **It fixes the measured defect.** The default bar-item style clamped the hosted frame to 46×36. With `.plain` and a rectangular content shape, the 44×44 frame survives as both the accessibility frame and the hit area. Two independent runs measured 44×44.
- **There is no visible change.** `delta-button-r5-vs-r6.png` places the R5 and R6 keyboard crops side by side. The glass platter, glyph and color are the same. The platter is about 55×49 pt in both.
- **Callers are unaffected.** The action is still `focusedField = nil`. The label and identifier are unchanged. The button is outside `fields.disabled(…)`, so hiding the keyboard while busy stays harmless, as review 98 noted. `.plain` keeps the system pressed feedback. The button has no disabled state.
- **The test diagnostics are sound.** `tearDown` uses `totalFailureCount` (`ScreenshotTourTests.swift:18`). Existence and hittability (code 2) are separate from size (code 4). The frame is read once. Nothing was relaxed, and there is no Return, drag fallback or timeout increase.

## Contrast samples on the originals

Text needs 4.5:1 and icons need 3:1. All samples pass.

| Element | Ratio |
| --- | --- |
| Hide keyboard icon on light glass, AX3 | 4.91 |
| Hide keyboard icon `#A6B4A7` on dark glass `#49494B` | 4.16 |
| Title and Instructions prompts, light | 4.99 |
| Instructions prompt, dark | 6.44 |
| "Task" and "Wait for these tasks (optional)" headers | 4.70 light, 7.57 dark |
| Help text, status captions, board captions, "Saved in Hermes." | 4.99 |
| Assignee value and Refresh status, green | 6.01 light, 7.94 dark |
| Create task, Close | 5.91, 5.76, 6.08 dark |
| Uncertain banner text on pink | 5.81 |
| Field labels | 21.0 light, 13.94 dark |

The disabled "Create task" measures 2.18. It is exempt.

## Scores, each actual frame

| # | Frame | Score | Basis |
| --- | --- | --- | --- |
| 1 | `task-create-large-text-keyboard` | 9 | The deliberate keyboard-visible AX3 state. The Hide keyboard platter sits clear of the text at the right of the "(optional)" line. The glyph scales with `.body` inside the measured 44×44 target. The title wraps cleanly, and the cursor is visible |
| 2 | `task-create-large-text-top` | 9 | Title and Instructions labels hold at AX3. The prompt is readable. The assignee wraps under its label with no truncation. The idle status chrome is gone |
| 3 | `task-create-large-text-middle` | 9 | Assignee, Priority and the stepper all fit. The help text is legible. Its last word is cut by the sheet edge, which is a scroll seam. See L3 |
| 4 | `task-create-large-text-bottom` | 9 | The dependency rows wrap with their statuses. The toggles are centered. The system hyphenates "weatherstrip-ping". The list end and "Choose up to 20 dependencies." are both visible |
| 5 | `task-create-empty` | 9 | Persistent labels, readable prompts, a muted "Task" header and "(optional)" markers. Status captions sit under each row. Create is disabled until a title exists, which is the iOS convention, and the Title label makes the requirement plain |
| 6 | `task-create-filled` | 9 | The two selected dependencies are clear. "Running" and "Blocked" captions distinguish the rows. Create task is enabled at 5.91 |
| 7 | `task-create-saved` | 9 | The sheet dismissed into an expanded Blocked (3), with "Plan the winter supplies · Garden planner · Priority 2" first. The source posts "Created … in Blocked." (`AutomationViews.swift:877`). See L4 |
| 8 | `task-create-dark` | 9 | All dark text passes. The prompt is measurable at 6.44, and the hide icon is 4.16. The platter slightly overlaps the stepper pill. See L2 |
| 9 | `task-edit` | 9 | "Edit task" title, primary Save task, the same labeled fields and Unassigned. The empty sheet below is normal sheet height |
| 10 | `task-edit-saved` | 9 | The nested sheet returns to the detail. "Saved in Hermes." sits under Edit task at 4.99. Status Ready and Unassigned are visible. The surrounding detail is accepted W2a context and was not rescored |
| 11 | `task-create-uncertain` | 9 | One honest warning with Refresh status beside it. The repeated footnote is gone. Create is disabled, and the draft keeps its labels |
| 12 | `task-create-refreshed` | 9 | The callout copy is plain at 21:1. The confirm becomes a primary Close. The matched task is filtered out of the dependency list, and the toggles and picker are dimmed. See L1 |
| 13 | `task-create-closed` | 9 | Blocked (3) has exactly one "Plan the winter supplies", assigned to Ranch hand. No duplicate |

13 of 13 frames score 9.

## Findings

### Blockers

None.

### Mediums

None.

### Lows (optional, non-blocking)

- **L1. Mixed disabled cues in the recovery states.** In `task-create-uncertain` and `task-create-refreshed`, the source disables all of `fields` (`AutomationViews.swift:795`). On screen, the toggles dim (`#E2E2E3` against `#C5C5C7` when enabled) and so does the assignee, but the Title and Instructions text and the stepper glyphs stay pure black, exactly as in the enabled frames. This is the platform's rendering. The banner and the Close callout carry the state, so it does not cost the score. A related nit: `refreshed` keeps both Cancel and Close. Both only dismiss, but "Cancel" can read as undoing a task Hermes may already have saved. If this code changes later, consider hiding Cancel while `likely != nil`.
- **L2. In the keyboard-up dark frame, the glass platter overlaps the stepper pill's lower-right edge by about 7 pt** (`dark-kb-button-crop.png`). The "+" glyph stays visible. A tap in the overlap hits Hide keyboard, which is harmless. This is iOS floating accessory placement and has been present since R4. The style delta did not introduce it.
- **L3. AX3 capture coverage seam.** `-middle` ends at "…the instructions are ready." with "ready." clipped by the sheet edge. `-bottom` starts at "Draft the winter checklist". So at AX3, the help text's last line, the "Wait for these tasks (optional)" header and the first three dependency rows are never imaged. Normal-size frames cover all of them, and the plan in review 93 did not require them at AX3. This is a coverage note, not a product defect.
- **L4. Runtime warning "Invalid frame dimension (negative or non-finite)"** appears in 4 of the 5 R6/R7 summaries. It is absent from `task-edit`. It first appears with the R4 keyboard-toolbar source (`9a33d969…`, summaries `221506Z` and `221650Z`) and also appears in R5 before the style delta. It has no visible effect in any frame, and it is unlocated. Do not chase it for this gate. If it matters later, export one xcresult's runtime-warning backtrace.
- Note on frame 7: native shows no on-screen "Created" text. It relies on the dismissal, the expanded group and the announcement, as M8 specified. This is iOS convention and is not a finding.

## Annotations

| Comparison | Bindings | Arrow and claim check |
| --- | --- | --- |
| `iphone-create` | BEFORE `fc8a3846…` and the AFTER R7 `task-create-empty` `70871430…`. The BEFORE hash matches `work-w2b-before-selection.json` | B1 lands on the pale "Title" placeholder, which is accurate. B2 lands on the "Managed by Hermes" block, which is accurate. A1 lands on the Title label and A2 on "Instructions (optional)", both accurate. "Readable prompt" is backed by 4.99 |
| `iphone-create-recovery` | BEFORE `a17d8bc7…`, which matches the baseline, and the AFTER R7 `task-create-uncertain` `270a9221…` | B1 lands on the repeated "Refresh and review…" footnote, which is accurate. The A1 tip lands in the blank gap just above-left of "Refresh status" rather than on the text. That is close enough, and the claim is true. A2 lands on the Title label, which is accurate |
| `iphone-recovery-after-states.png` | Both tiles match the R7 `task-create-uncertain` and `task-create-refreshed` originals at 0.00 mean pixel difference (552×1200) | Labeled "AFTER: unconfirmed" and "AFTER: reviewed, no matching BEFORE". It makes no before/after claim and uses no fake BEFORE |

The phone's 2 comparisons are sound. That makes 5 of the 6 planned comparisons: web 3 accepted and phone 2 sound. The iPad's 1 is pending.

## Effect on the iPad capture

The iPad uses the same source pin and the same toolbar code. I found nothing in the delta, the diagnostics or the data that would invalidate an iPad run in flight. Review 98's iPad note still applies. If the simulator uses a hardware keyboard, a "keyboard" frame shows no keyboard, so check that before calling a pad frame keyboard-visible.

## Limitations

- These are simulator images on iOS 27.0 with an iPhone 17. There were no VoiceOver, physical device, hardware keyboard, AX5 or iOS 17 checks, and I make no claims about them.
- The functional proof keeps its original bindings: R1 33 unit + 3 goal UI + 2 task UI, R4 repeat of the 2 affected task UI tests, R6 toolbar 44×44, the hide that preserves the draft and the range guards, and R7's four tours. I asked for no repeat for a style-only delta.
- Contrast comes from pixel sampling on the PNGs, not from source tokens. Glass backgrounds vary slightly with the content behind them.
- I did not review the iPad images or re-review the accepted web, W1 or W2a work.
