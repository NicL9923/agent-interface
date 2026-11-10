# November 10 a tapped notification opens its chat in the open window

Branch `perf/notification-opens-in-place`, stacked on `perf/cache-first-shell` at `7ab32b2`,
because both change `scripts/service-worker.js`, `tests/service-worker.test.ts` and
`e2e/smoke.spec.ts`, and the test files conflicted. Checks ran on NicolasLaptop (Fedora, Linux
x64, Node 24.22.2, Playwright Chromium) at commit `612ee5a`, which this entry follows. No server,
Python, iOS or Hermes code changed.

## Change

- `scripts/service-worker.js`: `openChat` lists only windows this worker controls. It prefers
  the focused window, then a visible one, then the first. It focuses that window at once, posts
  `{ type: 'OPEN_CHAT', url }` with a `MessageChannel` port, and waits up to 1,000 ms for an
  answer. With no answer it calls `navigate(url)`. With no controlled window, or when
  `navigate` rejects, it calls `openWindow(url)`.
- `src/app/worker-opens.ts`: `useWorkerOpens` hears `navigator.serviceWorker` messages. It
  acts only when the source is this page's controller, the type is `OPEN_CHAT`, and the
  address is this origin's `/` naming Today or a chat. It answers on the port after opening.
- `src/App.tsx`: the destination closes any overlay or panel, then reuses the click paths:
  `showView` for Today, `openMessage` for a message link, and `selectBot` for a chat, plus the
  routine panel for a routine.

## Application tests

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/service-worker.test.ts tests/worker-opens-ui.test.ts tests/app-update.test.ts`:
  3 files, 70 tests passed.
- `npm test`: 171 files, 2,582 tests passed.
- `npm run build` passed, including the precache-plan guards, then `npm run test:e2e`: 5
  Chromium tests passed. The new case calls the built worker's `openChat` through Playwright,
  since Playwright cannot click a notification.

## Mutants

Each line was broken by hand, the focused tests run, and the source restored.

| Mutation | Result |
| --- | --- |
| Window never asked | failed: "asks the window to open the chat in place…", "asks the window the person was last in…", "loads the chat into a window that does not answer in time" |
| No `navigate` fallback | failed: "loads the chat into a window that does not answer in time", "opens a new window when loading the chat into the silent one fails" |
| No new window after `navigate` fails | failed: the second of those |
| Uncontrolled windows considered | failed: "opens a new window beside one this worker does not control…" |
| Answer bound 1,000 ms changed to 500 | failed: "loads the chat into a window that does not answer in time" at 999 ms |
| Focus removed | failed: in-place and no-answer cases |
| Focused window not preferred | failed: "asks the window the person was last in…" |
| Page: source check removed | failed: "another worker", "no source" |
| Page: no-controller check removed | failed: "ignores a message without a source when no worker controls the page" |
| Page: type, text, origin, path or chat check removed | each failed its own "ignores a message from…" case |
| Page: answer removed | failed: "switches to the chat in place and tells the worker it did" |
| Page: message link, routine or Today branch removed | each failed its own case |
| e2e: window never asked, rebuilt | failed: "a notification tapped while the app is open…" at the same-document check |

## Not exercised

- No browser use beyond the Playwright suite. No real notification was clicked, and only
  Chromium ran. The browser's limit on `focus()` and `openWindow()` after a tap was not
  exercised. Firefox documents one second, so an `openWindow` after a silent window's full
  wait may be refused there.
- Push links carry only `bot`, `routine` and `view=today`, and the worker's `conversationUrl`
  keeps only those. The page also handles `message`, but no notification sends one today.

## November 9 review round

GPT-6.1 Sol reviewed the branch at `b8523a7`. This round merged the fixed
`perf/cache-first-shell` at `1f35a2d`, which carries `origin/main` at `0a5f28a` (merge commit
`7c9041e`), and changed the code at `cbd2bf3`. Checks ran on NicolasLaptop (Fedora, Linux x64,
Node 24.22.2, Playwright Chromium).

### Findings and changes

- P1, opening from a notification skipped the settings discard question. `src/app/close-request.ts`
  lets a sheet offer its own close to `App`. Assistant settings offers the path its close button
  uses: no unsaved work closes, unsaved work shows "Discard your unsaved changes?", and a save in
  progress stays. Settings (preferences) offers its close too, which saves a section name being
  typed or stays open with the reason. `App` opens the destination only when that sheet calls its
  `onClose`; keeping the form, or saving it while asked, drops the destination. The page answers
  the worker in every case, so the worker never navigates over the form.
- Other things the handler closes, checked against their own close paths:
  - Details, Integrations, Usage, Computer, Hermes upgrade and routine results close through
    `onClose` with no guard of their own, so `setPanel(null)` is what their close buttons do.
  - The command palette, keyboard shortcuts and the stop question are overlays with nothing to
    save.
  - The group composer with a draft storage refused, and a secure request card's typed secret,
    are not closed by the handler: they unmount when the view switches, exactly as when the
    person picks another chat in the sidebar. Neither has a guard on that path today, and
    `main`'s `navigate` reloaded the page, which loses them as well. Not changed in this branch.
  - A group being created (`GroupCreate`) stays open over the opened chat, as `main`'s reload
    did not; it is a modal, so the person sees it and can close it.
- P2, the fallback outlived the tap's activation. The acknowledgement wait is 250 ms, from 1,000.
  Measured in Playwright Chromium against the built app: an idle page answered in at most 2.1 ms
  over 30 tries, and a page in a 200 ms task answered in 201 ms over 5 tries
  (`askToOpen` timed inside the worker). 250 ms tolerates a quarter-second stall and leaves
  750 ms of Firefox's one second (`dom.serviceWorkers.disable_open_click_delay` in
  `StaticPrefList.yaml`) for `navigate` and `openWindow`. When every way of opening fails, the
  notification is shown again with its title, body, icon, badge, tag, actions and data, plus
  `reshown: true` and `silent: true`; a notification with `reshown` is not shown again.
- `tests/worker-opens-ui.test.ts` no longer mocks presence, device activity, `Avatar` or
  `clearResponseCache`. It runs the real client API against a fetch fake that records and refuses
  any request the test did not configure, and fails the test on one.

### Red before the fix

On `7c9041e` plus the new tests:

- `npx vitest run tests/worker-opens-ui.test.ts`: 4 failed. "asks before discarding an edited
  assistant…" found no settings dialog after the message: it had been closed without asking.
  "keeps a section name typed in Settings…" found no `PATCH /preferences`: the rename was dropped.
  The two Discard and Keep editing cases found no prompt.
- `npx vitest run tests/service-worker.test.ts -t "notification taps with the app open"`: 5
  failed. Nothing happened at 250 ms; `openWindow` was not called at 250 ms; a rejected
  `openWindow` rejected the tap's promise and showed nothing, three cases.

### Mutants

| Mutation | Result |
| --- | --- |
| Worker open ignores the sheet's close | failed: 5 unsaved-work cases |
| Waiting destination not opened on close | failed: "opens the chat once the person discards", the section case |
| Staying does not drop the destination | failed: "does not open the chat later…" |
| Settings closes without asking | failed: 3 cases |
| Keep editing not reported | failed: "does not open the chat later…" |
| Settings does not offer its close | failed: 3 cases |
| Settings (preferences) skips saving the typed name | failed: 2 section cases |
| Settings (preferences) closes on a refused name | failed: "leaves Settings open with its reason…" |
| A sheet's close kept after it unmounts | survived at first; killed by the added "opens the chat at once after the person has already discarded an edited assistant" |
| Acknowledgement wait back to 1,000 ms | failed: 2 timing cases |
| No re-show | failed: 3 re-show cases |
| Re-shown without limit | failed: "shows a notification again only once…" |
| Re-show not marked | failed: 2 cases |
| Re-show not silent | failed: 1 case |
| Re-show drops actions | failed: 2 cases |

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/service-worker.test.ts tests/worker-opens-ui.test.ts tests/app-update.test.ts`:
  3 files, 84 tests passed.
- `npm test`: 172 files, 2,690 tests passed.
- `npm run build`, then `npm run test:e2e`: 6 Chromium tests passed.

### Not exercised

- A real notification tap. Playwright cannot click one, so the e2e calls the worker's `openChat`.
- Firefox, Safari and an installed iOS web app: not run. The Firefox timing comes from its source
  and the reviewer's replay, not from Firefox.
