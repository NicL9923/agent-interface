# Dependency modernization validation

Base: c7bad480e3f090fefc7e9c23807068f9d3466033. The test results below apply to implementation head 341030eb326ffc7807d1e3c4854a361a9c8aaca8. The subsequent review fixes change documentation only, so those results remain applicable. Tests ran on macOS arm64; temporary Python test data used DevSSD.

- Node 24.22.2 and 26.13.0: `npm test` passed 1,531 tests in 107 files and `npm run build` passed on each.
- Node 24.22.2: `npm ci` passed. All required macOS arm64 and Linux GNU/musl tsrs packages remain in the lockfile.
- Ruff 0.17.3: `ruff check .` passed.
- npm audit reports three moderate entries through @fastify/static. The affected glob 13.0.6, minimatch 10.2.6 and brace-expansion 5.0.12 versions are unchanged from the base. The reviewed advisories are [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). The app uses the plugin's default wildcard handling, so its glob enumeration branch is unused; that branch uses a constant pattern and passes no AbortSignal. Reassess if the configuration or dependency path changes. Plugin 10.1.8 requires glob ^13, while fixed glob 14.0.3 and minimatch 11.0.3 fall outside that supported tree. The suggested forced fix downgrades the plugin to 6.12.0; no forced override was applied. Track the supported upstream fix in [issue #210](https://github.com/NicL9923/agent-interface/issues/210).
- The Python spike lock records a real host environment and was not rewritten. CI Python remains 3.14.7 to match that host.
- Python 3.14.7: `npm run test:py` passed 32 test files, with individual test skips noted by the runner. The initial run used internal temporary storage and failed the free-space guard; the SSD-backed run passed.
- `git diff --check` passed.
- Claude Opus 5.5 independently reviewed the full base-to-341030e diff and found no merge blockers. Follow-up documentation records the production runtime prerequisite, corrects the tested Node versions, restores SQLite version evidence, and expands the audit disposition.
- The production app's last documented runtime is Node 24.21.0, outside the updated engine range. Verify and update its app-specific runtime to 24.22.2 before the next release, tracked in issue #210. No production runtime was inspected or changed in this work.
- Follow-up SQLite queries on the tested binaries returned 3.53.4 for Node 24.22.2 and 3.54.0 for Node 26.13.0.
