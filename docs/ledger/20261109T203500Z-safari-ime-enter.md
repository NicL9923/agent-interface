# November 9 Safari IME Enter no longer sends

Branch `fix/composer-safari-ime-enter`, from `origin/main` at `e479781`. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2) at the commit that carries this entry.
No Python, iOS, server or Hermes code changed.

## Change

Safari fires `compositionend` before the keydown of the Enter that confirms an IME word, so
that keydown reports `isComposing` false and `keyCode` 229 (WebKit bug 165004). `src/app/ime.ts`
adds `imeKey`, which checks both. It guards the composer's whole key handler (Enter send, Up and
Down recall, Escape restore), the find bar's Enter and Escape, the command palette's keys, and the
group chat composer's Enter send and mention picker.

Checked and left alone: rename and add-section fields in `PreferencesDialog.tsx` submit through
native form submission with no key handler; `AttentionCard` keys act only on the digits 1 to 9 and
skip text areas; `shortcuts.ts` combos need Cmd/Ctrl or are `?`, never Enter or arrows; `use-menu`,
`segmented`, `BotMenuPopup`, `ApprovalCard` and `Conversation` key handlers act on buttons, menus or
modified keys, not text entry.

## Application tests

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/shell-ui.test.ts tests/transcript-ui.test.ts tests/collaboration-ui.test.ts`:
  3 files, 153 tests passed.
- `npm test`: 169 files, 2,488 tests passed.
- `npm run build` passed, then `npm run test:e2e`: 3 Chromium tests passed.

## Mutants

Each line was broken by hand, its focused test run, and the source restored.

| Mutation | Test | Result |
| --- | --- | --- |
| Composer guard back to `isComposing` only | shell-ui "confirms an IME word" | failed: recall replaced the draft |
| Composer guard skips Enter | same | failed: a `/bots/shared/messages` write |
| `imeKey` drops the `keyCode === 229` check | same | failed |
| Palette guard back to `isComposing` only | shell-ui "filters, and opens an assistant with Enter" | failed: palette closed |
| Find bar Enter guard back to `isComposing` only | transcript-ui "counts loaded matches" | failed: `2 of 3` |
| Find bar Escape unguarded | same | failed: find bar closed |
| Group chat guard back to `isComposing` only | collaboration-ui "shows a sent group message at once" | failed: a `/groups/room/messages` write |

## Not exercised

No real Safari or real input method. jsdom and Chromium receive synthetic keydown events with
`keyCode` 229; the WebKit behavior itself is taken from WebKit bug 165004, not reproduced here.
