# November 19 connection and reconnect states on the web

Branch `t3/improve-connect-reconnect-flows`, from `origin/main` at `18b9699a`, uncommitted when this
was written. Source fingerprint `sha256:b6f747d5f35605f5e1d4c8aad457a8fd96f87331e305373d3561d97dbe4d6abc` from `python3 .agents/tools/source-state.py`. Checks ran
on NicolasLaptop (Fedora 44, Linux x64, Node 24.22.2), Chromium from Playwright's bundled build. No
server, Python, iOS or Hermes code changed.

## What production showed

`journalctl --user -u agent-interface.service --since "14 days ago"` on the production host, read on
November 19: 655 lines, November 5 to November 19.

| Observed                                            | Count                                                       |
| --------------------------------------------------- | ----------------------------------------------------------- |
| App service starts (deploys and restarts)           | 30                                                          |
| Hermes socket losses the app logged, and recoveries | 19 lost, 20 recovered                                       |
| Conversation reads answered with a 502              | 2                                                           |
| Conversation reads slower than 1 second             | 63 log lines, 483 requests counting each line's repeats     |
| Their duration                                      | median 2,983 ms, 95th percentile 4,616 ms, longest 6,760 ms |
| Conversation reads slower than 10 seconds           | 0                                                           |

The server almost never fails a conversation read, and no read came near the client's 20-second
timeout. A member who sees "Reconnecting" often is seeing the client's own handling of short losses:
30 restarts, 19 Hermes socket losses, and whatever the network does when a phone or laptop wakes.

## What main did

Each of these was read in the code and, where a browser could show it, reproduced in Chromium against
the loopback preview with [`capture-before.js`](../evidence/2026-11-19-connection-states/capture-before.js).

1. A failed bootstrap, a bootstrap that found Hermes not connected, and `navigator.onLine` turning
   false each showed the whole app as disconnected in the same render. Only a failed conversation read
   had the 3-second grace period of November 10.
2. A failed bootstrap set no read of its own. The next came when the household stream reconnected, on
   focus, or with the 45-second poll. A bootstrap that failed while the stream's own connection opened
   was the read the stream's `onopen` joined, so nothing read again until the poll.
3. A failed conversation read set no read of its own either, as the November 10 entry notes. With the
   chat's stream live the next read could be 2 minutes away, so one failed read showed "Reconnecting
   to Hermes" 3 seconds later and kept it.
4. Opening a chat asks for two reads back to back: the opening read, and the read the stream's `onopen`
   asks while the first is on its way. Two failures in a row showed the loss at once, so on opening a
   chat the grace period did not apply.
5. The server answers a single Hermes call that timed out with a 502 and the code `unreachable`, while
   its socket and every other chat are fine (`hermes-transport.ts`, "timed out. Try again."). The
   client took any such code as proof and showed the loss at once.
6. Any of these, including one chat's failed read, marked every assistant disconnected. In the preview
   fixture that was nine avatars desaturated with a question-mark badge, "Reconnecting" under each
   pinned assistant and beside the account button, "Ledger is reconnecting..." as a row in the
   transcript, and a card above the composer with a heading, a paragraph, a button and a disclosure.
7. Every state's copy said "Your draft is kept", with or without a draft. So did the client API's
   message for a read that never reached the app, which other screens show as their error.
8. A chat that had never loaded, once its loss showed, drew an empty transcript with only the
   "is reconnecting..." row.

## Change

- `src/app/outage.ts`, new. `useOutage(down, definite, scope)` is the one rule for when a loss goes on
  screen: after `OUTAGE_GRACE_MS` (3 seconds), at once when `definite`, `lasting` from
  `OUTAGE_LASTING_MS` (10 seconds) after it began, and for at least `OUTAGE_MIN_SHOWN_MS` (1 second) from
  when it was drawn. It is a small state machine: `down` changing and three timers take every step, and
  the render reads where the outage stands, never the clock. It also reports `lingering` (the loss is
  over and its notice is staying out its second) and `recoveries` (losses that were on screen and came
  back). App uses it twice: for the app (`session.disconnected` or offline) and for the open chat's
  failed reads, scoped to that chat and timed only while the chat is on screen. A loss is definite when
  it needs a person (`needsSetup`), when no bootstrap on this page has found Hermes connected, or when
  live updates have already been down for 20 seconds and their notice is on screen.
- `connectionLost` is unchanged: session down, offline, or the open chat's read failed. Everything it
  gated on main is still refused from the first moment.
- `useConversation` reports only `readFailed`. Its grace timer, the second-failure rule and
  `provesDisconnected` are gone. A failed read is retried after `READ_RETRY_MS` (1, 2, 4, 8, 16, then
  30 seconds), not while hidden or offline, and a success stops the chain and starts the waits over.
  This changes the bounded-read contract of November 10, which the comment in `use-conversation.ts` now
  lists as one of the inputs a read answers.
- `useSession` retries a bootstrap that failed or found Hermes down after `BOOTSTRAP_RETRY_MS` (1, 2, 4,
  8, 16 seconds), then leaves it to the 45-second poll. It reports `everConnected`.
- A failed conversation read asks bootstrap once what is down. While bootstrap still finds Hermes
  connected, the loss is the chat's alone: the notice says "Can't refresh this chat" once it lasts and
  only that chat's header avatar dims. The list of assistants, the command palette, settings and other
  assistants' details follow the app's own loss. On Today, Find and a group chat the notice speaks for the app alone.
- `ConnectionPanel`: the notice above the composer is one row. Until the loss is lasting it reads
  "Reconnecting…" (or "Connecting…" for a server that just started) with a spinner and nothing else.
  Once lasting it names what is down, "Can't reach the app", "Hermes isn't answering" or "Can't refresh
  this chat", says what follows, and adds Reconnect now and, for the app and Hermes, the connection
  details. Setup states and offline are unchanged in substance; offline has its own icon and no
  details. Stopped live updates read "Live updates are delayed". "Your draft is kept" appears only when
  the message box holds words or files, in the notice and on Send's tooltip.
- `ConnectionAnnouncer` says the loss while it is a loss, not while its notice lingers, and says
  "Connected again." for 5 seconds when `recoveries` rises, or "Live updates are back." when that notice
  ends. Its words are held from the moment the connection's own news last changed, so editing a draft
  does not repeat them.
- A disconnected avatar has no badge and a lighter dim (`saturate(0.45)`, was `0.25`) that eases over
  400 ms. Pinned assistants show no caption while disconnected. The transcript's activity row is hidden
  while disconnected. A chat that never loaded says "This conversation hasn't loaded yet".
- The client API's message for a read that never reached the app no longer mentions a draft; a write's
  still does.
- From the review rounds below: a bootstrap takes the server's roster membership always and keeps a
  row's activity when the server marks the row disconnected, for 30 seconds from the first stale roster
  in a row; a bootstrap whose roster is stale is retried like one that failed; a stop question that is
  open when the connection goes refuses its answer and says why in the question; every read drops the
  pending retry as it sets out; a session that is unmounted sets no retry; and "Live updates are back."
  is said only once `useStreamsLive` finds every watched stream up, including when one returns after
  the other.

## What a person sees

Hermes or the app is lost while a chat is open and working:

| Time since the loss | Sees                                                                                                                             | Hears                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 0 to 3 seconds      | Nothing changes. Send and Stop are disabled and say "Checking the connection. Try again in a moment." on hover or focus.         | Nothing.                         |
| 3 to 10 seconds     | One row above the composer: a spinner and "Reconnecting…". Assistants dim. The sidebar says "Reconnecting" once.                 | "Reconnecting…"                  |
| From 10 seconds     | The row names what is down and what follows, with Reconnect now and Connection details.                                          | The same sentence, once.         |
| When it is back     | The row and the dim go, at least 1 second after they appeared. Send works from the first successful read, not when the row goes. | "Connected again." for 5 seconds |

A loss that ends inside 3 seconds shows nothing. The retries make that the usual case: the first is 1
second after the failure.

## Visual checks

Real Chromium against `.agents/tools/preview-app.mjs` on loopback, with routes that fail bootstrap or
the conversation read, at 1440 by 900 and 390 by 844, light and dark, reduced motion on so screenshots
are still. Scripts: [`capture-before.js`](../evidence/2026-11-19-connection-states/capture-before.js)
at `18b9699a` and [`capture-after.js`](../evidence/2026-11-19-connection-states/capture-after.js) on
this change. Each run also read the notice's text, the live region, the sidebar chip and the count of
disconnected avatars and their badges from the page.

- [Phone, before and after](../evidence/2026-11-19-connection-states/before-after-phone.png)
- [Desktop, one chat's read answering `unreachable`](../evidence/2026-11-19-connection-states/before-after-desktop.png)

| State, read from the page at 1440 wide                         | Before                                                            | After                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| One chat's read answers 502 `unreachable`, bootstrap connected | 9 avatars disconnected, 9 badges, sidebar "Reconnecting", at once | nothing for 3 s, then that chat's own 1 or 2 avatars, 0 badges, the list untouched |
| Hermes lost, 1.5 s in                                          | full card, 9 badges                                               | no notice, Send refused with its reason                                            |
| Hermes lost, 3.8 s in                                          | full card                                                         | "Reconnecting…", 8 avatars dimmed, 0 badges                                        |
| Hermes lost, 11 s in, with a draft                             | "Your draft is kept"                                              | "Hermes isn't answering … Your draft is kept. We'll keep trying."                  |
| Hermes lost, 11 s in, no draft                                 | "Your draft is kept"                                              | no mention of a draft                                                              |
| Offline, no draft                                              | "Your draft is kept on this device."                              | "We'll reconnect when you're back online."                                         |

## Application tests

New files: `tests/outage.test.ts` (the timing rule, on fake timers) and `tests/connection-copy.test.ts`
(what the notice says). New cases in `tests/connection-grace-ui.test.ts` (the real app with only the
client API replaced): the loss shows by time however many reads failed, an `unreachable` answer waits
like any other, the one-line and lasting forms, the notice lingering while Send works at once, a
chat-only loss dimming only its chat, bootstrap deciding the scope, the read retries and their guards,
going offline inside the grace period, a chat that never loaded, and the draft sentence. New cases in
`tests/connection-ui.test.ts`: the bootstrap retries and their guards, a first bootstrap that finds
Hermes down, and a setup code mid-session. `tests/live-updates-ui.test.ts`: Today ignores the chat's
failed reads and its draft, and live updates returning is announced. The review round added the
cases its table names: the server's disconnected rows inside the grace period, the list and the chat
read apart, opening another chat, the composer's gates while a notice lingers, the stop question
(`tests/shell-ui.test.ts`), a read on its way at the retry's deadline, a bootstrap answered after
unmount, a notice drawn late, another scope, and draft edits during one loss.

Tests changed because the behavior did:

- `tests/app-ui.test.ts` "keeps a turn whose read failed for the next read" expected no read for 5
  seconds after a failed one. It now expects the retry's one read a second later to place the turn, and
  no read after that.
- `tests/app-ui.test.ts` "stops claiming work during a disconnect" expected the activity row with a
  disconnected avatar. It now expects no row, and the header avatar disconnected without a badge.
- `tests/sidebar-ui.test.ts` expected "Offline" and "Reconnecting" under each pinned assistant. It now
  expects no caption there and the header chip saying it once.
- `tests/connection-grace-ui.test.ts` lost "a second failure in a row" and the table of failures that
  showed at once, for the cases above.
- `tests/live-updates-ui.test.ts`, `tests/shell-ui.test.ts`, `tests/connection-ui.test.ts` and
  `tests/saved-roster-ui.test.ts` follow the new titles and wait out the grace period where a loss
  used to show at once.

## Mutants

Each line was broken with `~/.agents/tools/mutate.py`, the named tests run, and the source restored.
The lists and the tool's output from the final pass, after all the review rounds, are in
[`mutants/`](../evidence/2026-11-19-connection-states/mutants/): 112 mutants, 112 caught. The last
three rows were run after the fifth and sixth review rounds.

| File                                                | Mutants | Result    |
| --------------------------------------------------- | ------- | --------- |
| `src/app/outage.ts`                                 | 24      | 24 caught |
| `src/app/use-conversation.ts`                       | 7       | 7 caught  |
| `src/app/use-session.ts`                            | 18      | 18 caught |
| `src/components/ConnectionPanel.tsx`                | 18      | 18 caught |
| `src/App.tsx`                                       | 24      | 24 caught |
| `Composer`, `Conversation`, `Sidebar`, `client-api` | 5       | 5 caught  |
| `src/components/Avatar.tsx`, `StopConfirm`          | 4       | 4 caught  |
| `src/app/stream-health.ts`                          | 3       | 3 caught  |
| `ConnectionAnnouncer`, partial live return          | 5       | 5 caught  |
| Live-updates scope, `App.tsx` and `stream-health`   | 4       | 4 caught  |

Mutants that survived on the way, and what was done:

- `outage.ts`, first version, "a loss that never showed lingers". No test rendered between the end of a
  short loss and the moment its grace period would have ended. The test now renders again there.
- `outage.ts`, as a state machine, four: the render's own scope check; a lingering notice counted as a
  second recovery when something else changed during its second; a definite loss created already
  shown, which the effect's next pass does anyway, so that branch was removed; and becoming definite
  restarting a notice's minimum time. Tests now read every render after a scope change, change
  `definite` during the linger, and end a loss just after it became definite.
- `use-session.ts`, "retries at the sign-in page". The test ended an account's generation, which unmounts
  the session and clears the timer, so the guard was never reached. It now uses a page that never drew
  an account.
- `use-session.ts`, `rosterFrom`'s `previous?.user.id !== next.user.id` replaced by `!previous`. It
  survives and is left out of the final list: a bootstrap for another member never reaches `setBoot` in
  the same session, because `accountNamed` ends that generation first. The check mirrors the one beside
  it for preferences.
- `App.tsx`, `conversationReadFailed && !appDown`. Nothing a person could see depended on `!appDown`, so
  it was removed.
- `Avatar.tsx`, the portrait's badge guard. `tests/avatar-component.test.ts` now covers a portrait.
  Putting `disconnected` back in the drawn avatar's list is left out of the final list: the guard in
  front of it makes it equivalent.
- `use-conversation.ts`, "a success leaves the pending retry set". Once every read drops the pending
  retry as it sets out, the success's own `stopRetrying()` did nothing, so it was removed.
- `use-session.ts`, a stale streak that a fresh roster never ended. The test now puts a stale and a
  fresh roster before the long wait.
- `App.tsx`, the live-updates outage scoped to the chat. Once the live region asks whether the streams
  are up, a chat just opened never is, so the scope did nothing and was removed.

## Review rounds: GPT-6.2 Sol, high effort

Four independent reviews of the uncommitted diff, each of what the one before had not covered. Every
finding was replayed as a failing test before its fix, except where noted.

### First round: one P1, seven P2, one P3

Eleven tests failed on the reviewed code for the reasons given and pass after.

| #   | Finding                                                                                                                                                                                                          | Fix                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1. While Hermes is down the server lists its cached rows with `activity: "disconnected"` (`hermes.ts`, `listBots`). The client took those rows, so the list of assistants dimmed inside the grace period.       | The roster keeps each row's activity when the server marks it disconnected. The fixture now sends the rows the server sends. Reworked in the second round. |
| 2   | P2. A chat-only loss dimmed the open assistant in the list and could caption its row "Reconnecting", because the list was given the chat's state.                                                                | The list gets the assistant's own activity and applies only the app's loss. The test reads the list and the chat apart.                                    |
| 3   | P2. Opening another chat just after one chat's notice appeared left "Reconnecting…" over the healthy chat, announced "Connected again." with nothing back, and showed the next chat's first failed read at once. | `useOutage` takes a `scope` and drops the outage it is timing when the scope changes. The announcement was reworked in the second round.                   |
| 4   | P2. For the second a notice lingers after the connection is back, the composer was told the assistant was disconnected, so guidance an assistant cannot take, and an unreviewed interruption, could be sent.     | The composer acts on "disconnected" only while the loss is still a loss (`connectionShown && connectionLost`).                                             |
| 5   | P2, on `main` too. A stop question already open when a read failed still sent `POST /stop`.                                                                                                                      | `StopConfirm` takes `unavailable`: Stop work is disabled and the question says why.                                                                        |
| 6   | P2. A read asked just before the retry was due and answered after it left a second read queued behind it.                                                                                                        | Every read drops the pending retry as it sets out; its own outcome sets the next.                                                                          |
| 7   | P2. A bootstrap answered after the app was unmounted set its retries anyway.                                                                                                                                     | `useSession` sets no retry once unmounted.                                                                                                                 |
| 8   | P2. The 1-second minimum counted from when the notice was due, so a timer that ran late drew it and the next successful read removed it at once.                                                                 | The minimum counts from when the notice was drawn.                                                                                                         |
| 9   | P3. Typing the first character of a draft, or clearing the last, changed the live region's text during the same loss.                                                                                            | The announcement is held from the moment the connection's own news last changed. It includes the draft sentence when the loss found a draft.               |

### Second round, of the first round's fixes: six P2, one P3

| #   | Finding                                                                                                                                                                             | Fix                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2. Keeping the whole previous roster during an outage kept an assistant another member had made private; the server filters its last roster for each member even then.             | `rosterFrom`: membership is always the server's, and only a row's activity is kept when the server marks it disconnected.                                                                                      |
| 2   | P2. A roster read that failed with Hermes connected (`profiles.list`) returns the last roster marked disconnected, which dimmed every assistant at once with no notice.             | The same rule: those rows keep what each assistant was doing.                                                                                                                                                  |
| 3   | P2. Leaving a chat for Today with its notice showing announced "Connected again."; a real recovery followed by opening another chat during the notice's second was never announced. | `useOutage` counts `recoveries`, and the live region speaks from that count and from the loss itself, not from the notice. The chat's scope includes whether its chat is on screen.                            |
| 4   | P2. A deadline that passed between a render and its effects was dropped, so the one-line notice could be skipped until 10 seconds.                                                  | The hook is a state machine: the render reads no clock and a timer's delay is clamped at 0. Replayed with a commit that moves the clock past the grace period before the timer is set.                         |
| 5   | P2. A cleanup timer that ran late left the previous outage's timestamps for the next loss, which then skipped its grace period although the notice had gone.                        | By construction: the notice is on screen exactly as long as the state says, and a loss that arrives while it still is continues it. A loss after it has cleared waits its own grace period, which a test pins. |
| 6   | P2. A chat failing behind Today used up its notice's minimum time, so opening the chat as a read succeeded flashed it.                                                              | The chat's outage is timed only while its chat is on screen. Opening the chat starts its grace period.                                                                                                         |
| 7   | P3. The stop question's disabled reason was only a `title`, which a keyboard cannot reach on a disabled button.                                                                     | The reason is a paragraph in the question and part of its description.                                                                                                                                         |

### Third round, of the second round's fixes: six P2

| #   | Finding                                                                                                                                                                                  | Fix                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2, on `main` too. A member's last visible assistant made private during a Hermes outage stays listed: the server then answers no rows, and an empty roster keeps the rows as they were. | Not fixed here. The client cannot tell that answer from a server that has no roster to list, which the rule exists for. It needs a field from the server, and the native app keeps more. See "Not done". |
| 2   | P2. The read that ends a loss, landing in one batch with the timer that ends its grace period, drew the notice for a second and counted a recovery.                                      | A loss falls `due` and is shown only by a commit in which it still is one.                                                                                                                               |
| 3   | P2. A recovery that came while another warning was being said was kept, and said when that warning went, as on opening Today.                                                            | Something that comes back while a warning is being said is not kept.                                                                                                                                     |
| 4   | P2. Leaving a chat whose stream was down for a healthy one announced "Live updates are back.".                                                                                           | Stopped live updates are an outage of their own, scoped to the chat, so leaving it is no recovery.                                                                                                       |
| 5   | P2. On a phone's home list the chat behind it was timed and announced, and showed its notice at once when opened.                                                                        | The chat's outage is timed only while the chat is on screen, which behind the home list it is not.                                                                                                       |
| 6   | P2. A roster that stayed stale while Hermes answered kept an assistant shown as working with no end.                                                                                     | A stale roster keeps what each assistant was doing for `ROSTER_CARRY_MS` (30 seconds) after the last fresh one, counts as a miss, and is read again on the bootstrap retries.                            |

### Fourth round, of the third round's fixes: five P2

The fifth round reviewed these fixes.

| #   | Finding                                                                                                                                                                      | Fix                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2. A loss that fell due was drawn a commit later, and in a contrived replay something ended the loss in between, so its notice first appeared with the connection back.     | The render that finds the loss due and still a loss draws it. Replayed as "no render in between".                                                                                                                 |
| 2   | P2. "Live updates are back." was said when a stream was closed, as on a hidden page, and when one stream returned while the other was still down but not yet for 20 seconds. | `useStreamsUp`: the live region says it only while every stream the notice watches has heard from the server.                                                                                                     |
| 3   | P2. A live-updates notice that a loss's notice had covered appeared for 900 ms after both ended together.                                                                    | The notice follows `liveDown` directly, as on `main`. `useOutage` only counts its ends.                                                                                                                           |
| 4   | P2. The 30 seconds counted from the last fresh roster, which is minutes old while all is well, so one stale roster dimmed assistants at once.                                | They count from the first stale roster in a row.                                                                                                                                                                  |
| 5   | P2. The carry is judged only when a bootstrap answers, so with the retries used up an assistant showed as working 74.5 seconds after the roster went stale.                  | Not changed. The bound is stated where the constant is: about 75 seconds at the latest, because bootstraps come at least every 45 seconds while the roster is stale. A timer for the difference was not worth it. |

### Fifth round, of the fourth round's fixes and the rebase onto main: one P2

The reviewer found nothing else in the fourth round's fixes. The three CSS files hand-merged into
main's `@layer` blocks keep their selectors and declarations.

| #   | Finding                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2. With the household stream down 21 seconds and the chat stream 6, the household stream's return cleared the notice and used up the recovery while the chat stream was still down. When the chat stream came back 5 seconds later, nothing was said. | `useStreamsLive` tells a stream still waiting from one that is closed. The live region keeps a partial return and says "Live updates are back." when the rest return, unless a stream closes, the watched streams change, or another warning is said first. The UI test replays the reviewer's timings; `connection-copy.test.ts` covers the three ways the kept return is dropped. |

The sixth round reviewed this fix.

### Sixth round, of the native port and the fifth round's fix: one web P2

The native findings and their fixes are in the iOS section below.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                              | Fix                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | P2. A replacement stream could still say "Live updates are back.": leaving a chat whose stream was down for another counted a recovery in the new chat's scope, said once that chat's stream proved itself; and a chat stream closed and reopened for a new canonical session in one batch never rendered `closed`, so a partial return was said when the replacement proved itself. | `useStreamsLive` also returns a `scope` that changes with the watched names and whenever one of them closes, even if it reopens before a render. The live-updates outage and the live region both use it, so neither a chat switch nor a replaced stream is counted as a return. UI tests replay both paths; `stream-notice.test.ts` pins that a batched close and reopen changes the scope and a failed retry does not. |

The seventh round, which reviewed the native fixes, reviewed this fix and found nothing in it.

### Eighth round, of the native fixes: one server cause

The eighth round found that a roster Hermes answered while a native change was reported never reached
`botCache`, so an outage listed the roster from before it. A client then treats an assistant added in
between as removed. `listBots` now keeps the answer of the latest read to begin, whether or not a
change made it unfit for reuse. `tests/hermes-adapter.test.ts` replays one such read and two that answer
out of order; both mutants in `mutants/roster-cache.py` are caught. The native side of that finding,
and the rest of the round, are in the iOS section.

## Checks

On the fingerprint above, `.agents/tools/check-all --keep-going` under `linux-heavy-lock.sh`, and
`npm run format:check`:

| Check        | Result                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------- |
| format:check | passed                                                                                      |
| typecheck    | passed                                                                                      |
| lint         | passed                                                                                      |
| ruff         | passed                                                                                      |
| test         | passed: 227 files, 4,192 tests                                                              |
| build        | passed: 899 modules                                                                         |
| e2e          | Chromium: 87 passed. WebKit: 87 not run, blocked: the browser does not launch on this host. |
| py           | passed: 52 files                                                                            |

WebKit fails at `browserType.launch` with "Host system is missing dependencies to run browsers" (it
names `libicu74` and `libjpeg-turbo8`), for all 87 tests and for a bare `webkit.launch()` outside the
suite, so the cause is the host and not this change. `check-all` reports that as e2e failed.

A full run before the fourth round's fixes found two tests this change had broken and no affected-file
run had included:

- `tests/thinking-at-send-ui.test.ts` expected the activity row, marked disconnected, the moment the
  browser went offline with a message on its way. It now expects "thinking" through the grace period,
  then no row and the offline notice.
- `tests/avatar-art-parity.test.ts` failed because the web's badge glyph for a lost connection had been
  deleted, and that test holds the web's path data and the native app's together. The path is back in
  `Avatar.tsx`, unused, until the native badge goes with it.

## Not run, and not done

- iOS matched these states afterwards; see "iOS" below.
- Safari, Firefox, a screen reader and a real phone: not run. The live region and tooltips were checked
  in jsdom and by reading the DOM in Chromium.
- The fourth review round's fixes were not reviewed again.
- A member's last visible assistant made private during a Hermes outage stays listed until Hermes is
  back (third round, finding 1). On `main` too. The server answers no rows then, which the client cannot
  tell from a server with no roster to list, and that case keeps the rows on purpose. The fix is a
  field in bootstrap that says whether the server had a roster. The native app keeps every row through
  an outage, so it has the wider form of this.
- The server still answers one timed-out Hermes call with the code `unreachable`. The client no longer
  treats it as proof, so nothing depends on it, but the code says more than the server knows.
- The live-updates notice still clears about 10 seconds after a stream reconnects, because a stream
  counts as live only on data well after its opening ping. Unchanged here.

## iOS

The native app's half of the same change, on the same branch after `9301c603`. Checks ran on the Mac
mini (macOS 27.0.1, Xcode 27.2), iOS 27.0 simulator "conn-states-iphone17" (iPhone 17), made for
this task. `ios/Parity.md`, "Connection states", lists what matches and what still differs, and why.

### Change

- `ConnectionOutage.swift`, new. `Outage` is `useOutage` as a value with no clock of its own: `update`
  takes each change of what is lost, `advance` takes each deadline, and both are given the time. It has
  the web's grace, lasting and minimum times, scope, `lingering` and `recoveries`. It has no "due" step:
  native changes run on the main actor one at a time, so the call that finds a loss past its grace
  period and still down shows it. `ReadRetry.delay` is `READ_RETRY_MS`.
- `AppStore+Outage.swift`, new. The store times two outages: the household's (offline, the app or
  Hermes) and the open chat's own failed reads, scoped to that chat while it is on screen. The timer
  sleeps until the next deadline instant, not for a duration, so a task that starts late still wakes
  on time; the fake clock in the tests found that. A household loss is certain, and shows at once, when
  it needs setup or when a household read has answered in this session and never found Hermes
  connected. A cold launch's saved roster counts as nothing answered yet, so it waits like any loss.
  VoiceOver hears the loss once per change and "Connected again." when a shown loss ends, but not while
  another loss is being said. The news is held without the draft sentence.
- `connected` still gates every write, now including the open chat's failed read, from the first
  moment. `activity`, which the chat shows, stays what Hermes last said until the loss shows.
  `listedActivity` is what home lists for the open assistant, which only the household's loss changes.
- A failed conversation read no longer sets `appUnavailable` or slows the poll. It sets
  `readFailedFor`, asks bootstrap once what is down, and is read again after 1, 2, 4, 8, 16, then every
  30 seconds, not while the app is in the background, the device is offline, the sign-in is gone or the
  chat is off screen. Coming back online reads at once. Every read drops the pending retry as it sets
  out. After failed bootstraps the poll waits the same steps; it waited 2, 4, 8, 16, 30 before.
- A connected bootstrap whose rows are marked `disconnected` keeps each row's activity for 30 seconds
  from the first stale roster, as `rosterFrom` does, and reads the next bootstrap whole so the end of
  the carry is judged.
- `ConnectionCopy.of` is the web's copy table, `needsSetup` included. The dock's notice is one line
  with a spinner until the loss lasts, then the title, the detail, Reconnect now and, for the app and
  Hermes, the details. Offline has no button and no details. The full panel always says everything and
  shows only once the household's loss does. The client's message for a read that never reached the
  app no longer mentions a draft.
- A disconnected avatar has no badge and dims to saturation 0.45 and opacity 0.9, easing over 400 ms.
  Home captions no assistant with "Connection lost", and the saved-roster line no longer adds
  "Offline." or "Reconnecting…": the header's pill says it once, after the grace period. The chat's
  activity row is hidden while the loss shows, the "reconnecting" verb is gone, and a chat that never
  loaded says "This conversation hasn't loaded yet".
- Native idioms where the web has none: Send's reason is its VoiceOver hint, because a disabled button
  has no tooltip on a touch screen. The Stop confirmation is a system dialog with no room for a reason,
  so it closes when stopping becomes unavailable.
- `DebugFixtures.swift` gains `UIConnectionLoss`, which loses the app, the network, Hermes or one chat's
  reads at a moment a UI test picks. Release builds compile it out.

No web source changed. `tests/avatar-art-parity.test.ts` checks only that native path data is in the
web's list, and native drew its badge with an SF Symbol, so the web's unused question-mark path in
`Avatar.tsx` can now go; it was left for a web change.

### Tests

- `ios/AgentInterfaceTests/ConnectionStateTests.swift`, new, 39 tests: `OutageTests` (15, the edges of
  `tests/outage.test.ts` at exact instants), `ReadRetryTests` (2), `ConnectionCopyTests` (9, from
  `tests/connection-copy.test.ts`), `ConnectionStateStoreTests` (10, the store on a fake clock and a
  fake timer: the grace period, the one line, lasting, a loss before Hermes was reached, setup, offline,
  a chat-only loss, the saved copy, recoveries and announcements, the draft sentence) and
  `ConnectionQuietingTests` (3: badge and dim, captions, the read message).
- `NativeContractTests`, 7 new against the mock server: the backoff and the one bootstrap, the retry
  guards, a read dropping the pending retry, a retry waking while a read is on its way, another chat's
  failures, a Hermes loss before and after Hermes was reached, and the roster carry.
- Changed because the behavior did: `testConversationOutagePreservesDraftAndTranscriptWhileDisablingSendUntilRecovery`
  expected `.disconnected` at once and now expects Send refused with the chat unchanged during the
  grace period. `testPollingKeepsRefreshingBootstrapWhileTheServerIsDisconnectedOrFailing` expected a
  chat's failed read to need a bootstrap to clear; it now expects the one bootstrap the failure asks
  for and a clear through the chat's own read. `ConversationParityTests` and `HomeParityTests` lost the
  old copy and "reconnecting" cases, which `ConnectionCopyTests` replaces. `ObservedChanges` lists the
  five new observed properties.
- `ios/AgentInterfaceUITests/ConnectionStateFlowTests.swift`, new, 4 tests on the fixture: a Hermes loss
  shows nothing at 1.5 seconds, one line no sooner than 3 seconds with no button, then "Hermes isn't
  answering" no sooner than 10 with Reconnect now and details; a lasting loss with a draft; one chat's
  reads, with home showing nothing lost; and offline. No existing UI test expected the card at once:
  the only one that shows it, the setup panel, is certain and still shows at once.

### Screenshots

From `ConnectionStateFlowTests`, iPhone 17 simulator, light theme. The collage is
[`ios-collage.png`](../evidence/2026-11-19-connection-states/ios-collage.png), made by
[`ios-collage.swift`](../evidence/2026-11-19-connection-states/ios-collage.swift): in grace, one line,
lasting, lasting with a draft, one chat only, and offline. The one-line shot was taken as the notice
appeared, so the header avatar is still easing into its dim.

### Mutants

Each line was broken with `~/.agents/tools/mutate.py` and the tests in
[`ios-tests.sh`](../evidence/2026-11-19-connection-states/mutants/ios-tests.sh) run, all under
`mac-heavy-lock.sh`. The lists and the tool's output are the `ios-*` files in
[`mutants/`](../evidence/2026-11-19-connection-states/mutants/): 63 mutants, 63 caught. The review
round's lists are the `ios-review-*` files, run by
[`ios-review-run.sh`](../evidence/2026-11-19-connection-states/mutants/ios-review-run.sh) with the
review's tests added to `ios-tests.sh`. It also ran the three earlier lists whose files the round
changed, on the review's code, after three of their targets were moved to the new lines: 28 of 28
caught. The round's own 20 were all caught, one of them after a new test, below. The second review
round's lists are the `ios-review2-*` files, run by
[`ios-review2-run.sh`](../evidence/2026-11-19-connection-states/mutants/ios-review2-run.sh) with its
tests added to `ios-tests.sh`; its view lines ran through the UI test in
[`ios-review2-ui.sh`](../evidence/2026-11-19-connection-states/mutants/ios-review2-ui.sh). All 26 were
caught. The third review round's lists are the `ios-review3-*` files, run by
[`ios-review3-run.sh`](../evidence/2026-11-19-connection-states/mutants/ios-review3-run.sh) with its
tests added to `ios-tests.sh` and the tests it replaced taken out; the chat banner's lines ran through
the unit test that hosts the chat view, and the settings lines through the UI test in
[`ios-review3-ui.sh`](../evidence/2026-11-19-connection-states/mutants/ios-review3-ui.sh). 25 of 26
were caught; the survivor is below.

| File                                                              | Mutants | Result    |
| ----------------------------------------------------------------- | ------- | --------- |
| `ConnectionOutage.swift`                                          | 19      | 19 caught |
| `AppStore+Outage.swift`                                           | 17      | 17 caught |
| `AppStore.swift`                                                  | 4       | 4 caught  |
| `AppStore+Polling.swift`                                          | 7       | 7 caught  |
| `AppStore+Conversation.swift`                                     | 3       | 3 caught  |
| `ConnectionCopy`                                                  | 9       | 9 caught  |
| `AvatarView`, `Models`, `APIClient`                               | 4       | 4 caught  |
| Review: `AppStore.swift`                                          | 4       | 4 caught  |
| Review: `HomeStates.swift`                                        | 1       | 1 caught  |
| Review: `AppStore+Outage.swift`                                   | 3       | 3 caught  |
| Review: `AppStore+Polling.swift`                                  | 7       | 7 caught  |
| Review: `AppStore+Session.swift`                                  | 1       | 1 caught  |
| Review: `AppStore+Sending.swift`                                  | 3       | 3 caught  |
| Review: `PreferencesView.swift`                                   | 1       | 1 caught  |
| Review 2: `AppStore+Polling.swift`                                | 9       | 9 caught  |
| Review 2: `AppStore+Conversation.swift`                           | 3       | 3 caught  |
| Review 2: `AppStore+Outage.swift`                                 | 3       | 3 caught  |
| Review 2: `AppStore.swift`                                        | 1       | 1 caught  |
| Review 2: `StoreRequests.swift`                                   | 3       | 3 caught  |
| Review 2: `WidgetSync.swift`                                      | 4       | 4 caught  |
| Review 2: `RootView.swift`, `GroupSettingsView.swift`, by UI test | 3       | 3 caught  |
| Review 3: `AppStore+Polling.swift`                                | 11      | 11 caught |
| Review 3: `AppStore+Conversation.swift`                           | 3       | 3 caught  |
| Review 3: `AppStore.swift`                                        | 3       | 3 caught  |
| Review 3: `WidgetSync.swift`, `BackgroundRefresh.swift`           | 2       | 2 caught  |
| Review 3: `AgentInterfaceApp.swift`                               | 1       | 1 caught  |
| Review 3: `CollaborationViews.swift`, `GroupSettingsView.swift`   | 2       | 2 caught  |
| Review 3: `ConversationView.swift`, by the hosted view            | 2       | 1 caught  |
| Review 3: `BotSettingsView.swift`, by UI test                     | 2       | 2 caught  |

Survivors on the way, and what was done:

- The pending retry dropped as a read sets out. No test had a retry wake while a read was on its way;
  one now does, and catches the second read.
- `select` clearing the last chat's failures. Equivalent: the next read's outcome, or the new chat's
  id, already decides, so it was removed.
- A new chat's failures starting the waits over (`first ? 1`). Once `select` no longer cleared them,
  this is what does; the chat-switch test now checks the new chat's first wait is a second.
- Review: holding `updateActivity` while the bootstrap and `appUnavailable` change. Clearing the flag
  before the bootstrap is assigned already fixes finding 4, so the hold survived. It matters when the
  app answers that Hermes is down: applied apart, the loss ends and the Hermes loss waits a new grace
  period, where the web sees one loss. `testAnAppLossThatTurnsIntoAHermesLossIsOneLoss` now catches it.
- Review: `PreferencesView.swift` is a view, so its mutant ran by hand through `mutate.py --replace` and
  the new UI test ([`ios-review-settings.out`](../evidence/2026-11-19-connection-states/mutants/ios-review-settings.out)).
  The tool's first try stopped before any mutation, because its unchanged run failed the test's own
  guard that the chat opens before the fixture's loss; the second try ran it.
- Review 2: no survivors. The `AppStore.swift` list first stopped before any mutation, because its
  unchanged run failed once; the same tests passed on the lists before and after it and when run alone,
  and the list then ran: 1 of 1.
- Review 3: the banner's once-per-message guard survived. It matters only when the banner changes in
  the same update that the chat appears, so `onAppear` reads the new message and `onChange` then
  delivers it again; XCTest cannot place a change inside that update. It stays as the finding asked,
  untested. The two group lists first stopped before any mutation, because their unchanged runs failed;
  the whole `ios-tests.sh` list then passed unchanged, 77 of 77, and the two lists ran: 2 of 2. Not kept:
  a mutant of `?? rosterFromCache` for an unchanged bootstrap, which is equivalent: a roster with stale
  rows is always read whole, so never answered unchanged, and the one other cached roster, Hermes down
  with nobody listed, keeps the rows it had, so the open chat is listed and the widgets see Hermes down.

### Checks

| Check                                | Command                                                                                                                                                                                                                                                   | Result                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Connection tests while writing       | `validate-ios.sh … test -only-testing:` the five new classes, `NativeContractTests`, `FixedWaitRuleTests`                                                                                                                                                 | passed, 205 tests                                                                                                            |
| Mutants                              | `ios-run.sh`, then the two changed lists again                                                                                                                                                                                                            | 63 of 63 caught                                                                                                              |
| Connection UI tests                  | `validate-ios.sh … test -only-testing:AgentInterfaceUITests/ConnectionStateFlowTests`                                                                                                                                                                     | passed, 4 tests                                                                                                              |
| Native unit suite                    | `validate-ios.sh SIMULATOR test`                                                                                                                                                                                                                          | passed: 858 tests, 2 skipped                                                                                                 |
| Native UI suite                      | the same run, then the seven classes it had not reached                                                                                                                                                                                                   | passed: 94, then 66 with 2 skipped                                                                                           |
| Web battery                          | `.agents/tools/check-all --keep-going`, Node 24.22.2                                                                                                                                                                                                      | typecheck, lint, ruff, build, py passed; test 5 failed of 4,204; e2e 3 failed of 178, 3 skipped                              |
| Web format                           | `npm run format:check`                                                                                                                                                                                                                                    | passed                                                                                                                       |
| Review: failing first                | `validate-ios.sh … test -only-testing:` the 10 new and changed tests, on `b7cb59c9` with the new tests                                                                                                                                                    | 9 unit tests failed with 20 failures, the UI test failed at the room's Send, each for the finding's reason                   |
| Review: connection tests             | the five connection classes, `NativeContractTests`, `FixedWaitRuleTests`, `ConnectionStateFlowTests`                                                                                                                                                      | unit passed, 217 tests; UI 4 of 5, the new test's Settings step used the wrong navigation; fixed, then passed alone          |
| Review: mutants                      | `ios-review-run.sh`, then `ios-review-appstore` again after the new test; `PreferencesView.swift` by hand                                                                                                                                                 | 46 of 47, then 47 of 47; 1 of 1                                                                                              |
| Review: native unit suite            | `validate-ios.sh SIMULATOR test -only-testing:AgentInterfaceTests`                                                                                                                                                                                        | passed: 870 tests, 2 skipped                                                                                                 |
| Review: UI classes the fixes touch   | `ConnectionStateFlowTests`, `ExperienceFlowTests`, `NativeFlowTests`, `SettingsPolishTests`, `ShellFlowTests`                                                                                                                                             | passed: 51 tests                                                                                                             |
| Review 2: failing first              | `validate-ios.sh … test -only-testing:` the 7 new and changed tests that compile on `ab2751b9`, on its code                                                                                                                                               | 6 unit tests failed with 25 failures; the UI test failed at New group chat, each for the finding's reason                    |
| Review 2: connection tests           | the five connection classes, `NativeContractTests`, `SystemSurfaceTests`, `StoreRequestsTests`, `AssistantSurfaceTests`, `FixedWaitRuleTests`, `ConnectionStateFlowTests`                                                                                 | unit passed, 259 tests; UI passed, 5 tests, after the 20-second lead                                                         |
| Review 2: mutants                    | `ios-review2-run.sh`, then the `AppStore.swift` list again                                                                                                                                                                                                | 25 of 25, then 1 of 1                                                                                                        |
| Review 2: native unit suite          | `validate-ios.sh SIMULATOR test -only-testing:AgentInterfaceTests`                                                                                                                                                                                        | passed: 878 tests, 2 skipped                                                                                                 |
| Review 2: UI classes the fixes touch | `AutomationFlowTests`, `ChatCardsFlowTests`, `ConnectionStateFlowTests`, `DailyFlowTests`, `ExperienceFlowTests`, `NativeFlowTests`, `ParityFlowTests`, `SettingsPolishTests`, `ShellFlowTests`, `TalkFlowTests`, `TranscriptFlowTests`, `VaultFlowTests` | 123 tests: 118 passed, 4 skipped, 1 flaky; the flaky test passed alone with no change                                        |
| Review 3: failing first              | `validate-ios.sh … test -only-testing:` the 9 new and changed tests that compile on `13e80c63`, on its code                                                                                                                                               | 8 unit tests failed with 29 failures; the UI test failed at "Reconnect to save your changes.", each for the finding's reason |
| Review 3: connection tests           | the five connection classes, `NativeContractTests`, `SystemSurfaceTests`, `NativeReachTests`, `StoreRequestsTests`, `AssistantSurfaceTests`                                                                                                               | unit passed, 281 tests, on the second try; see below                                                                         |
| Review 3: mutants                    | `ios-review3-run.sh`, then the two group lists again                                                                                                                                                                                                      | 21 of 22, the two group lists stopped at their unchanged runs; then 2 of 2                                                   |
| Review 3: native unit suite          | `validate-ios.sh SIMULATOR test -only-testing:AgentInterfaceTests`                                                                                                                                                                                        | passed: 886 tests, 2 skipped                                                                                                 |
| Review 3: UI classes the fixes touch | `AutomationFlowTests`, `ChatCardsFlowTests`, `ConnectionStateFlowTests`, `ExperienceFlowTests`, `NativeFlowTests`, `ParityFlowTests`, `SettingsPolishTests`, `ShellFlowTests`, `TranscriptFlowTests`                                                      | passed: 99 tests, 4 skipped by design                                                                                        |

The full run stopped at its 2-hour limit while it was in `ScreenshotTourTests`, after 94 UI tests had
passed and none had failed. `ScreenshotTourTests` produces evidence only, and the README leaves it out of
the UI checks; it was not run again. The other 7 classes it had not reached ran next with
`ConnectionStateFlowTests` and `ConnectionStateStoreTests` again: 66 passed and 2 skipped:
`TabletPresentationTests`, which needs an iPad, and `testApprovalScopeScreens`, which skips by design.
That run was on the final code. The unit run was on code that differed only by a blank line and an
unused property in `RootView.swift`, which the second run compiled.

The web battery ran on `9301c603` with this change, before `811804ec` (the fifth review round's web
fix) was merged in. That commit changes only web files and the native app has no live-updates notice,
so nothing here was run again for it.

The review round's checks ran on the Mac mini, iOS 27.0 simulator "iPhone 17" (`0915E0B2`), the earlier
simulator having been removed. The unit suite and the UI classes ran in one run on the final code. The
round changed no web file, so the web battery was not run again.

The second review round's checks ran on the same Mac mini and simulator, on `50786c99`, in one run for the
unit suite and the twelve UI classes, which cover group rooms, approvals, answers, Stop, assistant
settings and automations. `AutomationFlowTests.testInterruptedGoalRequiresReviewThenResumesAndPauses`
failed in that run, not finding `automation.reviewedInterruption`, and passed alone on the same code; no
changed line reaches the automation screens. The 4 skips are the three `testW3Trigger…` cases and
`testApprovalScopeScreens`, which skip by design. No web file changed, so the web battery was not run
again.

The third review round's checks ran on the same Mac mini and simulator, on `33708dc9`; the commits after
it change only the ledger and the mutant evidence. The unit suite and the nine UI classes ran in one run.
The first run of the connection tests had 3 failing tests: `ObservedChanges` lacked the new observed
`unconfirmedDepartures`; the finding 6 test counted the draft save that leaving a chat sends as a read,
and parked a 304 that the mock server never parks, both fixed in the test; and
`testACancelledReadThatDisplacedTheRetrySetsItAgain` failed once when its held read timed out at 20
seconds, in a run whose sources changed while it ran. That test then passed 4 times of 4 alone and again
in the 281. No web file changed, so the web battery was not run again.

The 8 web failures are this Mac's, and all 8 fail the same way at `9301c603` in a separate worktree:
`tests/direct-routes.test.ts` (2) and `tests/native-contract.test.ts` (1) need a second loopback address
the Mac does not have, `tests/upgrades.test.ts` (2) runs `scripts/hermes-upgrade-worker.py` with a
Python that rejects its syntax, and the 3 WebKit cases in `e2e/smoke.spec.ts` (lines 40, 811 and 856)
fail on this host's WebKit. No web source changed here.

### Review

GPT-6.2 Sol, high effort, reviewed the iOS change from source at `bd781222`: six P2 and two P3
findings. All eight were fixed. Each
fix has a test that went red on `b7cb59c9`, the code before the fixes, for the reason the finding
gave; [`ios-review-before-fix.out`](../evidence/2026-11-19-connection-states/mutants/ios-review-before-fix.out)
is that run. A fix that added a store property has a test that cannot compile against the old code,
so its red run is the mutant that puts the old expression back.

| Finding                                                                                                                                                        | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Failing-first test                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Send and Stop could write after a loss. Offline left `connected` true until a read failed, and Stop and the uncertain-send retry did not check again.       | `connected` reads `householdReachable`, which adds the network. `send` checks `connected` for a retry too. Stop goes through the new `stopWork`, which checks the open chat and the connection as it posts. The Cmd+. dialog still closes when stopping becomes unavailable: that leaves Stop disabled with its reason as the VoiceOver hint, the web's state, and a dialog left open could offer only Cancel. The earlier note that a dialog has no room for a reason was wrong; the choice now rests on the web's state. | `testAnOfflineDeviceRefusesWritesFromTheFirstMoment`, `testAnUncertainSendIsNotRetriedWhileTheChatOrTheNetworkIsDown` (red before); `testAStopIsNotSentAfterTheChatOrTheNetworkIsLost` (mutants)                               |
| 2. The poll read a failed chat every 1.5 seconds, dropping its retry, and kept reading while offline. Coming back online queued a read while the app was away. | While the open chat's reads fail (`chatReadWaits`), the poll leaves it to its retry. Coming back online reads only while the app is in the foreground, and returning to the app reads it at once.                                                                                                                                                                                                                                                                                                                          | `testWhileAChatsReadFailsOnlyItsRetryAndAWakeupReadIt` (red before). `testPollingKeepsRefreshingBootstrapWhileTheServerIsDisconnectedOrFailing` expected the poll to clear the chat; it now releases the retry.                |
| 3. VoiceOver heard a failed poll during the grace period, then the outage again.                                                                               | `chatErrorShown` is the banner's rule, and the chat announces only errors it shows. The store's outage announcer says the rest.                                                                                                                                                                                                                                                                                                                                                                                            | `testAFailedPollIsTheNoticesNewsAndOtherErrorsAreTheBanners` (mutant)                                                                                                                                                          |
| 4. A changed bootstrap that answered past the grace period, before the timer ran, showed the loss and said "Connected again."                                  | The bootstrap and the cleared `appUnavailable` are applied with `updateActivity` held, then the outages are recomputed once.                                                                                                                                                                                                                                                                                                                                                                                               | `testABootstrapThatAnswersPastTheGracePeriodBeforeTheTimerRunsShowsAndSaysNothing` (red before); `testAnAppLossThatTurnsIntoAHermesLossIsOneLoss` (mutant, see below)                                                          |
| 5. One chat's failed read disabled a healthy group room's Send and Stop and made Settings say Hermes was reconnecting.                                         | Group rooms and the Settings row read `householdReachable`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `ConnectionStateFlowTests.testOneChatsFailedReadsLeaveGroupChatsAndSettingsLive` (red before, at the room's Send; the Settings half went red by mutant); `testOneChatsFailedReadLeavesTheHouseholdReachable` (mutant)          |
| 6. A Hermes-down bootstrap kept the old roster whole, so an assistant made private stayed listed with its saved chat.                                          | The web's `rosterFrom`: membership from a nonempty roster, activity carried only for rows it keeps, for 30 seconds from the first stale roster, and the removal cleanup for rows it drops. A roster that lists nobody still keeps the rows. While Hermes is down the open chat stays open, as on the web, instead of another being picked.                                                                                                                                                                                 | `testAHermesDownRosterTakesTheServersMembershipAndCarriesOnlyTheRowsItKeeps`, `testAHermesDownRosterWithoutTheOpenChatKeepsItOpenUntilHermesAnswers` (red before). The mock server gained `listWhileDown` and `hideFamilyBot`. |
| 7. The notice said the draft was kept while a send on its way left the box empty.                                                                              | `hasDraft` reads `composerDraft`, what the box shows, and the tray's uploads.                                                                                                                                                                                                                                                                                                                                                                                                                                              | `testTheNoticeClaimsNoDraftWhileTheMessageBoxShowsItEmptyForASend` (red before)                                                                                                                                                |
| 8. A working chat that recovered just after its notice showed brought its activity row back while the notice stayed out its second.                            | `activityRowShown` hides the row while a loss is on screen, lingering included, as the web does. The composer reads `activity`, which follows the recovery at once.                                                                                                                                                                                                                                                                                                                                                        | `testTheActivityRowWaitsForTheNoticeToGoAndTheComposerDoesNot` (mutant)                                                                                                                                                        |

### Second review

GPT-6.2 Sol, high effort, reviewed the review round from source at `ab2751b9`: six P2 and one P3
findings. Each was reproduced against the real code before it was fixed. Each fix has a test that went
red on `ab2751b9` for the reason the finding gave;
[`ios-review2-before-fix.out`](../evidence/2026-11-19-connection-states/mutants/ios-review2-before-fix.out)
is that run. Three tests call something the fix added, so they cannot compile against the old code;
their red run is the mutant that puts the old behavior back. "On main" says whether `origin/main`, before
this branch, had the same gap.

| Finding                                                                                                                                                                                | Reproduced                                                                                                                                                               | On main                                                                                            | Fix                                                                                                                                                                                                                                                                                                                                                       | Failing-first test                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Automatic chat reads went out offline or after suspension: the poll's read for a healthy chat with a silent stream, a poll the app left during its bootstrap, and a queued refresh. | Yes: an offline pass read the chat, and so did a queued refresh after a loss, a suspension or a new session, and a poll suspended while its bootstrap was held.          | Yes. Main's poll and queued refresh had no such check.                                             | `automaticReadAllowed(in:)` checks cancellation, suspension, the network, the session and the sign-in as each poll read and each queued read sets out. Opening a chat, pull to refresh and Reconnect now still read at once.                                                                                                                              | `testAutomaticReadsWaitForTheNetworkTheForegroundAndTheSameSession` (red before, 5 failures).                                                                                                                                                       |
| 2. A cancelled refresh stranded a failed chat: it dropped the retry as it set out and set none when cancelled.                                                                         | Yes: after a held refresh that displaced the retry was cancelled, nothing waited.                                                                                        | No. Main had no read retry.                                                                        | A cancelled read sets the same wait again (`scheduleReadRetry`) when the chat still failed and no newer read set out after it.                                                                                                                                                                                                                            | `testACancelledReadThatDisplacedTheRetrySetsItAgain` (red before).                                                                                                                                                                                  |
| 3. An open assistant dropped by a Hermes-down roster stayed selected, which the phone shows as a blank screen, and a read on its way put its evicted chat back.                        | Yes: selection, the cache and the notice, and the typed draft was not saved.                                                                                             | No. Main kept the whole roster while Hermes was down; the first review round's fix 6 brought this. | An assistant the server says left closes its chat through `leave`, Hermes up or down: the read on its way is dropped, its uploads go and the draft is saved. No other chat is chosen while Hermes is down.                                                                                                                                                | `testAnOpenAssistantRemovedWhileHermesIsDownLeavesAndAReadOnItsWayCannotBringItBack` (red before). `testAHermesDownRosterWithoutTheOpenChatKeepsItOpenUntilHermesAnswers` expected the chat kept; it is now `…LeavesItAndOpensNoOther`, red before. |
| 4. A removed assistant stayed on the widgets with its last message, in Spotlight and Siri, with its notification picture, and with its delivered notifications.                        | Yes for the widgets, Spotlight and the picture. The notifications were confirmed from source: nothing cleared them.                                                      | Notifications: yes, on any removal. The rest: no, for the same reason as finding 3.                | A Hermes-down roster that lists anyone prunes the stored snapshot to it, keeping each remaining row and the snapshot's age, then syncs Spotlight and the pictures. Every removal clears the chats' delivered notifications (`removeDeliveredChats`).                                                                                                      | `testARosterThatDropsAnAssistantWhileHermesIsDownPrunesItFromTheSystemSurfaces` (red before); `testAnAssistantThatLeavesTakesItsDeliveredNotificationsWithIt` (mutant).                                                                             |
| 5. One failed chat disabled New group chat on home and Save in a room's settings.                                                                                                      | Yes: New group chat was disabled.                                                                                                                                        | Yes, more widely: main's failed read set `appUnavailable`.                                         | Both read `householdReachable`, as does the settings footnote.                                                                                                                                                                                                                                                                                            | `ConnectionStateFlowTests.testOneChatsFailedReadsLeaveGroupChatsAndSettingsLive` (red before at New group chat; the Save step went red by mutant).                                                                                                  |
| 6. Group writes and chat approvals did not check the connection as they ran.                                                                                                           | Yes for chat writes: an approval posted after the chat's read failed and while offline. The group gap was confirmed from source: no check between the tap and the write. | Yes.                                                                                               | `perform`, which every chat write and assistant setting goes through, refuses unless `connected`, with Send's reason. `attempt` and `run` take `household:`; group create, Send, Stop, approvals and settings pass it, so nothing is saved as pending or posted while the household is down. Group creation records its pending request inside the write. | `testAChatWriteIsNotSentWhileTheChatOrTheNetworkIsDown` (red before); `testAHouseholdWriteChecksTheConnectionAsItStartsAndOneChatsFailureIsNotIt` (mutant).                                                                                         |
| 7. VoiceOver missed an error that came into view as the notice cleared, because the chat watched `error`, which had not changed.                                                       | Yes, in the store: the error stayed the same string while the banner went from hidden to shown.                                                                          | No. Main announced every error and hid none.                                                       | `chatErrorBanner` is what the banner shows; the chat shows and announces it.                                                                                                                                                                                                                                                                              | `testTheBannerMessageChangesWhenAHiddenErrorComesIntoViewThoughTheErrorDoesNot` (mutant).                                                                                                                                                           |

The before-fix run had the tests as first written. Cases added after it, each for a condition of a fix
(a cancelled poll, an ended sign-in, signing out, a newer read on its way, a healthy chat's cancelled read
and the refusal's reason), went red by mutant. Two conditions first written into the cancelled read's
retry, no retry already set and the same selection, were removed as equivalent: a retry set by an older
read's failure is only restarted at the same step, and one set for a chat no longer open finds it off
screen and reads nothing.

Also changed while here: `ConnectionStateFlowTests` loses the connection 20 seconds after launch, not 10,
with two waits widened to match. The first launch on a freshly booted simulator took 11 seconds and failed
the tests' own guard that the chat opens before the loss, twice before any fix and once after.

### Third review

GPT-6.2 Sol, high effort, reviewed the second round's fixes from source at `2754114b`: seven P2 and two
P3 findings. Each was reproduced against the real code before it was fixed, and all nine were fixed.
Every test that compiles against `13e80c63`, the code before the fixes, went red there for the reason
the finding gave; [`ios-review3-before-fix.out`](../evidence/2026-11-19-connection-states/mutants/ios-review3-before-fix.out)
is that run: 8 unit tests with 29 failures, and the UI test. The tests for findings 2, 4 and 9 call
what the fixes added, and the one for finding 8 hears the banner through the store's `announce`, which
the old view never called; their red runs are the mutants that put the old behavior back.

Findings 1 to 3 follow one decision from the orchestrator. A roster the server returns from its cache,
while Hermes is down or after its roster read failed, with rows marked `disconnected`, can be stale
either way (`src/server/hermes.ts`, `listBots`: a read a concurrent change overtook never updates
`botCache`). So an assistant it leaves out has not been shown to leave. Home lists what the server
lists, as the web does, but nothing is removed for it. A connected roster's omission is the word.

| Finding                                                                                                                                                                               | Reproduced                                                                                                                                       | On main                                                                                                            | Fix                                                                                                                                                                                                                                                                                                                                                                                                  | Failing-first test                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. P2. A stale cached roster closed a chat the person still had: a fresh `[A, B]`, then a Hermes-down `[A]`, and B's chat closed with its saved copy, uploads and alerts.             | Yes, with exactly that sequence: the chat left, the draft was taken off screen, B's saved chat, recent entry, recording and widget row went.     | Partly. Main kept the roster whole while Hermes was down, but removed on a connected roster whose rows were stale. | `refreshBootstrap` marks a roster `cached` when Hermes is down or any row is `disconnected`. For it, an assistant left out goes into `unconfirmedDepartures` with its last row and nothing is cleared; `bot` falls back to that row, so the open chat stays on screen and is never blank. A connected roster removes what it leaves out, those departures included, through `leave` and the cleanup. | `testACachedRosterThatLeavesOutTheOpenChatKeepsItAndClearsNothing`, `testAStaleConnectedRosterThatLeavesOutTheOpenChatKeepsIt` (red before). `testAHermesDownRosterTakesTheServersMembershipAndCarriesOnlyTheRowsItKeeps` expected the saved chat cleared; it now expects it kept until Hermes answers, red before. |
| 2. P2. On a shared iPad, member two's removal cleared member one's delivered alert for the same assistant.                                                                            | Yes, from source: the matcher read only the assistant in the link.                                                                               | No. Main cleared nothing on a removal; the second round brought it.                                                | `removeDeliveredChats` takes the account marker of the roster that removed. `NotificationController.isChat` matches a delivered alert only when its `account` is that marker, so one that names no account, as an oversized payload may not, stays.                                                                                                                                                  | `testARemovalClearsOnlyThisAccountsDeliveredNotificationsAndACachedRosterNone`, through the real matcher over four delivered alerts (mutant).                                                                                                                                                                       |
| 3. P2. A background widget refresh could undo a removal, since pruning kept `generatedAt`; and a prune after the background one already removed B skipped Spotlight and the pictures. | Yes: the prune kept the snapshot's age, and the background read wrote any connected roster, stale rows included.                                 | The background read of a stale connected roster: yes. Pruning: no, the second round brought it.                    | No prune happens for a cached roster: the widgets, Spotlight, Siri's names and the pictures keep the last good snapshot whole. A connected roster writes a new snapshot dated now and syncs Spotlight and the pictures every time, so its `generatedAt` is the ordering a background read that began earlier already respects. The background read skips a roster with `disconnected` rows.          | `testACachedRosterLeavesTheSystemSurfacesWholeAndAConnectedOnePrunesThem` (replaces the second round's pruning test), `testABackgroundReadOfACachedRosterLeavesTheSnapshotAlone` (red before).                                                                                                                      |
| 4. P2. With chat A's read failing while B's profile PATCH was on its way, the tools step of B's Save was refused.                                                                     | Yes: the UI test found Save disabled with "Reconnect to save your changes."; the refused tools step from source, `perform` checking `connected`. | No for the refusal. The disabled Save: yes, through `appUnavailable`.                                              | `perform` takes a required `gate`: `.openChat` for Stop, approvals and answers, `.household` for an assistant's settings. The 11 settings controls that read `connected`, Save among them, read `householdReachable`.                                                                                                                                                                                | `testAnAssistantsSettingsWaitForTheHouseholdNotTheOpenChat`, with the profile PATCH held while A's read fails (mutant); `ConnectionStateFlowTests.testOneChatsFailedReadsLeaveItsAssistantsSettingsSavable` (red before).                                                                                           |
| 5. P2. An old session's refresh swallowed the new session's retry, and nothing read the failed chat again.                                                                            | Yes: a held stream refresh in account one, a switch, a failed first read in account two; its retry never read.                                   | No. Main had no session check, so the old loop read for the new session.                                           | `conversationRefreshAgain` holds the session that asked. The running loop reads next for that session and checks it, not its own.                                                                                                                                                                                                                                                                    | `testARetryTheNewSessionAsksForWhileTheOldSessionsRefreshRunsStillReads` (red before).                                                                                                                                                                                                                              |
| 6. P3. A bootstrap that answered after the network dropped opened a chat and read it, and an automatic refresh sent its second request after an unchanged answer without checking.    | Yes, both: the offline bootstrap selected the chat and read its draft and conversation, and the second request went out offline.                 | Yes. Main checked no automatic read.                                                                               | `refreshConversation(automatic:)` checks `automaticReadAllowed` before each of its requests; the poll and the queued refresh pass their session. The bootstrap opens a chat nobody tapped only while automatic reads are allowed; the next bootstrap that answers chooses. Opening a chat, pull to refresh and Reconnect now stay immediate.                                                         | `testReadsInsideAnAutomaticRefreshAreCheckedAsEachSetsOut` (red before).                                                                                                                                                                                                                                            |
| 7. P3. A history page read after a pull displaced the retry counted as a newer read, so a cancelled pull set no retry.                                                                | Yes: with the page failed and the pull cancelled, nothing waited.                                                                                | No. Main had no read retry.                                                                                        | `conversationRefreshes` counts full refreshes apart from the history pages in `conversationReads`; a cancelled refresh sets its retry again when no newer refresh set out.                                                                                                                                                                                                                           | `testAHistoryPageDoesNotKeepACancelledRefreshFromSettingItsRetryAgain` (red before).                                                                                                                                                                                                                                |
| 8. P3. VoiceOver missed an error already on the banner as the chat appeared, because `onChange` does not fire for the initial value.                                                  | Yes, from source.                                                                                                                                | Yes. Main announced changes of `error` only.                                                                       | The chat announces the banner on appearance and on each change, once per message, through the store's `announce`.                                                                                                                                                                                                                                                                                    | `testAnErrorAlreadyOnTheBannerIsHeardOnceAsTheChatAppears`, which hosts `ConversationView` in a window (mutant).                                                                                                                                                                                                    |
| 9. P3. Dropping `household: true` from group Send or a room's settings Save left every test green.                                                                                    | Yes: the lines were in private view methods no test reached.                                                                                     | Not applicable: the check is new.                                                                                  | The two writes are store actions, `sendGroupMessage` and `saveGroupContext`, that the views call.                                                                                                                                                                                                                                                                                                    | `testAGroupSendAndARoomsSettingsSaveCheckTheHouseholdBeforeTheyStart`: offline, nothing saved as pending and no POST; one chat's failed read, both post (mutant).                                                                                                                                                   |

Also changed: `testAnOpenAssistantRemovedWhileHermesIsDownLeavesAndAReadOnItsWayCannotBringItBack` is now
`…RemovedByAConnectedRoster…`, the same leave path through a connected roster. The second round's
`testAnAssistantThatLeavesTakesItsDeliveredNotificationsWithIt` and `testAHermesDownRosterWithoutTheOpenChatLeavesItAndOpensNoOther`
were replaced by the finding 1 and 2 tests, since the behavior they pinned is the one this round reverses.
`ios/Parity.md` drops the difference that native closed such a chat while Hermes was down. One line written
into the fix, dropping a departure a later cached roster listed again, was removed as equivalent: the roster
row wins over the held one, and a connected roster's removal subtracts what it lists.

### Not done

- No independent review of the third review round's fixes has run. The three reviews' findings are in
  "Review", "Second review" and "Third review" above.
- `activityRowShown` is tested in the store; the activity row in `ConversationView.swift` that reads it
  has no UI test, since the row's moment is a 1-second linger. The banner's announcement is now tested
  through the hosted chat view and the store's `announce`; real VoiceOver was not run.
- The household check of group create, Stop and approvals is tested in `StoreRequestsTests`, and their
  three `CollaborationViews.swift` call sites still pass `household: true` with no test that fails when
  it is dropped. Send and a room's settings Save, which the review named, are store actions with tests.
- About 39 controls on household screens still read `connected`, which adds the open chat's failed read:
  automations (18), experiences (9), vaults (5) and others. On main they did the same through
  `appUnavailable`. Each needs its own choice and UI check. Assistant settings (11), which the review
  named, now read `householdReachable`.
- A delivered notification that names no account, as an oversized payload's fallback may not, is no
  longer cleared when its assistant leaves, since it could be another member's. Opening a chat still
  clears its delivered notifications for every account on the device (`viewing`), as on main.
- A real phone, real VoiceOver and a real network: not run. Announcements were checked through the
  store's injected `announce`, and the network loss through the fixture.
- iPad was not captured or run through the new UI tests. Its sidebar reads the same `listedActivity`
  and household outage as the phone's home.
- The remaining differences in `ios/Parity.md`: no live-updates notice, and the poll reading
  bootstrap every 1.5 seconds while Hermes is down.
