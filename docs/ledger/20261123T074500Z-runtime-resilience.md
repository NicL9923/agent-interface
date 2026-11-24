# November 23 multi-runtime resilience

Code state: the working tree on top of `320740c3` on `t3/multi-runtime-resilience`, committed as the
change that adds this entry. Node per `.node-version`. Hermes did not take part; every check runs the
runtime router over fake runtimes that throw on any method a test did not configure.

The change keeps `/bots` up while a second runtime fails, lists that runtime's last roster as
disconnected, marks such answers partial (`src/server/unknown-roster.ts`), and makes every caller that
reconciles, prunes or decides privacy check the mark. It also prefixes other runtimes' event IDs,
refuses made-up assistant IDs with no roster at all, and gives each roster row its runtime's
capabilities.

## Checks

| Check                                                                                          | Result                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck, lint, format check                                                                  | Compiled and passed                                                                                                                                                                                                  |
| `check-all --keep-going`: test                                                                 | 4302 of 4304 passed. The two failures were `tests/models-api.test.ts`, whose fake runtime had no roster and relied on the old gate admitting any ID; its fixture now lists the assistant, and the file passes 6 of 6 |
| `check-all`: build, ruff, py                                                                   | Passed                                                                                                                                                                                                               |
| `check-all`: e2e                                                                               | Chromium 142 passed. WebKit 142 failed to launch: "Host system is missing dependencies to run browsers" on this host. Not run in WebKit                                                                              |
| `tests/runtime-resilience.test.ts`, `tests/runtime-router.test.ts`, `tests/bot-access.test.ts` | Unit-passed: 65 tests                                                                                                                                                                                                |
| iOS contract (`ContractFixtureTests`) for the new `queueManagement` key                        | Not run: needs the Mac mini                                                                                                                                                                                          |

## Mutation runs

Each line below was broken by hand with `~/.agents/tools/mutate.py` against
`npx vitest run tests/runtime-resilience.test.ts tests/runtime-router.test.ts`, and the suite went red:

- Router: Hermes event IDs left unprefixed, the double-prefix guard, the never-answered runtime making
  the roster unknown, the partial marks on the roster and the routine inventory, the all-runtimes-fail
  rethrow, and the failed runtime's rows marked disconnected.
- Bot access: the made-up ID refusal, `routineById` on a partial inventory, `seenOn` without a record,
  `seenOn` for an assistant a complete answer leaves out, and `assertNothingOmittedFor` both ways.
- Callers: assistant creation, main-assistant reconciliation, the routine-room sharing check, the
  badge, the upgrade busy check, Live Activity rows, the unreadable-capabilities fallback, the routine
  list, and the room list.

One survived: in `withBotCapabilities`, reading the last rather than the first assistant of a runtime.
Either reads the same runtime once, so it is equivalent.
