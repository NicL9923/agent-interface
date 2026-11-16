# November 15 reviewed resend fences

Base `62ea8cb992ad38fd4cd58e1612e98f8fc8df21ae`, Node 24.22.2 on NicolasLaptop. No live Hermes or browser was exercised. PR #347 introduced the before-admission rejection that can settle an earlier uncertain ordinary send after a temporary fence.

The regression runs the real Fastify app, in-memory store, Hermes adapter and transport with a controlled external socket. The fake holds the original send after its connection drops, returns a missing receipt, admits the original without delivering its answer, then returns RPC 5035 to the reviewed resend. A later receipt lookup confirms admission. The fake checks the same native request and rejects unexpected I/O. The original red run used the base plus `tests/hermes-adapter.test.ts` blob `6afc684682d254e6c3b5d77e83a0a43508fe6240`; `npx vitest run tests/hermes-adapter.test.ts -t 'keeps a reviewed send uncertain'` failed because the resend returned `rejected` and the draft-saved message, instead of `uncertain`. Output: `/tmp/reviewed-resend-red.log`.

The two targeted mutations ran at source fingerprint `sha256:ffeaf33e7bad89eaf0a682884f2f2b3ab2428d8f3886d08d70ea4c9b69a92357`. Removing the adapter's `reviewedUncertain` condition, and separately removing route forwarding, each made that regression fail with the same rejected receipt. Files were restored byte for byte. Output: `/tmp/reviewed-resend-mutation-adapter.log` and `/tmp/reviewed-resend-mutation-route.log`. The fixture was subsequently tightened to reject unexpected HTTP calls.

At source fingerprint `sha256:eade9765de264f528d05c1525a2c6ba7353d6a09c88621561830a299575d6302`, `npx vitest run tests/hermes-adapter.test.ts tests/retry-send.test.ts tests/talk-api.test.ts` passed 318 tests in 3 files. `npm run typecheck` and `npm run lint` passed. Output: `/tmp/reviewed-resend-target.log`.

The review flag is sent only to the runtime adapter, not the stored request or the native RPC. The same route handles explicit steers and Talk; Talk does not initiate reviewed resends. The multiuser failed-turn test checks that a reviewed resend keeps the original sender and input. Permanent retry denial remains rejected; fresh ordinary requests retain their original refusal handling. Web and iOS use the shared server contract and were inspected, not run.

The first `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going --skip e2e --py always --lock-timeout 7200` attempt timed out in the machine queue after 7,200 seconds, exit 75. It did not start a check. Output: `/tmp/reviewed-resend-check-all.log`. A retry with a 14,400-second machine queue timeout was started at the same source fingerprint.

The retry passed on commit `e00d2d6e6078bf9f4507c3a96f3de2038f9fb961`, the same source fingerprint. It waited 4,660 seconds for the machine lock and ran for 6 minutes 17 seconds. Typecheck, lint, Ruff, the JavaScript suite (4,066 tests in 221 files), build (896 modules), and Python checks (52 files) passed. Command: `LINUX_HEAVY_LOCK_TIMEOUT=14400 ~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going --skip e2e --py always --lock-timeout 14400`. Output: `/tmp/reviewed-resend-check-all-retry.log`. Browser checks were skipped for the compatible-container validation assigned to the parent.


## Completed browser validation at `c407254ba5fc19bdcb880c895730ff24b2802741`

The compatible Playwright 1.65.0 Noble container with Node 24.22.2 ran
`.agents/tools/check-all --only e2e` through the actual server and browser suites.
All 167 Chromium/WebKit cases passed, with 3 existing skips, in 5 minutes 30 seconds.
Output: the parent worktree's `.private/own-send-resend-checks.log`. The combined job queued
for 8,744.184 seconds and held the machine lock for 351.510 seconds, including the preceding
Linux checks for PR #430. This completes final browser validation for the reviewed-resend
fix; no application or test inputs changed afterward. The earlier full non-browser results
still cover the same source. No live Hermes or physical-device run was performed.
Independent review outside OpenAI remains incomplete. Keep the PR draft until an eligible
reviewer is available. A release is required after merge; no deployment ran.
