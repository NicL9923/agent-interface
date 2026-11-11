# November 11 Stop during the disconnect grace period

Branch `t3/stop-during-grace` over `origin/main` at `23e758b`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
Web client only.

## What changed

After a failed conversation read, `connectionLost` is true at once, but the chat shows itself disconnected
(`connectionShown`) only after `DISCONNECT_GRACE_MS` or a second failure (#317). Stop and Ctrl+. used `connectionLost`, so
for those seconds the button was disabled and the shortcut did nothing while the chat still looked fine.

- `canStop` in `src/App.tsx` (the shortcut) uses `connectionShown`.
- The Stop button in `src/app/Composer.tsx` is disabled only while a stop is in flight or the capability is missing.
  It needs no connection check of its own: `active`, which decides whether the button shows at all, follows `reported`,
  which is `disconnected` once `connectionShown`, so the button is gone by then. Its tooltip no longer carries
  the grace-period "Checking the connection" text. Send keeps its connection reason.

A stop sent during the grace period cannot misfire: `useStopResponse` sends one `POST /bots/:id/stop` with no retry. The
server's `runtime.stop` opens the assistant's session and sends `session.interrupt`, so a gone connection throws,
`useStopResponse` reports the error where the person sees it and clears `stopping`. The request interrupts only the
named assistant's session. Whether Hermes treats `session.interrupt` on an idle session as a no-op is not checked here.

## Tests and red proof

`tests/connection-grace-ui.test.ts`: the earlier test that Stop and Send are both refused in the grace period now covers
Send alone. A new "Stop" group: Stop works by button and by Ctrl+. (through its confirmation) during the grace period
and is gone, with the shortcut inert, once the chat shows it is disconnected; a stop sent in the grace period that gets a
connection error shows it, is sent once and is not retried. Each line broken by hand, the file run, then restored:

- `canStop` back to `!connectionLost`: the grace-period case fails (1 failed).
- `canStop` without any connection check: the case fails at the shortcut after the chat shows disconnected (1 failed).
- Stop button `disabled` with `connectionLost` again: both new cases fail (2 failed).
- Stop button `title` with `connectionReason` again: the grace-period case fails (1 failed).

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3), `npm run build` passed. `npm test`: 201 files, 3430 tests
passed. `npm run test:e2e` (`E2E_PORT=4580`): 29 passed.
