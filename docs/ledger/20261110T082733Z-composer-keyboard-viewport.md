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
