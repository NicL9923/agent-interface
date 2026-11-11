# November 10 a send Hermes put into the running turn is marked as a steer

Branch `t3/joined-as-steer` over `origin/main` at `acec071`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10,
Node 24.22.2, ruff 0.17.3. Source fingerprint `sha256:a4486586518a15a5c2c10163c7e033382590552acb760bdbd952b9c0c654972e` (1766 source files) with the change applied, before this
entry. Hermes behavior was read from the local upstream clone at `ed1afb0` (`agent/interrupt_control.py`
`steer` and `redirect`); no Hermes process ran, nothing was deployed and the production host was not touched.

## Defect

A new task Hermes answered `steered` or `redirected` is saved with `steering = 0` and `turn: "joined"`, and nothing ever
bound it to a row. Its saved copy carried no steer mark, so other devices did not show "Added to the current task".
`bind_steers` only looks at `steering = 1` receipts whose root, a receipt, has kept the turn's rows.

Hermes appends a steer and a redirect as a real user row inside the running turn, not as a new task
(`interrupt_control.py` `steer` and `redirect`), so the row is among the turn's committed rows.

## Change (`src/hermes/extension.py`)

- A joined send is its own run, because the turn it joined is usually another client's and no receipt holds that turn's
  rows. When the answer is accepted as `joined` and the session is running, `admit_native` registers its request ID for
  that session (`Bridge.joined`, memory only).
- `keep_joined_turn`, called with `bind_turn_row` at every `message.complete`, takes the registered sends of the session
  and keeps the completion's `persisted_turn.row_ids`, without its `user_row_id`, as each one's `turn_rows`. A completion
  with no rows, or no prompt row to leave out, keeps none. Leaving the prompt row out stops a native prompt with the same
  words from taking the send's place.
- `bind_steers` also selects receipts with `steering = 0`, their own `run_id` and an admission answer of `turn: "joined"`,
  so the existing rule binds them: one user row in the kept rows with exactly its words, saved no more than a second
  before the send, held by no receipt, and no other receipt of the run with the same words. A later app send into that
  turn already steers into the joined send's run, so that last guard covers it.
- `attribute` marks a row `app_steering` for `steering = 1` or a joined answer.
- The answer and the receipt still say `steering: false` and `turn: "joined"`, so nothing the server or the clients read
  changed shape. Documented limits are kept: `docs/HermesCapabilityMatrix.md` (the binding rule, the unbound-by-design
  list and the admission-turn paragraph) and `docs/native-api.md` say it.

Limits that remain, each fails to unbound: a restart before the turn completes loses the registration; a joined answer
for a session that is idle binds nothing; a turn that ended its `message.complete` but still drains a queue can hand the
registration to the drain's completion, where the time guard and the exactly-one-row rules still apply; and the existing
known limit, a native client's identical words saved in the same turn after the send was sent, can take the send's place.

## Tests

`tests/hermes_turn_binding_test.py`, against the fake Hermes turn lifecycle (39 tests, 6 new or changed):

- A redirected send into another client's turn binds to the row its turn delivered, nothing binds while the turn runs,
  and the open marks that row `app_steering` and no other. The queued-versus-joined table now expects a bound, marked row
  for joined and none for queued, with and without an image.
- A joined send whose turn never delivers it, with the same words as that turn's own prompt, stays unbound.
- A steer into a joined send's turn with the same words binds neither.
- A completion with no rows, malformed rows or no prompt row binds nothing, and so does one that lists rows without the
  prompt row.
- A send answered joined while the session is idle is not bound to a later turn.

## Red proof

A scratch runner applied each replacement, deleted every `__pycache__`, ran the test file with `python3 -B` and
`PYTHONDONTWRITEBYTECODE=1`, and restored it.

| Broken | Red |
| --- | --- |
| Joined send never registered | queued/joined table, redirected-send test |
| Registered while the session is idle | idle-answer test |
| Registered for every accepted turn | two-members-behind-one-turn test |
| Completion never keeps the rows | queued/joined table, redirected-send test |
| Turn's own prompt row left in | undelivered-correction test |
| Completion with no prompt row trusted | no-prompt-row test |
| Completion with no rows trusted | unusable-rows test |
| `bind_steers` ignores joined sends | queued/joined table, redirected-send test |
| The mark ignores joined sends | redirected-send test |

Two breaks stayed green and the code was changed instead of the tests. A `turn_rows IS NULL` guard on the update could
not matter, since the registry hands each send out once, and a second marking branch in `attribute` for non-integer row
IDs cannot bind a joined send, which binds only integer rows; both were left as they were before (the guard removed, the
branch not edited). Selecting any receipt that is its own run instead of only joined ones is equivalent: an ordinary
root with kept turn rows always has its row, so `row_id IS NULL` excludes it already. The joined test stays as the
explicit statement of which receipts bind.

## Checks

`npm run test:py` 45 files passed; `ruff check .` clean (0.17.3); `npm run typecheck`, `npm run lint` clean; `npm test`
205 files, 3645 tests passed; `npm run build` passed.

Not exercised: a real Hermes, a real compaction or queue drain, iOS, and production. The app server and web client did not
change; they already render `app_steering` as the steer mark.

## Review: Claude Opus 5.5 on `a0ab22a`

Same-provider review: the cross-provider reviewers were unavailable, so this branch's pull request carries the
`independent-review-owed` label. Approved, no P1 or P2. One P3, applied by the orchestrator, Claude Opus 5.5: the
capability matrix said the add-on keeps "that turn's" next completion, where the code keeps the session's next one.
Upstream emits `message.complete` before it sets `running = False`, so a send answered joined in that moment takes the
following completion; in steer mode that is the turn the steer is delivered in, and in interrupt mode Hermes answers
queued and nothing registers. The matrix now says so. The reviewer broke six lines: five red, one equivalent.
