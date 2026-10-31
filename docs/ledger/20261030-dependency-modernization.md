# Dependency modernization validation

Base: c7bad480e3f090fefc7e9c23807068f9d3466033. This record applies to the dependency and configuration changes in the commit containing it. Tests ran on macOS arm64; temporary Python test data used DevSSD.

- Node 24.22.2 and 26.13.0: `npm test` passed 1,531 tests in 107 files and `npm run build` passed on each.
- Node 24.22.2: `npm ci` passed. All required macOS arm64 and Linux GNU/musl tsrs packages remain in the lockfile.
- Ruff 0.17.3: `ruff check .` passed.
- npm audit reports three moderate advisories in glob/minimatch through @fastify/static. Its suggested forced fix downgrades the direct dependency; no forced override was applied.
- The Python spike lock records a real host environment and was not rewritten. CI Python remains 3.14.7 to match that host.
- Python 3.14.7: `npm run test:py` passed 32 test files, with individual test skips noted by the runner. The initial run used internal temporary storage and failed the free-space guard; the SSD-backed run passed.
- `git diff --check` passed.
