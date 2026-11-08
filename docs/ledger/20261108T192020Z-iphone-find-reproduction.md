# November 8 iPhone Find reproduction preparation

Based on `298c02dfb0e4ca99b77f26be50f21ad43fa48700`. The prepared branch's iOS fingerprint is
`sha256:cc0a19d36367b21aa3499105310f77017d55f575d38a0c3e1f09f33b87189053`.
Prepared on NicolasLaptop, Fedora Linux. No Swift compiler or Xcode is installed.
No iOS compilation, test, simulator, mutation check or physical-device run took place.

Issue #178 remains open. This branch prepares its reproduction and does not
change production command routing or claim to fix the bug. The old non-strict
expected-failure wrapper hid missing Find and missing keyboard focus together.
The reproduction now fails normally, reports how many Cmd+1 attempts preceded
Find, and attaches the screen and accessibility hierarchy for either failure.
Cmd+F gets one attempt after the chat is ready, so retrying cannot hide a lost press.
The other shortcut-helper callers retain their retries and ignore its new result.

Claude Opus 5.5 at high effort reviewed the diagnosis against the named base.
The Find menu action calls store.command directly, the composer passes modified
keys to UIKit, and no verified app-code defect explains the issue's report that
the command callback never runs. A separate Find-focus race is possible, but
would show the field without focus. The split assertions distinguish those cases.
The review's suggestion to intercept UIApplication.sendEvent was deferred to the
Mac investigation, where its behavior and responder state can be observed.

Before a production fix, use the Mac Mini to compile this branch and run the
focused reproduction on an owned iPhone simulator. Verify DevSSD is mounted and
follow the machine-fleet storage instructions before creating bulk paths. With
the checkout and derived data on DevSSD, run the existing locked test runner:

```sh
bash .agents/tools/validate-ios.sh "$SIMULATOR_UUID" test \
  -only-testing:AgentInterfaceUITests/ParityFlowTests/testSwipingARowPinsItAndCommandShortcutsOpenAndFind \
  -test-iterations 20 -run-tests-until-failure \
  -test-repetition-relaunch-enabled YES \
  -collect-test-diagnostics on-failure
```

Set IOS_DERIVED_DATA to a task directory on DevSSD before the run. The runner
already acquires mac-heavy-lock. Record the exact head, simulator, Xcode version,
test results and failure attachments here. On a failing run, inspect key delivery,
the key window, the first responder and command callback execution in the app
debugger. Repeat 20 iterations without run-tests-until-failure to measure how
often the current code fails. After a future production fix, repeat that run
and record the red-to-green comparison. The current reproduction has not been observed fail on Linux,
because Linux cannot execute XCTest. Do not merge this branch as a completed fix.

The diagnostics flag requests the simulator diagnostic bundle. The runner notes
that collecting it after a failure can take 10 minutes on the Mac Mini. The
test's own screenshot and hierarchy attachments are separate from that bundle.

Claude Opus 5.5 at high effort reviewed the draft and found that retrying Cmd+F
could hide the lost press. That finding is addressed by allowing one attempt.
The review's fingerprint and repetition wording notes are also addressed. The
remaining code and existing helper callers had no findings. Xcode compilation,
an observed failing reproduction and command-delivery diagnosis remain blocked.

## Mac follow-up after PR 271 merged

PR 271 merged as `3150bca03708cb0eab4ea9a501f329eb984dd289` after native
validation, eligible Grok 4.7 high review and final CI. The published reproduction
branch was merged with that main commit normally in task commit
`6b4b82d28ddf1922261a10dce9b248e0754d8c74`. Its uninstrumented iOS fingerprint is
`sha256:97ba31ced12fa4ae6ac3731c82ef9d2d5dd4b62c69999636e3662428b7a5be4d`.

The isolated Mac checkout is
`/Volumes/DevSSD/dev/agent-interface-worktrees/followup-273-20261108`.
SSH file reads and the expected DevSSD UUID worked before creating it.
Source transfer used a Git bundle, and the Mac's commit and iOS fingerprint
matched the parent. Xcode is 27.2, build 27B52. Derived data and task scripts stay
under `/Volumes/DevSSD/scratch/agent-interface-followup-20261108`.

The first baseline is queued in `~/.agents/tools/mac-heavy-lock.sh`. Its private
runner copy preserves simulator signing and the patched test plan. It omits
`shutdown all` and operates only on a simulator created and deleted by this task.
After the build, it starts 10 `/usr/bin/yes` processes with output discarded.
An EXIT trap kills only those child processes and shuts down the owned simulator.
This provides a recorded load on the Mac's 12 logical CPUs. The command selects
the strict parity test with `-test-iterations 20 -run-tests-until-failure` and
`-test-repetition-relaunch-enabled YES`. Simulator diagnostic collection stays
disabled to avoid the runbook's known collector stall. XCTest's own failure
hierarchy and screenshot attachments remain enabled.

The baseline log is
`/Volumes/DevSSD/scratch/agent-interface-followup-20261108/273-baseline.log`.
No baseline result is available at this checkpoint. There is no production fix.
A separate local diagnostic patch prepares launch-variable-gated logging of
UIApplication press delivery, the key window and first responder, the command
callback, Find dispatch and focus assignment. It does not register a key command
or request focus. That patch has not been compiled or applied to the Mac baseline.
Its source fingerprint is
`sha256:b58afc56ecefd0a11dbfd568b318c84b210b05c5fc6b47f8bc34ccd57219416c`.
It is retained locally as `native-273/diagnostic-trace.patch` in the parent audit.

A read-only Claude Opus 5.5 pressure-test recommended testing against current main,
recording CPU load and logging without stopping the app in a debugger. It could
not confirm the requested high effort. This advice is not an independent approval
of a production fix and does not satisfy the final review gate.

At 21:22 UTC the baseline reproduced the missing Find field on its first
iteration. The signed build-for-testing succeeded. XCTest reported 1 failed test,
0 passed and 0 skipped, and xcodebuild exited 65. Cmd+1 took 1 attempt; one Cmd+F
then failed to show `findConversation`. The attached hierarchy and screenshot
show the chat open without Find or a stray `f` in its composer. The screenshot
was visually inspected. The test did not reach the separate keyboard-focus
assertion, so this establishes a missing field rather than a focus-only failure.

The owned iPhone 18 Pro simulator was
`16044CAB-49EE-4160-9D66-5AEEEC409614`, iOS 27.0, build 24A434. The run waited
about 9 minutes for the global lock before creating the device. Its bundle is
`.private/ios-test-20261108T212034Z-49879.xcresult` in the Mac checkout. The
parent audit retains `native-273/baseline.log`, `native-273/baseline-summary.txt`
and all 16 exported attachments under `native-273/273-baseline-all-attachments`.
The failure screenshot is `666D8073-23A1-437B-B695-7094963AF857.png` there.
The runner killed its 10 CPU load workers and the outer wrapper deleted its
owned simulator. No existing device was shut down by this task.

The temporary trace patch was then applied to the Mac checkout. Its iOS
fingerprint matched the parent's prepared fingerprint above. The separate
trace-enabled run uses the same repetition options and CPU load. It collects
its unified-log subsystem before the private runner shuts down the owned
simulator. That run is queued at this checkpoint; its probes and compilation
are not yet verified. No production command-routing fix has been applied.

### Correction to the Cmd+1 interpretation

The trace-enabled run compiled, then failed with the same missing Find field on
its first iteration. It used owned simulator
`EF27B634-444C-4C17-BCA0-3035588FA527` and wrote
`.private/ios-test-20261108T213459Z-58711.xcresult`. Its iOS fingerprint was
`sha256:b58afc56ecefd0a11dbfd568b318c84b210b05c5fc6b47f8bc34ccd57219416c`.
The trace logged installation in app PID 60201 but none of the later command
probes, including Cmd+1. The probes therefore do not yet establish where a key
was lost. The parent retains `native-273/trace.log`, `trace-summary.txt`,
`key-trace-1.log` and the exported XCTest diagnostics. The API reported no
separate console log. The app's standard-output diagnostic also contained only
the initial trace-install message from this subsystem.

Reviewing the baseline recording exposed a false positive in the existing Cmd+1
helper call. The Ranch hand chat was already open at 12 seconds, before XCTest
sent Cmd+1 at 13.27 seconds. The helper checked an already-present composer and
reported 1 attempt. That result does not prove Cmd+1 navigated. The earlier PR
wording saying that Cmd+1 opened the chat is withdrawn and has been corrected.
The missing Find field after one Cmd+F remains observed, but this is not yet a
verified reproduction after a successful Cmd+1 navigation.

The recording is `105CBB2D-82C1-4D48-8E8C-8593326BDAC8.mp4` in the baseline
attachments. The parent audit also retains `native-273/baseline-command-transition.png`,
a labeled comparison of frames at 12 and 14.5 seconds.

The next test returns home after pinning, verifies the pin's preview is absent,
visits Kitchen companion, then returns home again. It requires Ranch hand's
header to be absent before Cmd+1 and uses that header as the command's target.
This strengthens the navigation precondition on both iPhone and iPad. It keeps
Cmd+F strict and limited to one attempt. The diagnostic trace also adds a
fixture-ready control, known-touch controls, responder-chain details and a check
that its sendEvent hook remains installed. These changes are queued for native
validation, not yet verified. Their iOS fingerprint is
`sha256:62a6b6626e4bfdfcdbab7f3895480e100d9943170197c354df2a9e8e7d936cf7`.
No production fix has been chosen.

The strengthened trace run compiled, then failed on the first iteration at
Cmd+1 itself. Three presses did not reveal Ranch hand's header. The test had
successfully visited Kitchen companion and returned home, so its target was no
longer already present. It did not reach Cmd+F. The result is
`.private/ios-test-20261108T214328Z-76029.xcresult`, on owned iPhone simulator
`9B32056B-104C-4271-A5E2-A9CAB22CC153`. The parent retains
`native-273/trace-v2-summary.txt`, `trace-v2.log`, `key-trace-v2.log` and the
exported `273-trace-v2-diagnostics` directory. Both the runtime and device type
remain the iOS 27.0 iPhone 18 Pro used above.

The fixture-ready and touch controls logged successfully. They reported a key
window, no first responder found in the view tree, and an active sendEvent hook.
The recorded application chain was `SwiftUIApplication`, `AppDelegate`; those
unqualified type names do not establish whether the latter is SwiftUI's proxy.
There was no raw-key, input-watcher press or AppStore.command trace. This is
insufficient to blame production command routing: the test keyboard I/O boundary
still needs a positive control. The simulator and CPU workers were cleaned up.

The next diagnostic run adds a separate normally focused-editor control. It
uses typeText to enter `Keyboard control`, then requires an unmodified typeKey
`x` to append to that value before sending Cmd+F once. This does not focus the
editor in the strict unfocused regression. The run selects both tests on an
owned iPhone and then an owned iPad, sequentially under the same global lock.
The verified tablet type is `com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5-12GB`.
The source fingerprint is
`sha256:2142f97a93cdefe431b2bf0a361c84427fe6eecce8e9eab7a95c1054abaf847f`.
Those controls are queued and have no result yet.

### Keyboard delivery controls on November 8

The queued phone control completed at 21:50 UTC on owned iPhone 18 Pro
`FA9C3DE5-3AB9-4696-B288-1882631DF4F0`, iOS 27.0, build 24A434. The signed
build-for-testing succeeded at the v3 fingerprint above. The normally focused
composer accepted `Keyboard control` through `typeText`, but the subsequent
unmodified `typeKey("x", modifierFlags: [])` did not append `x`. It failed the
positive-control assertion before Cmd+F. The trace recorded fixture and touch
controls, with a key window and its hook active, but no hardware-key events.
This weakens the production-routing interpretation of the earlier failures.
It does not prove that a real iPhone hardware keyboard loses its keys.

The strict test in that run failed before any shortcut, while the existing home
helper queried a disappearing `openSettings` button during navigation. This is
separate from the previous run's Cmd+1 failure. The bundle is
`.private/ios-test-20261108T214844Z-82622.xcresult`. The parent audit retains
`native-273/273-control-phone-summary.txt` and
`native-273/273-key-trace-control-phone.log`.

The initial control wrapper then failed to create its iPad because the running
copy still used the invalid type `iPad-Pro-11-inch-M5`. No iPad test ran in that
attempt. The saved script now uses the discovered type
`com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5-12GB`. A separate
locked run selects only `ParityFlowTests/testHardwareKeyDeliveryControl` on an
owned iPad and keeps the original signed runner, trace gate and 10 CPU workers.
Its output is `273-pad-control.log` in the same Mac scratch directory.

Read-only SSH and actual checkout/tool reads worked again at 21:51 UTC. DevSSD
still had UUID `A6506932-2021-45AD-8C2E-91FCFD595A87`; Xcode remained 27.2,
build 27B52, with first-launch checks passing. The linked Mac T3 environment was
unreachable, and `device_list` exposed only Linux with no iOS platform. Direct
Device panel interaction remains unavailable. XCTest remains usable over SSH.

External API evidence checked on November 8: Apple's XCUIElement overview
specifically describes keyboard interactions for macOS and iPadOS 15 or later.
Its single-key method page does not explicitly resolve iPhone behavior. The
installed Xcode 27.2 `XCUIElement.h`, lines 112 through 129, declares the API for
TARGET_OS_IOS, which alone also does not establish iPhone delivery. Appium's own
[mobile keys documentation](https://appium.github.io/appium-xcuitest-driver/latest/reference/execute-methods/#mobile-keys)
explicitly says the API works only on iPad and has no effect on iOS phones. This
is consistent with the phone control; the tablet control is the next empirical
comparison. A production fallback is not justified by the current evidence.

Current `origin/main` advanced to
`323ed78ca1c4a9d75bfd905fa2e8f95ff7e32c5e` through PR 276. A normal local merge
preserves the published branch history. Diagnostic edits were saved, temporarily
stashed, and reapplied successfully. The Mac tablet control still tests the v3
fingerprint on the older main integration, so it is diagnosis evidence rather
than validation of the new main merge.

The corrected tablet control also failed to append the unmodified `x`, on owned
iPad Pro 11-inch M5 `5D65AD23-7962-4A64-92F3-D43A6C52A79F`, iOS 27.0,
build 24A434. XCTest reported 1 failed test, 0 passed and 0 skipped. The signed
build-for-testing passed. Its bundle is
`.private/ios-test-20261108T215304Z-87794.xcresult`, with source fingerprint
`sha256:2142f97a93cdefe431b2bf0a361c84427fe6eecce8e9eab7a95c1054abaf847f`.
The tablet trace also recorded fixture/touch controls with an active hook and
key window, and no hardware-key probes. Both device types therefore lack a
successful keyboard-I/O control in this environment. Appium's phone limitation
alone does not explain the tablet result. The optional unified-log read ran
slowly after the test; its normal EXIT trap ultimately stopped the 10 owned CPU
workers and removed the owned simulator. An attempted verified worker cleanup
found that the owning runner had already exited and signaled nothing.

The next control removes artificial CPU load and compares application-targeted
`typeKey` with editor-targeted `typeKey` in separate tests. Both still require
ordinary user-visible typing through `typeText` first. The failure message now
includes the actual editor value and hierarchy, so an unexpected character
cannot be confused with dropped input. It does not focus the editor in the
strict shortcut regression. The Mac checkout is at normal merge commit
`2858cf19af12d1e5155c9eb6a9f7d05dcb8ff649`, with verified iOS fingerprint
`sha256:ba8a8c1d582a55626fa14756993a81475c147794641f96415e70830adc9b9fd8`.
The wrapper `run-273-receiver-controls.sh` selects both focused controls, first
on an owned phone and then on an owned tablet, under the same global lock.
Its output is `273-receiver-controls.log` in the Mac scratch directory.

The related hardware-key test entry points are `UITestSupport.shortcut`, pinned
navigation/Find in ParityFlowTests, quick switching and composer draft-history
arrows in ShellFlowTests, Stop in NativeFlowTests, and select-all in the
ScreenshotTourTests capture path. The current failures cannot validate or
invalidate those production behaviors without successful test I/O. No shortcut
handler, command menu or focus behavior has been changed as a fix.

### Correction to the positive-control inference

The expanded failure message in the no-load phone run reports the actual editor
value as `Keyboard controlX` for both app-targeted and editor-targeted `typeKey`.
The unmodified key did arrive, in uppercase. The earlier controls expected
lowercase and did not print their actual value, so their assertion failures do
not establish missing unmodified-key delivery. The inference above that the
keyboard-I/O control lost its plain key is withdrawn. The raw-event trace still
did not log that insertion; absence from that trace alone cannot prove an input
was not delivered. The v4 failures are diagnostic-test failures, not product
regressions. They did not reach the subsequent Cmd+F assertion.

The control now uses the digit `7`, which avoids a letter-case assumption. A
separate control registers Cmd+7 directly on the already-focused UIKit editor
and requires its action to append ` [UIKit command]`. This temporary registration
is enabled only by that control's launch variable. The strict unfocused Find
regression and normal app launches do not get the command. The experiment asks
whether a UIKit command callback is deliverable separately from SwiftUI's Find
menu. It is not a production fallback and does not register Find or change focus.
The trace also snapshots the responder after the editor begins editing, since
the prior touch snapshots happened before the tap assigned its first responder.
The prepared v6 iOS fingerprint is
`sha256:ead4f2f6b4c8a7394fb4cbf0b994283378f2bf2fb171107fabf7c6f58fabcd68`.

The no-load v4 receiver comparison completed with 2 failed tests on each device
and no passed or skipped tests. Both application-targeted and editor-targeted
calls appended uppercase `X` on both phone and tablet. The owned devices were
iPhone `3501027B-A683-4215-9B3E-FE81B0BEE19B` and iPad
`4266BA79-26E9-4013-BB10-2DCDAC8401E3`, both iOS 27.0, build 24A434. Their
bundles are `.private/ios-test-20261108T215641Z-91916.xcresult` and
`.private/ios-test-20261108T215928Z-93445.xcresult`. The parent audit retains
`native-273/273-receiver-phone-summary.txt` and
`native-273/273-receiver-pad-summary.txt`, including each actual value.

The v6 corrected controls are now running sequentially on owned phone and tablet,
without artificial CPU workers, from the same normal main merge. The selected
tests are `ParityFlowTests/testHardwareKeyDeliveryControl` and
`ParityFlowTests/testUIKitCommandDeliveryControl`. The first requires an
unmodified `7`, then sends Cmd+F once. The second independently requires the
UIKit Cmd+7 callback. Output is `273-command-controls.log` in the Mac scratch
directory. Optional unified-log collection is now limited to 30 seconds and the
last 10 minutes; XCTest results and its own diagnostic attachments remain the
primary evidence. The earlier Grok diagnosis review was canceled because its
missing-plain-key premise was superseded. It provides no current approval.

The corrected phone controls completed at 22:05 UTC on owned iPhone 18 Pro
`130B3CC1-D7E9-4174-89C7-E437092828D8`, iOS 27.0, build 24A434. The signed
build-for-testing passed at v6 fingerprint
`sha256:ead4f2f6b4c8a7394fb4cbf0b994283378f2bf2fb171107fabf7c6f58fabcd68`.
The unmodified `7` assertion passed, then a single Cmd+F failed to show Find.
The separate `testUIKitCommandDeliveryControl` passed. XCTest reported 1 passed,
1 failed and 0 skipped tests. The failure hierarchy shows the focused composer
still containing `Keyboard control7`, with no stray `f` and no Find field.

The native trace confirms `AgentInterface.ComposerUITextView` as first responder
after editing began. Cmd+7 reached `pressesBegan` with `key=7` and modifier flags
`1048576`, UIKit's Command flag. The independent control action then logged
`UIKit command control, firstResponder=true`. In the Find control, the composer
logged the modifier press, but no AppStore command or Find dispatch ran.
This establishes a functioning modified-command callback in the phone simulator;
it rules out treating all modified-key injection as unavailable. It does not yet
identify why Find's SwiftUI command is missing, nor demonstrate a production fix.

The bundle is `.private/ios-test-20261108T220349Z-95772.xcresult`. The parent audit
retains `native-273/273-command-phone-summary.txt` and
`native-273/273-key-trace-command-phone.log`. The same two controls are running on
an owned iPad next. No production shortcut fallback is installed. A separate
local test-only change avoids querying a disappearing home menu's frame on
phone navigation, using the explicit BackButton instead. That change is not in
the v6 native run and remains unvalidated.

The v6 tablet controls finished with the same outcome: 1 passed, 1 failed and
0 skipped tests. UIKit Cmd+7 executed, while the separate single Cmd+F control
did not show Find after ordinary text entry and successful digit insertion.
The owned iPad was `12F40C1E-0936-4270-8444-2AFA70D3A15F` on iOS 27.0,
build 24A434. Its signed build-for-testing passed. The bundle is
`.private/ios-test-20261108T220610Z-99145.xcresult`. Its summary, trace and the
complete command-control log are retained in the parent audit as
`native-273/273-command-pad-summary.txt`,
`native-273/273-key-trace-command-pad.log` and
`native-273/273-command-controls.log`. Both owned devices were deleted normally.
No native process from these control runs remains active.

These controls justify investigating the app's SwiftUI command registration
rather than treating modified-key delivery as unavailable. They do not approve
any fallback design. The next step is a read-only Claude Opus 5.5 high-effort
pressure-test of a stable UIKit responder integration that leaves keyboard focus
alone, including normal typing, system shortcuts and iPad command-menu behavior.
The production implementation and orchestration remain GPT-6.1 Sol high.
PR 273 stays draft; issue 178 stays open. No final review, production fix,
red-to-green regression or production mutation result exists yet.
