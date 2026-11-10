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
  now meets every conditioned rule for the same selector, except a conditioned rule later in the same file, which
  is an override such as a phone variant.
- `tests/motion-css-order.test.ts`: no stylesheet other than the ones `main.tsx` imports before `motion.css` sets a
  property, by shorthand family, that the motion layer sets on the same selector under an overlapping motion
  setting and condition. The five dark-mode depth entries are the expected list, so the follow-up empties it.

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
