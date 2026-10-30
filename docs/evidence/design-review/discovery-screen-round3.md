# Search, saved items, history and automations: whole-area review, round 3

Reviewer: Claude Opus 5.5, Anthropic. OpenAI Sol implemented the work, so
this review is independent. High effort was requested. This session does not
show how effort maps to internal settings, so I can't confirm the level
beyond that request. This is round 3 of 3, with one score for the whole area.

Reviewed commit: `a29fec02e9c8d751163a495533ab203ed0a68af8` on PR #207. The
scope is the diff since `a2c0198870610a401eb4d1bdf4d760126a65510c` plus the
code that calls the changed lines. Earlier rounds: `discovery-screen-review.md`
(8.2) and `discovery-screen-round2.md` (8.8). Work settled in those rounds was
not reviewed again.

Screenshots: `/Volumes/DevSSD/scratch/wildbots-design-review/discovery-screen-r3/`.
Web coordinates are CSS pixels in the 1440x1000 and 390x844 captures. Native
coordinates are pixels in the 1206x2622 originals. I judged the raw captures
and did not use `history-comparison.png`, `saved-comparison.png` or the old
`native-history-button-detail.png`. My crops, collages and pixel samples are in
`/Volumes/DevSSD/scratch/wildbots-design-review/discovery-screen-r3-review/`.

Sources read: the diff to `DiscoveryPanel.tsx`, `discovery.css`,
`src/shared/discovery.ts`, `ChatHeader.tsx`, `DiscoveryViews.swift`, the new
test cases, and the callers `use-action.ts`, `FormMessage`, the shared
`.form-error`/`.form-notice` styles, and native `perform`, `savePointer`,
`history` and `historyToolbar`. Capture tooling, `DebugFixtures` and the DEBUG
fixture shortcut are excluded.

## Score: 9.0 / 10, pass

Every round 2 finding was addressed on both clients, and I can see the fixes
in the captures. The scrolled history heading now has a clean top edge
(`history-bottom-1440.png` y 89-93 is the page rule followed by plain
background, with no leaked content). Saved reply titles read as titles:
"I looked at the last 48 hours of events for binary_sensor.north_gate." at
`saved-items-1440.png` y 234, two clean lines at 390. Both subtitles say "Past
answers, saved items and automations". A failed save shows inside the pinned
heading at both widths (`history-save-error-1440.png` x 472-1304, y 268-312;
`history-save-error-390.png` x 16-374, y 195-239), and it is the only alert on
the page. Native Save reply is now a neutral gray capsule. I measured its text
at 4.53:1 against the button fill (`native-History.png` x 310-610,
y 1160-1270), which passes AA for its size. The small items are also fixed:
Enabled and Paused are both chips, "Last result" is on its own line, the
Back-during-save race clears `savingKey`, and the role fallbacks are
capitalized.

The fix for the sticky heading added a small new glitch, described in issue 1.
It is a one-rule CSS fix and doesn't keep the area below the bar.

## Remaining issues, most important first

1. **The history heading clips whatever sits directly above it.** Observed,
   web.
   - `history-save-error-1440.png` x 472-755, y 140-146: the bottom 6 px of the
     tab strip are cut off, so the strip has rounded top corners and a flat,
     borderless bottom (crop `err1440-top.png`). This affects every desktop
     history page before it scrolls.
   - `reply-saved-1440.png` x 472-1304, y 195-206: the "Saved. Find it in
     Saved items." notice loses its bottom padding and border, so the box
     looks broken (crop `saved1440-notice.png`). This shows after every
     successful save near the top of a history page. The "Loading..." line
     during a save or page load sits in the same spot.
   - `conversation-history-1440.png` y 90: a 1 px row of the tab strip shows
     under the page rule while the heading is pinned. It's barely visible.

   Cause: `.history-heading` now has `margin-top: calc(-1 * var(--discovery-padding))`
   (`discovery.css:39`). `.discovery-history` has no padding or border, so that
   margin collapses through the section into the margin of the previous
   sibling. The tab strip's 18 px `margin-bottom` (`discovery.css:5`) becomes
   18 - 24 = -6 px, and the heading's opaque background (z-index 3) covers the
   bottom of the tab strip. The notice `<p>` has a smaller margin, so the
   overlap there is larger. At 390 the padding is 16 px, so the tab strip
   escapes, but the notice still loses about 3 px.

   *Fix:* Keep the stuck behavior and stop the collapse. One option is to
   move the success notice and the Loading line into `.history-heading`, as
   was done for the error, and give `.view-tabs` a bottom margin of at least
   `calc(var(--discovery-padding) + 6px)` while history is open. A simpler
   option is to drop the negative `margin-top`, keep `top: calc(-1 * var(--discovery-padding))`,
   and add a `::before` band of `var(--discovery-padding)` height with the
   surface background above the heading. That band only overlaps the panel's
   own padding once the heading is stuck. After either fix, check both widths
   at scroll 0 with a notice showing.

2. **Native Back leaves the save error and notice behind.** Code only. Back
   sets `page = nil` and `historyRequest = nil` but doesn't clear `error` or
   `notice` (`DiscoveryViews.swift:221`). With the new `page == nil` guard
   (`DiscoveryViews.swift:80`), a failed save's "Could not save" banner or the
   "Saved. Find it in Saved items." notice moves to the top of the search
   results after Back. It stays there until the next action. Web clears both
   through `reset()` in `back()` (`DiscoveryPanel.tsx:91`).
   *Fix:* Set `error = nil; notice = nil` in the Back action, matching web.

3. **The wrapped search date starts with a separator at 390.** Observed,
   `search-results-390.png` x 24-167, y 321-337: the second meta line reads
   "· Updated Wed 7:00 AM". The new nowrap span keeps the date together as
   intended. It just carries the dot into the line start
   (`DiscoveryPanel.tsx:140`; saved rows use the same pattern at line 147).
   This is minor and optional. Leave the dot outside the nowrap span so it
   stays with the first line, or let the span take a line of its own without
   the dot under 600 px.

Not scored and outside this round's diff: the shared `When` formatter gives
"Saved Just now" and "Next: In 59 min" with a capital letter mid-phrase
(`saved-items-1440.png` y 259, `automations-1440.png` y 284). The fix is a
lowercase variant for inline use, if anyone touches `When`.

## Round 2 findings

| Round 2 item | Status | Evidence |
| --- | --- | --- |
| 1 Content above pinned heading | Fixed when scrolled; fix caused issue 1 above | `history-bottom-1440.png` y 89-93 clean; `history-bottom-390.png` top clean |
| 2 Saved reply titles | Fixed on both clients, same rules | `saved-items-1440.png` y 234; `saved-items-390.png` y 221-262; `discovery.ts:25-36`; `DiscoveryViews.swift:271-279`; matching unit cases |
| 3 Subtitle omits Automations | Fixed on both clients | Every capture's header; `ChatHeader.tsx:6`; `DiscoveryViews.swift:156` |
| 4 Errors off screen | Fixed on web at both widths; native code only | `history-save-error-*`; UI test asserts one alert inside the heading for save and paging |
| 5 Native Save competes | Fixed: neutral tint, regular size, 44 pt frame, 4.53:1 | `native-History.png` x 310-610, y 1160-1270 |
| 6 Polish | Fixed: nowrap dates, Last result line, chips on both states, `savingKey` cleared, capitalized roles | `automation-paused-390.png` y 264-314; `automations-1440.png` chip; `DiscoveryPanel.tsx:40,91,107` |

## Coverage

Observed in captures: web search, history at the target, failed save with the
pinned error, the Saved state, history at its end, Saved items, enabled and
paused routines, and usage, all at 1440 and 390. Native Search, Saved,
Automations and a long History page with the pinned heading and the final
Save tint.

Code only: native error placement in `historyToolbar`, native Back state,
paging errors (web unit test only), and the Back-during-save fix.

Not exercised, and not scored as defects: native interaction and the new
native unit cases, which didn't run on this host; clipboard; VoiceOver, dark
mode and large text; real providers, scheduling and delivery. The fixed Oct 3
schedule, the generic native recipient and the synthetic timestamps are
fixture limits. I ran no tests, builds, browsers or runtime checks for this
review.
