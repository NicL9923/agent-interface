# Effect server lifecycle migration

Validated on Nicolass-Mini, macOS, against code at
`3737c162deca28786186323e9deedee6866f9c7a`, based on main
`939225b34263f28bbacfe81225d41084cb0a5716`.

GPT-6.1 Terra implemented the transport, shared helpers and notification worker.
GPT-6.1 Sol coordinated and added shutdown and late-approval regression coverage,
dependency documentation and the qualification manifest entry.

## Scope

Effect 4.0.7 owns socket cleanup, pending RPC responses and timeout fibers, setup
fetch interruption, and keyed worker jobs. Public runtime methods remain
Promise-based. Approval reads can be interrupted; notification delivery drains
before its dependencies close. A transport close returns an uncertain receipt for
a pending submission without resending it. Signal shutdown runs once and has a
30-second deadline.

The integration qualification manifest includes the shared helper. Existing
deployment receipts must match the changed integration digest before release.

## Checks

- Node 26.10.0: `npm test`, 106 files and 1,364 tests passed.
- Node 24.21.0: `npm test`, 106 files and 1,364 tests passed.
- Node 26.10.0: `npm run build` passed on the reviewed code, including the pinned
  tsrs typecheck, Vite client build and service worker generation. The same build
  also passed on Node 24.21.0 before the review fixes at `8aa3781`.
- Python 3.14.7: `npm run test:py`, 32 files passed in 111.2 seconds. Two individual
  suites reported one skipped case each; the runner counts test files separately.
- `ruff check .` and `git diff --check` passed.
- The lockfile retains all five optional tsrs platform packages.

The first full application run caught a missing qualification manifest entry for
`effect-support.ts`. Adding it fixed the failure without excluding the helper from
qualification. Both Node suites above include that fix. The Python run started
before that manifest entry and completed afterward; no Python source changed.

The tests exercise concurrent RPC failure identity, socket listener removal, stale
socket isolation, uncertain admission on close, queued delivery drain, repeated
stop calls, late approval responses, and clean, failed and timed-out signal
shutdown. Effect imports occur only in server modules.

## Manual validation and review

The independent reviewer started the real server against a silent fake Hermes
WebSocket peer and sent SIGTERM on Node 24 and 26. This exposed the clean shutdown
hang described below. After the fix, the reviewer repeated the Node 26 probe and
observed exit code 0 eight seconds after SIGTERM. No browser session, live Hermes execution, physical push
delivery, iOS build or deployment was performed. API and transport tests use local
fakes.

Independent Claude Opus 5.5 review found two defects and one documentation nit.
A clean close could leave the silent WebSocket's TCP handle alive after clearing
the shutdown deadline. Restoring exit code 0 after successful cleanup fixes that.
The job runner could retain a finished fiber for one microtask and lose a requested
outbox pass. Registering the job before starting work and removing it inside the
fiber's finalizer fixes that race. The dependency row now has its own verification
date. Regression tests cover both defects. Opus approved the fixes after a focused
review of `8aa3781..3737c16` and their callers. The rerun regression failed on the
old helper and passed on the fix. Additional probes covered synchronous startup,
failure, interruption, single flight and drain. No remaining findings block the PR.
