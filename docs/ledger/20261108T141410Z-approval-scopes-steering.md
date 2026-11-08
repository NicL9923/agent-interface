# November 8 approval scopes, decline handoff, recommended answers and steering validation

Code state `1b35271`, branch `t3/approval-interaction-flow` over `846ec70` (#264's head), on
NicolasLaptop (Linux, Node 24.22.2, Python 3.14.10) and the Mac mini (macOS 27, Xcode 27.2
27B52, iPhone 17 simulator). The ledger-only commit after it changes no input. No production
Hermes, physical device, APNs delivery or screen reader was exercised.

Real Hermes, at `ed1afb082eb3` (production's revision), in a disposable home with the
deterministic provider: `scripts/spike/approval_scope_probe.py` passed every check against the
add-on in this branch. Hermes offered `once`, `session`, `always` and `deny` with pattern key
`recursive delete`; `session` granted the session only; `always` wrote the profile's
`command_allowlist`; the add-on's removal withdrew the saved pattern and the live session grant,
so Hermes asked again at once; `deny` blocked the command. With `approvals.mode: smart` the
guardian ran an approved command unasked and a denied one offered only `once` and `deny`; an
unoffered `always` sent anyway was not saved but still ran once, which is why the server now
refuses unoffered choices. Clarify carried `multi_select`, marked the first of several choices
` (Recommended)`, accepted a JSON-array multi-select answer and stripped the suffix. Receipts,
receipt lookup and history rows carried the steering decision. Receipt:
[hermes-approval-scope-probe-ed1afb0.json](../evidence/hermes-approval-scope-probe-ed1afb0.json).
The full `run.py` qualification sequence was not run; the probe ran under a scratch launcher
that reproduces run.py's isolated home, provider and add-on gateway. The source of `b9cb268`
and `d23cc6b` builds the same approval `choices` and clarify wire.

Web and server, at `1b35271`:

- `npm test`: 151 files and 2,100 tests passed. `npm run typecheck`, `npm run lint`,
  `npm run build` and `npm run test:e2e` (2 tests): passed.
- `python3 scripts/run-python-tests.py`: 37 files passed. Ruff `check .`: passed.
- Mutants: 36 hand mutations across the decision guard, the Hermes mapping, the recommended
  helper, the settings routes, the approval card, the composer handoff, the sent echo, the
  settings panel, `automation.py` and `extension.py`, each applied alone with its focused
  suite. 34 failed. Two survived: the remembered-receipt check in the composer guarded
  nothing a test or remount could reach, and the Always-resend confirmation was redundant;
  both were simplified away, and a new remount test was confirmed red with the replacement
  guard forced true.

iOS, on the Mac mini:

- Unit: TranscriptFeatureTests (29), SentEchoTests (15) and ContractFixtureTests (3) passed,
  47 tests, after the last change. Five Swift mutants (recommended label guard, multi-select
  pre-selection, JSON-array answers, echo steering, older-Hermes choices) were applied as one
  batch; each failed its own assertion, and the source was restored.
- UI: TranscriptFlowTests' new approval-scope flow and screenshot capture passed;
  ten other transcript UI tests passed. `testQuestionOptionsAdvanceAndSendEveryAnswer` fails
  at typing into the written question, which sits under the decision dock; it fails the same
  way on `846ec70`, so it predates this branch.

Visual: the real app server over a scripted runtime in headless Chromium 1248 at 1280x860
and 390x844, light and dark (approval choices with a steered message, the Always allow
confirmation, the decline with the focused composer, the settings list, a recommended
question), and the iOS simulator in light and dark (the same states). The scripted runtime
does not serve Connections or Logins, so those panels show a load error in the settings
captures. No page errors or CSP reports besides those two refused reads.

## Cross-provider review follow-up

An independent GPT-6.1 Sol review of `846ec70..d2157aa` found four issues; all four were real.

1. Removing an always-allowed pattern left it live on qualified `b9cb268` and `d23cc6b`, whose
   `tools.approval._permanent_set()` keeps the permanent set without rereading
   `command_allowlist`. The add-on now drops the pattern from the profile's permanent cache and
   baseline, including the launch profile's module-level set (`ea00f3d`).
   `RealApprovalCacheTests` runs the removal against the real `tools.approval` of each qualified
   revision through `HERMES_SOURCE`: it passed on `b9cb268`, `d23cc6b` and `ed1afb0`. With the
   cache withdrawal removed it failed on `b9cb268` and `d23cc6b` ("The routed profile still
   allows it from its cache") and passed on `ed1afb0`, which resyncs from disk; with only the
   launch-profile branch removed it failed on `b9cb268` ("The live session keeps it"). The fake
   module now models the cache, and both breaks also fail the default tests. The full
   approval scope probe then passed against both `ed1afb0` and `b9cb268`, using
   `ed1afb0`'s dependency set ([b9cb268 receipt](../evidence/hermes-approval-scope-probe-b9cb268.json)).
   The removal note now says another Hermes app may keep the grant until its chat ends or
   Hermes restarts.
2. Exposing `multi_select` let installed apps send comma-joined picks, which Hermes's real
   `_clean_answer` on `b9cb268` and `ed1afb0` reads as one typed answer
   (`['Feed (Recommended), Water']`). New clients now send `answerFormat: "json"`, which the
   server validates; an answer without it is split into the options it names, then written
   text, unless an option contains ", " (`adbe227`). Six hand mutations of the conversion,
   the guard and the web client's flag each failed their tests.
3. An older add-on passed Hermes's `always` through without a way to remove the grant. The
   server now leaves `always` out of the choices unless the add-on reports `approval_settings`,
   which both clients and the decision guard follow (`f482ddb`). Removing the filter, or forcing
   the capability on, failed the adapter test.
4. iOS cleared the decline handoff only after a send's own response. The shared receipt handler
   clears it now, and `testAnAcceptanceLearnedByLookupEndsTheDeclineHandoff` covers recovery
   through lookup (`75a7f4a`). The web clears on its shared receipt state already; a new test
   with every POST failing shows a lookup-recovered acceptance ends it, and it failed with the
   composer's clear disabled.

After the fixes: `npm test` 151 files and 2,103 tests passed on six of seven runs; the one
failing run started right after a hand mutation was restored and did not recur. Typecheck,
lint, Python (37 files) and ruff passed.

iOS after the fixes, on the Mac mini (iPhone 17 simulator, Xcode 27.2), through
`mac-heavy-lock.sh`: NativeContractTests (137, including the new lookup-recovery test),
TranscriptFeatureTests (29), SentEchoTests (15) and ContractFixtureTests (3) ran; 183 passed.
`testTheObservedListNamesEveryTrackedProperty` fails only on `sendingRequests` against the
listed `sending`, which predates this branch; `declinedApprovals` is now listed. With the
handoff clear removed from the shared receipt handler, the lookup-recovery test failed
("approval" still set) and passed again once restored. TranscriptFlowTests: the approval scope
flow passed; `testQuestionOptionsAdvanceAndSendEveryAnswer` fails as it does on `846ec70`; the
screenshot test skipped without a screenshot directory.

## Re-review fixes (coordinator)

A scoped GPT-6.1 Sol re-review of `d2157aa..d9f4fdf` found two gaps in the legacy answer
conversion, both reproduced through Fastify injection:

- An older client's written answer that starts with an offered option ("Water, only if the
  trough is empty") was split into an unconditional "Water" plus a fragment. The payload can't
  tell that apart from a pick plus writing, so only an answer made entirely of offered options
  becomes an array now; anything else passes unchanged as one typed answer, as these clients
  behaved before this branch.
- An empty answer with `answerFormat: "json"` skipped validation. It now gets the
  question-specific 400 and never reaches Hermes.

Mutations in `tests/approval-scopes-api.test.ts`, each applied alone and restored:
restoring the `!answer` empty shortcut failed "passes a client's JSON array unchanged and
refuses anything else"; converting any comma-joined answer failed "turns an older client's
comma-joined picks into the JSON array Hermes reads, and leaves written text as typed".
