# October 24 native iOS features validation

This entry covers the native features branch at commit `ac2a9e0`, rebased onto main
`7f9f334`. Claude Opus 5.5 implemented it. The native fingerprint, `python3
.agents/tools/source-state.py ios/ .agents/tools/validate-ios.sh
.agents/tools/patch-xctestrun.py`, is
`sha256:90b35bc323c2e9f54617d71b8615ebf34b8baf9d877d9783632dd288f4ecac35` over 227
files. The whole repository fingerprint is
`sha256:f9053424ace89da11ef578d235ca6bba26fb64f3285c0710a0909343f77aa8ae` over 1078
files. The build number is 15.

Native runs used the Mac mini with Xcode 27.1 (27A9275) on an iPhone 18 Pro simulator
running iOS 27.0, through `validate-ios.sh` with its shared lock.

## Application tests

- `npm run typecheck`, `npm run build` and Vitest passed on Node 26.10 and Node 24.21:
  89 files and 1093 tests. Push-to-start tests cover the start payload, the app's own
  start hold, dismissal and coverage of runs, account takeover of the token, races with
  Hermes reads, unreadable conversations and payload size.
- The full scheme at `ac2a9e0` ran 477 cases: 472 passed, 4 skipped and 1 failed. The
  UI suite ran 64 cases with the 2 known skips and no failures, in 27 minutes.
- The failure was `NativeContractTests.testAnExpiringSignInStopsTheChangeStreamToo`,
  which timed out in its first 10-second wait for the event stream. It runs before
  any code this branch changes. Run alone at the same commit, it passed 10 of 10
  iterations.
- An earlier full run, before the review fixes, failed
  `AutomationFlowTests.testAdvancedRoutineSavesScriptAndKeepsInheritedModel` once at its
  switch row. This branch does not touch the routine editor, and the final run passed it.
- New native tests cover notification sender pictures, account cleanup and donation
  ordering, the talk link, its App Group hand-off, its freshness and account, the
  pushed-activity duplicate and account rule, and on-device transcription with its server
  fallback. A UI test opens the talk link from home into a recording.

## Visual checks

Rendered notification avatars, geometric and mascot, were inspected at 288 pixels. Each
stays inside the circle iOS crops sender pictures to.

## Independent review

GPT-6.1 Sol reviewed the full branch diff at high reasoning effort over 12 rounds. Every
verified finding was fixed and each round was checked again. The last round approved.

## Not exercised

Physical devices and APNs: pushed starts and their update tokens, communication
notification appearance, Time Sensitive delivery, the control in Control Center and on
the Action button, and on-device speech models. The simulator has no push. The App Store
profiles also need Time Sensitive Notifications and Communication Notifications turned on
in the Apple Developer portal before the next archive.
