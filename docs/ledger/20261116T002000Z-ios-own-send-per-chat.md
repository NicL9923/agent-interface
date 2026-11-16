# iOS own sends across chats

Base `92b3fadc4f712a4338166c5f6184183fae54ca6c`. Claude authored the production fix and regression test. The recovered source SHA-256 values are `eabfd94b2ca6c8e0743182b0d3d5c857270d6e6490ddbc997481180914a200e0` (OwnSends), `9ec21efb891d25b674c900a8a5c31578bf98ee27636e7b0220808654e33523ba` (Models), `a8df347e78451a1de817c70e3500329820c968961f25c3a313238c85db13605f` (AppStore), and `c72067d1ea5121390b4c83fd45c1192613149feb6532ed816280b5c1b724e4ef` (NativeContractTests).

The regression against baseline production code failed one test with four assertions: the echo and anchor disappeared, the accepted send was not recorded, and its saved row was not claimed. Log: `/Volumes/DevSSD/scratch/own-send-red.log`; result: `.private/ios-test-20261115T232125Z-46713.xcresult`.

With the recovered source, `validate-ios.sh` ran NativeContractTests, OwnSendsTests and ConversationParityTests on the simulator: 188 tests passed. Log: `/Volumes/DevSSD/scratch/own-send-green.log`; result: `.private/ios-test-20261116T001657Z-93808.xcresult`.

`check-all` passed typecheck, lint and ruff, then failed 3 of 4064 tests because this Mac cannot bind `127.0.0.2` (EADDRNOTAVAIL). Build and e2e were skipped. Log: `/Volumes/DevSSD/scratch/own-send-check-all.log`.

After merging `origin/main` at `62ea8cb9`, native suites ran on merge commit `b532b0a9e4cf402d6bd473416cbccea7c6f9263c`: the regression passed, but 2 assertions failed in `testUploadFinishingWhileReturningDraftLoadsKeepsTheFile` (188 tests total). That test passed in the earlier run. Log: `/Volumes/DevSSD/scratch/own-send-merged-green.log`; result: `.private/ios-test-20261116T004638Z-21558.xcresult`. An isolated retry was canceled while queued so the shared checkout could be released for the parent task; it did not run.


## Coordinator follow-up: select outgoing status for the open chat

Sol's re-check of the Claude implementation at f2ccbc02 found that the outgoing getter still
selected the first unsettled echo from any chat. Preserving chat A's echo therefore masked
chat B's delivery and its send-anchor observer. This follow-up is implemented by GPT-6.1 Sol.

At test-only commit f7f9783d, NativeContractTests/testOutgoingTracksOnlyTheOpenChatWhenTwoSendsAreUnsettled
failed with four assertions on the Mac's iPhone 17e simulator. The real AppStore selected A's
request and status while B was open. Log: /Volumes/DevSSD/scratch/own-send-outgoing-red.log.
The getter now filters by selectedBotId before choosing a delivery. The regression checks
no outgoing item in the newly opened chat, B's sending and unconfirmed statuses, and A's
status when returning. Native green validation of the completed fix remains pending.

The earlier two upload/draft assertions did not reproduce when the single test was run on
both f2ccbc02 and base62ea8cb9. Each isolated run passed. Their cause remains unknown, so
those passes do not turn the earlier full-suite failure into a pass. The new native run must
report the complete suite result separately. Logs: own-send-isolated-pr.log and
own-send-isolated-base.log under /Volumes/DevSSD/scratch.

The original source was Claude-authored and Sol independently reviewed it. This added test
and outgoing filter are OpenAI-authored and still need eligible non-OpenAI independent review.
No production deployment ran. A release is required after merge.


## Compiler correction after the Mac validation attempt

At `bddec87639efd7c3f4b7b84f639f7998996159d2`, both requested native invocations
failed during compilation, before any tests ran. Xcode 27.2 requires the instance reference
inside the lazy filter closure to be explicit. The getter now uses `self.selectedBotId`.
This compiler correction changes no selection condition or test assertion.

Failed logs: `/Volumes/DevSSD/scratch/ios-validation-task-20261116/pr430-single.log`
and `pr430-full.log` in that directory. No fresh baseline build ran; the base did not
contain this closure. The previous baseline and isolated results do not validate this head.
A fresh exact-commit focused and complete three-suite run is required on the Mac.
The queued Linux job prints the checked-out commit before execution; its scope cannot
compile Swift and does not replace this required native check.
