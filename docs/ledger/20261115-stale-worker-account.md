# Drop a stale account word after worker lookup

Base: `62ea8cb9`, latest `origin/main` when this worktree was created.
Source fingerprint: `sha256:91e6d5b66340eca64b683584469acb05b5f0cb1a6ea23f5752efa0569eae30de`.
Implemented by GPT-6.1 Sol on NicolasLaptop, Node 24.22.2.

## P1 finding and fix

Sol's independent review of #330 reproduced an old tab posting its account to the worker
after another tab settled the next account. The per-tab message chain orders only one tab's
messages. A delayed `getRegistration` can therefore overwrite the worker's newer account,
showing the previous account's notifications and suppressing the current account's.

An ACCOUNT post now captures the account record that queued it. After registration resolves,
the post proceeds only if that record still matches. This check uses the shared record, so it
does not depend on the old tab having processed a storage event or updated its local generation.
Capturing only a local generation would not catch this reproduced sequence.

Only ACCOUNT words are bound through the internal optional post argument. Generic ordered
messages retain their existing behavior and port replies, including BADGE. Each account entry
point still calls the same `tellWorker`; its own settlement may advance the local generation
while its shared record remains current, so current account words continue to post.

## Regression and checks

The new test loads two independent copies of the real account module with shared browser
storage and worker I/O. Tab one's registration lookup waits. Tab two settles and posts its
account, then tab one's lookup resumes. On the old code the worker received two, then one.
With the fix it receives only two and storage still names two.

- Account and account-transition UI suites passed 82 tests in two files.
- The app-badge suite passed 14 tests, including its ordered-worker message contract.
- Removing the post check and separately omitting the captured record each made the new test
  fail with the stale account-one post. Source bytes were restored after each mutation.
- `npm ci` and `git diff --check` completed.

Logs: `.private/stale-worker-red.log`, `.private/stale-worker-green.log`,
`.private/stale-worker-badge.log`, and `.private/stale-worker-mutations.log`.

Full local validation is recorded below. Independent review is
incomplete: Anthropic is weekly-limited and Grok returned HTTP 402 for exhausted balance.
This OpenAI implementation remains unmerged until eligible review is available.

The separate concurrent-auth-request cookie race in #330 is being fixed separately. This change
does not serialize authentication requests or fix #333's late logout CSRF cleanup.
No production or Apple-platform operation ran for this fix.

## Full local validation at `2b959334`

The coordinated check-all run passed typecheck, lint, ruff, 4,065 Vitest tests and build.
Python was automatically skipped because the changed files do not affect those tests.
The real Chromium and WebKit suites passed 167 cases with 3 existing capability skips.
The browsers ran in the Playwright 1.65.0 Noble container with Node 24.22.2 because
Fedora lacks the host libraries required by WebKit. The outer Linux machine lock covered
the full job. Output: the coordinating worktree's `.private/review-fix-checks.log`.

This local runtime validation does not replace independent review, which remains incomplete.
Before publication, main's separately reviewed compaction-test change #433 was merged.
The production and regression-test files described above are unchanged by that merge.


## GPT review P1: preserve the signed-out word after cleanup

Nicolas explicitly authorized GPT review and merging for this round. GPT-6.1 Sol high
reviewed head `8b4c351ca2905d2de0b9a8584db2a9b5e6649286` and reproduced one P1:
a page starts with pending logout and queues ACCOUNT(null) behind a held registration
lookup. Cleanup gets bootstrap 401, then signOutFinished rewrites the record. The guard
drops the old ACCOUNT(null), but no replacement was queued. The worker retains the old
account and badge and displays that account's next push. The same replay on the merge
base clears the worker and suppresses the push.

Main `325c54758400e6092b76232ef65dc1878df44b9b`, including the reviewed auth fix, was
merged normally in `e174bf5dba62ebc834c6d422b9b5de980b8eb60d` before this follow-up.
No published history was rewritten. The production/test diff from that merge has SHA-256
`b4ab4cc488f371e828e5c0129988317738777e3e2cede82b4d054d96ad3246b7` over src/app/account-epoch.ts and tests/account-operation.test.ts.

signOutFinished now forces a fresh ACCOUNT(null) bound to its rewritten record. Normal
per-account deduplication remains, and the queued record check still rejects stale words.
This is a private tellWorker option; it changes no persisted record or wire format.

The real account-operation/client API regression holds only registration I/O, returns
bootstrap 401, performs actual cleanup, then releases registration. Before the fix it
failed because only BADGE(null,0) arrived. After the fix it receives ACCOUNT(null) before
that badge. Logs: `.private/signed-out-word-red.log` and `.private/signed-out-word-green.log`.
All 116 account-operation, account-epoch, account-transition UI and app-badge tests passed;
typecheck, lint and diff checks passed. Removing the replacement call, or restoring the
old unconditional deduplication, independently fails the new regression. Source bytes were
restored after each mutation. Log: `.private/signed-out-word-mutations.log`.

The review's real account/client/worker replay was also run against the working source.
It persisted signed-out worker state, cleared the badge and suppressed the old account's
push. The probe compares cross-realm posted data as wire values; its initial extra strict
prototype comparison was corrected without changing the behavioral assertions. Probe and
result: `.private/signed-out-word-replay.mjs` and `.private/signed-out-word-replay.log`.
The original review replay/result remain at `/tmp/pr437-review/repro.mjs` and `repro.log`.

A scoped GPT re-check and final-source full validation remain required before merging.
The original #330 label remains until this fix merges; sibling auth fix #429 has merged.
A production release is still required after merge; none ran.
