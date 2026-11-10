# November 10 revealing a streaming reply at a steady pace

Branch `t3/streaming-reveal` over `f436f66`, then merged with `main` at `3bfd79d` (#306, turn events), on NicolasLaptop (Fedora, Linux x64), Node 24.22.2.
Web client only; no server, Hermes or iOS code changed.

## Application tests

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/streaming-reveal.test.ts tests/live-reply-ui.test.ts tests/message-markdown.test.ts tests/app-ui.test.ts tests/shell-ui.test.ts tests/transcript-rerender.test.ts`: 6 files, 169 tests passed.
- `npm test`: 177 files, 2785 tests passed.
- `npm run build` passed. `npm run test:e2e`: 8 passed in Chromium.

After merging `main` at `3bfd79d`:

- `npm run typecheck` and `npm run lint` passed.
- The six files above: 192 tests passed.
- `npm test`: 181 files, 2925 tests passed.
- `npm run build` passed. `npm run test:e2e`: 9 passed in Chromium, including main's new reply
  streamed through a tool call.

## Parse cost

`npx vitest run --config .agents/tools/streaming-parse-bench.config.ts --silent=false`, jsdom, the
last 1,000 of 20,000 characters streamed as 8 updates 250 ms apart:

| Reply | Before: parses/s, median | After, capped at 30/s | After, uncapped (60 Hz) |
| --- | --- | --- | --- |
| Prose, last block one paragraph | 5.0, 0.65 ms | 26.5, 0.48 ms, 13 ms/s | 60.5, 0.47 ms, 29 ms/s |
| One open code block of 20,000 characters | 4.0, 5.0 ms | 25.5, 4.7 ms, 122 ms/s | 63.5, 4.8 ms, 308 ms/s |

Finished blocks did not re-parse in either run. The cap, `MIN_FRAME_MS`, keeps the worst case
near 12% of a second's main thread in jsdom instead of 31%.

## Browser

`npx tsx .agents/tools/streaming-preview.ts 4190` on this branch's build, and on port 4191 from a
`main` build, with a Playwright script sampling the live row's text length on every animation
frame while a 1,600-character answer streamed at 150 characters a second (14.3 s, Chromium,
900 x 800):

| Build | Text changes/s | Characters per change, median and max | ms between changes, median and p95 | Long tasks |
| --- | --- | --- | --- | --- |
| `main` at `f436f66` | 4.0 | 36, 45 | 250, 250 | 0 |
| This branch over `f436f66` | 29.4 | 5, 26 | 33, 50 | 0 |
| `main` at `3bfd79d` | 4.0 | 36, 54 | 250, 250 | 0 |
| This branch merged with `3bfd79d` | 28.2 | 5, 26 | 33, 50 | 0 |

After the merge the preview sends versioned reads and `turn` events as `e2e/server.ts` does.

The caret showed after the last character of a list item mid-stream and was gone once the
reply was saved.

## Red proof

Each line was broken by hand, the named test went red, and the line was restored:

- Reduced motion ignored: "shows an update at once when the system asks for reduced motion".
- The reveal's speed allowed to drop on a new update: "clears a large backlog within the
  catch-up time..." and the seeded pacing-rule test.
- The `visibilitychange` listener removed: "shows an update at once in a hidden tab...".
- The cut ignoring graphemes: "cuts only between graphemes".
- The continuation check removed: at first nothing failed, because the test's new text was
  shorter than what showed. The test now uses a longer text and goes red.
- A row's first text paced from empty: three tests, including the first-text and caret tests.
- `LiveMarkdown` rendering the revealed text without the hold-back: "keeps holding back a
  half-revealed marker...".
- The caret without `aria-hidden`: the caret unit test and the app test.
- A saved row rendered as live: the app test, through the caret check.
