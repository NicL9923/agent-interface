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

## November 10 fourth review round: the design reduced

GPT-6.1 Sol's fourth review at `4f6839e` found three paths that left the person with no window in
front and no notification, all on a tap of a notification that had come back: a prompt answer from
a visible window that could not come forward, a hidden window whose new window was refused, and a
navigation that worked while the window stayed hidden. It also found that two overlapping taps
could each open a new window for a hidden window that could not come forward. Every round so far
had found new cases of the same two kinds, so the orchestrator decided to cut the states down to
one invariant instead of patching the cases. This round does not merge `main`. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2, Playwright Chromium).

### The invariant and the rules

Every tap ends with a window known to be in front showing the chat, or the notification on screen
again. "In front" is a window that was focused already, one whose `focus()` succeeded, or one
`openWindow` just opened. The comment above `openChat` holds this table, and `reach()` reads as it:

| Rule | Window this worker controls | Then |
| --- | --- | --- |
| 1 | none | `openWindow`. If that fails, the notification comes back. |
| 2 | answers within 250 ms | The chat is open in it. In front: done. If not, it comes back. |
| 3 | no answer in time, first tap | The window is left as it is and a focus attempted. The notification comes back, marked as having come back. |
| 4 | no answer in time, tap on a marked notification | `navigate` the window, or `openWindow` if that fails. Then, unless a window is known to be in front, the notification comes back. |

The 250 ms wait and its reasoning, the rule that a first tap never replaces the document, and the
page side (the discard question, the sheet and account binding) are unchanged.

### Removed

- The ten-second late listening (`OPEN_LATE_MS`), the answer counts per window (`answered`,
  `answerKey`), `within()` and `closeShownAgain()`. `askToOpen` closes its port at the 250 ms
  deadline, so a late answer is not heard. If a page answers late, it has opened the chat, and the
  notification that came back stays until the person dismisses it or taps it, which gets a prompt
  answer.
- Opening a new window for a window that answered (`reachPerson()` and its `visible`/`hidden`
  split). A window that answered shows the chat; if it is not in front, the notification comes
  back. This removes the double open.
- The limit of one re-show. The notification now comes back every time a tap does not reach the
  person, always silent and marked. It comes back only as the direct result of a tap, so it cannot
  loop without the person tapping. The limit was what left the round's three paths with nothing on
  screen.
- The `.catch(() => showAgain(...))` in the `notificationclick` handler moved into `openChat`, so
  overlapping taps share it.

### Overlap

With the late listening gone, the overlap left is two taps on the same chat while the first is
still being handled: a double tap, or taps on two notifications about one chat. Without a guard
each would ask the page, and on rule 1 or 4 each would navigate or open a window. `openChat` keeps
one attempt in flight per address, and a second tap joins it; the entry goes when the attempt ends,
so the next tap starts its own. The key is the address alone, not window and address: the worker
picks the window after an `await`, and a window the first tap opened can appear in the second
tap's `matchAll`, so a window-keyed check could miss the join. One attempt per chat also covers
the window the orchestrator named.

### Tests

`tests/service-worker.test.ts`, "notification taps with the app open":

- One table, "rule N: …", one row per rule and way it ends, 13 rows. Each asserts the invariant
  through `ending()`: a new window `openWindow` resolved, or an open window that answered in time
  or was navigated and was focused already or focused; otherwise exactly one notification, marked
  as having come back. Each also asserts how many times the window was asked, navigated, and a new
  window opened.
- "two overlapping taps act once", 5 rows from that table: rules 1, 2, 3 and both outcomes of 4.
  The notifications are untagged, so two shown would both stay; the second tap starts before the
  first has heard anything back. Each asserts one ask, load or new window and at most one
  notification.
- "brings the notification back when a step fails in a way the rules do not name": `matchAll`
  rejects.
- Kept: the 250 ms boundary (now asserting the tap ends at 250 ms), the sequential second tap that
  loads into a silent window, the new window a quarter second after a failed load, the uncontrolled
  window, the window the person was last in, and the re-shown notification's fields and actions.
- Deleted with the late listening: both "closes the brought-back notification when the page
  answers late…", "closes only the notification it brought back…", "does not load the chat on a
  second tap once the page has answered the first one late", "shows a notification again only
  once…", and the third round's 10-row table.

### Red before the change

The new `tests/service-worker.test.ts` copied onto a worktree at `4f6839e`:
`npx vitest run tests/service-worker.test.ts -t "notification taps with the app open"`: 13 failed,
13 passed. Each changed row failed:

| Test | Failure on `4f6839e` |
| --- | --- |
| waits 250 ms for an answer, then leaves the window as it is… | "expected false to be true": the tap still listened past 250 ms |
| rule 1: a new window is refused on a tap of one that came back | "a window in front, or the notification back: expected 1 to be +0": nothing on screen |
| rule 2: the window cannot come forward (hidden) | "expected 'in front' to be 'back'": a second window opened |
| rule 2: the window cannot come forward, on a tap of one that came back | nothing on screen |
| rule 3: the window comes forward; rule 3: the page answers late | timed out in 15,000 ms: the tap waited ten seconds |
| rule 4: the chat loads into the window, which cannot come forward | nothing on screen |
| rule 4: loading fails and a new window is refused | nothing on screen |
| two overlapping taps, rule 1 | "expected { … opened: 2 } to deeply equal { … opened: 1 }" |
| two overlapping taps, rule 2 | "expected 'in front' to be 'back'": new windows opened |
| two overlapping taps, rule 3 | timed out in 15,000 ms |
| two overlapping taps, rule 4: loading fails and a new window opens | "expected { asked: 2, navigated: 2, opened: 2 } to deeply equal { asked: 1, navigated: 1, opened: 1 }" |
| two overlapping taps, rule 4: …cannot come forward | nothing on screen |

The rows that pass there are the ones whose behavior did not change: rule 1 with a new window or
refused on a first tap, rule 2 in front either way, and rule 4 in front either way. "brings the
notification back when a step fails…" needs the fake's new `clients` handle, so it was written
after this run; mutant W12 below shows it can fail.

### Mutants

Each line was broken by hand, `tests/service-worker.test.ts` run (76 tests), and the source
restored.

| Mutation | Result |
| --- | --- |
| W1 A second tap never joins | failed: all 5 overlap rows |
| W2 An attempt is never cleared | failed: "loads the chat into a window that still does not answer…" |
| W3 An answer in time counts as in front | failed: both rule 2 "cannot come forward" rows and their overlap row |
| W4 A first tap without an answer navigates | failed: 5 |
| W5 A navigation counts as in front | failed: rule 4 "…cannot come forward" and its overlap row |
| W6 No new window after `navigate` fails | failed: 4 |
| W7 A refused new window counts as in front | failed: 5 |
| W8 `focused` ignored | failed: "rule 2: the window was focused already" |
| W9 Answer wait 250 ms changed to 1,000 | failed: 12 |
| W10 The notification brought back is not marked | failed: 11 |
| W11 Not silent | failed: 2 |
| W12 An unexpected failure not caught | failed: "brings the notification back when a step fails…" |
| W13 Never brought back | failed: 16 |
| W14 No focus attempted | failed: 4 |
| W15 Port not closed at the deadline | survived |

W15 survives because closing the port is cleanup: the answer promise has already settled at the
deadline, so a late message reaching `onmessage` cannot change the outcome. It stays so a stalled
page's port is released.

### Checks

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/service-worker.test.ts tests/worker-opens-ui.test.ts
  tests/close-request.test.ts`: 3 files, 103 tests passed.
- `npm test`: 173 files, 2,716 tests passed.
- `npm run build`, then `npm run test:e2e`: 6 Chromium tests passed. The in-place case runs
  rule 2 with a window focused already.

### Not exercised

- A real notification tap, a browser behind another application, a real late page and real
  overlapping taps. The worker cases fake the browser APIs at their boundary; the e2e calls
  `openChat`.
- Safari, Firefox and an installed iOS web app: not run.

## November 10 fifth review round: bringing the notification back

GPT-6.1 Sol's fifth review at `4f6fc28` cleared the four rules, the 13-row table, the overlap rows
and every rejecting call except two, both in bringing the notification back. This round does not
merge `main`. Checks ran on NicolasLaptop (Fedora, Linux x64, Node 24.22.2, Playwright Chromium).

### Findings and changes

1. A tap on the brought-back notification before its `showNotification()` settled joined the
   attempt that was ending, closed the notification, and left no window in front and nothing on
   screen. The Notifications standard lets the notification show before the promise resolves.
   Each attempt in `openChat` now carries `restoring`, set when it starts bringing the
   notification back. A tap that finds its chat's attempt restoring waits for it to settle, then
   calls `openChat` again. The first such tap starts a new attempt and the rest join it as
   overlapping taps do, so several share one new attempt. The new attempt runs whatever the
   restoration did, so a restoration the tap itself closed never counts for that tap.
2. A rejected `showNotification()` escaped the shared attempt: both joined taps rejected and
   nothing was on screen. `restore()` now retries once inside the attempt and swallows a second
   failure, so every joined tap ends cleanly. That double failure is the one case the invariant
   does not cover, and the comment and README say so.

The comment above `openChat` gained one sentence for each. The README paragraph after the rules
now describes both. No state was added beyond `restoring`; late listening, answer counting and
a second window for a window that answered stay out.

### Tests

`tests/service-worker.test.ts`, "notification taps with the app open":

- "a tap while the notification is being brought back": the reviewer's sequence (rule 2, the
  window cannot come forward) with only the completion of `showNotification()` held. One case
  taps the notification on screen, which closes it, and asserts the window is not asked again
  before the restoration settles, then the invariant through `ending()` and one more ask. The
  other adds a second tap and asserts the two share one new attempt: two asks and two
  `showNotification()` calls in all.
- "bringing the notification back fails": a rejection then success, for one tap and two joined
  taps, through `ending()`; and two rejections, asserting both taps fulfil and no third
  `showNotification()` call follows.
- The `tap` helper now lets a test pass the notification's `close`, so a tap can close the one
  on screen.

The 13 table rows and five overlap rows pass unchanged; no expected count in them changed.

### Red before the fix

The new tests against `4f6fc28`'s worker:
`npx vitest run tests/service-worker.test.ts -t "notification taps with the app open"`: 5 failed,
27 passed.

| Test | Failure on `4f6fc28` |
| --- | --- |
| starts a new attempt once the notification is back… | "a window in front, or the notification back: expected 1 to be +0": nothing on screen |
| starts one new attempt for several taps | the same |
| tries once more, for 1 tap(s) and for 2 tap(s) | the tap rejected with "Failed to store the notification." |
| ends every tap without a rejection when the second try fails too | both taps rejected |

### Mutants

Each line was broken by hand, `tests/service-worker.test.ts` run (81 tests), and the source
restored.

| Mutation | Result |
| --- | --- |
| R1 `restoring` never set | failed: both "a tap while…" cases |
| R2 A tap while restoring joins the ending attempt | failed: both "a tap while…" cases |
| R3 The new attempt starts before the restoration settles | failed: both "a tap while…" cases ("not asked again before the notification is back") |
| R4 Each tap while restoring starts its own attempt | failed: "starts one new attempt for several taps" |
| R5 No retry | failed: 3 |
| R6 Second failure not caught | failed: "ends every tap without a rejection…" |
| R7 Retry not bounded | failed: "ends every tap without a rejection…" |

A first version kept a shared `next` promise for the taps while restoring. A mutant that
replaced it on every tap survived, because a second `openChat` after the restoration already
joins the attempt the first started, so the field was removed. A mutant starting the new attempt
at once also survived that first version; the "not asked again before the notification is back"
assertion was added after the red run above to catch it, and R3 shows it can fail.

### Checks

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/service-worker.test.ts tests/worker-opens-ui.test.ts
  tests/close-request.test.ts`: 3 files, 108 tests passed.
- `npm test`: 173 files, 2,721 tests passed.
- `npm run build`, then `npm run test:e2e`: 6 Chromium tests passed.

### Not exercised

- A real notification tap during a real pending `showNotification()`, and a real storage
  failure. The worker cases fake the browser APIs at their boundary.
- Safari, Firefox and an installed iOS web app: not run.

## November 10 sixth review round: no waiting on a restoration

GPT-6.1 Sol's sixth review at `c9e5217` verified two findings in last round's wait, both in
`openChat`. The orchestrator chose to remove the wait rather than bound it, and to give every
brought-back notification one tag per chat. This round does not merge `main`. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2, Playwright Chromium).

### Findings and changes

1. A display that never settled left a tap waiting forever: the tap closed the brought-back
   notification, no window came forward, and both `waitUntil` promises stayed pending.
2. Tapping a second notification for the same chat while the first was being brought back
   ended with two notifications for the chat when focus failed again.

- A tap that finds its chat's attempt bringing the notification back starts a new attempt at
  once and replaces it in `attempts`; later taps join the new one. The replaced attempt's promise
  races a `replaced` promise that the new attempt resolves with its own, so the first tap's
  `waitUntil` ends when the new attempt ends, or sooner if its own display settles first. An
  attempt removes itself from `attempts` only while it is still the chat's attempt.
- `restore` waits on the display for at most `RESTORE_MS`, 10 seconds. Storing a notification
  takes milliseconds and browsers may show it before the promise settles, so the bound only stops
  a display that never settles from keeping the worker alive until the browser stops it. The one
  retry of a rejected display stays, inside that bound.
- `showAgain` tags the notification `reshown:` plus the chat's canonical address from
  `conversationUrl`. Original pushes carry the server's `tag`, which is the event's own ID
  (`store-notifications.ts` `enqueue`, `health.ts`, `computer.ts`, `push-routes.ts`), or a fresh
  batch ID for a digest. None is per chat, so there was no scheme to reuse. A failed decline is
  tagged with its notification's tag plus `:decline`, and no address ends that way because
  `conversationUrl` encodes the `bot` and `routine` values. A brought-back notification therefore
  replaces only one brought back for the same chat, never a newer push. Data and actions are kept.
- Removed: last round's wait (`current.done.then(() => openChat(notification))`) and its comment
  sentence. The comment above `openChat` and the README paragraph after the rules now describe
  the new attempt, the tag and the bound.

One loss to know about: a brought-back approval, with its Decline button, is replaced when another
brought-back notification for the same chat arrives. Both were tapped, both open the same chat,
and the approval is answerable there.

### Tests

`tests/service-worker.test.ts`, "notification taps with the app open":

- "starts a new attempt at once that …": the reviewer's first sequence with every display on
  screen and never settling. One row's new attempt cannot come forward either, so both taps stay
  pending at 9,999 ms and end at 10,000 ms with the notification back. In the other the window
  comes forward, and both taps end at once, which only the replacement link can do because the
  first display's own bound is still running. Each checks the invariant through `ending()`.
- "leaves one notification for the chat when another about it is tapped meanwhile": the
  reviewer's second sequence, with untagged notifications; exactly one is on screen, the second's.
- "lets later taps join the new attempt, even once the replaced one settles": replaces last
  round's "starts one new attempt for several taps".
- "brings back notifications for two chats side by side": distinct tags per chat.
- "shows the notification again…" now expects the `reshown:` tag.

The fake notification store already replaced a notification with the same tag, so no existing
test changed meaning. The 13 table rows, five overlap rows and last round's three rejection
cases pass unchanged; no expected count changed. No test was written for a newer push for the
same chat surviving: push tags are event IDs, so no tag of this scheme can match one.

### Red before the fix

The new tests against `c9e5217`'s worker:
`npx vitest run tests/service-worker.test.ts -t "notification taps with the app open"`: 5 failed,
30 passed.

| Test | Failure on `c9e5217` |
| --- | --- |
| starts a new attempt at once that cannot come forward either… | "asked again at once": asked 1, expected 2 |
| starts a new attempt at once that comes forward… | the same |
| leaves one notification for the chat… | "a window in front, or the notification back: expected 1 to be 2" |
| lets later taps join the new attempt… | the window asked once, expected twice |
| shows the notification again… | tag `bot:ranch`, expected `reshown:https://app.example/?bot=ranch` |

"brings back notifications for two chats side by side" passes there, since that worker kept each
notification's own event tag; S6 below shows it can fail.

### Mutants

Each line was broken by hand, `tests/service-worker.test.ts` run (84 tests), and the source
restored.

| Mutation | Result |
| --- | --- |
| S1 Any settling attempt clears the chat's entry | failed: "lets later taps join the new attempt…" |
| S2 No replacement link | failed: "…that comes forward…" |
| S3 No bound on the display | failed: "…that cannot come forward either…" |
| S4 A tap while restoring joins the ending attempt | failed: 4 |
| S5 The original tag kept | failed: "leaves one notification…", "shows the notification again…" |
| S6 One tag for every chat | failed: "…two chats side by side", "shows the notification again…" |
| S7 Bound 10 s changed to 1 s | failed: "…that cannot come forward either…" |
| S8 No retry | failed: 3 |
| S9 Bound timer not cleared | survived |
| S10 `restoring` never set | failed: 4 |

S9 survives because clearing the timer is cleanup: it resolves a promise nobody waits on once the
display settled, and a pending timer does not keep a service worker alive.

### Checks

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/service-worker.test.ts tests/worker-opens-ui.test.ts
  tests/close-request.test.ts`: 3 files, 111 tests passed.
- `npm test`: 173 files, 2,724 tests passed.
- `npm run build`, then `npm run test:e2e`: 6 Chromium tests passed.

### Not exercised

- A real display that never settles, a real late display, and real taps during one. The worker
  cases fake the browser APIs at their boundary.
- Safari, Firefox and an installed iOS web app: not run.

## Seventh review round

GPT-6.1 Sol reviewed `c9e5217..b047676b` and cleared the two round 6 findings: a tap during a
restoration starts at once, replaced attempts finish earlier taps, untagged originals leave one
brought-back notification per chat, and an old attempt settling late cannot clear a newer entry.
It replayed mutants S1 to S10 with the recorded results. One finding, a documentation gap:

- The 10 second deadline adds a second way to end with nothing on screen that the comment and the
  README did not name. Opening a window fails, `showNotification()` stays pending without having
  displayed anything, and at 10,000 ms the tap ends. Neither display was rejected, so the stated
  exception for two rejected displays did not cover it.

Fixed by the orchestrating agent, as the reviewer specified: the comment above `openChat` and the
README now name both cases, and a test pins the second, "stops waiting at the deadline for a
display that has neither appeared nor failed". It asserts the tap is still waiting at 9,999 ms,
has ended at 10,000 ms with nothing on screen and no further try, and that the notification
appears when the browser finishes later, without a second call.

The test describes behavior the code already had, so it passed when written. Two hand breaks
prove it can fail:

| Break | Result |
| --- | --- |
| `RESTORE_MS` raised to 20 seconds | failed: "ended at the deadline: expected false to be true" |
| The wait on the display no longer raced against the deadline | failed the same way |

The reviewer also noted, without a finding, that an old attempt's late retry can replace newer
brought-back content for the same chat. One notification for that chat remains either way.
