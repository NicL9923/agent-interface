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

## November 9 review round

GPT-6.1 Sol reviewed the branch at `bd6def6`. This round merged `origin/main` at `da00a26`
(merge commit `9e3f851`) and changed the code at `d7d2bcd`. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2).

### Findings and changes

- P1, a prefetch made as another account. The record now holds the account ID, written by the
  first connected bootstrap after sign-in; a record without one starts no read. The read is
  tagged with that account. `settleLinkedChat()` runs on every bootstrap before anything else in
  `refresh()`, so before the chat can open: a different account drops the read and clears the
  response cache, and the chat reads again. A `storage` event that removes the record or names
  another account drops the read the same way. A bootstrap that names another account than the
  record also drops the record.
- P2, an empty prefetched chat. `use-conversation.ts` lets only the chat's first load join a
  prefetch. The stream's connection read, every notice, reconnect and poll ask the server.
- README: names the two cases that still cost one refused read.
- `tests/linked-chat-ui.test.ts` no longer mocks presence, device activity or `Avatar`. It runs
  the real client API against a fetch fake that records and refuses any request the test did
  not configure, and fails the test on one. jsdom's missing SVG geometry and
  `IntersectionObserver` are stubbed as other suites do.

### Red before the fix

On `bd6def6` plus the new tests, before each fix:

- `npx vitest run tests/conversation-prefetch.test.ts -t "empty prefetch"`: failed, "expected
  [ Array(1) ] to have a length of 2 but got 1" at the stream's connection read.
- `npx vitest run tests/linked-chat-ui.test.ts`: 8 failed. Both "never shows a read made as
  another account" cases failed with "expected 'One's private draft' not to contain 'One's
  private draft'"; both "drops its read when another tab…" cases failed the same way with "Read
  before the switch"; the two new record guards and the two record-content tests failed on the
  missing account field.

### Mutants

Each line was broken by hand, the two focused files run, and the source restored.

| Mutation | Result |
| --- | --- |
| `settleLinkedChat()` call removed from `refresh()` | failed: both "never shows a read made as another account" |
| A mismatched account settles without dropping | failed: the same two |
| `storage` listener not added | failed: both "drops its read when another tab…" |
| Any record change drops the read | failed: "keeps its read when another tab changes the same account's chat list" |
| Storage key filter removed | failed: "keeps its read when another tab changes something other than the sign-in" |
| A record without an account prefetches | failed: "waits for bootstrap with a sign-in whose account no bootstrap has named yet" |
| Account type check removed | failed: "waits for bootstrap with an account that is not an ID" |
| Another account's record kept | failed: "is forgotten when bootstrap names an account other than the one it recorded" |
| Account not recorded | failed: "starts at sign-in, learns the account and chats…" |
| A drop does not clear the response cache | failed: 4 drop cases |
| Every load may join the prefetch | failed: "reads fresh for the stream's connection and each notice after an empty prefetch" |
| No load may join the prefetch | failed: 6 cases |

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/linked-chat-ui.test.ts tests/conversation-prefetch.test.ts`: 2 files, 35
  tests passed.
- `npm test`: 171 files, 2,599 tests passed.
- `npm run build`, then `npm run test:e2e`: 4 Chromium tests passed.

### Not exercised

- Two real browser tabs switching accounts. The interleaving runs in jsdom with the real client
  API and a fake server.
- Safari, Firefox and an installed iOS web app: not run.
- A false match needs the cookie to change from A to B, then back, between this page reading the
  record and bootstrap leaving, with no storage event in between. Not tested; it needs two
  sign-ins inside one round trip.
