# November 10 streaming blocks for replies with code

Branch `t3/streaming-blocks-code` over `e479781`, on NicolasLaptop (Fedora, Linux x64), Node
24.22.2. Web client only; no server, Hermes or iOS code changed.

## Application tests

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/message-markdown.test.ts`: 24 passed.
- `npm test`: 169 files, 2493 tests passed.
- `npm run build` passed. `npm run test:e2e`: 3 passed in Chromium.

## Red proof

Each guard was broken by hand in `src/components/MessageMarkdown.tsx`, the file test went red,
and the line was restored:

- Applying `spansReply` inside fences too (`if (spansReply...` without `!open`): the five
  per-rule cases failed, including the fence still open at the end.
- Restoring the old `text.includes("[^")` fallback: the footnote cases and the regex case failed.
- Dropping the rule that a backtick fence's info string cannot hold a backtick: the case where
  a line such as ```` ```js``` is inline. ```` precedes a definition failed.
- Narrowing `spansReply` back to the margin (`^ {0,3}`): the footnote definition in a quote failed.

## Not exercised

No browser session watched a live reply. The render test compares streaming and saved output
for a code-heavy reply in jsdom.

## Review round 1

GPT-6.1 Sol reviewed `759b704` and found two ways the live view showed different content
from the saved one. Both are fixed, along with three more of the same kind found while proving
the fix.

- A1. `- ```` opens a fence the tracker cannot see, so it paired the item's indented closing
  line with the next fence and skipped a footnote definition between them. Any fence behind a
  quote or list marker now parses the whole reply. Found while proving it: a fence indented
  inside a list item ends where the item ends, at a line indented less than the item's content,
  so a fence opened with indentation now parses whole when a non-blank line left of its opener
  arrives before it closes. An HTML block can hold a fence-shaped line that is not code, so a
  line opening one now parses whole too.
- A2. A definition label that runs onto the next line, or holds an escaped bracket, now parses
  whole: a line that opens a bracket and either never closes it or reaches `]:` counts as a
  definition. `origin/main` also missed the escaped bracket.
- A seeded property renders 1,500 random replies, built from fences in and out of containers,
  definitions, split labels, HTML blocks and tables, live and saved, and requires the same
  HTML. About one in five of them splits into blocks. Before committing, a scratch version
  with a different random source passed 4,000 cases at seed 7 and 10,000 each at seeds 11, 23
  and 99 on the fix, and found 8 divergences in 4,000 cases on `759b704`.

Checks on the fixed tree: `npm run typecheck` and `npm run lint` passed;
`npx vitest run tests/message-markdown.test.ts`: 32 passed; `npm test`: 169 files, 2501
tests passed; `npm run build` passed; `npm run test:e2e`: 3 passed in Chromium.

### Red proof, round 1

Every new case failed on `759b704` on the render comparison, live HTML against saved HTML:
the six named cases and the seeded property, 7 failed and 25 passed. Then each guard was
broken by hand and restored:

- Dropping the quote-or-list fence guard from `wholeReply`: the case where a list item's fence
  closes on a line the tracker reads as an opener failed.
- Dropping the indentation guard: the case where a list item's fence ends at a line left of it
  failed, and so did the seeded property.
- Making that guard `<=`: 7 cases failed, including a fence in a list item whose lines stay
  indented, which must keep its blocks.
- Dropping the HTML block start from `spansReply`: the HTML block case, two per-rule cases and
  the seeded property failed.
- Dropping the never-closed label from `spansReply`: the two-line label case failed.
- Dropping escapes from the label: the escaped bracket case failed.

## Review round 2

GPT-6.1 Sol reviewed `7aa08d8` and found one more divergence: in "- Code:\n\n    ```\n    x\n\n> Next"
the live code block held "x\n" and the saved one "x\n\n". The fence sits four spaces in, inside
the list item, where the tracker reads it as indented code, so the splitter cut before the quote
that ends the item and dropped a blank line from the open fence.

- A fence indented four or more spaces, or by a tab, now parses the whole reply once a list
  marker has appeared earlier in it. With no list above it, such a line is indented code and
  splits as before.
- The reviewer measured that the fallbacks do not fire on ordinary code-heavy replies (0 of 64,
  0 of 102 and 0 of 92 prefixes on three realistic replies). A new test writes three replies of
  those shapes, a tutorial with fenced code between paragraphs, numbered steps with code in each
  item, and a fix with a diff, Python and a Markdown sample holding a definition, and requires
  that no prefix ending at a line break returns null.
- The seeded property's line set gains a four-space fence.

Checks on the fixed tree: `npm run typecheck` and `npm run lint` passed;
`npx vitest run tests/message-markdown.test.ts`: 36 passed; `npm test`: 169 files, 2505 tests
passed; `npm run build` passed; `npm run test:e2e`: 3 passed in Chromium.

### Red proof, round 2

- The new render case failed on `7aa08d8` before the fix: the live HTML lacked the code block's
  second newline.
- Removing the four-space fence rule: the new render case failed.
- Dropping the "list seen" condition: the case where a four-space fence with no list above it
  keeps its blocks failed.
- Lowering the threshold to three spaces: the numbered-steps reply returned null at its fences,
  and the three-space list fence case failed.
- Raising it to five spaces: the new render case failed.
- The seeded property did not catch the missing rule at seed 7. A scratch fuzz with a different
  generator (xorshift32) over list markers, indented fences, quotes and definitions passed
  10,000 cases each at seeds 11, 23 and 99 on the fix, and found divergences at all three seeds
  within 3,000 cases with the rule removed. It was not committed.
