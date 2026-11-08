# November 7 assistant terminal request card

Validated on the working tree of branch `t3/mobile-terminal-chat-card`, not yet committed. No real Hermes
execution ran; the add-on tests use `tests/hermes_chat_reply_test.py`'s fake native `server_requests`.

Checks: `python3 scripts/run-python-tests.py` (37 passed), `ruff check .` 0.17.3 (clean), `npm run lint`, `npm run typecheck`,
`npm run build`, and `npx vitest run` (the only failures were the server and sign-in work in the same tree).

Protecting tests, each broken by hand once, then restored:

- Command with a hidden character or line break: dropped the `HIDDEN.search` guard in `terminal_command`;
  `test_a_terminal_request_refuses_without_a_person_and_bad_arguments` went red. The same test first caught a real bug: trimming before
  the check silently accepted `"ls\r"`.
- Settling a request of another kind: removed the `request.method != method` check in `settle_request`;
  `test_a_handoff_card_cannot_be_settled_as_a_terminal_request_or_the_reverse` went red.
- Done limited to terminal administrators: disabled the check in `src/server/terminal-requests.ts`; both administrator tests in
  `tests/terminal-requests.test.ts` went red.
- Command shape in the mapping: accepted any string in `openRequests`; the terminal case in `tests/hermes-adapter.test.ts` went red.
- Paste once per card: removed the `opening.at <= lastPasted` guard in `ComputerPanel.tsx`; the reconnect test in `tests/computer-ui.test.ts` went red.
- No paste of a line break: removed `terminalCommandPattern.test` in `ComputerPanel.tsx`; the newline test went red.
- Card disables Done when the terminal is unavailable: removed it in `TerminalRequestCard.tsx`; its test went red.

The manifest `src/shared/qualification-inputs.json` now lists `src/server/terminal-requests.ts` and `src/hermes/computer.py` changed, so
the Hermes qualification receipt needs a new run before release.
