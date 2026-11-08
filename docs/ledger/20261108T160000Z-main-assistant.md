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
