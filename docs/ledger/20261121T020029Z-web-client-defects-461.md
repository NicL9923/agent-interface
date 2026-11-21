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

## 3. Keys in the transcript that did not scroll it still counted as the reader scrolling

The report said arrow keys, Home and End pressed in the approval card's `role="menu"` reach `scrollIntent` and can stop the transcript from following. They do reach it, but for those keys that is correct. The menu has no key handler, so the browser scrolls the transcript with them. A probe page with a scrolling box, a button in a `role="menu"`, a link, a summary, two scrolling `pre` blocks and a sideways scroller showed what each key does. It ran in Chromium and in WebKit, in the `mcr.microsoft.com/playwright:v1.65.0-noble` container, with Playwright 1.65.0:

| Focused element                                          | Key                               | Chromium               | WebKit                  |
| -------------------------------------------------------- | --------------------------------- | ---------------------- | ----------------------- |
| Menu item button                                         | Up, Down, Home, End, Page Down    | The transcript scrolls | The transcript scrolls  |
| Menu item button, other button                           | Space, Shift Space                | Nothing scrolls        | Nothing scrolls         |
| Summary                                                  | Space                             | Nothing scrolls        | Nothing scrolls         |
| Link                                                     | Space, Down                       | The transcript scrolls | The transcript scrolls  |
| `pre` with more lines than it shows                      | Down, Space, End                  | The `pre` scrolls      | The `pre` scrolls       |
| The same `pre` at its top or bottom                      | Up at the top, Down at the bottom | The transcript scrolls | The transcript scrolls  |
| `pre` with `overscroll-behavior: contain`, at its bottom | Down                              | Nothing scrolls        | The transcript scrolls  |
| Sideways scroller                                        | Down                              | The transcript scrolls | The scroller moved 1 px |

So the reported keys do not reproduce the defect. The same class of defect does reproduce for other keys and elements:

- Space and Shift Space on the menu item, or any button or summary in the transcript, press it and scroll nothing. Shift Space counted as scrolling up, which stopped following. Space counted as scrolling down, which ends the anchor after a send.
- Up in the approval card's command box, which is at most `9.5em` tall and scrolls, moves the box. It counted as scrolling up.
- The listener ran on the transcript element, before React's handlers on the root. It could not see a handler that took a key. No control inside the transcript takes a scroll key today: the message rail, Find in chat and the files panel sit outside it, and the question card takes only the digits 1 to 9. A menu with arrow keys, as the ARIA menu pattern describes, would have hit this.

The fix moves the rule into `keyScrollsTranscript` in `src/app/scroll-follow.ts`, and `use-conversation.ts` now hears keys on the document, after every handler. A key counts only when no handler prevented its default, the focused element is not a field, the key is not Space on a button or summary, and no scrolling box between the focused element and the transcript can still move that way. Text fields were already left out. Their check moved into the same function. The function does not read `overscroll-behavior`. The tool call output box sets `contain`, so Up at that box's top in Chromium still counts as scrolling. It also misses WebKit's 1 px sideways scroller.

The tests are in `tests/transcript-ui.test.ts`. On main, three of the five failed at their first assertion: Shift Space on the menu item, Up in the command box, and a key a React handler took. The other two passed on main: Up in the menu, which documents the reported case, and Up in a field.

| Break                                               | Result                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Main's `scroll-follow.ts` and `use-conversation.ts` | Red: the three tests above                                                       |
| Keys heard on the transcript element again          | Red: `hears it as scrolling only when the control left it to the browser`        |
| No `defaultPrevented` check                         | Red: the same                                                                    |
| No field check                                      | Red: `does not hear Up in a field as scrolling, since the field moves its caret` |
| No Space check                                      | Red: `does not hear Space or Shift Space on a button as scrolling`               |
| Space checked on buttons only, not summaries        | Red: the same                                                                    |
| No check for a scrolling box inside                 | Red: `does not hear a key the command box scrolls with`                          |
| A scrolling box takes the key even at its end       | Red: the same                                                                    |

## Validation

Both runs below used `4ac636d0`, the item 3 commit, under `~/.agents/tools/linux-heavy-lock.sh`.

| Check                                                                             | Result                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.agents/tools/check-all --keep-going`                                            | Typecheck, lint, ruff, unit tests (229 files, 4,210 tests) and build passed. Chromium e2e: 142 passed. WebKit e2e: all 142 failed with "Host system is missing dependencies", as WebKit does on this host |
| WebKit e2e in `mcr.microsoft.com/playwright:v1.65.0-noble`, after `npm run build` | 138 passed, 3 skipped by their own conditions, 1 failed: `e2e/smoke.spec.ts:811`, which fails in WebKit on main too                                                                                       |

No e2e spec changed. No Playwright spec exercises the three fixes directly. The key behavior in item 3 was checked with the probe page in both browsers, and the app's handling of it with the jsdom tests.

## Review fixes

An independent review of `af8d1c38..ba701a28` found four defects and two nits. Each fix is its own commit on top of `ba701a28`.

### Review 1. Small turn resizes added up past the reading line

A resize report skipped the measure when the turn's border box was within 0.5 px of the measured height. Five turns that each grew by 0.375 px moved the message after them 1.875 px, past the reading line, and the rail kept the old tick. The skip now needs exact equality. A probe in Chromium and in WebKit, the same Playwright 1.65.0 setup as above, observed seven elements with fractional heights. `ResizeObserverEntry.borderBoxSize[0].blockSize` equalled `getBoundingClientRect().height` exactly for every one. Under CSS `zoom: 1.25` the two differ, so the skip never fires there and the rail measures as main did.

| Break                              | Guarding test                                                                         | Result                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The 0.5 px tolerance back in place | `measures again when turns above the reading line each grow by a fraction of a pixel` | Red: Question 30 stayed marked, Question 29 expected |
