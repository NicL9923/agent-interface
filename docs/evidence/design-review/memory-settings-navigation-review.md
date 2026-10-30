# 52. Shared settings navigation recheck

Reviewer: Claude Opus 5.5, high effort. OpenAI implemented the change. This was a read-only review. I ran no builds, browsers, simulators, locks, tests or subagents, and I edited no app code, ledger or docs. My only writes are this file and `52-collages/`.

## Verdict

**Pass. The shared nav delta causes no regression on the five 200% views.** All five R2 captures are byte-identical to the frames the earlier reviews scored. The compact tab bar does not wrap in any of them, so their content viewport, sticky save bar and More trigger are unchanged to the pixel.

| View, web phone 390×844, 200% | Earlier score | Score now | Basis |
| --- | --- | --- | --- |
| Details (`web-settings-edit-large-text`) | 9.1, reviews 21 and 23 | **9.1** | Same SHA-256 as `after/` |
| Avatar (`web-avatar-geo-large`) | 9.0, review 28 | **9.0** | Same SHA-256 as `avatar-captures/after/` |
| Models picker in Details (`web-models-models-large-text`) | Details row, "no regression" in reviews 33 and 34 | **9.1**, Details row | Same SHA-256 as `models-captures/after/` |
| Tools (`web-models-tools-large-text`) | 9.0, reviews 34 and 35 | **9.0** | Same SHA-256 as `models-captures/after/` |
| Skills (`web-models-skills-large-text`) | 9.0, reviews 34 and 35 | **9.0** | Same SHA-256 as `models-captures/after/` |

These are the scores for the frames as they exist now. Identical bytes give identical frames, so the earlier scores apply as they are. I did not re-open any body design.

## The delta

`src/styles.css`, compact bar only (`.settings-tabs-mobile`, used when `(max-width: 620px)` matches, `BotSettings.tsx:49,340`):

- `:962` adds `flex-wrap: wrap` to `.settings-tabs-mobile`.
- `:968` adds `flex-shrink: 0` to `.settings-tabs-overflow`.
- `:986` keeps `white-space: nowrap` on `.settings-more-trigger > span` and drops `min-width: 0`, `overflow: hidden` and `text-overflow: ellipsis`.

The desktop grid uses `.settings-tabs:not(.settings-tabs-mobile)`, so the delta cannot reach it. The DOM, focus order, `aria-current` and the `aria-label` "More settings, <tab>" are unchanged.

## Evidence checked

- **Captures.** All 130 paths in `settings-nav-regression-r2-evidence.json` match their recorded SHA-256 and mtime: settings 63, avatar 24, models 43, with 0 mismatches. All mtimes fall inside the admitted window, 14:37:23 to 14:40:03 local. All three segments report `overflow: false`. Avatar and models report no browser errors. The settings driver does not return browser errors, and the evidence notes this.
- **Receipt.** Build, settings, avatar and models all exited 0. Cleanup exited 0 with `{"closed":0}`. The run finished inside its deadline, the lock probe was `free` and port 3044 was closed. The release was observed at 19:40:03.9Z. I inspected images only after that.
- **Source.** I reran `source-state.py src .agents/tools/capture-design.js .agents/tools/capture-design.py .agents/fixtures/models-design.json` on the current tree. It gives `sha256:37626541…12d17 (226 source files)`, which matches the evidence and receipt. The prefix set follows the convention recorded in `memory-web-before-evidence.json`.
- **Drivers.** I diffed each `*-after-capture.js` against the repo's `capture-design.js`. There are exactly five changed lines: the run-code wrapper opening, one `addInitScript` that sets `window.name="wildbots-design-settings-nav-capture"` before `newPage()`, and the closing call with arguments. The wrapper only assigns the ownership marker. Context close comes from the unchanged repo body. The inlined fixtures equal `.agents/fixtures/{settings,avatar,models}-design.json`, and those files match the recorded fixture hashes. "Confirm this model" appears in both the driver and the repo script, which matches the corrected selector. The failed first window is not in this evidence, and nothing here relies on it.
- **Byte identity.** The five target files have the same SHA-256 as the earlier accepted captures: `de48d561…`, `7e9e3fed…`, `2054141c…`, `7be6ddd8…` and `631c3216…`. A Pillow difference over each pair returned no bounding box and 0 changed pixels.

## Consequences of wrapping, from source and the Memory frame

None of the five views wraps. At 200% on 390 px, "Details", "Avatar" and "More ›", "Tools ›" or "Skills ›" fit on one row. "Skills ›" is the tightest fit. Wrapping starts with labels about as long as "Memory". It shows in the accepted `memory-after-captures-r7/after/web-memory-large-text.png`, which review 47 independently accepted (`52-collages/03-wrap-context.png`).

- **Content viewport.** When the bar wraps, the trigger sits alone and right-aligned on a second row. In the Memory frame this costs about 70 px of 844, as review 47 recorded. The nav is a sibling above `.settings-content` (`flex: 1`, `min-height: 0`), so the scroller shrinks and nothing overlaps.
- **Sticky controls.** `.sticky-actions` (`styles.css:1396`) are sticky inside `.settings-content` (`BotSettings.tsx:432,522,606`, `CatalogEditor.tsx:43`). They pin to the bottom of the scroller whatever the nav height is. The Avatar sticky stage also lives inside the scroller, so the nav row can't offset it. `scroll-padding-bottom` is unaffected.
- **Dropdown placement.** `.settings-more-menu` is absolutely positioned at `top: calc(100% + 4px); right: 0` against `.settings-tabs-overflow`. When wrapped, it opens under the second-row trigger, right-aligned to the nav padding. Its height is `min(240px, 100dvh - 200px)` with its own scroll. In the Memory geometry the nav ends near y 315, so a full-height menu ends near y 560. That is well clear of the sticky Save bar at about y 770 and of the dialog's `overflow: hidden` edge. Nav and save bar both use `z-index: 1`. The later save bar would paint over the menu only if they overlapped, which this geometry rules out. That stacking is unchanged by the delta.
- **Truncation trade.** Without the ellipsis, the trigger never shrinks, so a selected label always shows in full. That is the M3 fix from review 47. The overflow labels are a fixed constant (`BotSettings.tsx:33`, longest "connections"). By my source estimate, "Connections ›" at 200% on a 320 px dialog is about 218 px against 276 px of nav width, so it fits on its own row. This is an estimate, not a measurement.

## Findings

No must-fix and no new nonblocking findings. Review 47's note stands: the wrapped bar uses about 70 px at 200%. It applies only to views that wrap, and none of these five do.

## Limits

- **More menu open was not captured** at any width or text size, before or after. The placement above comes from source and the closed-state Memory geometry, not from a runtime frame.
- **No frame shows a wrapped bar with a long label**, such as "Connections", "Routines" or "Learning", or a wrapped bar at 320 px. The only wrapped evidence is Memory at 390, 200%.
- 200% here is root font scaling, not browser zoom. It gives no VoiceOver, physical device or software keyboard assurance.
- Native is out of scope. The delta is web CSS only.

## Files

- `52-collages/01-before-after-200.png`: Details, Avatar and Models, earlier frame next to R2 at 1:1 height.
- `52-collages/02-before-after-200.png`: Tools and Skills, earlier frame next to R2.
- `52-collages/03-wrap-context.png`: accepted Memory 200% wrapped bar, Details at 320 and Details on phone from R2.
- Also inspected: `settings-nav-regression-r2/large-text.png`.
