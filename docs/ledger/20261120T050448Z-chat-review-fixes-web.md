# November 20 chat review fixes on the web

The reaction answers work this entry describes was removed before the pull request; see
`20261120T062940Z-reaction-answers-removed.md`.

Branch `t3/research-openbot-chat-bubbles`, from `8bb38de9` through the merge of origin/main
`d6b53105`. Node v24.22.2 on LaptopServer (Fedora). Hermes did not take part; the server tests use
the in-memory store and the fake runtime, the UI tests the mocked client API, and the browser checks
the preview fixtures. An independent review of the chat bubbles, message rail and reaction answer
work reported the findings below. Each was replayed as a failing test on the code it was reported
against before the fix; logs are in `.private/chat-review-fixes/`, which Git ignores.

## What the earlier entries describe that no longer holds

- `20261120T041822Z-reaction-answers-web.md`: a reaction is no longer hidden and drawn as a chip on
  the reply before it. It is an ordinary message row. The rule about the first loaded message,
  `readReactions`, the chips, `[data-reaction-id]` in find, and following the end after a reaction
  send are gone. A reaction send now carries `answering`, anchors like any send, and the server
  refuses it with 409 `answer_stale` when the reply no longer ends the chat. Its mutation list for
  chips and the context rule no longer applies.
- `20261120T033142Z-message-rail.md`: the rail no longer always shows the newest ticks. It shows a
  window around the turn in view or the focused tick, and positions are measured once, not on every
  scroll. The mutations "keeping the oldest ticks instead of the most recent" and the `fitTicks`
  rounding case are replaced by the `railWindow` cases below.
- `20261120T033957Z-chat-bubbles-web.md`: a list or block quote that holds code, a table, media or a
  rule is no longer one bubble. "Every block kept its offset and size when it was saved" held for the
  replies streamed there; a reply whose link definition arrives late redraws its bubble when the
  definition arrives, which clears a selection in it. The renderer is unchanged; the README now says so.

## Findings

| Finding                                                                       | Reproduced                                                                                                                             | Now guarded by                                                                                                                                              |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One member can approve a newer question with a stale reaction (blocker)       | Yes: an answer to `a1` after the chat moved to `a2` was accepted, 200 instead of 409 (`red-api-guard.log`)                             | `tests/reaction-answers-api.test.ts`, every rejection branch and the accept path                                                                            |
| A picker 👍 cleared a saved 👍 draft and marked the revision sent             | Yes: draft `{ text: '' }` after the answer; an empty draft gained a `sent` revision (`red-api-guard.log`)                              | same file, three draft cases                                                                                                                                |
| A refused or discarded picker send put its emoji in front of the draft        | Yes: `'😂\n\nFeed the horses'` for a rejected receipt and for a 400, `'👍\n\nFeed the horses'` on reconciliation (`red-ui-before.log`) | `tests/reaction-answers-ui.test.ts`                                                                                                                         |
| A reaction's row depended on its neighbors (paging, find, anchoring, members) | Yes, by design: another member's ❤ drew no row (`red-ui-before.log`)                                                                   | `tests/reactions.test.ts` (`isReactionMessage` reads one message), UI row cases                                                                             |
| React missing on a reply with files and no text                               | Yes: no React button (`red-ui-before.log`)                                                                                             | UI case "offers React on a reply that has files and no text"                                                                                                |
| Home in the open picker switched the transcript from follow to free           | Yes: scrollTop stayed 2600 when a new message arrived instead of following to 3200 (`red-ui-before.log`)                               | UI case "keeps the transcript following the end while the open picker takes Home and End"                                                                   |
| Focus fell to `body` when an update removed the open picker                   | Yes: `activeElement` had no label (`red-ui-before.log`)                                                                                | UI case "moves focus to the conversation when an update takes away the open picker"                                                                         |
| The rail strands earlier messages                                             | Yes: scrolled to Question 1, no tick was current; Home reached Question 45 (`red-rail-ui.log`)                                         | `tests/message-rail-ui.test.ts` "a chat with more sent messages than ticks fit", `railWindow` units                                                         |
| The rail measured every loaded message each scroll frame                      | Yes: 640 row reads by the rail over 10 scrolls of a 64-message chat (`red-rail-ui.log`)                                                | "reads where each message sits once, not on every scroll"; "measures again once something above the messages changes size" guards the cache                 |
| Code nested in a list sat inside the bubble                                   | Yes: `bubble:p,ol,p` instead of `bubble:p`, `ol`, `bubble:p` (`red-nested-block.log`)                                                  | `tests/message-markdown.test.ts` "keeps a list or quote that holds a full-width block out of bubbles…" and "renders a list with nested code at full width…" |
| A late reference definition remounts a bubble; README promised more           | Yes: a live bubble node was replaced once `[a]: https://example.test` arrived, and again on save (scratch probe, not kept)             | Behavior unchanged on purpose; README now says a late link definition redraws the reply and clears a selection in it                                        |

## Red runs

Every fix line was broken by hand with `.private/chat-review-fixes/mutate.py`, which restores the file
byte for byte after the run. Each went red for its intended reason (`red-<name>.log`):

- Server guard: dropping the running-turn check, comparing against any message rather than the last,
  using a shared read, dropping each of the four `answering` refinements, allowing a steer, clearing
  the draft for an answer, recording the intent before the guard. Runtime: dropping the fresh-read
  bypass of shared reads, dropping the capability key.
- Web: restoring a refused answer into the draft, ignoring `answer_stale`, not reading the chat again
  after it, leaving `answering` off the request, dropping it from the retry, letting the transcript
  hear keys in an open menu, not moving focus when the picker goes, hiding React on a reply without
  text, ignoring the capability, the old discard copy. Rule: any assistant row is answerable, a live
  reply is answerable, origins ignored, files allowed, any role allowed; the rail and prompt recall
  not skipping a reaction.
- Rail: never revalidating the cache, clearing the cache on every scroll, anchoring on the active turn
  while a tick has focus, not focusing a tick beyond the window, keys limited to the window, always
  the newest window, no margin, recentering, a strict reading line, ignoring `scrollTop`, no earlier
  chevron, no `aria-describedby`.
- Bubbles: a holder never counted as a block, only direct children searched, `hr` not full width.

## Checks

| Check           | Code state             | Command                                                                    | Result                                                                                                                       | Evidence                                               |
| --------------- | ---------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Typecheck, lint | each commit            | `npm run typecheck`, `npm run lint`                                        | Compiled; passed                                                                                                             | terminal                                               |
| Build           | `65c68e3f`             | `npm run build`                                                            | Built                                                                                                                        | `.private/chat-review-fixes/build.log`                 |
| check-all       | `65c68e3f` (the merge) | `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going` | test failed (1 of 4,219, below), e2e failed (WebKit only), the rest passed                                                   | `.private/chat-review-fixes/check-all-65c68e3f.log`    |
| check-all       | `f47d53fe`             | same                                                                       | Every check passed except e2e, whose 89 WebKit tests could not start a browser                                               | `.private/chat-review-fixes/check-all.log`             |
| e2e baseline    | origin/main `d6b53105` | `check-all --only build,e2e --keep-going` in a clean worktree              | Build passed; e2e the same as this branch: 89 Chromium passed, 89 WebKit failed at browser launch. Baseline, not this branch | `.private/chat-review-fixes/baseline-e2e-d6b53105.log` |
| Browser         | `65c68e3f` build       | `PREVIEW_PORT=3424 node .agents/tools/preview-app.mjs`, `playwright-cli`   | Runtime-exercised in Chromium; see below                                                                                     | `.private/chat-review-fixes/*.png`                     |

The final run on `f47d53fe` (queued 227 s, ran 583 s):

| check     | result | run   | counts                 |
| --------- | ------ | ----- | ---------------------- |
| typecheck | pass   | 1.0s  | -                      |
| lint      | pass   | 1.0s  | -                      |
| ruff      | pass   | 0.0s  | -                      |
| test      | pass   | 18.0s | 232 files, 4,219 tests |
| build     | pass   | 2.6s  | 913 modules            |
| e2e       | FAIL   | 3m24s | 178 tests, 89 failed   |
| py        | pass   | 5m55s | 52 files               |

The e2e failures are the 89 WebKit tests, each stopped at `browserType.launch` with "Host system is
missing dependencies to run browsers" (`libicu74`, `libjpeg-turbo8`); all 89 Chromium tests passed,
including `e2e/stylesheet-order.spec.ts`. The first run, on the merge `65c68e3f` (queued 117 s, ran
597 s), also failed `tests/hermes-qualification.test.ts`: the send route newly imports
`src/shared/reactions.ts`, which the qualification inputs did not list. `f47d53fe` binds it.

## Browser

The preview served a copy of the `65c68e3f` build from `.private/chat-review-fixes/client`, with
`PREVIEW_REACTIONS=1` on port 3424 and `PREVIEW_REACTIONS=stale` on 3425, in a `playwright-cli`
session that was closed afterwards.

**Baseline defect from #457, not this branch.** `src/main.tsx` imports `App`, and with it every
component stylesheet, before `src/ui.css` declares `@layer theme, base, components, motion,
utilities`. The build links the component sheets first, so `components` is declared before `base`
and the base `button` rule beats every component's button styles. On an untouched origin/main
`d6b53105` build, `.message .reply-action` (authored `border: 0; padding: 0`) rendered with a 1 px
border and 10 px padding. On this branch the rail's ticks drew as bordered boxes with no marks and
the React menu's choices had borders. Files without `-layerfix` show the build as shipped. Files
with `-layerfix` were taken after inserting the layer statement as the head's first style and
re-adding the stylesheet links, which is how the cascade was meant to read; nothing in the
repository was changed for it.

- Picker, 1440 and 390, light and dark, Bubbles (`picker-*`), and Classic at 390: menu inside the
  column, first choice focused, no page overflow.
- Reaction sent: `aria-busy` row "Sending…" anchored near the top as any send is, focus on the
  Conversation region; settled as an ordinary row ("Just now") in all four combinations and Classic
  at 390 (`sent-*`).
- Floating composer at 390, scrolled to the end, Bubbles and Classic: the last reply ended at 766 px,
  React at 762 px and the reaction row at 766 px, above the composer area's top at 776 px. At 1440 the
  same rows ended at 820 px above 832 px.
- Stale answer, `PREVIEW_REACTIONS=stale` (`stale-*`): the alert read "The chat moved on, so your
  reaction was not sent.", the draft "Ask about the north gate" stayed, and Jordan's new message
  showed after the refresh.
- Rail on Kitchen companion at 1440×640, 19 sent messages loaded, room for 14
  (`rail-*-1440x640-layerfix.png`): at the end it showed turns 51 to 64 with an upward chevron and
  "5 earlier messages are not shown. Up and Down reach them."; scrolled to the first message it
  marked turn 46 and showed the downward chevron and "5 later…". Shift+Tab from the transcript
  reached the one tab stop; End, 25 × Up, Home and Down moved focus across the window's edges; Enter
  jumped to turn 48 and marked it; Tab left the rail. At 1440×900 all 19 fit and no chevron showed
  (`rail-*-1440-layerfix.png`). While a tick has focus the window follows focus, so the turn in view
  may be outside it until focus leaves.
- Code nested in a list (`nested-*`, a reply injected through a route with the service worker
  bypassed): Bubbles drew a bubble, the full-width list with its code inside the second item, and a
  bubble; Classic drew it flat. No page overflow at 390.

## Not exercised

No WebKit or Firefox run here (WebKit cannot start on this host), no screen reader pass, no 200%
text pass for the rail chevrons, no physical phone, no iOS build or test. The iOS app's
`CapabilityKey` lacks `reactionAnswers`, so `ContractFixtureTests` will fail on the regenerated
`bootstrap.json` until the app adds the case; that is outside this web change. No independent
re-review ran on these fixes.
