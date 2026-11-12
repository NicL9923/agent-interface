# November 12 Today answers without its slowest assistant

Branch `t3/4fbe4b74` over `265f36d`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2. Source fingerprint of
`src tests docs/native-api.md` with the change applied:
`sha256:d944740662192c0b7380bc344cce39a1750bff26294dc341962e2cb2dd2d9c13` (635 source files). No Hermes process ran
and nothing was deployed.

## Defect

`GET /api/today` read every assistant's first page, four at a time, and answered only when the last finished: 8.4 s
cold on production, mostly the longest chat. Each read asked for 20 turns, though Today needs only an assistant's
latest reply, its state and the files of recent work, and the add-on's window context already holds every earlier
message with files.

## Change

- A recap reads the last 2 turns. Only a window without a reply reads 20 turns, and the whole history after that,
  as before. Files and event files come from the window's context whatever its length, so the output is the same.
- Today waits `TODAY_WAIT_MS` (2 s) for each assistant, from one deadline for the request. An assistant not read by
  then is answered as `pending: true`: the roster's activity, no requests, and the files and reply of its saved recap
  when the recap key (session, preview, start, unread runs, privacy) is the same, nothing otherwise. It is listed in
  `unavailableBots` too. Its read goes on under a limiter of four reads across every Today, and the next Today with the
  same key takes it, on its way or up to `TODAY_LATE_MS` (5 s) after it finished; an answer taken in time is not taken
  again, so a running assistant is still read on every Today, as before.
- The web Today names the assistants still being checked ("Still checking Patch."), says "No requests in checked
  assistants" rather than "All clear", and asks again every 2 s while any is pending, including through a 304.
- Deliberate change for iOS, which ignores `pending`: such an assistant shows as "Couldn't check 1 assistant. Their
  current activity is unknown." until its next refresh. iOS was not changed.
- `docs/native-api.md` describes `pending`.

## Measurement

A fake runtime, six assistants, every history read 150 ms except one of 3 s, light reads 20 ms; `GET /api/today`
timed through the Fastify app, then again at once, then 1.2 s later, then at once:

| Build | First Today | Asked again at once | 1.2 s later | At once |
| --- | --- | --- | --- | --- |
| `265f36d` | 3015 ms | 42 ms | 41 ms | n/a |
| this change | 2025 ms, the slow one pending | 992 ms, its read taken | 42 ms | 42 ms |

On production the first answer is bounded by 2 s instead of the longest chat's 8.4 s cold read, and the slow chat's
read is shared with the follow-up instead of repeated. The smaller window's saving in transfer was not measured; the
add-on's history projection, which dominates a cold read, is the same for any window.

## Tests and red runs

- `tests/experience-api.test.ts`: the window is 2 turns, then 20, then the whole history; a slow assistant is answered
  pending and unchecked, and the next Today takes its read; a pending assistant keeps its saved recap's files and reply
  with the roster's activity, and another recap shows none; a late read is not taken for another recap or once
  `TODAY_LATE_MS` old.
- `tests/experience-ui.test.ts`: the pending note and summary, asking again through an unchanged answer, stopping once
  checked. `tests/concurrency.test.ts`: `limiter`.

Each mutation by hand, restored after:

| Mutation | Result |
| --- | --- |
| waits for the slowest | failed: is answered without, as unchecked… (3 tests) |
| never joins a late read | failed: is answered without, as unchecked, and the next Today takes its read… |
| joins another recap's read | failed: is read again for another recap, or once its answer is TODAY_LATE_MS old |
| joins however old | failed: is read again for another recap, or once its answer is TODAY_LATE_MS old |
| answer left to be taken again | failed: reads a settled assistant's history again only after its roster preview changes (2 tests) |
| pending listed as checked | failed: is answered without, as unchecked… |
| another recap's files shown | failed: keeps the files and reply of the same recap it saved… |
| saved recap not shown | failed: keeps the files and reply of the same recap it saved… |
| the roster's activity not shown | failed: keeps the files and reply of the same recap it saved… |
| a page of twenty turns | failed: builds a recap from a recent window and its earlier file context… |
| straight to the whole history | failed: builds a recap from a recent window and its earlier file context… |
| web asks again once | failed: names an assistant the server is still checking… |
| web never asks again | failed: names an assistant the server is still checking… |
| pending counted as couldn't check | failed: names an assistant the server is still checking… |
| pending not named | failed: names an assistant the server is still checking… |
| limiter runs all at once | failed: runs at most its limit at once… |
| a failure frees no slot | failed: runs at most its limit at once… |

## Checks

`npx vitest run`: 211 files, 3879 tests passed; typecheck and lint pass. The full battery runs once for the branch.
Not exercised: real Hermes, production, and iOS.

## Installed iOS builds

Merged into the consolidated branch, the pending answer became opt-in. The iOS app ignores `pending` and shows such an
assistant as one it could not check, so `GET /today` answers early only with `pending=1`, which the web panel sends.
Without it, Today waits for every assistant as before, still reading 2 turns each and taking a check another Today
started. `tests/experience-api.test.ts` "waits for every assistant when the client does not ask for pending answers"
fails with the deadline applied to every request; "refuses a pending value other than 1" names the `pending` field.
