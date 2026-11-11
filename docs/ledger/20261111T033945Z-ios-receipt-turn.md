# iOS reads the receipt's `turn` and `admittedVersion`

Branch `t3/ios-receipt-turn`, based on `origin/main` at `41bfa499`. Swift written and run on the Mac mini
(Xcode 27.2, iPhone 18 Pro simulator, iOS 27.0) through `.agents/tools/validate-ios.sh`. Simulator runs, not device runs.

## What changed

`Receipt` decodes `turn` and `admittedVersion`, as does `RetryClaim` for `turn`. A typed stop phrase
(`accepted` with `turn: "none"`) keeps the draft as a refusal does, plays no sent cue and starts no Live
Activity, keeps declined approvals, drops the echo, and the dock shows the receipt's message. `joined` reads as steered.
A retry whose receipt or server claim says `none` is explained as refused. iOS has no early "thinking" row, so the
web's `admittedVersion` rule has nothing to end here; the field is decoded only.

## Red proof

Eight lines were broken together by hand and every protecting test went red, 19 failures in 232 tests
(`t1-mutants` run): the echo's `admitted` guard, `joinedRunningWork`, the declined-approval clear, the `refused` call for
`admittedNothing`, the sent haptic, the dock item, the retry refusal and the retry haptic. The restored files then passed.
The UI test `TranscriptFlowTests.testATypedStopPhraseKeepsTheDraftAndSaysNothingWasSent` went red with the dock item and
the draft handling broken (the notice never appeared) and green restored. Breaking only the draft-clear line did not
turn it red, because `refused` puts the draft back; the unit test on the declined approval catches that line.

## Final run

`bash .agents/tools/validate-ios.sh 39F5329D-FA70-4259-9B8A-6AECECDE2227 test -only-testing:AgentInterfaceTests -only-testing:AgentInterfaceUITests/TranscriptFlowTests/testATypedStopPhraseKeepsTheDraftAndSaysNothingWasSent`
passed: 757 tests, 755 passed, 2 skipped (`testRenderPropEvidence`, `testRenderEvidence`, which need an evidence directory),
0 failed. Input fingerprint `cab9edd9bd52`.
