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
