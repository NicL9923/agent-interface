# November 11 the motion layer's depth styles apply in the built app

Branch `t3/motion-cascade-depth` over `origin/main` at `acec071`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2,
Playwright's full Chromium. Web client styles, one guard test, one e2e spec and one tool; no server, Hermes add-on or iOS
code changed, and no file on `src/shared/qualification-inputs.json` is touched.

## What main did

The build links `home.css` and `shell.css` after `index.css` (which holds `styles.css` and `motion.css`); the dev server
loads every component sheet before it. A same-specificity rule in one of those sheets therefore won in the build and lost
on the dev server. `tests/motion-css-order.test.ts` listed five such collisions, and Settings had two more between
`home.css` and `device-notifications.css` that no selector check can see, because their selectors differ.

## Measured before and after

`.agents/tools/diff-computed-styles.mjs` (new): the computed style of every element on home, the assistant and account
menus, Settings, the command palette and a chat, light and dark, build against the Vite dev server, motion reduced,
transitions off. Differences per run, at 900 px and at 390 px (identical both times):

| | main | this branch |
| --- | --- | --- |
| differing lines | 70 | 0 |
| light | `box-shadow` on `.bot-menu`, `.home-new-menu` (account menu), `.settings-sheet`, `.command-palette`; Settings `p.muted` font-size 12px (build) / 13px (dev), margins 6px 0 0 / 7px, `label.notification-toggle` gap 10px / 9px, and the heights and widths they move | none |
| dark | the same, plus `aside.bot-rail` `background-image` none (build) / the grain (dev), on every screen | none |

`.agents/tools/sample-entrance-animations.mjs`, build and dev, motion allowed and reduced: byte-identical before and after
(this change touches no animation), and the build equals dev in both.

## Decisions

- Box-shadow on `.bot-menu`, `.home-new-menu`, `.settings-sheet`, `.command-palette`: dev's value, the lit edge over the
  drop shadow, is intended (README "Motion and ambience", `motion.css` header). `motion.css` already carried the whole
  value, so the duplicates in `home.css` and `shell.css` are deleted and the layer is the only sheet that sets it. The
  edge is `transparent` in light, so light is unchanged on screen.
- The rail's grain: `home.css` set the `background` shorthand, which reset `background-image`. It now sets
  `background-color`, in the base rule and the phone layout's. The grain therefore shows on the phone rail in the build,
  as it already did in dev.
- `.jump-latest`: the shared edge rule replaced its drop shadow in both builds (not a dev/build difference, a loss in
  both). It has its own rule with the edge and the drop shadow, as `.composer` does, and leaves the shared list; the
  shared rule keeps only `.approval-card` and `.today-attention-list`, which have no shadow of their own. The other five
  selectors that sat in that list also have their own rule, so their entries were dead and went.
- `artifacts.css`: `(min-width: 621px)` becomes `(width > 620px)`, which closes the gap at fractional widths between 620
  and 621 px, as `#331` did elsewhere.
- Settings notification row: not dev's values. The build's 12px help text and 10px toggle gap are the Settings-scoped
  overrides written in `1206bf9` ("Redesign web home and settings"), together with its row-only restyling of the same card
  (`margin: 0; padding: 0; border: 0`, hidden switch thumb); dev showed the card's own 13px and 9px only because its sheet
  loaded later. Those rules now name `.notification-settings` too (specificity 0,3,0 and 0,2,1 against the card's 0,2,0 and
  0,1,1), so they win in both orders. This differs from "make the build match dev"; if 13px and 9px are wanted, delete
  the three rules instead.

## Guards

- `tests/motion-css-order.test.ts`: the expected list is empty. The family check now treats `background-color` and
  `background-image` as independent longhands, so the `background` shorthand collides and the pair does not. New: the
  lit-edge rule may list only selectors no other sheet gives a shadow; no stylesheet uses `min-width: 621px`.
- `e2e/stylesheet-order.spec.ts` (new, about 40 s): each screen above is read as built, in the dev server's order (every
  component sheet before `index.css`) and with the component sheets reversed, light and dark, and every computed value
  must match. The reversed order is the one that sees Settings' two differing selectors. Values that differ between two reads
  of the same order (content still arriving) are ignored, and a generated SVG ID is normalized. A second test keeps the jump
  button's drop shadow under the dark edge.

## Red runs

Each protecting line broken by hand, the guard run, the line restored.

| Broken | Result |
| --- | --- |
| `box-shadow` back on `.bot-menu` in `home.css` | motion-css-order: "leaves each property it sets on a selector to it alone" red |
| `box-shadow` back on `.command-palette` in `shell.css` | the same test red |
| `.bot-rail` base `background-color` back to `background` | the same test red |
| phone `.bot-rail` `background-color` back to `background` | the same test red |
| the longhand rule removed from `overlap` | the same test red (rail color against grain) |
| `.jump-latest` back in the shared edge list | "lists in the lit-edge rule only selectors no other sheet gives a shadow" red |
| `(min-width: 621px)` back in `artifacts.css` | "pairs the phone layout's width with a range that has no gap" red |
| all of main's four CSS files restored | stylesheet-order e2e red, light and dark: palette, menus and Settings `box-shadow`, rail `background-image` |
| Settings' three rules back to their short selectors | stylesheet-order e2e red, light and dark: `p.muted` font-size 12px -> 13px, the toggle's gap and the sizes they move |
| `.jump-latest`'s own rule removed, then cut to the edge alone | jump-button e2e red: `rgba(0,0,0,0.14) 0px 6px 22px` without an inset, then the inset without the drop |

## Checks

`.agents/tools/check-all` at the commit, 6m41s total (py ran because the diff touches a file the Python tests read):

```
check      result  queued  run    counts
typecheck  pass    -       0.5s   -
lint       pass    -       0.2s   -
ruff       pass    -       0.0s   -
test       pass    -       14.4s  205 files, 3647 tests
build      pass    -       1.3s   891 modules
e2e        pass    -       2m06s  43 tests
py         pass    -       4m17s  45 files
```

## Not exercised

No phone or iOS device. The grain on the phone rail was read as a computed value at 390 px, not looked at on a screen.
