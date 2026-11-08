# Computer and terminal: whole-area review, round 1

Reviewer: Claude Opus 5.5, High, Anthropic. OpenAI Sol and Terra implemented
the work. Round 1 of at most 3. This review gives one score for the web
Computer panel, both of its tabs, and the native iPhone Computer screen
together. It does not grade each capture. Head `6088159` on
`nic/full-app-design-review`, PR 207. This is a baseline: the branch has no
design fixes for this area yet.

Screenshots: `/Volumes/DevSSD/scratch/wildbots-design-review/computer-screen-r1/`.
Crops: `/Volumes/DevSSD/scratch/wildbots-design-review/computer-screen-r1-review/`.
Web coordinates are CSS pixels, and the web captures are 1x. Native coordinates
are full-resolution pixels in `native-Computer.png`, which is 1206x2622.

The desktop canvas, the native "Fixture desktop · Watching" page, the terminal
banner, host names and bot ownership are fixture data. This review grades the
app chrome, layout and controls around them, not the remote content.

## Score: 7.6 / 10, not yet passing

The area gets the hard parts right. Every frame states who holds the desktop.
The panel stays read-only until Take over, and the four key buttons stay
disabled until then. Hand back is a quiet secondary button, so it is easy to
tell apart from Take over. The terminal names the signed-in target, warns that
the shell persists, and puts End shell behind a confirmation. That
confirmation leads with Keep shell and marks End this shell in red. Native
matches the web's ownership copy and Take over placement, and it hands back
when the screen goes away.

The score is held down by visible polish defects and a few gaps. Every terminal
frame has a pure black strip under the last row. On a phone, half of the
desktop stage is empty black. The control state has no cue on the desktop
itself. Most secondary text, including the persistent-shell warning, is 11 px.
Two source-only problems remain: the native Terminal link opens the Desktop
tab, and the hint tells people to take over while Take over is disabled.
Each fix is small, and none needs backend work.

## Issues, most important first

1. **A pure black strip sits under the last terminal row.**
   Visible: `computer-terminal-1440.png` x 163-1281, y 831-843, about 12 px
   tall. The same strip shows in `computer-end-confirm-1440.png` at the same
   place. `computer-terminal-390.png`, `computer-paste-390.png` and
   `computer-end-confirm-390.png` show a thinner strip at x 16-376 near
   y 742-748. Crops: `terminal-bottom-1440.png` and `terminal-bottom-390.png`.
   It is `#000` against the `#151c18` terminal, so it reads as a rendering
   glitch at the bottom of every shell.
   Likely cause: FitAddon leaves less than one row of height unused, and
   `@xterm/xterm/css/xterm.css:93-95` paints `.xterm .xterm-viewport` with
   `background-color: #000`. The theme at `ComputerPanel.tsx:414` sets the
   terminal background but does not reach that CSS default.
   `computer.css:49-51` adds padding around it but does not override it.
   *Fix:* Add `.computer-terminal .xterm-viewport { background-color: #151c18; }`
   to `computer.css`, or use a shared custom property with the theme value.
   Recapture one terminal frame at each width.

2. **On a phone, half the desktop stage is dead space.**
   Visible: `computer-watching-390.png` and `computer-control-390.png`. The
   stage runs from y 238 to 718, which is 480 px. The 16:10 desktop fills only
   y 360-595. About 245 px of black sits above and below it, and the key
   buttons are pushed to y 731-771. `computer-type-390.png` shows the same
   stage shrunk to y 238-509 once the text form opens, so a smaller stage
   works. Source: `computer.css:38` gives `.computer-screen-wrap` `flex: 1`,
   and `ComputerPanel.tsx:285` uses `scaleViewport`, so the canvas letterboxes
   inside whatever height is left. At 1440 the pillarboxing at x 149-333 and
   x 1107-1291 is acceptable, because the panel is wide.
   *Fix:* At `max-width: 620px`, size the desktop stage to the desktop's aspect
   ratio instead of the leftover height. The canvas size is known after
   `connect` from the canvas noVNC creates inside `.computer-screen`, so this
   is client-only. A CSS fallback such as `aspect-ratio: 16 / 10` covers the
   connecting state. Keep the terminal stage as it is; a tall terminal is
   useful.

3. **Taking control changes nothing on the desktop itself.**
   Visible: compare `computer-watching-1440.png` with
   `computer-control-1440.png`. Only the headline at x 172-432, y 268-283,
   the hint below it, the button at x 1191-1285, y 264-308, and the enabled
   key buttons change. The canvas at y 323-806 looks identical. The status dot
   at x 158, y 275 is the same green in both. Source:
   `ComputerPanel.tsx:338` ties the dot to the connection, not to who holds
   the desktop. The phone frames show the same. While the user has control,
   assistants are paused and their clicks reach a shared machine. That mode
   should be visible where they are looking, which is the canvas.
   *Fix:* When `controlling` is true, give `.computer-screen-wrap` a 2 px
   accent outline and show a small "You have control" chip in a corner of the
   stage. Keep the existing text and `aria-label` at `ComputerPanel.tsx:348`.
   Native could use the same outline on `screen` in `ComputerView.swift:133-153`.

4. **Most secondary text is 11 px, including the persistent-shell warning.**
   Visible: `computer-terminal-1440.png` x 1071-1289, y 878-889 shows "Closing
   this panel keeps your shell running." It is small, muted, and pushed to the
   far right, away from End shell. The ownership hint at y 297, the desktop
   footnote at x 155-541, y 894, and the form hints use the same size. The
   host label "Preview computer" in `computer-watching-390.png` x 298-380,
   y 144 is 10 px. Source: `computer.css:34`, `:44`, `:54` and `:58` set
   `0.6875rem`, and `:69` sets `0.625rem`. `--muted` passes contrast against
   `--raised`, so size is the problem, not color.
   *Fix:* Raise these to `0.75rem` and the phone host label to `0.6875rem`.
   Move the persistent-shell warning under the toolbar status line on desktop
   widths, next to End shell, or keep it left-aligned beside the terminal
   tools. Keep the wording.

5. **The native Terminal link opens the Desktop tab.** Source-only. I did not
   click the link.
   Visible: `native-Computer.png` x 37-629, y 2320-2370 shows "Open in Safari"
   and "Terminal" side by side. Source: `ComputerView.swift:167-171` points
   both links at `/?computer=1`. `src/app/view.ts:17` maps that to
   `{ kind: "computer" }`, and `ComputerPanel.tsx:116` always starts on
   `"desktop"`. A person who taps Terminal lands on the desktop and must find
   the Terminal tab. The visible label also does not say it leaves the app;
   only the accessibility hint at `:171` does.
   *Fix:* Add a terminal destination such as `/?computer=terminal`, map it in
   `initialPanel`, and pass the starting tab into `ComputerPanel`. Label the
   native link "Terminal in Safari" so both links say where they go. Terminal
   reauthentication still happens in the browser, as before.

6. **The hint says "Take over" when Take over is disabled.** Source-only. No
   capture shows these states.
   Source: `ComputerPanel.tsx:339` shows "Take over to use the mouse and
   keyboard." whenever this tab is not controlling. When another household
   member holds the desktop, `:342` disables Take over, so the hint tells the
   person to do something they cannot do. Native repeats this at
   `ComputerView.swift:114`. When this person holds the desktop from another
   screen, `ownerLabel` at `:109` already says "Watching. Take over to control
   the desktop.", so the headline and hint repeat the same instruction.
   *Fix:* Choose the hint from the same state as the button. Another member in
   control: "Take over is available after they hand back." This person holds
   it elsewhere: "You have control in another window." Keep "Take over to use
   the mouse and keyboard." for idle and assistant control. Apply the same
   mapping in `Models.swift:761-769` and `ComputerView.swift:114`.

7. **The end-shell confirmation breaks apart on a phone.**
   Visible: `computer-end-confirm-390.png` y 238-358. The message and Keep
   shell share the first row at y 250-293. End this shell wraps alone to the
   left of a second row at y 302-345. The two choices end up in different
   corners. At 1440, `computer-end-confirm-1440.png` x 1088-1285, y 333-377
   keeps them together and reads well. Source: `computer.css:60-62` wraps a
   flex row whose message has `min-width: 180px`.
   *Fix:* At `max-width: 620px`, put the message on its own row and both
   buttons on the next row, with End this shell last. Keep the order, the
   danger style and `role="alert"` at `ComputerPanel.tsx:489`.

8. **The dialog opens with a heavy focus ring on Close.**
   Visible: `computer-watching-1440.png` x 1233-1288, y 100-154, and
   `computer-watching-390.png` x 325-381, y 12-66. A thick accent ring makes
   Close the strongest element on open, ahead of Take over. Crop:
   `close-focus-1440.png`. Source: `ComputerPanel.tsx:169-172` passes
   `fallbackFocus` but not `initialFocus`, and `ui/dialog.tsx:9` supports it.
   *Fix:* Pass `initialFocus` for the selected tab,
   `#computer-tab-desktop` or `#computer-tab-terminal`. Focus then starts at
   the top of the panel's working controls, and Escape still closes it.

9. **Smaller copy and state details.**
   - `computer-type-390.png` x 12-87, y 521-562: Type text has
     `aria-expanded="true"` at `ComputerPanel.tsx:355` but looks the same as
     the other buttons. Give expanded tool buttons the selected style.
   - `computer-type-390.png` y 690: "Click a field on the desktop first." is
     wrong on touch. "Select a field on the desktop first." works for both,
     `ComputerPanel.tsx:370`.
   - `computer-type-390.png` x 12-93, y 711-754 puts Send text on its own row
     at the left. `computer-paste-390.png` x 297-378, y 770-813 puts it at the
     right. Pin the submit button right in both forms at
     `computer.css:57`, and let the hint wrap above it.
   - The headline "Watching. Assistants can use this computer." ends with a
     period, and "You have control" does not, `ComputerPanel.tsx:107-112`.
     Pick one style.
   - On a phone the title block takes y 0-118 before the tabs, and the
     subtitle wraps "shell." onto its own line at y 98. Hide the subtitle at
     `max-width: 620px` or shorten it, so the stage gets the space.

## What already meets the bar

- Read-only until Take over: the key buttons are disabled while watching at
  `ComputerPanel.tsx:355-358`, and `viewOnly` stays true until the server
  confirms, `:322-330`.
- Lease fencing: losing ownership clears local input at once on web, `:301-306`,
  and on native, `ComputerView.swift:329-335`.
- Native hands back on leave after any pending takeover settles,
  `ComputerView.swift:337-353`.
- Terminal input is never queued across reconnects, `ComputerPanel.tsx:388-391`.
- End shell asks first, offers Keep shell first, and disables both while
  ending, `:487-493`.
- Tabs follow the ARIA tabs pattern with arrow, Home and End keys, `:181-190`.
- Phone targets meet 44 px, `computer.css:21`, `:30` and `:77`.
- Native wording matches web, including "You have control" and "Assistants are
  paused while you use the desktop."

## Path to 9

Fixes 1 to 5 move this area to about 9 if the recaptures show no new
problems. Fix 1 is a one-line CSS change. Fix 2 changes only the phone stage
size. Fix 3 adds an outline and a chip. Fix 4 changes type sizes and one
placement. Fix 5 adds one query value and a starting-tab prop. Fixes 6 to 8
are small and worth doing in the same pass. Item 9 is optional polish.

For round 2, recapture the same ten web frames and the native frame, plus a
web Shell ended frame and a native frame after Take over.

## Coverage gaps

These were not captured, so this review does not grade them:

- The terminal identity confirmation UI, `ComputerPanel.tsx:218-252`.
- Unavailable, refusal, reconnecting, dropped and failed states on web and
  native, including the connection overlays and `computer-notice`.
- The Shell ended frame. The run asserted that state, but there is no
  screenshot of its overlay or Start terminal button.
- Another member in control, and this person in control from another window.
- Native after Take over, native Hand back, and the native Safari and Terminal
  links. They were not tapped.
- Real browser keyboard input, native touch and keyboard input, VoiceOver,
  dark mode and large text.
- Live hosts, real shells, real remote desktops, the clipboard and providers.
- The phone soft keyboard over the Type text and Paste text forms.
