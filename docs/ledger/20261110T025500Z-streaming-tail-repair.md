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

## Review round 1

GPT-6.1 Sol reviewed `969f76e` and judged it not ready: the function guessed in contexts it did
not understand. `completeStreamingTail` is restructured so each repair is opt-in for a context
it has positively identified, and everything else comes back unchanged; the model is the
comment at the top of `src/components/streaming-tail.ts`.

- B1. No recursion and no rescanning. One inline scan, plus one verifying rescan of the repaired
  context, both under a step budget of 32 steps per character.
- B2. A definition, a bare autolink (`://`, `www.`, `@`) and any `<` mean no repair. A link's
  destination is hidden only while it arrives, and not when it holds a marker that could pair
  with one before it.
- B3. A fence behind a quote or list marker, or a list item's fence whose lines leave its indent,
  means no repair, which covers container-prefixed `agent-ui` and `wildbots-html` fences.
- B4. A header row is held back only while the delimiter row under it has begun and is not yet
  complete, only at the margin, and only when the hold takes no closer or line break from the
  paragraph above. Indented code and a lone pipe line show as typed.
- B5. Rule chosen: only `**` and `***` close, when they follow a space or an opening bracket or
  quote and precede a letter, digit, backtick or opening bracket. A single `*`, any `_` and a
  single `~` never close, since assistants write `*.ts`, `*args`, `_private`, `__init__`,
  `~user`, `~5` and footnote asterisks far more often outside code than single-marker emphasis.
  `~~` closes only when it is the lone tilde run. Code spans close. Accepted residual: a bare
  `**kwargs` outside backticks shows bold until its paragraph ends.
- B6. Delimiters match with CommonMark's per-kind stack floor, so work is linear; code spans find
  closers through per-length queues. Past the budget the text comes back unchanged.
- B7. `CodeBlock` keeps copy feedback with the code it copied. When the code changes the status
  clears, and a copy still pending neither claims success nor ends a newer copy's wait.
- B8. `README.md` now says a table appears once its delimiter row is recognized, and that a
  single `*`, `_` or `~` shows as typed.

### Property

The two old property tests are replaced. The parser (`mdast-util-from-markdown` with GFM) is the
judge, and for every prefix `p` of a reply, with `live = completeStreamingTail(p)`:

1. the visible text of `live` (text, inline code, code and image alt, in order) is a subsequence
   of the visible text of `p`;
2. every link, image and definition destination in `live` is one in `p` or in the whole reply;
3. a `*`, `_` or `~` the parser formats in `p` is still formatted in `live`;
4. for 11 replies an assistant would write, a marker `live` formats but `p` shows as typed is one
   the whole reply formats too, and at least 100 such repairs happen, which an identity function
   fails.

Properties 1 to 3 run over 300 seeded random strings built from Markdown fragments and the
reviewer's inputs, every prefix; the average call must stay under 0.5 ms. Text the parser reads
with no stray marker, including every paragraph in `README.md` and `docs/`, must come back
unchanged.

While building it, the property and a scratch search over random strings found faults in my own
first rewrite, each now fixed and covered by a case: a code span repair that revealed markers the
raw text formatted, a link cut that removed a strike's closing `~~`, a header hold that removed a
closer or a hard-break backslash from the line above, a strong opener inside a finished strike,
closers merging with a closer the rule of three then split, a closer changing how an adjacent `_`
flanked, and a link cut that emptied a list item. After the fixes, 12 search runs over 42,000
random strings from three fragment sets, every prefix, found nothing.

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/streaming-tail.test.ts tests/message-markdown.test.ts`: 153 passed.
- `npm test`: 170 files, 2622 tests passed.
- `npm run build` passed. `npm run test:e2e`: 3 passed in Chromium.
- Worst case on 100,000-character blocks, Node 24.22.2 via `npx tsx`, 10 warm runs each: 37 ms
  cold and 32 ms warm, both on adversarial delimiter mixes. The B6 input took 21 ms cold.

### Red proof, round 1

On `969f76e`, with the committed tests: 65 failed and 88 passed across the two files, including
every finding's case, both new properties, the B1 function and render cases, which overflowed the
stack after 6.1 s and 10.4 s, the timing case, which took 1.8 s, and the B7 copy test.

Then 65 hand mutations of `streaming-tail.ts`, one guard or rule at a time: each turned at least
one test red before the file was restored. Survivors on the first pass were resolved by adding a
case that kills them, found by hand or by search, or by deleting the guard when the final
verification already covered it: the code-content check, the trailing-backslash check, the
closer cap, the bracket cap, the HTML check on continuation lines, the ambiguous delimiter check,
and the tilde checks that the equal-size rule now covers. Mutations in `MessageMarkdown.tsx`:
reading copy state without its code, settling a pending copy without the code check, and keying
an unfinished `CodeBlock` by its code each turned their test red.

## Review round 2: hold back instead of repairing

GPT-6.1 Sol reviewed `2cb8bb5` and found six more faults in `completeStreamingTail`: quadratic
bracket invalidation (735 to 1,120 ms on one input), closers added inside list-item and
carriage-return-indented code, link labels read as a rule or heading once their brackets were
removed, a code span shown where the saved view shows a link, and `**3`, `**kwargs` and
`**test.ts` losing their stars. The orchestrator stopped the repair approach. Adding or removing
characters makes text the parser reads in ways the scanner cannot foresee, and closing an open
marker is a guess.

`src/components/streaming-tail.ts` and its tests are deleted. `streamingHoldBack` in
`src/components/streaming-hold-back.ts` returns a prefix of its input. The contract is the comment
at the top of that file:

- It holds back at most `HOLD_LIMIT` = 120 characters, all on the last line. That is about one
  short sentence: it covers a bold phrase, a code span and a link to a typical docs page. At
  100 to 300 characters a second it delays about half a second at worst.
- A block longer than `BLOCK_LIMIT` = 4,000 characters comes back whole without being read. Every
  pass runs over at most that many characters, and the stacks only push and pop, so the work is
  bounded and no budget is needed. A paragraph rarely runs past 4,000 characters; a longer list
  or a reply parsed whole shows markers as typed, as `origin/main` does.
- Code is never cut. Any fence-shaped line in the block, behind any container markers, or a last
  line indented four spaces or a tab, returns the block whole. The function sees the same block
  the renderer parses on its own, so its view of code matches the parse of that block.
- Rules, each held only while unfinished: an unclosed code span; a `**`, `__`, `~~`, `*` or `_`
  opener after a space or opening bracket and before a letter or digit; a link or image whose text
  or destination is arriving; a pipe-led line under a line that is not; a last line of only
  marker characters; and a trailing `*`, `_`, `~` or `|` run after a space.
- Pause mid-construct: no rule added. Nothing is held once a line break arrives, since the cut
  never crosses one. Before a tool call the segment is already a saved history row
  (`src/server/hermes-mapping.ts`, `inflightMessage`), and a saved row is parsed whole from raw
  text. A model stall mid-construct with no tool call keeps up to 120 characters hidden until text
  resumes; only a timer would change that. Neither case was watched in a browser.

The copy-feedback fix, the mounted unfinished `CodeBlock` and the README's table sentence stay.
The README now says short bold, italics, strikethrough, code and links appear whole when their
closer arrives, a longer one shows as typed, and the header shows as typed while the delimiter
row arrives.

### Tests

- `tests/streaming-hold-back.test.ts`: for every prefix of 14 realistic replies and 400 seeded
  strings built from markers, words, brackets, pipes, backticks, tabs, `\r` and `\n`, the output
  is a prefix, holds at most 120 characters and no line break, and never overlaps a `code` node
  in the parse of that prefix. More than 1,000 prefixes must be cut, which an identity function
  fails. A table of 20 positive cases holds each construct while unfinished and shows it whole
  once finished; 24 negative cases show globs, names, indexes, URLs and every kind of code as
  typed. A timing case requires a median under 1 ms on 100,000 characters and on five blocks at
  the read limit.
- `tests/message-markdown.test.ts`: all 18 reviewed inputs from both rounds, plus a readable
  copy of the slowest, are checked through the real components: the live render equals
  `MessageMarkdown` rendering the same prefix. React Markdown took about 80 seconds to render
  `"*a ".repeat(16000) + "b_ ".repeat(16000)` live and saved in jsdom, so that input checks only
  its prefix.
- A scratch search, not committed, with a xorshift generator over a wider fragment set, including
  `\r\n`, `<div>` and U+2028: 6 seeds, 931,733 prefixes, 362,425 of them cut, no fault.

### Timing

`npx tsx` with Node 24.22.2 on NicolasLaptop, 50 warm-up calls, then 101 timed calls each: the
100,000-character block took 0.0002 ms median and 0.005 ms max, because it is not read. The worst
4,000-character block, alternating `_a ` and `b_ ` runs, took 0.14 ms median and 0.55 ms max
across the runs. A scratch search over 3,000 random 4,000-character blocks built from repeated
marker shapes found a worst single call of 0.9 ms.

While measuring I found my first fence regex backtracked exponentially: `"-   ".repeat(20) + "x"`
took 52,465 ms, and the random strings had never built that shape. Its two space quantifiers
could split the same run of spaces. The container pattern now gives each character one way to
match. The same input takes 0.02 ms, and a 4,000-character version is in the timing case.

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/streaming-hold-back.test.ts tests/message-markdown.test.ts`: 86 passed.
- `npm test`: 170 files, 2555 tests passed.
- `npm run build` passed. `npm run test:e2e`: 3 passed in Chromium.

### Red proof, round 2

35 hand mutations, each run against both test files and then restored. All 35 turned at least
one test red. On the first pass 29 did. Of the six survivors, one was a redundant guard (a
construct before the window returning early), now deleted, because the final bound check already
shows it as typed. The other five got a case each, and each now goes red: an underscore inside a
word closing emphasis, a link destination not skipped, the bound not enforced on a line-level
cut, openers or brackets beyond the bound blocking a later hold, and escapes ignored.

Per rule: not holding an unclosed code span, removing each marker's opener test (`*`, `_`, `~~`),
letting a shorter closer close, letting closers never close, letting an opener follow a letter,
dropping the trailing run, the single tilde, the lone pipe, the link-text bracket, the image's
`!`, the closed bracket at the end, the open destination, the open reference label, the table
header and the marker line each failed their positive case. Holding every bracket, and counting
tilde runs of any size, failed negative cases. Dropping the fence check, narrowing it to the
margin, dropping the indentation check or its tab, treating only `\n` as a line end, and dropping
the read limit each failed the property, a negative case or the timing case. In
`MessageMarkdown.tsx`, passing the raw last block failed the hold test and three reviewed render
cases. Not holding back a reply parsed whole failed the definition case.
