# Two failing ShellFlowTests: one app bug, one stale test

Branch `t3/ios-shellflow-tests`, based on `origin/main` at `41bfa499`. Mac mini, Xcode 27.2, iPhone 18 Pro simulator on iOS 27.0,
through `.agents/tools/validate-ios.sh`. Simulator runs, not device runs.

## `testCommandKOpensTheQuickSwitcher...`: the app was wrong

Red on base (`t4-base-1`): "The k shortcut never showed quickSwitcherField after 3 tries"; the final hierarchy was home, no sheet. It
also failed on an iPad Pro 11-inch (iOS 27.0) and an iPhone Duo (iOS 27.1), so it is not the phone idiom or one runtime, and
the test at `a6b8c8f1` (October 25) passed on the same Xcode 27.2, so it is not the toolchain either. `git bisect` over the 75 iOS
commits between `a6b8c8f1` and `5a1ab77b` (each built and run on the Mac mini) named `60881595` (October 30), which added
`Button("Settings") ... .keyboardShortcut(",", modifiers: .command)` to `AssistantCommands`. With that one item removed the test and
`NativeFlowTests.testCommandPeriodAsksBeforeStoppingActiveWork` (also red on base, same message) pass. Moving the item last did
not help, removing `.disabled(store.bootstrap == nil)` from Cmd+K did not help, and `CommandGroup(replacing: .appSettings)` stopped
poisoning the menu but Cmd+, still never fired. So Cmd+, never worked and its item silently disabled every shortcut after it:
Cmd+K, Cmd+F and Cmd+. on a hardware keyboard. The fix removes the Cmd+, command (`KeyboardCommands.swift`, the dead `.settings`
case in `RootView.swift`) and leaves a comment saying why. Settings is still in the quick switcher.

## `testGroupChatNames...UpdatesLive`: the test was stale

Red on base (`t4-base-1`): line 141, "Your message names you". The failure hierarchy shows the sent message labelled "You" and the other member by
name. `GroupConversationView.author` has returned "You" for the viewer's own group messages since `c3a57ea3` (October 30, "Make group
threads and assistant requests clear"), which the unit tests also pin (`GroupRows.preview` with author "You"). The test now expects
"You", the message text, and no "Local test member" on the own message. The app is unchanged for this one.

## Runs

- Base (`41bfa499`) red: both tests failed as above.
- Final: `-only-testing:AgentInterfaceTests -only-testing:AgentInterfaceUITests/ShellFlowTests -only-testing:AgentInterfaceUITests/NativeFlowTests/testCommandPeriodAsksBeforeStoppingActiveWork`
  passed: 748 unit tests (2 skipped, evidence-directory ones), 13 `ShellFlowTests`, 1 `testCommandPeriod...`, 0 failures.
- Repeat: the two target tests and Command-Period with `-test-iterations 3`: 9 runs, 0 failures. Input fingerprint `f4eb217b4f63`.
