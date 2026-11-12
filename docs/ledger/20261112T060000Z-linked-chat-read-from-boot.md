# November 12 a linked chat's read starts before the bundle

Branch `t3/4fbe4b74` over `265f36d`, on NicolasLaptop (Fedora 44, Linux x64, 32 logical cores), Node 24.22.2,
Playwright's Chromium. Source fingerprint of `public src/startup-read.ts src/app tests .agents/tools` with the change
applied: `sha256:b37de9c8f9e359cd981d75d991ab7ed1fa3d8941cdd52d9c4f90c585b3c867d7` (474 source files). Nothing was
deployed.

## Defect

Opening a chat's address (`/?bot=ID`) on a 4x-slowed CPU with Slow 4G, the conversation read started 4.2 to 4.6 s
after navigation on production, although bootstrap answered at about 1.8 s: `boot.js` started only bootstrap, and the
chat's read (`prefetchLinkedChat`, src/app/linked-chat.ts) waited for the bundle to download and run.

## Change

- `public/boot.js` starts the chat's first page (`/bots/ID/conversation?turns=20`) beside bootstrap, by
  `prefetchLinkedChat`'s rules: a conversation view, not a link to one message, Today or a group chat, a shown page
  that is online, and a chat the stored sign-in hint lists for a named account that has not lapsed. Nothing starts
  while another tab's sign-in or sign-out is under way, as before.
- `src/startup-read.ts` version 3 holds several reads by path under one account record. `api()` takes each once, on
  its own path; an account record that changed drops them all; one malformed read drops them all; a minute with no
  bundle asking lets them all go. An older release's single read is still aborted when dropped.
- The bundle is unchanged: `prefetchLinkedChat` still asks for the chat, sets the account the read was made for, and
  `api()` hands it the read `boot.js` started, through every check `api()` makes of its own. So the response cache,
  account scoping (`settleLinkedChat`) and `prefetchLinkedPage` rules hold as before.
- `.agents/tools/measure-first-load.mjs --chat ID` loads a chat's address and reports when its first conversation read
  is issued, sent and answered, and when bootstrap is issued.

## Measurement

`node .agents/tools/measure-first-load.mjs --chat ranch --runs 5 --only cold,warm`, run twice per build, the builds
alternating (before, after, before, after), each against a fresh e2e server; `--compare` was not used because its
build swap crashed Chromium here, and the `worker` load crashes Chromium on `265f36d` too, with or without `--chat`,
so it is not reported. Medians (quartiles), 10 loads each, ms from navigation start:

| Load | Build | Chat read issued | Chat read sent | Chat read answered | Bootstrap answered |
| --- | --- | --- | --- | --- | --- |
| cold | `265f36d` | 5561 (5557 to 5568) | 5561 (5558 to 5569) | 5715 (5712 to 5724) | 3496 (3488 to 3538) |
| cold | this change | 478 (475 to 482) | 3370 (3366 to 3380) | 3548 (3541 to 3561) | 3516 (3507 to 3525) |
| warm | `265f36d` | 444 (441 to 446) | 444 (441 to 446) | 600 (595 to 602) | 493 (493 to 494) |
| warm | this change | 330 (329 to 332) | 331 (330 to 332) | 492 (491 to 493) | 498 (497 to 500) |

The e2e server speaks HTTP/1.1, so on a cold load Chromium's six connections a host queue both early reads behind the
bundle's files: the chat read is issued at 0.48 s but leaves at 3.4 s. Production serves the app over a proxy whose
protocol was not checked here; over HTTP/2 the read would leave when issued. Each build made two conversation reads per
load (the second from the change notice the opened chat's stream sends) and two bootstrap reads, the same before and
after. Bootstrap was issued 32 ms later on a cold load (445 to 477 ms), from the larger `boot.js`. The load average
reached 8.45 by the end of the last run, above the tool's quarter-of-cores line, so small differences are not results;
the chat read's figures moved by seconds.

## Tests and red runs

- `tests/linked-chat-ui.test.ts`: the whole "a link that names a chat" suite now runs twice, read as the bundle starts
  and from `boot.js`, so both follow the same rules, including every case that waits for bootstrap (new: a group chat
  link) and the account checks. New: the chat's read starts before the bundle and the chat shows it without reading again.
- `tests/startup-read.test.ts`: the chat's read is at the path the bundle reads (`firstPage`), each read is taken once
  on its own, none for a hidden page, offline, an unlisted chat or a message link, both dropped on an account change
  or another account record, both let go after a minute, and malformed or older-release shapes dropped and aborted.

Each mutation by hand, restored after, against `npx vitest run tests/startup-read.test.ts tests/linked-chat-ui.test.ts`:

| Mutation | Result |
| --- | --- |
| no chat read | failed: is dropped with bootstrap's when the account changes… (5 tests) |
| any chat read | failed: waits for bootstrap with a chat the last sign-in could not open (2 tests) |
| a message link read at the latest page | failed: opens a message link at that message after bootstrap (3 tests) |
| Today read | failed: waits for bootstrap with a link to Today |
| a group chat read | failed: waits for bootstrap with a link to a group chat |
| hidden page read | failed: reads bootstrap alone for a hidden page… |
| offline read | failed: reads bootstrap alone for an offline browser |
| another path than the bundle's | failed: drops a read for a chat the person can no longer see… (12 tests) |
| the timer lets go of bootstrap's only | failed: lets both go after a minute when no bundle asks for them |
| taken under another account | failed: is not taken under another account record, and nor is bootstrap's |
| taken twice | failed: is taken once, so the read after an error answer asks the server again (2 tests) |
| left on window once all are taken | failed: reads the chat's first page beside bootstrap… |
| malformed reads kept | failed: is dropped, and aborted, when it has a read whose path is not text (3 tests) |
| an older release's read not aborted | failed: is dropped, and aborted, when it has the shape an older release left |

## Checks

The two suites pass (99 tests); typecheck and lint pass. The full battery runs once for the branch. Not exercised: a
phone, production, and the service worker's shell load.
