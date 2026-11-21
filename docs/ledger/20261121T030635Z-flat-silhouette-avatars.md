# November 20 flat silhouette avatars

Web and server at commit `7054d774` on `t3/refresh-bot-avatars`, Node 26.13.0. The iOS half is
recorded in its own section below once it has run on the Mac mini.

## Web and server checks

- `npm run typecheck`, `npm run lint` and `npm run format:check`: clean.
- `npx vitest run`: 230 files, 4144 tests passed.
- `node .agents/tools/avatar-shapes.mjs --check` with paper 0.12.18: the generated art file is
  current. The tool's own check compared each merged outline with the drawing it came from at
  10,000 points per shape and found none over the 0.4% limit.
- All 13 definitions drawn for this app pass Open Bot Avatar's strict validator
  (`packages/core/scripts/avatar-validate.ts --strict` at `5e64c08`).
- Visual: `/avatar-specimen/` under Vite in Chromium at 1100 px, light theme, reduced motion.
  Inspected every shape at 70 px, with a cowboy hat, with glasses and with visor eyes at 56 px, and
  in the done state at 28 px. Hat size and height were corrected for 9 shapes from that pass.

Not exercised here: the dark theme, motion in a real browser beyond the specimen's still frames,
a phone, and the iOS app.

The specimen's state matrix showed a white mug's and ghost's blocked exclamation mark missing on
the light theme: the mark was drawn in the body color with no edge. It now takes the same soft
edge as a very light body.

## Red runs

Each guarded line was broken by hand once, the named test file run, and the line restored.
All 25 went red in the test written for them.

| Break                                   | File                               | Test that failed                                                                            |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| faceX ignores the anchor                | `src/components/Avatar.tsx`        | looks out from the part that carries the face, not the middle of the box                    |
| face radius ignores the anchor          | `src/components/Avatar.tsx`        | keeps a turning face on a narrow body                                                       |
| eye spacing ignores the anchor          | `src/components/Avatar.tsx`        | looks out from the part that carries the face, not the middle of the box                    |
| morph samples the hole too              | `src/components/Avatar.tsx`        | morphs along the outside of a shape with a hole and lands on its real outline               |
| morph never lands on the outline        | `src/components/Avatar.tsx`        | morphs along the outside of a shape with a hole and lands on its real outline               |
| unknown shape has no fallback           | `src/components/Avatar.tsx`        | draws a shape from a newer release as the blob instead of failing                           |
| hat ignores its size when placed        | `src/components/Avatar.tsx`        | sets a hat on the head it belongs to                                                        |
| family lookup trusts inherited names    | `src/shared/avatar-legacy.ts`      | reads a mascot family it never had as the blob, including an object's own property names    |
| recolor ignores the retired color       | `src/shared/avatar-legacy.ts`      | swaps a seasonal mascot's fixed face color for its shape's, and leaves a chosen color alone |
| recolor is case-sensitive               | `src/shared/avatar-legacy.ts`      | swaps a seasonal mascot's fixed face color for its shape's, and leaves a chosen color alone |
| Hermes metadata read keeps the mascot   | `src/server/hermes-mapping.ts`     | reads a mascot kept in Hermes profile metadata as its shape                                 |
| store read keeps the mascot             | `src/server/store-presentation.ts` | reads a mascot kept in the app's store as its shape                                         |
| avatar route refuses a mascot           | `src/server/bot-routes.ts`         | saves an avatar through native metadata and round-trips it through household presentation   |
| saved copy accepts any mascot family    | `src/app/saved-roster.ts`          | is not drawn with a retired mascot's unknown family                                         |
| saved copy skips a mascot's face checks | `src/app/saved-roster.ts`          | is not drawn with a retired mascot's color that is not a color                              |
| saved home draws the mascot unconverted | `src/app/saved-roster.ts`          | draws each mascot as the shape that took its place, in the color it had                     |
| a ghost turns home spooky               | `src/app/season.ts`                | gives each seasonal shape its season and leaves holiday-looking everyday shapes plain       |
| a turkey brings no season               | `src/app/season.ts`                | gives each seasonal shape its season and leaves holiday-looking everyday shapes plain       |
| a seasonal shape keeps the old color    | `src/components/AvatarEditor.tsx`  | brings a seasonal shape in its own color and keeps every other choice                       |
| every shape takes a seasonal color      | `src/components/avatar-shapes.ts`  | brings a seasonal shape in its own color and keeps every other choice                       |
| TARS loses its capitals                 | `src/components/avatar-shapes.ts`  | offers every other shape in the color already chosen                                        |
| portrait forgets the drawn character    | `src/components/AvatarEditor.tsx`  | restores the drawn character after trying a portrait                                        |
| an arc slips into an outline            | `src/components/avatar-shapes.ts`  | writes every outline as closed contours the native reader can parse                         |
| a face sits above its head              | `src/components/avatar-shapes.ts`  | keeps each face on its body, with room for the eyes at their largest                        |
| a light exclamation has no edge         | `src/components/Avatar.tsx`        | edges a very light exclamation too, so a white assistant that needs help can be seen        |

## Review fixes

After the independent review, at the commit that follows `63d18a56`: `npm run typecheck` and
`npm run lint` clean, `npx vitest run` 231 files, 4153 tests passed. With aligned samples the
smallest body any of the 2,862 ordered shape pairs passes through mid-morph is 89% of the smaller
shape's area; before, a blob halfway to a reindeer was 24% of the reindeer's.

Red runs for the lines these fixes added, 15 in all. One first survived: the tie-break
between two equally central samples, because the test's two samples were at the same height. The
test was rewritten with one above the other and the same break then failed it.

| Break                                          | File                               | Test that failed                                                                          |
| ---------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| shape lookup finds inherited names             | `src/components/Avatar.tsx`        | draws a shape it does not have as the blob instead of failing                             |
| season lookup finds inherited names            | `src/app/season.ts`                | gives each seasonal shape its season and leaves holiday-looking everyday shapes plain     |
| samples keep the way the outline was drawn     | `src/components/avatar-outline.ts` | starts at the top and runs clockwise, wherever and whichever way the outline was drawn    |
| samples keep the outline's own start           | `src/components/avatar-outline.ts` | starts at the top and runs clockwise, wherever and whichever way the outline was drawn    |
| equally central samples start at the lower one | `src/components/avatar-outline.ts` | starts between two equally central samples at the higher one                              |
| the sampler walks the hole too                 | `src/components/avatar-outline.ts` | walks only the outside of an outline, evenly, in every command the outlines use           |
| tuned eyes never shrink to fit                 | `src/components/Avatar.tsx`        | stops tuned eyes growing at the edge of the part the face sits on                         |
| tuned eyes shrink on every body                | `src/components/Avatar.tsx`        | looks out from the part that carries the face, not the middle of the box                  |
| face radius ignores the anchor                 | `src/components/Avatar.tsx`        | keeps a working rocket's eyes on its hull as its face turns                               |
| morph never lands on the outline               | `src/components/Avatar.tsx`        | morphs through 72 samples and lands on the real outline, hole and all                     |
| any mascot family is saved                     | `src/server/schemas.ts`            | saves an avatar through native metadata and round-trips it through household presentation |
| a saved copy refuses a shape it does not have  | `src/app/saved-roster.ts`          | is drawn at every bound's limit, so a copy bootstrap could produce always shows           |
| a saved copy takes any text as a shape         | `src/app/saved-roster.ts`          | is not drawn with a geometric avatar's shape that is not a name                           |
| a saved copy takes a shape of any length       | `src/app/saved-roster.ts`          | is not drawn with a geometric avatar's shape past any name's length                       |
| equally central samples keep the first met     | `src/components/avatar-outline.ts` | starts between two equally central samples at the higher one                              |

## Re-review fixes

The re-review of `313acec4..d27f38c7` found that the eye fit drew no eyes for an eye style this
release does not have, where it had drawn oval ones. Fixed, and the eye-fit test now also requires
both eyes to be drawn for most of the working run. `npx vitest run tests/avatar-component.test.ts`:
23 tests passed.

| Break                                    | File                        | Test that failed                                                  |
| ---------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| an unknown eye style has no width        | `src/components/Avatar.tsx` | draws an eye style it does not have as oval eyes instead of none  |
| an inherited name counts as an eye style | `src/components/Avatar.tsx` | draws an eye style it does not have as oval eyes instead of none  |
| a fitted avatar draws no eyes at all     | `src/components/Avatar.tsx` | stops tuned eyes growing at the edge of the part the face sits on |

## Full check battery at `2c5727be`, on the Fedora laptop

`~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going`, queued 74 minutes for
the machine lock and ran 14 minutes 21 seconds. The iOS commits after `2c5727be` change no web,
server or test file, so these results stand for the branch.

| Check                    | Result                               |
| ------------------------ | ------------------------------------ |
| typecheck                | compiled, no errors                  |
| lint                     | passed                               |
| ruff                     | passed                               |
| test                     | unit-passed: 231 files, 4154 tests   |
| build                    | built: 914 modules                   |
| e2e, Chromium            | runtime-exercised: 142 of 142 passed |
| e2e, WebKit on this host | not run: all 142 failed at launch    |
| py                       | passed: 52 files                     |

WebKit does not start on the Fedora laptop: `browserType.launch` reports "Host system is missing
dependencies to run browsers" (`libicu74`, `libjpeg-turbo8`). Two other worktrees' runs the same
day failed the same way, every WebKit test and no Chromium test. So the WebKit half ran in the
container the [November 20 WebKit entry](20261120T202616Z-webkit-browser-tests.md) used:
`podman run mcr.microsoft.com/playwright:v1.65.0-noble npx playwright test --project=webkit`, Node
26.13.1, queued 52 minutes and ran 5 minutes 41 seconds: 138 passed, 3 skipped, 1 failed.

The one failure is `e2e/smoke.spec.ts:811`, "the message box floats over the transcript, whose
latest message rests just above it". That entry records it failing on main in CI at the same line,
and issue #462 tracks it. The 3 skips are the worker badge and back-forward cache tests WebKit
already skipped.

Not exercised: Safari itself, and motion in any browser beyond still frames and the unit tests.

## iOS

The native port on `t3/refresh-bot-avatars`, through web commit `2c5727be`, on the Mac mini with
Xcode's iPhone 17 simulator (`0915E0B2`). Every run went through `.agents/tools/validate-ios.sh`
under the shared Mac lock.

### Checks

- Unit suite at `dfda0001`, `validate-ios.sh 0915E0B2 test -only-testing:AgentInterfaceTests`:
  851 tests, 0 failures, 2 skipped by design. 80 s of test execution, 147 s with the build.
- The 17 new tests in `AvatarShapeTests` and the rewritten `AvatarArtParityTests` passed in that run.
- `NativeFlowTests` and `SettingsPolishTests` at `ecac8e56`: every avatar test passed except
  `testAFailedAvatarSaveKeepsTheNewAssistantOpenWithRetry`, whose picker sat under the keyboard.
  `8316c0ad` closes the keyboard first. `testChoosingATalkVoiceSavesItAndSamplesPlayAndStop` failed
  once in the same run and passed in the run before it, with no change to its code: flaky.
- Captures at `8316c0ad`: `testVariedRosterHome` and `testAvatarShapesReview` passed.
- Full unfiltered suite at `d43d5c81`, `validate-ios.sh 0915E0B2 test`: 1022 tests, 1007 passed,
  14 skipped, 1 failed. 2 h 29 min of execution after 32 min in the lock queue. The failure is
  `ScreenshotTourTests.testWorkTriggerAfterDesignReview` ("Wrong W3 fixture"): the test pins a
  SHA-256 of `.agents/fixtures/work-triggers.json` that the file has not had since #453 reformatted
  it. Neither changed on this branch, so it fails on `main` too. It was not run on `main` here, but
  the hashes settle it: the test pins `5ed79b27…`, and `sha256sum` of the file gives `e952e902…`
  on both `origin/main` and this branch.
- An earlier full run at `8316c0ad` found two failures of this port: a capture that asked
  `isHittable` directly, which `FixedWaitRuleTests` forbids, and `testAvatarCreationLayoutRegression`,
  which ran out of drags before the creation form's bottom Next now that the form carries 54 tiles.
  `d43d5c81` fixes both. That run does not validate one source state: the fixes were edited in
  while it ran, and the wrapper said so.

`.agents/tools/check-all` at `d43d5c81` on the Mac mini, with Node 24.22.2 (the Mac's own Node is
26.10, which `npm ci` refuses): typecheck, lint, ruff, build and py pass. Vitest: 4154 tests, 5
failed, all on this host's setup. Three need the loopback alias `127.0.0.2`, which this Mac lacks
(`direct-routes`, and `native-contract`, the one that checks the iOS contract fixture), and two in
`upgrades.test.ts` run `/usr/bin/python3`, which here is too old for the worker's syntax. e2e: 284
tests, 6 failed in cascade layers, phone overlays and the phone smoke test, none about avatars. The
iOS port changes no web, server or test-runner file, so all of these are the branch's web state as
of `2c5727be`, not this port.

`testScreenshotTour` stops where it waits for a settings button named Avatar
(`ScreenshotTourTests.swift:3319`, unchanged from `main`). The avatar editor moved under Profile
with the settings sections on November 6. `testAvatarShapesReview` captures the editor and the
specimen instead.

### What was looked at

The editor's four shape groups, the Debug specimen's groups and state matrix, a white mug in every
state, and home with a varied roster (`AGENT_INTERFACE_UI_ROSTER=varied`) in both themes. Eyes sit
on the cup of the mug, the lens of the magnifier, the palette and the dino's head. The mug's handle
is open, hats and glasses sit on the head, and the white mug, egg, ghost and snowman keep their soft
edge. The white mug's and ghost's blocked exclamation marks are edged; saturated ones are not. Home
shows a blocked assistant as Ready with "Needs your help" in words, as before, so the edged mark is
checked in the specimen.

### Red runs

Each guarded line was broken by hand, the avatar test classes run, and the line restored by
`git checkout`. The mutations ran in four batches whose target tests do not overlap, all on
`dfda0001` except M20 on `ecac8e56`. All 19 went red in the test written for them. The
numbering skips M10.

| Break                                        | File                   | Test that failed                                                                                                                                                   |
| -------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1 recolor ignores the retired color         | `Models.swift`         | `testASeasonalMascotsFixedFaceColorBecomesItsShapesColor`                                                                                                          |
| M2 an unknown family becomes a bear          | `Models.swift`         | `testAMascotFamilyNoBuildHadDecodesAsTheBlob`                                                                                                                      |
| M3 a mascot keeps its mode                   | `Models.swift`         | `testARetiredMascotDecodesAsItsShapeAndKeepsEveryChoice`, `testABotFromAnOlderServerArrivesWithItsMascotConverted`                                                 |
| M4 a converted avatar writes a family        | `Models.swift`         | `testARetiredMascotDecodesAsItsShapeAndKeepsEveryChoice`                                                                                                           |
| M5 hat ignores the anchor's cx               | `AvatarView.swift`     | `testAnOffCenterFaceSitsOnItsAnchor`                                                                                                                               |
| M6 eyes ignore the anchor's cx               | `AvatarView.swift`     | `testAnOffCenterFaceSitsOnItsAnchor`                                                                                                                               |
| M7 face turns on the default sphere          | `AvatarView.swift`     | `testANarrowFaceTurnsAndGlancesWithinItsOwnRadius`                                                                                                                 |
| M8 a glance ignores the face's reach         | `AvatarView.swift`     | `testANarrowFaceTurnsAndGlancesWithinItsOwnRadius`                                                                                                                 |
| M9 morph samples the hole too                | `AvatarView.swift`     | `testAShapeWithAHoleMorphsAlongItsOutsideAndDrawsTheHoleWhenStill`                                                                                                 |
| M11 samples keep a counter-clockwise outline | `AvatarView.swift`     | `testMorphSamplesStartAtTheTopAndRunClockwise…`, `testTheBlobStartsWhereItsOutlineDoesAndTheDropIsReversed`, `testNoMorphBetweenTwoShapesCollapsesTheBodyOnTheWay` |
| M12 a tie keeps the earlier sample           | `AvatarView.swift`     | `testBetweenTwoEquallyCentralSamplesTheHigherOneStarts`                                                                                                            |
| M13 samples are never rotated to the top     | `AvatarView.swift`     | `testMorphSamplesStartAtTheTopAndRunClockwise…`, `testNoMorphBetweenTwoShapesCollapsesTheBodyOnTheWay`                                                             |
| M14 tuned eyes never fit                     | `AvatarView.swift`     | `testTunedEyesStopGrowingAtTheEdgeOfThePartTheFaceSitsOn`                                                                                                          |
| M15 a seasonal shape keeps the old color     | `Models.swift`         | `testPickingASeasonalShapeBringsItsColorAndOthersKeepTheChosenOne`                                                                                                 |
| M16 a light exclamation has no edge          | `AvatarView.swift`     | `testAVeryLightBodysBlockedMarkKeepsItsEdge`                                                                                                                       |
| M17 an extra fixed path                      | `AvatarPathData.swift` | `testFixedPathsAreExactlyTheOnesTheWebDraws`                                                                                                                       |
| M18 an unknown mode draws its shape          | `Models.swift`         | `testAnAvatarValueThisAppDoesNotKnowSurvivesASaveUnchanged`                                                                                                        |
| M19 an unknown eye style draws nothing       | `AvatarView.swift`     | `testAnEyeStyleThisBuildDoesNotHaveDrawsAsOvalEyes`                                                                                                                |
| M20 an unknown eye style fits as a visor     | `AvatarView.swift`     | `testAnEyeStyleThisBuildDoesNotHaveDrawsAsOvalEyes`                                                                                                                |

M20 first stayed green: the oval had no entry of its own and fell to the same default, so the
fallback and the oval moved together. `545e8daa` names the oval's width, and M20 then went red.

Not red-run: the UI tests. `NativeFlowTests` reads back the pumpkin's saved color swatch, which
M15 breaks at the unit level.
