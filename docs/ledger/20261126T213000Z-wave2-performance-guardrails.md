# Wave 2: Mechanical Performance Guardrails

- **Date:** 2026-11-26
- **Branch:** `t3/wave2-performance-guardrails`

## Summary

- Enabled Oxlint 1.94 `react` plugin and promoted `typescript/no-floating-promises`, `typescript/no-misused-promises`, `react/rules-of-hooks`, `react/exhaustive-deps`, `react/jsx-no-constructed-context-values`, `react/no-unstable-nested-components`, `react/no-array-index-key`, `react/no-deriving-state-in-effects`, `react/no-object-type-as-default-prop`, `react/set-state-in-render`, `react/use-memo`, `react/error-boundaries`, and `react/static-components` to `error`, fixing all violations cleanly across `src/` with zero inline suppressions.
- Migrated `vite.config.ts` from deprecated `build.rollupOptions` to `build.rolldownOptions` with `output.codeSplitting.groups` for `vendor-react` and `vendor-markdown`, isolating long-lived vendor chunks from app deploys while preserving lazy `@base-ui/react`, `@novnc/novnc`, and `@xterm/xterm` invariants.
- Added `scripts/chunk-cycle-guard-plugin.mjs` wired into `vite.config.ts` to fail builds on circular static chunk imports or banned heavy packages (`@novnc/novnc`, `@xterm/xterm`, `highlight.js`) leaking into `index.html`'s static entry closure.
- Added zero-extra-build gzip bundle budget enforcement (`scripts/check-bundle-budget.mjs` + `scripts/bundle-budget.json`) invoked inside `scripts/build-worker.mjs` before `.vite/` cleanup.
- Wrapped non-urgent `showView` and `openPanel` updates in `src/App.tsx` with `startTransition`.

## Red Runs

1. Disabled cycle detection (`status === 1`) in `scripts/chunk-cycle-guard-plugin.mjs` -> `tests/chunk-cycle-guard.test.ts` failed 3/7 tests (2-chunk cycle, 3-chunk/self cycle, plugin `generateBundle` cycle test). Restored and re-verified 7/7 green.
2. Disabled banned-package regex match (`regex.test(moduleId)`) in `scripts/chunk-cycle-guard-plugin.mjs` -> `tests/chunk-cycle-guard.test.ts` failed 3/7 tests (direct entry leak, transitive entry leak, Rolldown `moduleIds` leak). Restored and re-verified 7/7 green.
3. Disabled total gzip ceiling check in `scripts/check-bundle-budget.mjs` -> `tests/bundle-budget.test.ts` failed 1/5 tests (`throws a clear error naming every target and metric that exceeds its gzip ceiling`). Restored and re-verified 5/5 green.

## Verification

- `npm run verify:ci` — all 5 checks passed (`lint`: 0, `format:check`: 0, `typecheck`: 0, `build`: 0, `test`: 255 files / 4,256 tests passed).
- `npm test -- tests/chunk-cycle-guard.test.ts tests/bundle-budget.test.ts tests/precache-plan.test.ts --sequence.shuffle.files --sequence.seed=731 --maxWorkers=1` — 3 files / 24 tests passed.
