# Failed and interrupted turns: M1-M3 recheck

Reviewer: Claude Opus 5.5, high effort. Implementer: GPT-6.1 Sol.
Scope: only `reviews/15-recovery-delta.patch` and the code that calls it or is called by it.
Everything else stays as settled in `14-recovery-review.md`. My collages and crops are in
`reviews/15-recheck-collages/`.

## Verdict

The gate passes. M1, M2 and M3 are closed. Root may commit recovery and move on to
Assistant details/artifacts.

| Surface | Score | Blocking items |
| --- | --- | --- |
| Web desktop | 9.2 | None |
| Web phone | 9.2 | None |
| Native iPhone | 9.2 | None |
| Native iPad | 9.1 | None |

iPad sits a tenth lower because of the long guidance lines already noted as non-blocking
item 4 in review 14. The delta didn't introduce any new issue.

## Patch integrity

- I copied `14-reviewed-source/` and applied `15-recovery-delta.patch` with `patch -p1`.
  The patch applied cleanly. All six patched files match the working tree byte for byte
  (`cmp`), so the patch is the exact delta.
- No other source file changed after review 14. Only those six files and the two evidence
  docs have mtimes after `14-recovery-review.md`.
- I recomputed both fingerprints and they match the ledger. Web is
  `source-state.py src/ tests/ .agents/tools/capture-design.js .agents/fixtures/recovery-design.json`
  = `3ba66376…c296` (355 files). Native is the `validate-ios.sh` input set = `565807ca…af53`
  (241 files).

## M1. Stable web live region: closed

- `src/app/Conversation.tsx:227-233`: there is now one `<div role="status" aria-atomic="true">`,
  and only its children change. The title, the reason (`recovery-detail`) and the
  interruption guidance are all inside it. The nested `role="status"` on the title is gone,
  so nothing announces twice.
- The node really stays the same. Its parent `.activity-status` block is the same element
  type at the same child position, with no `key`, and `showActivity` (`src/App.tsx:202`)
  stays true from `working` through `failed` and `interrupted`. React therefore reuses the
  element and only swaps its children.
- `aria-atomic` doesn't regress the working state. The shimmer's sweep copy is still
  `aria-hidden` (`Conversation.tsx:297`), so an atomic read gives the same single sentence
  as before.
- The test at `tests/transcript-ui.test.ts:103-114` would fail on the old code. There,
  `.activity-copy > [role=status]` resolved to the new `<p>` after the failure, so `toBe(live)`
  fails, and `aria-atomic` was missing.
- A timing gap, now closed: `recovery-v5-tests.log` (10:47:06) ran about a minute before
  the last write to `Conversation.tsx` and `transcript.css` (10:48:10). I reran the same
  focused command on the current tree. 105 of 105 passed, in `reviews/15-opus-vitest.log`.
  The build log (10:48:11) and the web captures (10:49) both come after the final edit.

## M2. Primary web recovery actions: closed

- Both actions now use `primary retry-turn` (`Conversation.tsx:244`, `:246`). The cascade
  holds. `.primary` (0,1,0) sets `color: var(--surface)`, which beats `button { color: inherit }`
  and the muted color it would inherit from `.activity-status`. `.conversation-activity
  .retry-turn.primary` (0,3,0) restores the accent border over the `--line` border at
  `transcript.css:53`.
- I sampled `after/web-recovery-failed-phone.png` myself: `#FAF8F2` on `#246F59` is 5.66:1.
  In dark, `#1B211E` on `#8BD2B2` is 9.32:1. Both match root's numbers. Light web (5.66)
  and native (5.91) differ slightly, but both use the same accent role and both pass.
- Pixels (`15-recheck-collages/web-failed.png`, `web-retry.png`): Retry and "Put my message
  in the message box" now read as the primary action on desktop, phone, dark and 200% text.
  The 3 px focus ring with its 3 px offset is clearly visible around the filled button. The
  disabled Retry in the unsupported state now reads as disabled through opacity, a much
  clearer difference than the old grey on grey. The web interrupted states
  (`web-interrupted.png`) look the same as before. The guidance kept its styling after it
  moved inside the region.

## M3. Native acknowledgment target: closed, with a correction to my own claim

- `ConversationView.swift:1158`: the label now carries `.padding(.vertical, 6).frame(minHeight: 44)
  .contentShape(Rectangle())`, inside the `Button` label. `StatusDock.swift:104-106` dropped the
  outside padding and frame. `CheckboxStyle` has only that one caller, so nothing else
  shifts.
- The logs confirm the geometry (`ios-recovery-v5-after.log`, `ipad-recovery-v5-after.log`):
  - iPhone, normal and dark: row `(12,633,378,44)`, tap `(388,669)`. That point sits 112 pt
    past the caption's trailing edge and 5 pt below the text.
  - iPhone, AX3: row 98 pt tall, tap 5 pt below the text and 1 pt inside the row.
  - iPad, normal and dark: row `(53,983,728,44)`, tap `(779,1019)`.
  - iPad, AX3: row 55 pt tall, tap 1 pt inside the row.
  Every tap sits outside both the glyph and the text, and each is followed by an assertion
  that Send is enabled. The test passed on both devices, and the `.private/*.txt` summaries
  record `565807ca` with exit status 0.
- Correction: my review 14 predicted a target of roughly 20 pt with dead padding. Root's
  two probes against the old code both passed, so that dead tap area was never reproduced.
  Touch slop most likely covered the 5 pt gap. My hit-testing claim was overstated, and I
  withdraw it. The fix still stands on what was measured: the old control reported an
  18 pt accessibility frame, which is what VoiceOver outlines and Voice Control and Switch
  Control target. Its row also stopped at the end of the text. It now reports and accepts
  a full-width 44 pt row.
- Pixels (`15-recheck-collages/native-interrupted.png`): the caption is at the same y (646)
  as before, so the layout doesn't shift. Send turns filled after the tap in light, dark,
  AX3 and on iPad.

## Non-blocking and limits

- Review 14 asked for the 27 native `TranscriptFeatureTests` to rerun after the M3 fix. They
  didn't. Their last run was on `f8bb9f35` (`ios-test-20261026T151942Z-97921`). I'm dropping
  that request. The delta only changes view modifiers on one control plus a UI test, which
  those store-level tests don't exercise. Both final runs compiled the whole test bundle
  with `build-for-testing`. The acceptance note states this gap honestly.
- The web refused annotation (`annotated/recovery-web-refused.png`) puts its marker and
  arrow over part of "The gate service" and "didn't". The raw image is authoritative and
  reads correctly. This is cosmetic.
- Review 14's polish items 1 through 8 remain open as follow-ups. None of them blocks.
- No VoiceOver, NVDA, JAWS, hardware keyboard, physical device or live Hermes run was
  done. A stable DOM node and an 18 pt to 44 pt accessibility frame are verified. Actual
  screen-reader speech and real-device touch are not.

## Permission

All four surfaces are at 9 or above with no obvious issue left in scope. Root may commit
the recovery work and start Assistant details/artifacts.
