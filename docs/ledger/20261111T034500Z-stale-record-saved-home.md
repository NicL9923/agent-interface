# November 11 a saved home no longer marks the address as another member's when the record and the hint disagree

Branch `t3/stale-record-address` from `de4c15c`, merged with `origin/main` at `16c96a8` first, on NicolasLaptop (Fedora 44, Linux x64),
Node 24.22.2 after a real `npm ci`, ruff 0.17.3. Client and tests only. Line numbers are this branch's.

## Defect

`readSavedRoster` (`src/app/saved-roster.ts:99`) read the saved home for the account the sign-in hint names. `AccountApp` then
called `drawingAccount(saved.user)` at mount (`src/App.tsx:138`), which set the address's account to the saved copy's. When the settled
record named another member than the hint, as when storage refused one of the two writes of a sign-in, the page opened under the
record's account and drew the hint's home, and the address was marked as the hint's member's. The reviewer's probe: the record names
member two, the hint and saved home name member one, the cookie is member one's, and the page opens at `/?bot=home#home-1`. After one
bootstrap the address was still `?bot=home#home-1`, though it had been opened under member two's record.

## Change

`recordedUser` (`src/app/account-epoch.ts:133`) returns the account the stored record names for this browser now, through the
`accountOf` that `accountStart` uses, so a sign-out and a record that names none give nothing. `readSavedRoster` returns null when
the record names an account other than the hint's. With no saved home drawn, the address stays the record's, so the first bootstrap
naming member one ends the generation (the previous commit's check), the address is reset to `/`, and the app starts again at member
one's own place. A record that names no account, or a sign-out, does not block the saved home, as before. The README sentence
about when the saved home is drawn says so.

## Tests

`tests/account-transitions-ui.test.ts`, in "the address after a change", over the real app and a fake server by cookie:

- The reviewer's probe: record member two, hint and saved home member one, cookie member one, page at `/?bot=home#home-1` with
  bootstrap held. Before bootstrap answers, the screen is "Connecting" and shows no Ranch Hand. After it answers, member one's Ranch
  Hand chat is open, `?bot=ranch`, no fragment, no shared Home chat, and the record names member one.
- The matching case: record, hint and saved home all member one. Before bootstrap answers, the rail shows Ranch Hand from the saved
  copy, and after it the address is still `?bot=home#home-1` with the Home chat open.

### Red runs

Each protecting line broken by hand, the file restored, over `tests/account-transitions-ui.test.ts`, `tests/saved-roster-ui.test.ts`
and `tests/account-epoch.test.ts`.

| Mutation | Result |
| --- | --- |
| Record check removed from `readSavedRoster`, as before | failed: the probe (1) |
| Blocks unless the record names the hint's account, so a record naming none blocks too | failed: 8 saved-home tests, which open with no record account |
| `readSavedRoster` returns null always | failed: the matching case (1) |

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` pass. `npm test`: 203 files, 3,590 tests. `npm run build` passes. `npm run test:e2e`:
39 passed.

## Not exercised

A real browser whose storage refuses one of the writes. The record and hint are written by hand into the harness's storage. Only
Chromium runs here.

## Closes

The "Found along the way, not changed" paragraph of the previous entry for this branch.
