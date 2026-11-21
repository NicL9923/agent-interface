# November 21 shared solid bubble fill

Code state: the working tree on top of `af8d1c38` on `t3/sync-solid-fills-group-bubbles`, before
its first commit. Node v24.22.2. Hermes did not take part; the browser checks use the e2e server
and its fixtures.

The web filled a person's solid bubble with `oklch(from var(--bot-tint) min(l, 0.52) c h)` and let
the browser fit the result into sRGB, which gave `#0062DA` for `#1084FE`. iOS computes `#0066CA` in
`SolidBubble.fill`. `solidFill` in `src/app/bot-tint.ts` now ports the iOS steps, `tintProps` sets
the result as `--solid-fill`, and `src/motion.css` paints that value. The solid rules left the
`@supports (color: oklch(from red l c h))` block, because they no longer use a relative color.

`ios/AgentInterfaceTests/Vectors/solid-bubble.json` holds 16 cases: the nine avatar colors, a
three-digit hex, an already dark color, a gray, pure blue, white, black and a value that is not a
color. The expected fills come from the port, checked against the two known values: the port gives
`#0066CA` for `#1084FE`, and the old CSS gives `#0062DA` in red run E1 below. The closest any
vector's channel comes to a rounding tie is 0.012 of a byte (`#FF6700`'s red channel, 172.488 before
rounding), so a last-digit difference between JavaScript's and Swift's math cannot change a byte.

## Checks

| Check                                                                           | Result                      |
| ------------------------------------------------------------------------------- | --------------------------- |
| `tests/solid-bubble.test.ts`, `tests/motion-logic.test.ts`                      | Unit-passed: 22 tests       |
| `e2e/accessibility.spec.ts -g solid`, Chromium                                  | Runtime-exercised: 3 passed |
| `e2e/accessibility.spec.ts -g solid`, WebKit in the Playwright 1.65.0 container | Runtime-exercised: 3 passed |

## Red runs

Each broken line was restored from a saved copy, and the app rebuilt, before the green runs above.

| Break                                              | Result                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| R1. `largestChromaInGamut` returns the full chroma | Failed as intended: 7 vectors                                                  |
| R2. A three-digit hex is not expanded              | Failed as intended: the three-digit vector                                     |
| R3. The lightness cap is 0.53                      | Failed as intended: 11 vectors                                                 |
| R4. The contrast step-down never runs              | Passed. See below                                                              |
| R5. The `#FF9800` vector is removed                | Failed as intended: "has a vector for every avatar color"                      |
| R6. `solidFill` skips the hex check                | Failed as intended: the not-a-color vector                                     |
| E1. The CSS paints the old relative color          | Failed as intended in both themes: received `#0062DA`                          |
| E2. `tintProps` leaves out `--solid-fill`          | Failed as intended in both themes: received `#000000`                          |
| E3. The solid bubble's file link rule is removed   | Failed as intended in both themes: the link edge is not white at half strength |

R4 survives because no sRGB color reaches the step-down. On a grid of every 17th value per channel
(4,096 colors), the lowest white contrast on a fill at the first lightness is 5.11:1, for `#11AA33`.
The loop stays as a guard and to keep the two ports step for step.

The new browser test turns the service worker off. WebKit cannot route a request the worker makes,
and the test changes the bootstrap answer to give the seeded assistant a drawn avatar and the solid
preference.
