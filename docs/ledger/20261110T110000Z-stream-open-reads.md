# November 10 stream opens name the read they follow

Branch `t3/stream-open-reads`, from `origin/main` at `5d74731`. Checks ran on NicolasLaptop (Fedora,
Linux x86_64, Node 24.22.2) in Chromium only. No real Hermes, iOS build, deployment, Safari, Firefox or
phone ran.

## What changed

Each event stream opens after the reads it follows settle and names what they showed. The server
compares once its watch is in place and sends its existing notice at open only if the state moved on,
so the client no longer reads on open.

- Chat stream: `?since=` names the conversation read's structural version. A new optional runtime
  method, `version(botId)`, gives the version a read starting now would carry. The Hermes runtime returns
  `versionOf(structuralGenerationOf(botId))`, which moves on every change a watcher hears without a kind.
  If the read is stale, or the runtime keeps no versions, the server sends one `data: change`. If it is
  current, it sends the running reply whole.
- Household stream: `?roster=` names bootstrap's new `rosterVersion`, and the server sends
  `event: roster` at open if the roster changed. `?groups=` names `GET /api/groups`'s new `version`, and
  the catalog watch skips its connect notice while the catalog is unchanged.
- The household stream waits for home's first catalog read. On wake it waits for the bootstrap that
  wake started. A server that sends `groups` notices no longer gets a catalog read on wake, because the
  reopened stream covers it.
- Old web bundles and the iOS app name nothing. Their streams send exactly what they sent before.

## Request counts

The counts come from `node .agents/tools/count-stream-requests.mjs`. It runs real Chromium against
`e2e/server.ts`, with service workers blocked so each `/api` request counts once. Cold is a fresh tab
on `/?bot=ranch`, counted for 8 s. Wake is 70 s hidden, then shown, counted for 8 s. Idle is 10 minutes
after settling, with one tab on a chat and one on home. The e2e runtime now versions every read as
Hermes does. It has no group chats, so the catalog changes are covered only by tests.

| Scenario | `main` 5d74731 | This branch | Change |
| --- | --- | --- | --- |
| Cold load | 10 | 8 | bootstrap 2 to 1, conversation 2 to 1 |
| Wake | 12 | 10 | bootstrap 2 to 1, conversation 2 to 1 |
| Idle chat, 10 min | 113 | 113 | none; idle polling is a separate change |
| Idle home, 10 min | 113 | 113 | none |

## Checks

- `npm ci`: passed.
- `npm run typecheck`, `npm run lint`: passed.
- Touched test files: `connection-ui`, `home-groups-ui`, `app-ui`, `conversation-prefetch`,
  `conversation-events`, `group-catalog-watch`, `live-turn-runtime`, `helper-guards` and
  `native-contract` passed.
- `npm test`: 179 files, 2,944 tests passed. The known flaky transcript test did not fail.
- `npm run build`: passed.
- `npm run test:e2e`: 9 passed.
- iOS contract fixtures `bootstrap.json` and `groups.json` gained one optional key each. The Swift
  `Bootstrap` and `GroupCatalog` use synthesized `Decodable` through a plain `JSONDecoder`, which ignores
  unknown keys. `ContractFixtureTests` was not run; it needs the Mac mini.

## Red proofs

A scratch script broke each line by hand, ran the protecting tests, and restored the source. All 19
mutations went red. Two stayed green on the first run: one mutation was malformed and was redone; the
other exposed a missing test for reopening after the wake's bootstrap, which was added.

- Server: no stale notice; a comparison taken before the watch; no live reply when current; a repeated
  or overlong version taken as none; no roster notice at open; `rosterVersion` hashing other text; the
  catalog watch always stale, or ignoring `since` at its first check; `GET /api/groups` version
  hashing other text; Hermes `version()` not following the structural generation.
- Client: reading on open while vouched; never recording the shown version; opening before the first
  read settles; the household opening before the catalog read; reopening before the wake's bootstrap;
  the `wake` predicate ignored on focus, or on the poll's show refresh; a versioned catalog not proving
  notices.

## Not exercised

- A group room's stream, `?group=`, still reads on open, as do the room watch's first-poll notice and
  a draft change between the draft read and the subscription.
- Old bundles against this server were checked by server tests, not in a browser.
