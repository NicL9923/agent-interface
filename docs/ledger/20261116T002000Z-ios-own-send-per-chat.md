# iOS own sends across chats

Base `92b3fadc4f712a4338166c5f6184183fae54ca6c`. Claude authored the production fix and regression test. The recovered source SHA-256 values are `eabfd94b2ca6c8e0743182b0d3d5c857270d6e6490ddbc997481180914a200e0` (OwnSends), `9ec21efb891d25b674c900a8a5c31578bf98ee27636e7b0220808654e33523ba` (Models), `a8df347e78451a1de817c70e3500329820c968961f25c3a313238c85db13605f` (AppStore), and `c72067d1ea5121390b4c83fd45c1192613149feb6532ed816280b5c1b724e4ef` (NativeContractTests).

The regression against baseline production code failed one test with four assertions: the echo and anchor disappeared, the accepted send was not recorded, and its saved row was not claimed. Log: `/Volumes/DevSSD/scratch/own-send-red.log`; result: `.private/ios-test-20261115T232125Z-46713.xcresult`.

With the recovered source, `validate-ios.sh` ran NativeContractTests, OwnSendsTests and ConversationParityTests on the simulator: 188 tests passed. Log: `/Volumes/DevSSD/scratch/own-send-green.log`; result: `.private/ios-test-20261116T001657Z-93808.xcresult`.

`check-all` passed typecheck, lint and ruff, then failed 3 of 4064 tests because this Mac cannot bind `127.0.0.2` (EADDRNOTAVAIL). Build and e2e were skipped. Log: `/Volumes/DevSSD/scratch/own-send-check-all.log`.
