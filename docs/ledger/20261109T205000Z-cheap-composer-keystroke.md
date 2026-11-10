# November 9 a composer keystroke stops re-rendering the transcript and reading layout

Branch `perf/cheap-composer-keystroke`, from `origin/main` at `e479781`. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2) at the commit that carries this entry.
No Python, iOS, server or Hermes code changed.

## Change

- The transcript (`Conversation`) is memoized. App passes it stable callbacks (`onDraft` through
  `useStableCallback`, `onCreate` as the existing `newBot`), `useConversation` memoizes `history`,
  and `useDeviceNotifications` memoizes its result with stable `enable`, `disable` and `dismissPrompt`.
- Where `CSS.supports("field-sizing", "content")`, CSS grows the field and the height script does
  not run. The stacking decision reads the slot width and font once per resize, not per keystroke,
  decides from the text alone when it can (empty, a line break, over 200 characters, a narrow slot),
  and otherwise measures with an `OffscreenCanvas`, which lays out nothing. The hidden span stays as
  the measuring fallback and the height script as the sizing fallback.
- `localSaveSoon` in `storage.ts` writes the chat draft within 250 ms of the first unsaved edit,
  newest value only, and at once on `pagehide` or `visibilitychange` to hidden. Any `localRead`,
  `localSave` or `localRemove` of the same key writes or drops the waiting value first, so the sent
  copy marking and save-response merges see the same order as before.

## Application tests

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/shell-ui.test.ts tests/connection-ui.test.ts tests/composer-layout.test.ts
  tests/draft-sync-ui.test.ts tests/local-save.test.ts tests/transcript-rerender.test.ts`:
  6 files, 91 tests passed.
- `npm test`: 170 files, 2,496 tests passed.
- `npm run build` passed, then `npm run test:e2e`: 3 Chromium tests passed.
- Merged with `fix/composer-safari-ime-enter` in a scratch tree: typecheck passed, and the seven
  touched UI and unit files ran 217 tests, all passed.

## Mutants

Each line was broken by hand, its focused test run, and the source restored.

| Mutation | Test | Result |
| --- | --- | --- |
| `Conversation` not memoized | shell-ui "re-renders nothing in the transcript while typing" | failed: 5 renders |
| `onDraft` an inline closure | same | failed: 5 renders |
| `onCreate` an inline closure | same | failed: 5 renders |
| `history` rebuilt each render | same | failed: 5 renders |
| notifications result rebuilt each render | same | failed: 5 renders |
| `enable` a fresh closure each render | same | failed: 5 renders |
| height script runs where CSS sizes the field | shell-ui "lets CSS size the field" | failed: `96px` |
| `cssSizesField` always true | connection-ui "fits a restored multi-line draft" | failed: no height |
| slot read on every keystroke | shell-ui "lets CSS size the field" | failed: 5 `getComputedStyle` calls |
| measure before the line-break and length rules | composer-layout "without measuring" | failed |
| measure for empty text | composer-layout "placeholder" | failed |
| `localSaveSoon` back to `localSave` | draft-sync-ui "a moment after a keystroke" | failed: stored at once |
| no `pagehide` flush | draft-sync-ui "typed offline just before the page is closed" | failed: nothing stored |
| no hidden flush | draft-sync-ui "typed offline just before the page is hidden" | failed: nothing stored |
| flush on a visible `visibilitychange` | draft-sync-ui "a moment after a keystroke" | failed |
| `localRead` skips the waiting value | local-save "lets a read see" | failed |
| `localSave` skips the waiting value | local-save "keeps a direct save" | failed: `typed` won |
| `localRemove` keeps the waiting value | local-save "drops a waiting save" | failed |
| later saves push the write back | local-save "writes rapid saves once" | failed: nothing written |

The `pagehide` and hidden mutants first survived when the test typed online, because the server
save's own `pagehide` path reads the key and so wrote the local copy. The tests now type offline,
where nothing else writes it, and both mutants fail.

## Real browser

Playwright Chromium (`@playwright/test`'s bundled build), 1280 by 800, against `npm run build` and
`e2e/server.ts`, through a measurement spec that was not committed. It types 48 characters with
`pressSequentially` (25 ms apart), three runs, and reads Chrome's `Performance.getMetrics` and a
wrapped `getComputedStyle`. `origin/main` was built in a scratch worktree; its service-worker step
failed on the scratch path, which ends that run with a worker console error after measuring.

| Per 48 keystrokes | `origin/main` | This branch |
| --- | --- | --- |
| `getComputedStyle` calls | 48, 48, 48 | 0, 0, 0 |
| Layouts | 232, 227, 219 | 82, 80, 75 |
| Style recalculations | 348, 333, 309 | 196, 183, 164 |
| Layout time (ms) | 55.2, 36.1, 21.6 | 24.5, 20.4, 10.1 |
| Script time (ms) | 144.7, 103.7, 64.6 | 132.4, 101.1, 51.7 |

Empty, short, wrapping and ten-line drafts gave the same layout attribute and field size on both
(550 by 44 inline, 742 by 68 stacked, 742 by 200 at max height). At max height after `fill`, main's
field sat about 14 px further down its scroll. `OffscreenCanvas` widths matched the measuring span
within 0.01 px for Latin, accented, CJK and emoji text in the app's font.

## Not exercised

No Safari or Firefox. The fallback paths, a browser without `field-sizing` or without
`OffscreenCanvas`, ran only in jsdom. No real page close or tab switch; jsdom dispatched the events.
