# Computer and terminal: whole-area review, round 2

Reviewer: Claude Opus 5.5, Anthropic. Requested effort High. The session
reports a numeric reasoning setting that does not map to a named tier, so I
cannot confirm the tier from inside the run. OpenAI Sol implemented the fixes.
Round 2 of at most 3. One score covers the web Computer panel, both tabs, and
the native iPhone Computer screen. Head `08167e5` on
`nic/full-app-design-review`.

Scope: the diff from `1b9a8f7` to `08167e5` in `ComputerPanel.tsx`,
`computer.css`, `App.tsx`, `app/view.ts`, `ComputerView.swift` and
`tests/computer-ui.test.ts`, plus the code those lines call. Round 1 is in
`computer-terminal-screen-review.md`. Areas round 1 marked as meeting the bar
are not reopened.

Screenshots: `/Volumes/DevSSD/scratch/wildbots-design-review/computer-screen-r2/`.
Crops: `/Volumes/DevSSD/scratch/wildbots-design-review/computer-screen-r2-review/`.
Web coordinates are CSS pixels at 1x. Native coordinates are full-resolution
pixels in `native-Computer.png`, which is 1206x2622. The desktop canvas, the
native "Fixture desktop · Watching" page, the terminal banner, host names and
bot ownership are fixture data and are not graded.

## Score: 8.6 / 10, not yet passing

Round 1 scored 7.6. Every round 1 issue from 1 to 8 is fixed in the captures or
the source, and most of item 9 is done. The terminal has no black strip at
the bottom at either width. The phone desktop stage now fits the desktop, so
the key buttons sit right under it at y 473-515 in `computer-control-390.png`.
Taking control adds an outline and a badge. The persistent-shell warning sits
under the target, next to End shell. The phone End shell confirmation keeps
both choices on one row, with equal widths. The native Terminal link opens the
Terminal tab without attaching the desktop. The disabled Take over has a hint
that matches it. The safety behavior round 1 approved is unchanged:
`viewOnly` until a confirmed takeover, input cleared on lost control, native
hand back on leave, and End shell confirmation.

Two problems keep the score under 9. Both are visible in the new captures, and
both are small fixes. The move of the persistent-shell warning left it showing
after the shell has ended. The new control badge covers the top-right corner of
the remote desktop on a phone, which is where browser menus and window
controls live.

## Findings, most important first

1. **"Closing this panel keeps your shell running" shows after the shell ended.**
   Visible: `computer-shell-ended-390.png` x 31-269, y 207-221, directly under
   "Shell ended" at y 172. `computer-shell-ended-1440.png` shows the same at
   x 172-410, y 309-322. Crops: `shell-ended-status-390.png` and
   `shell-ended-status-1440.png`. The status line says the shell ended and, one
   line down, says closing the panel keeps it running. The overlay at y 500
   then offers Start terminal.
   Source: `ComputerPanel.tsx:504` renders the `terminal-persistence` span for
   every connection state. It sits inside the `role="status"` element, so a
   screen reader reads the contradiction in the "Shell ended" announcement
   too. Round 1 did not catch this because the warning was in the tools row
   and no Shell ended frame existed.
   *Fix:* Render the span only while `connection !== "ended"`. Keep the
   wording and placement for the other states. Add one assertion to the
   existing Shell ended test that the warning is gone.

2. **The control badge covers the remote desktop's top-right corner on a phone.**
   Visible: `computer-control-390.png` x 260-372, y 240-264. Crop:
   `control-badge-390.png`. At 390 the canvas fills the stage width, so the
   badge sits on the desktop itself. On a real desktop, a maximized Chrome
   window puts its menu, profile and extension buttons there, and the window
   close button sits at the same edge. `pointer-events: none` at
   `computer.css:94` lets taps through, but the person cannot see what they are
   tapping. At 1440, `computer-control-1440.png` x 1169-1281, y 333-358 puts the
   badge on the pillarbox, so it is harmless there. Any panel narrower than the
   desktop's aspect ratio letterboxes vertically and covers content again.
   The outline at `computer.css:93` already marks control without covering
   anything, and the toolbar headline at x 31-123, y 172 says "You have
   control".
   *Fix:* Keep the outline and move the label off the canvas. One option: when
   `controlling` is true, render the badge in the stage's top margin as a tab
   attached to the outline, outside the canvas area. Another: fade the badge
   out after about 3 seconds and keep the outline, with no fade under
   `prefers-reduced-motion`. Either keeps the cue where the person looks.
   Native has the same overlay at `ComputerView.swift:91-97`. It is lower risk
   there because the native stage is tall and a landscape desktop letterboxes
   above the badge, but apply the same rule. Code-only for native: no capture
   shows native after Take over.

3. **"Take over to use this viewer." uses an internal word.** Code-only. No
   capture shows this state, though a unit test asserts the headline.
   Source: `ComputerPanel.tsx:352` and `ComputerView.swift:136`. "Viewer" is
   the code's name for an attachment (`viewerId`). A person thinks in windows,
   tabs or screens. The headline "Watching your desktop session" at
   `ComputerPanel.tsx:110` and `ComputerView.swift:142` is honest about what
   the server knows, but "your desktop session" reads like the person is
   watching themselves. The server knows that this account holds the desktop
   and this attachment does not.
   *Fix:* Headline "Your account has control". Hint "Take over to use it
   here." Both are true whether the lease belongs to another window or to this
   window before a reconnect. Update the assertion in
   `tests/computer-ui.test.ts`.

4. **Smaller items.**
   - Code-only: `computer.css:54` and `computer.css:78` still style
     `.terminal-tools > span`. The warning left that row, so no span matches
     anymore. Delete both rules.
   - `native-Computer.png` x 406-629, y 2325-2365 still reads "Terminal".
     Round 1 suggested "Terminal in Safari" so the visible label says it
     leaves the app. Only the accessibility hint at `ComputerView.swift:186`
     says so. Optional.
   - The initial focus ring now lands on the selected tab, which is the right
     target. It shows as a full box at `computer-watching-1440.png`
     x 145-261, y 194-253 and `computer-terminal-link-390.png` x 112-229,
     y 97-156. Chromium shows `:focus-visible` for focus set by script when the
     person has not yet interacted with the page, which happens on a cold load
     such as the native Terminal link. After a tap or click, it usually does
     not show. This uses the app-wide focus style, so leave it.

## Resolved from round 1

- Item 1, black terminal strip: gone in `computer-terminal-1440.png` at
  y 831-851 and `computer-terminal-390.png` at y 742-778. `computer.css:92`.
- Item 2, phone dead space: the stage follows the canvas aspect, capped at
  `60dvh`, `computer.css:97`. The observer at `ComputerPanel.tsx:293-299` is
  cleaned up with the attachment. noVNC 1.7 watches its container with
  `ResizeObserver`, so the canvas rescales when the stage changes. The fixture
  desktop is 1.6, the same as the fallback, so the captures cannot show the
  measured ratio in use. The unit test covers it.
- Item 3, control cue on the stage: present. See finding 2 for the badge
  placement.
- Item 4, small text: secondary text is 12 px and the phone host label is
  11 px. The warning sits under the status line next to End shell.
- Item 5, native Terminal link: `/?computer=1&computerTab=terminal` maps to
  `{ kind: "computer", tab: "terminal" }` in `app/view.ts`, and the panel
  opens on Terminal. `computer-terminal-link-390.png` shows it selected and
  connected. The desktop attaches only on first visit. Source-only for the
  native tap.
- Item 6, hint for a disabled Take over: `computer-other-member-390.png`
  x 31-264, y 196 reads "Take over is available after they hand back." next
  to the disabled button.
- Item 7, phone End shell confirmation: `computer-end-confirm-390.png`
  y 245-312. The message is on its own row, and Keep shell and End this shell
  share the next row with equal widths.
- Item 8, initial focus: moved from Close to the selected tab.
- Item 9: Type text and Paste text show the selected style when open
  (`computer-type-390.png` x 12-87, y 473-515). The touch-safe "Select a
  field" wording is in place. Send text is pinned right in both forms. The
  headlines use one style. The subtitle is short enough to fit on one phone
  line.

## Path to 9

Fix findings 1 and 2. Finding 1 is a one-condition change plus one test
assertion. Finding 2 moves or fades one element on web and native. With both
done and no new problems in a fresh `computer-control-390.png` and
`computer-shell-ended-390.png`, this area reaches 9. Findings 3 and 4 are
copy and cleanup. They are worth doing in the same pass but do not gate the
score.

For round 3, recapture `computer-control-390.png`, `computer-control-1440.png`
and `computer-shell-ended-390.png`. Add a native frame after Take over if the
machine lock allows it. Other frames from round 2 stay valid unless their UI
changes.

## Coverage gaps

These were not captured or verified, so this review does not grade them:

- The terminal identity confirmation UI and any real reauthentication.
- Unavailable, refusal, reconnecting, dropped and failed states on web and
  native, including the connection overlays and notices.
- This person in control from another window. A unit test covers the copy.
- Native after Take over, native Hand back, the native outline and badge, and
  native taps on the Safari and Terminal links.
- A remote desktop whose aspect ratio differs from 1.6, and a portrait one
  that hits the `60dvh` cap.
- Real browser keyboard input, native touch and keyboard input, VoiceOver,
  dark mode, large text and the clipboard.
- Live hosts, real shells, real remote desktops and providers.
- The phone soft keyboard over the Type text and Paste text forms.
