# November 10 a send the add-on refused before admitting it is reported as not sent

Branch `t3/pre-admission-errors`, from `origin/main` at `def669a`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores), Python 3.14.10,
Node 24.22.2, ruff 0.17.3. Source fingerprint `sha256:65ac84c8ea6d7cd3385b25aa6e21b534b4140afd89f09247599e6bbf3d7feb2a`
(1766 source files) with this entry's change set. No Hermes process ran and nothing was deployed. Line numbers are this branch's.
The change touches three files of `src/shared/qualification-inputs.json`: `src/server/hermes.ts`, `src/server/upgrade-routes.ts` and
`src/shared/errors.ts`.

## Defect

`src/server/hermes-transport.ts` (`receive`) turns every JSON-RPC error the add-on answers into a `TransportError` of code `incompatible`
with "Hermes refused the request (code N). Review before retrying.", keeping the code and the add-on's message. `submit` in
`src/server/hermes.ts` turned any such error into an `uncertain` receipt. The web composer holds an uncertain send as a pending
submission that blocks the next send until Retry or Discard ("Checking whether your last message arrived..."), and the iOS app does the
same. That is right when admission may have happened, and wrong for an error the add-on answers before it writes a receipt or calls
Hermes: the person is told to review a message that never went anywhere, and a send under a lease the app does not know about (the
unanswered-acquire case in `20261111T002643Z-worker-acquire-unanswered.md`) stuck every message the same way.

## Which errors come before admission

Read from `src/hermes/extension.py` at this commit. `agent-interface.submit` answers a JSON-RPC error from exactly these places; a handler
that raises is answered `-32000 handler error`, which can follow admission.

| Code | Where | Why nothing was admitted |
| --- | --- | --- |
| 409 | `guarded_call` (line 797) | the lease is held; answered before `route` or the handler runs |
| 5035 | `route` (line 848) | `retirement.acquire()` failed, which `guarded_acquire` does while a lease is held; answered before the send is queued |
| -32602 | `submit` (line 1803), `admit` (line 1863) | invalid parameters; or no canonical session for the profile, or not the one the call named; both before the receipt insert |
| 4093 | `admit` (line 1858) | the request ID has a receipt with a different digest; this call writes nothing, and that receipt is untouched |

Not in the set: `-32000` (a raise anywhere in the handler or a lane), `4094` (already mapped to a 409 the person reviews), `4091` (a retry's
own guard, mapped to `rejected` for a retry only, unchanged), the native refusals `4090`, `4010`, `4001` (the add-on turns those into a
rejected receipt itself and answers a result, never an error), and every failure of the connection, such as a timeout, which stay `uncertain`.

## Change

- `src/server/hermes.ts:44-60`: `BEFORE_ADMISSION = new Set([409, 5035, -32602, 4093])` with the table above in its comment, and
  `beforeAdmissionMessage`. `submit` (line 420) returns `{status: 'rejected', message}` for a `TransportError` whose `rpcCode` is in the set.
  Steer is the same RPC, so it reads the same.
- Messages: 409 is the app's own maintenance message, now `hermesMaintenanceSendMessage` in `src/shared/errors.ts`, which
  `installMaintenanceGate` (`src/server/upgrade-routes.ts`) already sent word for word for a send it refused itself. The rest read
  "Hermes did not accept this message: <the add-on's message, without a trailing period>. Your draft is saved.", or the same
  without the colon when the add-on sent no message. The transport already caps the add-on's text at 500 characters.
- `docs/HermesCapabilityMatrix.md`: the receipt paragraph states the four errors and that the rest stay uncertain.

## What clients do with a rejected receipt

- Web (`src/app/use-submission.ts`): `notTaken` (rejected, interrupted or an accepted turn of none) calls `refused`, which puts the sent text
  back into the draft in front of anything typed since, in memory and in the saved copy, clears the pending submission so the next send is
  allowed, and removes the stored request. The composer shows `receipt.message` in an alert notice. A rejected receipt reaches it from the
  POST answer and from `GET /submissions/:id`.
- iOS (`AppStore+Sending.swift:35`, `:126`, `StatusDock.swift:42`): a rejected or interrupted status buzzes, runs `refused(original)`, which
  restores the draft, and shows the message in the dock.
- Server (`src/server/store-submissions.ts` `receipt`): a rejected receipt is final for that request ID. Each send gets a new request ID,
  so resending the restored draft is a new request.
- Talk (`src/server/talk.ts:139`): a rejected receipt answers `refused` with the message as its text.

## Tests

- `tests/hermes-adapter.test.ts`, 2 new tests through the real runtime and a fake Hermes socket. Each of the four codes, for a send and for
  a steer, answers `rejected` with the exact message (maintenance's own, the add-on's text, a trailing period not doubled); an answer
  with no message of its own still says nothing was sent. Seven other codes (`-32000`, `-32603`, `4090`, `4091` for a send that is not a
  retry, `4010`, `5000`, `404`) stay `uncertain`, never carry the add-on's text, and the generic "Hermes refused the request (code N)"
  message is kept.
- `tests/hermes_extension_journal_test.py`, 1 new test against the real add-on: no request ID, no sender, blank text, another conversation than
  the profile's canonical one, and a request ID that names different text each answer their code and message and leave the receipts table
  and Hermes's call log exactly as they were. `tests/hermes_send_lanes_test.py` already pins the same for 409 and 5035 (`receipt("late")` and
  `receipt("retiring")` are `None`). This is what keeps the app's set honest: an add-on change that answers one of these after a receipt fails
  here.

## Red proof

A scratch runner applied each replacement, deleted every `__pycache__`, ran the named file (`python3 -B`, `PYTHONDONTWRITEBYTECODE=1`, or
`npx vitest run`), and restored the file. All 13 went red; the restored tree then passed both files.

| Broken | File run | Red |
| --- | --- | --- |
| 409 left out of the set | `tests/hermes-adapter.test.ts` | the rejected-errors test |
| 5035 left out | same | same |
| -32602 left out | same | same |
| 4093 left out | same | same |
| -32000 added | same | the uncertain test |
| 4091 added | same | the uncertain test and the existing retry test |
| Any code in the set | same | the uncertain test and the retry test |
| 409 shows the add-on's text | same | the rejected-errors test |
| Trailing period doubled | same | the rejected-errors test |
| No generic message without add-on text | same | the rejected-errors test |
| A pre-admission error answers `uncertain` | same | the rejected-errors test |
| Add-on rewrites a receipt before answering 4093 | `tests/hermes_extension_journal_test.py` | the new test |
| Add-on calls Hermes before answering -32602 | same | the new test, 2 failures |

## Checks

`.agents/tools/check-all --keep-going`: all 7 passed in 5m50s, none of it queued.

| Check | Result |
| --- | --- |
| typecheck, lint, `ruff check .` (0.17.3) | passed |
| `npm test` | 205 files, 3,636 tests passed |
| `npm run build` | 891 modules |
| `npm run test:e2e` | 40 tests passed |
| `npm run test:py` | 45 files passed in 4m16s |

## Not exercised

No real add-on answered over a socket: the adapter tests answer with the add-on's messages copied from its source, and the add-on test runs
its handler against the fake gateway. A retry of an uncertain request ID is the one place a rejected answer could follow an earlier attempt that
was admitted: the route reads Hermes's receipt for that ID before it asks again, and a lease cannot be acquired while the first attempt holds its
reservation, so the window is the time between that read and the retry's own call. It is not closed here.

## Review round 1: a retry, and Talk's draft clause

Claude Opus 5.5 reviewed `283826b` and found two things. Both are fixed on top of it, as Claude Sonnet 5.5 (same provider as the author;
`independent-review-owed`). Source fingerprint `sha256:2f5c05bd20111d57b51ac2e06a7443361f0a9f64ba09823940f26c24aabf7d3b` (1766 source files)
with this round's change set, after merging `origin/main` (`acec071`) into the branch.

**P2, a retry refused for maintenance became final.** A retry's request ID comes from its failed turn, so every later retry of that turn
reuses it, and a rejected receipt is final for an ID (`src/server/conversation-routes.ts` returns it for every later retry, reviewed resends
included). A 409 or 5035 is a refusal that passes, so a retry saw "Hermes didn't take the retry. Hermes is being upgraded. Your draft is
saved...", which is false for a retry (it never touches the draft), lost its Retry button after the update, and was never sent. On `main`
it stayed `uncertain` and its reviewed resend asked Hermes again.

- `src/server/hermes.ts:55-61,426-428`: `TEMPORARY_REFUSAL = new Set([409, 5035])`. A send with `retryOf` whose error is one of these falls
  through to `uncertain`, as on `main`. -32602 and 4093 stay `rejected` for a retry, since no wait changes them, and the client already
  tells a refused retry to send from the message box.
- `tests/hermes-adapter.test.ts:357`: through the real runtime, a retry refused with 409 and 5035 is `uncertain` with the generic message,
  and one refused with -32602 and 4093 is `rejected`.
- `tests/hermes-adapter.test.ts:373`: the route test, through `createApp` and the real runtime on the fake Hermes socket. A retry of a
  failed turn is refused for maintenance and answers `uncertain`; asked again unreviewed, it answers from the recorded receipt and Hermes is
  not asked a second time; once the upgrade ends, the reviewed resend reaches Hermes with the same request ID and `require_idle`, and is
  `accepted`.

**P3, Talk spoke a draft that does not exist.** `talkAnswer` spoke a rejected receipt's message as is, and the app's maintenance gate
answers a `talk/ask` with the same text, which `src/app/talk-loop.ts` speaks as "could not reach ...".

- `src/shared/errors.ts:62-66` `withoutDraftClause` drops each sentence that mentions a draft. It is applied where Talk takes a refusal's
  text: `src/server/talk.ts:140` (receipts, so also the add-on's own "Your draft is saved" messages in `extension.py`) and
  `src/app/talk-loop.ts:182` (an error thrown by the ask, such as the gate's 409). A message that is only about the draft becomes no text.
- `tests/talk-api.test.ts:180`: a rejected receipt reads "Hermes is being upgraded." for the maintenance message (semicolon form), the add-on's
  three-sentence message keeps its other two sentences, and a message that is only the draft clause answers `refused` with no text.
  `tests/talk-loop.test.ts:220`: the maintenance gate's 409 is spoken as "could not reach Ranch Hand: Hermes is being upgraded." with no
  "draft".
- `docs/HermesCapabilityMatrix.md`: the receipt paragraph says a retry refused for the first two stays uncertain and that Talk drops the draft
  sentences.

### Red proof

Each break was made by hand, the named files run, and the line restored. The restored tree then passed all three files (296 tests).

| Broken | Red |
| --- | --- |
| The retry exemption replaced by `true` | both retry tests (409 expected `uncertain`; the route test expected `uncertain` after the refusal) |
| `talkAnswer` returns `receipt.message` unchanged | the three table cases in `tests/talk-api.test.ts` |
| `talk-loop` speaks `error.message` unchanged | the maintenance-gate test in `tests/talk-loop.test.ts` |

### Checks

`.agents/tools/check-all --keep-going`: all 7 passed in 11m07s, 5m03s of it queued for the machine's heavy slot. A first run found two
type errors in the new code (an optional `message`, an option typed `false`); both were fixed and the run above is the second.

| Check | Result |
| --- | --- |
| typecheck, lint, `ruff check .` | passed |
| `npm test` | 205 files, 3,653 tests passed |
| `npm run build` | 892 modules |
| `npm run test:e2e` | 40 tests passed |
| `npm run test:py` | 45 files passed in 4m25s |

Not exercised: no real add-on answered a retry. The Talk sentence filter is a text rule, so a refusal whose only useful sentence mentions a
draft is spoken with that sentence missing. The three messages Talk can receive today read correctly without it.
