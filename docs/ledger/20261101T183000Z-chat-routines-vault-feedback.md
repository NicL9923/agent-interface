# November 1 chat, routines, secure input and group chat feedback

Branch `nic/improve-chat-routines-vault`, based on `5a1ab77` (#212). It merges four
implementation streams, followed by fixes from independent review. The source fingerprint is
recorded in the PR for the final commit. Node 26.10 ran the web checks, Python 3.14.7 the
add-on checks, and Xcode 27.2 the native checks on an iPhone 18 Pro simulator (iOS 27.0).

## What changed

- **Transcript:** message times and delivery status sit under each bubble. Your own messages
  have Copy. Every reply's action row has Listen. The composer has no model picker. In
  Advanced, a model chip under the assistant's name shows the provider mark and the model's
  display name, and opens the model, reasoning and speed picker. There is less space between
  the composer and the messages. Pinned assistants have no pin badge.
- **Model display names:** a cache-only add-on `model_names` operation reads Hermes's
  models.dev cache. When the add-on is older or the model is uncataloged, the server falls
  back to a port of T3 Code's slug formatter.
- **Routine runs** appear in the chat as collapsed cards, ordered by time, each with a status
  dot. A run already delivered into the chat shows once, as its message. "Show runs in chat"
  is a per-person setting.
- **Secure input:** a chat message sent while the assistant waits on a secure prompt, a
  question or a computer handoff closes that request, so the message reaches the assistant.
  A login asked for by address stays with the member who asked for it. Cards show sending,
  confirmed and receipt states. The transcript gap after submitting is gone. Agent tool text
  is rewritten.
- **Computer handoff:** assistants can ask for a takeover in chat with
  `computer_request_handoff`. Take over opens the computer with control. Handing back, Not
  now, a chat message or 10 minutes untaken settles the request. While a computer tool runs,
  the live row has Watch.
- **Group chats** are rows on home beside the assistants. The separate page and link are
  gone. **+** offers New assistant and New group chat.

## Application checks

- **Web:** after the final merge and review fixes, the full web suite passed: 117 files,
  1,648 tests. The pinned no-emit typecheck and the production build passed.
- **Add-on:** the Python suite (33 files) and Ruff passed. `hermes_chat_reply_test.py` also
  passed against the real `tui_gateway/server_requests.py` of Hermes `0beda3a` through
  `HERMES_SOURCE`.

## Native checks

The full native scheme ran on the merged code before the last add-on-only review fixes. Those
fixes do not touch native sources.

- **Unit tests:** all 219 passed, with 1 skip. One expected failure is the pre-existing
  `FixedWaitRuleTests.testUITestsNeverAskIsHittableDirectly`.
- **UI tests:** 14 failed. Each was compared against base `5a1ab77`.
  - 13 fail the same way on base and predate this work:
    - five `NativeFlowTests`
    - `ExperienceFlowTests.testRoutineResultsAndGroupCreationMessaging`
    - two `ShellFlowTests`
    - `TranscriptFlowTests.testQuestionOptionsAdvanceAndSendEveryAnswer`
    - `DailyFlowTests.testHomePushesKeepDraftAndFindOpensMessageActions`
    - `DiscoveryFlowTests.testSearchSavedItemsAutomationAndEditableStarter`
    - two `ParityFlowTests` (Today and notification prompt)
  - One was a regression: `ExperienceFlowTests.testUncertainRoutineTrialChecksReceiptBeforeFreshRun`.
    The new "Show runs in chat" switch had split the routine's run controls. Moving it after
    them fixed the test; see the rerun below.

After the switch moved, a focused rerun passed:
- the whole `ExperienceFlowTests` class except its pre-existing `testRoutineResultsAndGroupCreationMessaging`, including the routine trial test
- `TranscriptFlowTests.testRoutineRunsSitAmongTurnsAndOpenToTheirOutput`
- `RoutineRunsTests` and `SettingsParityTests`, 27 tests

The simulator was shut down after every run.

## Independent review

GPT-6.1 Sol reviewed at high effort, a different provider from the Claude implementers.

- **First review**, of the three earlier streams, found three bugs:
  - a handoff that never settled after a hand-back or timeout
  - an ask opened during undelivered steering that stayed open
  - `exec:N` routine rows indexed against the wrong list
- **Second review**, of group chats, the fixes and the merge, found two more:
  - a later member's message hid the login requester's
  - one viewer's filter evicted the shared group preview cache
- **Three narrow re-reviews** refined how the add-on matches waiting messages against
  Hermes's steer buffer. The final re-review had no findings.

Each fix has a regression test. Where practical, the test was confirmed to fail without its
fix.

## Visual checks

The implementation agents captured each feature at web desktop and phone widths and on
iPhone, and the orchestrator inspected the results. The captures cover:
- the header chip and meta lines
- routine cards, collapsed and open, in light and dark
- secure card states and the handoff flow
- group rows and the open room

Captures are under `/Volumes/DevSSD/scratch/wildbots-*/` on the Mac mini and are not
retained in `docs/evidence/`.

## Not exercised

- **Real Hermes:** nothing ran against a live Hermes stack, so these are unverified there:
  steering past an open request, the handoff tool, `model_names`, and per-run routine status.
- **Deployment:** the add-on changes `vault.py`, `computer.py`, `extension.py` and
  `experience.py`, and adds qualification inputs. Production needs a qualified add-on
  redeploy. Until then routine runs read "Status unknown", and steering and handoff behave
  as before.
- **Not run:** a physical phone, real audio, an iPad layout run, and APNs.
