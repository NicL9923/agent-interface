# November 23 memory and skills service

Code state: `sha256:23e8f9b9bd2c0813d01818fb39dfca241074a36e57c1482b42226fbe9af311f1`
on top of `2ee7ec9a`, recorded by `.agents/tools/source-state.py`. The checks ran on Node
24.22.2 with SQLite 3.53.4 on NicolasLaptop. Hermes did not take part.

- `npm run typecheck && npm run lint && npm run format:check` passed.
- `npx vitest run tests/memory-learning.test.ts` passed, 28 tests. They run the repository on a
  real in-memory SQLite database, the importer on a temporary profile directory with real
  symlinks, and the routes on a real Fastify app with the production auth hook and error handler.
- The first `check-all` run failed the Hermes qualification dependency check because
  `src/shared/api.ts` imported the new `src/shared/memory.ts`. The manifest now lists it.
- The first `check-all` run's browser suite passed all 142 Chromium tests. All 142 WebKit tests
  failed to launch because this host lacks WebKit's system libraries. No client code changed.
- After the manifest change, `check-all --skip e2e --py always` passed typecheck, lint, ruff,
  the full app suite (4,493 tests in 244 files), build, and the Python suite (52 files).

Each mutation below made its targeted test fail. The original sources were restored before the
repository check.

| Mutation                                                   | Failure observed                                      |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| Approve a proposal without checking its base version       | A stale proposal overwrote a newer change.            |
| Undo a revision that is not its item's latest              | Undoing an older revision discarded a later one.      |
| Allow undoing the same revision twice                      | The second undo applied.                              |
| Drop the bot filter from the revision lookup               | Another bot's proposal was approved through this bot. |
| Skip the memory character budget                           | An add past the budget applied.                       |
| Skip the skill count budget                                | A skill past the budget applied.                      |
| Disable the instruction-override guard                     | "Ignore all previous instructions" was learned.       |
| Keep a never-approved item after its proposal is rejected  | The rejected skill stayed in the list.                |
| Follow symlinks out of the Hermes profile                  | The importer read files outside the profile.          |
| Remove the per-review change cap                           | The 21st memory change applied.                       |
| Allow replacing a skill body the reviewer saw only in part | A truncated body was replaced.                        |
| Stop escaping the conversation tag in the review prompt    | Transcript text closed the conversation block.        |
| Let cleaning add entries                                   | The pruner's add was accepted.                        |
| Remove the route's visibility check                        | A private bot's learning answered another member.     |
| Remove the route's roster check                            | An unknown bot answered 200.                          |
