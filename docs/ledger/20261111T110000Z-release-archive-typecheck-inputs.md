# Release archive ships what the typecheck reads

The production release of 6975080a stopped in `prepare`. The host build failed with
`tests/e2e-ports.test.ts(8,17): error TS2307: Cannot find module '../e2e/ports'`.
`tsconfig.json` includes `e2e`, but `archive-release.py` did not ship it. The archive also
left out `playwright.config.ts`. This is the second break of this kind, after
`native-computer.html` on Oct 25.

## Change

- `archive-release.py` now ships every path in `tsconfig.json`'s `include`, so a new
  type-checked directory ships without editing the tool.
- The CI job "Release archive builds" archives the checkout, extracts it, and runs
  `npm ci && npm run build` inside it, as the host does.

## Red and green, on Linux at 6975080a

| Archive | `npm run build` in the extracted tree |
| --- | --- |
| Old tool | exit 2, the same TS2307 error as the host |
| New tool | exit 0 |
