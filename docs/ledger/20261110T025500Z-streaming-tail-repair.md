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
