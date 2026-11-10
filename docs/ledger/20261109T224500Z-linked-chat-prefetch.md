# November 9 a linked chat is read beside bootstrap

Branch `perf/linked-chat-prefetch`, from `origin/main` at `0d205eb`. Checks ran on NicolasLaptop
(Fedora, Linux x64, Node 24.22.2) at commit `3184fea`, which this entry follows. No Python, iOS or
Hermes code changed. The server change is a shared constant for the session lifetime, with the
same value.

## Change

- `src/app/linked-chat.ts`: `prefetchLinkedChat()` runs as `useSession` mounts, before the first
  bootstrap. For `/?bot=ID` it calls `prefetchFirstPage(ID)`, which the chat already joins.
- It reads only when `agent-interface:sign-in-hint` in localStorage says this browser signed in
  less than `SESSION_MAX_AGE_MS` (seven days, less a minute) ago and the last connected bootstrap
  listed the chat. Sign-in writes the record, each connected bootstrap updates its chat IDs, and a
  401 bootstrap or a sign-out removes it.
- A link with `message=`, `view=today` or any other view waits for bootstrap as before.
- `prefetchedFirstPage` also returns a read that finished less than five seconds ago, so a chat
  opened after its prefetch finished does not read twice.

## Application tests

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/linked-chat-ui.test.ts tests/conversation-prefetch.test.ts`: 2 files,
  25 tests passed.
- `npm test`: 171 files, 2,571 tests passed.
- `npm run build` passed, including the precache-plan guards, then `npm run test:e2e`: 4 Chromium
  tests passed, including the new link case.

## Mutants

Each line was broken by hand, the focused tests run, and the source restored.

| Mutation | Result |
| --- | --- |
| `prefetchLinkedChat()` call removed from `useSession` | failed: "reads the chat while bootstrap is on its way…", "drops a read for a chat the person can no longer see…" |
| Chat-list guard removed | failed: signed-out case and 6 "waits for bootstrap" cases |
| Lapse check removed | failed: "waits for bootstrap with a sign-in that has lapsed" |
| `Array.isArray(bots)` check removed | failed: "…whose chats are not a list of IDs" |
| `typeof until` check removed | failed: "…a lapse time that is not a number" |
| Message-link guard removed | failed: "opens a message link at that message…", "…a link to a message…" |
| View guard removed | failed: "…a link to Today" |
| `forgetSignIn()` on a 401 removed | failed: "starts at sign-in, learns the chats…" |
| `forgetSignIn()` on sign-out removed | failed: "is forgotten when the person signs out" |
| `rememberSignIn()` removed | failed: "starts at sign-in, learns the chats…" |
| Connected check on the chat-list write removed | failed: "starts at sign-in, learns the chats…" |
| Lifetime not from `SESSION_MAX_AGE_MS` | failed: "starts at sign-in, learns the chats…" |
| A finished read not joinable | failed: "opened 4999ms after a prefetch finished…", "reads the chat while bootstrap is on its way…" |
| Freshness boundary `<` changed to `<=` | failed: "opened 5000ms after a prefetch finished…" |
| e2e: `prefetchLinkedChat()` removed, rebuilt | failed: "a link to a chat…" at `expect(heldUntil[0]).toBe(true)`, received `false` |

One mutant survived the first pass: removing the check that each listed chat is a string. A
non-string entry never equals a chat ID, so the check was dead. It was removed with its test case.

## Not exercised

- No browser use beyond the Playwright suite. No real phone or notification tap.
- A browser signed in before this release has no record, so it waits for bootstrap until its next
  sign-in, at most seven days.
- A session the server ends early, such as an account removed from the household, still has a
  record until the next 401. That load logs one refused chat read. A chat made private since the
  last bootstrap logs one 404 the same way; the app shows its existing notice and opens the main
  assistant.
