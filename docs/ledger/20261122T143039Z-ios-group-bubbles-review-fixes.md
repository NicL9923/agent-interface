# November 22 iOS group bubbles: review fixes

Branch `t3/followups-ios-2`, after merging `origin/t3/followups-459-462` at `b5715913` as `92a5fb3e`, with no conflicts. Xcode 27.2
(27B52), iOS 27.0 simulators made for this task: iPhone 18 Pro Max, iPad Pro 11-inch (M5) and iPhone SE (3rd generation). These are simulator runs,
not device runs. Each run was its own scoped request through `validate-ios.sh`. Logs, captures and result bundles are in
`/Volumes/DevSSD/scratch/followups-ios-3/`. `ios/AgentInterface/AppStore+Polling.swift` and
`ios/AgentInterface.xcodeproj/project.pbxproj` compiled as merged and were not changed.

## Red runs

One build, `red.log`, had all four fixes undone.

| Finding           | Undone                                                    | Result                                                                 |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| Tinted quote bar  | `quoteBar(on: .tint)` back to `Palette.line`              | Red: 1.16:1 in light, 1.25:1 in dark                                   |
| Dock card         | `DockCard` removed from the refused and interrupted lines | Red: 1.86:1 in light, 1.87:1 in dark, over the test's backdrop         |
| Today press style | `AttentionRowStyle` removed from the row                  | Red: the row drew the raised fill, not the pressed one, in both themes |
| Routine tag       | The tag always reads "Routine failed"                     | Red: `Morning brief, Routine failed, Sep 21, 09:15`                    |

## Results

| Scope                               | Device            | Run | Passed | Failed | Skipped | Log         |
| ----------------------------------- | ----------------- | --- | ------ | ------ | ------- | ----------- |
| `AgentInterfaceTests`               | iPhone 18 Pro Max | 936 | 933    | 1      | 2       | `green.log` |
| `ShellFlowTests`                    | iPhone 18 Pro Max | 20  | 16     | 0      | 4       | `green.log` |
| Group edge test and 4 capture tests | iPad Pro 11       | 5   | 5      | 0      | 0       | `ipad.log`  |
| Group edge test and 4 capture tests | iPhone SE         | 5   | 5      | 0      | 0       | `se.log`    |

The failure is `NativeContractTests.testAGrowthNoticeThatDoesNotContinueTheHeldReplyReloadsOnceAndReconnects`, a 10-second wait
that timed out. It was not run again, because the coordinating task asked for no more runs on merged code, so whether it is flaky,
baseline or new is not known. This round changes none of the code it names.
The 4 skips are capture tests, which run only with `AGENT_INTERFACE_SCREENSHOT_DIR`.

The bar was checked by eye on iPhone SE in light, dark and at Accessibility XXXL in light, and on iPad in light and dark. Not run:
`check-all`, any other UI class, VoiceOver and any device run. Today's press was drawn by a test, not by a finger.

The web's tinted bubble keeps the same faint stripe: `src/components/message-markdown.css` draws it in `--line`, and
`e2e/accessibility.spec.ts` returns before its stripe check for a tinted bubble. It is not changed here.
