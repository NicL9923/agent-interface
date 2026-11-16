# November 16 form reply ownership

Base: `62ea8cb992ad38fd4cd58e1612e98f8fc8df21ae`. The application and test diff at validation has SHA-256 `ee87664ae60b9d54ea14a93a075efe11f2efe1593bab335b480b88beb4d40308` (`git diff --binary -- src tests`). Node 24.22.2. No Hermes service or native device was exercised. Command output is in the session tool transcript.

- Before the fix, `npx vitest run tests/app-ui.test.ts -t 'keeps an accepted form answer'` failed 1 test: the accepted row read `Household member`.
- After the fix, `npx vitest run tests/app-ui.test.ts -t 'form answer|original chat.s form|different answer accepted'` passed 5 tests, with 104 skipped by the filter.
- `npx vitest run tests/form-retry-ui.test.ts tests/sent-echo.test.ts` passed 69 tests.
- `npx vitest run tests/account-transitions-ui.test.ts tests/account-epoch.test.ts` passed 81 tests.
- `npm run typecheck` and `npm run lint` passed.
- Mutation proof: replacing the call to `ownAttempt.current.record(receipt)` with a false guard made the accepted form test fail with `Household member`; 1 failed, 108 skipped. The source was restored byte for byte. The final test edit waits explicitly for the POST before making the same assertion.
- Shared matcher limitation reproduced with `ownSentRows`: two unattributed rows of identical text after the anchor cause the first to be claimed, even if the second was the viewer's. A sender or message ID is needed to disambiguate them. This pre-existing shared behavior is outside this change.

No browser or physical-device acceptance was run. The account guard uses the existing account mark, but an account-switch form regression was not verified. The native iOS form posts through `store.attempt` directly, rather than the central AppStore send path, and has the same ownership gap.
