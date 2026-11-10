# November 10 completing the streaming reply's tail

Branch `t3/streaming-tail-repair` over `e479781`, on NicolasLaptop (Fedora, Linux x64), Node
24.22.2. Web client only; no server, Hermes or iOS code changed.

## Application tests

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/streaming-tail.test.ts tests/message-markdown.test.ts`: 73 passed.
- `npm test`: 170 files, 2542 tests passed.
- `npm run build` passed. `npm run test:e2e`: 3 passed in Chromium.

## Parser checks

`completeStreamingTail` was compared with the app's own parser (`mdast-util-from-markdown` with
GFM, the micromark stack React Markdown uses):

- 120,000 seeded strings over words, spaces and `*`, `_`, `~` and backticks: none that the parser
  reads with no stray marker was changed. The committed test keeps 4,000 of these.
- Over words, spaces, `*` and `_`, no repair left more stray markers than it found. With single
  tildes mixed in, about 0.2% of random strings (101 of 60,000, all with a single `~` wedged
  against `*` or `_`) gain one, because strikethrough and emphasis resolve in separate passes.
  The tail stays readable and the saved reply is unaffected.
- 2,525 finished paragraphs from `README.md` and `docs/` came back unchanged.
- The first version used CommonMark's flanking text; micromark treats a `~` beside `*` or `_` as
  an ordinary character, and the check caught the difference. The scanner now follows micromark.

## Red proof

Each guard was broken by hand, the named test went red, and the line was restored:

- `MessagePre` keying an unfinished `CodeBlock` by its code: the same-node test failed.
- `StreamingMarkdown` passing the raw last block: the bold render test failed.
- In `completeStreamingTail`: the unfinished-fence return, escapes, the word-internal `*` rule,
  the `_` opener rule, the content-after-opener rule, the trailing backslash, the closer touching
  whitespace, the half-typed `~~`, the delimiter-row check, the body-row check, the bracket glued
  to a word, the footnote call, the blank-line reset, URL paren depth, the half-typed code
  closer, the single tilde, closed code spans, indented code, trailing whitespace, the rule of
  three (caught by the parser test), openers inside a finished link, inline HTML tags, the
  heading, deeper-quote, list item, rule and table-cell resets, the lazy quote continuation and
  partial images each turned at least one case red.
- Two mutations survived at first. The task-checkbox skip changed nothing because a closed
  `[ ]` never reaches the link path, so it was removed. Mutating the quote reset showed that a
  lazy continuation line was wrongly cut off from its quoted paragraph; that was fixed and tested.

## Not exercised

No browser session watched a live reply. The DOM-node and bold checks run in jsdom.
