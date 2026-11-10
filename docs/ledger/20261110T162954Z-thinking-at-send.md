# November 10 the assistant thinking from the moment a message is sent

Branch `t3/thinking-at-send` over `origin/main` at `8281930`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores),
Node 24.22.2. Web client, the browser suite's scripted server and one measuring tool; no app server, Hermes or iOS
code changed.

## What main did

- `src/App.tsx:392` took the activity state only from the conversation Hermes reported, and
  `src/app/Conversation.tsx:302` drew the activity row only for that state. A sent message showed at once as an echo
  (`src/app/sent-echo.ts`), but the row with the avatar waited for the POST's answer, a change notice and a read.
- The activity row is not keyed by `src/app/reply-keys.ts`: it is one conditional child after the turns, so the
  early row and Hermes's row are the same node whenever the row stays mounted. Its status line is a
  `role="status" aria-atomic="true"` region whose words, "Shared is thinking...", are the same for both.

## What the admission answer can say

The client sees `accepted` (with `steered` when the add-on reports its decision), `uncertain`, `rejected` or
`interrupted` (`src/shared/types.ts:476`). Hermes's `prompt.submit` answers `streaming`, `queued` (busy, queued behind
the running turn) or `voice_stopped` (a bare stop phrase typed while the session's own Hermes voice mode is on,
`tui_gateway/methods_prompt.py`, read from a local upstream clone). The add-on folds all three into `accepted`
with `steering: false` (`src/hermes/extension.py:1909`), so the client cannot tell them apart. What a person sees:

| Answer | Row |
| --- | --- |
| Sending, chat idle, done, failed or interrupted | Thinking, at once |
| Sending while the chat shows work (a steer) | Only the work's row; nothing added |
| Accepted, new turn | Thinking until Hermes's report or copy takes over, same node |
| Accepted, steered | Nothing added |
| Accepted, queued behind another turn | That turn's working row takes over the node; nothing after it |
| Accepted, typed stop phrase | Thinking until the echo's own 30 s patience ends, then nothing (see below) |
| Rejected, interrupted, refused by the app (4xx) | Gone with the echo |
| Failed without an answer (5xx, network) or uncertain | Gone while unconfirmed; back while a Retry is on its way |
| Discarded | Gone |
| Read failed (#317) | Send is refused, so no echo and no row |

The typed stop phrase is the one case the client cannot see. WildBots never turns on Hermes's voice mode, so it can
happen only when someone ran `/voice on` in a Hermes terminal on the same session. Showing it correctly would take
the add-on passing `queued` and `voice_stopped` through its receipt; that is a Hermes add-on change, left out here.
Stop and the composer's interrupted-task review follow only Hermes's report, so Stop appears once the turn is real.

Group chats: the group composer shows no echo at all. The message appears after the server accepts it and the room
reloads, and "who is working" comes from the room driver, which picks the member. Not the same gap or the same
change, so not fixed here.

## Gap, before and after

`npm run build && node .agents/tools/measure-thinking-gap.mjs --runs 10 --delays 0,1500`, Chromium 1280 x 800,
`e2e/server.ts` on port 4183, Trail Cook "Echo: …" turns. Time from the echo row's insertion to the activity
row's, per a MutationObserver:

| Build | Admission | Echo to row, median (min, max) | Row nodes inserted, removed | Status words | Sent message moved |
| --- | --- | --- | --- | --- | --- |
| `main` at `8281930` | immediate | 34 ms (30, 49) | 1, 0 | thinking | 18 px |
| `main` at `8281930` | held 1,500 ms | 1,520 ms (1,514, 1,534) | 1, 0 | thinking | 18 px |
| This branch | immediate | 0 ms (0, 0) | 1, 0 | thinking | 18 px |
| This branch | held 1,500 ms | 0 ms (0, 0) | 1, 0 | thinking | 18 px |

On loopback the gap on `main` is one round trip; on a real network it adds the network's round trip and Hermes's
admission. The 18 px move of the sent message is the same before and after, so the send anchor is undisturbed.
The first `main` run timed out waiting for the sign-in button once; the rerun is the one recorded. An earlier
attempt hit another worktree's server on port 4173 and was discarded, which is why `e2e/ports.ts` now reads
`E2E_PORT` and the tool refuses a port that already answers.

## Checks

- `npm ci` once. `npm run typecheck`, `npm run lint` passed. `ruff check .` (ruff 0.17.3): all checks passed.
- `npx vitest run tests/thinking-at-send-ui.test.ts tests/sent-echo.test.ts`: 2 files, 40 tests passed.
- `npm test`: 191 files, 3,184 tests passed.
- `npm run build` passed. `npm run test:e2e`: 21 passed in Chromium (`E2E_PORT=4193` when 4173 was held by
  another worktree). The new e2e test holds admission 800 ms and checks the row showed while the message read
  "Sending…", one row node, one status text.
- Safari, Firefox, screen-reader speech and a real phone: not run. The accessibility claim rests on the status
  node staying the same with the same words, asserted in jsdom and Chromium.

## Red proof

Each line was broken by hand, the named tests went red, and the line was restored:

1. App ignores `awaitingTurn`: 8 UI tests, from "appears with the echo…" to the Retry tests. The e2e test also
   went red on a build with this break: `whileSending` false.
2. `!echo.steered` removed: "does not show when Hermes steered it into the running task".
3. `!echo.duringWork` removed, and separately `duringWork` never set: the unit case and "never adds a row for
   guidance sent while the assistant works…".
4. Unconfirmed echoes allowed: 8 tests, including "goes when the send fails…" and "goes when Hermes's answer is
   uncertain".
5. Retry not blocked by the early row: "keeps a failed turn's Retry away once Hermes accepts…".
6. `echoShown` check removed: "does not show when Hermes's copy is in the chat".
7. `active` on the shown state instead of Hermes's: "offers Stop only once Hermes reports the turn".
8. `!echo.ran` removed: "does not show when its turn already showed work".
9. Bot check removed: "does not show when the message went to another assistant".
10. Active conversation check removed: "does not show when Hermes reports the turn's own work".

## After merging main at `c2ee202` (#320)

`main` gained #320, which changed `src/App.tsx` and `src/app/use-conversation.ts`; the only conflict was the
tools index. On merge commit `068654a`: `npm run typecheck`, `npm run lint` and `ruff check .` passed;
`npm test`: 193 files, 3,224 tests passed; `npm run build` passed; `npm run test:e2e`: 21 passed in Chromium.
`measure-thinking-gap.mjs --runs 5`: 0 ms echo to row at both admission delays, one row node, none removed,
one status text, the sent message moved 18 px as on `main`.
