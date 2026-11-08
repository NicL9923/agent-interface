# Home and context menus recheck

Reviewer: Claude Opus 5.5, high effort. The implementer was OpenAI GPT-6.1 Sol, so this review is cross-provider.
Scope: the delta from `03-home-input.patch` to `04-home-input.patch`, plus the callers it affects. That covers the `Sidebar.tsx` row meta, the `home.css` pinned grid, tap highlight and menu focus rules, `context-menu.tsx` portal stacking, the `RootView.swift` pinned tile, row frame and `UnreadDot`, the new submenu capture in `ScreenshotTourTests.swift`, and `.agents/tools/check-home-touch.js`. Today and everything that `03-home-review.md` settled were not reviewed again.
Evidence: every current `after/web-home-*.png`, `after/ios/home-*.png` and `after/ipad/home-*.png`, plus `home-touch.json`. Collages and crops are in `reviews/04-collages/`.
Not performed by me: tests, builds and live interaction. I took the reported passing runs (`ios-home-v2.log`, `ipad-home-v2.log`, the 104 focused web tests and the production build) as given. Both logs end in `TEST EXECUTE SUCCEEDED`.

## Scores

| Surface | Score | Gate |
| --- | --- | --- |
| Web Home | 9/10 | Passes |
| Web Home context menus | 9.5/10 | Passes |
| Native Home (iPhone and iPad) | 9/10 | Passes |
| Native Home context menus | 9.5/10 | Passes |

No blockers remain. Each surface meets the bar of 9 or higher with no obvious remaining issues.

## Prior blockers

| Blocker | Status | Evidence |
| --- | --- | --- |
| Web 1. The unread dot detached from the date | Resolved | `.bot-row-meta` groups the dot with the date. Narrow shows "Kitchen / companion • 9:12 PM". At 200% the "• 9:12 PM" pair wraps under the name as one unit. |
| Web 2. Single-column pinned tiles reserved an empty line | Resolved | `min-height` is gone. With `li { display:flex }`, the trigger renders the `Button` directly, so `.pinned-copy { flex:1; grid-template-rows:1fr auto }` stretches to the row height. Phone "Working" and "Thinking" share a baseline. At 200%, "Ranch hand" sits directly above "Working". |
| Web 3. Blue focus ring on the keyboard-opened menu | Resolved | `desktop-menu` shows a 2 px green accent outline. In `desktop-submenu` the trigger keeps the app's standard button focus ring. |
| Native 1. AX rows hugged their content and centered | Resolved | The text `VStack` now has `.frame(maxWidth: .infinity, alignment: .leading)`. In `home-large-text-scrolled` the text columns start at the same x for every row, and the tap area spans the full row again. |
| Native 2. Pinned tiles misaligned | Resolved | `GridItem(alignment: .top)` plus `lineLimit(2, reservesSpace: true)` outside AX sizes. iPhone loaded and dark, and iPad loaded, show aligned avatars and status lines. AX sizes stack one tile per column with no reserved line. |
| Should fix: AX pin badge | Resolved | Capped at 13 pt. It is now proportionate on the 92 pt AX avatar. |
| Should fix: native submenu coverage | Resolved | `home-submenu` is captured on iPhone and iPad. Both show the system submenu with a checked "Around the house". |
| Should fix: web touch coverage | Resolved | `web-home-touch-menu.png` comes from a CDP `touchStart` long-press. `home-touch.json` reports the menu open with home still visible, and the outside tap lands on the Base UI backdrop. |

## Portal stacking fix

The fix is correct, and the change is small and safe.

- In Base UI 1.9.0, `MenuPositioner` renders `InternalBackdrop` as a sibling of the positioner (`menu/positioner/MenuPositioner.js:238`). The backdrop is `position: fixed; inset: 0` with no z-index, and it has no cutout for context menus. `Menu.Portal` forwards `className` to its own `div` through `useRenderElement` (`FloatingPortal.js:60`).
- Before the fix, the backdrop sat in the root stacking context at `z-index: auto`. On phones `.bot-rail` is `position: fixed; z-index: 10` (`home.css:570`), so the rail painted over the backdrop. Outside taps then reached the rows and opened assistants. Making the portal `relative z-30` creates one stacking context that holds both the backdrop and the positioner, above the rail. That stacking context is still below the toast region at z-index 40.
- Desktop behavior does not change. The sidebar has no z-index there, so the backdrop was already on top.
- Inside a dialog, the portal uses the dialog's overlay container, so the menu still stacks within the dialog.
- `position: relative` on an empty portal `div` that already existed has no layout effect.
- The only consumer is `BotMenu` in `Sidebar.tsx`, for both the root and submenu content.

## New issues in touched code

None that block.

- `-webkit-tap-highlight-color: transparent` removes the grey flash. Touch feedback stays because `button:active:enabled` (`styles.css:80`) still applies, and a tap navigates right away.
- Screen readers announce the moved `UnreadMark` "Unread" after the name and before the time. That order is fine.
- `UnreadDot` uses `@ScaledMetric` capped at 12 pt. At AX3 it now reads as a deliberate bullet instead of a period.

## Not blocking

1. **The iPad AX "scrolled" capture is not scrolled.** This line is new in this diff. `after/ipad/home-large-text-scrolled.png` matches `home-large-text.png` except for the clock. `app.swipeUp()` in `testHomeDesignReview` (`ScreenshotTourTests.swift`, the `size.contains("Accessibility")` line) swipes the middle of the screen, which on iPad is the conversation pane. So the lower iPad sidebar rows at AX sizes have no capture. The row code is shared and covered by the iPhone AX scrolled capture and the iPad default capture, so this is an evidence gap, not a product defect. Fix: swipe the home list element, for example the scroll view that contains `bot.kitchen`, instead of `app`.
2. **Native AX unread dot alignment (polish).** The dot's bottom sits on the first text baseline, slightly lower than the "• Working" status bullets. It reads clearly as an unread marker at its new size. Centering it on the first line's cap height with an `alignmentGuide(.firstTextBaseline)` would be a nicety.
3. **iPad AX sidebar (accepted earlier).** "compan-ion" still hyphenates in the narrow split column. This was accepted in 03 and is unchanged.

## Verdict

Home passes on web and native, including iPad, at 9 or higher for both the screen and its menus. Proceed to the next screen. Item 1 above is a one-line test fix worth folding into the next capture pass.
