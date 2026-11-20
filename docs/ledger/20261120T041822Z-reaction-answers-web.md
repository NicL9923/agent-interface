# November 20 reaction answers on the web

Code state: `00055614` on `t3/research-openbot-chat-bubbles`, based on `4f6329e5`. The commits are
`2d65cf5a` (the shared rule), `2be06d3c` (the web UI) and `00055614` (docs and the preview fixture).
Node v24.22.2 on LaptopServer (Fedora). Hermes did not take part; the checks use the mocked client
API, the in-memory store and the preview fixtures.

A person answers the latest reply with one of 👍 ❤️ 😂 🎉 👎. The emoji is an ordinary message sent
through the composer's submit path, and it shows as a chip on the reply instead of as a row.
`src/shared/reactions.ts` holds the rule and `docs/native-api.md#reaction-answers` states it for iOS.

## Checks

| Check                   | Code state | Result                                                                                                                                                                                            | Evidence                                                                                              |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Typecheck               | `00055614` | Compiled                                                                                                                                                                                          | `.private/reaction-answers/typecheck.log`                                                             |
| Lint                    | `00055614` | Passed                                                                                                                                                                                            | `.private/reaction-answers/lint.log`                                                                  |
| Build                   | `00055614` | Built                                                                                                                                                                                             | `.private/reaction-answers/build.log`                                                                 |
| Full Vitest             | `00055614` | Unit-passed: 4,175 tests in 229 files, including `tests/reactions.test.ts`, `tests/reaction-answers-ui.test.ts` and the new cases in `tests/message-rail.test.ts` and `tests/shell-logic.test.ts` | `.private/reaction-answers/test.log`                                                                  |
| 21 deliberate mutations | `00055614` | Each went red for its intended reason. Source restored byte for byte after each run                                                                                                               | `.private/reaction-answers/red-*.log`, `mutations.json`; runner `.private/reaction-answers/mutate.py` |
| Fixture preview         | `2be06d3c` | Runtime-exercised in Chromium through `playwright-cli` against `PREVIEW_REACTIONS=1`, Kitchen companion's 64-turn fixture with another member's heart on the latest reply                         | `.private/reaction-answers/*.png`                                                                     |

The four verification commands ran inside `~/.agents/tools/linux-heavy-lock.sh`. The lock queued
for 668 seconds and the commands executed for 22 seconds.

### Mutations

Rule, against `tests/reactions.test.ts`: comparing without removing U+FE0F, comparing without
trimming, allowing files, counting any user-role message as a person's (so a scheduled prompt
counts), letting a tool row end the run, letting one reaction end the run, taking any assistant row
as a reply (so a progress line counts), and reading messages without their origins (so a reply to
an agent's prompt counts).

Readers, against their own tests: the rail ticking a reaction (`tests/message-rail.test.ts`) and
prompt recall keeping one (`tests/shell-logic.test.ts`).

Interaction, against `tests/reaction-answers-ui.test.ts`: sending the draft instead of the emoji,
naming the draft revision on a reaction, keeping a send without a receipt as a chip, drawing the
reaction's row, offering React while a turn runs, offering it on every reply, a reaction hiding
React on the reply it answers, the menu ignoring Left and Right, leaving focus on the removed
button after a send, a chip never marked busy, and another member's chip without their name.

### Browser

Each of Bubbles and Classic, light and dark, at 1440 and 390 px: the menu open, the chip while
sending, and the chip settled, 24 shots named `<style>-<theme>-<width>-<state>.png`. While sending
the chip read at opacity 0.55 with `aria-busy`, the early thinking row showed and the view followed
the end. The 390 px shots also show the fixture's "Update available" notice, and
`bubbles-dark-390-settled.png` its "Reconnecting live updates" notice; both come from the preview
after rebuilds, not from this change.

`failed-send-row-bubbles-light-1440.png` is a reaction whose send died with a killed preview: it
reads as a message row with "Not confirmed yet" and the composer's Retry, as intended.

The keyboard path ran end to end at 1440 px: Tab from Quote reached React; Enter opened the menu on
Thumbs up; Right, End, Right (wrapping to the first) and Left moved focus; Escape closed it on React;
Space reopened it; Right twice and Enter sent Laugh. Focus then sat on the Conversation region, the
status region read "You reacted laugh.", and the chips read "Jordan reacted heart" and "You reacted
laugh, sending" until the fixture accepted it.

Two defects were found and fixed before the commits. At 320 px on a touch context with Share
available, the meta row was 308 px in a 280 px column and pushed React to x = 328; the row now
wraps and React ends at x = 294 (`touch-320-*.png`). The overflow predates this change for five
actions; React made it worse. At 200% root font size and 390 px, the menu, anchored to the React
button, started at x = -230; it now anchors to the reply's meta row, keeps to the column and wraps
to two rows (`text-200-390-menu.png`). Forced colors at 1440 px keep the chip borders and a visible
focus ring; the emoji draw as monochrome glyphs there, which is Chromium's forced-colors behavior
(`forced-colors-1440-*.png`). Menu targets measured 44 by 44 px on touch and 40 by 40 px with a
mouse; React itself is 44 px on touch and 32 px with a mouse, as the other actions are.

## Readers of the message list

- Find in chat matches only shown rows, so a reaction is not a local match. A server hit on a
  reaction's ID now lands on its chip: `messageElement` in `src/app/use-conversation.ts` falls back
  to `[data-reaction-id]`. Read positions and the rail still read `[data-message-id]` only.
- Quote, copy and read aloud act on the reply's own text and are unchanged.
- Unread, the home preview and the in-chat new-message count still count a reaction as a message.
- A reaction send follows the end of the chat (`jumpToLatest`) instead of anchoring, since it draws
  no row to anchor; this also marks it seen.
- Prompt recall skips reaction answers; a lone emoji that answers nothing is still recalled.

## Not exercised

No screen reader pass, no WebKit or Firefox run, no Playwright e2e suite, no physical phone and no
`check-all`, which the orchestrator runs on the integrated branch. No independent review ran on
this change. iOS is unchanged; the native API section is its contract.
