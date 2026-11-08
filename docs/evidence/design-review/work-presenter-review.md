# 57 Work goal presenter repair: proposal and regression test review

- Reviewer: Claude Opus 5.5, high effort, independent of the OpenAI implementer. No children.
- Worktree: `/Users/nicolas/.t3/worktrees/agent-interface/t3-d1b42c2a`, HEAD `ba930d3`.
- Scope: `R/work-goal-presentation-proposal.{swift,patch,json}` against `ios/AgentInterface/AutomationViews.swift`, and the applied test `AutomationFlowTests.swift::testGoalPresentersStayOverSettings` (lines 65 to 107).
- Source read, sha256 prefixes:
  - `ios/AgentInterface/AutomationViews.swift` `371b5ec7fbdcbc58`, unchanged, matches the proposal JSON `beforeSHA256`
  - proposal `.swift` `29dcf21270e86c8f`, matches JSON
  - `ios/AgentInterfaceUITests/AutomationFlowTests.swift` `d139b6a545c28d87`
  - `ios/AgentInterfaceUITests/UITestSupport.swift` `66b30b84bff4f7b4`
  - `ios/AgentInterface/AutomationDebugFixtures.swift` `ce4e372b2b8a3d3a`
  - `ios/AgentInterface/DebugFixtures.swift` `66ea4f8495ded1c1`
  - `ios/AgentInterfaceUITests/ScreenshotTourTests.swift` `795633b2c048ab5b`
- Evidence read: review 56, `R/work-native-before-failure-evidence.json`, the r1 failure hierarchy, and the two settings-open hierarchies in `R/memory-ax-r4-diagnostics/` (`1A2B36FA`, `EE0AD81B`).
- Light checks only: `patch` applied to a scratch copy of the original reproduces the proposal byte for byte. No build, simulator, browser, service, lock, or probe. No app, docs, or ledger edits. No visual scores.

## Verdict

- **Proposal: ready to apply unchanged after the red run.** It moves the three goal presenters to the Work `Form` through the existing `HermesWorkSheet` route, and changes nothing else. I found no ownership, lifetime, or caller defect.
- **Test: one required fix before the red run.** The fallback dismissal tap resolves an ambiguous query. It can produce a red for the wrong reason, which is exactly the case you need to read cleanly. One small wait is also recommended. Both fixes are in the test file only.
- **Short legacy fixture risk is real.** The legacy Replace goal row likely sits about 200 pt higher than in the canary. If old code passes 3 of 3 cycles, the regression test does not discriminate, and the canary stays the proof. See "Red-run interpretation".
- Nothing is fixed until the green run passes.

## Proposal review

### Ownership, identity, and lifetime: no defect

| Check | Finding |
|---|---|
| Presenter owner | All Work sheets now sit on one `.sheet(item: $sheet)` on the `Form`, and the clear dialog sits beside it on the `Form`. No goal presenter remains on a lazy row. |
| State owner | `editing`, `startingNewAttempt`, and `clearing` move out of `HermesGoalSection`. `sheet` and `clearingGoal` are `HermesWorkView` `@State`, which lives as long as Work. `reviewedInterruption` stays row-local with both `onChange` resets. It is not a presenter. |
| Sheet identity | `"goal-editor"` and `"new-resume-attempt"` are constant ids, distinct from `create-task`, `task:*`, `create-trigger`, and `trigger:*`. One `sheet(item:)` means at most one Work sheet at a time. That matches today's reachable behavior, since a presented sheet covers the rows that could open another. |
| Callers | `HermesGoalSection` has one caller, `HermesWorkView.body`, and the proposal updates it. No other references to the deleted state remain. The `editing` hits at proposal lines 603 to 639 belong to `HermesTaskDetail` and are untouched. |
| Task and trigger routes | `createTask`, `taskDetail`, `createTrigger`, and `editTrigger` cases and destinations are unchanged. |
| Parent guards | Each row button keeps `.disabled(disabled)`. `HermesGoalEditor` and `HermesNewResumeAttempt` keep `interactiveDismissDisabled(control.busy)`, their Cancel buttons, and `dismiss()` on success. `@Environment(\.dismiss)` inside a `sheet(item:)` destination clears `sheet`, the same path task editors use today. |
| Close and cancel | The editor's Cancel and save, and the new-attempt Cancel and submit, still call `dismiss()`. The dialog clears `clearingGoal` on cancel or outside tap. Its destructive action is the same `changeOK(store, "/goal/clear", [:])` call. `store` comes from `HermesWorkView`'s environment, the same `AppStore`. |
| Work lifetime | Goal sheets are page sheets over settings, as before. Work stays mounted, so `.onDisappear { control.disappear() }` behaves as it does for task sheets. |
| Concurrency | Closure properties follow `HermesTaskSection(create:open:)`. `HermesGoal` is an internal `Decodable` struct, and the enum needs no `Sendable` or `Equatable`. I expect no new Swift 6 diagnostics. The compiler run decides that. |

### Intentional semantic change, acceptable

`.goalEditor(HermesGoal?)` captures the goal at tap time. Before, the sheet closure passed the live `state.goal`, so `HermesGoalEditor.existingGoal` was recomputed on every render. The editor's `@State` title and budget already froze at first render, so only `existingGoal` differs. The visible case: a person opens Replace goal, taps the editor's own Refresh status, and the goal was cleared elsewhere in the meantime. Old code switches to "Standing goal" and saves without confirmation. The proposal keeps "Replace goal", the warning, and the confirmation. `replacing` is still `existingGoal || live goal`, so the proposal can only ask for confirmation more often, never less. The payload is identical. Mention it in the commit message, then move on.

### Presentation change to check at runtime, not a defect

The clear dialog's anchor moves from the Section's rows to the whole `Form`. A `confirmationDialog` presents as a popover on iPad, and it may on iOS 26 and later iPhone too. Its arrow and placement can therefore change from the Clear goal row to the form. This is not styling, but people will see it. Keep the move: the dialog shares the attachment point that failed, and the Form-root rule is the mistake-proofing here. SwiftUI has no anchor override for `confirmationDialog`, and attaching it to the button is still a lazy row. Judge placement in the iPad `goal-clear` canary frame under the repair label. Any adjustment belongs to W1 design work, not this repair.

### Optional

The comment at `:283-284` already says "the presenter and its state" generically, so it covers the goal presenters. Naming them, as review 56 suggested, is optional.

## Test review

### What is right

- **It can fail on old code.** A fresh `launch()` per cycle sets a new `AGENT_INTERFACE_UI_SCOPE` UUID and `UI_RESET`. `defer { app.terminate() }` runs at the end of each loop iteration. The route is profile, then settings, then Work, the same route as the canary.
- **No false pass on a flash.** `waitForExistence` can return during the 0.4 s window when the editor was up in r1. The inverted `XCTNSPredicateExpectation` on `exists == false` then returns `.invertedFulfillment` on teardown, and the guard fails. The r1 teardown was permanent, so even a polling interval near 1 s lands at least one evaluation inside the 2 s window.
- **The query is unambiguous.** Only the editor's bar is identified "Replace goal". Toolbar buttons are not navigation bars.
- **No destructive writes.** The test never taps the editor's Replace goal or the dialog's Clear goal. It only uses Cancel or an outside tap. The final `Resume goal` check proves the paused goal survived.
- **Failure ends the test.** `guard ... else { return }` stops at the first red, so a red at the editor step never reaches the Clear step.

### T1, required: ambiguous "Ranch hand" navigation bar in the fallback dismissal

`AutomationFlowTests.swift:100`: `app.navigationBars["Ranch hand"].coordinate(...)`. With settings open, two navigation bars carry that identifier. The chat bar is at y=62 and the settings bar at y=78, because settings uses `navigationTitle(savedName)` (`BotSettingsView.swift:212`). Both settings-open hierarchies, `1A2B36FA` lines 9 and 58 and `EE0AD81B` lines 12 and 61, show both bars. Resolving the element for a coordinate tap fails with multiple matches.

When this branch runs:

- **iPad, always.** A popover dialog has no Cancel button.
- **Phone, possibly.** If the iOS 27 action sheet omits Cancel, the phone runs this branch too. No passing evidence on this simulator shows a dialog Cancel either way.

Why it matters for the red run: suppose old code survives the editor step with the short fixture. The test then reaches Clear and goes red here. That red looks like a product failure and is not one.

There is a second hazard. If a popover anchored to the Form covered the header center, a blind tap could land inside the dialog, possibly on Clear goal.

Fix in the test file only, replacing line 100:

```swift
      else {
        let header = app.navigationBars.matching(identifier: "Ranch hand").firstMatch
        let outside = CGPoint(x: header.frame.midX, y: header.frame.midY)
        guard !app.sheets.firstMatch.frame.contains(outside) else {
          XCTFail("The outside tap would land on the Clear goal dialog, cycle \(cycle).\n\(app.debugDescription)"); return
        }
        header.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      }
```

Either matching bar is outside the dialog, and the guard turns an overlapping popover into a loud failure instead of a destructive tap. Existing tests already query confirmation dialogs as `app.sheets` (`NativeFlowTests.swift:297`, `VaultFlowTests.swift:41`).

### T2, recommended: wait for the editor to close after Cancel

After `editor.buttons["Cancel"].tapWhenReady()`, `form.waitForExistence` passes trivially, since the form stayed mounted under the editor. `reveal(clear, in: form)` can then see Clear goal as not hittable while the editor animates out, and swipe on the closing sheet. Add:

```swift
      XCTAssertTrue(editor.waitForDisappearance(timeout: 5), "Cancel closes only the goal editor, cycle \(cycle)")
```

This also asserts the close behavior directly. The existing `settingsMore == "Work"` check then proves that only the editor closed.

### Not raised

- No separate check that `settingsMore` exists during the 2 s window. Losing the editor is sufficient for red, and the post-Cancel checks cover settings for green.
- The new-attempt sheet is not exercised. The legacy fixture has no uncertain-resume option. The canary's `goal-uncertain` variant (`ScreenshotTourTests.swift:742-754`) covers it, and that is enough.

## Red-run interpretation (unchanged app, after T1 and T2)

Run once. One invocation already runs 3 fresh cycles, so "3 of 3" means the 3 cycles inside one run, not 3 runs.

| Outcome | Meaning | Next |
|---|---|---|
| Red at "Replace goal editor must remain over settings for two seconds" or "must open over settings" | Reproduced with the legacy fixture. | Apply the proposal, then do the green run. |
| Red at "Clear goal confirmation must remain…" | Reachable only if the editor survived. The dialog has the same defect, and the editor did not reproduce with the short title. | Apply the proposal. The canary remains the editor's red proof. |
| Red anywhere else | Test or harness fault, not this bug. | Inspect it. Do not apply on this evidence. |
| Green, all 3 cycles | The legacy layout does not discriminate. Do not call the fix proven by this test. | See below. |

**The concrete counterfactual for green on old code:** the legacy goal is "Inspect the north pasture", with no `pausedReason` and no resume receipt (`AutomationDebugFixtures.swift:6`). The design fixture has a 104-character title plus `pausedReason`. My estimate puts the legacy Replace goal center near y≈575, compared with r1's 779 in the same 214 to 862 band. If the teardown depends on the row's position as the settings card recedes, the legacy layout may not trigger it. The automation fixture cannot load the design fixture (`DebugFixtures.swift:25` precondition), so the long-title proof is the canary. In order:

1. Use the existing r1 `goal-replace` failure as the red. It already ran on unchanged code with the long fixture. One more unchanged-code canary run is optional corroboration, not required.
2. Apply the proposal, then run the canary `goal-replace` on phone. Green there is the discriminating proof.
3. The canary does not pass on a flash. After `waitForExistence` it taps the editor's own Replace goal button (`ScreenshotTourTests.swift:728-731`), which fails if the editor was torn down.
4. Keep `testGoalPresentersStayOverSettings` as a guard, recorded as "did not reproduce on legacy layout".

Do not add delays, retries, or positioning tricks to force a red.

## Conditional application and green run

Apply the proposal unchanged once the red run has a verdict from the table above. Green criteria, in order:

1. `testGoalPresentersStayOverSettings`, one invocation, all 3 cycles pass on phone. Plus `testTaskCreationStaysBlockedUntilExplicitStart` once, so the shared root presenter still works.
2. Canary, phone: `goal-loaded`, `goal-loading`, `goal-replace`. Then iPad, the same variants, once.
3. The other moved presenters get their first runtime proof in the full W1 before set: `goal-set-form` (same `edit` closure), `goal-clear` (moved dialog, check iPad placement), and `goal-uncertain` new-attempt review. All three must pass before you call the repair complete, not only `goal-replace`.

Stop condition from review 56 stands: two red runs after the fix means the cause is elsewhere. Return to diagnosis with the new recording.

## Baseline provenance

I agree with the plan as stated. The r1 failure image is diagnostic and earns no baseline credit. The post-repair before set is labeled "before design, after functional repair `<sha>`, presenter move only, no style change". A clock-masked pixel compare of repaired `goal-loaded` and `goal-loading` against the r1 diagnostic frames checks only that rendering is unchanged. It does not credit r1. Add one note: `goal-clear` frames carry the repair label and may show a different dialog anchor than old code would have. No passing old-code clear frame exists to compare, so record that in the frame label rather than claiming equivalence.

## Queue impact

Unchanged. W1 visual design stays pending behind the repair and the before set. Tasks, Triggers, and Learning stay queued. Settled contracts 53, 54, and 55 and the passing web baseline 20 are not reopened. Web shot 21 is out of scope.
