# November 19 phone glass composer

Branch `t3/mobile-liquid-glass-input`. Web checks last ran on the code at `6667bbd9`, and the
native checks at `d6d89798`. No Swift file changed after `d6d89798`.

On phones the message box floats over the transcript with nothing behind it, and the box is glass.
On the web (max-width 620px), a CSS backdrop blur provides the glass. iOS 26 and later use Liquid
Glass through `glassEffect`, and iOS 17 to 25 use a material fallback.

## Application tests

- `.agents/tools/check-all --keep-going` on LaptopServer at `6667bbd9`:
  - Typecheck, lint, the unit tests (225 files, 4,120 tests) and the build passed.
  - All 89 Chromium e2e tests passed.
  - All 89 WebKit tests failed to launch because the host is missing Playwright's system
    libraries. This is a host limit, not a test result.
- Native tests on the Mac mini at `d6d89798`, using an iPhone 18 Pro on iOS 27.0 with Xcode 27.2:
  - `AgentInterfaceTests` had 812 tests pass and 2 skipped.
  - `AgentInterfaceUITests/DailyFlowTests` had all 8 tests pass.
- At `f915963d` and `ea5e7dc4`, `testTranscriptRunsUnderTheMessageBox` failed because iOS 27
  flattens the glass card, so `composerCard` was never exposed. The test now measures
  `composerArea`. That passes, and the test passed on the parent commit `18b9699a` too.

## Red runs

Each break was made by hand in Chromium, and the named test failed:

- In `on a phone held upright › the message box floats over the transcript`:
  - Dropping the transcript's end padding gave `lastClear: false`.
  - Dropping the frame's negative margin gave `underArea: -68` and
    `gapReachesTranscript: false`.
  - Changing the composer area's `pointer-events: none` to `auto` gave
    `gapReachesTranscript: false`.
- In `a sent message held near the top stays there while the next draft grows and clears`,
  counting the end padding as content moved the sent message from 24px to 493px. The test now
  runs at 390x582 with a 12-line draft. There, measuring content as `scrollHeight` less the
  fractional end padding still moved it from 24px to 231px in 3 of 3 runs. The final
  `space.offsetTop` measure passed 3 of 3.

## Visual checks

- Chromium at 390x844, light and dark: messages scroll under the glass box with no band, and the
  latest message rests above the box.
- iOS 27.0 simulator, light and dark, at the latest message, scrolled, and with five lines and the
  keyboard up: no opaque band, the controls are aligned, and the card text stays legible.

## Not exercised

- WebKit, Safari on a phone, and Chromium with reduced transparency or more contrast. These fall
  back to a solid box.
- The iOS 17 to 25 material fallback, because no simulator runtime for it was installed.
- The z-index fix for the find bar and the quote button has no automated test.
- The status dock and the Talk panel over a scrolled transcript.
