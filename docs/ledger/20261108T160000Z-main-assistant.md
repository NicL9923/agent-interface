# November 8 main assistant, check-ins and hand-off validation

Code state `cbe3421` (this record's commit changes no input) on branch `t3/main-assistant-checkins-delegation` over `846ec70`
(origin/main `a3dfff6` plus PR #264), built from NicolasLaptop (Linux, Node 24.22.2,
Python 3.14.10) and the Mac mini (macOS 27, Xcode 27, iPhone 18 Pro Max simulator
`270DC27B`). The Mac checkout was a scratch clone at the same commits, delivered as a git
bundle. Hermes source for the facts below: `3a1e9ef50a570b1544795ddad197ad2dcde430ab`, read
only from a fresh shallow clone. That was wrong: production runs `ed1afb082eb3`, per the
November 7 release record. The review fixes below were checked against `ed1afb0`, where every
fact listed here still holds. No live
Hermes, production VPS, real check-in run, physical device or screen reader was exercised.

Hermes behaviors relied on, read from that source:

- `cron/jobs.py` `parse_schedule`: "every 2h" is an interval of 120 minutes, shown back as
  "every 120m".
- `cron/scheduler.py` `_is_cron_silence_response` and `gateway/response_filters.py`
  `is_autonomous_silence_response`: `[SILENT]`, its bracketless forms, and the marker on its
  own first or last line suppress delivery. `cron/scheduler_prompt.py` `_archive_answer`
  returns no answer for them, so the add-on's completion event has no body; the app also
  matches the same forms for an older add-on.
- `tools/bot_mode_dm.py` `message_agent_tool`, looked up by module attribute on every call
  by `agent/inline_tool_executors.py`, so the add-on can wrap it. Its gate asks through
  `tools/clarify_tool.py` and the agent's `clarify_callback`. Cron sessions are not Bot Chat
  sessions, so check-ins cannot hand off.

Web and server, at `c30cc59`; later commits change only iOS files:

- `npm test`: 152 files and 2,117 tests passed. `npm run typecheck`, `npm run lint` and
  `npm run build`: passed. `npm run test:e2e`: 2 passed.
- `npm run test:py`: 38 files passed. Ruff (pinned CI version): passed.
- `tests/hermes_delegation_test.py` with `HERMES_SOURCE` at the 3a1e9ef clone: 11 tests passed
  against the real `clarify_tool`, in a venv with `ruamel.yaml` for its imports.

Mutation checks, each protected line broken by hand alone, its focused suite run, then
restored (`main-assistant-api`, `main-assistant-ui`, `main-assistant` or
`hermes_delegation_test`): 39 lines went red. They cover preference saves keeping the
server-owned fields and the dismissal; quiet check-ins kept out of notifications and Today,
and the quiet rule for failed, empty, `[SILENT]` and other routines' answers; stopping a run
before deleting; keeping the tracked job over a duplicate; no changes while Hermes is
unreachable; the share confirmation; main eligibility, frequency bounds and main-required
guards; turning the switch off after a refused create and adopting an uncertain one;
clearing a main that is no longer the member's own; the roster never listing another
member's personal assistant; a new main starting with check-ins off; the managed routine's
edit, delete, pause and marker guards; chat run cards and Today's upcoming list; the
silence matcher's line forms; home, palette and details rules; and the add-on's ask, Send
only, off-roster refusal, withdrawal and policy ID checks. Three survived the first pass:
Today's upcoming filter had no test (one added, then red), the policy ID test passed through
a missing name (fixed, then red), and the fan-out comma guard in `exchangePartner` could not
change any result (removed).

iOS, on the Mac mini:

- Full `AgentInterfaceTests` through `validate-ios.sh` at `5b60084`: 629 tests, 2 skipped and 4
  failures. xcodebuild labels them "0 unexpected", which an earlier version of this record misread
  as expected failures. They are `DirectRouteTests` (three) and
  `NativeContractTests.testTheObservedListNamesEveryTrackedProperty`, and the same four fail on
  the base `846ec70` on the same simulator, so they predate this work.
  `MainAssistantTests` (7) and `MainAssistantFlowTests` (2, light and dark) then passed at
  `cbe3421`, the last iOS change.
- Affected UI suites at `cdba4c9`: `ParityFlowTests` and `ShellFlowTests` passed except five
  tests: `testAssistantCatalogAndUnsavedChangesAreProtected`,
  `testNotificationPromptAsksIosOnlyAfterEnableAndSettingsSwitchFollows`,
  `testTodayAndTabletLayout`, `testCommandKOpensTheQuickSwitcherAndGoesWhereChosen` and
  `testGroupChatNamesSendersSuggestsMentionsAndUpdatesLive`. The same five fail the same way
  on the base `846ec70`, on the same simulator, so they predate this work.
- Two fixes came from these runs: the unit tests' Preferences JSON lacked required keys, and
  the switch test now drags the UISwitch thumb, since a tap on an iOS 27 list row lands on
  its label.

Visual: the real app server over a scripted runtime in headless Chromium at 1280x860 and
390x844, light and dark: home with the main assistant, the suggestion card, the picker,
details with Check in with me, a check-in message beside a hand-off with Open Ranch Hand's
chat, the palette's Ask entry, and the opened chat. No page or console errors. iOS simulator
screenshots of the same come from `MainAssistantFlowTests`.

Not built: A4, the "thanks" filter. Hermes's hosted-room send path has no quiet-post flag
(`tui_gateway/hosted_room_service.py`, `gateway/hosted_room_discussion.py`), so skipping
the wake would still allow later processing. It needs an upstream change first.

## Review fixes, November 8

An independent GPT-6.1 Sol review of `846ec70..f57166d` found eight privacy failures. All eight
held against the code and against Hermes `ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df`, read
from a fresh clone, and all are fixed:

1. Hand-offs forwarded the model's target words, which Hermes resolves by profile ID first. The
   add-on now resolves once and forwards the authorized profile ID; a name two roster entries
   share names neither.
2. Only `message_agent` was gated. `cronjob_manage` deliveries (`deliver`, `failure_deliver`)
   are now checked against the roster. Host-level tools (`terminal`, `execute_code`,
   `process_manage`, `write_file`, `patch`) are guarded for main assistants only, which is a
   guard and not a boundary, as the privacy limits say. `send_message` is not agent-callable
   at `ed1afb0`.
3. Check-in markers are now signed with an HMAC under the installation secret. A kept job
   must deliver only to its own chat, with no failure delivery, rooms, skills, model pins,
   toolsets, script, script-only mode or foreign context; anything else is deleted and replaced.
4. Sharing now checks for check-in jobs on the assistant (recorded, or signed in Hermes; an
   unreadable Hermes counts as yes), not only the main designation.
5. A sharing change first pushes a roster where that assistant is listed nowhere and reaches
   nobody, and is refused when Hermes does not take it; the final roster follows the outcome.
6. Hermes's native Bot Mode section listed every profile, with descriptions, to every Bot Chat.
   It is now filtered for every assistant by a per-profile roster, and the roster is mixed
   into the capability epoch, so cached and stored prompts rebuild once. Once rosters arrive,
   a profile without one sees and reaches nobody. This also closes native `message_agent` reach
   from any assistant to another member's personal assistant, which existed before this work.
7. No replacement check-in is made while a superseded one could still run. A refused delete
   falls back to a pause.
8. Discovery identifies untracked routine runs against signed check-in jobs before storing
   them, holding the cursor when Hermes cannot be read. A run of a check-in already gone
   stays quiet.

Checks at the review-fix commit: `npm test` 152 files and 2,127 tests passed; typecheck, lint
and build passed. `tests/hermes_delegation_test.py`: 20 tests passed with `HERMES_SOURCE` at
the `ed1afb0` clone, including a real `_build_section` that lists "Dad private diary" to Mom's
main assistant unfiltered and not filtered.

Mutation checks against the fixes, run the same way: 31 lines broke and went red. Finding 1:
dispatch by ID, ambiguous names. Finding 2: main and personal cron delivery to shared chats,
rooms and platforms, failure delivery, terminal and file guards. Finding 3: signature,
failure delivery, single own-chat delivery, script, context, and replacing drifted jobs.
Finding 4: retry blocked while a job remains, unreadable Hermes blocks sharing (a survivor
until its test was added). Finding 5: withdraw before the change, refusal when Hermes won't
take it, a withdrawn assistant reaching nobody. Finding 6: unknown profiles reach nobody,
section filtering, roster in the epoch, teammates removed from errors, a departed owner's
assistant reaching nobody, only a main assistant asking. Finding 7: no replacement while an
old one could run, pause when delete is refused. Finding 8: identify before recording,
tracking signed jobs, a gone check-in staying quiet. One redundant guard went instead of
being tested: the marker's assistant name, which the signature already covers.

iOS at the review-fix commit `e27106c`, through `validate-ios.sh`, which takes the Mac heavy lock
itself: `AgentInterfaceTests` ran 629 tests with 2 skipped and 3 failing, all among the four
above (a fourth `DirectRouteTests` case passed this time). `MainAssistantFlowTests` passed
both tests, light and dark. The base `846ec70` run of `DirectRouteTests` and
`NativeContractTests` failed the same four.

## Review fixes, round two

A second GPT-6.1 Sol review of `f57166d..13479e0` found six more issues. All six held against
the code and Hermes `ed1afb0`, and all are fixed. Where exact modeling got complicated, the
fix narrows the feature.

1. Roster protocol versions. The add-on reports `delegation_version: 2`. A version 1 add-on
   gets main rosters only, in the old shape. A policy without `main`, from a version 1 server
   or an older journal row, is a main roster. Only version 2 makes undescribed profiles reach
   nobody, so a rolled-back server leaves the others as Hermes has them.
2. Rosters go to Hermes one at a time, each built at send time from the sharing the app records
   then, so no send carries sharing older than one before it.
3. Narrowed: a main assistant's `cronjob_manage` may only list, pause, remove, cancel, and
   create with an explicit own-chat delivery and no script, monitor, working directory or
   context. Update, resume and run are refused; members do those in WildBots. Other assistants'
   changes are checked after merging the saved job, read with Hermes's own `cron.jobs.get_job`;
   `origin` and unreadable jobs are refused. The app's routine save, resume and trial routes
   now also refuse deliveries into chats not everyone who sees the assistant can read, and,
   for a main assistant, anything outside WildBots.
4. A hand-off ID that is also a registered peer's name, or is not a live local profile, is
   refused, since Hermes's `_dispatch` tries peers first and relays unknown names; so is any
   hand-off when those can't be read.
5. The runtime lists every set native cron field outside an allowlist taken from a real
   `ed1afb0` job record; a check-in with any of them, or whose fields weren't listed, is
   replaced.
6. A replacement waits until a run in progress is seen to end. A pause alone no longer counts
   as safe.

`tests/hermes_delegation_test.py` now also runs the real `_roster`, `bot_peers` config read
and `cron.jobs.get_job` when `HERMES_SOURCE` is set: 22 tests passed against the `ed1afb0`
clone.

Mutation checks, the same way: 28 lines broke and went red. Three survived the first pass,
each a missing case rather than dead code, and went red after:
- sending rosters one at a time needed a test where Hermes finishes the older send last;
- main assistants' update, resume and run needed calls naming only their own chat;
- confirming the run ended needed the case where the delete succeeds while the run continues.

Checks at `c5f8b04`, the round-two fix commit: `npm test` 152 files and 2,138 tests passed;
typecheck, lint, build, Ruff and the e2e smoke suite (2) passed; `npm run test:py` 38 files
passed. iOS, through `validate-ios.sh` on the Mac mini (it takes the heavy lock itself), exit 0:
`MainAssistantTests`, `ContractFixtureTests`, `SettingsParityTests` and `HomeParityTests` ran 54
tests with no failures, and `MainAssistantFlowTests` passed both tests, light and dark. This
round changed no iOS source.

## Review fixes, round three

A third GPT-6.1 Sol review of `13479e0..2e6b730` found five issues. All five held against the
code and Hermes `ed1afb0`, this time checked by running Hermes's own code rather than reading it,
and all are fixed:

1. Resume and run disguised the saved destination. Hermes ignores delivery arguments there, so
   the add-on now checks a resume or run (and the `run_now` and `trigger` aliases) against the
   saved routine alone, merges delivery arguments only on an update, and refuses unknown actions.
2. A sharing change checked only rooms. It now also refuses, naming the routines, while an
   enabled routine posts into the changing assistant's chat, or from it into another's, that the
   new sharing would let the wrong people read. Paused routines don't block it; resuming one is
   checked.
3. `deliver="origin"` with no recorded origin counted as staying inside WildBots. Hermes then
   posts to a platform's home channel, so it now counts as outward and is refused for a main
   assistant.
4. Scheduler bookkeeping read as overrides. The field lists moved to
   `src/shared/hermes-job-fields.json`, split into routine and bookkeeping fields. A new test runs
   a real job through `ed1afb0`'s `cron.scheduler_tick.tick`, using a script-only job so no model
   is needed, and checks every field it carries mid-run (`fire_claim`, `last_dispatch`,
   `live_execution`) and after completion is listed. The real records are kept as
   `tests/fixtures/hermes-ed1afb0-scheduled-job.json`, and a reconciliation test keeps a healthy
   check-in through both states without stopping, deleting or creating anything.
5. Routine names stopped working. The add-on now resolves references with Hermes's own
   `resolve_job_ref`, case-insensitive names included, refuses an ambiguous name, and forwards
   the ID it checked. Tested against the real resolver.

Mutation checks, the same way: 14 lines broke and went red at once, after adding one positive
case for the `run_now` and `trigger` aliases. They cover the aliases, update-only merging,
unknown actions, the real resolver, ID forwarding, ambiguity, `last_dispatch` (both the fixture
and the real-scheduler test), the mid-run claim, outward on a missing origin, and the sharing
check's chat deliveries, paused routines, incoming deliveries and the personal-sender rule.

Checks at `9438f9c`: `npm test` 152 files and 2,145 tests passed; typecheck, lint, build, Ruff
and the e2e smoke suite (2) passed; `npm run test:py` 38 files passed. With `HERMES_SOURCE` at
the `ed1afb0` clone, `tests/hermes_delegation_test.py` ran 23 tests, all passing, including the
real scheduler run, the real resolver, profile list, peers config and roster section. No iOS
source changed this round, so iOS was not rerun.

## Review fixes, round four

A fourth GPT-6.1 Sol review of `2e6b730..2bd6351` found two issues. Both held against real
Hermes `ed1afb0`, and both are fixed:

1. Pausing a routine let private results arrive after sharing. Pausing keeps a run in progress
   and its queued delivery, which the sharing check skipped. Two fixes:
   - At delivery time, the add-on producer, which Hermes's cron reaches for every Bot Chat the
     add-on runs, now records the sending profile home on each delivery. The consumer checks
     that sender against the current rosters before running the turn, and closes a refused
     delivery as `failed` with reason `not_allowed`, never posting it. The rule matches the
     share-time one: a personal assistant's routine output goes only to its owner's personal
     assistants' chats, a shared one's only to household chats, and an agent message only to an
     assistant on its sender's roster. A delivery whose sender can't be told is held.
   - At share time, any conflicting routine now refuses the change, paused or running or not.
   A test queues a private report through `ed1afb0`'s real `_deliver_to_bot_chat` and the real
   mailbox, shares the destination, and sees the delivery held and never posted. With the
   destination still personal, the same delivery is posted. Not covered at delivery time, and
   documented: Bot Chats the add-on doesn't run (never opened in WildBots) and group rooms. For
   those, the share-time refusal covers every routine that still exists.
2. Provider failures read as overrides. `unreachable_retry`, `quota_hold_until` and
   `quota_hold_cron_expr` are now bookkeeping. A real-Hermes test drives `mark_job_run` through a
   provider outage, a failed retry rung, a quota hold past the next run, a daily routine's quota
   recovery fire, a timeout and the recoveries between, on an interval and a daily schedule. It
   checks every field written is listed. The 16 real states joined the fixture, and the
   reconciliation test keeps a healthy check-in through all of them.

Mutation checks, the same way: 12 lines broke and went red. They cover the consumer check (a
unit test and the real-Hermes test), the source stamp (both), the routine-output rule, the
agent-message rule, holding an unknown sender, paused or running routines blocking a sharing
change, and each of the three bookkeeping fields.

Checks at `49b7c00`: `npm test` 152 files and 2,146 tests passed; typecheck, lint, build, Ruff and
the e2e smoke suite (2) passed; `npm run test:py` 38 files passed. With `HERMES_SOURCE` at the
`ed1afb0` clone, `tests/hermes_delegation_test.py` ran 28 tests and `tests/hermes_bot_delivery_test.py`
18 (one skip, the 6ebd92d rollback case, which needs that older source), all passing. No iOS source
changed this round.

## Re-scope, round five

The coordinator moved the general routine-delivery enforcement to its own branch,
`t3/routine-delivery-privacy`, created locally at `a98ea55` and not pushed. Commit `7e4142e`
removes it here with ordinary edits. No history was rewritten.

Removed. These records above are superseded by the removal:
- The Bot Chat delivery-time sender check and the producer's sender stamp from round four, item 1.
  `src/hermes/bot_delivery.py` and its test are back to their `2bd6351` state.
- The share-time routine refusals: round three, item 2, and the paused-routine rule from round
  four. `src/server/routine-delivery.ts` is back to `846ec70`, so sharing checks only group
  rooms, as before this branch.
- On other assistants' `cronjob_manage`: the merged-job check, the `origin` refusal, the chat
  checks and the routine-reference resolver. These were round two, item 3, for other assistants,
  and round three, items 1 and 5. Other assistants' cron calls now pass through as Hermes runs them.
- The app routine routes' chat checks for other assistants, from round two, item 3.

Kept:
- Native roster filtering for every assistant: the Bot Mode section, `message_agent` targets,
  teammate lists, the versioned protocol and serialized publication.
- For a main assistant: the update, resume and run refusals, the `origin` refusal, the field
  limits, the host-tool guard, the hand-off pinned to a peer or profile, and the question gate
  for shared targets.
- The signed markers, the reconciler fixes and the bookkeeping-field lists with their
  real-Hermes fixture.

New main-assistant restrictions. Each one fails closed:
- Its routines deliver only to its own chat. Nothing else is accepted: another assistant's
  chat, a group room, `origin`, `all` or an outside platform. A missing or unreadable delivery
  is refused too. This applies at every entry point:
  - the Hermes cron tool on create, including `failure_deliver`;
  - the app's routine save, paused or not;
  - resume;
  - trial run;
  - event trigger;
  - the managed check-in.
  The app returns 409 `routine_chats`.
- Making an assistant main is refused while any of its routines delivers elsewhere. The 409
  `main_routine_delivery` names the routine. It is also refused when its routines can't be read.

The known limit is recorded in `docs/HouseholdExperience.md` (Privacy limits) and
`docs/HermesCapabilityMatrix.md`.

Mutation checks, the same way: 14 lines broke and all went red. They cover:
- the save, resume and trial, and event trigger checks;
- making an assistant main, and the case where its routines are unreadable;
- each own-chat condition: outward, rooms, other chats, and an `origin` with no provenance;
- the add-on's create check, its `failure_deliver` check and its update, resume and run refusal;
- the main-only scope, which a test that leaves other assistants alone turns red;
- the managed check-in's failure-delivery condition.

Checks at `0efa0ee`:
- `npm test`: 152 files and 2,147 tests passed.
- Typecheck, lint, build, Ruff and the e2e smoke suite (2) passed.
- `npm run test:py`: 38 files passed.
- With `HERMES_SOURCE` at the `ed1afb0` clone, `tests/hermes_delegation_test.py` ran 24 tests and
  `tests/hermes_bot_delivery_test.py` ran 17 (one skip, the `6ebd92d` rollback case), all passing.
- No iOS source changed, so iOS was not rerun.

## Review fixes, round six

A GPT-6.1 Sol review of the re-scope (`a98ea55..4edd56a`) confirmed the removal was clean. It found
three P1 issues, all on moving into and out of main, and all reproduced. Commit `852fd69` fixes them.

1. Main activation ran ahead of Hermes. Making an assistant main now runs in turn with routine
   saves and triggers (`serialDelivery`), and the event trigger route now always runs in that
   turn too. The order is:
   1. Its roster goes to Hermes as a main one.
   2. The send must succeed, and Hermes must enforce protocol 2. The runtime now returns the
      protocol it sent and 0 when no gate is installed, and the add-on answers only after its
      rosters are saved.
   3. Its routines are checked.
   4. Only then is the choice recorded.
   Any failure sends the roster back as it was and refuses with `main_activation_failed`,
   `main_routine_delivery` or `main_routine_busy`. A test that adds a routine posting elsewhere
   while the roster is on its way shows the check runs after Hermes holds the limits.
2. Promotion missed copies held by work in flight. It is now refused while any of the
   assistant's routines meets one of these conditions, whatever its destination:
   - it is running (`live_execution`);
   - it has a claimed fire or a Bot Chat delivery Hermes still holds (`fire_claim`,
     `last_delivery_queued`);
   - Hermes still holds a delivery from it: an unfinished row in `cron/deliveries.db`, or a
     parked output in `cron/bot_chat_pending`. These count even after the routine is deleted.
   The add-on reads both stores through a new `agent-interface.routine_deliveries` RPC. If they
   can't be read, or the runtime can't read them, promotion is refused. A real-Hermes test queues
   and parks deliveries through `ed1afb0`'s own `cron.delivery_queue` and
   `cron.bot_chat_legacy.defer`, and sees each until it is sent.
3. Clearing main dropped protection from a check-in cleanup missed. Two fixes:
   - (a) An assistant stays main in Hermes while a check-in is on it. That covers ones recorded
     here and ones found by their signed marker that a pass failed to delete, and it holds from a
     restarted server before its first pass. Clearing or changing main answers 502
     `main_clear_pending` until the check-in is gone.
   - (b) The add-on refuses update, resume and run, including their aliases, on any job whose prompt
     carries the check-in marker, for every assistant and with no rosters at all. Pausing and
     removing stay allowed. The job is found with Hermes's own resolver and the call is pinned to
     the ID checked. An ambiguous or unreadable reference is refused. Tested against the real
     resolver.

Clients show the 502's message and keep their old view until the next reload; a retry converges.
This matches `check_in_removal_pending` and needed no client change.

Hand-breaks: 34 lines broke and all went red, across the API, adapter and add-on tests. Two
runs needed fixing first:
- The serialization mutants first ran with a syntax-breaking edit, so they were redone with a
  stand-in that keeps the syntax.
- The activation one survived until its test held the roster send long enough for an
  unserialized trigger to finish first.
Two lines added during the work were redundant with the current main's preference and could not
fail a test, so they were removed.

Checks at `852fd69`:
- `npm test`: 152 files and 2,157 tests passed. `tests/main-assistant-api.test.ts` passed five more
  runs in a row.
- Typecheck, lint, build, Ruff and the e2e smoke suite (2) passed.
- `npm run test:py`: 38 files passed.
- With `HERMES_SOURCE` at the `ed1afb0` clone, `tests/hermes_delegation_test.py` ran 32 tests and
  `tests/hermes_bot_delivery_test.py` ran 17 (one skip, the `6ebd92d` rollback case), all passing.
- No iOS source changed, so iOS was not rerun.

## Saved state after a refusal, round six follow-up

After `main_clear_pending` the server had saved the change, but the web and iOS apps kept showing the
old main assistant until their next reload. `check_in_removal_pending` and `check_in_unavailable`
had the same gap. Commits `ae94388` and `bdf5dcc` close it:
- The server's error body now carries `preferences`, the member's preferences as saved. It does so
  on `main_clear_pending`, on `check_in_removal_pending` from both check-ins and sharing, and on both
  `check_in_unavailable` cases.
- Web: `chooseMain` and `saveCheckIns` apply them on failure as on success and still reject with
  the message. Bot settings reloads the bootstrap when a sharing refusal carries them.
- iOS: `AppStore.setMainAssistant` and `setCheckIns` apply them on failure for the same store
  generation. Bot settings applies them from a failed save.

Tests that fail without the change:
- Web: `tests/main-assistant-ui.test.ts` covers clearing main and turning check-ins off, each
  refused after saving. The saved preferences are applied and the message stays visible. A
  refusal that saved nothing applies nothing.
- Web: `tests/bot-settings.test.ts` covers a sharing refusal that ended main. Bot settings reloads
  and shows the message.
- Server: `tests/main-assistant-api.test.ts` asserts each error body carries what was saved,
  including a new case for a frequency change Hermes refused.
- iOS: `MainAssistantTests.testARefusalAfterTheServerSavedShowsWhatItSavedAndKeepsTheReason`.

Hand-breaks: 10 lines broke and all went red.
- Web and server, 9 lines: the web apply on failure, the error reader, the Bot settings reload,
  the error handler's `preferences` field, and each of the five throw sites.
- iOS: `applyingSaved` stopped applying on the Mac copy. `MainAssistantTests` failed 3 assertions,
  exit 65, and the file was restored.

Checks at `bdf5dcc`:
- `npm test`: 152 files and 2,160 tests passed. Typecheck, lint, build and the e2e smoke suite (2)
  passed.
- No Python changed, so the add-on tests were not rerun.
- iOS on the Mac mini, through `validate-ios.sh`, which takes `mac-heavy-lock.sh` itself, in the
  foreground. The first build failed on a type error: the store generation is a UUID. It was fixed
  in `bdf5dcc`. The rerun exited 0 with 43 tests and no failures:
  - `MainAssistantTests`: 8
  - `SettingsParityTests`: 24
  - `MainAssistantFlowTests`: 2, light and dark
  - `SettingsPolishTests`: 9

## Final review fixes: protection by default

A final GPT-6.1 Sol review of `4edd56a..d1cb1f3` found three issues, all reproduced. Commit `dc9db64`
applies one rule rather than patching each race. An assistant's Hermes roster marks it main while
any of these holds:
- it is a member's designated main;
- the last successful routine inventory left a signed check-in on it, whether kept, just created,
  or one Hermes refused to delete;
- no inventory has succeeded since this server started.

Protection comes off only in a reconciliation pass. Its inventory, its main-designation cleanup and
its roster send all run inside `serialDelivery`, in turn with routine saves, triggers, sharing and
main changes. A Hermes without routines counts as an inventory that found nothing.

1. A concurrent request bypassed activation. Every `PUT /preferences/main`, a reaffirmation or a
   no-op included, now runs in that turn and reads the designation there. So does the main decision
   in sharing an assistant. Two tests cover it:
   - A reaffirmation held mid-request, then a clear, then a routine posting elsewhere: the requests
     take effect in order and the assistant ends cleared.
   - A share sent while the assistant is being made main now asks for confirmation instead of
     leaving a shared assistant designated main.
2. Untracked check-ins lost protection across a restart. The in-memory set is no longer trusted
   before an inventory. A test restarts with a signed, untracked check-in on an assistant that isn't
   main and makes another assistant main before any inventory. Every personal assistant stays
   protected, a failed inventory changes nothing, and protection comes off for the orphan's
   assistant only once its check-in is confirmed deleted. Two further tests clear main while Hermes
   can't list routines, after a check-in was just made and after one was kept; both stay protected.
   Not persisted: the review asked to persist what the inventory found, but the unknown-at-start
   rule already protects everyone until the first successful scan, and nothing reads a persisted
   copy before that scan replaces it. A persisted set could not fail a test, so it was left out.
3. Settled deliveries blocked promotion forever. The runtime no longer treats `last_delivery_queued`
   as in flight; only `fire_claim` is. The add-on's `routine_deliveries` now reads each queued marker's
   receipt in the target profile's mailbox with Hermes's `read_delivery_result`. A marker counts only
   when its receipt is queued or claimed, or is missing with no finished parked record. A real-Hermes
   test admits receipts into a real mailbox, records the markers with `_record_delivery_verification`,
   and settles one and fails another with `complete_delivery`. Only the unfinished one still counts,
   while Hermes keeps all three markers.

The main-assistant API test setup now runs a reconciliation first, as the server's start does.

Hand-breaks: 19 lines broke and all went red:
- both request-ordering changes, failing on the race tests themselves;
- the unknown-at-start rule, marking an inventory successful, the no-routines case, and adding kept,
  just-created and undeleted check-ins to the protected set;
- the adapter's marker handling;
- the receipt statuses: claimed, settled or failed, and missing;
- a finished parked record;
- the own, default and invalid targets;
- the three malformed-input guards.

Checks at `dc9db64`:
- `npm test`: 152 files and 2,165 tests passed. `tests/main-assistant-api.test.ts` passed five more
  runs in a row.
- Typecheck, lint, build and Ruff passed.
- The e2e smoke suite (2) passed on a rerun. The first attempt couldn't start because port 4173 was
  briefly in use by another process.
- `npm run test:py`: 38 files passed.
- With `HERMES_SOURCE` at the `ed1afb0` clone, `tests/hermes_delegation_test.py` ran 34 tests and
  `tests/hermes_bot_delivery_test.py` ran 17 (one skip, the `6ebd92d` rollback case), all passing.
- No iOS source changed, so iOS was not rerun.
