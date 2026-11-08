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
