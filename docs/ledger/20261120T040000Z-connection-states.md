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

This fix has had no review of its own.

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
[`mutants/`](../evidence/2026-11-19-connection-states/mutants/): 63 mutants, 63 caught.

| File                                | Mutants | Result    |
| ----------------------------------- | ------- | --------- |
| `ConnectionOutage.swift`            | 19      | 19 caught |
| `AppStore+Outage.swift`             | 17      | 17 caught |
| `AppStore.swift`                    | 4       | 4 caught  |
| `AppStore+Polling.swift`            | 7       | 7 caught  |
| `AppStore+Conversation.swift`       | 3       | 3 caught  |
| `ConnectionCopy`                    | 9       | 9 caught  |
| `AvatarView`, `Models`, `APIClient` | 4       | 4 caught  |

Survivors on the way, and what was done:

- The pending retry dropped as a read sets out. No test had a retry wake while a read was on its way;
  one now does, and catches the second read.
- `select` clearing the last chat's failures. Equivalent: the next read's outcome, or the new chat's
  id, already decides, so it was removed.
- A new chat's failures starting the waits over (`first ? 1`). Once `select` no longer cleared them,
  this is what does; the chat-switch test now checks the new chat's first wait is a second.

### Checks

| Check                          | Command                                                                                                   | Result                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Connection tests while writing | `validate-ios.sh … test -only-testing:` the five new classes, `NativeContractTests`, `FixedWaitRuleTests` | passed, 205 tests                                                                               |
| Mutants                        | `ios-run.sh`, then the two changed lists again                                                            | 63 of 63 caught                                                                                 |
| Connection UI tests            | `validate-ios.sh … test -only-testing:AgentInterfaceUITests/ConnectionStateFlowTests`                     | passed, 4 tests                                                                                 |
| Native unit suite              | `validate-ios.sh SIMULATOR test`                                                                          | passed: 858 tests, 2 skipped                                                                    |
| Native UI suite                | the same run, then the seven classes it had not reached                                                   | passed: 94, then 66 with 2 skipped                                                              |
| Web battery                    | `.agents/tools/check-all --keep-going`, Node 24.22.2                                                      | typecheck, lint, ruff, build, py passed; test 5 failed of 4,204; e2e 3 failed of 178, 3 skipped |
| Web format                     | `npm run format:check`                                                                                    | passed                                                                                          |

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

The 8 web failures are this Mac's, and all 8 fail the same way at `9301c603` in a separate worktree:
`tests/direct-routes.test.ts` (2) and `tests/native-contract.test.ts` (1) need a second loopback address
the Mac does not have, `tests/upgrades.test.ts` (2) runs `scripts/hermes-upgrade-worker.py` with a
Python that rejects its syntax, and the 3 WebKit cases in `e2e/smoke.spec.ts` (lines 40, 811 and 856)
fail on this host's WebKit. No web source changed here.

### Not done

- No independent review of the iOS change has run.
- A real phone, real VoiceOver and a real network: not run. Announcements were checked through the
  store's injected `announce`, and the network loss through the fixture.
- iPad was not captured or run through the new UI tests. Its sidebar reads the same `listedActivity`
  and household outage as the phone's home.
- The remaining differences in `ios/Parity.md`: no live-updates notice, the whole roster kept while
  Hermes is down, and the poll reading bootstrap every 1.5 seconds while Hermes is down.
- A group chat open while the selected assistant's last read failed keeps its writes refused until that
  assistant's chat is read again, as `appUnavailable` refused them before.
