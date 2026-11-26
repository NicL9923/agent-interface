# November 26 pnpm migration (`npm` → `pnpm@11.16.0`)

Switched package management, lockfile, scripts, GitHub Actions workflows, release archiving, `deploy.py`, and `.agents/tools/check-all` from `npm` (`package-lock.json`) to `pnpm` (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, pinned via `packageManager: "pnpm@11.16.0"`). Bun 1.4.5 remains the production server bundler and runtime (`--no-install`).

Toolchain: Node v24.22.2, pnpm 11.16.0, Bun 1.4.5, Ruff 0.17.3, Python 3.15.2, podman (`mcr.microsoft.com/playwright:v1.65.0-noble`).

## Key details

- `pnpm-lock.yaml` retains all eight optional `@tsrs/*` platform binaries (macOS arm64/x64, Linux x64/arm64 GNU/musl, Windows x64/arm64).
- `pnpm-workspace.yaml` records `allowBuilds: { esbuild: false }` so pnpm 11 exits cleanly without running `esbuild` postinstall scripts.
- `tests/web-push-wire.test.ts` loads `http_ece` from `web-push`'s dependency graph via `createRequire(import.meta.resolve("web-push"))` instead of relying on npm hoisting.
- `playwright.config.ts` and `check_all.py`'s podman WebKit step invoke `./node_modules/.bin/tsx` and `./node_modules/.bin/playwright` directly, so WebKit runs cleanly in `mcr.microsoft.com/playwright:v1.65.0-noble` without `pnpm` installed inside the container.
- `.github/workflows/checks.yml` and `.github/workflows/audit.yml` install the exact `packageManager` version into `$RUNNER_TEMP/pnpm` and cache the pnpm store with pinned `actions/cache` (no third-party actions).

## Red runs

Run via `python3 .agents/tools/mutate-py.py`:

| Mutation                                                                              | Result                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `.agents/tools/check_all.py`: `if not has_version:` → `if False:`                     | `failed: test_an_unreadable_lockfile_is_refused_not_crashed_on (exit 1)`              |
| `.agents/tools/check_all.py`: `optional_snaps.add(current_snap)` → `pass`             | `failed: test_drift_cases (exit 1)`                                                   |
| `scripts/deploy.py`: `pnpm install --frozen-lockfile` → `npm ci --no-audit --no-fund` | `failed: test_deploys_release_writes_previous_assets_json_and_flips_symlink (exit 1)` |

## Verification

- `.agents/tools/check-all --py always`:
  - `typecheck`: pass (0.6s)
  - `lint`: pass (0.8s)
  - `ruff`: pass (0.0s)
  - `test`: pass (13.5s, 250 files, 4201 tests)
  - `build`: pass (1.2s, 912 modules)
  - `e2e:chromium`: pass (5m31s, 202 tests)
  - `e2e:webkit (podman)`: pass (7m26s, 202 tests, 3 skipped)
  - `py`: pass (3m17s, 11 files)
- `pnpm run build:server:bun && pnpm run smoke:bun`: Bun 1.4.5 smoke passed.
- `pnpm audit --prod`: no known vulnerabilities found.
- Release archive build (`python3 .agents/tools/archive-release.py` → extract → `pnpm install --frozen-lockfile && pnpm run build`): passed.
