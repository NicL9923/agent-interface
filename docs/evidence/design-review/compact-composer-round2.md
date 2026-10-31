# Compact composer and #206 follow-ups: review, round 2

Reviewer: Claude Opus 5.5, Anthropic. Requested and configured effort High.
The session reports a numeric reasoning value that does not map to a named
tier. I do not read that as a lower tier. OpenAI implemented every product
change in this round, so this is a cross-provider review. Round 2 of at most
3. Head `9113d12` on `nic/design-followups-compact-composer`, draft PR #208.

Scope: product changes in `b630d93..9113d12`, the code they call or are
called by, and the render regions they change. Settled and excluded: the
Anthropic shared-text work that Sol reviewed, the rest of the branch already
covered in round 1, and capture tooling, hashes and proofs.

Method: source reads and saved images only. No tests, builds, browser or
simulator runs. Evidence root:
`/Volumes/DevSSD/scratch/wildbots-design-review/followups-composer/`. I built
my collages from the current raws in `review-round2/`. They have no text
labels because this ffmpeg build has no `drawtext`. Grid order:

- `static-390-320.png`: row 1 is idle, draft, long-line and multiline at 390. Row 2 is the same at 320.
- `static-768.png` and `static-1440.png`: idle and draft, then long-line and multiline.
- `states-390.png`: row 1 is recording, transcription-error, transcribed, speaking, audio-ready and upload-error. Row 2 is upload-retried, large-paste, ime, advanced and offline.
- `states-1440.png`: the same 11 states, four per row.
- `attach-align-zoom.png`: idle Attach button, 1440 on top and 390 below.

The web renders are from 18:40 to 18:41. `452ddfe..9113d12` changes no web
source, so they match head.

**Native evidence status.** Every `native-*.png` in `after/` comes from
`b630d93`. `native-Groups.png` and `native-Notifications.png` still show the
Widget preview page. The rebuild is queued behind the machine lock, and
`native-ComposerAX3Focused.png` does not exist yet. All native changes below
are **SOURCE-ONLY**. I make no claim that native icons, AX3 line limits,
replay, Groups scrolling or batching were recaptured.

Labels: **pixels** means seen in a current render, **source** means verified
only in code.

## Round 1 items

| Item | Status | Basis |
| --- | --- | --- |
| C1, measure span causes page overflow | **Fixed** | Pixels and source. `.composer` is `position: relative`. The span sits inside `.composer-measure-box`, which is `absolute; inset: 0; overflow: hidden`, so it no longer adds scrollable overflow. As an inline-block with `white-space: pre`, the inner span still reports its full max-content width to `getBoundingClientRect`. Only `slice(0, 201)` reaches the DOM, and 201 characters is past the `> 200` stacking threshold in `composer-layout.ts:5`. The `long-line` fixture is a 152-character single line. It renders without clipping at 1440, 768, 390 and 320, and the capture's `scrollWidth > innerWidth` guard passed for every shot. |
| C2, recipient targets | Fixed | Source. `experience.css:159` is back to 44 px. I accept the note that the saved-routine card already stays mounted. |
| C3, Artifacts empty fallback | Fixed, one leftover | Source. The ref is gone, and `reloading={!current}` shows a truthful message. The caller still mounts only with `ownConversation`. See N3. |
| C4, Home and Today tokens | Fixed | Source. Each handler sets its token back to nil, and the nil write only re-runs a guarded no-op. Store-only tests in `AssistantSurfaceTests` and `TranscriptFeatureTests` compare `conversationRequest` and never mount `RootView`, so they are unaffected. |
| C5, dead CSS and 621 to 900 px padding | Fixed | Pixels at 768: the card uses the same 6/12/8 dock as the other widths. The dead selectors are removed. |
| C6, keyboard order | Fixed | Source. `.composer-tools` now comes before the textarea in a static JSX position, so React never remounts the textarea. No CSS sibling selector depended on the old order. The grid areas keep the visual layout. |
| 1, persistent "Play audio" row | **Fixed** | Pixels. `audio-ready` at 1440 and 390 is back to the 54 px idle pill, and nothing sits under the controls in `upload-*`, `large-paste` or `ime`. The new test covers replay without a second provider request and drops audio when the reply id changes. |
| 2, speaker crowds the draft at 390 | Improved as designed | Pixels. At 390 the speaker hides once the draft has text. You can see this in `recording`, `transcription-error` and `transcribed`. The 37-character sample still stacks at 98 px, which is correct for an inline slot of about 214 px. |
| 3 and 5, clipped placeholder | Fixed on web, source-only on native | Pixels on web: "Message…" fits at every width. The label still reads "Message {name}". On native the source shows the same short placeholders, and the label keeps the assistant name. |
| 4, AX3 glyph overlap | **SOURCE-ONLY** | The mic, speaker, attach and hide-keyboard glyphs are a fixed 20 pt in 44 pt frames. Send was already capped at `min(sendGlyphSize, 24)` in `b630d93`. The fix looks correct but has no render yet. |
| 6, small voice text | Fixed | Pixels. "Recording", "Speaking" and the transcription error now match the 13 px attachment error. |
| 7, AX with keyboard and multiline | **SOURCE-ONLY** | `maximumLines` is 3 when `isAccessibilitySize`. `ComposerAX3Focused` will show the result once it is captured. |
| 8, missing 621 to 900 px capture | Fixed | Pixels at 768. |

## Code review of newly changed code

**Native Groups (`CollaborationViews.swift:378`).** Correct, source only.
`more` is `page.has_more` from the forward cursor (`:535`), and "Load more
messages" sits below the list (`:346`). Skipping `scrollToLatest` when more
pages exist matches the web rule for forward-paged rooms.

**Debug fixture (`DebugFixtures.swift:68`).** An empty survival mode now
returns nil. That is correct and debug-only.

**Web replay (`VoiceControls.tsx:64-69`).** It is correct for the case it
targets, and the generation bump makes an in-flight `speak` ignore its own
result. See N2 for one side effect.

## Remaining issues, none blocking

- **N1. Pixels, web at 621 px and up. Attach sits about 5 px below the mic and speaker in the inline layout.** `.composer-tool` gets `min-height: 44px` only inside the 620 px block (`styles.css:1243`). Wider, it is 34 px tall, and the grid's `align-items: end` puts its glyph lower than the 44 px voice buttons. See `attach-align-zoom.png` (top) and every idle or draft frame at 1440 and 768. This predates the round, but it is the most visible flaw left on desktop. Smallest fix: move `min-width: 44px; min-height: 44px; justify-content: center` onto the base `.composer-tool` rule.
- **N2. Source, web. Any switch of `reply` to undefined drops the cached audio.** `App.tsx:261` passes `undefined` whenever the conversation is active, and the effect keys on `reply?.id`. So a short run that adds no reply, such as a routine or a brief `waiting`, discards replayable audio. The next tap then makes a fresh provider request. If the run starts during playback, playback also stops with no message. Smallest fix: keep a ref to the spoken id and act only when `reply` is defined and its id differs.
- **N3. Source, unreachable today.** When `reloading` and `unavailable` are both true, `ArtifactsView` shows two status lines that say about the same thing. Suppress the reload line when `unavailable` is set. This is low priority because `BotDetails` never mounts the button without a conversation.
- **N4. Source, native.** `ComposerView.swift:101` hides the speaker whenever the draft has text, at every size class. Web does this only at 620 px and below. On iPad, and on iPhone in landscape when the size class is regular, the button disappears with plenty of room. Gate it on `horizontalSizeClass == .compact` if parity matters.
- **N5. Source, native. Fixed 20 pt glyphs no longer scale with Dynamic Type.** That is a reasonable choice for 44 pt toolbar-style targets. Consider `.accessibilityShowsLargeContentViewer()` on those four buttons so AX users can still read them by long-pressing.
- **N6. Pixels, deliberate.** At 320 px the empty composer stacks at 98 px, because `@media (max-width: 359px)` forces the stacked layout (`styles.css:1460`). This was already true at `b630d93`. Allowing the inline layout when empty would give back 44 px on the smallest phones. Optional.
- **N7. Source, minor.** `.composer-measure` copies `font` but not `letter-spacing`. That predates this round and matters only if the textarea ever sets letter-spacing.

## Fixture artifacts, not graded

- **F1.** In `ime-1440` and `ime-390` a "Pasted text.txt" chip is still attached. The capture removes chips with `/^Remove pasted/`, but the file is named "Pasted text.txt" (`src/app/large-paste.ts:10`), so the case-sensitive regex matches nothing. The stacked, taller IME card is the CDP composition artifact already noted as E3 in round 1.
- **F2.** Round 1's E2 is resolved. The chip and the notice both read 34 KB, and the retried upload reads 35 B.

## Composer score: 9.1 / 10, round 2 of 3, passing

This rates the whole composer. The web part is verified in pixels at 1440,
768, 390 and 320 across 15 states. The native part is rated from source
alone, because its renders are stale. The original blocker C1 is fixed and
holds up in a 152-character render at every width. Every round 1 pixel issue
on web is fixed. The cards now read as one compact system: 54 px idle, inline
short drafts, a clean stacked layout for long or multiline text, transient
voice states that collapse back, and readable 13 px errors. I found no new
regressions in pixels. N1 is the most visible remaining flaw. N2 is a small
behavioral edge case.

The native items, the AX3 glyphs, the AX focused multiline case, Groups and
the batching row, have no current renders. The source changes are what the
round 1 fixes called for. Treat the score as conditional: before marking
#208 ready, the parent's manual check of the rebuilt `native-Composer*`,
`native-ComposerAX3Focused`, `native-Groups` and `native-Notifications`
captures must confirm them. If those show glyph overlap, a clipped AX card or
the wrong page again, that check reopens the score.

No blockers. N1 and N2 are worth taking if a final round happens anyway.
