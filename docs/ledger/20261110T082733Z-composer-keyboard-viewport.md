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
- Breaking each group line by hand turned the tool red. Undoing the two-class sticky failed 21 cases. Removing the
  message box cap failed the portrait keyboard case with a thread and a long draft. Removing the floor failed the
  120px and 150px frames. Using the plain 76px for the banner failed the threaded portrait keyboard case.
- `npm run lint`, `npm run typecheck`, `npm run build` and `npm run test:e2e` (10 passed) passed again. `npm test` was
  not repeated: this commit changes only CSS that jsdom does not lay out, and a tool.
