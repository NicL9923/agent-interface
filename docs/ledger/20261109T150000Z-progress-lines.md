# November 9 assistant progress lines

Branch `assistant-progress-lines` over `7a1f782` (origin/main). Checks ran on NicolasLaptop (Linux,
Node 24.22.2, Python 3.14.10) at the commit that carries this entry. Hermes revision read:
`ed1afb082e`, the one the Hermes capability matrix already records for production. No iOS
build, simulator, physical device, live Hermes turn or deployment ran.

## Web and server

- `npm run lint`, `npm run typecheck` and `npm run build` passed. `npx vitest run`: 169 files,
  2,451 tests passed. `npm run test:py`: 40 files passed (the add-on test reads the new
  `src/shared/progress-line-instructions.json`). `ruff` is not installed here, so `lint:py` did not
  run; no Python beyond one line in `extension.py` changed.
- `tests/native-contract.test.ts` regenerated `ios/AgentInterfaceTests/Contract/conversation.json`
  with one progress line. The generator also reordered keys in three routine fixtures; those were
  restored, since the test compares deeply.

## Real Hermes, read-only

On `hermes-prod`, with bytecode writing off, `agent.history_commentary._project_one` at
`ed1afb082e` ran on four real assistant rows whose `codex_message_items` hold phase `commentary`
items, copied out of `state.db` opened `mode=ro&immutable=1`. Enabled, each row yields
`display_commentary` with one redacted line plus `display_reasoning`. Disabled, each yields `[]`.
Every row has empty `content`. The real lines are longer than one sentence and carry Markdown, such as
`**68 tools**`, so they render as Markdown and the length cap is 1,200 characters. One temporary
script was copied to `/tmp` on the host and deleted afterwards; nothing else on the host was written.
`load_config` was not called, so the gate itself was not read from the host. Not exercised: a live turn,
the `message.interim` frame on a real socket, and a model obeying the new guidance.

## Independent review

GPT-6.1 Sol (`gpt-6.1-sol`, high effort, read-only, a separate worktree) reviewed `2e9b344`. Three
findings, each verified before it was fixed:

- A saved progress line cut at 1,200 characters left the rest in the live tail, which
  `watchReplies` then announced as a reply. Confirmed by the reviewer through the real mapping
  functions. Fixed by never cutting or dropping a line (the length, count and repeat limits are
  gone), with a test that streams a 2,000 character line and a repeated line and expects no tail.
- Saved history pages decode through another schema that stripped `display_commentary`,
  `display_content` and `display_reasoning`, so archived chats lost their lines and kept flattened
  ones, including with commentary off. Confirmed: the add-on projects those rows with the same native
  function (`experience.py` `discovery`). Fixed in `hermes-operation-contracts.ts`, sharing
  `progressLines` and `displayCopies` with the live read, with `tests/history-progress.test.ts`.
- iOS `Artifacts.replyFiles` took a progress line as the reply and put file chips under it. Fixed with
  `!message.isProgressLine`, and a vector in `reply-artifacts.json`, which both clients read. Not
  compiled or run.

A second review of the fix commit and PR 2 (same reviewer) found one more defect in this PR: the web's
saved-history view offered Save reply on a progress line, which saved a made-up ID that Hermes's
`history_pointer` cannot resolve, so the bookmark never reopened. The save route now refuses one with 400
and a reason, and the view offers no button; iOS already offered none. Both are tested and mutated.

## Mutants

Each line below was broken by hand, its focused suites run, and the source restored (the runner is
not committed). 32 mutants over the final code. 30 failed their tests at once. Three of the first 22
survived, and each got a sharper test and then failed:

- Skipping progress lines when choosing where the work folds survived, because the tools had come
  first in the first fixtures. A turn with tools, a line, then the answer now pins it.
- Not joining a progress line to the answer beside it survived, because tools sat between them. A
  turn with no tools now pins it, including the answer keeping its own time.
- The memo comparison ignoring `interim` survived. A rerender test now marks a saved line after
  the fact.

After the review, the length, count and repeat mutants were replaced by mutants that put a cut and a
repeat drop back (both killed), and nine more covered the history page: lines shown, the display copy
of the reply and of the reasoning, the row's origin on its lines, and display copies for assistant rows
only. That last one survived until a test fed a user row and a tool row display copies.

Killed on the first pass: the `display_commentary` array guard, the assistant-only guard, the string
check, the guard against repeating the answer, `display_content`, `display_reasoning`, the `interim`
mark, the window cut by rows, `isConversationReply` excluding progress lines (Talk, read aloud, Today),
no meta row or inline pages on a progress line, the `message-interim` class, the unread counter, Retry
ignoring a progress line, the duration ending at the answer, and the add-on guidance.

## iOS

Written and not compiled or run: `Message.interim`, `isProgressLine`, the turn fold, reply joining, Retry,
read aloud, the unseen count, copy and listen actions, offline library, saved history reply, quieter style,
and tests in `ContractFixtureTests`, `PresentationTests`, `ReplyAnnouncementTests`, `ReviewFixTests` and
`OfflineLibraryTests`. Pending on the Mac mini: the Swift build, those suites, and a simulator look at the
quieter style.
