# November 14 stable file signing key

Branch `t3/stable-file-signing-key` from `origin/main` at `65ed9eb`, on the Mac mini (macOS 27.0.1, arm64) with
Node 24.22.2. The red runs below were made against the branch's working tree at `86e3586`, before it was squashed
into one commit. Nothing was deployed and no Hermes took part.

## Change

File identifiers are signed with a key kept in the app database's `metadata` table instead of the Hermes token, as
`v2.<key id>.<body>.<signature>`. Identifiers from earlier releases still verify with the Hermes token while one is
configured. Each start re-signs the ones stored in drafts, recorded events and avatars. Every refusal is a 404.

## Red runs

Each broke one line by hand, ran only the named tests, then restored the file from the commit and saw them pass.

| File | Break | Tests | Result |
| --- | --- | --- | --- |
| `hermes-files.ts` | signature comparison replaced with `false` | `hermes-files`, `hermes-adapter` | 5 failed: every wrong-signature case |
| `hermes-files.ts` | canonical base64url check removed | `hermes-files` | 1 failed: non-canonical signature |
| `hermes-files.ts` | `v2.<key id>.` prefix left out of the signed text | `hermes-files` | 12 failed |
| `hermes-files.ts` | key id ignored, current key always used | `hermes-files` | 2 failed: unknown key id, earlier key |
| `hermes-files.ts` | empty body or signature check removed | `hermes-files` | 3 failed |
| `hermes-files.ts` | unsafe path check removed | `hermes-files` | 1 failed |
| `hermes-files.ts` | body `version` check removed | `hermes-files` | 1 failed |
| `hermes-files.ts` | body `botId` type check removed | `hermes-files` | 1 failed |
| `hermes-files.ts` | refusal status 404 changed to 502 | `hermes-files`, `hermes-adapter` | 23 failed, including the `GET /api/files/:id` route case |
| `hermes-files.ts` | `isCurrent` ignores the key id | `hermes-files` | 1 failed |
| `hermes-files.ts` | `legacyToken \|\| undefined` reduced to `legacyToken` | `hermes-files` | survived: `!secret` already refuses an empty token, so the fallback was removed |
| `store-files.ts` | current identifiers re-signed too | `store-files` | 2 failed |
| `store-files.ts` | malformed row parsed without a guard | `store-files` | 2 failed |
| `store-files.ts` | unverifiable reference not counted | `store-files` | 2 failed |
| `store-drafts.ts` | draft cleared on content only, not revision | `store-files` | 1 failed: a send held before the upgrade still clears its draft |
| `index.ts` | upgrade skipped at start | `index-files` | 1 failed |
| `index.ts` | store not passed to `createApp` | `index-files` | 1 failed |

## Not exercised

No real Hermes, no production database, and no iOS build: the iOS app treats file identifiers as opaque strings and
no Swift changed.

## Review fix

GPT-6.1 Sol's review reproduced a lost clear: a device held draft revision 1, another device edited and restored the
same content (revision 3), the startup pass re-signed the stored attachments, and the first device's send of its v1
copy with `draftBaseRevision: 1` left the sent draft in place. A send without `draftBaseRevision` failed the same way.
Draft equality compared signed identifier strings, and a re-signed identifier also rebuilds its body.

Drafts now compare each attachment by the file it names (`fileIdentity` in `src/server/hermes-files.ts`: path,
assistant and kind) when clearing a sent draft and when deciding a save changes nothing.

| Break | Test | Failure |
| --- | --- | --- |
| Clear compares raw identifiers again | `clears the draft by content ... names a revision another device has moved past`, `... names no revision` | 2 failed |
| Identity drops the path | `keeps a draft whose attachment is a different file` | 1 failed |
| Save compares raw identifiers again | `treats a device saving its pre-upgrade copy as no change` | 1 failed |

Each file was restored from a copy and `tests/store-files.test.ts` passed 11 of 11. `check-all --keep-going --py
never` then passed typecheck, lint, ruff, build and 55 e2e tests; Vitest failed only the three `127.0.0.2` tests.
