# November 10 a bootstrap that names another member than the record no longer keeps the record's address

Branch `t3/stale-record-address` over `origin/main` at `2f1670e`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2, ruff 0.17.3.
Client and tests only. Line numbers are this branch's. It touches `accountNamed` only, so it shares no line with
`t3/refused-session-push`, which is server code; the two are independent.

## Defect

`accountNamed` (`src/app/account-epoch.ts`) ended the generation only when this generation had already drawn another account
(`drawn`, from an earlier bootstrap or the saved home). When the stored record lags the cookie, which storage that refuses writes
allows, a page opens under member A's record with member B's cookie. `accountStart` sets `addressFor` to A, and `AccountApp` reads the
address into its state at mount: the open chat (`useSession`), view, room and panel (`initialView`, `initialRoom`, `initialPanel`
in `App.tsx`), and the fragment. The first bootstrap then names B, `drawn` is undefined, so the answer was used: the record was rewritten
to B and `drawingAccount(B)` marked the address as B's. A's chat, panel and fragment carried into B's view, and `useUrlSync` kept
writing them. For a chat B cannot open, B also got "That assistant is no longer available to you" from A's address.

## Decision

End the generation, as for a drawn account, instead of resetting only the URL. The state was read from the address before bootstrap
answered, so replacing the URL alone would leave A's chat selected. Ending the generation is the way `addressLeaves` makes an address
leave on a settled change: `transition({ user })` ends it, the next `accountStart` finds `addressLeaves({ user: A }, { user: B })`
true, `App` resets the address to `/` (`App.tsx:74`), and `AccountApp` mounts again and reads the clean address.

The condition is `addressFor.user` is named and is not the bootstrap's account (`account-epoch.ts:423`). It is not "the record's
account is not the bootstrap's", for these cases, which keep the address and the answer:

- The record names no account (a sign-in whose answer named none, or a browser signed in before records existed) and the address
  is `{}`: the first bootstrap names the account, the address is its own.
- The record is a sign-out, or there is none, so the address was opened signed out and "the next account keeps it".

The cost is one more bootstrap, and a connecting screen, when it happens. With storage that refuses writes, the record is kept in
memory (`unwritten`), so the second bootstrap meets a record that names B and is used. The UI test counts exactly two bootstrap reads
over five more seconds.

## Tests

- `tests/account-epoch.test.ts`, "a bootstrap that names an account, for a page that opened under a record": a table of the records
  whose answer is used, each checked for whose address it leaves (the same account put back keeps it, another takes it): the
  record's own member, a record naming none, a sign-out, no record. Then member one's record with member two named: the answer is
  refused, the record names two, the next start says `leftAccount: true`, the second answer is used and keeps what it draws. And
  the same with `setItem` refusing, from memory.
- `tests/account-transitions-ui.test.ts`, "the address after a change": member one's record and hint, member two's cookie, a page opened
  at `/?bot=home#home-1`: it shows member two's Barn Cat chat, not the shared Home chat, with `?bot=barn`, no fragment, no
  "no longer available", nothing of member one's, and the record naming two. The same with storage refusing writes, and exactly
  two bootstrap reads after five more seconds. And member one's record with member one's cookie keeps `?bot=home#home-1` after one read.

### Red runs

Each protecting line broken by hand, the file restored, over `tests/account-epoch.test.ts`, `tests/account-transitions-ui.test.ts` and
`tests/saved-roster-ui.test.ts`.

| Mutation | Result |
| --- | --- |
| No address condition, as on `main` | failed: both unit refusal tests and both UI lag tests (4) |
| `addressUser !== user` without the named guard | failed: the three "uses the answer" unit rows, the UI "record had not named" test and four saved-home tests (8) |
| Any named address ends the generation, even for the same account | failed: 16 tests, and the UI files never finished, the generation restarting forever; I stopped the run |
| Judged by `record?.user` instead of the address's account | failed: the sign-out unit row (1), so the sign-out row is what tells the two apart |

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` pass. `npm test`: 202 files, 3,526 tests. `npm run build` passes.
`npm run test:e2e`: 38 passed.

## Not exercised

A real browser whose storage refuses a write: the UI test refuses `setItem` in the harness's storage, and the unit test spies on
`Storage.prototype.setItem`. Only Chromium runs here.

## Found along the way, not changed

The saved home has the same shape one step earlier. `AccountApp` calls `drawingAccount(saved.user)` at mount, which sets
`addressFor` to the saved copy's account whatever the record named. `readSavedRoster` checks the sign-in hint's account, not the
record's, so a copy for B opened under A's record, with the hint naming B and the record naming A, would mark A's address as B's.
That needs the hint and the record to disagree as well, and it is a different concern, so it is left for its own change.
