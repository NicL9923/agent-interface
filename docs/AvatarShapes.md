# Avatar shapes

Every drawn avatar is one flat silhouette with two eyes. The app has 54 shapes in four picker
groups, the same on web and iOS. Mascot characters with muzzles, ears and glossy eyes were retired
on November 20, 2026. Each one has a shape that took its place.

## Where the shapes come from

| Group     | Shapes                                                                                                                                                             | Source                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Classic   | blob, pebble, squircle, capsule, triangle, hex, drop, circle, diamond, sparkle, clover, heart, cookie, pentagon, burst, alien, flower, sun                         | Drawn for this app in September 2026. See [AvatarReferenceInventory.md](AvatarReferenceInventory.md) |
| Objects   | cloud, star, egg, shield, chat, lightbulb, mug, book, camera, magnifier, controller, barbell, brain, rocket, palette, paint-brush, watering-can, sprout, witch-hat | Open Bot Avatar                                                                                      |
| Objects   | cactus                                                                                                                                                             | Drawn for this app                                                                                   |
| Creatures | ghost, cat, bunny, bull                                                                                                                                            | Open Bot Avatar                                                                                      |
| Creatures | bear, fox, owl, dino, tars, rocky                                                                                                                                  | Drawn for this app                                                                                   |
| Seasonal  | pumpkin, bat, turkey, santa-hat, reindeer, snowman                                                                                                                 | Drawn for this app                                                                                   |

The 23 Open Bot Avatar definitions are the seven starters and 16 gallery avatars of
[DominikScholz/open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar) at commit
`5e64c081971eb296f562544641bad37d40fb36b6`, MIT licensed. The app uses their outlines and eye
placement. It does not use that project's renderer: this app's own rig draws them, so they share
its states, hats, glasses, eye styles and conductor with every other shape. `cloud` and `ghost`
took the place of the app's earlier outlines of the same names.

The 13 shapes drawn for this app use the same definition format and pass that project's strict
validator (`avatar-validate.ts --strict`), which checks face room and silhouette seams. TARS is four
slabs mid-stride. Rocky is a rock carapace on four legs with the fifth limb raised for a fist bump.

## Files

- `.agents/tools/avatar-shapes/definitions/<id>.json` holds each object, creature and seasonal
  shape as a definition: one path in a 0-100 box and where the eyes sit.
- `.agents/tools/avatar-shapes.mjs` turns the definitions into `src/components/avatar-shape-art.ts`.
  It merges a definition's overlapping parts into one outline, turns arcs into cubics, scales the
  drawing by 1.07 to the size of the classic shapes, and measures the face anchor. Its header lists
  the commands.
- `src/components/avatar-shapes.ts` is the catalog the web draws from: the classic outlines, the
  generated ones, labels, picker groups and seasonal colors.
- `src/shared/types.ts` lists the shape ids by group. The server accepts only these.
- `ios/AgentInterface/AvatarCatalog.swift` is the same catalog for the iOS app.
  `tests/avatar-art-parity.test.ts` writes it, and the answer key that `AvatarArtParityTests` checks
  the app's hand-copied fixed paths against, when run with `UPDATE_AVATAR_ART=1`. Without that it
  fails if either file is stale.

## The face anchor

Each shape has a face anchor (`Face` in `avatar-shapes.ts`). `cx` and `cy` are the middle of the
eye pair, so a mug looks out from its cup and not from the middle of the box. `scale` sizes the
eyes and `spacing` sets them apart. `radius` is nine tenths of the half-width of the part the face
sits on: the face turns on a sphere of that radius, which keeps a turning rocket's eyes on its
hull. `top` and `hat` place the cowboy hat on that part.

The eye sliders reach 150%. Eyes stop growing where the widest style at the chosen width and
spacing would pass the edge of that sphere, so a visor tuned to the limit fills the blob and
shrinks to fit a paint brush. The classic shapes have no `radius` of their own and keep the
blob's 42-unit sphere, as they always have, so on a narrow one such as the capsule an eye tuned
to the limit still slides past the body's edge mid-spin.

The tool measures all of these. Three kinds of shape fool it, and `manifest.json` overrides the
value: a part beside the face at eye level (a bat's wings, a bull's ears, a barbell's plates)
widens `radius`, and ears or horns beside the head widen `hat`.

## Morphing between shapes

Changing shape morphs the body over 280 ms. `src/components/avatar-outline.ts` walks the outside
of each outline into 72 evenly spaced samples, and sample `i` of one shape moves to sample `i` of
the next. The samples are put in one order first: clockwise, starting at the top. Outlines are
drawn from wherever their author began and either way round, and without that step a blob on its
way to a reindeer crossed over itself and shrank to a quarter of the reindeer's size. A hole, such
as a mug's handle, is not sampled; the exact outline takes over when the morph ends. The iOS app
samples and orders the same way in `AvatarGeometry.points`.

Samples are matched by how far round the outline they are, not by where they are, so two very
different shapes can still cross over a little on the way: Rocky to Sprout folds a loop about 2%
of the body's area at the midpoint.

## Adding a shape

1. Make the avatar in the [Open Bot Avatar editor](https://dominikscholz.github.io/open-bot-avatar/)
   or write its JSON by hand, and check it with that project's strict validator.
2. Save it as `.agents/tools/avatar-shapes/definitions/<id>.json` and list it in `manifest.json`.
3. Run `npm install --no-save paper@0.12.18`, then `node .agents/tools/avatar-shapes.mjs`.
4. Add the id to its group in `avatarShapeGroups` in `src/shared/types.ts`. The compiler then names
   anything else that misses it.
5. Look at it in every state, with a hat and with glasses, on `/avatar-specimen/` under
   `pnpm run dev:client`. Override `radius` or `hat` in the manifest if the measurement is off.
6. Run `UPDATE_AVATAR_ART=1 pnpm exec vitest run tests/avatar-art-parity.test.ts`, which rewrites the
   iOS catalog, and commit both files it writes. `tests/avatar-component.test.ts` then checks the
   new shape's eyes sit on its body and `tests/avatar-outline.test.ts` that it morphs to and from
   every other shape without collapsing.

## Retired mascots

Mascots are still stored in Hermes profile metadata, in the app's own store, in rosters saved on
devices, and iOS builds from before the change still save them. `currentAvatar` in
`src/shared/avatar-legacy.ts` reads one as its shape wherever the server or the web reads an
stored avatar, and the iOS app does the same when it decodes one. Color, eyes, accessory and eye
tuning carry over. No migration rewrites stored data. A mascot becomes a shape in storage the next
time the app writes that assistant's avatar or, in the app's own store, its sharing, which rewrites
the whole row.

A save from an older client is stricter than a read. `PUT /bots/:id/avatar` reads a mascot as its
shape only when the family is one of the 18 below and the rest of the avatar is valid; anything
else is refused, as it was before. A reader is lenient instead, because it has to draw something:
a family the app never had is drawn as the blob.

| Mascot     | Shape     | Color                                            |
| ---------- | --------- | ------------------------------------------------ |
| Bear       | bear      | kept                                             |
| Fox        | fox       | kept                                             |
| Sprout     | sprout    | kept                                             |
| Panda      | bear      | kept                                             |
| Raccoon    | fox       | kept                                             |
| Owl        | owl       | kept                                             |
| Cactus     | cactus    | kept                                             |
| Dinosaur   | dino      | kept                                             |
| Leprechaun | clover    | green, unless someone had changed the face color |
| Bunny      | bunny     | kept                                             |
| Eagle      | star      | amber, unless someone had changed the head color |
| Pumpkin    | pumpkin   | kept                                             |
| Bat        | bat       | kept                                             |
| Ghost      | ghost     | kept                                             |
| Turkey     | turkey    | kept                                             |
| Santa      | santa-hat | red, unless someone had changed the face color   |
| Rudolph    | reindeer  | kept                                             |
| Snowman    | snowman   | kept                                             |

Only the six shapes in the Seasonal group bring their season to home outside the calendar's
windows. A converted leprechaun, bunny, eagle or ghost no longer does, because clover, bunny, star
and ghost are everyday shapes that anyone may pick without wanting seasonal chrome all year.

## Releasing it

Deploy the server first, then release the iOS build as soon after as you can. Neither order is
seamless, and this one loses nothing:

- **Server first.** An iOS build from before the change draws a shape it does not have as the
  blob, so until it updates it shows new shapes and converted mascots that way. It still saves:
  the server reads a mascot it sends as its shape, and it sends a shape it does not know back
  unchanged.
- **iOS first.** The new build draws everything, because it reads mascots from an older server
  itself. But it saves a converted mascot as its shape, and the older server refuses 34 of the 54
  shapes, so those avatar saves fail until the server is deployed.

A page still running an older web bundle also draws shapes it does not have as the blob. It
refuses to keep a home with a shape it does not know, so it discards its saved copy and its next
launch waits for the server instead of drawing home at once. The copy is saved again once the page
has the new bundle, which keeps shapes it does not know.

## License of the Open Bot Avatar definitions

```text
MIT License

Copyright (c) 2026 Dominik Scholz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
