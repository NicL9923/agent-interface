# November 12 the add-on cuts a window that starts inside a turn

Branch `t3/36e26aad` over `origin/main` at `1e3cb31`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10,
Node 24.22.2. Nothing was deployed.

## Defect

Found by reading code, from a design review's lead; not yet measured on production. The server's turn read asks
the add-on for a window that starts at the running turn's first saved message (`src/server/hermes.ts:577`,
`readTurn`). For a turn whose prompt is hidden, such as a routine's, an auto-continue or a delegated result, that
message is a reply. `history_window` refused any cut that would start on a row other than a user row and
returned the whole history, which the add-on then copied (`detached`) and sent over the socket. The server cut it
again with `historyWindow` in `src/shared/history.ts`, which does start at a reply, so responses were correct and
only the cost showed. `patch`'s canonical session has 8,805 rows with 26 MB of content. A web client's own
`start=` read takes the same path when the oldest message it holds is a reply.

The refusal kept bodies identical when the add-on started cutting windows (65db481): a reply takes its origin
from the prompt before it, which a cut at the reply would leave out.

## Change

`history_window` cuts at a named start inside a turn, as `historyWindow` does, and keeps the prompt before it as
context, so the server gives its replies the origin the whole history gives them.

## Tests and red runs

- `tests/hermes_extension_journal_test.py`: a start inside turn 15 keeps rows 6 and 7 for files and row 30, the
  turn's prompt, as context. A start inside the first turn has no prompt to keep.
- `tests/app.test.ts` "answers a window Hermes already cut exactly as it answers its own cut": its model of the
  add-on's cut now cuts at `?start=a12`, and the server's bodies stay identical for all six window shapes (four
  now cut by Hermes, was three).
- `tests/hermes-adapter.test.ts`: a window cut inside a turn gives its replies the scheduled origin of the kept
  `[Cron delivery: …]` prompt.

`python3 .agents/tools/mutate-py.py --batch` against `python3 tests/hermes_extension_journal_test.py`:

| Mutation | Result |
| --- | --- |
| refuse mid-turn cut again | failed: test_a_start_inside_a_turn_cuts_there_and_keeps_the_prompt_its_replies_answer (exit 1) |
| drop the turn's prompt | failed: test_a_start_inside_a_turn_cuts_there_and_keeps_the_prompt_its_replies_answer (exit 1) |

Not exercised: real Hermes, release qualification, and a production measurement of turn reads.
