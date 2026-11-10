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
