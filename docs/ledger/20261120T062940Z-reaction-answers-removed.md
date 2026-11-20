# Reaction answers removed before the pull request

Branch `t3/research-openbot-chat-bubbles`, from `4586b3b4` through `061510af`. Node v24.22.2 on
LaptopServer (Fedora). Three independent reviews each found a blocker in reaction answers: one tap
could approve a newer question than the one the person saw. Closing that needs a conversation version
checked inside the Hermes add-on's admission lock and a durable record of refused sends, a change to
the send path that the feature does not justify. The feature was taken out of this pull request.
Chat bubbles, the message rail, the table edge fades and the cascade layer fix stay.

## What was removed

The feature came in through `2d65cf5a`, `2be06d3c`, `00055614`, `8bb38de9`, `4f250997`, `349f606b`,
`4efe141e`, `f47d53fe`, `7f316670` and `c80ebce6`. It was removed with ordinary edits, not reverts,
because later commits and two merges of origin/main sit on top.

- Web app (`b621cbff`): `src/app/Reactions.tsx`, `src/app/reactions.css`, the React control in
  `ReplyActions.tsx`, the face icon, the reaction handling in `Conversation.tsx` and `App.tsx`, the
  answer path through `use-submission.ts` with its `answer_stale` refresh, `answering` on `Pending`,
  the reaction exclusions in `sent-echo.ts`, `Composer.tsx` and `use-draft.ts`, the horizontal mode
  of `use-menu.ts`, the menu key exemption and `refresh` in `use-conversation.ts`, the rail's rule
  that a reaction gets no tick, and prompt recall's skip. Tests: `tests/reaction-answers-ui.test.ts`,
  the rail and prompt recall reaction cases.
- Server and shared contract (`36e09900`): `src/shared/reactions.ts`, `answering` with its four
  refinements and the route guard, the `fresh` read option, `require_idle` for answers and the 4091
  mapping, `withdraw` in the store, the `reactionAnswers` capability, `answer_stale` and its message,
  the qualification input binding, and the shared `activeStates` list the guard introduced.
  `isHumanMessage` moved back to `transcript-logic.ts` and `withMessageOrigins` takes `Message[]`
  again, as on main. Tests: `tests/reactions.test.ts`, `tests/reaction-answers-api.test.ts`, the
  adapter cases, the add-on journal case and the fixture capability. The contract fixture
  `bootstrap.json` lost the capability.
- Docs and tools (`7ceb2a2a`): the "Reaction answers" section of `docs/native-api.md`, the README
  paragraph and the rail's "a reaction gets no tick", `PREVIEW_REACTIONS` in `preview-app.mjs` and
  its line in `.agents/tools/README.md`.
- Ledger: `20261120T041822Z-reaction-answers-web.md` is deleted. The two chat review fix entries
  keep their record and point here.

`git diff d6b53105 -- src/server src/hermes` now shows only `chatStyle` and `ownBubble` in the
preferences schema and the bootstrap save. Every file that only reaction commits touched matches
`d6b53105` again.

## What was kept, and why

- The meta row's `flex-wrap` in `src/styles.css`, from `2be06d3c`. It stands without reactions. At
  320 px on a touch context with Share stubbed, five 44 px actions fit with 3 px to spare at the
  default text size. At 125% root text, turning the wrap off squeezes the time to 46 px with no
  room left; with it on, the actions take their own line (`320-touch-share-125pct-text.png`). No
  test covers it.
- `docs/OpenBotDesignNotes.md` is unchanged here; its reaction paragraph is the orchestrator's to
  rewrite.

## Not carried over

The React menu was the only reason for the `role="menu"` key exemption in `use-conversation.ts`.
`ApprovalCard.tsx` also renders a `role="menu"` inside the transcript. Read from the code, not run:
on main, the arrow keys, Home and End pressed in that menu still reach the transcript's
`scrollIntent` and can take it out of follow mode. That predates this branch and is left for its own
change.

## Checks

All on the working tree that became `061510af`, except the build, which ran before the commits on
the same content.

| Check             | Command                                                                                                                       | Result                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Typecheck         | `npm run typecheck`                                                                                                           | Compiled, no errors                                                                                             |
| Lint              | `npm run lint`                                                                                                                | Passed                                                                                                          |
| Format            | `npm run format:check`                                                                                                        | Passed after `061510af`; at `4586b3b4` it failed on `20261120T045632Z-chat-bubbles-ios-followup.md`             |
| Build             | `npm run build`                                                                                                               | Built                                                                                                           |
| Unit and UI       | `~/.agents/tools/linux-heavy-lock.sh` around `npm test`                                                                       | Unit-passed: 229 files, 4,183 tests, 45.88 s after 1,675 s queued                                               |
| Python            | `.agents/tools/check-all --only py --py always`, same lock                                                                    | Unit-passed: 52 files, 7m03s                                                                                    |
| Contract fixtures | `UPDATE_CONTRACT=1 npx vitest run tests/native-contract.test.ts`                                                              | Only `bootstrap.json` lost `reactionAnswers`; the regenerator's reformatting of 24 other fixtures was discarded |
| Browser           | `PREVIEW_PORT=3427 node .agents/tools/preview-app.mjs`, then `PREVIEW_SECURE_FLOW=login` for accepted sends, `playwright-cli` | Runtime-exercised, below                                                                                        |

Browser, in sessions `rmreact` and `rmreact320`, both closed, and the preview stopped by the process
listening on 3427. Screenshots are in `.private/remove-reactions/`, which Git ignores.

- 1440 px: the last reply's actions are Copy, Listen, Save and Quote, and no button on the page is
  named React (`1440-reply-actions.png`). Replies render in bubbles. The rail jump to turn 47 moved
  the view and marked that tick (`1440-rail-jump.png`).
- 390 px: the same four actions, no React, bubbles drawn, no rail, page width 390
  (`390-reply-actions.png`).
- Sends: with the default fixture, which never confirms a send, an ordinary message and a typed 👍
  each showed "Not confirmed yet", the same notice and the same discard wording, and the 👍 got a
  rail tick (`1440-*-send-unconfirmed.png`). With `PREVIEW_SECURE_FLOW=login`, both were accepted
  and cleared the draft (`1440-*-send-accepted.png`).

Not run: the e2e suite and native iOS checks. Another agent is changing stylesheets in a separate
worktree, and the orchestrator runs the full battery after merging both.
