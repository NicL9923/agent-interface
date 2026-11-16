# Account authentication operation serialization

Base: `62ea8cb992ad38fd4cd58e1612e98f8fc8df21ae`. The source, test and README diff, excluding this ledger, has SHA-256 `caf01674bfc27f353f05239b766cce3ea2800d1229b141145fe0f72b56a4542f`, from `git diff --cached --binary -- README.md src/app/account-change.ts src/app/account-epoch.ts tests/account-operation.test.ts | sha256sum`.

- On the base code, `npx vitest run tests/account-operation.test.ts` failed because both sign-ins reached fetch before the first returned. The test uses two separately imported module graphs and shared storage, locks and cookie effects.
- On the previous test fingerprint `bf55f43b2297b644989a0cd5214744b4df8389baee54a2aa610af4c10399ba85`, `npx vitest run tests/account-operation.test.ts tests/account-epoch.test.ts tests/account-transitions-ui.test.ts tests/saved-roster-ui.test.ts` unit-passed 171 tests in four files. `npm run typecheck` compiled and `npm run lint` passed.
- On the current fingerprint, `npx vitest run tests/account-operation.test.ts` unit-passed 11 tests after tightening the two-tab setup.
- Removing the conditional CSRF cleanup made the offline logout regression fail because the new token was cleared. Removing the era comparison made the failed-sign-in regression fail for the same reason. Removing the pending-logout recheck made the queued logout regression fail because it sent a bootstrap after sign-in. The original files were restored after each mutation.

The Web Locks fake models exclusive queues, not browser process shutdown or delayed localStorage replication. With no Web Locks the existing immediate fallback remains, and cannot serialize authentication across tabs. Storage that rejects writes also cannot propagate account changes. The separate service worker message race is outside this change. No human or browser manual test was run. Independent review is incomplete because the eligible providers are unavailable.

- On commit `231c85bb8d5f33400c104aaae2b6c5f2437dcade`, `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going` exited 75 after 7,200 seconds waiting for the machine-wide lock. No checks in that run started. The complete source and browser battery remains unverified and needs a subsequent run; the compatible WebKit container is available to the parent. Output: `/tmp/agent-auth-check-all.log` on NicolasLaptop.
