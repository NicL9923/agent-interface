# 16. Assistant details and artifacts review

Reviewer: Claude Opus 5.5, high effort. Implementer: GPT-6.1 Sol. Different provider, so this counts as an independent review.
Scope: uncommitted delta against `af3e8fd` in `/Users/nicolas/.t3/worktrees/agent-interface/t3-d1b42c2a`, plus callers of the changed lines. Settled scopes were not re-reviewed.
I ran no builds, simulators, devices, new browsers or lock operations. I ran only the two focused jsdom test files and some read-only checks.

## Verdict

**Not ready to advance.** Five MUST FIX items. All are small. Native acceptance also needs the final iPhone and iPad runs.

| Screen | Score now | Expected after fixes | Blocking |
| --- | --- | --- | --- |
| Web desktop details | 8.8 | 9.1 | M1 |
| Web phone details (390, 320, 200%) | 8.5 | 9.1 | M1, M4 |
| Web desktop artifacts and preview | 8.7 | 9.1 | M2, M3 |
| Web phone artifacts and preview (390, 320, 200%) | 8.5 | 9.0 | M2, M3, P1 |
| iPhone profile (provisional) | 8.6 | 9.1 | M5, final run |
| iPhone artifacts (provisional) | 8.9 | 9.1 | icon fix is unbuilt and unrendered |
| iPhone preview (provisional) | 9.0 | 9.0 | final run |
| iPad profile (provisional) | 9.0 for normal only | ? | no dark, AX or empty captures; M5 applies |
| iPad artifacts (provisional) | 8.8 for normal only | ? | captured before the icon and search fixes |
| iPad preview | not scored | ? | no capture exists |

I did not average any weak screen up to 9.

## Verified claims

- Web fingerprint `9cc568c1…8a0043` and native fingerprint `9232c72e…a1ccd1` match `source-state.py` on the current tree. The fixture SHA `548b984c…51b16f5` also matches.
- Focused web tests pass: 17/17 in `reviews/16-opus-vitest.log`.
- The iPhone run `.private/ios-test-20261026T192002Z-35023` compiled `BotProfileView.swift` (`ios-details-after-v6.log:77`) and passed the 6 `ArtifactsTests` (`:285-297`).
- The iPad failure is the claimed driver assumption: `ipad-details-after.log:388`, `"Cancel" Button never appeared`. The current test now waits for `Close` instead (`ScreenshotTourTests.swift:480`).
- `Artifacts.swift` (14:47) and `ScreenshotTourTests.swift` (14:31) changed after both native runs, so the search binding and the 20 pt glyph are unbuilt, as stated.
- The excerpt uses the shared `excerpt()` (`src/shared/event-copy.ts:7`). The test proves Markdown markers are stripped (`tests/bot-details-ui.test.ts:84-89`).
- The web `PDF` label is accurate, because `document` only matches `application/pdf` (`Artifacts.tsx:31`). Native `typeName` mirrors this.
- Container queries are safe. Both containers have explicit widths (`home.css:285-288`, `artifacts.css:9`). The nested artifacts `<dialog>` uses `showModal()` (`ui/dialog.tsx:62`), so the top layer escapes the sheet body's layout containment. The desktop capture confirms this.
- Preview ownership is sound. The sheet-scoped `open` keeps the generation check and the cancellation check before presenting (`AppStore.swift:1876-1879`). It returns silently on cancellation (`:1882`) and cancels on sheet disappear (`Artifacts.swift:150`). The root entry still uses `openedFile` (`:1860`, `RootView.swift:212`). Temp files are removed on cancellation and in `dismantleUIViewController`.

## MUST FIX

### M1. Web details status colors contradict the app's status vocabulary
`src/app/shell.css:238-240` makes `waiting` and `interrupted` use the attention color. It gives `blocked` ("Needs your help") no rule, so it falls back to the accent color through `shell.css:223`. Everywhere else, blocked uses attention and waiting/interrupted use muted:
- web home: `src/styles.css:303-311`
- activity dot: `src/styles.css:706-708`
- native `ActivityLabel`: `RootView.swift:682-684`

The result: a bot that needs the user looks the same as one that is working, and an interrupted bot looks urgent. This contradicts the ledger's "semantic status colors" claim.
**Fix:** add `.state-blocked { color: var(--attention) }` and make waiting/interrupted muted. Only `failed` was captured (`after/web-details-profile-failed.png`). Add a blocked capture, or a jsdom class assertion, so this can't drift again.

### M2. Selected artifact row metadata fails WCAG AA contrast
`artifacts.css:37-38`: `--muted #697268` on `--accent-soft #dce9df` measures **3.98:1**. Pixel samples from `after/web-details-artifacts-desktop.png` confirm it: the background is (220,233,223) and the text is (105,114,104). The first file is always selected, so this shows on every artifacts screen at 14 px, light theme. Dark theme passes at 4.91:1. Crop: `reviews/16-collages/web-selected-row-crop.png`.
**Fix:** add `.artifact-item.selected small { color: var(--ink) }` or use a darker muted token on the soft fill.

### M3. Text preview renders in the browser's default Courier
`artifacts.css:53` sets no `font-family` on the `pre`, so Chromium on macOS uses its default, Courier. You can see the thin serif monospace in `after/web-details-artifacts-desktop.png`, the dark variant, and all phone captures. Conversation code uses `ui-monospace, "SFMono-Regular", Consolas, monospace` (`message-markdown.css:85`, `transcript.css:180`). This pass touched that rule for readability, and the accepted conversation pass standardized code fonts.
**Fix:** use the same font stack.

### M4. At 200% text, the web Artifacts count badge covers its icon
The badge now uses rem sizing (`home.css:552`, 0.75rem), but its offsets stay in px: `top: 4px; right: calc(50% - 26px)` (`home.css:548-549`). The icons are fixed-px SVGs that don't scale. At 200% the 24 px badge sits on top of the file glyph, and the icons look tiny over 28 px labels. Baseline had the same occlusion, so this pass didn't cause it, but it is still the most obvious defect in `after/web-details-profile-large-text.png`. Crop: `reviews/16-collages/web-200-badge-before-after.png`.
**Fix:** anchor the badge to the icon with a relative wrapper, or use em offsets. Sizing the quick-action icons in em would also fix the scale mismatch.

### M5. Native AX3 quick-action tiles have unequal heights and misaligned labels
This diff changed the glyph frame from `height: 26` to `minHeight: 26` (`BotProfileView.swift:106`). At accessibility sizes each SF Symbol now sets its own height. `LazyVGrid` doesn't equalize row heights, so the `pin` tile is taller than `magnifyingglass`, and the "Find" and "Pin" baselines differ by about 15 pt. See `after/ios/details-large-text-profile.png` and the crop `reviews/16-collages/ios-ax3-tiles-crop.png`. Default size is unaffected (`ios-tiles-crop.png`). The annotation "icon frames grow with their glyphs" describes the cause as if it were an improvement. iPad AX will show the same issue.
**Fix:** add `@ScaledMetric(relativeTo: .title3) var glyph = 26` and use `.frame(height: glyph)`. Or use `Grid`, or `.frame(maxHeight: .infinity)` per row.

## Nonblocking polish

- **P1** `artifacts.css:66`: at 200% on phone, the fixed 0.65fr/1.5fr split shows exactly one file and no partial next row, so nothing hints at the other six (`after/web-details-artifacts-large-text.png`). Consider list-first browsing, or a taller list share at large text. This is the main thing holding web phone artifacts near 9.0.
- **P2** `artifacts.css:43`: `justify-content: center` floats short text previews. On desktop that leaves about 100 px of empty space under the header (`after/web-details-artifacts-desktop.png`). Top-aligning text previews would read better.
- **P3** `Artifacts.tsx:174-175`: the external and unsupported messages have no glyph, and a multi-line message is left-aligned, while the PDF and other-file placeholders are centered with a 48 px icon (`after/web-details-artifacts-external.png` vs `-document.png`).
- **P4** Web list rows show "Generated · 217 B" (`Artifacts.tsx:159`). Native rows include the type. Adding the category on web would match native and help scanning.
- **P5** Quick-action order differs between clients: web is Pin, Find; native is Find, Pin (`BotDetails.tsx:79-84` vs `BotProfileView.swift:64-69`). This predates the pass.
- **P6** The earlier-file failure notice is attention-colored on web (`artifacts.css:30`) and muted on native (`Artifacts.swift:166`). Pick one.
- **P7** `Artifacts.swift:151-154`: `openingFile` is cleared only by `present` or `onError`. The download can also return silently, through `guard let api` (`AppStore.swift:1869`) or a generation change (`:1876`, `:1882`). Then the spinner stays up. Only sign-out and account switch reach this today. A completion callback that always runs would rule it out.
- **P8** On session expiry, the sheet alert shows and `report()` also sets `store.error` (`AppStore.swift:1885`). The user may see the same message again as a root banner after the sheet closes. This is acceptable, but worth knowing.
- **P9** The Now: Failed row shows no reason, though the activity detail exists ("The gate service did not answer." in the failed fixture).
- **P10** Keyboard: Clear filters unmounts itself (`Artifacts.tsx:151`) and focus falls to the dialog. Move focus to the search field.
- **P11** Native glyphs are now a fixed 20 pt that doesn't scale. That's defensible for decoration, but check the final AX3 render. `.top` alignment may put the glyph above the first line's optical center. `.firstTextBaseline` is the usual fix.
- **P12** No web test asserts the friendly category text ("Generated · PDF · 2.4 MB"), which replaced the MIME display. One assertion in `artifacts-ui.test.ts` would catch a regression.
- **Note only, accepted conversation scope:** chat attachments say "217 bytes" and "6 KB", while artifacts say "217 B" and "5.7 KB" for the same files (`after/ios/details-chat-file-before-open.png`).

## False or overstated claims

1. Ledger, "semantic status colors": only failed is semantic. Blocked, waiting and interrupted are wrong (M1).
2. Annotations "readable metadata" and "metadata ... use a readable scale" (`details-web-artifacts-wide`): the scale is readable, but selected-row contrast fails AA (M2).
3. iOS large-profile annotation "icon frames grow with their glyphs": this is what causes M5.
4. Acceptance doc: "keep file icons within a fixed 24 pt column at AX3" describes unbuilt, unrendered code. The doc does call it queued, so this is acceptable as written. It must not appear in any gallery caption until the image exists.

No other claims were false. Fingerprints, counts (11 rendered, 14 listed), test totals and the iPad failure cause all check out.

## Evidence gaps (native)

- **iPhone:** no capture yet of the 20 pt glyph or the search-binding change. Every after image predates them.
- **iPad, missing entirely:** dark profile and artifacts; AX3 profile, profile bottom, artifacts and artifacts bottom; empty; earlier-file error; Clear filters leaving search mode; the unavailable 404 alert; the scoped preview showing file contents, Done and the share control; the chat preview; Done returning to the list.
- **iPad annotations:** `details-ipad-{profile,artifacts,preview}` are listed but not rendered.
- **Never claimed:** VoiceOver, a physical device, PDF/audio/video rendering, or external-source opening.

## Minimal rerun after the shared runtime is released

1. Fix M1 to M5 first so one native slot covers everything. M1 to M4 are CSS only; M5 is one Swift line plus a property.
2. Web, which needs no shared slot: run `vitest run tests/artifacts-ui.test.ts tests/bot-details-ui.test.ts` and `npm run build`, then `capture-design.py details after` with a blocked-state profile added. Check desktop and phone, light and dark, 200% profile and artifacts, and failed and blocked.
3. Native, through `validate-ios.sh` with its automatic admission:
   - One iPhone run of `ArtifactsTests` plus `testDetailsDesignReview`, all five variants.
   - One iPad run of the same.
4. Render all 14 manifest comparisons with `--batch`. Regenerate the iPhone profile-large and artifacts comparisons, because their after images will change.
5. Get a scoped re-review from a non-OpenAI reviewer. Cover only the M1 to M5 diff, the Artifacts.swift search and glyph lines, and the new captures. Everything else here is settled.

Root stays on this screen until every row above clears 9 with final native evidence.
