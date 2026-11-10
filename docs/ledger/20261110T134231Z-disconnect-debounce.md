# November 10 one failed read no longer shows the chat as disconnected

Branch `t3/disconnect-debounce`, from `origin/main` at `d090194`. Checks ran at the commit that carries
this entry, on NicolasLaptop (Fedora 44, Linux x64, Node 24.22.2), Chromium from Playwright's bundled
build. No server, Python, iOS or Hermes code changed.

## What main did

`useConversation` set `disconnected` on any failed conversation read and cleared it on the next
success. App folded it into one `connectionLost`, which both refused actions and drew the disconnected
state: the dock's connection notice, avatars and activity in the disconnected state, the sidebar's
"Reconnecting", and "Last seen running" on running tools. In the transcript it reached every
`TurnView` (`disconnected`, compared in `sameTurnProps`) and every reply's `MarkdownBlocks`
(`unavailable`, compared in `sameBlock`), so a flip re-rendered every turn and ran `react-markdown`
again on every reply, then did it all again on the next success.

## Change

- `useConversation` keeps two facts. `readFailed` is set by any failed read, at once. `disconnected`,
  what the chat shows, is set by a second failure in a row, by `DISCONNECT_GRACE_MS` (3 seconds) after a
  first failure with no successful read, or at once by a failure that proves the connection is down:
  `navigator.onLine === false`, or an `ApiError` whose code is a Hermes connection diagnosis
  (`not_configured`, `invalid_config`, `connecting`, `unreachable`, `unauthorized`, `addon_missing`,
  `incompatible`, `reconnecting`, `closed`) or `hermes_unauthorized` or `hermes_maintenance`. A request
  that never reached the app (`CONNECTION_UNAVAILABLE`, which also covers timeouts), an unreadable
  answer (`INVALID_RESPONSE`), a failure without a code and a non-API error may be blips. The first
  success clears both.
- App gates on `connectionLost` (session down, a read failed, or offline) and draws from
  `connectionShown` (session down, `disconnected`, or offline). Gates kept on the immediate fact: send
  (`useSubmission` and the Composer's Send), Talk, Stop (Composer and the shortcut), the model
  picker, check-in settings and Artifacts in assistant details, approvals, attention cards, turn retry,
  loading earlier messages, reply cards, Save and Listen in reply actions, and, from the review round
  below, the transcript's "Create an assistant". Not gated on a failed read on this branch or on `main`:
  attach, paste or drop upload, upload retry, and "Retry this saved message" for an uncertain send.
  An earlier version of this entry listed attach as still immediate; it never had that gate. Moved to the shown fact:
  the dock's connection notice and the Review button's style, the activity state and avatars, the
  sidebar, the command palette, the settings status line, the transcript's live tool, reasoning and
  activity sentence, its disconnected empty state, "Last seen running", and stopping a reply already
  being read aloud.
- `Turns` gives a turn `unavailable` only when one of its replies may hold a reply card (its text holds
  `agent-ui`, as `sameBlock` already tests) and gives that reply alone the flag; it gives a turn
  `disconnected` only when the turn has a running call. No other turn's props change, so no other turn
  renders. Reply actions read `unavailable` from `TranscriptTools` and still render, because their Save
  and Listen buttons show it.
- A failure asks for no read of its own. A re-read one second after a first failure was tried and
  dropped: it changed the bounded-read contract in `use-conversation.ts`, and `tests/app-ui.test.ts`
  "keeps a turn whose read failed for the next read, without reading again for it" failed on it, because
  that read would settle a held turn. The next read comes from a change notice, the stream, a wake, the
  `online` event or the 30-second poll, as before.

## Measurements

Chromium, production build with `react-dom/profiling`, the probe in
[`../evidence/2026-11-10-disconnect-debounce/`](../evidence/2026-11-10-disconnect-debounce/) (counts
`TurnView` and `MarkdownBlocks` renders, each `MarkdownBlocks` render being one `react-markdown`
parse, and `MessageActions` renders; never committed to `src`). The preview is
`.agents/tools/streaming-preview.ts` from `t3/window-work-memo` with `SEED_TURNS=80`, idle, first
page: 20 turns, 40 replies counting progress lines, 5 of them with email cards. Each run opens Ranch
Hand, aborts the next conversation read at the network (`route.abort`, which the client API reports as
`CONNECTION_UNAVAILABLE`), asks a read, waits 200 ms, lets the next read through and asks it, then
waits 1.5 seconds. Three runs each; every run gave the same counts. Raw output: `results.json`.

| One failed read, then a success | Before (`d090194`) | After |
| --- | --- | --- |
| Disconnected state shown during the failure | yes, all 3 runs | no, all 3 runs |
| `TurnView` renders | 40 (every turn, twice) | 10 (the 5 turns with cards, twice) |
| Markdown parses (`MarkdownBlocks` renders) | 80 (every reply, twice) | 10 (the 5 card replies, twice) |
| `MessageActions` renders | 80 | 80 |
| Transcript commits over 0.5 ms, ms | 41.1 + 20.7, 33.0 + 20.4, 33.8 + 23.7 | 10.8 + 10.7, 16.4 + 9.8, 10.5 + 8.8 + 3.8 |

Email cards do not read `unavailable`, but the `agent-ui` test cannot tell card types apart without
parsing, so their turns still render.

## Application tests

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/connection-ui.test.ts tests/app-ui.test.ts tests/shell-ui.test.ts
  tests/transcript-ui.test.ts tests/live-reply-ui.test.ts`: 5 files, 302 tests passed.
- `npm test`: 184 files, 3,087 tests passed.
- `npm run build` passed. `npm run test:e2e`, with ports 4173 and 4174 contended by another worktree's
  runs: one attempt reported 13 passed and listed three tests under a summary heading that was not
  captured (the reply across a tool call, the notification tap, the sideways phone keyboard), most
  likely the other worktree's server taking the ports mid-run; the next complete run passed all 20
  Chromium tests.

New tests in `tests/connection-ui.test.ts`, "a failed conversation read", run the real app with only
the client API module mocked, on fake timers pinned to November 10, 2026. The review round below moved
them to `tests/connection-grace-ui.test.ts` and changed their fixture and render evidence:

- One failure that the next read answers shows nothing, even 3 seconds later.
- A second failure in a row shows it at once.
- One failure shows it at 3 seconds and not at 2,999 ms, and the next success clears it.
- One failure shows at once when the browser is offline or the server answers `unreachable`, and not
  for `INVALID_RESPONSE`, a 500 without a code, or a plain `Error`.
- During the grace period Stop and Send guidance are disabled and submitting the form writes nothing;
  both work again after a successful read.
- The rows: one failure re-renders the form card's reply and disables its submit button, and leaves the
  plain replies' Markdown, a progress line in the card's own turn, and the first turn's own rows as they
  were. Once the connection shows as down, only the running tool's turn adds "Last seen running", and
  the plain replies and the first turn still do not render. Renders are seen through React 19.3's
  `__reactProps$` object, compared by identity; `renderedProps` moved from `tests/shell-ui.test.ts` to
  `tests/ui-harness.ts` for this.

Two `tests/app-ui.test.ts` cases that expected the disconnected avatar and "Last seen running" right
after one generic failure now advance `DISCONNECT_GRACE_MS` first.

## Mutants

Each line was broken by hand, the "a failed conversation read" tests run, and the source restored.

| Mutation | Result |
| --- | --- |
| No failure proves the connection down | failed: offline case |
| `navigator.onLine` not checked | failed: offline case |
| Any API error code proves it down | 5 failed, including the unreadable-answer case |
| A second failure not enough (`> 2`) | 2 failed, including "a second failure in a row" |
| Grace one millisecond short | failed: the 3-second boundary |
| A success leaves the grace timer running | failed: "one failure that the next read answers" |
| Send and Stop gated on the shown fact | 2 failed, including "refuses a send and a stop" |
| Every turn gets `unavailable` | failed: the rows test (first turn rendered) |
| Every reply in a card's turn gets `unavailable` | failed: the rows test (progress line parsed) |
| Every turn gets `disconnected` | failed: the rows test (first turn rendered) |
| "Last seen running" follows the immediate fact | failed: the rows test |

A first version of the rows test compared props objects with `toEqual`. That let "every turn gets
`unavailable`" and "every turn gets `disconnected`" survive, because a re-render with equal props is
deep-equal. It now compares identity, and both fail.

## Review round: GPT-6.1 Sol findings

Fixed on `t3/disconnect-debounce` after head `7ae44fc`, same host and toolchain. Implemented by Claude
Opus 5.5.

### 1. P1: the transcript's "Create an assistant" during a failed read

The reviewer found the transcript's empty state offered an enabled "Create an assistant" while
`readFailed` was still true, after a failed read and then a roster refresh that removed the last
assistant. The cause underneath: `readFailed` and `disconnected` were plain booleans. When the roster
emptied, `botId` became `""`, the effect returned before its reset, and nothing ever cleared them; no
read runs with no chat open. Gating the button on the immediate fact alone made it worse: in a test,
the transcript's button stayed disabled 6 seconds after the chat was gone, with no way back but
creating an assistant from the home list, whose own button was never gated on `main` or here.

- `useConversation` now records which chat a failure belongs to (`readFailedFor`, `disconnectedFor`)
  and reports `readFailed` and `disconnected` only for the open chat. A failure clears when its chat
  closes or leaves the roster. The roster refresh that removed the chat succeeded with Hermes
  connected, which is more evidence than one conversation read.
- The transcript's "Create an assistant" is also disabled on `connectionLost`, with the tooltip
  "Checking the connection. Try again in a moment.", as the reviewer asked. With the first change, no
  path reaches it: `!selected` with a failed read of the open chat needs a roster without the open
  chat while Hermes is connected, and the session moves `botId` in that same refresh. It stays as the
  option that refuses more; the mutant that removes it survives for that reason.
- The exact red the reviewer described, "the button enabled while `readFailed` is true", cannot be a
  passing assertion once the failure is cleared, so the test pins the outcome instead: after the roster
  empties, past the grace period, no connection notice shows, the transcript's button is enabled with
  no tooltip, and it opens setup. It runs twice: after one failure, still in its grace period, and after
  two in a row, which already show the chat as disconnected. In the second case `main` and `7ae44fc`
  both kept the transcript's full connection panel for good, since `disconnected` was never cleared
  either. Red runs for the first case: at `7ae44fc` it passes, because the stale failure gates
  nothing visible yet. With only the gate added it failed, `expected true to be false` on the
  button's `disabled`. With the gate and the ownership check it passes.

### 2. P2: Send and Stop refused with no explanation during the grace period

The Composer now gets `connectionShown` beside `connectionLost`.

- While a read has failed and the chat does not show it yet, a disabled Send or Stop has the title
  "Checking the connection. Try again in a moment." The buttons are named by `aria-label`, so the title
  is also their accessible description. Once the chat shows it is disconnected, the title is "Waiting
  for the connection. Your draft is kept." With the connection back, Send has no title and Stop's is
  "Stop response" again.
- A send refused from the keyboard during the grace period sets the composer's status line,
  `#composer-paste-status`, to "Not sent. Checking the connection. Try again in a moment." It is the
  line the composer already uses to explain what happened to a long paste: a `role="status"` paragraph
  that is always in the page, so a screen reader hears each new line once, and the message box points
  `aria-describedby` at it while it has text. It clears when the person types, after 8 seconds, or when
  the dock's connection notice appears, so one notice explains at a time. During a shown outage a
  refused keyboard send adds nothing to it. No composer element existed for a refused send before; the
  dock's send notices are for a send that Hermes answered, so the status line was the closest fit.
- Nothing visible appears from a blip on its own: the tooltip needs a hover and the status line needs a
  send. The form's own submit is unchanged, because Send is disabled and the keyboard path never
  submits the form.

What a person sees and hears:

| Case | Sees | Hears |
| --- | --- | --- |
| One blip, cleared in 300 ms | Nothing changes. A hover on Send or Stop inside those 300 ms shows "Checking the connection. Try again in a moment." A keyboard send inside them shows "Not sent. Checking the connection. Try again in a moment." under the message box for up to 8 seconds or until they type; the message stays in the box. | Nothing, unless they focus Send or Stop, which reads the same reason as the description, or send from the keyboard, which announces the status line once. |
| One blip lasting 2 seconds | The same, for 2 seconds. The chat never looks disconnected. | The same. |
| A real outage | Up to 3 seconds as above, or at once on a second failure, offline, or a Hermes-down answer. Then the dock's connection notice, the disconnected avatars and activity, as on `main`; the status line clears, and Send and Stop's tooltip reads "Waiting for the connection. Your draft is kept." | The connection notice's status line, as on `main`; Send and Stop read the waiting reason as their description. |

Red runs, before the Composer change: "refuses a send and a stop during the grace period, says why"
failed with `expected 'Stop response' to be 'Checking the connection. Try again in…'`, and "hands the
explanation to the connection notice" failed with `expected '' to be 'Not sent. Checking the
connection. Tr…'`.

### 3 and 4. The tests' fixture and render evidence

The branch's tests moved from `tests/connection-ui.test.ts`, which is back to `main`'s text, to
`tests/connection-grace-ui.test.ts`, so they run without that file's module mocks.

- Only `../src/client-api` is replaced, and only its `api` and `write`. Each lists the requests it
  serves: bootstrap, the conversation, the draft, routine runs, the group catalog and a form card's
  receipt lookup, which the server answers `uncertain` for an ID it never saw; and the presence and
  device-activity `PUT`s. Anything else throws and is recorded, and `afterEach` fails the test on any
  recorded request, because the app swallows some failed requests.
- The presence hooks and `Avatar` run for real. jsdom gaps are filled as other UI tests fill them:
  SVG path geometry and `IntersectionObserver` for the avatar, `showModal` and `close` for the setup
  dialog.
- Markdown parses are counted at `remark-gfm`, the plugin the app hands every React Markdown parse:
  a pass-through wrapper runs the real plugin and adds a step that records each parsed source. The
  rows test now asserts which replies parsed: all four on opening, only the card reply on one failure,
  none when the connection shows down, and only the card reply on recovery. This is a second
  `vi.mock`, but it replaces no behavior.
- The first turn's rows still use `renderedProps`, as the one assertion that sees a turn render
  without a parse. No public API reports a memoized component's skipped render, and the parse count
  cannot see a turn that renders while reusing its Markdown, which is what "every turn gets
  `unavailable`" and "every turn gets `disconnected`" do. `renderedProps` throws if React stops
  keeping the object, so an upgrade fails it loudly. A `Profiler` around App reports commits, not
  which turn rendered, and one inside `Turns` would be test code in `src`.

### 5. Gates the first version listed wrongly

Attach, paste or drop upload, upload retry and "Retry this saved message" have no conversation-failure
gate on this branch or on `main`; the Change section above now says so. No behavior changed.

### Mutants, review round

Each line broken by hand with
[`mutate.py`](../evidence/2026-11-10-disconnect-debounce/mutate.py), the new file run, and the source
restored.

| Mutation | Result |
| --- | --- |
| A failure gates any chat, not its own (`!!readFailedFor`) | 2 failed: both "once its chat is gone" cases |
| A shown disconnection outlives its chat (`!!disconnectedFor`) | failed: "once its chat is gone", two failures in a row |
| The transcript's "Create an assistant" ignores `connectionLost` | survived: unreachable, see item 1 |
| Stop gives no connection reason | failed: "refuses a send and a stop" |
| Send gives no connection reason | 2 failed |
| Grace and outage reasons swapped | 2 failed |
| A refused keyboard send says nothing | 2 failed |
| The status line also speaks during a shown outage | failed: "hands the explanation" |
| The status line stays once the connection notice shows | failed: "hands the explanation" |
| Every reply in a card's turn gets `unavailable` | failed: the rows test (progress line parsed) |
| Every turn gets `unavailable` | failed: the rows test |
| Every turn gets `disconnected` | failed: the rows test |
| "Last seen running" follows the immediate fact | failed: the rows test |
| No failure proves the connection down | 2 failed: offline, unreachable |
| `navigator.onLine` not checked | failed: offline |
| Any API error code proves it down | 6 failed, including the unreadable-answer case |
| A second failure not enough (`> 2`) | 3 failed, including "a second failure in a row" |
| Grace one millisecond short | failed: the 3-second boundary |
| A success leaves the grace timer running | failed: "one failure that the next read answers" |
| Send and Stop gated on the shown fact | 3 failed, including "refuses a send and a stop" |

### Checks, review round

- `npm ci` once, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/connection-grace-ui.test.ts tests/connection-ui.test.ts tests/app-ui.test.ts
  tests/shell-ui.test.ts tests/transcript-ui.test.ts tests/live-reply-ui.test.ts`: 6 files, 305 tests
  passed, the first round's 302 and the 3 new ones.
- `npm test`: 185 files, 3,090 tests passed.
- `npm run build` passed. `npm run test:e2e`: 20 Chromium tests passed, ports uncontended.

## Not run

Safari, Firefox, a screen reader and a real phone: not run. The review round's accessible description
and status line were checked in jsdom only. The native iOS app has its own connection handling and is
unchanged. The session-level `disconnected` (bootstrap and connection checks) and `offline` still show
at once, as before; only the conversation read has the grace period. On an idle chat, one blip still
shows the disconnected state after 3 seconds and keeps it until the next read, which may be the
30-second poll.
