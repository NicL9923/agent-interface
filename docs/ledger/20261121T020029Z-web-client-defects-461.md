# November 20 web client defects from issue 461

Branch `t3/fix-web-client-defects`, from `main` at `af8d1c38`. This fixes the first three web items on issue 461, one commit each. Every regression test was run on the unfixed code first, and each line a test protects was broken by hand afterward and restored from a saved copy. Runs used Node from `.node-version` and Vitest 5.1.0 on NicolasLaptop.

## 1. The message rail measured each row twice when an earlier page loaded

When an earlier page goes in, the rail's layout effect measures every sent message because the IDs changed. On main, the column's mutation observer then reported the same insertions as turns joining above the last sent message, marked the positions stale, and measured every row again. In a browser, each new turn's first resize report did the same: `ResizeObserver` reports every element once when observation starts, and the rail treated any report from a turn above the last sent message as a reflow.

The fix, in `src/app/MessageRail.tsx`:

- `locate` takes the mutation records not yet delivered with `takeRecords()`. Those changes happened before the measurement, which already sees them. The rail still watches the turns they added, but they do not mark the positions stale.
- `locate` records each turn's height. A resize report from a turn above the last sent message marks the positions stale only when its border box differs from that height by more than 0.5 px, or when the turn or its size is unknown. Safari before 15.4 sends no border box, so its reports still measure again.

The jsdom tests count the rail's own `getBoundingClientRect` calls on message rows, as the existing rail tests do. That count is the only way the double measure shows: the positions come out the same either way. I kept the test because it is cheap and the defect is a cost, which nothing else would catch. The browser's first resize report is simulated in the test from the specification's behavior. No browser run counted it.

| Break                                                              | Guarding test                                                                          | Result                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Main's `MessageRail.tsx`, before the fix                           | `measures each sent message once when an earlier page loads above them`                | Red: 148 row reads for 74 sent messages, limit 75    |
| `locate` takes no mutation records                                 | The same                                                                               | Red: 148 row reads                                   |
| `locate` takes the records but does not watch the turns they added | The same                                                                               | Red: the new turns were not observed                 |
| A first report never matches the measured height                   | The same, after the first reports                                                      | Red: 148 row reads                                   |
| Any reported size matches the measured height                      | `measures again when a turn from an earlier page has changed size by its first report` | Red: Question 30 stayed marked, Question 29 expected |

The two reviewed cases in this area, a stale position after turns above the last sent message reflow and the tick after a hidden routine card, passed in every red run above: each run failed only the test named.
