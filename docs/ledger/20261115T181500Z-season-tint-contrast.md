# November 15 seasonal accent contrast

Branch `t3/season-tint-contrast` from `origin/main` at `b7665369`, source fingerprint
`sha256:6439bcfa13941d522d1fb525c8c97bc29ebdab3c4ec067ab6202ce1da068b744` before this entry, on the Mac mini with
Node 24.22.2 and Playwright's Chromium. Nothing was deployed by this entry.

## Change

PR #413 cut home's seasonal accent shift from 12% (18% for the soft fill) to 4% so the accent kept 4.5:1 against
its soft fill, which left the season barely visible. The shift is back at 12% and 18%, but each seasonal color now
keeps its base token's WCAG luminance, so no contrast ratio falls below the unseasoned theme's.
`.agents/tools/season-tint.mjs` computes the colors from the theme tokens and season colors and writes them into
`src/motion.css` as `light-dark()` pairs. Browsers without `light-dark()` keep the 4% mix.

## Red runs

| Break | Test | Failure |
| --- | --- | --- |
| Generator: light accent rounded lighter instead of darker | `tests/season-tint.test.ts` | stale-block check and `keep every light contrast at or above the unseasoned theme's` failed |
| `src/motion.css`: harvest light accent hand-edited to `#4e7a60` | `tests/season-tint.test.ts` | stale-block check failed |
| `src/motion.css`: generated block removed, plain mix back at 88% and 82% | `e2e/accessibility.spec.ts` seasonal sweep, light and dark | axe `color-contrast` in the rail for winter, the first season scanned |

Each file was restored from a copy and the tests passed again.

## Not exercised

- Safari and WebKit. The sweep runs in Chromium; `light-dark()` has shipped in Safari since 17.5.
