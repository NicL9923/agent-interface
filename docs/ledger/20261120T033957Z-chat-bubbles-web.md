# November 20 chat bubbles on the web

This entry covers branch `t3/research-openbot-chat-bubbles` from `18b9699a` through `9ce55e9a`, with the README and `docs/native-api.md` changes that land in the same commit as this entry. Node v24.22.2 on LaptopServer (Fedora). No Hermes took part; the server and UI tests use the in-memory store, the fake runtime and the mocked client API.

## Application checks

On `9ce55e9a` plus the uncommitted README and native API text, one run under `~/.agents/tools/linux-heavy-lock.sh` (queued 15 s, ran 33 s) passed `npm run typecheck`, `npm run lint`, `npm run build` and `npm test`: 225 test files, 4,134 tests, all passed. `.agents/tools/check-all` and the browser suite did not run here.

`tests/native-contract.test.ts` regenerated `ios/AgentInterfaceTests/Contract/preferences.json` and `bootstrap.json` with `chatStyle: "classic"` and `ownBubble: "solid"`. The iOS contract tests did not run; no Mac step ran.

## Red runs

Each test written to protect a line was run against a hand-broken copy of that line, then the file was restored and the test passed again.

| Line broken                                                                      | Test                                                                       | Result                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bootstrap-routes.ts`: drop `value.chatStyle ??= previous.chatStyle`             | models-api "saves the chat style per person…"                              | failed: expected `{ presentation: 'simple', … }` to match `{ theme: 'dark', … }`                                                                                               |
| `schemas.ts`: `ownBubble` as `z.string()`                                        | same                                                                       | failed: expected 200 to be 400                                                                                                                                                 |
| `MessageMarkdown.tsx` `pieceKind`: every element is prose                        | "reply bubbles" suite                                                      | 6 of 10 failed: table in the middle, code first, media, fence inside a block, streaming join, node kept                                                                        |
| `bubbleRuns` (first version, with lookahead): a new bubble for every prose piece | same                                                                       | 4 failed: prose only, streaming join, node kept, reported inputs                                                                                                               |
| `bubbleRuns` (committed linear version): never extend an open bubble             | same                                                                       | 3 failed: prose only, streaming join, node kept                                                                                                                                |
| `pieceKind`: an image-only paragraph is prose                                    | "keeps media and a thematic break out of bubbles"                          | failed                                                                                                                                                                         |
| bubble keyed by its last piece instead of its first                              | "keeps a bubble's node while the reply grows into it and once it is saved" | failed                                                                                                                                                                         |
| `PreferencesDialog.tsx`: Chat style saves `{}`                                   | app-ui "saves the chat style and own-message fill…"                        | failed: last write was not `/preferences` with `chatStyle: "classic"`                                                                                                          |
| Your messages always saves `"tint"`                                              | same                                                                       | failed on the `ownBubble: "solid"` write                                                                                                                                       |
| `Conversation.tsx`: `bubbles={true}`                                             | same                                                                       | failed: expected `<div class="reply-bubble">` to be null                                                                                                                       |
| `App.tsx`: drop `data-own-bubble`                                                | same                                                                       | failed: expected undefined to be `'solid'`                                                                                                                                     |
| `fadeSides` ignores direction                                                    | "fades each side that has more to scroll to…"                              | failed: expected `'right'` to be `'left'`                                                                                                                                      |
| `fadeSides`: `right = fromLeft < overflow`, no 1 px slack                        | same                                                                       | **survived** the first version, whose sub-pixel case sat at the start. The case became a scroll end 0.4 px short, and the rerun failed: expected `'left right'` to be `'left'` |
| `fadeSides`: `left = fromLeft > 0`                                               | same                                                                       | failed: expected `'left right'` to be `'right'`                                                                                                                                |
| `MarkdownTable`: no scroll listener                                              | "updates the fade as the reader scrolls the table"                         | failed: expected undefined to be `'right'`                                                                                                                                     |

## Visual checks

A client built before two last edits in `9ce55e9a`, served by `PREVIEW_PORT=3421 node .agents/tools/preview-app.mjs`, driven with `playwright-cli` in Chromium. Screenshots are in `.private/chat-bubbles/`, which Git ignores.

- Ranch hand at 1440 and 390 px, light and dark, Bubbles and Classic, Tinted and Solid: 16 shots named `<width>-<theme>-<style>-<fill>.png`. Measured at 1440 px: reply bubbles 600 px wide holding 77 characters a line; the table reply's corners read 18/18/18/8 px, then the table, then 8/18/18/4 px; the gap around the table is 6 px.
- Table fade with a wide table injected through a Playwright route at 320, 390 and 1440 px: `right` at the start, `left right` after three ArrowRight presses with the region focused, `left` at the end. No page overflow at 320 px.
- Forced colors, `prefers-contrast: more` and 200% root font size at 1440 and 390 px: both bubbles draw a border, and nothing overflows or clips.
- Solid fill contrast, white text on the computed fill, the same in light and dark: #1084FE 5.59, #FF6700 5.95, #00BCA6 4.88, #FF263C 5.65, #FF309B 5.70, #9159FE 6.19, #FF9800 5.73, #97683D 5.66, #292929 14.55. File chip text matches the bubble text.
- `STREAM_CHARS=12 SAVE_DELAY_MS=1500 npx tsx .agents/tools/streaming-preview.ts 4190`: the answer grouped as bubble, code, table, bubble while it streamed, and every block kept its offset and size when it was saved. The caret sat 2 px after the last character, on its line, inside a bubble.
- Kitchen companion: 40 rows, 20 reply bubbles, find in chat highlighted 21 matches inside bubbles, and a selection inside a bubble showed Quote.
- `PREVIEW_PROGRESS=1`: progress lines stay flat. A group chat shows no bubbles.

The two edits that came after these captures were not captured again: another member's name moves to the trailing edge only over a bubble, so a scheduled prompt's label stays put, and bubbles apply only to assistant rows, so a scheduled prompt renders flat as before. The unit and UI suites above ran on them.

Not exercised: Safari and Firefox, a physical phone, a screen reader, and the iOS app.
