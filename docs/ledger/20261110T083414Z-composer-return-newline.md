# November 10 Return starts a new line on a touch screen

Branch `composer-return-newline`, code state `e84e32e` plus this entry. It is stacked on
`composer-keyboard-viewport` (`812cae4`) because both change the same lines of
`src/app/Composer.tsx` and `tests/shell-ui.test.ts`. Written on NicolasLaptop (Fedora, Linux x64),
Node 24.22.2, Playwright Chromium. No Hermes took part.

## What changed

Nicolas decided the behavior. On a device whose only pointer is coarse, Return in the assistant
and group message boxes inserts a newline and the Send button sends. Enter sends wherever a mouse
or trackpad is present (`any-pointer: fine`), on a computer with no pointer, where `matchMedia` is
missing, and on a touch device once this tab sees a key no on-screen keyboard sends. Those keys
are a lone modifier, Tab, Escape, a function key, or a Ctrl or Cmd chord, and the tab remembers
them in sessionStorage. `enterkeyhint` is `send` or `enter` to match. The shortcuts dialog says
what Return does on a touch screen. The rule is in `src/app/enter-key.ts`.

## Application tests

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/shell-ui.test.ts tests/enter-key.test.ts tests/collaboration-ui.test.ts tests/keyboard-viewport.test.ts tests/transcript-ui.test.ts`:
  5 files, 184 tests passed.
- `npm test` on the stacked state: 177 files, 2811 tests passed. Before stacking, on `3bfd79d`, the
  same branch passed 180 files and 2935 tests.
- `npm run build` passed. `npm run test:e2e`: 8 passed.

### Red proof

Each line was broken by hand, the named test went red, and the line was restored:

- `Composer.tsx`, Enter ignoring `enterSends`: "starts a new line on a touch screen, and the Send
  button sends" failed.
- `Composer.tsx`, `enterKeyHint="send"` always: the same test failed on the hint.
- `GroupChats.tsx`, Enter ignoring `enterSends`: "starts a new line on Return from a touch screen,
  and sends with the Send button" failed.
- `enter-key.ts`, dropping `fine.matches`: "a touch-screen laptop" and "sends on Enter and starts a
  new line on Shift+Enter with a mouse or trackpad" failed.
- `enter-key.ts`, dropping `!coarse.matches`: "a computer driven by its keyboard alone" failed.
- `enter-key.ts`, no `notify()` after a hardware key: "sends on Enter on a touch screen once a key
  only a hardware keyboard has is pressed" failed.
- `enter-key.ts`, returning `false` without `matchMedia`: "sends where the browser cannot answer a
  media query" failed.
- `enter-key.ts`, `/F/` for the function-key pattern: "a letter" failed.
- `enter-key.ts`, reading sessionStorage without `try`: "stays a new line on a touch screen when
  storage is refused" failed.
- `ShortcutsDialog.tsx`, the touch note never shown: "says in the shortcut list what Return does on a
  touch screen, and only there" failed.

## Real browser, no device

The build ran on `.agents/tools/preview-app.mjs` and was checked in Chromium with Playwright's
`Pixel 7`, `iPhone SE (3rd gen)` and `Desktop Chrome` profiles. Both phone profiles reported
`(any-pointer: coarse)` and not `(any-pointer: fine)`. In each, `enterkeyhint` was `enter`, and Enter
left `feed the horses\n` with no message POST. Shift+Enter switched the hint to `send`, and the next
Enter sent one message. On desktop the hint was `send`, Enter sent, and Shift+Enter inserted a newline.
Playwright's keys arrive as hardware key events, and emulation shows no on-screen keyboard.

## Not run on a device

Not checked on a device: what Safari and Chrome on a phone report for `any-pointer`; the Return key
label each on-screen keyboard draws for `enterkeyhint`; whether either platform's on-screen keyboard
sends a lone Shift; an iPad with a trackpad keyboard and one without; a touch-screen laptop; and
input-method composition on a phone.

## Review round 2

After merging `composer-keyboard-viewport` at `a8a161c`, which carries `origin/main` at `3bfd79d`, as `a408aee`.
An independent GPT-6.1 Sol review of `0276253` found that iOS fires DOM Shift and Caps Lock key events from its
on-screen keyboard (WebKit bug 191475), so tapping Shift for one capital letter switched the tab to "Enter sends"
for good. It also found that no key in the list is guaranteed to come only from hardware, and that refused
`sessionStorage` kept the detection from taking effect. The orchestrator replaced both findings with a simpler rule.

### What changed

- `src/app/enter-key.ts` no longer watches keys or uses `sessionStorage`. The device's pointers alone decide what
  plain Enter does, with nothing remembered. A fine pointer, no coarse pointer, or no `matchMedia` means Enter sends
  and Shift+Enter starts a new line. A device whose only pointer is coarse gets a new line from Return and sends with
  the Send button. The answer and `enterkeyhint` follow a change in `any-pointer`.
- `sendsOnKey` is the one rule both message boxes call: Ctrl+Enter or Cmd+Enter always sends, and plain Enter sends
  where `enterSends`. Keys an input method is using never send. Ctrl+Enter and Cmd+Enter were checked as unbound
  first, in `src/app/shortcuts.ts`, the Find and approval-menu key listeners, and both composers. Both composers
  still run the IME guard before anything else.
- The group composer's mention picker still takes Enter, including Ctrl+Enter, while suggestions show, as it takes
  Tab. The next Ctrl+Enter sends.
- The shortcuts dialog lists what Enter does on this device and lists "Ctrl+Enter or ⌘Enter" as Send. On a touch-only
  device it adds a note: a keyboard without a trackpad gets a new line too, so it sends with Ctrl+Enter or ⌘Enter.
  The README says the same and states that limit.

### Red proof

The new tests were written first and run on `a408aee`:

- "starts a new line on a touch screen whatever keys came before, and sends nothing" (Shift, Caps Lock, Tab, then
  Enter) failed with `expected 'send' to be 'enter'`, the reviewer's finding. So did the group chat's version.
- "sends on a touch screen with Ctrl+Enter" and "with Cmd+Enter" failed, assistant and group alike: the key was
  left alone.
- The shortcut list test failed on the missing rows.

Each line of the new rule was then broken by hand, and the named tests went red before the line was restored:

- Dropping `event.ctrlKey` from `sendsOnKey`: both Ctrl+Enter touch-screen tests failed. Dropping `event.metaKey`:
  both Cmd+Enter tests failed.
- Dropping `imeKey` from `sendsOnKey`: both "never sends on ..." helper tests failed. The composers' own early
  return hides it from the UI tests, so the helper has its own test.
- Not subscribing to `change`: "follows a trackpad connected and removed while the page is open" failed.
- Dropping `fine.matches`: the touch-screen laptop, the mouse or trackpad and the trackpad-connected tests failed.
- Ignoring `enterSends` in `sendsOnKey`: four Return-on-touch tests failed, including the group chat's.

The tests for the remembered-key heuristic (`hardwareKey`, the sessionStorage refusal, Shift switching to send)
were deleted with it.

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/shell-ui.test.ts tests/collaboration-ui.test.ts tests/enter-key.test.ts tests/keyboard-viewport.test.ts tests/transcript-ui.test.ts`:
  5 files, 188 tests passed.
- `npm test`: 181 files, 2948 tests passed.
- `npm run build` passed. `npm run test:e2e`: 10 passed, including the landscape Send test from the first branch.

### Real browser, no device

The build ran on the e2e server in Chromium with Playwright's `iPhone 15 Pro Max`, `Pixel 7` and `Desktop Chrome`
profiles. Both phone profiles reported a coarse pointer and no fine one. They showed `enterkeyhint="enter"`. After
Shift, Caps Lock, Tab and Caps Lock, Enter left `feed\n` with no message POST and the hint stayed `enter`.
Ctrl+Enter and Meta+Enter each sent one message. On desktop the hint was `send` and Enter, Ctrl+Enter and
Meta+Enter each sent. Playwright's keys arrive as hardware key events. Emulation shows no on-screen keyboard and
cannot change `any-pointer` while a page is open, so that path is covered by the unit test only.

### Not run on a device

Still unchecked on a device: what Safari and Chrome on a phone report for `any-pointer`, with and without a
trackpad keyboard; the Return key label each on-screen keyboard draws for `enterkeyhint`; Ctrl+Enter and Cmd+Enter
from an iPad or Android hardware keyboard; the `change` event when a trackpad connects; and input-method composition
on a phone.

### After merging the group composer fix

`composer-keyboard-viewport` at `6b97b01` added the group composer fix and was merged here as `50c058b`. On that
state, `npm run typecheck` and `npm run lint` passed, `npm test` passed 181 files and 2948 tests, `npm run build`
passed, `npm run test:e2e` passed 10, and `.agents/tools/check-send-visible.mjs` kept the button whole and tappable
in 70 of 70 cases. In a group chat, where Return now starts a new line on a phone, Send stays on screen.

## Review round 2

GPT-6.1 Sol reviewed `0276253..2d5db06`: ready after one fix of its own, plus the group retry fix it takes from
`composer-keyboard-viewport`. It cleared the pointer rule on every device type it tried, including a touch screen
with a trackpad and a desktop touch screen with no mouse, the IME guard's order in both composers, the hint
following a pointer change, the removal of the remembered-key heuristic and its storage, and found no collision of
Ctrl+Enter or Cmd+Enter with the global shortcuts, Find, the approval menu or the command palette. All 14 hand
mutations in this branch's scope went red.

- P2: with the group composer's list of members showing, Ctrl+Enter and Cmd+Enter picked the member instead of
  sending. `Ask @ra` became `Ask @ranch ` and nothing was posted. An earlier note in this ledger chose that; it
  contradicts the rule that the two chords send everywhere.
- Fix, by the orchestrator: the list takes plain Enter and Tab. Ctrl+Enter and Cmd+Enter fall through to
  `sendsOnKey`. No reviewer has read this fix.

### Red proof

"sends with Ctrl+Enter while members are suggested, leaving the mention as typed", and the Cmd case, failed before
the fix with no message posted.

### Checks

- `npm run typecheck` and `npm run lint` passed. `npm test`: 181 files, 2958 tests passed.
- `npm run build` passed. `npm run test:e2e`: 10 passed in Chromium.
- `.agents/tools/check-send-visible.mjs`: 80 of 80.
- Safari, Firefox and a physical phone: not run for this fix.
