# November 16 form reply ownership

Base: `62ea8cb992ad38fd4cd58e1612e98f8fc8df21ae`. The application and test diff at validation has SHA-256 `ee87664ae60b9d54ea14a93a075efe11f2efe1593bab335b480b88beb4d40308` (`git diff --binary 62ea8cb992ad38fd4cd58e1612e98f8fc8df21ae ffdd53f801a0720e06f945b880875dcb3910d347 -- src tests`). Node 24.22.2. No Hermes service or native device was exercised. Command output is in the session tool transcript.

- Before the fix, `npx vitest run tests/app-ui.test.ts -t 'keeps an accepted form answer'` failed 1 test: the accepted row read `Household member`.
- After the fix, `npx vitest run tests/app-ui.test.ts -t 'form answer|original chat.s form|different answer accepted'` passed 5 tests, with 104 skipped by the filter.
- `npx vitest run tests/app-ui.test.ts` passed all 109 tests at `ffdd53f801a0720e06f945b880875dcb3910d347`.
- `npx vitest run tests/form-retry-ui.test.ts tests/sent-echo.test.ts` passed 69 tests.
- `npx vitest run tests/account-transitions-ui.test.ts tests/account-epoch.test.ts` passed 81 tests.
- `npm run typecheck` and `npm run lint` passed.
- `npm run build` built the web bundle and service worker at `ffdd53f801a0720e06f945b880875dcb3910d347`.
- `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going` at that source state passed typecheck, lint, Ruff, 4,069 tests in 221 files, and the 896-module build. The browser run passed 85 and failed 85 WebKit tests at launch because this host lacks `libicu74` and `libjpeg-turbo8`; Python was skipped because no Python inputs changed. Logs: `/home/nic/.cache/agent-interface/check-all/logs/20261115T201117-4179788-t3-af0fd3be-79fcd596fc952beb/`. The machine lock wait was 64 minutes; the check ran for 3 minutes 27 seconds.
- Main advanced to `cf3c9688f3cef983db79baf1b9254932bd987466` during that wait. Merge `4dc0610d328c1cb0fc881d64380e589fd3d6cd63` changed three UI test files, one Python test, and ledger documents, but no production source or dependencies. On the merge, the three changed UI suites passed 23 tests and `python3 scripts/run-python-tests.py tests/hermes_compaction_test.py` passed 1 file. The earlier source checks still cover the same production code.
- Mutation proof at `ffdd53f801a0720e06f945b880875dcb3910d347`: replacing the call to `ownAttempt.current.record(receipt)` with a false guard made the accepted form test fail with `Household member`; 1 failed, 108 skipped. The source was restored byte for byte.
- Shared matcher limitation reproduced with `ownSentRows`: two unattributed rows of identical text after the anchor cause the first to be claimed, even if the second was the viewer's. A sender or message ID is needed to disambiguate them. This pre-existing shared behavior is outside this change.
- Recall limitation reproduced with `ownSentRows` and `ownPrompts`: an unattributed steer can be claimed for display while `ownPrompts` returns no entry, because recall requires a sender ID. This affects existing composer sends too and is outside this change.

No browser or physical-device acceptance was run. The account guard uses the existing account mark, but an account-switch form regression was not verified. The native iOS form posts through `store.attempt` directly, rather than the central AppStore send path, and has the same ownership gap.
