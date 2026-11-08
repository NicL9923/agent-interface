# November 8 iPhone Find reproduction preparation

Base `298c02dfb0e4ca99b77f26be50f21ad43fa48700`, iOS source fingerprint
`sha256:2719a128466aa67832742ca01895d028ad87af0f97eda1a71d3f0b948b16770f`.
Prepared on NicolasLaptop, Fedora Linux. No Swift compiler or Xcode is installed.
No iOS compilation, test, simulator, mutation check or physical-device run took place.

Issue #178 remains open. This branch prepares its reproduction and does not
change production command routing or claim to fix the bug. The old non-strict
expected-failure wrapper hid missing Find and missing keyboard focus together.
The reproduction now fails normally, reports how many Cmd+1 attempts preceded
Find, and attaches the screen and accessibility hierarchy for either failure.
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
debugger. Then repeat 20 iterations without run-tests-until-failure to measure
the fixed behavior. The current reproduction has not been observed fail on Linux,
because Linux cannot execute XCTest. Do not merge this branch as a completed fix.
