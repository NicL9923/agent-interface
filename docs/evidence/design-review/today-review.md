# Today recheck 2

Reviewer: Claude Opus 5.5, effort high. Independent cross-provider recheck of GPT-6.1 Sol fixes. No implementation edits, builds, browser sessions or subagents.
Date: 2026-10-25. Worktree `t3-d1b42c2a`, branch `nic/full-app-design-review`, uncommitted diff on `383bde4`.

Scope: fixes since `01-today-review.md` only. Read `TodayPanel.tsx`, the Today rules in `experience.css`, the `ChatHeader.tsx` class hook, `TodayView` in `ExperienceViews.swift`, the `DebugFixtures.swift` design transport, `testTodayDesignReview`, the `ExperienceFlowTests` copy change, the new web tests, the `partial` branch of `capture-design.js`, and `src/server/experience.ts:110-121` for the real error shape. Viewed all 13 `after/web-today-*.png`, all 9 `after/ios/today-*.png` and both `after/ipad/today-*.png` as collages in `review-collages/recheck/`. Logs checked: `web-tests-v2.log`, `today-tests.log`, `web-build.log`, `ios-today-v2.log`, `ipad-today.log`.

## Gate

| Target | Score | Gate |
| --- | --- | --- |
| Web | 9.2/10 | Met. No obvious remaining issues. |
| Native iPhone | 9.1/10 | Met. No obvious remaining issues. |
| Native iPad | 9.1/10 | Met for the loaded state. |

Today passes. Move to the next screen.

## Prior blockers

### B1. Resolved on both platforms

- Web `attention` and native `attention()` now include `item.error`. `active()` still excludes it, so a disconnected assistant appears once.
- The row shows the server message as its title, "Trail guide · Disconnected" with the reason in `--danger` / `Palette.danger`, and the verb "Reconnect". Tapping opens the bot.
- The bottom note now counts only `unavailableBots` ids with no errored item. The server always sends an item for each unavailable id, so in practice the note never shows. That is the intended fallback.
- `capture-design.js` now builds the real server shape: `disconnected` state, the exact error string, cleared approvals and attention, and a matching `unavailableBots` id. It clicks the Disconnected row and waits for `?bot=guide`. The native tour taps `today.bot.guide` and waits for the Trail guide chat header. `ios-today-v2.log:681` shows that test passed.
- Web test "keeps disconnected assistants named and opens their conversation to reconnect" checks the count, title, meta, verb and `onOpen("ranch")`. It can fail.
- Screenshots: `web-today-partial.png` and `ios/today-partial.png` both show the row in the first viewport with "3 need you".

### B2. Resolved on both platforms

The summary now counts the deduplicated `working` list. Every loaded capture says "1 at work", and Up next lists only Garden planner. The new web test asserts "1 at work" with Ranch both pending and working.

### B3. Resolved

- `testTodayAcknowledgesEachReturnedPageWithoutDroppingLateImports` passed (`ios-today-v2.log:371`).
- Large text now uses `UICTContentSizeCategoryAccessibilityXL`, which is AX3. Main and scrolled captures show no clipping. The verb moves under the meta, and the summary stacks.
- `today-loaded-scrolled.png` shows Up next and Recent files at the default size.
- Partial, stale-error and loading captures exist and come from real transport states. Loading leaves the request pending. Stale returns a 503 on the second read.

## Prior non-blocking items

- 1, header subtitle: kept on purpose. I accept the reasoning. Today's state is visible in the summary row one line below, and moving the resource into App only for a subtitle adds coupling.
- 2, empty "Mark caught up": kept on purpose. I accept it. Marking an empty page still advances `since` and the frontier, and an existing test depends on that.
- 3, "Up next" label: unchanged. The meta line names the state, so this remains a taste call.
- 4, live region and group: fixed. The timestamp has `role="status"` only before data arrives. The summary has `role="group"`.
- 5, focus ring: fixed. `outline-offset: -3px` with a 10px radius keeps the ring inside the card in `web-today-keyboard-focus.png`.
- 6, dividers: fixed. They start at `left: 48px`, which is 36px avatar plus 12px gap, and line up with the text on desktop, phone and 320px.

## New observations

None of these blocks the gate.

1. **L, copy. The disconnected title and verb repeat each other.** "Could not read this Hermes conversation. Open it to reconnect." sits beside a "Reconnect" button. It also names the backend, "Hermes", in a family-facing UI. The string comes from `src/server/experience.ts:110`, and using it unchanged was a deliberate choice. If the server copy is revisited later, "Couldn't reach this assistant" or "Lost connection to this conversation" would read better next to the verb. This is optional.
2. **L, native test coverage.** Native coverage for opening a disconnected assistant lives only in `testTodayDesignReview`. That test skips unless `AGENT_INTERFACE_DESIGN_TODAY_PATH` is set, so routine native runs don't exercise it. Web has a real unit test. Consider a small `ExperienceFlowTests` case that uses the fixture transport. This is optional.
3. **Evidence note.** `after/web-today-large-text.png` is dated 22:53:01. The final Today source edits are dated 22:56:09, and the other web captures are dated 22:57:53 or later. `capture-design.js` does not produce that file. The later CSS changes use fixed pixel values for dividers and focus that don't change text layout, and the earlier review accepted this layout. I don't need it recaptured for this gate. Regenerate it if a later diff touches Today type or spacing.
4. **iPad.** `today-loaded.png` and `today-loaded-scrolled.png` show the same content because everything fits in portrait. The PNG bytes differ, but the layout is identical. That still counts as evidence. The detail column reads well, the attention card is the only raised group, and the rows keep one text edge. iPad has only the loaded state, which is acceptable because the layout code is shared with iPhone.
5. **Native stale-error spacing.** There is a large gap between the error banner and the summary in `today-stale-error.png`. It comes from List section spacing plus the summary section. It reads fine and is not worth a change on its own.

## Validation reviewed

- Web full suite: 100 files, 1269 tests passed (`web-tests-v2.log`). Focused run: 12 passed. Production build passed (`web-build.log`).
- Native: `ExperienceFlowTests` frontier test and `testTodayDesignReview` passed, 2 tests and 0 failures (`ios-today-v2.log:685`). iPad `testTodayDesignReview` passed (`ipad-today.log:182`, `TEST EXECUTE SUCCEEDED`).
- Every iOS and web capture except the large-text one noted above postdates the final source edits.
- I did not recompute the stated source fingerprints.
