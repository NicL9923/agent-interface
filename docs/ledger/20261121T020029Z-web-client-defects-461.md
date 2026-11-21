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

### Review 2. A finished table row stayed hidden under a delimiter row without a leading pipe

`| Day | Meal |\n--- | ---\n| Mon | Pasta |\n` is a table with one body row. Rule 4 asked only that the line above not start with `|`, so it read `| Mon | Pasta |` as a header. The new hold kept it hidden after its line ended. Main's rule 4 also hid it while it was the last line. Both holds now share `opensTable`: the line above must hold no `|` at all. That rules out a table row or delimiter row in either form. It also rules out prose with a pipe, whose header then shows as typed, as it did on main.

| Break                                                                 | Result                                                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opensTable` checks only that the line above does not start with `\|` | Red: the row under a delimiter row without a leading pipe, the row under a row without one, and the row still arriving under such a delimiter row |

### Review 5. Without a grapheme segmenter, a shown header went away

Without `Intl.Segmenter` the hold-back holds nothing after the first character, because it cannot prove a cut falls between characters. The header hold returned before that check, so `Intro\n| Day |` showed whole and then hid `| Day |` once the newline arrived. Both holds now cut through `cutAt`, which keeps that check.

| Break                                             | Guarding test                                                        | Result                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| The header hold slices without the boundary check | `holds nothing it showed when the runtime has no grapheme segmenter` | Red: `Intro\n` shown, `Intro\n\| Day \|\n` expected |

### Review 4. The seeded live and saved comparison accepted a dropped delimiter row or code line

The exception accepted any live render that matched the saved render without the reply's last line, when that line started with `|`. That would pass a live render missing a valid delimiter row, as in zero-based case 301, or missing a fenced code line, as in case 8. The exception now asks the hold-back what it held in the last block, as `StreamingMarkdown` does. It applies only when that is the reply's whole last line, starting with `|`, under a line with no pipe, and the saved parse puts it in paragraph text, not in code or a table. A lazy line in a list item stays accepted. The seed holds one, and it is paragraph text inside a list.

| Break in `streaming-hold-back.ts`                                                  | Old exception | New exception |
| ---------------------------------------------------------------------------------- | ------------- | ------------- |
| `opensTable` ignores the line above, so a delimiter row under a header row is held | Green         | Red           |
| No fence check, so a code line starting with `\|` is held                          | Green         | Red           |

### Review 3. Up still counted where nothing scrolled

The review found two cases, both reproduced in Chromium:

- A tool's output box at its top. It sets `overscroll-behavior: contain`, so Chromium scrolls neither the box nor the transcript.
- Cancel in the "Always allow" dialog. The dialog sits inside the transcript in the page, but it is modal.

A probe confirmed the dialog case in Chromium and in WebKit. A modal dialog's computed `position` is `fixed`. Up, Down, Home, End and Page Up pressed on a button in it left the transcript where it was.

I did not switch to counting a key only once the transcript's scroll position changes, though the review suggested it. That rule does not fit the hook, for two reasons:

- The follow mode's layout pass pins the transcript to the end on every content change. The hook counts a key at keydown because a reply arriving between the key's default scroll and its scroll event would otherwise pin the transcript back and undo the reader's move.
- The app scrolls the transcript itself: pinning to the end, offsetting late images, and the browser clamping the top when content shrinks. A key that did nothing could be confirmed by one of those.

`measurePosition` already ends following when the transcript moves up while no input was heard. That covers a key scroll the classifier misses, one frame later.

The classifier now stops at a fixed box, which covers a modal dialog, because such a box scrolls with the viewport. At a scrolling box at its end, it also reads `overscroll-behavior-y`: anything but `auto` keeps the key, as Chromium does. WebKit passes the key on anyway. That scroll is then heard by `measurePosition`, as above. Safari before 16 reads the property as empty, which counts as `auto`. The tests set the CSS they depend on inline, because jsdom loads neither the app's stylesheet nor the browser's `dialog:modal` rule. I did not chase the 1 px WebKit case.

| Break                                    | Result                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The previous commit's `scroll-follow.ts` | Red: `does not hear Up at the top of a box that contains overscroll` and `does not hear keys pressed in the Always allow dialog as scrolling` |
| No check for a fixed box                 | Red: the dialog test                                                                                                                          |
| `overscroll-behavior-y` ignored          | Red: the contained box test                                                                                                                   |

### Review 6. No test sent plain Space

The Space test sent only Shift Space, which ends following. Plain Space on a button ends a send's anchor, and nothing tested it. `keeps this person's sent message near the top after Space presses a button in the transcript` anchors a send, presses Space on a button in the transcript, and checks that the sent message still lands 24 px from the top.

| Break                                        | Result                                               |
| -------------------------------------------- | ---------------------------------------------------- |
| The Space check applies only with Shift held | Red: the new test. The Shift Space test stayed green |

## Second review fixes

A second review of `ba701a28..b9d6d0a0` found three defects and a nit. Each fix is its own commit on top of `b9d6d0a0`.

### Second review 1. WebKit pulled a reader back after a send

After a send, Down or Page Down from the end of a tool's output box made WebKit scroll the transcript. The box sets `overscroll-behavior: contain`. Chromium keeps those keys in the box. The classifier said the key scrolled nothing, so the send's anchor stayed on, and `measurePosition` does not read moves in anchored mode. The anchor pulled the reader back to the sent message.

The classifier, renamed `keyScroll`, now says "unknown" for a contained box at its end. The hook counts an unknown key only while a send's anchor is on. These are the two wrong answers:

- Counting a key that scrolled nothing ends the anchor early in Chromium. The view stays where it is either way while the reply grows.
- Not counting a key that scrolled moves the reader back.

The hook does not count an unknown key while following, so Up at the top of a tool output box still leaves Chromium following. WebKit's move up there is heard by `measurePosition`, which runs on the next animation frame, before resize observers place the transcript.

`e2e/contained-scroll.spec.ts` covers it in the built app. The fixture's new "Read the gate log" turn saves an 80-line tool output, then streams a reply slowly and stays running. The test opens the output, focuses it at its end, and presses Down and Page Down. Then it waits 2.4 seconds while the reply grows. In WebKit the transcript moves down and stays. In Chromium it does not move.

| Break                                                            | Guarding test                                                                 | Result                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `b9d6d0a0`'s `scroll-follow.ts` and `use-conversation.ts`, built | `e2e/contained-scroll.spec.ts`, WebKit in the container                       | Red: the transcript ended at 50 px, where it started. No scroll event reported a move past it |
| The same                                                         | The same, Chromium                                                            | Green, as expected: Chromium scrolls nothing                                                  |
| The same                                                         | `ends a send's anchor on Down from the end of a box that contains overscroll` | Red: the sent message was still pinned 24 px from the top                                     |
| An unknown key never counts                                      | The same                                                                      | Red                                                                                           |
| An unknown key always counts                                     | `does not hear Up at the top of a box that contains overscroll`               | Red: following ended                                                                          |

### Second review 4. The rail comment claimed more agreement than was measured

My probe ran at a device pixel ratio of 1 with untransformed boxes. At a ratio of 1.25, the reviewer measured a box with `scaleY(1.003)`: it reported 60.375 px through `ResizeObserver` and about 60.556 px through `getBoundingClientRect()`. The comment now says the two agree only for an untransformed turn at a ratio of 1. Under zoom or a transform, every report measures again. This changed a comment only, so no test or red run applies.

### Second review 2 and 3. The parser now decides which lines are table headers

The hand-written rule for which lines a delimiter row would make a header was wrong three times across two reviews. It missed a delimiter row without a leading pipe, then a pipe on the line above, then a lazy line in a list item. The review found it wrong in both directions:

- It hid body rows: `| Meal |\n:---\n| Soup |\n`, and `| Meal |\n|---|\nPasta\n| Soup |\n`.
- It showed headers as raw text: under ``Use `|` as a separator.``, and under a heading with a pipe.
- The seeded comparison accepted case 1127, `- item\nText **bold**\n| - | - |\n`. The list item's paragraph takes that line in, and no delimiter row can make it a table.

`becomesHeader` in `streaming-hold-back.ts` now asks the parser. A line starting with `|` is a header when parsing the block with a delimiter row of as many cells appended gives a table whose header row is that line. The parser is `fromMarkdown` with the GFM extensions, imported as `MessageMarkdown.tsx` imports it. Both holds use it. A cell miscount only means no table, so the line shows as typed. A header without a leading pipe still shows as typed, as before.

The seeded comparison's exception is now exact. Live and saved may differ only by a held last line that the parser reads as a table header under a delimiter row of 1 to 6 cells. The test runs the parser itself, apart from the hold-back's code. The exception applied to 9 of the seed's 1,500 replies. Case 1127 now shows its last line live.

Cost, from `.agents/tools/streaming-parse-bench.test.ts` with a new reply ending in a table of about 3,600 characters, paced. The hold-back's share is rendering minus React Markdown's parsing. jsdom times are an upper bound for a browser.

| Run                                      | Hand-written rule | Parser         | React Markdown parsing |
| ---------------------------------------- | ----------------- | -------------- | ---------------------- |
| Quiet host, one run each                 | 10 ms/s           | 32 ms/s        | 27 ms/s                |
| Loaded host, three interleaved runs each | 29 to 33 ms/s     | 85 to 103 ms/s | 80 to 105 ms/s         |

The parser adds about one more parse of the last block per update, only while that block's last line starts with `|`. The prose and code replies never reach it. A cache of the text above a known body row did not help here. Each update in the bench starts a new row, so the cache never hit, and I removed it.

| Break                                                     | Result                                                                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The previous commit's `streaming-hold-back.ts`            | Red: the header under a pipe in code, the header under a heading with a pipe, both body rows above, the list item's line, and the seeded comparison, on case 1127 |
| The same, with the previous commit's seeded exception     | Green, so the old exception hid case 1127                                                                                                                         |
| Any line starting with `\|` counts, without the parser    | Red: 12 hold-back cases and the seeded comparison                                                                                                                 |
| Any table in the parse counts, not one headed at the line | Red: 11 hold-back cases and `renders a growing reply the same as the saved reply`                                                                                 |

### Second review validation

On `9f6f7d9b`:

| Check                                                                                         | Result                        |
| --------------------------------------------------------------------------------------------- | ----------------------------- |
| `npm run typecheck`, `npm run lint`                                                           | Passed                        |
| `npx vitest run`, under `linux-heavy-lock.sh`                                                 | 229 files, 4,224 tests passed |
| `npm run build`, then `e2e/contained-scroll.spec.ts` and `e2e/live-reply.spec.ts` in Chromium | 11 passed                     |
| The same two specs in WebKit, in `mcr.microsoft.com/playwright:v1.65.0-noble`                 | 11 passed                     |

## Third review fixes

A third review of `b9d6d0a0..fc002507` found five things. One was declined. Each of the other four is its own commit on top of `fc002507`.

### Left as a follow-up: a key that ends the anchor in Chromium, where nothing scrolled

In the gate-log fixture, Page Down from the end of the tool output scrolls nothing in Chromium, yet it ends the send's anchor, because the hook counts that unknown key while an anchor is on. If the viewport then grows and shrinks while the reply streams, from 1280 × 720 to 1280 × 1150 to 1280 × 650, the transcript jumps from 51 px to 403 px and hides the sent message. The client at `b9d6d0a0`, or the same steps without the key, returns to 51 px. Main counts every key, so main ends the anchor on that key too and makes the same jump. Telling a key that scrolled from one that did not, in a box the two engines treat differently, needs the hook to confirm the key against the transcript's own movement. That is a larger change to the follow logic than this task carries, so it is left for a follow-up.

### Third review 1. A header showed, went away, then came back as a table

After ``Use `|` as a separator.``, the line `| Name | No.` read as a finished sentence at `No.`, so the hold dropped and the line showed. The closing ` |` made it a header candidate again, and the hold hid the whole line until the delimiter row made it a table. A line now counts as a header only if no prefix of it ended a sentence: it holds none of `.`, `!`, `?`, `。`, `！` or `？`. Such a header shows as typed until its delimiter row arrives.

The prefix property test did not catch this. It checked that a shown line never goes away only for a header held over its delimiter row, two lines, and not for a header held alone as the last line. It now checks every hold that hides a whole line starting with `|`: none of that line may have shown, apart from spaces, one character earlier. That check is limited to header holds. The same check over every rule finds 171 cases on `fc002507` where an opener at a line's start showed as a finished sentence and was then held again. That behavior predates this work and is outside it. The reviewer's reply is now one of the test's fixed replies.

| Break                                                        | Result                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fc002507`'s `streaming-hold-back.ts`                        | Red: the prefix property test ("hid a shown line", the reviewer's reply first) and `keeps showing a header that read as a finished sentence while it arrived` |
| The header check tests only the last line's own sentence end | Red: the same two                                                                                                                                             |

### Third review 2. The extra parse ran for every row of a long table

`becomesHeader` parsed the block for every pipe-led last line, body rows included. The reviewer replayed a 3,600-character, three-column table in Chromium at 390 px with 4× CPU throttling, 59 updates over its last 1,000 characters:

- Median render and layout time per update rose from 45 to 53 ms before the parser to 71 to 76 ms with it.
- The median gap between updates rose from 67 to 83 ms.

A line under one shaped like a delimiter row is now a body row: it is not held, and the parser is not asked. The shape is `| --- | :-: |`, `:---` or `---`. Where that line is a heading's underline or a rule instead, the parser might have read the line under it as a header, and it now shows as typed.

Cost, from the parse benchmark's table reply, paced, with three interleaved runs of each version. The hold-back's share is rendering minus React Markdown's parsing.

| Run | Hand-written rule (`b9d6d0a0`) | Parser on every row (`6d0388c5`) | Parser after the delimiter check |
| --- | ------------------------------ | -------------------------------- | -------------------------------- |
| 1   | 12 ms/s                        | 37 ms/s                          | 13 ms/s                          |
| 2   | 17 ms/s                        | 62 ms/s                          | 25 ms/s                          |
| 3   | 13 ms/s                        | 41 ms/s                          | 13 ms/s                          |

Run 2 ran under more load: React Markdown's own parsing took 47 to 60 ms/s against 33 to 37 in the others.

| Break                              | Guarding test                                       | Result |
| ---------------------------------- | --------------------------------------------------- | ------ |
| No check for a delimiter row above | `shows a line under a heading's underline as typed` | Red    |

### Third review 3. The seeded exception could waive a dropped line of prose

The exception asked only that the held last line become a table header under some delimiter row. GFM reads `Title` as a one-cell header under `|-|`, so if the hold-back ever dropped the last line of zero-based case 107, which ends in `Title\n`, the test would have accepted it. The exception still takes what the hold-back held of the last block. It now also requires that line to start with `|` after at most three spaces, as every header the hold-back holds does.

| Break in `streaming-hold-back.ts`                                     | Old exception | New exception |
| --------------------------------------------------------------------- | ------------- | ------------- |
| `becomesHeader` no longer requires a leading pipe, so `Title` is held | Green         | Red           |

### Third review 4. A cell holding only a nonbreaking space made the header flash

`cellCount` trimmed the row with `trim()`, which removes a nonbreaking space. GFM trims only spaces and tabs, so `| A |  ` has two cells for GFM and had one for the count. The synthetic delimiter row then had too few cells, the parser found no table, and the header showed as raw text until its real delimiter row arrived. The count now trims spaces and tabs only.

| Break                                          | Guarding test                                                 | Result |
| ---------------------------------------------- | ------------------------------------------------------------- | ------ |
| `trim()` back in `cellCount`, as on `e9f17cb2` | `holds a table header whose last cell is a nonbreaking space` | Red    |
