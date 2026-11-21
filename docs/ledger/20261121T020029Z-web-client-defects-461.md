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

## 2. A streaming table's header showed as raw pipe text

Rule 4 in `src/components/streaming-hold-back.ts` held a header row only while it was the last line. Once the header ended, the delimiter row's line was held as a marker line, and the header showed as a paragraph of raw `| … |` text until the delimiter row ended. That paragraph sits in a bubble when the chat style is Bubbles.

The header now stays held with the next line while that line holds only `|`, `:`, `-`, spaces and tabs. These decisions were mine:

- Only a header that rule 4 held while it was the last line stays held. That header starts with `|` after at most three spaces, is not under another such line, fits in `HOLD_LIMIT` and does not end a sentence. A line on screen never goes away again. A header without a leading pipe, such as `a | b`, shows as typed, as before. A table body row is never held, because the line above it starts with `|`.
- The delimiter row's line has its own `HOLD_LIMIT`, so at most two lines of 120 characters each are held. The contract in the file now names this as the one hold that crosses a line break. The prefix property test checks it: such a hold starts at a line start and was already in place one character earlier.
- Pipes in inline code or a code fence need nothing new. A line that starts with inline code does not start with `|`, and a block with a fence is returned whole before any rule runs. React Markdown does treat `` `a | b` `` over `--|--` as a table. Holding such a line would hide prose like `` Run `ls | wc -l` `` during every pause, so it shows as typed, as the task asked.
- A header whose delimiter row never comes shows once the reply is saved, because a saved reply skips the hold-back. A new test in `tests/message-markdown.test.ts` covers that.

`renders seeded random replies the same live and saved` compares the live and saved renders of seeded replies that end at a line break. The hold-back did nothing on those endings before. It now holds a trailing header row on purpose, so that test also accepts a live render that matches the saved render of the reply without its last line, when that line starts with `|`. Any other difference still fails it.

| Break                                                | Result                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main's `streaming-hold-back.ts`                      | Red: the header over its delimiter row, the header before its delimiter row starts, and the live render of the header whose delimiter row never came |
| No check that the line above the header is not a row | Red: the prefix property test, the three header cases, and `a table row under another row`                                                           |
| No sentence check on the header                      | Red: the prefix property test ("hid a shown header") and `a pipe, on the line above`                                                                 |
| No length bound on the header                        | Red: `a table header longer than the bound, once it ends`                                                                                            |
| No length bound on the delimiter row's line          | Red: `a table header over a delimiter row longer than the bound`                                                                                     |
| Any next line keeps the header held                  | Red: the prefix property test and `a line starting with a pipe once the next line reads as prose`                                                    |

iOS has the same defect, and a broader one. I found it by reading the code. No simulator run checked it. `MarkdownCache.streamingBlocks` in `ios/AgentInterface/MarkdownCache.swift` parses the streamed text with `Markdown.parseTail` and holds nothing back. `ChatBubbles.segments` and `MarkdownView` in `MediaViews.swift` render those blocks while a reply streams. `Markdown.table` in `MarkdownParser.swift` makes a table only once the next line is a delimiter row with as many cells as the header. Until then the header is a paragraph of raw pipes, from its first character until the delimiter row has its last cell. The same path shows an unfinished `**`, link or code span as typed. I did not edit Swift.
