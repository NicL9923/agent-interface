# November 7 iOS chat cards and private form key validation

Code state `a73cd4c3`, on branch `t3/t3code-mcp-chat-integrations` over `a3dfff6`, built from
NicolasLaptop (Linux, Node 24.22.2, Python 3.14.10) and the Mac mini (macOS 27.0.1, Xcode
27.2 27B52, iPhone 17 simulator on iOS 27.0, reached through the Hermes VPS because
NicolasLaptop has no Mac key and NicolasDESKTOP was offline). The Mac checkout was the pushed
`07215b4` with the later Swift files copied in and checksum-matched against this commit. The
ledger-only commit after it changes no input. No live Hermes, T3 Code MCP connection, mail
client, physical device or screen reader was exercised.

Web and server, at this commit:

- `npm test`: 149 files and 2,066 tests passed. `npm run typecheck` and `npm run lint`: passed.
- `python3 scripts/run-python-tests.py`: 37 files passed at `78fd948`; no Python changed after.
- The form-key read under another connection's `BEGIN IMMEDIATE` fails with "database is
  locked" against `a387948` and passes now. Moving the key to another user, resetting the
  secret, and dropping the key from TranscriptTools each turned their tests red.

iOS, on the Mac mini:

- Unit: ReplyActionCardsTests (9), ExperienceTests, ConversationParityTests, ContractFixtureTests
  and FixedWaitRuleTests passed, 39 tests. The form request ID vectors match the web's.
- UI: ChatCardsFlowTests passed three times across the fixes, and
  ExperienceFlowTests.testInteractiveChecklistMemoryAndRoutineSchedulePreview passed.
- Mutants: eight Swift guards broken in two batches; each failed its own assertion except
  the ASCII-digit pattern, which Swift's Double parsing already guards. Removing the
  unchanged-value guard in the form's setter failed the UI test's focus check (1 of 2 errors).
- Pre-existing on `a3dfff6` too, not changed here: DirectRouteTests (two tests),
  NativeContractTests.testTheObservedListNamesEveryTrackedProperty, and
  ExperienceFlowTests.testRoutineResultsAndGroupCreationMessaging. The inline-HTML UI test
  failed once on this branch and passed twice on rerun and once on `a3dfff6`.

Independent review: GPT-6.1 Sol at high effort reviewed `7fce6f2..78fd948`; all eight findings
were fixed in `a73cd4c` with tests, which were not reviewed again.
