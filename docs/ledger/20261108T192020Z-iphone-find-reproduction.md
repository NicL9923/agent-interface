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

### Continued diagnosis after the scheduled refresh

The scheduled follow-up refreshed both PRs and confirmed PR 271 is already merged
at `3150bca03708cb0eab4ea9a501f329eb984dd289`. Its completed native checks and
eligible Grok 4.7 high review were reused. PR 273 remains draft at published head
`7a9881dff715d248357e70ed3c3fd20b5b30e22f`.

SSH file access recovered. Reading the lock script and running Git in the Mac
repository both succeeded. Xcode remains 27.2, build 27B52, and the mounted DevSSD
UUID is `A6506932-2021-45AD-8C2E-91FCFD595A87`. T3 reports the linked Mac environment
unreachable; device discovery exposes only the Linux host and no iOS device.
No direct device interaction or manual app testing is claimed.

Current main `af601cea7bd88fdd17261e044305596d5af5424f` was merged normally into
the task branch as `15fa1a23c55d2a59537a923e8cf4a6573c72cfbf`. The existing
uncommitted diagnostics were saved, reapplied and transferred to the isolated
Mac checkout. The first bundle lacked the Mac's missing published prerequisite;
a corrected bundle transferred the full required history. A queued invocation
was canceled before it acquired the lock or created a simulator. No test result
comes from that invocation.

Two previously requested Opus 5.5 pressure-tests arrived during this continuation.
Their effort was unconfirmed, so neither satisfies the final review gate. They
identify untested keyboard-attachment state, a possible Settings key conflict,
and a possible stale SwiftUI command menu after bootstrap. These are hypotheses,
not established causes. A newly started overlapping pressure-test was canceled.
Implementation and orchestration remain GPT-6.1 Sol high.

The next diagnostic matrix retains the independent UIKit control and adds
focused Cmd+K, unfocused tapped-chat Cmd+F, an always-enabled SwiftUI Cmd+8 item,
and a launch that omits the Settings shortcut. It also selects the existing
ShellFlowTests Cmd+K flow. Traces record hardware-keyboard detection through
GCKeyboard, complete composer key codes and phases, responder commands, Find
validation queries and AssistantCommands body evaluations. These temporary
probes can affect command evaluation and must be removed before accepting any
production red-to-green evidence.

The parent and Mac match at diagnostic iOS fingerprint
`sha256:631a0b8945d2d5988b1547ea047c13d94579a2dd58113d07f9fba9607d358a13`.
The exact patch is retained in the parent audit as `native-273/diagnostics-v8.patch`.
The locked command is `~/.agents/tools/mac-heavy-lock.sh bash
/Volumes/DevSSD/scratch/agent-interface-followup-20261108/run-273-matrix-v8.sh`.
Its log is `273-matrix-v8.log` in that directory. This invocation is queued;
compilation and test results are not yet available. Its private runner preserves
signing, omits `shutdown all`, and creates and deletes only owned devices.

The first matrix build failed in the temporary logging code because a UIKit
key-command action is optional. The corrected trace source fingerprint is
`sha256:6d7b70a8d1306d384e88a053056ee0bb43a73c851aedc9c5a4335995b9817c6a`.
That signed build and all seven selected controls ran on both owned devices.
Each platform reported 2 passed, 5 failed and 0 skipped tests. Omitting the
Settings menu button made the single Cmd+K control pass, and the independent
UIKit Cmd+7 control also passed. Focused Cmd+K, focused Cmd+F after plain-key
entry, always-enabled SwiftUI Cmd+8, tapped-chat unfocused Cmd+F, and the full
ShellFlowTests Cmd+K flow failed with the ordinary menu. The always-enabled item
also failing, together with menu evaluations after bootstrap, rules against a
stale `.disabled` value as the explanation for this diagnostic result.

The phone was `12747AC6-82D6-43BE-9C59-5C17F7E28132`; the iPad was
`60FD2876-0751-4896-A2FB-90F6C640A45F`. Both used iOS 27.0, build 24A434, on
Xcode 27.2, build 27B52. Their bundles are respectively
`.private/ios-test-20261108T222353Z-11714.xcresult` and
`.private/ios-test-20261108T222748Z-26518.xcresult`. The parent audit retains
`native-273/273-matrix-v8-fixed.log`, both `273-matrix-v8-*-summary.txt` files
and both `273-key-trace-matrix-v8-*.log` files. Both owned devices were deleted.

GCKeyboard reported an attached keyboard during the failed focused-command
presses, although it reported none at initial fixture setup. Visible software
keyboard state alone therefore did not establish absent hardware-keyboard
attachment. AssistantCommands evaluated with bootstrap present before failed
Find dispatch, and the omitted-Settings launch logged `command quickSwitch`.
These results justify isolating Settings registration before adding a UIKit
responder integration. They do not yet prove why the framework rejects that menu.

All temporary diagnostic source, swizzling, logging and launch-variable controls
were removed from the candidate. The proposed production change moves the
existing Settings button and Cmd+, binding from the custom Assistants menu into
`CommandGroup(replacing: .appSettings)`. Apple documents that placement for app
settings and preferences at
https://developer.apple.com/documentation/swiftui/commandgroupplacement.
No command action, focus assignment or responder implementation changes.
The strengthened navigation precondition remains, with permanent focused-Find
and Settings/quick-switcher shortcut checks added.

The candidate iOS fingerprint is
`sha256:0d28d4d897259ac0a902c4e5d856c6097e874d980493694f4b87b6627de4175f`.
With the identical permanent tests and the original production menu, the
baseline fingerprint is
`sha256:0e2ce99064531630fca592409fb9ae7325b7c5b7849278491eed490f571a4f78`.
The Mac and parent candidate fingerprints match. A locked baseline-then-candidate
phone run is starting through `run-273-appsettings-check.sh`. Its exact source
copies, script and log live in the same Mac scratch directory and parent audit.
No candidate result, mutation result or final eligible review exists yet.

The clean baseline built and reported 0 passed, 4 failed and 0 skipped checks.
Find did not appear after one Cmd+F with the composer focused. Cmd+, from home
did not show Settings. The strengthened pin test did not navigate after three
Cmd+1 presses, and ShellFlowTests Cmd+K did not show its field after three presses.
The baseline bundle is `.private/ios-test-20261108T223413Z-37050.xcresult`.

The standard Settings-group candidate built on the same owned iPhone simulator
and reported 2 passed, 2 failed and 0 skipped checks. Focused Find preserved the
draft and passed, and the complete ShellFlowTests Cmd+K flow passed. Cmd+, from
home still did not show Settings. The strict pin flow now genuinely navigated to
Ranch hand in one Cmd+1 attempt, but its single Cmd+F did not show Find. This is
an unmasked reproduction after verified shortcut navigation. Its bundle is
`.private/ios-test-20261108T223717Z-39595.xcresult`. These runs used owned iPhone
`4F9C0F59-0FFC-41CB-B069-2F5133A0E314`. Both were iOS 27.0 with Xcode 27.2 and signed builds.
The script deleted its owned device, restored the candidate file and stopped
before broader validation. The parent audit retains `273-appsettings-check.log`
and both `273-appsettings-*-summary.txt` files under `native-273`.

The candidate is not accepted. Moving Settings restores some command delivery
but does not resolve issue 178. A separate control retains the Settings menu
button and removes only its Cmd+, binding. It runs focused Find, the strict pin
sequence and the full Cmd+K flow, without diagnostics or forced focus. This
separates a reserved-key binding problem from the remaining navigation failure.
The strict test now also attaches its actual Cmd+1 attempt count and an after
screenshot on success. Those additions do not change its assertions. They are
not part of the preceding baseline or candidate results. The next script is
`run-273-no-comma-control.sh`; its log is `273-no-comma-control.log` in the same
Mac scratch directory. PR 273 remains draft and issue 178 stays open.

Removing only the Settings Cmd+, binding built and ran at iOS fingerprint
`sha256:0661d943c5770baeb328490d77edb1492a3608c6df741ced2535a2cb5ec2fec1`.
Focused Find and the full ShellFlowTests Cmd+K flow passed. The strict pin flow
still failed to show Find after actual Cmd+1 navigation. XCTest reported
2 passed, 1 failed and 0 skipped tests. This control therefore does not fix issue
178 either. Its summary and complete log are retained in the parent audit as
`native-273/273-no-comma-summary.txt` and `native-273/273-no-comma-control.log`.
Its exact owned simulator and result bundle are recorded in that summary.

The next temporary trace keeps the no-comma control and logs only command
callbacks, Find-handler delivery, chat visibility updates and passive key-window,
first-responder and GCKeyboard snapshots. It does not swizzle methods, enumerate
responder commands, move focus or add key bindings. Its iOS fingerprint is
`sha256:040e977e88243a67bd138c719a32417d3aa8e60f10e00d49ae5538e81c8a0d3e`.
The parent retains `native-273/navigation-delivery-trace.patch`. The Mac command
is `~/.agents/tools/mac-heavy-lock.sh bash
/Volumes/DevSSD/scratch/agent-interface-followup-20261108/run-273-navigation-delivery.sh`.
Its log is `273-navigation-delivery.log`. The selected tests are the permanent
focused-Find control and the strict pin sequence. The test remains limited to
one Cmd+F. The trace is pending; no production fix is accepted, and no final
review or merge gate has passed. The completion schedule stays enabled.

The initial passive-trace build failed because the diagnostic logger passed its
non-escaping autoclosure through os.Logger's escaping interpolation. Evaluating
that string before logging fixed the diagnostic code. The corrected iOS
fingerprint is
`sha256:9d3663225416801ef6333ed968ef0d698860a812bf3c8c2723fa28b546ca0d0e`.
Both the parent and Mac reported that exact fingerprint before the run.

The corrected signed run passed both selected tests, with 0 failures and 0 skips,
on owned iPhone `F510CB58-B658-4C36-B141-881AD2BA530C`. The bundle is
`.private/ios-test-20261108T225047Z-49529.xcresult`. The parent audit retains
`native-273/273-navigation-delivery-summary.txt`,
`native-273/273-navigation-delivery-fixed.log` and
`native-273/273-key-trace-navigation-delivery.log`.

In the successful strict sequence, `command pinned(0)` ran at 16:52:58.060 Mac
local time with Kitchen selected and no viewed chat. Ranch's visibility update
and Find-handler appearance followed at 16:52:58.104 and 16:52:58.105.
`command find` ran at 16:52:59.861 with Ranch selected and viewed. Its snapshot
reported an active key window, hardware-keyboard detection and no first responder
in the view tree. The handler and `openFind` then ran at 16:52:59.865.
This proves that this path can work without composer focus. It does not establish
a fix: both the temporary trace and timing differ from earlier failed runs.
There were no input-watcher press lines even in this successful run, so the
absence of those lines cannot establish that a key failed to reach the app.

Claude Opus 5.5 returned a read-only design pressure-test with unconfirmed effort.
It identified potential visibility or observer races if the command callback
runs, and proposed separate focused/unfocused navigation controls if it does not.
Its no-input-watcher inference is not accepted, because the successful control
above provides a counterexample. It approved no production fix. The requested
model and tool options were Opus 5.5 with high effort, but this feedback does not
count toward the final eligible review gate.

The unchanged corrected trace is now selected for 20 strict iterations with
relaunch, stopping on the first failure. The private runner starts 10 owned CPU
load workers after the build and kills them at cleanup. The locked script is
`run-273-navigation-loaded.sh`; output is `273-navigation-loaded.log` in the same
Mac scratch directory. No production or test assertion changed for this run.
PR 273 stays draft and the completion schedule remains enabled.

The loaded trace ran two iterations before stopping at a failure. The first
iteration delivered Find and passed. On the second launch, Cmd+1 genuinely
opened Ranch in one attempt, its ReadingChat and Find-handler appearance logs
reported Ranch viewed with an active key window and hardware keyboard detected,
and the single Cmd+F never reached AppStore.command. There was no `command find`
line for failing app PID 68965. This localizes the failure before the app's Find
handler and rejects a stale viewed-chat guard as the cause of that occurrence.
The absence of input-watcher lines still distinguishes nothing, because both
passing and failing iterations lack them.

This used the unchanged trace fingerprint above, signed Xcode 27.2, owned iPhone
`07908C9F-6A38-4646-AF6D-94D97AFCC883` and iOS 27.0. It waited 354 seconds for the
shared lock before execution. The result bundle is
`.private/ios-test-20261108T230103Z-68015.xcresult`. The overall test summary marks
the repeated test failed, while its device configuration counts 1 passed and
1 failed iteration, with no skips. The 20-iteration cap was not reached.
The parent audit retains `native-273/273-navigation-loaded-summary.txt`,
`native-273/273-navigation-loaded.log` and
`native-273/273-key-trace-navigation-loaded.log`. All 10 owned load workers were
stopped, and the owned simulator was deleted.

A new candidate removes the automatic UIKit Find menu group through
`UIMainMenuSystem.Configuration.findingPreference = .removed` at app launch,
on iOS 26 and later, with a nil build handler. SwiftUI retains menu construction.
This is a hypothesis about competing command registration, not an established
framework cause. It uses the separate Find-group configuration API verified in
Apple's current documentation and the Xcode 27.2 SDK interface. It does not
repeat the earlier textEditing-group replacement or add another Find shortcut.
No focus changes or diagnostic source remain.

The candidate retains the Settings button but removes its Cmd+, binding, which
already prevented the other menu controls from working. The newly written
Cmd+, control is replaced with a check that Settings remains reachable through
Cmd+K followed by its Settings result, and through the home menu. That deliberate
binding removal is not an assertion relaxation in the strict Find regression;
Find still gets exactly one press after actual pinned navigation. The candidate
iOS fingerprint is
`sha256:53845e5c427de0e194652cf2cd9efa713e04011975bb006ff47ba0f4d5502530`,
verified on both parent and Mac. Five targeted native UI checks are starting on
an owned phone through `run-273-native-selection.sh find-config phone 0`, with
the three ParityFlowTests shortcut cases, ShellFlowTests Cmd+K and NativeFlowTests
Cmd+period. The script preserves signing and the global lock, and never shuts
down a device it did not create. Broader validation waits for these results.

The system-Find configuration candidate built but failed both focused Find and
the strict post-pin Find sequence. Cmd+period, Settings via Cmd+K/home, and the
full Cmd+K flow passed. XCTest reported 3 passed, 2 failed and no skips in
`.private/ios-test-20261108T230610Z-70374.xcresult`. The retained artifacts are
`native-273/273-find-config-phone-summary.txt` and
`native-273/273-find-config-phone.log`. The configuration change is rejected and
removed from the working candidate.

A DEBUG-only UIKit global-menu Cmd+7 control then built but failed to open the
quick switcher from home. Its fingerprint is
`sha256:8df9d323953ea6964e3a4af1bff85f4ce0f30de478d269cadf48ecf938556190`.
The native trace reported `proxyResponds=true target=SwiftUI.AppDelegate` for
its distinct action selector, so the delegate target exists. The menu
registration still did not dispatch that control. This does not establish
whether its build handler ran or whether the phone consults that menu for the
injected key. The parent retains the three `273-global-menu-control-phone`
artifacts and its key trace in `native-273`. No production implementation was
accepted from this control.

The same control is now registered through public `addKeyCommand` on the existing
root view controller, after fixture configuration. It does not replace the
controller, change focus or change the test's single key press. This separates
action-target reachability from key registration at that controller. Its source
fingerprint is
`sha256:1610eded7cb850bcd08ba2b4eebb8ffdd165eb78363bac3a8854609436293b61`,
verified on parent and Mac. The locked command uses
`run-273-native-selection.sh root-key-command-control phone 0` with only
`ParityFlowTests/testGlobalUIKitMenuCommandControl`. The log is
`273-root-key-command-control-phone.log`. Temporary controls will be removed
before any production validation or final independent review.

The direct root-controller Cmd+7 control passed its single test with no skips.
Its retained summary and log are `273-root-key-command-control-phone-*` in the
parent audit. The trace confirmed that the existing UIHostingController reported
the added key command. No editor focus or controller replacement was required.

A production candidate then replaced the SwiftUI shortcut declarations with
owned UIKit key commands and retained all existing store handlers. It added
native tests for command registration, unchanged-command stability, controller
changes, pin order and rename, sign-out removal, each action's event and startup,
missing-index and stale-index rejection. On fingerprint
`sha256:cc22e4bfdaf012aedfb9b13766b5ee2d4273b286effb8c68e1ce6648b2bc5dbf`,
all 23 AssistantSurfaceTests and three non-Find UI checks passed; both Find checks
failed. The parent retains `273-root-registration-phone-summary.txt` and its log.
This was not accepted as a working fix.

Giving only Find UIKit's priority-over-system-behavior flag still failed Find
and Cmd+, in the six selected UI checks. Stop, Settings via the quick switcher
and home menu, and Cmd+K passed. Its fingerprint is
`sha256:173bd8dd880f38a148f194224be69bd6555960b6f960e9e15386ee3e9cd6c43e`.
The parent retains `273-find-priority-phone-summary.txt` and its log.
A temporary registration trace at
`sha256:c099cb7d2437392d6411c45deb3af37fda4006bf9c58fb45173e0f52950fa9e3`
reported the app's Find descriptor registered with priority true, a key window,
SwiftUI.AppDelegate as target and canPerformAction true. Focused Find and Cmd+K
passed in that traced run, but post-pin Find still did not reach the delegate.
The parent retains `273-root-registration-trace-phone-summary.txt` and the key
trace. These observations reject an unavailable delegate or signed-out gate as
the reason for that failure.

The next candidate registers with the navigation content's nearest existing
view controller instead of the outer app root. The installer moves and clears
only its owned commands through normal UIView lifecycle callbacks. Home, all
phone navigation destinations, both iPad columns and the quick switcher use the
same registration. It changes no focus or controller hierarchy. Five focused
UI checks are starting at fingerprint
`sha256:287614ba362c3bcd27623cd1fbdbefe4e5470354a2e6de3d074e86e61f7bb89b`.
The exact command is `run-273-native-selection.sh controller-registration phone 0`
with focused Find, the strict pin flow, Cmd+, from home/quick switcher, Cmd+K and
Cmd+period. Its log is `273-controller-registration-phone.log`. Diagnostics remain
temporary and no final native pass or eligible review is claimed yet.

Registering on each navigation content's closest controller also failed focused
Find, post-pin Find and Cmd+, while Cmd+period and Cmd+K passed. Its selected
five-test run is retained as `native-273/273-controller-registration-phone-summary.txt`
and its controller registration trace. This implementation is still unaccepted.
A temporary alternative-key control now uses the same Find selector on Cmd+G,
without focusing the composer, to distinguish the Find handler from the reserved
key's routing. Its fingerprint is
`sha256:d8f8767655add5f6990007ff77f69493bfe70083632f2e70f0fa72751ed267b7`.
The locked command selects only `ParityFlowTests/testAlternativeFindKeyControl`
through `run-273-native-selection.sh alternative-find-control phone 0`.
An independent review was explicitly requested from verified Grok 4.7 with high
reasoning effort before further production changes. The reviewer is reviewing
this failing integration and is not asked to approve a merge. The original
strict regression still sends one Cmd+F and remains failing. The schedule stays
enabled, and issue 178 remains open.

The alternative-key control passed its one native test with no skips. Cmd+G
reached `assistantFind`, which logged a bound store, present bootstrap and Ranch
viewed, and opened the ordinary Find UI without composer focus. The parent audit
retains `273-alternative-find-control-phone-summary.txt`, its full log and its key
trace. This establishes that the same delegate handler and presentation path
work under another shortcut; Cmd+F matching or routing remains the unresolved
boundary. The alternative descriptor also has a diagnostic title and does not
request Find's priority flag, so this is not claimed as a complete one-variable
proof of which system component consumes Cmd+F. No further production code has
been accepted. The requested Grok review is still the pending independent check.

Origin/main advanced to `f218e65233cda4e9bb1c549cdaf5723045d5dd3d`, which changes
the validation runner and runbooks through PR 277, not application code. Its
runner removes shutdown all, verifies lock ancestry and reuses exact matching
passes. The existing private copies were already limited to owned devices;
these completed native comparisons remain tied to their exact recorded inputs.
The next validation phase will use the updated runbook after a normal target
merge, without rewriting published history or repeating unrelated passing work.
