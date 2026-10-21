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
