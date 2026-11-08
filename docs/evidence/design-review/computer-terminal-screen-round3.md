# Computer and terminal: whole-area review, round 3

Reviewer: Claude Opus 5.5, Anthropic. Requested effort High. The session does
not report a named effort tier, so I cannot confirm the tier from inside the
run. OpenAI Sol implemented the fixes. This is round 3 of 3 and the final
review. One score covers the web Computer panel, both tabs, and the native
iPhone Computer screen. Head `fc41b35` on `nic/full-app-design-review`.

Scope: the diff from `08167e5` to `fc41b35` in `ComputerPanel.tsx`,
`computer.css`, `ComputerView.swift` and `tests/computer-ui.test.ts`, plus the
code those lines call. Round 1 (7.6) is in `computer-terminal-screen-review.md`
and round 2 (8.6) is in `computer-terminal-screen-round2.md`. Areas those
rounds accepted are not reopened, including the direct Terminal routing in
`src/app/view.ts` and `App.tsx`.

Screenshots: `/Volumes/DevSSD/scratch/wildbots-design-review/computer-screen-r3/`.
Crops: `/Volumes/DevSSD/scratch/wildbots-design-review/computer-screen-r3-review/`.
Web coordinates are CSS pixels at 1x. Native coordinates are full-resolution
pixels in `native-Computer.png`, which is 1206x2622. The abstract desktop
canvas, the green "Fixture desktop · Watching" page, the echo-only terminal,
host names and bot ownership are simulated fixture data and are not graded.

## Score: 9.0 / 10, passing

Both round 2 gating findings are fixed in the captures. Round 2's path to 9
asked for those two fixes and no new problems in fresh control and Shell ended
frames. The fresh frames show no new problems. The copy and cleanup items are
done except half of finding 3. The safety behavior earlier rounds approved is
unchanged in the diff: `viewOnly` until a confirmed takeover, input cleared on
lost control, native hand back on leave, reauthentication, and End shell
confirmation.

The leftovers below do not gate the score. Per the three-round limit they go
into the PR as follow-ups, with no fourth review.

## Resolved from round 2

1. **Persistent-shell warning after Shell ended.** Seen.
   `computer-shell-ended-390.png` shows "Shell ended" at y 174 and the target at
   y 196. Nothing sits between the target and the stage, which starts at
   y 220. `computer-shell-ended-1440.png` shows the same at y 274 and y 297.
   `computer-terminal-390.png` y 213 and `computer-end-confirm-390.png` y 213
   still show "Closing this panel keeps your shell running." while connected.
   Source: `ComputerPanel.tsx:503` renders the span only when
   `connection !== "ended"`, so the `role="status"` announcement no longer
   contradicts itself. `tests/computer-ui.test.ts:298` asserts the warning is
   gone in the existing ended-shell test.

2. **Control badge over the remote desktop.** Seen on web.
   `computer-control-390.png` stage x 8-382, y 230-461 has nothing drawn on the
   canvas. `computer-control-1440.png` stage x 149-1291, y 323-803 is also
   clear. Control shows in three places that cover nothing: the toolbar
   headline "You have control" (x 31-123, y 172 at 390), the Hand back button,
   and the accent outline. The enabled key buttons at y 473-515 add a fourth
   cue. No timer or motion was added. Source-only on native:
   `ComputerView.swift:91-95` keeps only the stroke, and no capture shows native
   after Take over.

3. **"Use this viewer" hint.** Source-only, since no capture shows this state.
   `ComputerPanel.tsx:352` and `ComputerView.swift:134` now say "Take over to
   use it here." The headline half of round 2 finding 3 was not done. See
   leftover 2.

4. **Smaller items.** The two `.terminal-tools > span` rules are gone from
   `computer.css`. Seen: `native-Computer.png` x 409-781, y 2325-2365 reads
   "Terminal in Safari", next to "Open in Safari" at x 36-352 on the same row.

## Leftovers, most important first

None of these blocks the score. Each is small.

1. **The control outline is faint where the remote desktop is dark.** Seen.
   Crops: `control-corner-390.png` against `watching-corner-390.png`. Against
   the cream panel, the stage edge in `computer-control-390.png` around x 8,
   y 230-461 reads as a thin green line. Inside, the same 2 px band sits on
   the fixture's black top bar and olive desktop. On a real desktop with a
   dark wallpaper or taskbar at the edge, it nearly disappears. The toolbar
   carries the main signal, so this is polish, not a safety gap.
   Source: `computer.css:91` draws `outline: 2px` at `outline-offset: -2px` and
   an inset 2 px `box-shadow`. Both paint the same inner 2 px band, so one is
   redundant.
   *Fix:* Draw the outline outside the canvas so it always sits on the panel
   color, for example `outline-offset: 0` or `2px` with the inset shadow
   removed. Check that the panel's horizontal padding leaves room so the
   outline is not clipped at 390.

2. **The headline still reads "Watching your desktop session".** Source-only.
   `ComputerPanel.tsx:110`, `ComputerView.swift:140` and
   `tests/computer-ui.test.ts:162`. Round 2 suggested "Your account has
   control" so the line does not read as if the person is watching themselves.
   The new hint "Take over to use it here." makes more sense under that
   headline than under the current one.

3. **No test checks the on-stage control cue anymore.** Source-only. The diff
   deleted the badge assertions at the old `tests/computer-ui.test.ts:145` and
   `:184` without a replacement. The `is-controlling` class and the
   "Shared desktop. You have control." label at `ComputerPanel.tsx:364-365`
   now have no test. A broken condition there would leave the stage
   looking as if it is in Watching mode while the person has input.
   *Fix:* In the takeover test, assert that `.desktop-stage` has
   `is-controlling` after Take over and not after Hand back. In the
   other-member test, assert that it does not.

4. **Native links may truncate with large text.** Source-only.
   `ComputerView.swift:182-186` puts both links in a fixed `HStack`. At default
   size the row ends at x 781 of 1206, about 65% of the width. "Terminal in
   Safari" is nine characters longer than before, and accessibility text sizes
   will truncate or squeeze the row. *Fix:* Wrap the row in
   `ViewThatFits` with a `VStack` fallback. Large text is a coverage gap, so
   this is a risk, not an observed defect.

5. **Leftover from the badge removal in Swift.** Source-only.
   `ComputerView.swift:94` is an empty line inside `if input { }`, and
   `.overlay(alignment: .topTrailing)` at line 91 no longer needs an alignment.
   Cleanup only.

## Coverage gaps

These were not captured or verified, so this review does not grade them:

- Native after Take over, native Hand back and the native outline, native
  gestures, and native taps on the Safari and Terminal links.
- VoiceOver, dark mode and large text on web and native.
- Real browser and native keyboards, the phone soft keyboard over Type text
  and Paste text, the clipboard, and real providers.
- The terminal identity confirmation UI and any real reauthentication.
- Unavailable, refusal, reconnecting, dropped and failed states, including the
  connection overlays and notices.
- This person in control from another window. A unit test covers the copy.
- A remote desktop whose ratio differs from 1.6. The fixture is 1.6, the same
  as the fallback, so the captures cannot tell the measured ratio from the
  fallback. An existing unit test covers a different resolution.
- Live hosts, real shells and real remote desktops. All remote content in the
  captures is simulated.

The agent reported 40 focused checks and both builds passing. This review did
not run tests, builds, the browser or the simulator.
