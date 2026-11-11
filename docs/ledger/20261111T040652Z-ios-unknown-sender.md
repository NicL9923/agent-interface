# iOS labels a no-sender row in a shared chat

Branch `t3/ios-unknown-sender`, based on `origin/main` at `41bfa499`. Swift written and run on the Mac mini
(Xcode 27.2, iPhone 18 Pro simulator, iOS 27.0) through `.agents/tools/validate-ios.sh`. Simulator runs, not device runs.

## What changed

`MessageView` drew a user row with no sender as the viewer's own. It now reads "Household member" when other members can
write in the chat (`Bot.othersCanWrite`: not a private assistant, which is `shared == false` with an owner), unless the row
is a copy of one of the viewer's own recent accepted sends. New `OwnSends.swift` ports the web's `OwnSend`, `ownSentRows` and
`nextSends` (#338): each accepted send is recorded from the echo it had, anchored, at most 20 per chat, in memory, and
ends when its echo leaves with its copy not shown. `AppStore.updateEcho` keeps the records and the open chat's claimed
rows (`ownRows`, observed). `SentEcho.shown(in:)` and the records share one matcher, `SentEcho.copyIndex`, so they cannot drift.

## Red proof

Eight lines were broken together by hand and went red, 14 failures in 177 unit tests plus the UI test: the shared-chat
condition, the 20-send cap, the anchor rule for a restored send, one row per send, the record ending with its echo, the
accepted-only word match in `shown`, `othersCanWrite`, and the store's `ownRows` update. The restored files passed.
`ShellFlowTests.testANoSenderMessageIsLabeledInASharedChatAndNotInAPrivateOne` (new Debug fixture `AGENT_INTERFACE_UI_UNKNOWN_SENDER`)
went red with `othersCanWrite` broken, because the private chat showed the label.

## Final run

`bash .agents/tools/validate-ios.sh 39F5329D-FA70-4259-9B8A-6AECECDE2227 test -only-testing:AgentInterfaceTests -only-testing:AgentInterfaceUITests/ShellFlowTests/testANoSenderMessageIsLabeledInASharedChatAndNotInAPrivateOne`
passed: 768 tests, 766 passed, 2 skipped (`testRenderPropEvidence`, `testRenderEvidence`, which need an evidence directory), 0 failed.
Input fingerprint `73e21d2d7f71`.

## Not covered

Group chat rows already name a sender-less member "Household member" (`GroupConversationView.memberName`); unchanged.
Once the branch for the receipt's `turn` lands, a stop phrase never becomes a record: its echo leaves in the same step,
and `nextSends` ends a record whose echo left with no copy.
