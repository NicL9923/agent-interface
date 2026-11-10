# November 10 composer above a phone's on-screen keyboard

Branch `composer-keyboard-viewport` over `06d0660`, code state `a622626` plus this entry and its
evidence. Written on NicolasLaptop (Fedora, Linux x64), Node 24.22.2, Playwright Chromium. No
Hermes took part.

## What changed

- `index.html` adds `interactive-widget=resizes-content` to the viewport meta.
- `src/app/keyboard-viewport.ts`, installed from `src/main.tsx`, sizes `.app-shell` to the visual
  viewport while it is shorter than the layout viewport at normal scale, and leaves it alone while
  the page is pinch-zoomed.
- `.composer-area` drops the home-indicator inset while that is in effect, and its notice dock
  shrinks and scrolls before the message box is cut off.
- The transcript also observes its own scroll view, so a shrinking view re-places it by mode.
- Send and Stop prevent mousedown's default, so a press leaves focus in the message box.

## Application tests

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/keyboard-viewport.test.ts tests/transcript-ui.test.ts tests/shell-ui.test.ts`:
  3 files, 140 tests passed.
- `npm test`: 176 files, 2791 tests passed. This run predates the notice-dock CSS commit, which
  changed only CSS that jsdom does not lay out.
- `npm run build` passed.
- `npm run test:e2e`: the first run had 6 passed and 2 failed, both service-worker deploy tests
  (`smoke.spec.ts:129` and `:159`) that touch nothing this branch changed. Another worktree was running
  its own e2e and builds at the time. The next three runs each passed 8 of 8.

### Red proof

Each line was broken by hand, the named test went red, and the line was restored:

- `src/app/use-conversation.ts`, removing `if (element) observer.observe(element);`: "keeps a
  follower at the latest message" failed, 1700 where 2000 was expected.
- `src/app/keyboard-viewport.ts`, removing the scale check: "never resizes the shell for a pinch
  zoom" and "holds the keyboard's frame through a zoom" failed.
- Same file, `SLACK = 0`: "does nothing where the keyboard already shrinks the layout viewport"
  failed.
- Same file, not clearing when the keyboard closes: the iOS keyboard case and the zoom case failed.
- Same file, not listening for `scroll`: the iOS keyboard case failed on the panned top.
- `src/app/Composer.tsx`, `keepFocus` doing nothing: "keeps focus in the message box when Send is
  pressed" failed, with focus on the button.

## Visual checks in Chromium phone emulation

`phone-check.mjs` (kept in the session scratchpad, not committed) loaded `main` and this branch side
by side from `.agents/tools/preview-app.mjs` fixtures on ports 3101 and 3102. It used Playwright's
`iPhone SE`, `iPhone SE (3rd gen)`, `iPhone 15 Pro Max` and `Pixel 7` profiles, with touch and
a mobile user agent. Emulation shows no keyboard, so an init script replaced `window.visualViewport`
with one the script could shrink by 300px. That is what Safari reports with a keyboard up. Results are
in [the report](../evidence/composer-keyboard-20261110/phone-emulation-report.json).

- No keyboard: composer boxes match on all four profiles. Pixel diffs of whole screenshots differ only
  inside the header avatar's box, which animates.
- Faked keyboard: on this branch the composer area's bottom equals the visible bottom on every
  profile, the latest message is in view, and the document does not scroll. On `main` the composer
  stays under the keyboard.
- `tap()` on Send with touch: focus stays on `#message` on this branch and falls to `body` on `main`.
  The message sends on both.
- Back with the keyboard up ran the view transition to home with no page errors.
- `iPhone SE` (320 by 568, no longer supported by current iOS) with a 300px keyboard and a send notice
  leaves the transcript about 0px. Its padding then overlaps the scrolled notice dock.

Collages: [small](../evidence/composer-keyboard-20261110/small-phone.png),
[large](../evidence/composer-keyboard-20261110/large-phone.png),
[tiny](../evidence/composer-keyboard-20261110/tiny-phone.png). The red line marks the faked keyboard's
top edge.

## Not run on a device

No phone, simulator or on-screen keyboard was used. Still unverified: Safari's real visual viewport
events, the pan offset (`pageTop`) path, Android's `resizes-content` and its safe-area inset
under the keyboard, an installed web app on either platform, keeping the keyboard up through a tapped
Send on WebKit, VoiceOver, TalkBack and Voice Control activating Send, and a hardware-keyboard
iPad's shortcut bar.

## Review round 2

After merging `origin/main` (`3bfd79d`) into the branch as `992a8c2`. Findings came from an independent
GPT-6.1 Sol review of `812cae4`.

### What changed

- P1, Send hidden by a long draft in landscape: `src/styles.css` now states the order in which a short
  conversation gives up space. The transcript goes first, then the notices, the Talk panel, the attachment tray and
  the message box, which scroll inside their own boxes. The message box keeps one line and the composer keeps its
  row of buttons. The header goes last, cut from the top, because `.conversation-panel` packs its content to the
  bottom. The floors are explicit (`--composer-floor`, 54px inline or 98px stacked, plus 10px for a notice dock and
  28px for a Talk panel) because Chromium sizes a box's automatic minimum height to all of its content. The
  message box stretches to the grid row the form leaves it, so the draft scrolls inside it. Send can only be cut
  when the visible frame is shorter than the composer area's floor, 112px with a stacked draft.
- P2, a view resize settled the send reserve: `reserveEnd` in `src/app/use-conversation.ts` marks the anchor
  filled only when the content outside the reserve grew since the last measurement. A view that shrinks recomputes
  the reserve, and it comes back when the view grows.
- P3: the README and `keyboard-viewport.ts` name iOS 27.2 as the last version that ignores
  `interactive-widget=resizes-content`, cite WebKit bug 259770's fix in the iOS 27.3 beta and its report that the
  field still ends up behind the keyboard there, and call the app's behavior on that beta unverified. The pinch-zoom
  wording now says a scale within 0.01 of 1 counts as unzoomed. The README describes the space order.

### Red proof

- P2: "gives the reserved space back when a view that shrank grows again" (`tests/transcript-ui.test.ts`) was
  written first and failed on the branch head at the expand step, `expected '' to be '176px'`. It passes with the fix.
- P1: the e2e test "a long draft scrolls inside the message box and Send stays on screen to tap" failed against the
  branch head's `styles.css` with `Send at 190 to 234`, the reviewer's numbers. With the fix it passes. Breaking single
  lines of the fix:
  - `justify-content: flex-end` changed to `flex-start` failed at the 140px step, `Send at 145 to 189 of 140`. At
    190px alone the composer's bottom padding absorbed the overflow, so the test checks both heights.
  - Removing `align-self: stretch` from the message box failed on `inForm: false`.
  - Setting the form's floor to 0 passed: with no notice or Talk panel nothing competes with the form inside the
    composer area. The matrix below covers those cases.
  - `.composer-area > * { flex-shrink: 0; }` was removed after its removal passed: every child sets its own.

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/transcript-ui.test.ts tests/keyboard-viewport.test.ts tests/shell-ui.test.ts`: 3 files,
  141 tests passed.
- `npm test`: 180 files, 2925 tests passed.
- `npm run build` passed. `npm run test:e2e`: 10 passed.

### Chromium phone matrix

A script in the session scratchpad loaded the e2e server's build with Playwright's touch and mobile settings and a
faked visual viewport. It covered 375 by 667, 430 by 932, 667 by 375, 844 by 390, 932 by 430 and 1280 by 800, with no
keyboard and with visible frames of 363, 548, 120, 190 and 150px. Drafts were empty, one line, eight lines, eight lines
with four attachments, and eight lines with a notice dock or a Talk panel. The notice and Talk panel were inserted into
the DOM with the app's classes, so they check layout only.
[The report](../evidence/composer-keyboard-20261110/send-visibility-round2.json) holds both runs:

- Before, Send was outside the visible frame in 20 of 36 keyboard cases. After, it was inside and a tap at its centre
  reached it in all 36. An empty draft shows Send in the same slot Stop uses.
- All 36 no-keyboard cases have the same Send, form, message box, tray and header boxes before and after.
- [Landscape at 190px](../evidence/composer-keyboard-20261110/landscape-190-round2.png), before and after.

### Not run on a device

The earlier list still stands. This round added no device runs. A browser without `field-sizing`, such as Safari
before 26.2, sizes the message box from script with an explicit height, which the stretch does not override. There a
long draft may draw above its row when space is short, though Send keeps its place. The group chat composer was not
checked with a keyboard: the e2e server has no group.

### Group chat composer, same round

Checking the other surface that shares the behavior found the group composer's Send below the frame with a long
draft, on `main` too and even with no keyboard on a small phone. `.composer { position: relative }` in
`src/styles.css` overrode `.group-composer { position: sticky }`, so it never stuck. `collaboration.css` now:

- states the sticking with two classes, so the order of the style sheets cannot undo it;
- makes `.group-panel` a size container and caps the group message box at its height (`100cqh`) less the 20px top
  margin and the composer's other rows: 76px, or 150px with the "Replying in thread" banner. It keeps one line;
- gives the panel a floor of one line plus those rows, so in a frame too short for it the header is cut from the
  top, as in an assistant chat.

`.agents/tools/check-send-visible.mjs` scripts the check, since this round needed it twice. It runs against
`preview-app.mjs`, which has Stop, a dock notice, uploads and group threads, over 70 cases: five sizes, keyboard
frames of 363, 548, 120, 190 and 150px, and empty, short, long, with-attachment and threaded drafts in both
composers. [Report](../evidence/composer-keyboard-20261110/send-visible-preview.json):

- With `812cae4`'s CSS, 38 of 70 kept the button whole and tappable. With `a8a161c`, 49 of 70, all the misses in the
  group chat. Now 70 of 70.
- Breaking each group line by hand turned the tool red. Undoing the two-class sticky failed the long and threaded group drafts on the small phone, with and without a keyboard. Removing the
  message box cap failed the portrait keyboard case with a thread and a long draft. Removing the floor failed the
  120px and 150px frames. Using the plain 76px for the banner failed the threaded portrait keyboard case.
- `npm run lint`, `npm run typecheck`, `npm run build` and `npm run test:e2e` (10 passed) passed again. `npm test` was
  not repeated: this commit changes only CSS that jsdom does not lay out, and a tool.

## iOS Simulator check of `bbadcff`, and the fix it led to

Safari on an iPhone 17e simulator, iOS 27.0, on the Mac mini, driven by the device tools, with a
same-origin probe script logging the viewport on every change. Nine of 16 steps ran before the
tool's test runner froze on Safari's microphone prompt. The iPhone 18 Pro Max and the iPad were
not run. A simulator is not a physical phone.

- **Failed: the keyboard code did not engage in the usual case.** With the keyboard up, Safari
  reported `innerHeight` as the root's `clientHeight` less the page's scroll: 699 - 330 = 369 in
  portrait, 699 - 100 = 599 after a smaller pan, 326 - 263 = 63 in landscape. Once Safari had
  panned to the field, `innerHeight` equalled the visual viewport's height and `keyboardFrame`
  saw no keyboard. The probe log shows `data-keyboard-open` set at 10:10:51.887 with
  `innerHeight` 699 and cleared at 10:10:52.303 with `innerHeight` 369 and `scrollY` 330. The
  root's `clientHeight` stayed 699 throughout. Safari's own pan still put Send inside the frame,
  at 312 to 356 of 369, but the header scrolled off and the notice was clipped, not shrunk.
- Where the code did engage, it worked: back in portrait with the keyboard up, the shell was 401 px
  with Send at 344 to 388; with `innerHeight` 599 the notice shrank to 42.5 px before the field.
- Landscape leaves a 34 px visible frame on this phone, under the 112 px floor, so Send is cut
  there. That is the stated limit.
- Passed: no keyboard state at start, dismissing the keyboard, a long draft in portrait, four
  photos attached.

**Fix, by the orchestrator:** `followKeyboard` compares the visual viewport with the root
element's `clientHeight` and no longer reads `innerHeight`.

### Red proof

"keeps the shell fitted after Safari pans the page and innerHeight drops to the visible height"
replays the measured sequence. Before the fix it failed with the shell cleared: expected height
`369px`, top `330px`, open; received empty, empty, closed.

### Checks, after merging `origin/main` at `5d74731`

- `npm run typecheck` and `npm run lint` passed.
- `tests/keyboard-viewport.test.ts`: 7 tests passed. `npm test`: 180 files, 2926 tests passed.
- `npm run build` passed. `npm run test:e2e`: 10 passed in Chromium.
- `.agents/tools/check-send-visible.mjs`: 70 of 70.
- The fix has not run in Safari. A second simulator check follows.

## Third simulator check, on `73e4469`, and fixes for short frames, the page's end and the pan gap

Safari on an iPhone 17e and an iPhone 18 Pro Max simulator, iOS 27.0, on the Mac mini, driven by the T3 device
tools, with the same-origin probe from the earlier checks. A simulator is not a physical phone: its keyboard,
touch input and Safari's bars are the simulator's, and every result below is simulator-only. Talk was not opened.
The keyboard-minimization default was set to false for the run and restored to true on both simulators. Builds ran
side by side behind probe proxies: this fix, `origin/main` at `39e35a6` from a scratch worktree, and the e2e
server for the send step. Scripts, logs, screenshots and videos are on the Mac mini in
`/Volumes/DevSSD/scratch/wildbots-keyboard-check/run3/`. The Mac lock was queued 0.15 s and held 2,868 s.

### What changed

- `keyboardFrame` answers "no keyboard frame" for a visible frame shorter than `LEAST_FRAME`, 112px, the composer
  area's floor with a stacked draft in `src/styles.css`. The shell keeps the layout viewport's height there and
  Safari pans to the field, as on `main`.
- The shell's top is clamped so top plus height never passes the root's `clientHeight`.
- The top is the larger of the visual viewport's `pageTop` and the window's `scrollY`, and the window's `scroll`
  event is followed too. `scrollY + offsetTop`, which the brief offered, is wrong here: at rest Safari reports
  `offsetTop` equal to `pageTop` (330 and 330), so the sum would be 660.

### A, a frame too small to use: fixed

- Before, from the second check: `visualViewport.height` -44 made the shell 4101.6px tall with Send at y 4044, and
  2px or 34px fitted the shell to a frame Send could not fit in.
- 17e landscape, 1 tab, 12-line draft: the frame is 34px. The shell stays 326px, the root's height, and
  `scrollHeight` equals `clientHeight`. Safari panned 186 to 205px, and typed text ("Line 6 hay orderxxx") showed
  above the accessory bar. Screenshot `shots/i17e-A-landscape-1tab-typed.png`.
- 17e landscape, 2 tabs: the frame is -12px (-44px with 4 tabs). The shell stays 280px with no runaway. Safari's
  address bar, tab bar and accessory bar cover the whole page area, so the field is not visible; no page layout
  can change that. `shots/i17e-A-landscape-2tabs-typed.png`.
- Pro Max landscape: the 116px frame is still fitted, Send at 59 to 103. `shots/i18pm-A-landscape-1tab-after.png`.

### B, the shell making the page taller: fixed

- Before: after a drag that started on the notice, the top was 478 and the height 349, so `scrollHeight` was 827
  against a `clientHeight` of 796.
- After, the same drag on the Pro Max: `pageTop` reached 521 during the drag (frame bottom 870), top plus height
  never passed 796, and `scrollHeight` stayed 796 across all 188 probe entries. Safari settled at 447, not 478.
  `shots/i18pm-B-fix-drag-notice-up.png`.

### C, an empty band after a drag on the notice or composer: not fixed, same on `main`

The drag pans the page past the keyboard's pan, then Safari shrinks the visual viewport so it ends at the page's
bottom: 17e 369 to 271 at `pageTop` 428, Pro Max 447 to 349 at `pageTop` 447. The band is the area past the
document's end, above Safari's address pill, and the form accessory bar appears. `origin/main` does the same with
the same gesture: 271 at 428 on the 17e, 349 at 447 on the Pro Max (`shots/i17e-C-main-drag-notice-up.png`,
`shots/i18pm-C-main-drag-notice-up.png`). Tried through an injected stylesheet under `[data-keyboard-open]`:

- `overscroll-behavior` on the root, `touch-action: none` on the root and body, `overflow: hidden` on the root and
  body, either property alone on the composer area: the page still panned.
- `touch-action: none` and `overscroll-behavior: none` together on `.composer-area` and its descendants held the page
  at 330 on 6 of 6 drags from the notice or the buttons. A drag from the message box still panned it, to 489, and
  it only works if the notice itself gets `touch-action: none`, which stops the notice dock and the attachment tray
  from scrolling by touch. No rule met the brief's conditions, so none was kept.

### D, the shell above the frame while the keyboard opens: fixed

On 4 of 5 opens on the 17e, the visual viewport's resize came with `pageTop` 0, the window's scroll 30ms later with
`scrollY` 330 and `pageTop` still 0, and the visual viewport's scroll 390 to 420ms after that. Video at 30 fps showed
about 13 frames, roughly 430ms, with only the composer on screen. After the fix, 5 of 5 opens set the top to 330 at
the window's scroll; the header, notice and composer stay on screen and slide up with the keyboard, with a short
empty band above the header for about 6 frames, the same motion as an open without the gap. The Pro Max shows the
same gap (400 to 460ms) and the same result after. `video/frames/D-before-after.png`,
`video/frames/i18pm-D-after1.png`.

Residual: during the second check's hardware-key typing, which toggled the keyboard several times a second,
`scrollY` read 401 and 367 while `pageTop` read 182 for about 50ms. The shell now follows `scrollY` there, clamped
to 349. That state was not reproduced with the on-screen keyboard.

### E, "Jump to latest" over the reply: not fixed, differs from `main`

After sending with the keyboard up on the Pro Max (e2e server, Trail Cook), the button covers the reply line "Post
two is loose…" because the transcript is 298px and the view keeps the sent message near the top
(`shots/i18pm-E-fix-after-send1.png`). On `main`, Send closes the keyboard; tapping the box again shows no button,
since the transcript keeps its 647px, the reply's end is in view, and Safari pans the header off screen
(`shots/i18pm-E-main-after-send1-kb.png`). Scrolled up in Kitchen companion portrait, both builds place the button
over the same reply text and neither covers the header.

### Also seen

- `use-talk.ts` shows "Talk ended when the app went to the background." on any page hide on a phone, even when
  Talk was never started. Switching Safari tabs showed it.
- The preview fixture never confirmed a send through the probe proxy ("Checking whether your last message
  arrived"), so the send step used the e2e server.

### Red proof

The new tests were written first and failed: A's three short frames and B's clamp (4 failed, 8 passed), then D's
window scroll (1 failed, 13 passed, top `0px` where `330px` was expected). Each line was then broken by hand:

- Removing the `LEAST_FRAME` check failed the negative, zero and 111px cases. Making it `<=` failed the 112px case.
- Removing the clamp failed "never places the shell past the bottom of the page". Clamping 1px short also failed the
  measured-pan case.
- Removing the window listener, or taking the top from `pageTop` alone, failed "follows the window's scroll".
  Removing the window unlisten failed "stops following the window's scroll". Taking the top from `scrollY` alone
  failed four cases.

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/keyboard-viewport.test.ts`: 14 tests passed.
- `npm test`: 180 files, 2929 passed and 4 failed. `direct-routes` (2) and `native-contract` (1 test, 2 reports)
  fail the same way on an untouched `73e4469` on this Mac, where the expected LAN route is missing.
  `live-turn-timing` read 65ms for 61ms once and passed when rerun. Linux CI is the reference for these.
- `npm run build` passed. The Playwright suite was not run here.

## Review round 2

GPT-6.1 Sol reviewed `812cae4..5d025ab`: ready after one fix. It cleared the Send floors, the send reserve, the
README, the root-height comparison, the clamp, the window-scroll listener and the short-frame fallback against the
recorded Safari numbers, and all 15 hand mutations in this branch's scope went red. It noted that a frame crossing
112 px, replayed in Chromium as 113, 112, 111, 112, flips the shell between the fitted height and the full height;
whether a real keyboard animation shows that is unknown. Neither known Safari residual blocks.

- P2: the group composer lost its retry button after a failed send. The action error rendered above the
  conversation's section, pushed the section's start down, and the sticky composer cannot rise above its section. At
  375 by 667 with a 363 px frame and a ten-line draft, "Retry same saved message" sat at 395 to 441.
- Fix, by the orchestrator: the group panel's errors and notes render inside the section, so nothing above it moves
  it. They take the section's 860 px width limit with it. No reviewer has read this fix.

### Red proof

`.agents/tools/check-send-visible.mjs` gained a failed group send, a 503 answered at the browser's edge, with ten
cases across the phone sizes. Before the fix it reported 79 of 80, the failure at 375 by 667 with a 363 px frame and
the button at 395 to 441, the reviewer's numbers. After, 80 of 80, that button at 296 to 342.

### Checks

- `npm run typecheck` and `npm run lint` passed. `npm test`: 180 files, 2933 tests passed.
- `npm run build` passed. `npm run test:e2e`: 10 passed in Chromium.
- Safari, Firefox and a physical phone: not run for this fix.

## Review round 3, narrow

GPT-6.1 Sol reviewed `f8cf76a`: ready after one fix. It cleared every note in every state, the landmark and its
alert and status roles in Chromium's accessibility tree, and the 860 px limit, and its mutation moving the notes back
outside the section turned the tool red.

- P2: with the notes inside the section, the sticky composer lay over the failure's explanation. At 375 by 667 with a
  363 px frame and a ten-line draft, the note spanned 85 to 171 and the composer began at 105; a tap on the
  explanation reached the message box even with the panel scrolled to its top.
- Fix, by the orchestrator: the notes sit in one box whose height `GroupChats.tsx` reports to CSS as
  `--group-notes`, kept current by a `ResizeObserver`, and the draft's height limit subtracts it. No reviewer has
  read this fix.
- Limit: a landscape keyboard frame under 300 px cannot hold the explanation and a one-line composer together. There
  the composer still covers the explanation until the keyboard closes. The retry button stays whole.

### Red proof

`.agents/tools/check-send-visible.mjs` now also requires, after a failed group send, that with the panel scrolled to
its top a tap anywhere on the explanation reaches the explanation. Before the fix: 75 of 80, with the case above
reported as "explanation at 85-171 covered". After: 80 of 80. Three landscape keyboard frames, 120, 150 and 190 px,
report the explanation covered and are not required to show it.

### Checks

- `npm run typecheck` and `npm run lint` passed. `npm test`: 183 files, 3052 tests passed.
- `npm run build` passed. `npm run test:e2e`: 20 passed in Chromium.
- Safari, Firefox and a physical phone: not run for this fix.

## Review round 4, narrow, after #311 merged

GPT-6.1 Sol reviewed `071d859` on `main` at `d090194`: ready after one fix. It cleared the original reproduction at
375 by 667 with a 363 px frame, the notes' height going back to `0px` when they disappear, a room change, a room
that is gone, the effect's dependency on `gone`, and found no `ResizeObserver` error or continuing layout write.

- P2: the tool's blanket exemption under 300 px hid a frame that can show both. At 932 by 430 with a 250 px frame
  the explanation spanned 106 to 172 and the composer began at 138.5, covering it, and the tool passed only because
  the frame was under 300 px.
- Fix, by the orchestrator, as the reviewer prescribed: the group panel's least height includes the notes'
  measured height, so the header gives way before the composer covers the explanation. The tool gained the 250 px
  frame, and requires the explanation uncovered wherever the frame is at least the panel's least height, read from
  the page, in place of the 300 px limit. No reviewer has read this fix.
- Limit, now measured: a frame shorter than the panel's least height, 247 px at 932 by 430 with this explanation,
  cannot hold the explanation and a one-line composer together. At 190, 150 and 120 px the explanation is cut off
  above the frame with the header until the keyboard closes. The retry button stays whole.

### Red proof

With the tool's new frame and new rule and without the CSS change: 86 of 88, the 250 px frame failing with
"explanation at 106-172 covered", the reviewer's numbers, and the 190 px frame failing against a least height of
168. With the CSS change: 88 of 88, the 250 px frame's explanation at 27 to 93, the reviewer's numbers for its own
trial of this fix.

### Checks

- `npm run typecheck` and `npm run lint` passed. `npm test`: 184 files, 3077 tests passed.
- `npm run build` passed. `npm run test:e2e`: 20 passed in Chromium.
- Safari, Firefox and a physical phone: not run.
