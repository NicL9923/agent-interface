# November 12 an opened chat shows its first read

Branch `t3/36e26aad` over `origin/main` at `1e3cb31`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
Source fingerprint of `src/app` and `tests/app-ui.test.ts` with the change applied:
`sha256:e8702cf0dfdf7fef2209c227d3330abb5cb4baf14dd619fb6d1bd2bdc95ad9be` (105 source files). Nothing was deployed.

## Defect

Measured in Chromium against production (release `f30d06d`) with a temporary two-minute session, since removed:
every chat opened from its URL made two conversation reads in a row and painted only after the second. `patch`
showed its first message after 13.8 s, from reads of 6.9 s and 6.0 s; `penny` after 1.7 s, from 0.83 s and 0.12 s.

`useConversation` drops a read answered by another server process once a newer read is asked. Before the first read
is taken, no process is shown, so `boot` is undefined and every answer counted as another process's. Opening a chat
attaches Hermes's socket to its session, and the frames that follow send the open chat's stream a change notice while
the first read is on its way, so the first answer was dropped on every open.

## Red run

`npx vitest run tests/app-ui.test.ts -t "across a server restart"` with the guard reverted to
`if (from && from !== boot && asked < asks)`:

```
× shows an opened chat's first read at once while the read a change notice asked for follows
AssertionError: expected 'OChoose a main assistant: it checks i…' to contain 'Looking in the barn.'
Tests  1 failed | 18 passed | 85 skipped (104)
```

Restored, 19 passed.

## Change

The drop applies only once a read is shown (`boot !== undefined`). The first answer shows at once, and the read the
notice asked for still follows and decides. The existing restart case that dropped the first read now shows it,
then lets the newer boot's read decide, with the same final assertions.

## Checks

`.agents/tools/check-all` passed: typecheck, lint, ruff, 3822 Vitest tests in 209 files, build, 55 e2e tests and
50 Python test files. Not exercised: the change on production, and iOS, which has no such rule.
