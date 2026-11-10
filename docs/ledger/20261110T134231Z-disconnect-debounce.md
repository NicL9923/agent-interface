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
  (`useSubmission` and the Composer's Send), attach, Talk, Stop (Composer and the shortcut), the model
  picker, check-in settings and Artifacts in assistant details, approvals, attention cards, turn retry,
  loading earlier messages, reply cards, and Save and Listen in reply actions. Moved to the shown fact:
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
the client API module mocked, on fake timers pinned to November 10, 2026:

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

## Not run

Safari, Firefox and a real phone: not run. The native iOS app has its own connection handling and is
unchanged. The session-level `disconnected` (bootstrap and connection checks) and `offline` still show
at once, as before; only the conversation read has the grace period. On an idle chat, one blip still
shows the disconnected state after 3 seconds and keeps it until the next read, which may be the
30-second poll.
