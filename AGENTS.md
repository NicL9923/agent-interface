# Stack

- Node and npm versions follow `.node-version` and `package.json`.
- React uses Vite for the web build. The Fastify server runs TypeScript through tsx.
- `npm run typecheck` uses the exactly pinned Oxc tsrs with `tsconfig.json`.
  `npm run build` runs the same no-emit check before Vite and the service-worker build.
- Keep TypeScript 7.0.2 available for compiler comparisons and rollback. This
  migration does not change runtime transpilation or emitted JavaScript tooling.
- Keep all optional tsrs macOS arm64 and Linux x64/arm64 GNU/musl packages in
  `package-lock.json`; macOS-only lockfile regeneration must not drop Linux binaries.
- See `docs/Dependencies.md` for the tool choice and `README.md` for validation.
- Before calling work done, run `.agents/tools/check-all`. Use `npm ci` per worktree, never a symlinked `node_modules`.

# CI

- GitHub Actions runs `Checks` on every PR and push to main, the weekly dependency audit, and the
  manual iOS UI workflow. Nicolas re-enabled it on November 14, 2026 because this repository is
  public, so GitHub's standard hosted runners are free.
- Use only standard GitHub-hosted runners. Never add a larger runner, a self-hosted runner, or a
  third-party runner service. `tests/workflows.test.ts` fails on any other `runs-on` label.
- The repository allows only GitHub-owned actions pinned to a full commit SHA; the same test
  checks that before a push does.
- CI does not replace `check-all`: the Mac mini still runs the native iOS checks, and CI never
  runs the `scripts/spike/*` probes that host qualification runs.

# Staged checks

- `npm ci` installs the pre-commit hook in Git checkouts. It runs Oxlint and Oxfmt on staged JavaScript/TypeScript, Prettier on staged data and prose, and the pinned Ruff on staged Python. Release archives skip hook installation.
- `npm run verify:ci` runs lint, typecheck, build and Vitest concurrently and waits for every result. Browser tests run on main pushes and manual runs, never PR CI.
- Vitest defaults to `isolate: false` for Node units. The browser integration project and named socket/clock contracts retain file isolation after shuffled runs demonstrated retained lazy-module mocks and dependency timers across files. `vitest.config.ts` lists the exceptions. The first setup file clears app module caches for reused workers. Replay file order with `npm test -- --sequence.shuffle.files --sequence.seed=731 --maxWorkers=1`.

# Tests

The global Testing rules apply in full. The ones this repo has tripped on, restated:

- Server tests run the real Fastify app with the in-memory store and a fake
  runtime that throws on any method the test did not configure. UI tests mock
  only the client API module. The kept exceptions are `preparePortrait`, which
  needs an image decoder and canvas that jsdom lacks, and the retired chunks in
  `view-failure`, which cannot fail to load from disk. Python tests use temp
  directories and fake executables on PATH, never patched private methods of
  the code under test.
- Every validation guard and every decision table gets bad-input and
  cross-state cases, not just the path through. Upgrade restore-or-restart,
  delivery pruning, and live-activity filters are the past misses.
- Middleware and gates that enforce a security boundary (service auth, bot
  access, routine room visibility) have offline tests for every rejection
  branch and the reason they return.
- Per-variant `it.each` over cases that exercise the same branch is noise.
  One smoke case plus specific assertions beats fifty "the SVG changed" cases.
- A test written to protect a specific line is broken by hand once to prove it
  goes red before it is committed. Record the run in `docs/ledger/`.
- Python red runs go through `python3 .agents/tools/mutate-py.py`. It clears the stale
  bytecode that a hand edit and `git checkout` leave behind, and restores the file byte for byte.

# Production host

- Read Hermes source on the production host with `cat`, `sed` or `grep` only.
  Never run `git` in its Hermes checkout (`~/.hermes/hermes-agent`), not even
  `git log` or `git show`. It is a `tree:0` partial clone: a history command
  fetches missing objects lazily and can start an automatic repack, and the
  host's git 2.43 drops objects from such a repack. Release qualification then
  fails on the missing objects. This happened on October 14 and again on
  November 9, when a reviewer's history read removed 42 objects and blocked a
  release until they were restored. Read history from a local clone of
  upstream instead.
