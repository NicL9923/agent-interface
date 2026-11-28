# Stack

- Node and npm versions follow `.node-version` and `package.json`.
- React uses Vite for the web build. The Fastify server runs TypeScript through `tsx`.
- `npm run typecheck` uses the pinned Oxc `tsrs` with `tsconfig.json`; `npm run build` runs
  the same no-emit check before Vite and the service-worker build.
- Keep TypeScript 7.0.2 available for compiler comparisons and rollback, and keep all
  optional `tsrs` macOS arm64 and Linux x64/arm64 GNU/musl packages in `package-lock.json`
  (macOS-only lockfile regeneration must not drop Linux binaries).
- See `docs/Dependencies.md` for tool choices and `README.md` for validation.

# Repo-specific testing rules

- Server tests run the real Fastify app with the in-memory store and a fake runtime that
  throws on unconfigured methods; UI tests mock only the client API module; Python tests
  use temp directories and fake executables on `PATH`.
- Past guard/boundary misses to keep covered: upgrade restore-or-restart, delivery pruning,
  live-activity filters, and offline rejection-reason tests for service auth, bot access,
  and routine room visibility.
- Record mutation/verification runs in `docs/ledger/`.
