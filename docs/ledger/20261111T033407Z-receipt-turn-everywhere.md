# November 10 every stored receipt carries its turn, and a lookup returns it

Branch `t3/receipt-turn-everywhere` over `origin/main` at `def669a`, on NicolasLaptop (Fedora 44, Linux x64), Python
3.14.10, Node 24.22.2, ruff 0.17.3. Source fingerprint `sha256:22e203a62eb878a5715712fb8a90413d0c5d402c778189f7452a63348c682292` (1766 source files) with the change applied, before
this entry. No Hermes process ran, nothing was deployed and the production host was not touched.

## Defect

The add-on saved a started turn's answer with no `turn` (`admission_turn` returned None for `streaming`), which looks
exactly like an answer saved by an add-on older than the field. `agent-interface.receipt`, the lookup a server uses
after a lost answer, returned no `turn` at all. Two results:

- A typed stop phrase recovered by lookup had no `turn: "none"`, so `store.receipt` cleared the member's draft
  (`src/server/store-submissions.ts`, the `turn !== "none"` test) and the web client's `notTaken` was false.
- The server read a missing `turn` from an add-on that reports `admission_turn` as `started`, so an older add-on's
  replayed answer, which could have been queued or joined, was read as a started turn.

## Change

Add-on (`src/hermes/extension.py`): `admission_turn` answers `started` for `streaming`, so `admitted` saves it with
every other turn. `Journal.receipt` also returns the `turn` its saved answer carries. A steer, a refusal, an answer saved
before the field and a receipt never answered carry none.

Server: `receipt()` in `src/server/hermes-mapping.ts` accepts an explicit `started` and reads a missing turn as absent,
whatever the add-on reports; a lookup passes through the same mapping, so it carries the turn. `Contract.admissionTurn`
is gone, since nothing reads it; the add-on still reports `admission_turn`. `withAdmission`
(`src/server/store-submissions.ts`) takes the lookup's turn first and the recorded receipt's second; only the recorded
receipt has `admittedVersion`.

Readers of a receipt's `turn` for a lookup-recovered typed stop (`none`):

| Reader | Before | Now |
| --- | --- | --- |
| `SubmissionRepository.receipt` (`store-submissions.ts`), reached from `GET /submissions/:id` and Talk's refresh | no turn, so the draft was cleared | draft and photo stay, `sentRevision` unchanged |
| `GET /submissions/:id` (`conversation-routes.ts`) | answered the recorded turn only | answers the lookup's turn, else the recorded one |
| `use-submission.ts` `notTaken` | false, send treated as taken | true, words go back into the draft; the composer shows the fixed fallback text, since a lookup carries no `message` |
| `sent-echo.ts` | echo kept | echo dropped at acceptance |
| `talk.ts` `talkAnswer` | waited for a turn that never comes | answers `refused` with the fallback text |
| `conversation-routes.ts` timing (`receipt.turn`) | admission answers only | same; a lookup is never timed |

For a lookup-recovered `started`, `sent-echo.ts` `settledHere` has no `admittedVersion` and falls back to the
copy-version rule, as for `queued`. The web client needed no change; `tests/thinking-at-send-ui.test.ts` already feeds
it a lookup with `turn: "none"`.

Docs: `docs/native-api.md` (Admission turn, timing), `docs/HermesCapabilityMatrix.md`, comments in
`src/shared/types.ts` and `src/server/send-timing.ts`.

## Tests

- `tests/hermes_extension_journal_test.py` `AdmissionTurnTests`: the turn table now expects `started` for `streaming`
  and checks the lookup against each turn; a typed stop's lookup says `none`; a steer and a refusal carry none in the
  answer or the lookup; an answer saved before this change replays and looks up with no turn, and so does one never saved.
- `tests/hermes-adapter.test.ts`: explicit `started`, a silent answer read as absent even from a capable add-on, unknown
  values, steer and refusal; the lookup carries `none`, `started`, an unknown value as `unknown`, and nothing for a steer,
  a refusal or an answer without one, and has no `admittedVersion`.
- `tests/receipt-turn.test.ts`: the lookup's turn wins over the recorded one; a lost typed-stop answer recovered by
  lookup keeps the draft, and one recovered from an older add-on (no turn) clears it, which is the remaining limit.

## Red proof

Each replacement applied in turn, the named files run (Python with `python3 -B`, `PYTHONDONTWRITEBYTECODE=1`, every
`__pycache__` deleted; vitest for TypeScript), then restored. All ten went red.

| Broken | Red |
| --- | --- |
| `streaming` answered with no turn | table, typed-stop and pre-change replay tests |
| Lookup carries no turn | table and typed-stop tests |
| Lookup invents `started` for a saved answer without a turn | refusal, steer and pre-change tests |
| `started` not saved with the answer | table, typed-stop, pre-change, unknown-answer tests |
| Missing turn read as `started` | adapter test, receipt-turn tests |
| Explicit `started` read as `unknown` | adapter test |
| A refusal keeps its turn | adapter test |
| A steer keeps its turn | adapter test |
| The recorded turn wins over the lookup's | receipt-turn "the add-on saved" test |
| The recorded turn ignored when the lookup has none | receipt-turn tests |

## Checks

`npm run test:py` 45 files passed; `ruff check .` clean (0.17.3); `npm run typecheck`, `npm run lint` clean; `npm test`
205 files, 3637 tests passed; `npm run build` passed.

Not exercised: a real Hermes or a real server against a real add-on, iOS, and production.
