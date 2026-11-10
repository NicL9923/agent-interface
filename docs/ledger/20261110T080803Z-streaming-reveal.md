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

## Review round 1 (GPT-6.1 Sol)

Four findings, fixed in one commit over `8753e3d`.

1. The 30 a second cap broke across arrivals: an arrival painted during render, then the frame
   loop restarted with no memory of it and painted again a frame later. The hook now keeps the
   last paint's time and length across updates. A continuing update that lands within
   `MIN_FRAME_MS` of the last paint keeps showing what showed and waits for the next paced frame.
   A row's first text, a new reply, a hidden tab and reduced motion still show at once. The
   deadline is now "within `CATCH_UP_MS`, plus the wait for the next paced paint", under
   `MIN_FRAME_MS` and a frame. The README says "about a third of a second".
2. The caret overlapped right-to-left text. Browsers do not agree on a collapsed range's
   rectangle: the CSSOM spec and web-platform-tests give it no client rects, Firefox has returned
   an empty list, and which side of a bidirectional boundary it reports is a known weak spot. So
   the caret measures the last grapheme and the one before it with ordinary ranges, which every
   engine supports, and takes the grapheme's trailing edge in the direction it runs:
   `logicalEndSide`. A letter's direction is its script's, a digit runs left to right, and
   punctuation, spaces and symbols follow the browser's own layout of the grapheme before them on
   the line, else the paragraph's direction. Text flush with the reply's left edge puts the caret
   just outside it.
3. The caret stayed behind when a code block or table scrolled sideways. The reply listens for
   scroll in the capture phase and places the caret once a frame. It stays inside the visible part
   of the scrolling block.
4. The seeded pacing test asserted `text.startsWith(text.slice(0, length))`, true whatever the
   reveal returned. It now drives the real hook through a probe component that records what React
   committed, frame by frame, with the deadline and grapheme assertions. The other new tests on
   both branches were read for the same fault. The fixture-length assertion in the backlog test
   only checked its own input and became a comment.

`e2e/server.ts`'s Trail Cook streams back what follows "Echo: " and leaves the turn running, so the
browser suite can measure a live row. `.agents/tools/streaming-preview.ts` gained `CODE_BLOCK=1`.

### Browser, Chromium

`CODE_BLOCK=1 STREAM_CHARS=24 npx tsx .agents/tools/streaming-preview.ts 4190`, 900 x 800, the
live row's text length sampled on every animation frame for 7 seconds while an open code block
grew from 20,000 characters, the server sending 4 updates a second:

| Build | Text changes in each second | Least gap | Median gap |
| --- | --- | --- | --- |
| `8753e3d`, before | 32 in all 7 | 15.2 ms | 33.3 ms |
| This round | 30 in all 7 | 32.3 ms | 33.3 ms |

`e2e/live-reply.spec.ts` streams four texts and checks the caret against Chromium's layout of the
last word, one grapheme at a time, with a screenshot of each: Arabic alone, caret left of the last
word; Latin alone; Hebrew then a Latin word; Arabic then a number, caret right of "2026", between it
and the Arabic. At 390 px wide, it scrolls an open code block 24 px and the caret follows the last
character, then past the last line and the caret waits at the block's visible edge. Safari and
Firefox: not run.

### Red proof

Each was watched failing, then restored:

- The head's hook with the new pacing test: least gap 2 ms after an arrival, against 32.3.
- The hook ignoring a shorter text, with the probe test: "run 0: … is a prefix of …" fails.
- `visibleLength` without the grapheme cut: "cut between graphemes: expected 21 to be 28".
- The reveal's speed allowed to drop: "run 0 at 1034: expected 162 to be ≥ 231".
- The head's caret code with the e2e suite: right-to-left text, caret at 459 to 461 over the last
  letter at 457 to 461; code block scrolled 24 px, caret left 26 px behind.
- No scroll listener, and placing on every scroll event, with the jsdom scroll test.
- `logicalEndSide` taking the right edge of a right-to-left letter, and ignoring the grapheme
  before punctuation: the rule's table test.

### Checks

- `npm run typecheck` and `npm run lint` passed.
- The six files above: 202 tests passed.
- `npm test`: 181 files, 2935 tests passed.
- `npm run build` passed. `npm run test:e2e`: 14 passed in Chromium.

## Review round 2 (GPT-6.1 Sol)

One finding on this branch, fixed over `da17e8c`.

1. The caret still covered a glyph where two writing directions meet with no space. In `عام2026`
   the digits' trailing edge touches the Arabic, and in `helloمرحبا` the Arabic's trailing edge
   touches the Latin `o`, so the fixed gap put the caret inside the other run. The rule, in
   `clearEnd`: the caret goes past the logical end as before unless another glyph on the line lies
   within its gap and width there. Then it goes past the end of the line in the paragraph's
   direction, beyond every glyph on it, the right end in this app's left-to-right paragraphs, which
   is also where the next word goes when it runs that way. Drawing it on the boundary cannot clear
   both glyphs, since their boxes touch. The line's glyphs are its words measured whole without the
   spaces between them, read back from the end until a word lies on a line above, so a space
   between Arabic and a number still leaves the caret in it, as cleared.

### Browser, Chromium

`e2e/live-reply.spec.ts` gained both unspaced cases and a wrapped line whose last word has a
longer word above it. Every case now asserts that the caret's box meets no box of a grapheme of
the reply other than spaces. The screenshots show the caret right of the line's last glyph in both
unspaced cases and unchanged in the cleared ones: Arabic alone, Hebrew then Latin, Arabic then
digits with a space, Latin alone, the wrapped line. Safari and Firefox: not run.

### Red proof

- The e2e suite on `da17e8c`: both unspaced cases fail, the caret at 477.8 to 479.8 over the `o` at
  472.9 to 481.8.
- `clearEnd` never moving the caret, and moving it to the wrong end: "moves past the line's right
  end when a glyph touches the logical end" and "… left end in a right-to-left paragraph" fail.
- The line walk counting words on lines above: the wrapped-line case fails, the caret pushed past
  the longer word above.

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `tests/streaming-reveal.test.ts`, `tests/live-reply-ui.test.ts`, `tests/message-markdown.test.ts`:
  82 tests passed.
- `npm test`: 181 files, 2939 tests passed.
- `npm run build` passed. `npm run test:e2e`: 17 passed in Chromium.
