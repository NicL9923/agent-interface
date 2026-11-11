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
