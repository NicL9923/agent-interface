# November 8 form retry answers

Base `298c02dfb0e4ca99b77f26be50f21ad43fa48700`, source fingerprint
`sha256:c1313b2c9a420861b2134ce739a8e297e2b50a2ababeaa58f7a257b0b033ba74`.
NicolasLaptop, Fedora Linux, Node 24.22.2, npm 11.19.1, Vitest 5.1.0.

The new `tests/form-retry-ui.test.ts` regression keeps both copies mounted. B starts
its lookup before A sends. B learns of a restart before A's delayed acceptance,
then the acceptance merges A's answers into storage. B chooses to edit and send
again without reloading. Before the fix, its destination is empty rather than
"Marfa". That assertion failed on the base with only the new test added.

Both retry handlers now read the same attempt's admitted answers through the
existing known-answer merge rule before entering editing. The web test verifies
the visible text and toggle, the next saved attempt, and the exact request ID and
message sent. Five additional cases reject missing, older, newer, unconfirmed or
unknown stored answers. A later attempt's record stays intact.

Validation:

- `npm test -- tests/form-retry-ui.test.ts tests/transcript-ui.test.ts` unit-passed
  94 tests across 2 files.
- `npm run typecheck` compiled with no errors.
- `npm run lint` passed.
- The regression failed without the production fix, then passed with it.
- Removing the web retry restoration preserved a retired field in storage and
  failed the new retired-field test. The production code was restored afterward.

No browser session, iOS build, native unit test, simulator or physical device ran.
The Swift handler calls the extracted `FormRecords.retryAnswers` helper, which
uses the existing known-answer decision table and restores only current fields.
A new native regression passes the still-mounted blank answers alongside the
acceptance saved by another copy and covers unknown, unconfirmed and other
attempts. That test, its mutation check, compilation and the changed native
interaction still need Xcode on the Mac Mini. Linux results do not establish
native behavior.

The other entry points were checked in code: initial form restore, delayed
acceptance, interruption polling, refusal retry and explicit send-again. Only
explicit send-again could discard the already-stored answers while the form
stayed mounted. The API and stored-record formats are unchanged.

Claude Opus 5.5 at high effort approved the original diff and the native-test
extraction through `43cf206`. Its test-strength note was applied afterward: the
native bad-state cases now keep a nonblank mounted answer, so resetting them to
defaults cannot pass. That final change touches only the unrun native test. The
web checks above ran at source fingerprint
`sha256:1949aeafcbb94381c4b0b48ad6b3f77a2bd276478d8f76f4932f239b3b6d7ea4`;
their inputs are unchanged in the final state.

## Mac follow-up on November 8

The published head `dd1593ffca24950e1484f2172a2da99a2a966f91` now includes
`origin/main` at `d916250284046d70f1789ae6141e72fc2183cbc3` through normal merge
`8fb15e817c4d10cdf0a1ff2759fef2fd7eb4e295`. The added native success assertion
also requires admitted "Marfa" to replace a mounted copy's stale nonblank "Austin".
The tested iOS fingerprint, including that assertion, is
`sha256:0cea72a5dcf9581e91449b04a654063bdad8bafad00afcddf6abaa73177cd335`.

SSH file reads recovered on `Nicolass-Mini`. The expected DevSSD UUID was mounted:
`A6506932-2021-45AD-8C2E-91FCFD595A87`. Xcode 27.2, build 27B52, selected
`/Applications/Xcode.app/Contents/Developer`. The isolated task checkout is
`/Volumes/DevSSD/dev/agent-interface-worktrees/followup-271-20261108`.
Derived data and the task scripts are under
`/Volumes/DevSSD/scratch/agent-interface-followup-20261108`.

All native work acquired `~/.agents/tools/mac-heavy-lock.sh`. The first lock
attempt timed out after 60 seconds with exit 75. The next attempt acquired it.
This was an actual lock wait, distinct from the earlier file-read failure.
The task used a private copy of `.agents/tools/validate-ios.sh`, with the repository
path fixed to this checkout and `shutdown all` omitted. It retained simulator
signing, the patched test plan and all other runner behavior. An outer locked
script created the task's own simulator and deleted it after the run. Existing
devices and checkouts were preserved.

The signed build-for-testing succeeded. The command inside the held lock was:

```sh
IOS_DERIVED_DATA=/Volumes/DevSSD/scratch/agent-interface-followup-20261108/derived-271 \
WILDBOTS_NATIVE_LOCKED=1 bash .private/validate-ios-owned.sh \
  FCA3CA2C-B540-4077-9C6A-4771A22D98A1 test \
  -only-testing:AgentInterfaceTests \
  -only-testing:AgentInterfaceUITests/ChatCardsFlowTests
```

The owned simulator was an iPhone 18 Pro on iOS 27.0, build 24A434. At
20:52 UTC, XCTest reported 663 passed, 2 skipped and 0 failed tests. This includes
662 passed native unit tests and the single ChatCardsFlowTests test. The skips
were `AvatarPropEvidenceTests.testRenderPropEvidence` and
`SystemSurfaceEvidenceTests.testRenderEvidence`, which require an explicit
evidence-rendering output directory. The new retry regression passed.

`ChatCardsFlowTests.testThreadCardEmailDraftAndFormSend` exercised required-answer
validation, form entry, choice selection, submission and the sent receipt through
the synthetic native transport. Its four screenshots were exported from
`.private/ios-test-20261108T204723Z-34849.xcresult`. The required-answer and sent
screens were visually inspected. This exercises the ordinary native form flow;
it does not exercise two mounted native copies or the send-again button. The
helper regression covers the stale mounted state, and the web regression covers
the complete two-copy retry interaction. No direct Device panel interaction or
physical-device run occurred. The Mac T3 link was unreachable and device tools
exposed only the Linux host.

The exact run summary is `.private/ios-test-20261108T204723Z-34849.txt` in the Mac
checkout. The parent audit retains it as `native-271/green-summary.txt` with the
complete `native-271/green.log` under
`/home/nic/.cache/agent-interface-backlog`.

Grok 4.7, model `grok-4.7`, at high reasoning effort independently approved the
delta since the earlier approved native extraction, including the main merge and
the new nonblank success assertion. It verified the same iOS fingerprint. Two
supplemental Opus 5.5 passes found no defects but reported low or unconfirmed
effort despite the requested high setting, so their approvals do not satisfy the
current review gate. The Grok review does. All implementation remained OpenAI
GPT-6.1 Sol.

After merging main, `npm test -- tests/form-retry-ui.test.ts tests/transcript-ui.test.ts`
unit-passed 109 tests across 2 files. `npm run typecheck` compiled and
`npm run lint` passed. These checks ran on NicolasLaptop with full source
fingerprint `sha256:b990fd79cc592f25f32bcad68a48c0bbee0f893031016153de8093a1ca50435e`.
The first test invocation could not start because this checkout had no
`node_modules`; `npm ci` installed the pinned lockfile before the passing run.

The native mutation replaced `keepingKnownAnswers(...)` inside `retryAnswers`
with the mounted copy's own record, bypassing admitted-answer restoration.
Its iOS fingerprint was
`sha256:6e6ca14e0e525cd3dccd57b6c3dcf9c78d7edcbb9ca14a2fe00e9247ac84fde1`.
The same signed runner selected
`-only-testing:AgentInterfaceTests/ReplyActionCardsTests/testRetryingAMountedFormRestoresTheSameAttemptsAdmittedAnswers`
on owned iPhone 18 Pro simulator `27488A9E-9072-428A-8C88-A25AD2FBAB40`.
XCTest failed at lines 214 and 221: the actual city was blank or "Austin" instead
of "Marfa". The runner exited 65. Its result is
`.private/ios-test-20261108T205351Z-38100.xcresult`, with the summary beside it.
The complete log is retained in the parent audit as `native-271/mutant.log`.

The mutation script's post-test `rg` command failed because `rg` is not installed
on the Mac. Its exit trap still restored the original source and deleted the
owned simulator. Byte-for-byte restoration was verified against the saved source
before starting a separate restored `ReplyActionCardsTests` run. That restored
run is pending at this checkpoint. The earlier full native pass remains tied to
the identical restored iOS fingerprint.
