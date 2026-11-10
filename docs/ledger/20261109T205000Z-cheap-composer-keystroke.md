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
  and otherwise measures with an `OffscreenCanvas`, which lays out nothing. Text with a tab, vertical
  tab or form feed is measured by the hidden span, because canvas measures each as a space. The span
  stays as the measuring fallback and the height script as the sizing fallback.
- The local draft write is unchanged from `origin/main`: synchronous, on every edit. See the review
  round below for why the deferred write was removed.

## Application tests

First round, at `aa108c0`, before the review fixes:

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/shell-ui.test.ts tests/connection-ui.test.ts tests/composer-layout.test.ts
  tests/draft-sync-ui.test.ts tests/local-save.test.ts tests/transcript-rerender.test.ts`:
  6 files, 91 tests passed.
- `npm test`: 170 files, 2,496 tests passed.
- `npm run build` passed, then `npm run test:e2e`: 3 Chromium tests passed.
- Merged with `fix/composer-safari-ime-enter` in a scratch tree: typecheck passed, and the seven
  touched UI and unit files ran 217 tests, all passed.

Review round, at the commit that carries this revision:

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/shell-ui.test.ts tests/composer-layout.test.ts tests/draft-sync-ui.test.ts
  tests/connection-ui.test.ts tests/transcript-rerender.test.ts`: 5 files, 88 tests passed. That is
  the first round's set less the 7 deferral tests, plus the 4 new `textWidth` tests.
- `npm test`: 169 files, 2,493 tests passed.
- `npm run build` passed, then `npm run test:e2e`: 3 Chromium tests passed.
- The merge with `fix/composer-safari-ime-enter` was not repeated.

## Mutants

Each line was broken by hand, its focused test run, and the source restored.

The six render mutants ran against the review round's rewrite of "re-renders nothing in the
transcript while typing", which mocks no application module. It compares the `__reactProps$` object
React keeps on each element under `.transcript-frame` before and after typing. React 19.3 replaces
that object when the element's component renders again (`commitUpdate` in
`react-dom-client.development.js`) and keeps it when a memoized component above skips. The test
also checks the field's object did change, so it fails if React stops exposing renders this way.

| Mutation | Test | Result |
| --- | --- | --- |
| `Conversation` not memoized | shell-ui "re-renders nothing in the transcript while typing" | failed: 6 transcript elements re-rendered |
| `onDraft` an inline closure | same | failed |
| `onCreate` an inline closure | same | failed |
| `history` rebuilt each render | same | failed |
| notifications result rebuilt each render | same | failed |
| `enable` a fresh closure each render | same | failed |
| height script runs where CSS sizes the field | shell-ui "lets CSS size the field" | failed: `96px` |
| `cssSizesField` always true | connection-ui "fits a restored multi-line draft" | failed: no height |
| slot read on every keystroke | shell-ui "lets CSS size the field" | failed: 5 `getComputedStyle` calls |
| measure before the line-break and length rules | composer-layout "without measuring" | failed |
| measure for empty text | composer-layout "placeholder" | failed |
| tab left out of the span characters | composer-layout "with a tab in the span" | failed |
| vertical tab left out | composer-layout "with a vertical tab in the span" | failed |
| form feed left out | composer-layout "with a form feed in the span" | failed |
| canvas used for every text | composer-layout, all three span cases | failed |
| span characters checked without checking for a canvas | shell-ui "lets CSS size the field" | failed: jsdom has no canvas |

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

These measurements were taken at `aa108c0`, with the deferred draft write. They were not repeated
after it was removed. That write touched only `localStorage`, never layout, so the layout and style
counts stand; the script time may be slightly higher now.

Empty, short, wrapping and ten-line drafts gave the same layout attribute and field size on both
(550 by 44 inline, 742 by 68 stacked, 742 by 200 at max height). At max height after `fill`, main's
field sat about 14 px further down its scroll. `OffscreenCanvas` widths matched the measuring span
within 0.01 px for Latin, accented, CJK and emoji text in the app's font.

## Review round

GPT-6.1 Sol reviewed `aa108c0` and verified three findings. All three are fixed.

1. A deferred write could overwrite another tab's newer draft: each tab held its own waiting value,
   so tab A's timer could write an older draft over the one tab B had just saved. The reviewer
   reproduced it in two same-origin Chromium pages; `origin/main` kept B's value. The orchestrator
   chose to remove the deferral. `storage.ts`, `use-draft.ts`, `tests/setup-ui.ts`,
   `tests/draft-sync-ui.test.ts` and `README.md` are back to `origin/main`, and
   `tests/local-save.test.ts` is deleted. The removed tests covered only the deferral;
   `connection-ui` already checks that a draft is written to the device.
2. Canvas measured a tab as a space. In a 246 px slot, `Name\tQuantity\tPrice\tTotal` measured
   185.85 px on canvas and 247.17 px in the span, so the field stayed inline and wrapped where
   `origin/main` stacked it. Text with a tab now goes to the span. Stacking every tabbed text without
   measuring was rejected: `a\tb` measures 44.47 px, and `origin/main` keeps it inline.
   A Chromium probe of 25 character classes against the built app compared canvas with the span.
   Canvas differed only for three: tab, vertical tab (drawn as a 12 px control glyph, canvas 4.4 px) and
   form feed (drawn as nothing, canvas 4.4 px). No-break, en, em, thin, ideographic and Ogham
   spaces, zero-width space, soft hyphen, BOM, other C0 controls, DEL, U+2028, U+2029, NEL, and runs
   of leading, inner and trailing spaces all matched. A second probe read a no-wrap clone of the
   textarea for the three, plus a C0 control and plain Latin text; the span matched the textarea
   within 1 px each time, and canvas did not for the three. A carriage return never reaches the field's
   value, and a line feed stacks before measuring. After the fix, at a 254 px slot, the tabbed row
   stacked and `a\tb` stayed inline.
3. The render test replaced `AttentionList` through `vi.mock`, which `AGENTS.md` does not allow. It
   now reads React's per-element props object, as described under Mutants.

## Not exercised

No Safari or Firefox. The fallback paths, a browser without `field-sizing` or without
`OffscreenCanvas`, ran only in jsdom. The character probe ran only in Chromium with the app's font.
`origin/main` was not rebuilt for the tab case; its outcome is the reviewer's, and it follows from
main measuring with the same span.
