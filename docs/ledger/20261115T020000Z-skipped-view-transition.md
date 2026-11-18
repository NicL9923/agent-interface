# November 15 a skipped view transition is not an error

Branch `t3/view-transition-skip` from `origin/main` at `907eb1c`, on the Mac mini with Node 24.22.2. Nothing was
deployed by this entry.

## Change

A `check-all` e2e run for #402 failed a phone Back test on `Uncaught error: Transition was skipped. New
ViewTransition started`, then passed 20 of 20 alone. `morphNavigate` (`src/app/navigation-morph.ts`) handled only the
transition's `finished` promise. When a newer navigation starts a transition before the last one is ready, the browser
skips the older one: its update still runs and `finished` resolves, but `ready` rejects with an `AbortError`, which
nothing handled. `ready`'s rejection is now caught.

## Red runs

| Break                      | Test                                                                      | Failure                                                                               |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Remove the `ready` handler | `treats a transition a newer navigation skipped as done, not as an error` | Vitest reported `Unhandled Rejection: AbortError: Transition was skipped` and 1 error |

The file was restored and `tests/motion-ui.test.ts` passed 9 of 9 with no errors.

## Checks

`check-all --keep-going --py never` passed typecheck, lint, ruff and build. Vitest failed only the three `127.0.0.2`
tests. e2e failed one test, `smoke.spec.ts` "a reply keeps growing across a tool call", on a 5 s visibility timeout
after 9 minutes queued behind other worktrees' suites; that test is the known load-sensitive one and does not use view
transitions.
