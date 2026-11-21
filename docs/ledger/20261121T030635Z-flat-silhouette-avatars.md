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
