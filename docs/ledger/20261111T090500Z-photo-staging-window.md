# November 11 a member's photo and the turns that can take it

Branch `t3/photo-staging-window` over `origin/main` at `7d794ef`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10,
Node 24.22.2, ruff 0.17.3. Source fingerprint `sha256:c6dddbce753515c62678e50bd84339d0b713e4187d693fd9d38e73b8ed0e099f`
(1777 source files) with the change applied, before this entry. Hermes behavior was read from the local upstream clone at
`ed1afb0`; no Hermes process ran, nothing was deployed and the production host was not touched.

## The window, measured from the code

A send's photos are staged on the session every client shares (`image.attach` appends at `methods_prompt.py:1020`), and the
turn takes the list when `_run_prompt_submit` admits it (`prompt_turn.py:150-152`). It was already recorded as a known
defect in `docs/HermesCapabilityMatrix.md`. Its length, step by step, for a send with one photo:

| Step | Whose | Time |
| --- | --- | --- |
| `image.attach` after its append: `_attached_image_result`, a header read (`methods_prompt.py:1351-1355`) | Hermes | one file read per photo |
| Registering the request ID, the check of the list, the call | the add-on | a dict insert and one list copy: no I/O |
| `prompt.submit` up to marking the session running: stop phrase, lookup, ownership slot, transport rebind, busy check (`:835-909`) | Hermes | unbounded by the add-on; the ownership slot can wait on another gateway |
| Marking it running (`:806`), row write, agent build, thread start (`:918-972`), `_run_after_agent_ready` waiting for a deferred build (`:674-713`) | Hermes | seconds on a cold session |
| `_admit_prompt_turn`'s snapshot (`prompt_turn.py:150-152`) | Hermes | closes it |

Who can take the photo: a turn another client admits in the first rows takes it with its own snapshot; a prompt that finds the
session running in the last rows claims it for its own queue entry (`session_auto_continue.py:418-420`). I could not measure
Hermes's share against a running Hermes, so the table is from the code and every Hermes row is an upper bound I cannot put a number on.

The add-on's own share between its last attach and the call is a dict insert and one list copy, so there was nothing to
narrow by reordering, and nothing was reordered. What the add-on could change is what it knows when the window was lost.

## Change (`src/hermes/extension.py`)

- `stage_images` records a photo once Hermes has answered its path, even when a turn another client started took the list
  while native read the header. Before, such a photo was found "not staged" and never checked.
- `admit_native`: immediately before `prompt.submit`, every recorded photo is checked against the session's list under
  `history_lock` (`photos_gone`, each listed entry counted once). One gone stops the send: its remaining photos come off the
  list, the request ID it registered is dropped, and the receipt is `rejected` with a message that keeps the draft. Nothing
  is sent without the photo.
- After an answer `steered` or `redirected` (`joined`), `photos_not_sent` takes every photo of the send back and the receipt
  says none went. After `queued`, it looks for each in the session's list and in the queue entries' `image_paths`; one in
  neither is said missing, and with no entry to look in nothing is said.
- `check_turn_images`, in the `_run_prompt_submit` wrapper that already claims the receipt: as the send's turn starts, before
  Hermes snapshots the list, any photo no longer listed is said missing. It never stops the turn and never raises into it.
- `Journal.note_images_missing`, `receipt()` and `admitted()`: the receipt, its lookup, the admission answer and every replay
  carry `imagesMissing` (a count) and `message`. A count noted before the answer is saved is in the answer; after, the saved
  answer is amended. It never goes down. A damaged saved value says nothing.
- `docs/HermesCapabilityMatrix.md`: the window, what the add-on does and what is still open, and the upstream request, a
  public `images` parameter on `prompt.submit`, ready to send and not sent.

Walked: the iOS and web clients are unaffected on the wire (`message` and `imagesMissing` are new fields on the receipt, and
the server's `receipt()` already passes `message`, which the composer shows for a refused send, so the gate's refusal
reaches the member, and `imagesMissing` on an accepted receipt is not shown yet); steering sends still reject images
first; a typed stop still takes its photo back; an isolated compute-host turn never reaches the wrapper, so it is not checked.
Reverse state: a refusal drops the registered request ID and the staged photos.

## Tests

`tests/hermes_photo_staging_test.py` (22), on the Hermes fake of `tests/hermes_turn_binding_test.py`, whose queue entry now
uses upstream's `image_paths` key:

- the gate: a photo taken while it attached stops the send with the exact message, Hermes is never sent the words, the
  receipt is settled, no request ID is left, and the same draft sent again runs with its photo; two photos with one taken
  takes the other back; the same photo attached twice counts twice; a send with its photos staged calls `prompt.submit` right
  after its last attach; a text-only send never checks another client's staged photo.
- the turn's start: one gone is said in the receipt and in a replay; all present say nothing, even beside another client's
  photo; only the missing are counted, in the plural too; a check that fails never stops the turn.
- the answer: queued without its photo, queued with it, queued with one of two, joined (redirected), joined with the photo
  still staged, queued with no entry, queued with the photo still listed.
- the receipt: noted before and after the answer, never lowered, nothing noted for zero, a damaged saved value.

## Red runs

Each line broken by hand with `python -B`, `PYTHONDONTWRITEBYTECODE=1` and `__pycache__` cleared, the new file run (22 tests),
the file restored. 29 breaks: 26 killed at once, 3 survived, and are resolved below.

| Broken line | Result |
| --- | --- |
| the gate never finds a photo gone | 3 failed |
| the gate's refusal never taken | 3 failed |
| the refusal keeps the registered request ID | 1 failed (after adding `turn_requests == {}`; it survived before) |
| the refusal leaves the photos staged | 2 failed |
| the refusal leaves the receipt unrefused | 3 failed |
| the answered path not recorded | 3 failed |
| a photo attached twice counted once | 1 failed |
| the turn-start check never runs | 4 failed |
| the count at turn start fixed at 1 | 1 failed |
| the turn-start check's exception not caught | 1 failed |
| the claim carries no photos | 4 failed |
| the registered request carries no photos | 4 failed |
| `queued` or `joined` not accounted (each) | 2 failed |
| the accounting not noted | 4 failed |
| `joined` leaves the photos staged | 1 failed |
| `joined` reports none | 2 failed |
| queued, no entry still said missing | 1 failed |
| queued, entries' photos not looked in | 1 failed |
| queued, the list not looked in | 2 failed |
| the answer's count left in memory | 1 failed |
| lookup ignores the count noted before the answer | 5 failed |
| a count of any type, or 0, shown | 1 error, 1 failed |
| a zero count noted | 1 failed (after adding a test; it survived before) |
| the count lowered by a later note | 1 failed |
| a count before the answer not kept | 5 failed |
| plural and singular swapped | 3 failed |

The third survivor, clearing the memory entry after amending a saved answer, is unreachable: the entry exists only until the
answer is saved, and the answer is saved under the same lock, so the line was removed instead of tested.

## Checks

`.agents/tools/check-all --py always` on the committed tree over `origin/main` at `7d794ef` (the commit before this entry):

| Check | Result | Queued | Run | Counts |
| --- | --- | --- | --- | --- |
| typecheck | pass | - | 0.6s | - |
| lint | pass | - | 0.2s | - |
| ruff | pass | - | 0.0s | - |
| test | pass | 3m30s | 17.8s | 208 files, 3771 tests |
| build | pass | - | 1.7s | 894 modules |
| e2e | pass | 7m03s | 2m00s | 55 tests |
| py | pass | - | 5m10s | 47 files |

The queue time is other worktrees' suites holding the machine's one heavy slot. Before it, the Python files that exercise
admission passed on their own: `hermes_turn_binding_test.py` (39), `hermes_send_lanes_test.py` (16),
`hermes_extension_journal_test.py` (69), `hermes_compaction_test.py` (47). `.agents/tools/mutate-py.py` was not on `main` when
this started, so the red runs used `python -B`, `PYTHONDONTWRITEBYTECODE=1` and a cleared `__pycache__` by hand.

## Not done

- No real Hermes run and no measurement of the window's Hermes share.
- Every file under `src/hermes` changed here is on `src/shared/qualification-inputs.json` (`src/hermes/extension.py`), so the
  host needs a new qualification receipt before this deploys. No `src/server` file changed.
- The server and the apps do not show `imagesMissing` on an accepted receipt yet; the gate's refusal and the receipt are the
  add-on's half, and reading the field is a separate change.
- A photo taken after the check and before Hermes marks the session running still goes with that turn; the receipt says so
  for a `queued` or `joined` answer. A photo left staged by an answer the add-on does not know, or by an answer lost in
  transit, still runs in the next turn. Only Hermes can close these.
