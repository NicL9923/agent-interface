# Conversation start notice and capture driver recheck

Reviewer: Claude Opus 5.5, high effort. The implementer was OpenAI GPT-6.1 Sol, so this review is cross-provider.
Scope: only the delta between `07-conversation-input.patch` and `08-conversation-input.patch`, plus the code those lines call or are called by. `08-conversation-input.patch` matches `git diff` of the working tree byte for byte. The untracked `capture-design.py` and `conversation-design.json` are not in either patch, so I read them directly. Web, the composers, native code fonts, message metadata and iPad width and layout were settled in reviews 06 and 07 and are not reviewed again.
Evidence: the fresh `after/ipad/conversation-loaded.png`, `-loaded-earlier.png`, `-code-copied.png` and `-draft.png`, all written at 00:35, `annotated/conversation-start-notice.png`, `ipad-conversation-notice.log`, `conversation-driver-final.json`, `conversation-baseline-final.json`, `conversation-driver-final.failed.log`, and one web capture for the sidebar preview. My crops and collage are in `reviews/08-collages/`.
Not performed by me: builds, tests, simulator runs, browser runs, Ruff, the fake CLI check or any interaction. I read the logs and reports only. `ipad-conversation-notice.log` shows `testConversationDesignReview` passing with 1 test and 0 failures, and it points to `.private/ios-test-20261026T053457Z-4791.xcresult`. I did not open the xcresult bundle, and I did not recompute the native source fingerprint.

## Scores

| Surface | Score | Gate |
| --- | --- | --- |
| iPhone conversation | 9/10 | Passes |
| iPhone composer | 9/10 | Passes, unchanged |
| iPad conversation | 9/10 | Passes |
| iPad composer | 9/10 | Passes, unchanged |
| Web conversation and composer | 9 and 9.5, from review 06 | Not reviewed again |

The single blocker from review 07 is fixed, and the delta adds no new issue. iPhone and iPad conversation both reach 9 on the captured states. One honest caveat follows in "Missed by review 07": my earlier sibling list was incomplete. It does not change these scores, because those lines sit in states no capture shows, which is the same rule review 07 applied.

## Resolved from review 07

1. **Start notice contrast. Resolved.** `ConversationView.swift:331` now uses `Palette.muted`. In `after/ipad/conversation-loaded-earlier.png` the notice glyphs sample as `#697268` on `#FAF8F2`, which is **4.70:1**, up from 3.37:1. In dark mode, `Palette.muted` is `#A6B4A7` and the sampled surface is `#1B211E`, which gives 7.57:1. Crop: `reviews/08-collages/crop-ipad-start-notice-after.png`. The notice still reads as a quiet secondary line and is not competing with the transcript.
2. **iPhone notice, from the source.** iPhone and iPad render the same view at the same line, so the source check that review 07 allowed is enough.
3. **Listed siblings, from the source.** Every line review 07 named now uses `Palette.muted`: the live receipt and reasoning (`ConversationView.swift:505`, `:508`), the refused retry and checking notices (`:518`, `:535`), the group count and running label (`ConversationTurnView.swift:93`, `:95`), the reasoning parts and count (`:129`, `:136`), and the three composer notices (`ComposerView.swift:163`, `:172`, `:175`). The composer notices draw inside the raised card (`ComposerView.swift:81`), where `Palette.muted` measures 4.91:1. None of them draw on the user bubble.
4. **Bubble metadata stays separate.** `Palette.messageMetadata` (`#5F685E`, `AvatarView.swift:25`) is still applied only at `ConversationView.swift:616`. Nothing in the delta moved bubble text to `Palette.muted`, which would have dropped it to 4.22:1.
5. **Clean earlier state. Resolved.** `ScreenshotTourTests.swift` now captures `-earlier` right after the first swipe, before the copy and draft steps. The log confirms the order: the swipe at 9.52 s, the `conversation-loaded-earlier` attachment at 12.00 s, "Jump to latest" tapped at 13.54 s, then "Copy code" at 14.28 s. The capture shows an empty composer with the send button disabled and no "Code copied." line. `conversation-code-copied` and `conversation-draft` were recaptured in the same run. They show the copied state at the latest reply and the typed draft with the software keyboard, and they match review 07. Collage: `reviews/08-collages/ipad-loaded-sequence.png`.
6. **Annotation.** `annotated/conversation-start-notice.png` points at the right line, and its 4.7:1 note matches my sample. Its "before" panel is the 23:51 pre-review-07 capture, so it also shows the old proportional code font and a typed draft. The notice comparison is still valid, but that panel is not the review 07 state.

## Capture driver, README and fixture

All five driver items from review 07 are fixed. I verified each from the source and the artifacts.

1. **CLI resolution. Fixed.** `capture-design.py:37-38` uses `shutil.which("playwright-cli")` first and falls back to `npm exec --yes --package=@playwright/cli@0.1.22`. The pinned fallback can still download 0.1.22 on a clean machine, but it can no longer drift to a later version.
2. **Report safety. Fixed.** The CLI writes to a `NamedTemporaryFile` in `--root`, which is on the SSD. The driver parses the JSON and reads `paths` and `geometry` before `replace` renames it over the report (`:41-48`). On any failure it moves the output to `{name}.failed.log` and leaves the previous report alone (`:49-53`). The artifacts agree. `conversation-driver-final.failed.log`, from 00:36, holds the pinned CLI's "browser 'wildbots-design' is not open" error. `conversation-driver-final.json`, from 00:37, is the later good run.
3. **Screen choices. Fixed.** `screens` comes from the `*-design.json` names in `.agents/fixtures` (`:12`) and feeds `choices`, so a typo or `../x` is rejected with usage help.
4. **README order. Fixed.** The `capture-design.py` entry now sits directly under `capture-design.js`. It names the PATH-first lookup, the 0.1.22 pin, how a failed run is handled, and the session-ownership rule.
5. **Fixture preview. Fixed.** `bots[0].lastMessage.text` equals the transcript's last message text exactly, and its time is `2026-10-25T19:05:00Z`, which matches that message's `createdAt`.
6. **Baseline contrast.** `capture-design.js:91` throws only when `stage !== "before"` and still records the ratio. `conversation-baseline-final.json` records 4.22:1 for light metadata and 5.57:1 for dark. `conversation-driver-final.json` records 4.89:1 and 5.57:1. Both reports have 18 screenshots and no overflow entries.

Session ownership: the pinned `npx` package resolves to a different session namespace, so the driver fell back to the CLI that already owned the browser, by putting that CLI on PATH. That failure is loud, not silent, and the README now covers it. I can't verify from here that no browser restart happened. The failed log and the later passing report are consistent with that account.

## Not blocking

1. **A stale `.failed.log` survives a later success.** `conversation-driver-final.failed.log` now sits next to a good `conversation-driver-final.json` with the same name. Someone scanning the directory could read it as the current state. Delete `{name}.failed.log` after a successful rename.
2. **A misspelled `AGENT_INTERFACE_DESIGN_VARIANT` passes with no captures.** The `where selection.isEmpty || selection == name` filter (`ScreenshotTourTests.swift:114`, and the same pattern at `:31`) runs zero iterations for an unknown name, so the test passes and writes nothing. Assert that the selection is empty or one of the three names before the loop.
3. **The web sidebar preview shows raw list markers.** With the exact transcript text, the web sidebar reads "Take these along: - Water for everyone and a little extra - Hats,…" (`reviews/08-collages/crop-web-sidebar-preview.png`). The fixture is now correct, so this is how a real Markdown reply previews. It belongs to the settled sidebar and Home work, not this gate. It's worth stripping Markdown markers from previews in a later pass.

## Missed by review 07

My sibling list in review 07 was incomplete. These lines in the same three files still use `.secondary` (about 3.37:1 on the light surface) for small text, in states that no capture shows:

- `ConversationView.swift:376` and `:381`: the empty-conversation description at body size, and its unsupported-chat footnote. This shows for every new assistant, so it is the most visible one.
- `ConversationView.swift:995` and `:1008`: `ShimmerText`, the live activity line. With Reduce Motion on, it draws as plain `.secondary` footnote text.
- `ConversationView.swift:123` (the saved-copy banner), `:657` (the "Agent message" label), `:687` (the tool waiting footnote), `:779` (the attention request footnote, on the raised card) and `:792` ("Choose any that apply.").
- `ConversationTurnView.swift:154`: the approval expiry caption.
- `ComposerView.swift:350`: the drop overlay footnote, on a 94 percent surface.

These are outside this delta and are not scored, the same way review 07 treated uncaptured states. I am listing them because I said "fixing only the visible one would leave the same failure one state away", and my list itself missed some. Moving them to `Palette.muted` is a one-line change each. I recommend doing it before the final full-app sign-off, with the empty state first. Leave the decorative disclosure chevron at `ConversationTurnView.swift:283` as it is. It is an icon next to a full-contrast label.

## Preserved limitations

These come from reviews 05 to 07 and still stand: "Jump to latest" overlaying text in mid-scroll captures, the AX3 send arrow nearly filling its circle, the platform differences in "Worked for" formatting, code that scrolls horizontally at AX3, "Code copied." staying visible on both platforms, the composer placeholder sitting 20 pt inside the text edge on native, iPad lines running about 99 characters, the table cell inset, the glyph test checking the font constant rather than the view, `ToolOutputView` having no visual check, and no software-keyboard claim for iPhone. The iPhone captures were not rerun in this round. Their review 07 scores and findings still apply.

## Verdict

The Conversation screen passes on iPhone and iPad at 9, and both composers stay at 9. The start notice measures 4.70:1 in the fresh iPad capture. Every caption review 07 listed now uses `Palette.muted`, and bubble metadata keeps its darker color. The earlier-state capture is clean. The driver fixes are all in place and match the artifacts. In this delta I found no remaining issues that block the gate. Before final sign-off, the uncaptured `.secondary` captions above should get the same one-line fix, and the two small driver and test guards are cheap to add.
