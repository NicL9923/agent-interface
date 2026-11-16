# Account authentication operation serialization

Base: `62ea8cb992ad38fd4cd58e1612e98f8fc8df21ae`. The source, test and README diff, excluding this ledger, has SHA-256 `caf01674bfc27f353f05239b766cce3ea2800d1229b141145fe0f72b56a4542f`, from `git diff --cached --binary -- README.md src/app/account-change.ts src/app/account-epoch.ts tests/account-operation.test.ts | sha256sum`.

- On the base code, `npx vitest run tests/account-operation.test.ts` failed because both sign-ins reached fetch before the first returned. The test uses two separately imported module graphs and shared storage, locks and cookie effects.
- On the previous test fingerprint `bf55f43b2297b644989a0cd5214744b4df8389baee54a2aa610af4c10399ba85`, `npx vitest run tests/account-operation.test.ts tests/account-epoch.test.ts tests/account-transitions-ui.test.ts tests/saved-roster-ui.test.ts` unit-passed 171 tests in four files. `npm run typecheck` compiled and `npm run lint` passed.
- On the current fingerprint, `npx vitest run tests/account-operation.test.ts` unit-passed 11 tests after tightening the two-tab setup.
- Removing the conditional CSRF cleanup made the offline logout regression fail because the new token was cleared. Removing the era comparison made the failed-sign-in regression fail for the same reason. Removing the pending-logout recheck made the queued logout regression fail because it sent a bootstrap after sign-in. The original files were restored after each mutation.

The initial Web Locks fake modeled exclusive queues, not browser process shutdown or delayed localStorage replication. That implementation retained an immediate no-lock fallback and could not serialize that case. The compatibility decision and fix below supersede that fallback. Storage that rejects writes still cannot propagate account changes. The separate service worker message race is handled in #437. No browser acceptance ran on the initial state. Independent review remains incomplete because eligible providers are unavailable.

- On commit `231c85bb8d5f33400c104aaae2b6c5f2437dcade`, `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going` exited 75 after 7,200 seconds waiting for the machine-wide lock. No checks in that run started. The complete source and browser battery remains unverified and needs a subsequent run; the compatible WebKit container is available to the parent. Output: `/tmp/agent-auth-check-all.log` on NicolasLaptop.


## Required Web Locks and device-only sign-out

Nicolas explicitly chose to require Web Locks for browser account changes, while preserving
device-only sign-out. The coordinator implemented this OpenAI follow-up in commits
`0536c4ad` (tests and browser I/O fixtures) and `383d5b4e` (application policy).
The latest main, `a2f25ad0d5998c4e3b0fd0397564b4459ad05855`, was then merged in `0bcc5ee7b82e2d46483edc28c398205f83a4ab69`.
It added bot-exchange display and previously validated test changes; the five policy production
files are byte-identical before and after that merge. The full source/test/README diff against
that main, excluding this ledger, has SHA-256 `e9622bf2b4c45300f7ef14c5e023568060abdd5ab780ce4cdcf2d7b9765f9737`.

Cookie-changing sign-in, server sign-out and pending-logout cleanup now stop before fetching
if Web Locks are unavailable. A denied lock still propagates its refusal; there is no unsafe
fallback. Sign-in explains the requirement before collecting local or Google credentials.
Supported browsers retain the operation-wide lock, separate from the record lock.

Settings explicitly offers device-only sign-out without Web Locks. The kept local record is
required before saved data is removed. A storage failure leaves the account signed in and
shows the explanation. Only this device-only confirmation closes on choice, so a refusal is
visible on Settings; supported server sign-out retains its prior confirmation behavior.
The pending mark blocks use of the still-live server cookie until safe cleanup is possible.

The first real-browser check found one bootstrap prefetch after device-only sign-out and
reload, despite the bundle correctly refusing cleanup. The classic boot.js now skips both
bootstrap and linked-chat prefetch, and skips the old theme, for pending logout. This includes
an abandoned changing mark carrying logout. Its existing flag tolerance matches account-epoch;
a completed sign-out or a logout flag without a pending account state keeps the normal read.
The handoff version and all server/native API contracts are unchanged.

### Regression and mutation evidence

- Before the policy guard, the missing-lock cookie-change and pending-cleanup tests failed
  because fetch was reached. Device-only sign-out remained a positive control.
- The initial unsupported sign-in UI tests failed before the credential gate; both local
  and Google configurations now explain the problem without starting an auth POST.
- Both pending-logout startup tests failed on old boot.js because a bootstrap read started.
  The negative cases retain reads when logout is not owed.
- The original CSRF tests simulated concurrent authentication with no locks. That path is
  intentionally refused now, so they instead settle or undo the real public account-record
  operation while the old logout is held. Assertions on the newer token and transport remain.
- One late-bootstrap mutation initially survived: the test changed generation, so the API
  rejected the response before the explicit guard. The test now advances the era and undoes
  the record, keeping the generation; removing the explicit guard then fails it.
- Ten distinct mutations were caught: missing-lock fallback, local-only exception, conditional
  CSRF clear, era comparison, late-bootstrap guard, device-only UI routing, credential UI gate,
  pending-logout prefetch guard, overbroad logout-only guard, and theme eligibility. Each file
  was restored byte for byte. Logs: `.private/auth-required-mutations.log`,
  `.private/auth-required-mutations-followup.log`, and `.private/auth-final-mutations.log`.

### Validation at `0bcc5ee7b82e2d46483edc28c398205f83a4ab69`

Nine focused account, app, preferences, startup and affected minute-clock suites passed
295 tests. Typecheck, lint, build and diff checks passed. Log:
`.private/auth-required-after-main.log`. The earlier six-file policy run passed 268 tests.

Manual browser acceptance used real Chromium and the real Fastify e2e server with its scripted
Runtime. A normal Web Locks sign-in succeeded. The same browser then had Web Locks availability
removed at the navigator boundary to exercise unsupported-browser behavior. Device-only sign-out
and reload kept the pending mark, removed account content, preserved the server cookie, issued
zero auth POSTs and zero private bootstrap reads, and kept sign-in disabled with its explanation.
Desktop 1200 px and phone 390 px layouts were exercised; the phone dialog fits without overflow.
Screenshots are `.private/auth-device-signout-desktop.png`, `.private/auth-device-signout-phone.png`,
and `.private/auth-browser-required-phone.png`. Result: `.private/auth-browser-final.json`.
The pre-boot-guard result and source hashes are in `.private/auth-browser-before.json`.
The owned browser and fixture server were closed after acceptance.

The full check-all and Chromium/WebKit battery on the published follow-up remain pending.
Earlier c1accf27 checks cannot validate this new policy. Both implementers are OpenAI, so
eligible non-OpenAI independent review is still required before merge. No Apple or physical-device
validation was needed for this web-only change. No production deployment ran; a release is needed
after merge.


### CI correction for the simulated closed tab

At `e545abd3ae047bae5d064b04fff307e3fec54565`, CI passed 4,101 tests and failed
one saved-roster test on both Node versions. The test unmounted React while leaving its
jsdom document and the hung sign-in's fake auth lock alive, then treated that document as
a new page. The actual browser releases locks when the old document closes, as specified
in https://www.w3.org/TR/web-locks/#termination.

A real Chromium probe confirmed that the second page stays queued while the first owns
a never-settling lock, then acquires it after the first page closes. Both pages had no
remaining locks afterward. Output: `.private/auth-lock-close-browser.log`, replay script:
`.private/auth-lock-close-probe.js`. The owned browser and loopback server were closed.

The test now replaces the browser-lock I/O fake at the simulated tab close. Its hung fetch
and every original storage, request and privacy assertion remain. The original test still
failed before this fixture correction. Removing pending-logout propagation then made the
corrected test fail, showing that the original security regression remains covered.
Outputs: `.private/auth-closed-tab-red.log`, `.private/auth-closed-tab-mutation.log`.

After the correction, all 179 tests in the four account-operation, account-epoch,
account-transitions and saved-roster suites passed. Typecheck, lint and diff checks passed.
Output: `.private/auth-closed-tab-account-green.log`. Application code is unchanged from
e545abd3. The queued old-head full check was canceled before acquisition or any test execution;
a final-head full check replaces it. Independent review remains incomplete.
