# November 10 a user row with no sender in a shared chat

Branch `t3/unknown-sender` over `origin/main` at `785f4f2`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
Web client only. Hermes, the add-on and the server did not change and did not run.

## What changed

`TurnView` in `src/app/Conversation.tsx` labels a person's message that carries no `sender` "Household member" when
other members can write in the chat, so it no longer reads as the viewer's own. The wording is the one
`src/server/group-latest.ts` uses for an author it cannot resolve. A chat is private, and keeps the old unlabeled
look, only when its assistant is `shared === false` with a recorded `ownerId`; that is the case
`visible` in `src/server/bot-access.ts` hides from everyone else.

## Tests and red proof

`tests/app-ui.test.ts`, "labels a message with no sender in %s": a shared assistant, a personal assistant with no
recorded owner, and the viewer's own personal assistant, each with a row the viewer sent, a row with no sender and a
row from another member. Each line broken by hand, `npx vitest run tests/app-ui.test.ts -t "labels a message with no sender"`
run, then restored:

- `sharedChat ? UNKNOWN_SENDER : ""` replaced by `""`: the shared and the ownerless cases fail (2 failed, 1 passed).
- `bot.shared === false && !!bot.ownerId` replaced by `bot.shared === false`: the ownerless case fails (1 failed).
- the same replaced by `false`: the owner's own case fails (1 failed).

## Not exercised

A real Hermes desktop client writing into a shared chat; the rows in the tests are the shape its history read returns.

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3), `npm run build` passed. `npm test`: 196 files, 3299 tests
passed. `npm run test:e2e` (`E2E_PORT=4580`): 24 passed.

## Review fixes: the viewer's own sends

Merged `origin/main` at `2f1670e` first, as its own commit. Review found two things.

P2. The viewer's own steer read "Household member" once Hermes's copy replaced the sent echo. The add-on binds a steer
only after its turn and never binds a queued or redirected send, and the echo leaves on any row with the same words and
no sender. `src/app/sent-echo.ts` now keeps an `OwnSend` for each send Hermes accepted (`nextSends`, recorded from the
echo the send had until then, never for a typed stop), and `ownSentRows` claims for each the first row after its anchor
that `echoShown` would take as its copy (the shared `copyIndex`): named by request or row ID, or the same trimmed words
from no sender or from the viewer. One send claims one row, so another member's row with the same words stays
labeled only when it is saved after the viewer's copy; saved first, it takes the claim and reads as the viewer's own,
because equal words cannot tell them apart, and a row the add-on bound to the viewer takes the claim before a no-sender row. `TurnView` skips the label for
a claimed row (`ownRows`, from `src/App.tsx`); it is a display hint, bound to nothing, and the matrix says so.
Retention: in memory only, in the mounted app's state, so it ends with the account generation (the app mounts again for
each one) and when another person signs in; the newest `OWN_SENDS_KEPT` (20) sends of a chat. The anchor stops an older
row with the same words matching. A record that outlived a send Hermes never saved under its own words was fixed in the next round.

P3. `a.sharedChat === b.sharedChat` in `sameTurnProps` had no test.

### Tests and red proof

`tests/sent-echo.test.ts` ("the person's own sends, kept after their echo leaves") and `tests/app-ui.test.ts` ("the
viewer's own sends in a shared chat": a steer echo handing off to a no-sender row with another member's same words after
it, a queued send, a row saved before the send, a copy that arrives before the receipt, and an assistant whose sharing
changes while its chat is open). Each line broken by hand, the file's tests run, then restored:

- `sharedChat && !ownRows.has(...)` back to `sharedChat`: 4 of the 5 UI tests fail.
- the `ownRows` comparison in `sameTurnProps` removed: "reads a copy that arrived before Hermes answered" fails. The first
  draft of that test passed, because the echo row shared a turn and the live flag changed; it now has a reply after the
  steer row and the chat done.
- `a.sharedChat === b.sharedChat` removed: "follows an assistant that becomes the viewer's personal one" fails.
- `claimed` not passed to `copyIndex`: "claims one row for each send" fails.
- `receipt.turn !== "none"` removed, the accepted status removed, the sender filter removed: each fails its own case.
- the cap off by one, and the cap counting other chats: "keeps a chat's newest sends" fails both.
- the anchor guard removed: "anchors on a saved message" and "does not claim a row saved before the send" fail.
- the other-member sender guard replaced by `true`: "matches an accepted copy by its words" and "skips a row another member sent" fail.
- the chat filter in `ownSentRows` removed: "skips a row another member sent, and a send of another chat" fails.
- the row-ID match removed from `copyIndex`: "lets a row Hermes named for the send" fails.

`tests/transcript-rerender.test.ts` passes the new prop; nothing else in it changed.

### Checks

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3), `npm run build` passed. `npm test`: 202 files, 3538 tests
passed. `npm run test:e2e` (`E2E_PORT=4580`): 38 passed.

## Review fixes, round 2: reload anchor, lingering records, wording

Merged `origin/main` at `f6e0090` first, as its own commit. Review of `339c719` found three things.

P2. A send restored after a reload had no anchor. `use-submission.ts` restores the pending send while
`use-conversation.ts` still has no conversation, so its echo has `after: undefined`; Hermes then accepts it as queued or
steered with no `messageId`, and the record searched from index 0, so it could claim an older member's no-sender row
with the same words, which lost its label, while the viewer's real row read "Household member". `ownSentRows` now
claims by ID only for a record with no anchor (`copyIndex` with empty words). The viewer's own queued row in that case
still reads "Household member", which is the honest outcome without evidence. A send in a chat that was truly empty has
no anchor either, so it also claims by ID only; that needs a queued or steered send into a chat with no messages, which
nothing running makes possible this week.

P3. A record lingered when Hermes never saved a send under its own words, as when it joins steers waiting at one tool
batch into one row or merges or drops queued text (`docs/HermesCapabilityMatrix.md`), and then claimed another
member's identical words. A time bound cannot work, since a queued send waits as long as the work before it. `nextSends`
now takes the echoes before and after the change and drops a record when its echo left while its own chat is open and
`copyIndex` finds no copy, the evidence `nextEcho` uses to leave. `advance` is exported so a test drives both lists in
one step. Known cost: a queued send whose chat settles before Hermes saves its row loses its echo, as before, and now its
record, so that row reads "Household member". The echo already stopped standing for it there.

P3. The wording here and in `docs/HermesCapabilityMatrix.md` said another member's "later row" stays labeled. That holds
only when it lands after the viewer's copy; saved first, it takes the claim. Both say so now.

### Tests and red proof

`tests/sent-echo.test.ts`: "a send restored after a reload, before the chat was read" (an older member's same words
unclaimed, a row Hermes named still claimed) and "a send Hermes never saves under its own words" (two steers joined into
one row, then another member's same words; a copy that is shown or a long queue keeps its record; another chat open
leaves it alone). Each line broken by hand, `npx vitest run tests/sent-echo.test.ts` run, then restored:

- `copyIndex(send.after ? send : { ...send, text: "" }, ...)` back to `copyIndex(send, ...)`: the reload case fails (1 failed).
- the drop in `nextSends` removed: the joined-steers case, the keep case and the other-chat case fail (3 failed).
- the drop made to ignore the copy test (`&& copyIndex(...) < 0` removed): "keeps a record whose copy is shown" fails (1 failed).
- the open-chat test removed: "leaves a record alone while another chat is open" fails (1 failed).
- the echo-left test (`!after.some(...)`) removed: the joined-steers and keep cases fail (2 failed).

### Checks

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3), `npm run build` passed. `npm test`: 202 files, 3559 tests
passed. `npm run test:e2e` (`E2E_PORT=4580`): 39 passed.
