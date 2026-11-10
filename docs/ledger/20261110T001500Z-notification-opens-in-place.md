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

## November 10 second review round

GPT-6.1 Sol's second review verified three findings at `928363b`, in Chromium against the built
app or with a failing test through the real `App`. This round changed the code at `d4d7b02`. It
does not merge `main`; that waits for `perf/cache-first-shell` to merge. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2, Playwright Chromium).

### Findings and changes

- P1, the acknowledgement timeout could reload over an edited settings form. A missing answer no
  longer authorizes replacing the document. `openChat` now takes the notification:
  - First tap, no answer within 250 ms: the window stays as it is, focused, and the
    notification comes back through `showAgain`, marked `reshown: true` and silent, as before.
  - The worker keeps listening on the port for `OPEN_LATE_MS`, 10 seconds. A late answer means
    the page opened the chat, so `closeShownAgain` closes the brought-back notification: only one
    marked `reshown` for the same address, found with `getNotifications`. This covers both
    orders: an answer while `showNotification` is still pending closes it once shown, and one
    after it is on screen closes it then.
  - A tap on a `reshown` notification is the person asking again: the worker asks the page
    again, and only if it still does not answer in 250 ms calls `navigate()`, then
    `openWindow()`. A window running an older bundle, which never answers, therefore gets the
    chat on the second tap, as every tap on `main` does today.
  - Answers are counted per window ID and address. A second tap does not navigate when the page
    answered the first tap while the second waited, so the chat never opens twice.
  - A `reshown` notification is never shown again, as before.
- P2, a failed focus consumed the tap. The focus result is kept. A window that answers but whose
  `focus()` rejects, and was not visible, gets `openWindow(url)`; if that rejects too, the
  notification comes back once. A visible window that answered already shows the chat, so
  nothing more opens.
- P2, a waiting destination outlived its sheet and account. `useCloseRequest` offers a
  `SheetClose` with a token made once per mount. `waitingOnClose()` in `close-request.ts` binds
  the destination to that token and the account ID. A sheet's close takes it only when both
  match, and every close empties it, so a sheet that goes without closing, by an account switch
  or by its assistant leaving the roster, leaves a destination nothing can take.
- README: the paragraphs on taps with the app open describe the first and second tap, the late
  answer, the hidden window, and the destination bound to its sheet. The e2e calls the worker's
  `openChat` with a notification instead of an address.

### Choices

- Ten seconds of late listening. A page stalled longer is likely frozen. If it answers later, the
  notification stays; tapping it asks the page again, which answers in place, so nothing
  reloads.
- A first tap whose window neither answers nor takes focus still only brings the notification
  back. Opening a new window there could open the chat twice if the page then answered late.
- The focus fallback skips a visible window. The e2e found this: Chromium refuses `focus()`
  without a tap's activation, so the visible, answering window then tried `openWindow()`, which
  was refused too. A visible window already shows the chat in place.
- The account binding compares the account ID at the close. An account switch also unmounts
  the sheet, so in the app the sheet token catches it first; the unit test covers the account
  check alone.
- The worker test fakes `MessageChannel`, delivering in a later microtask and dropping messages
  once the port is closed, so tests set when a late answer lands. They also fake
  `getNotifications` over the notifications shown, with a tag replacing the last one.

### Red before the fix

On `928363b` plus the new tests:

- `npx vitest run tests/service-worker.test.ts`: 7 failed. "leaves a window that does not
  answer in time as it is…" failed with "expected "vi.fn()" to be called once with arguments:
  [ 'Ranch Hand', ObjectContaining{…} ]": nothing came back, and the window was navigated. Both
  late-answer orders and both second-tap cases failed because nothing came back. Both hidden
  focus-failure cases failed with `openWindow` not called.
- `npx vitest run tests/worker-opens-ui.test.ts`: 2 failed. "drops a waiting chat when its sheet
  closes with the account it was raised for" failed with "expected 'ranch says howdy' to contain
  'home says howdy'": the old notification's chat opened when Settings closed. "drops a waiting
  destination when its sheet goes without closing, for the same account" failed with "expected
  'today' to be null".
- "closes only the notification it brought back…" and "opens a new window on the second tap…"
  pass on `928363b`: the first guards the filter in `closeShownAgain`, the second the second-tap
  fallback that keeps `main`'s behavior.

### Mutants

Each line was broken by hand, the three focused files run, and the source restored.

| Mutation | Result |
| --- | --- |
| A first tap without an answer navigates | failed: 5 cases |
| No re-show on a first tap without an answer | failed: 5 cases |
| A late answer does not close the brought-back notification | failed: 3 cases |
| The close ignores the `reshown` mark, or the address | failed: "closes only the notification it brought back…" |
| A second tap ignores a late answer to the first | failed: "does not load the chat on a second tap…" |
| Answers not counted | failed: the same |
| A focus failure ignored | failed: both hidden focus cases |
| The focus fallback also for a visible window | failed: "…a visible one opens nothing more" |
| A refused window not re-shown (outer catch) | failed: 3 re-show cases |
| Late listening 10 s changed to 5 s | failed: "leaves a window that does not answer in time…" |
| Answer wait 250 ms changed to 1,000 | failed: 6 cases |
| A second tap does not navigate | failed: both second-tap cases |
| A failed `getNotifications` re-thrown | survived |
| The close takes with no sheet | failed: 5 page cases |
| The wait records no account | failed: 2 page cases |
| One sheet token for every mount | failed: "…goes without closing, for the same account" |
| The sheet's cleanup keeps its close | failed: "opens the chat at once after the person has already discarded…" |
| Sheet or account not compared | failed: their `close-request.test.ts` cases |
| An older stay cancels a newer wait | failed: "is cancelled by its own stay…" |
| A close keeps the wait | failed: 4 `close-request.test.ts` cases |

The survivor: a rejected `getNotifications` reaches the tap's outer `catch`, which calls
`showAgain` on a notification without `reshown`, showing it once more. The `catch` in
`closeShownAgain` stops that, but every fake here lists notifications. It stays: a browser
without `getNotifications` would otherwise bring back a notification for a chat already open.

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/service-worker.test.ts tests/worker-opens-ui.test.ts
  tests/close-request.test.ts tests/app-update.test.ts`: 4 files, 98 tests passed, before the
  visible-window change; `tests/service-worker.test.ts` after it: 65 passed.
- `npm test`: 173 files, 2,705 tests passed, after the last change.
- `npm run build`, then `npm run test:e2e`: 6 Chromium tests passed. The first e2e run failed on
  the in-place case, which led to the visible-window choice above; one later run waited for port
  4173, held by another worktree's server.

### Not exercised

- A real notification tap, and a real page busy past 250 ms. The worker cases fake the browser
  APIs at their boundary; the e2e calls `openChat`.
- Firefox, Safari and an installed iOS web app: not run.
- How long Safari keeps a worker alive for the ten-second late listen.

## November 10 third review round

GPT-6.1 Sol's third review verified two findings at `55c68ad`. This round does not merge `main`.
Checks ran on NicolasLaptop (Fedora, Linux x64, Node 24.22.2, Playwright Chromium).

### Findings and changes

- P2, visible was taken as proof the window reached the person. The Page Visibility
  specification allows `visible` while another application covers the browser. A window now
  counts as in front only when it was `focused` already or its `focus()` succeeded. A window that
  answers in time from behind another application gets the notification back once; no second
  window opens, since the first already shows the chat.
- P2, a late answer skipped the focus result. A first tap's late answer now gets the same
  handling as a prompt one, through `reachPerson()`, and `closeShownAgain` runs only once the
  window is in front or a new window opened for the hidden one. A hidden window whose new window
  is refused keeps the notification.
- `openChat` carries the rule as one table in its comment, and the code follows it: `place` is
  `front`, `visible` or `hidden`; an in-time answer brings the notification back when
  `reachPerson` is false; a late answer closes it only when `reachPerson` is true.
- README: the paragraphs on taps with the app open say what counts as in front and when a late
  answer closes the notification.

### The table

| Window answers | Focus | First tap | Tap on one that came back |
| --- | --- | --- | --- |
| in time | in front | done | done |
| in time | failed, visible | bring it back; no second window | nothing more |
| in time | failed, hidden | open a new window, or bring it back | open a new window |
| late | in front | bring it back, close it at the answer | load the chat into the window |
| late | failed, visible | bring it back and leave it | load the chat into the window |
| late | failed, hidden | bring it back; at the answer open a new window, and close it only if that worked | load the chat into the window |
| never | any | bring it back and leave it | load the chat into the window |

"Load the chat into the window" falls back to a new window when `navigate` fails, and does
nothing when the page answered the first tap meanwhile. Both are unchanged from the second round.

### Red before the fix

On `55c68ad` plus the new table test, which replaces the three-case "when a window answers but
cannot be focused" test:

- `npx vitest run tests/service-worker.test.ts -t "answered"`: 4 of 10 cases failed, the rows
  whose behavior changed. In time, failed while visible: "first tap: expected [] to deeply equal
  [ { url: '/?bot=ranch', …(1) } ]", nothing came back. Late, failed while visible: the same.
  Late, failed while hidden: "first tap: expected [] to deeply equal [ Array(1) ]", no new window.
  Late, failed while hidden with the new window refused: nothing came back.

### Mutants

Each line was broken by hand, `tests/service-worker.test.ts` run, and the source restored.

| Mutation | Result |
| --- | --- |
| `existing.focused` ignored | failed: "in time, focus focused already" |
| Visible counted as in front | failed: both "failed, visible" rows |
| A late answer closes without `reachPerson` | failed: the three late rows that are not in front |
| A hidden window opens no new window | failed: all four hidden rows |
| A refused new window counted as reached | failed: both refused rows |
| An in-time answer never brings the notification back | failed: in time "failed, visible", and the refused hidden row |

### Checks

- `npm run typecheck` and `npm run lint` passed. `npm ci` ran once this round, on the other
  branch; `package.json` and `package-lock.json` match.
- `npx vitest run tests/service-worker.test.ts`: 72 tests passed.
- `npm test`: 173 files, 2,712 tests passed.
- `npm run build`, then `npm run test:e2e`: 6 Chromium tests passed. A temporary probe in the
  in-place e2e case, removed before commit, read the window as `focused: true`,
  `visibilityState: 'visible'`, with `focus()` refused ("Not allowed to focus a window."). The
  e2e therefore runs the "focused already" row, which is why the second round's visible-window
  choice was needed and why `focused` counts as in front here.

### Not exercised

- A real notification tap, a browser behind another application, and a real late page. The worker
  cases fake the browser APIs at their boundary.
- Firefox, Safari and an installed iOS web app: not run.
