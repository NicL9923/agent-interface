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

## After merging main, at `8c4b3c7b`

`c7f02959` merges `origin/main` at `320740c3`, which brought in #466 (connection and reconnect
states). It touched the avatar rig and models on both platforms; the only textual conflict was the
generated Xcode project, regenerated with `ios/tools/generate-project.py`.

`~/.agents/tools/linux-heavy-lock.sh` around `check-all --keep-going` and then the WebKit container
run, queued 13 minutes 30 seconds and ran 26 minutes 12 seconds:

| Check                        | Result                                             |
| ---------------------------- | -------------------------------------------------- |
| typecheck, lint, ruff        | passed                                             |
| test                         | unit-passed: 233 files, 4244 tests                 |
| build                        | built: 915 modules                                 |
| py                           | passed: 52 files                                   |
| e2e, Chromium                | runtime-exercised: 142 of 142 passed               |
| e2e, WebKit on this host     | not run: all 142 failed at launch, as before       |
| e2e, WebKit in the container | runtime-exercised: 136 passed, 3 skipped, 3 failed |

An earlier `npx vitest run` on the merge, outside the lock with the load average at 94, had two
15 second timeouts, one each in `account-transitions-ui.test.ts` and `message-markdown.test.ts`.
Both files passed alone (195 tests) and in the run above: flaky under load.

The three WebKit failures are main's. Its own CI, the Browser smoke job on the push of `320740c3`
(run 44920781588), failed `e2e/smoke.spec.ts:40` ("the app opens offline from the service worker")
and `:811` ("the message box floats over the transcript"), and marked `:352` ("a returning
member's home is drawn from this device before bootstrap answers") flaky: it failed and passed on
CI's one retry. The run here has no retry, so `:352` counts as a failure. `:40` and `:811` also
failed on the push of `f103ecfc`, the #466 merge; before #466 only `:811` did, and this branch's
run at `2c5727be` matched that.

GitHub's PR checks on `8c4b3c7b` (run 44927252277): Node on `.node-version`, Node 26.13.0, Python
3.14.7 and the release archive build passed. Browser smoke does not run on pull requests.

## Review rounds

Independent reviews by GPT-6.2 Sol at high reasoning effort. The count is for the whole change.

| Round | Reviewed state | What it read                                                      | Findings |
| ----- | -------------- | ----------------------------------------------------------------- | -------- |
| 1     | `313acec4`     | Web, server, tests, the shape tool and docs                       | 7        |
| 2     | `d27f38c7`     | The fixes for round 1                                             | 4        |
| 3     | `31dd5e4b`     | The iOS port, read for the first time, and the web fix `2c5727be` | 6        |

No reviewer has read what came after `31dd5e4b`:

- `c7f02959`, the merge of `origin/main` with #466, which was reviewed in its own pull request.
- `6a072c2a` and `8c4b3c7b`, the release order in `docs/AvatarShapes.md`.
- `df363670` and `92f2d96f`, the iOS fixes for round 3, with the test-only `326efbd2` and
  `a1589517`. Outside tests they change 62 lines in four Swift files: a mascot's `shape` is not
  read, the sender picture's fingerprint covers its art, a frozen avatar does not start a morph,
  and picking the shape an avatar already has changes nothing.

That is under the round limit's 300 lines and touches no authentication, secrets, deletion or
migration, so there is no round 4.

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
  in the same run. This entry first called it flaky; it was this port's. See "iOS review fixes".
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
tests, 6 failed in cascade layers, phone overlays and the phone smoke test, none about avatars. This
entry first put all six down to the branch's web state, which was reasoned and not checked. One is:
WebKit `smoke.spec.ts:811`, which fails on main too. The other five are Chromium (four in
`cascade-layers.spec.ts:350`, one in `phone-overlays.spec.ts:56`), and the Fedora run above passed
all 142 Chromium tests on the same web code, so they belong to this Mac. Why was not looked into.

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

### iOS review fixes

After `c7f02959` merged `main` (#466), the review of the Swift found five things. All five held,
the third for about a second rather than for good.

- A mascot with a malformed `shape` failed the decode of its bot, the roster and the offline library.
  `AvatarConfig.init(from:)` now reads `mode` first and never reads a mascot's `shape`. Other modes
  still refuse a shape that is not a name.
- Notification sender pictures were cached by the avatar's settings alone, so a cloud or ghost kept
  its old outline. The fingerprint now covers the shape's outline and face from `AvatarCatalog`.
- A shape or color change on a frozen avatar started a morph that no frame carried. Measured on the view before the fix, in a window: an interrupted, disconnected or unknown
  avatar kept the old shape and color for about one second, until the timer that follows any change
  redrew it. It did not stay until some other redraw, as the finding had it. The editor's preview
  offers no frozen state; the specimen's frozen cells and an outage's home rows do. A change now
  moves into place only while the timeline runs, and otherwise shows at once.
- Tapping the selected seasonal tile reset a color chosen since. Picking the shape an avatar already
  has now changes nothing; the tile still previews the seasonal color, as on the web.
- `AvatarArtwork.still` was never read. It is gone.

`testChoosingATalkVoiceSavesItAndSamplesPlayAndStop` was also this port's. A recording shows the form
stop once the eye sliders reach the middle of the screen: `reveal`'s swipe then starts on a slider's
thumb and drags it. The longer picker moved where the swipes land, so the test failed in 3 of 6 runs.
`326efbd2` blamed the number of swipes and fixed nothing; `a1589517` drags the form's gutter.

The merge needed no Swift fix. #466 removed the lost-connection badge on both apps; the parity
test's exclusions were already exact, and its comment now says why.

#### Red runs

Each break was made by hand, the named test classes run, and the line restored. R1 to R5 ran on
`df363670` (`AvatarShapeTests`, `NativeFeatureTests`), R6 to R8 on `92f2d96f` (`AvatarShapeTests`).
R4 covers the decision only: the first tests would have passed with the view still asking the old
condition. R6 to R8 host the real view and read its pixels.

| Break                                                   | File                  | Test that failed                                                        |
| ------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------- |
| R1 a mascot's shape field is read                       | `Models.swift`        | `testAMascotWithAMalformedShapeStillDecodes`                            |
| R2 a sender picture's fingerprint ignores the art       | `SenderAvatars.swift` | `testASenderPictureIsDrawnAgainWhenItsShapesArtChanges`                 |
| R3 the body stays the samples once the morph lands      | `AvatarView.swift`    | `testTheDrawnBodyLandsOnTheExactOutlineHoleAndAll`                      |
| R4 a frozen avatar starts a morph                       | `AvatarView.swift`    | `testAChangeOnlyMovesIntoPlaceWhileFramesCanCarryIt`                    |
| R5 picking the shape again resets its color             | `Models.swift`        | `testPickingASeasonalShapeBringsItsColorAndOthersKeepTheChosenOne`      |
| R6 R3 again, seen on the view                           | `AvatarView.swift`    | `testTheViewsMorphLandsWithTheMugsHandleOpen`                           |
| R7 the view's shape change asks only for reduced motion | `AvatarView.swift`    | `testAFrozenAvatarsViewShowsItsNewShapeAndColorWithoutWaitingForAMorph` |
| R8 the view's color change asks only for reduced motion | `AvatarView.swift`    | the same                                                                |

#### Checks

Final code commit `92f2d96f`, iOS 27.0 iPhone 17 simulator made for this task. The runs came from a
detached checkout of that commit with the lock-scope helper (`25b31de5`, pull request #468) on top
so they could share the Mac; its `ios/` tree is the commit's, `c373b9ba`. The helper is not on this
branch.

- Unit suite: 936 tests, 0 failed, 2 skipped, 61 s.
- `NativeFlowTests`, `SettingsPolishTests`, `testVariedRosterHome`, `testAvatarShapesReview`: 25
  tests, 0 failed, 1033 s. The Talk voice test alone passed 3 of 3 at `a1589517`.
- Full unfiltered suite: 1113 tests, 1097 passed, 14 skipped, 2 failed, 9577 s.
  - `testWorkTriggerAfterDesignReview` ("Wrong W3 fixture") is main's: it failed the same way on
    `320740c3`, run here.
  - `AutomationFlowTests.testInterruptedGoalRequiresReviewThenResumesAndPauses` lost its review
    switch on the Work tab. Not attributed. It passed in three full runs of this branch before this
    one, then 9 of 10 repeats on this branch and 10 of 10 on `320740c3`: too few to tell a flaky
    test from a difference. The branch changes neither the Work tab nor that test.
- `NativeContractTests.testACancelledReadThatDisplacedTheRetrySetsItAgain` (#466) failed some runs of
  this branch. Cold, alone, it failed 1 of 3 here and 1 of 3 on `320740c3`, so it is flaky on main.
- `testScreenshotTour` stops at the same "Avatar" button on `320740c3`, run here.
- An earlier full run, at `d09fd2e1`: 1111 tests, 2 failed, that retry test and W3.
