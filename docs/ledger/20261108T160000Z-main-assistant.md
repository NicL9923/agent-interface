# November 8 main assistant, check-ins and hand-off validation

Code state `cbe3421` (this record's commit changes no input) on branch `t3/main-assistant-checkins-delegation` over `846ec70`
(origin/main `a3dfff6` plus PR #264), built from NicolasLaptop (Linux, Node 24.22.2,
Python 3.14.10) and the Mac mini (macOS 27, Xcode 27, iPhone 18 Pro Max simulator
`270DC27B`). The Mac checkout was a scratch clone at the same commits, delivered as a git
bundle. Hermes source for the facts below: the production revision
`3a1e9ef50a570b1544795ddad197ad2dcde430ab`, read only from a fresh shallow clone. No live
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

- Full `AgentInterfaceTests` through `validate-ios.sh` at `5b60084`: 629 tests, 2 skipped, 0
  unexpected failures; the 4 expected failures are existing `XCTExpectFailure` cases.
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
