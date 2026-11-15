# Clear a legacy push badge from the latest account's page

Base: `62ea8cb9`, latest `origin/main` when this worktree was created.
Source fingerprint: `sha256:df9392e9f309a595d995382a6bc88a2292d00f5e916d19ebbd9f1840ddef97ff`.
Implemented by GPT-6.1 Sol on NicolasLaptop, Node 24.22.2.

Sol's independent review of #342 found that a supported push without an account marker
records an unnamed badge owner. The page's zero count then compares that missing marker
with its own marker and refuses to clear, even though it is the latest account's page.
The stale badge can survive a worker restart and an item resolved on another device.

The worker now permits the latest named account's own page to clear an unnamed owner.
Pages for another account or no account still cannot clear that badge. Named owners,
sign-out clearing and account-generation ordering keep their existing behavior.

## Regression evidence

The new service-worker test sends a real push event without an account marker, verifies
its count is four, and checks that stale-account and signed-out-tab clears leave it four.
It restarts the real worker script over the saved cache and asks the latest account's
page to clear. On the old code no clear happened; the new code calls the browser badge
API and the resulting count is zero.

`npx vitest run tests/service-worker.test.ts tests/service-worker-orderings.test.ts`
passed 139 tests in two files. The latter runs the existing asynchronous ordering checks.
Output: `.private/legacy-badge-green.log`.

Two hand mutations each failed the new regression: restoring the old ownership comparison
prevented the final clear; permitting every page to clear an unnamed owner allowed the stale
tab to clear four to zero. The script restored the worker byte for byte after each run.
Output: `.private/legacy-badge-mutations.log`. `git diff --check` passed and `npm ci` completed.

## Scope and pending verification

Pushes and page messages still share the worker's serial chain. The regression covers
legacy payloads, persisted owner state across restart, stale pages, and latest-page clearing.
The existing suites retain named-owner, sign-out and concurrent account-change cases.
There is no server or iOS contract change; legacy pushes remain supported.

Full check-all and compatible-container browser validation are pending. Independent review
is incomplete because Anthropic is usage-limited and Grok returned HTTP 402 for exhausted
balance. This OpenAI implementation must remain unmerged until eligible review is available.
No browser interaction, production deployment, or Apple build ran for this change.
