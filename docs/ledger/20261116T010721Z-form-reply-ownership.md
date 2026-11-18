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

## Coordinator follow-up: uncertain acceptance after a chat remount

GPT-6.1 Sol reproduced a missed path at `aea70c8a`: send a form, receive an uncertain
receipt, switch chats, then reopen the original chat after acceptance. The form's local
ownership callback was gone, so the accepted anonymous row read "Household member".
The new real-App regression failed with that exact label before the follow-up fix.

The app now keeps callbacks by request ID while a form is unresolved. Each callback keeps
the original anchor and account mark. A remounted form settles the same callback, and a
terminal receipt removes it. Registration still occurs only after request-ID generation
and its account check. A receipt known to belong to another copy does not record ownership,
including when the receipt has no text. These callbacks remain in memory for this account's
mounted app, as the existing own-send list does. This adds no persisted data or server contract.

At source diff fingerprint `sha256:96cf22d7900b8d1186291e879a23f3a6108dc72ffbcc7e0b251d5f78f186d01f` from
`git diff --binary aea70c8a -- src tests`, the app, form retry, sent-echo and account suites
passed 262 tests in five files. Typecheck, lint and diff checks passed. Logs are in
`.private/form-reopen-red.log`, `.private/form-reopen-green.log`,
`.private/form-account-green.log`, `.private/form-conflict-green.log`, and
`.private/form-followup-mutations.log`.

Three individual mutations failed their respective tests: dropping a remounted form's
receipt, removing the account check after the real crypto digest, and recording an accepted
conflicting receipt despite its ownership flag. Source bytes were restored after each run.
The account test holds only the WebCrypto I/O result, changes the account record, then resumes;
it verifies that the old answers never reach the message POST. This supplies the form-specific
account-switch regression missing from the initial validation.

The earlier full 4,069-test run applies to the earlier implementation only. Full local and
Chromium/WebKit validation must run on this follow-up. Both implementers are OpenAI, so
independent review outside OpenAI remains incomplete. Native forms still bypass AppStore
send bookkeeping, a pre-existing native gap outside this web-only diff. No Apple validation
or production deployment ran.

## Final full validation at `1f179b27f737e37f684688e0fe8af14cfa39d8d4`

The Linux machine lock queued for 6,705.243 seconds; the combined check executed for
348.624 seconds. `.agents/tools/check-all --skip e2e --keep-going` passed typecheck,
lint, Ruff, all 4,072 JavaScript tests in 221 files, and the 896-module build. Python
was correctly skipped because no Python input changed against main.

The subsequent Playwright 1.65.0 Noble container ran the real Chromium/WebKit suite
through `.agents/tools/check-all --only e2e` with Node 24.22.2. It passed 167 cases,
with 3 existing skips, in 5 minutes 30 seconds. This replaces the earlier host WebKit
launch failures as the final browser result. Output: `.private/form-ownership-check-all.log`.
All five GitHub CI checks also passed at this source commit. A ledger-only commit does
not change the inputs these checks covered.

Independent non-OpenAI review remains incomplete; the PR stays draft. The native form
limitation and lack of physical-device or manual acceptance remain as recorded above.
A production release is required after merge; none ran.
