# November 9 iOS Talk voice picker and crash reports

Branch `parity/ios-voice-picker-crashes` on the Mac mini, based on `114caa10`. Code state:
`source-state.py` fingerprint `sha256:40c72735eeaec916073cd66bb425089b5d12ab7366f9432c63cc8192df945df4`
(1646 source files) at the last production change; the final commit adds only a test fix and this
entry. Xcode 27.2, iPhone 18 Pro simulator on iOS 27, `validate-ios.sh`, derived data on DevSSD.
Fixture transport only.

## What changed

- Per-assistant Talk voice picker in iOS Profile settings (`TalkVoicePicker.swift`), with `voice` on
  `Bot` and fixture support for `PUT /bots/:id/voice` and `/voice-previews/`. The web picker drops
  "Live Talk works in the web app."
- MetricKit crash and hang reports (`CrashReports.swift`) sent to `POST /client-errors`, whose schema
  gains `crash` and `hang` kinds and an optional `platform` of `web` or `ios`.

## Tests

- Server, Node 24.22.2: `client-errors-api`, `error-reports-ui`, `talk-ui` passed, 23 tests. Typecheck clean.
- iOS unit, clean run: `SettingsParityTests` 33 and `CrashReportTests` 15 passed, 0 failures.
- iOS UI: all 10 `SettingsPolishTests` passed, including the new voice flow. An earlier unit run caught a
  wrong expectation of mine (the escaped path encodes dots too); fixed and rerun clean.

## Mutants, each confirmed red then restored

- Server: dropped `crash` and `hang` from the kind enum; made `platform` a free string. Both failed the
  new iOS report test.
- iOS (applied together, failures attributed by test name): removed the rollback of the chosen voice
  (`testAFailedVoiceSaveRollsBackAndSaysWhy`); fetched the public sample with the session token
  (`testASampleThatCannotLoadReportsItAndPlaysNothing`); inverted the unavailable-capability guard
  (`testUnavailableLiveTalkNote...`); 429 dropped one report instead of all
  (`testARateLimitDropsEverything...`); removed the frame cap (`testTheStackKeepsOnlyTheTopFrames...`);
  removed the pending bound (`testReportsWaitWhileSignedOut...`).
- Not mutated: the UI flow and `testStoppingASampleReleasesTheSharedAudioClaim`.
