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
