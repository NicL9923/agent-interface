# 17. Assistant details and artifacts recheck

Reviewer: Claude Opus 5.5, high effort. Implementer: GPT-6.1 Sol. Different provider, so this counts as an independent review.
Scope: the delta since review 16 (`reviews/17-details-web-delta.patch`, `17-details-native-delta.patch`) plus its callers, the new native evidence, the conversation code-font change, and annotations and claims affected by the delta. Settled review 16 decisions were not reopened without new evidence.
I ran no builds, browsers, simulators or lock operations. I used only file reads, `source-state.py`, hashes and Pillow crops.

## Verdict

**The gate can close.** All five MUST FIX items are fixed and rendered. Every row below scores at least 9 on the final evidence. No blocker remains.

| Screen | Review 16 | Now | Notes |
| --- | --- | --- | --- |
| Web desktop details | 8.8 | 9.1 | M1 fixed |
| Web phone details (390, 320, 200%) | 8.5 | 9.1 | M1 and M4 fixed. See N1 for the blocked avatar |
| Web desktop artifacts and preview | 8.7 | 9.2 | M2 and M3 fixed, P2 fixed |
| Web phone artifacts and preview (390, 320, 200%) | 8.5 | 9.0 | P1 improved: at 200%, about half of the next row shows |
| iPhone profile | 8.6 provisional | 9.1 | M5 fixed at AX3 |
| iPhone artifacts | 8.9 provisional | 9.1 | 24 pt icon column built; search exit verified |
| iPhone preview | 9.0 provisional | 9.0 | Scoped and chat previews show real content, Done and Share |
| iPad profile | 9.0, normal only | 9.0 | Dark, AX3, empty and pin/follow now captured. See N2 |
| iPad artifacts | 8.8, normal only | 9.0 | All states captured. AX3 shows about two rows in the form sheet. See N2 |
| iPad preview | not scored | 9.0 | Scoped and chat previews both work |
| Web conversation, code-font delta only | accepted 9 | 9 preserved | Courier changed to Menlo; nothing else changed |

I scored each row on its own. No row was averaged up, and none uses an expected score.

## Evidence verified

- **Delta is exact.** Both patches pass `git apply --reverse --check`. I diffed each review 16 snapshot against the current file, and the changed-line counts match the patches: 8 files, 68 web and 3 native changed lines.
- **Web fingerprint:** I recomputed `source-state.py src/ tests/ .agents/tools/capture-design.js .agents/fixtures/details-design.json` and got `89e1421c…62b0e38` over 355 files. That matches. Fixture SHA `548b984c…51b16f5` matches.
- **Native fingerprint:** the `validate-ios.sh` input set (`ios/` plus the three tools) gives `25093311…5be0dc9` over 242 files. That matches both `.private/*.txt` summaries. Neither log says "changed during the run".
- **Native runs:** iPhone 17 and iPad Pro 11 each report `passedTests 7, failedTests 0, skippedTests 0`, exit 0, on commit `af3e8fd`. The iPhone log compiles `BotProfileView.swift` (`ios-details-final-v7.log:106`). The logs show 6 ArtifactsTests and 1 tour test (`:358`, `:1048`; iPad `:152`, `:892`).
- **Screenshots:** I re-hashed all 42 native screenshots. Every SHA-256 and mtime in `details-native-evidence.json` matches, and every mtime falls inside its run's start and finish.
- **Web timing:** every web source file is older than the 15:08:26 test run and the 15:08:27–40 captures. No file in `src/`, `tests/`, `ios/` or `.agents/` is newer than `details-v6-after.json`.
- **Logs:** `details-tests-v6.log` passes 34/34 across 4 files. `details-build-v7.log` ends with a successful build and service worker.
- **Lock release:** `details-heavy-release.json` shows both owned simulators Shutdown, no owned heavy processes, and the lock probe free at 20:17:31Z.

## MUST FIX recheck

### M1, fixed
`shell.css:239-241`: blocked uses attention, waiting and interrupted use muted, failed uses danger. This matches web Home (`styles.css:304-313`) and native `ActivityLabel` (`RootView.swift:682-684`). The geometry report records the computed colors: `state-blocked` is `rgb(155,103,51)` (#9b6733) and `state-failed` is `rgb(163,60,50)` (#a33c32). `after/web-details-profile-blocked.png` shows "Needs your help" in attention brown. The new `blocked-profile` capture state in `capture-design.js` satisfies review 16's anti-drift request.

### M2, fixed
`artifacts.css:39` sets selected metadata to `--message-meta`. On `--accent-soft` I calculate 4.620:1 in light and 4.911:1 in dark. The computed colors in `details-v6-after.json`, `rgb(95,104,94)` on `rgb(220,233,223)`, match the tokens. Both pass AA for 14 px text.

### M3, fixed
`--font-mono` is defined once at `styles.css:18` with an explicit Menlo fallback. Both `message-markdown.css:85` and `artifacts.css:55` use it. `CSS.getPlatformFontsForNode` reports `Menlo-Regular` for the artifact preview in every text-preview capture and for chat code in all 18 conversation captures. You can see the change from Courier to Menlo in `annotated/details-web-artifacts-large.png`. Dark mode needs no override, because the token is font-only.

### M4, fixed
The badge is now positioned inside `.artifacts-button-icon` with `left: calc(100% + 0.125rem)` (`home.css:541-547`). The icon is sized in rem (`home.css:540`). Geometry: at 100% the icon is 20×26 and the badge starts at x+22. At 200% the icon is 40×52 and the badge starts 4 px past it. Crop `17-collages/web-200-actions-list-crop.png` confirms no overlap, and the glyphs scale with their labels. The only caller is `BotDetails.tsx:86`. The rule is scoped to `.bot-details-actions`, so no other surface changes.

### M5, fixed
`BotProfileView.swift:103,107`: `@ScaledMetric(relativeTo: .title3) glyphHeight = 26` with a fixed `.frame(height:)`. Crops `17-collages/ios-ax3-tiles-crop.png` and `ipad-ax3-tiles-crop.png` show equal tile heights, a shared Find/Pin baseline and no clipped symbols, on both devices.

### Review 16 polish that changed
- **P1:** the phone list now gets a `1fr`/`1.5fr` share (`artifacts.css:68`). At 200% the list is 176 px tall and row 2 starts at 523 of 580, so about 57 of its 111 px show. The filename is visible and its metadata is cut off. That is enough of a hint.
- **P2:** `artifact-preview:has(.artifact-text-preview)` now top-aligns (`artifacts.css:45`). The desktop preview starts right under its heading.

### Previously unbuilt native code, now verified
- **Clear filters exits search:** after the tap, `ScreenshotTourTests.swift:482` asserts that the nav-bar Close button is hittable. The next capture, `details-artifacts-unavailable`, shows an empty search field on both devices.
- **20 pt glyph in a 24 pt column:** built and rendered on both devices, including AX3, at `Artifacts.swift:204`. File names now share one left edge.

## Conversation code-font delta
The only conversation change is `message-markdown.css:85`, which moves to the shared token. That swaps Chromium-on-Mac's Courier fallback for Menlo. The token resolves to SF Mono in Safari and iOS Safari through `ui-monospace`, and the Linux and Windows fallbacks are unchanged.

`conversation-details-font-after.json` covers all 18 captures. None overflow. Copy, draft-send and keyboard-focus checks are all true, and metadata contrast stays at 4.89:1 light and 5.57:1 dark. `conversation-font-code-recheck.png`, built from the `-latest` captures, shows clean Menlo code at desktop, phone and 200%. Wrapping, layout and every other accepted judgment from reviews 06 and 08 are untouched. **The accepted 9 holds, and the code is easier to read.**

## Annotations and claims
- All 14 manifest entries were re-rendered after the final runs, at 15:19:41–45.
- The AX3 profile annotation now matches the image. "Equal icon frames scale with Dynamic Type and align the labels" is true. The before note, "fixed icon frames clip large symbols", matches the baseline: the Pin glyph pokes above its tile there.
- "Selected metadata passes 4.5:1 and previews use the same monospace font as chat" is true.
- "Icons scale with the text and the file count sits beside its icon" is true.
- "The next file remains visible" is a little generous. Only the filename shows. That's acceptable.
- Acceptance note: "The status palette now matches Home and native" is true for the status text. Avatars are a separate question; see N1.
- Cosmetic only: in `annotated/details-web-artifacts-large.png`, the after marker covers the "A" of "All types". In `annotated/details-ipad-artifacts.png`, the arrow ends on the row separator instead of the metadata line. Neither one misleads.

## Nonblocking, new evidence

- **N1. The blocked avatar morph on both details cards.** `BotDetails.tsx:74` passes `blocked` to `Avatar`, so the 88 px hero becomes a bare blue "!" with no face or disc (`17-collages/web-status-avatar-crop.png`). Native `BotProfileView.swift:42` does the same. This is the documented mascot morph (`avatar-specimen.tsx:240`), so it isn't broken. Still, every other avatar maps blocked to idle and leaves the attention signal to the status text or badge: `Sidebar.tsx:62,106`, `ChatHeader.tsx:42`, `Conversation.tsx:225`, `ConversationView.swift:160,574`, `RootView.swift:485,511`. Failed keeps the face and adds a badge. Recommendation: map blocked to idle on both details cards. The "Now: Needs your help" row already carries the state. This is a product call, so it doesn't block. `CommandPalette.tsx:55` has the same omission, but it's out of scope.
- **N2. iPad sheets at AX3.** `FittedSheet.detents` returns `[.large]` once content exceeds 90% of the window (`BotProfileView.swift:133-134`, the fall-through `return [.large]`). On iPad regular width, `.large` is the standard form-sheet height. That is shorter than the fitted `.height` the normal-size card gets: the AX3 card is visibly shorter than the normal one in `details-ipad-final-profile.png`. The AX3 profile shows only the header and tiles, and nothing peeks below the tiles to hint at more (`17-collages/ipad-ax3-profile-top-bottom.png`). The artifacts sheet uses the default form sheet everywhere, so it shows about two rows at AX3. This is a platform convention that predates this pass. Follow-up: on regular width, return `.height(available * 0.9)` instead of `.large`.
- **N3. Native tile padding at AX3.** The tiles keep `.padding(.vertical, 4)` (`BotProfileView.swift:116`), so glyphs sit about 6 pt from the tile top. The count badge's `-6` offset pokes about 2 pt past the tile edge. This predates the delta and is cosmetic.
- **N4. Courier fallbacks remain outside the token.** `transcript.css:180` (`.option-key`, the questions keyboard hints) and `styles.css:715` (`.tool-call-detail summary`) still use stacks without Menlo, so they fall back to Courier in Chromium on Mac. Both are in accepted scopes and outside this delta. A one-line switch to `var(--font-mono)` in each would finish the standardization.

Unchanged review 16 polish items stay nonblocking as written: P3–P12 and the byte-format note.

## Rerun
None needed for this gate. If N1 or N4 is applied later, rerun the 34 focused tests and `capture-design.py details after`, then check the blocked capture. N2 would need one iPad AX3 tour run in a future shared slot.
