# iOS no-sender review fixes

Branch `t3/ios-unknown-sender` after a Claude Opus 5.5 review of `1b2d12ed`. This work merged `origin/main` (`08c8f969`) and
`origin/t3/ios-receipt-turn` (`77b390dc`, #349) and then fixed two findings in commit `163fad62`. The one merge conflict, in
`ios/AgentInterfaceTests/NativeContractTests.swift`, kept both sides' tests. Swift written and run on the Mac mini (Xcode 27.2,
iPhone 18 Pro simulator, iOS 27.0) through `.agents/tools/validate-ios.sh`. Simulator runs, not device runs.

## What changed

1. `PromptRecall.ownMessages` (`ComposerInput.swift`) takes a no-sender row only when `!othersCanWrite || ownRows.contains(id)`, as the
   transcript label does and as the web's recall does by taking only `sender.id == userId`. `ComposerView.recallArrow` passes
   `bot.othersCanWrite` and `store.ownRows`. The parameters have no defaults, so a caller cannot forget them.
2. `SentEcho.nextSends` (`OwnSends.swift`) records a send on `receipt.admitted` (accepted and `turn != "none"`) instead of
   `status == "accepted"`, as the web's `nextSends` does.

## Red proof

Each protecting line was broken by hand alone, its test went red, and the file was restored with `git checkout`:

| Broken line | Result |
| --- | --- |
| `ownMessages` guard returns `true` for a no-sender row | `ShellFeatureTests` 2 failures (shared-chat test, lines 38 and 40); UI `testUpArrowRecallsANoSenderMessageOnlyInAPrivateChat` red |
| `!othersCanWrite` removed | `testRecallListsOnlyThisPersonsOwnMessagesNewestFirstWithoutRepeats` red (private chat stopped recalling) |
| `|| ownRows.contains(message.id)` removed | `testRecallInASharedChatSkipsANoSenderRowUnlessItIsThisPersonsOwnSend` red (own queued send not recalled) |
| `ComposerView` passes `othersCanWrite: false` | UI `testUpArrowRecallsANoSenderMessageOnlyInAPrivateChat` red at its shared-chat Down assertion |
| `receipt.admitted` back to `receipt.status == "accepted"` | `OwnSendsTests.testATypedStopPhraseThatAdmittedNothingLeavesNoRecordButEveryOtherTurnDoes` red |

## Final run

`bash .agents/tools/validate-ios.sh 39F5329D-FA70-4259-9B8A-6AECECDE2227 test -only-testing:AgentInterfaceTests -only-testing:AgentInterfaceUITests/ShellFlowTests/testUpArrowRecallsOwnMessagesNewestFirstAndDownRestoresTheEmptyDraft -only-testing:AgentInterfaceUITests/ShellFlowTests/testUpArrowRecallsANoSenderMessageOnlyInAPrivateChat -only-testing:AgentInterfaceUITests/ShellFlowTests/testANoSenderMessageIsLabeledInASharedChatAndNotInAPrivateOne`
passed: 780 tests, 778 passed, 2 skipped (`testRenderPropEvidence`, `testRenderEvidence`, which need an evidence directory), 0 failed.
Input fingerprint `79a6919039d3fa82440b706c139649c8413fd0f2ad0f63d3b89bfb7aa76c3193`, identical for the committed `163fad62` source.

## Not covered

The rest of the UI suite was not rerun; the branch touches only the recall, label and send-record paths above. No physical device.
