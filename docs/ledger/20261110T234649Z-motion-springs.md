# November 10 the motion layer's entrance springs in the built app

Branch `t3/motion-springs` from `origin/main` at `145104f`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores),
Node 24.22.2, Chromium from Playwright 1.64.1. Follows `20261110T171622Z-avatar-motion.md`, which listed four
selectors animated by two rules and left them for this change.

## What the built app ran

`dist/client/index.html` links Avatar, reply-cards, main-assistant, MessageMarkdown, DeviceNotifications,
collaboration, index, home, shell. `index` holds `styles.css` and then `src/motion.css`. On the dev server App's
imports run before `main.tsx` imports `styles.css` and `motion.css`, so `home.css` and `shell.css` load first there.
At equal specificity the later sheet wins, so the two disagree.

`node .agents/tools/sample-entrance-animations.mjs`, Chromium 900 x 700, each class on a bare element after sign-in.
`main` is the four stylesheets from `origin/main` built in this worktree; the branch is this commit.

| Selector | `main`, production | `main`, dev | Branch, production and dev |
| --- | --- | --- | --- |
| `.bot-menu` | `bot-menu-in` 0.14s `ease-out` | `bot-menu-in` 0.26s soft spring | `bot-menu-in` 0.26s soft spring |
| `.dock-item` | `dock-in` 0.2s `cubic-bezier(0.2, 0.8, 0.2, 1)` | `dock-in` 0.38s spring | `dock-in` 0.38s spring |
| `.toast` | `toast-in` 0.2s same curve | `toast-in` 0.42s spring | `toast-in` 0.42s spring |
| `.jump-latest` | `jump-latest-in` 0.42s spring | same | same |
| `.command-palette[open]` | `palette-in` 0.16s same curve | `palette-in` 0.32s soft spring | `palette-in` 0.32s soft spring |
| `.settings-sheet[open]` | `settings-in` 0.22s same curve | `settings-in` 0.38s soft spring | `settings-in` 0.38s soft spring |
| All six, reduced motion | `none` | `none` | `none` |

The branch's production JSON equals `main`'s dev JSON value for value, including opacity and transform at 0 to
420 ms. At 390 px wide, the phone layout, the palette and settings sheet run `palette-up` 0.22s and `settings-up`
0.26s ease-out from the bottom before and after, and `none` under reduced motion. The other four match the table.

## Decision: the motion layer's springs, for all six

- `fd589e4` (#261) added the springs with "Spring easings replace the shared ease-out on small pops", and
  README's "Motion and ambience" says the layer loads after the others and is the motion. The base rules are older
  (`1206bf9`, `bcaa7e4`, `4b118d7`). The layer's own comment keeps ease-out for sheets that rise from a screen edge,
  and the phone sheets keep theirs.
- `.jump-latest` already ran the spring in production, and `.message-outgoing` was settled the same way in #324.
- The spring's overshoot is small at these sizes: the toast rises 10 px and passes its rest by 1.13 px at 140 ms,
  the menu's scale peaks at 1.0007, and the jump button passes by 0.9 px. Frames of the real menu and undo toast,
  paused at 40, 140 and 260 ms, looked settled and clean. None reads as a wobble, so no base rule is kept.

Change: the base `animation` declarations on `.bot-menu` (`home.css`), `.dock-item` and `.toast` (`shell.css`),
`.jump-latest` (`styles.css`), and the unconditional ones on `.command-palette[open]` (`shell.css`) and
`.settings-sheet[open]` (`home.css`) are gone. So are the reduced-motion `none` rules for the first four, which
cancelled only those. The phone variants and their reduced-motion `none` stay. Six keyframes that only the motion
layer now uses moved into `src/motion.css`, as `message-send` did.

## Same defect class beyond the four

A scan of every declaration in `src/motion.css` against every other stylesheet, same selector, same property or
shorthand family, overlapping motion setting and screen condition:

- `.command-palette[open]` and `.settings-sheet[open]` animations: the desktop springs sit under
  `min-width: 621px`, and the unconditional base rules in `shell.css` and `home.css` beat them in production. The
  existing test missed them because it treated any difference in conditions as a different screen. Fixed here.
- Dark mode depth, not fixed here: the lit top edge on `.bot-menu`, `.home-new-menu`, `.settings-sheet` and
  `.command-palette` and the rail grain on `.bot-rail`. Read in Chromium with a dark color scheme, production
  computes `box-shadow` without the `inset 0 1px 0` edge and `background-image: none` on the rail. Dev has both.
  `home.css` and `shell.css` restate the same `box-shadow`, and `home.css`'s `.bot-rail { background: var(--rail) }`
  resets the image. That is a visual change of its own, so it is a follow-up and the new guard lists it.
- Not this defect: `src/motion.css`'s shared `.jump-latest { box-shadow: inset … }` replaces the button's
  `0 6px 22px` drop shadow from `styles.css` in dev and production alike, so the jump button has no drop shadow.
  Worth a look as its own follow-up.

## Tests

- `tests/helpers/css-declarations.ts`: the block scanner from `tests/css-keyframes.test.ts`, moved so two files
  share it, plus `conditionsOf` and `conditionsMeet`.
- `tests/css-keyframes.test.ts`: the known list is gone. A rule with no media, container or supports condition
  meets every conditioned rule for the same selector, and so do two different conditions unless the helper lists
  them as complementary, except a conditioned rule later in the same file, which is an override such as a phone
  variant. The list holds one pair, `(max-width: 620px)` and `(width > 620px)`.
- `tests/motion-css-order.test.ts`: no stylesheet other than the ones `main.tsx` imports before `motion.css` sets a
  property, by shorthand family, that the motion layer sets on the same selector under an overlapping motion
  setting and condition. The five dark-mode depth entries are the expected list, so the follow-up empties it. Each
  entry carries the count of the other sheet's declarations, so a second one on a listed selector fails.

### Red proof

Each break made by hand with a script that restores the files after; the two test files run each time.

| # | Break | Result |
| --- | --- | --- |
| 1 | `.bot-menu`'s 140 ms base animation back in `home.css` | red in both: `no-preference \| .bot-menu`, and `.bot-menu animation: src/app/home.css` |
| 2 | `.dock-item`'s base back in `shell.css` | red in both |
| 3 | `.toast`'s base back in `shell.css` | red in both |
| 4 | `.jump-latest`'s base back in `styles.css` | red in the keyframe test; the order test trusts `styles.css`, as designed |
| 5 | `.command-palette[open]`'s unconditional base back in `shell.css` | red in both, against `src/motion.css` under `min-width: 621px` |
| 6 | `.settings-sheet[open]`'s unconditional base back in `home.css` | red in both |
| 7 | Break 5 with `conditionsMeet` reduced to equality | green, so the unconditioned-meets-all rule is what catches 5 |
| 8 | `.jump-latest { box-shadow: none }` added to `shell.css` | red: `.jump-latest box-shadow: src/app/shell.css` |
| 9 | `.app-shell { background: … }` added to `home.css`, against the layer's `background-color` and `background-image` | red |
| 10 | Break 9 with `family` returning the property unchanged | red only for the known `.bot-rail background` entry going missing; 9 is no longer caught, so the family map is what catches both |
| 11 | The layer's `.bot-rail` grain removed | red: the known entry is stale |
| 12 | `main.tsx` imports `motion.css` before `styles.css` | red: the trusted list, and four `styles.css` overlaps |
| 13 | A reduced-motion `.toast` animation added to `shell.css` | green: the layer's `.toast` is motion-allowed only |
| 14 | `.toast` base plus a later phone-width variant in `shell.css` | red, both against the layer's rule; the two `shell.css` rules are not paired |
| 15 | The phone variant placed before the base | red, including the `shell.css` pair: the base hides the variant |
| 16 | Two unconditional `.toast` rules in `shell.css`, the layer's removed | red: the pair |
| 17 | The layer's `.toast` removed, base plus a later phone variant | green |
| 18 | Break 17 with the same-file override exemption removed | red: the pair, so the exemption is what keeps 17 green |

## Checks

`npm ci` once. `npm run typecheck`, `npm run lint` passed. `ruff check .` (ruff 0.17.3): all checks passed.
`npm test`: 196 files, 3,273 tests passed. `npm run build` passed. `npm run test:e2e`: 24 passed in Chromium.
Safari, Firefox and a real phone: not run.

## Review fixes

A cross-provider review of `4f420e1` found seven things. Each is below with its change and its proof.

1. **The reduced-motion gate had no test.** Moving `.toast`'s spring out of the `no-preference` block left both CSS
   tests green. `tests/css-keyframes.test.ts` now requires every `animation` or `animation-name` in `src/motion.css`
   to apply only under `no-preference`, with two named exceptions, each asserted to still be in use:
   `.chat-header-identity` (`header-lift` follows the transcript's scroll offset, not time, and only fades a border,
   color and shadow in; nothing translates or scales) and the phone navigation's `::view-transition-old/new(root)`
   (`data-navigation` is set only while a view transition runs, and `canMorph` in `navigation-morph.ts` starts none
   under reduced motion). The `.message-outgoing` test stays, since it also looks at every other sheet.
2. **Two different conditions were taken as different screens.** `conditionsMeet` now treats any two different
   conditions as overlapping unless the pair is in `complementary` in `tests/helpers/css-declarations.ts`. With
   the list empty the guard also reports `.bot-rail position` and the palette and sheet pairs, so the width pair
   is the only entry and no expected entry was added.
3. **The 620 to 621 px gap.** `src/motion.css` now uses `(width > 620px)` for the desktop palette and Settings
   springs and for `.bot-rail { position: relative }`, which had the same `min-width: 621px` gap. The built CSS
   already carries range syntax: Vite 8's minifier turns the app's `(max-width: 620px)` into `(width<=620px)`, and
   Tailwind v4 needs Safari 16.4 or newer, which is also where range syntax arrives (Chrome 104, Firefox 63).
   Chromium and Firefox round a viewport's width to whole pixels for media queries, so 620.3 and 620.6 px cannot
   be reached in either. An iframe 620.3 px wide reports 620 and the phone rules; 620.6 px reports 621 and the
   desktop ones. A container 620.297 and 620.594 px wide does compare fractionally in Chromium, and shows the gap:
   `max-width: 620px` and `min-width: 621px` both miss both widths, while `max-width: 620px` and `width > 620px`
   cover them. A browser with fractional viewports, such as Safari under page zoom, is where the gap could show.
   Not run there. `src/components/artifacts.css:77` keeps its `(max-height: 520px) and (min-width: 621px)`, a layout
   rule outside this change.
4. **A new collision on a listed selector hid in the expected list.** Each entry now ends in `xN`, the count of
   the other sheet's declarations. `.bot-rail background` is `x2`: the base `background: var(--rail)` and the phone
   layout's `background: var(--surface)`.
5. **The dock item's top border was clipped at peak overshoot.** `.composer-area > .status-dock` has
   `overflow-y: auto`, and the livelier spring passed rest by 0.74 px at 114 ms. `.dock-item` takes the soft spring.
   A `.dock-item` holding a `.notice` with a 1 px `#c00` border, in a real `.status-dock` in the open chat, paused:

   | Frame | Item top vs the dock's top edge | Top border row, in pixels |
   | --- | --- | --- |
   | Livelier spring, 114 ms (before) | -0.744 px | `#f2bfbf`, about a quarter of the red |
   | Soft spring, 114 ms | +0.845 px | whole, below the edge |
   | Soft spring, its peak near 200 ms | -0.103 px | `#d11b1b`, within a few percent of `#cc0000` |

   The clip is not zero, but a tenth of a pixel is not visible.
6. `tests/helpers/css-declarations.ts` names `tests/motion-css-order.test.ts`.
7. **Fallback wording.** Without `linear()` support the soft spring is the app's `cubic-bezier(0.2, 0.8, 0.2, 1)`
   ease-out, and the livelier one is `cubic-bezier(0.34, 1.4, 0.64, 1)`, about 5% overshoot. The comment in
   `src/motion.css` said both fell back to ease-out; it now says what each does, and README's "Motion and ambience"
   says it too. No other file made the claim.

### Red proof for the review fixes

Same method as above, by script, the two test files run each time and the file restored after.

| # | Break | Result |
| --- | --- | --- |
| 19 | `.toast`'s spring moved outside the no-preference block | red: `src/motion.css:342 animation: toast-in 420ms var(--ease-spring)` |
| 20 | A `prefers-reduced-motion: reduce` `.toast` animation added to the layer | red, same test |
| 21 | The `header-lift` animation removed | red: the `.chat-header-identity` exception is unused |
| 22 | `@media (min-width: 1000px) { .settings-sheet[open] { animation: settings-in 220ms ease-out; } }` in `home.css` | red in both: the pair against `src/motion.css:247 [@media (width > 620px)]`, and `.settings-sheet[open] animation: src/app/home.css x1` |
| 23 | The complementary list emptied | red in both: the palette and sheet pairs against `(max-width: 620px)`, and `.bot-rail position: src/app/home.css` |
| 24 | The palette and sheet back to `(min-width: 621px)` | red in both, so the gap form cannot return unnoticed |
| 25 | A second `box-shadow` on `.bot-menu` in `home.css` | red: `.bot-menu box-shadow: src/app/home.css x1` became `x2` |

Break 22 on the reviewer's exact rule was green before the change. Finding 5 has no test: a test pinning
`--ease-spring-soft` on `.dock-item` would assert a constant, and the paused-frame table above is the evidence.

### After the fixes

`node .agents/tools/sample-entrance-animations.mjs` on the production build, Chromium 900 x 700, motion allowed.
Production and `MODE=dev` JSON are equal value for value. Samples are the paused animation's transform.

| Selector | Animation | Curve | 0 ms | 80 ms | 140 ms | 200 ms |
| --- | --- | --- | --- | --- | --- | --- |
| `.bot-menu` | `bot-menu-in` 0.26s | soft spring | scale 0.96 | 0.9948 | 1.0007 | 1.0003 |
| `.dock-item` | `dock-in` 0.38s | soft spring (was livelier) | y 6 | 2.11 | 0.31 | -0.10 |
| `.toast` | `toast-in` 0.42s | livelier spring | y 10 | 0.62 | -1.13 | -0.18 |
| `.jump-latest` | `jump-latest-in` 0.42s | livelier spring | y 8 | 0.50 | -0.90 | -0.15 |
| `.command-palette[open]` | `palette-in` 0.32s | soft spring | y -8, scale 0.98 | -1.96, 0.9951 | -0.03, 0.9999 | 0.13, 1.0003 |
| `.settings-sheet[open]` | `settings-in` 0.38s | soft spring | y 16, scale 0.98 | 5.62, 0.9930 | 0.83, 0.9990 | -0.27, 1.0003 |
| All six, reduced motion | `none` | | | | | |

At 390 px the palette and settings sheet still run `palette-up` 0.22s and `settings-up` 0.26s ease-out, and `none`
under reduced motion; the other four match the table.

### Checks after the fixes

`npm ci` (real), then `npm run typecheck`, `npm run lint` passed. `ruff check .` (ruff 0.17.3): all checks passed.
`npm test`: 197 files, 3,299 tests passed. `npm run build` passed. `npm run test:e2e`: 24 passed in Chromium. Merged
`origin/main` at `785f4f2` first. Safari, Firefox and a real phone: not run for the app; Firefox only for the
integer rounding of an iframe's width.
