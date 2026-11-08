# October 23 Hermes functionality integration

The implementation adds web and iOS Work and Learning controls, advanced routines,
and safe memory refresh to canonical Bot Chats. Implementation used OpenAI;
Claude Opus 5.5 independently reviewed the full branch and then verified fixes.

The exact native qualification-input digest is
`2926ac21dc658d107cfdc1b7beed1bb7434bf46718ec37b377aba6c62deba6b9`.
The Mac worktree and the isolated Linux app snapshot returned the same digest.
The final native/server/shared/probe source fingerprint is
`sha256:36f7beb77eae808b45b6ebd60df5c944e5f4d404f5f68bf504e1a90015753f86`.
The complete source fingerprint after iOS acceptance is
`sha256:e7938790e4bd2b8f6d6fb7e6b7d93edd3b15537e7975f56dd198c79dfc5f402b`
over 1,008 source files. Ledger files are excluded from that fingerprint.

Application checks used Node 26.10.0, npm 11.19.1 and Python 3.14.7 on
Nicolass-Mini. All 980 Vitest tests, typecheck and the production build passed.
Ruff passed. Python checks covered the automation, experience, journal, dashboard
installation and advanced routine probe. The final changed files passed 25
native-boundary automation tests and 42 experience tests. The earlier full Python
run passed except for a dashboard fixture fixed and rerun here, the upgrade
worker's internal-disk free-space check, and a terminal-only suite skipped because
local tmux is absent. The upgrade worker then passed 65 tests with one skip using
SSD-backed TMPDIR. The final CI run remains authoritative for Linux tmux coverage.

## Native execution

A full disposable run passed against clean official Hermes
`41dfcf2c1bd7146d4ad46aea08b7dd007900602e`, with its constrained managed Python
3.14.7 runtime and Node 24.21.0 on home-hermes-vps. It used synthetic profiles,
a deterministic local provider, isolated homes and the host's installed Chrome.
Production services, profiles, credentials and configuration were not changed.

Retained receipts and hashes are in the
[manifest](../evidence/hermes-features-41dfcf2c-20261023-final/manifest.json).
The [automation receipt](../evidence/hermes-features-41dfcf2c-20261023-final/hermes-automation-probe.json)
records 19 checks, including own and foreign native session leases, real goal
provider admission and receipts, budget reset, active Pause/Clear, same-goal replay,
cleared-goal refusal, interruption review, durable blocked tasks, nullable assignment,
owner/dependency visibility, disabled triggers and revision-safe skill review.

The [experience receipt](../evidence/hermes-features-41dfcf2c-20261023-final/hermes-experience-probe.json)
proves app memory edits reach the next native provider request, including edits
during a run, without injecting user text or replacing canonical history.
Restart acknowledgement and native prompt-rewrite recovery have unit coverage.
The [advanced routine receipt](../evidence/hermes-features-41dfcf2c-20261023-final/hermes-advanced-routine-probe.json)
proves HTTP round trips, native script execution, exact tool schemas, model pins
and latest upstream output in a downstream provider request. Its zero-provider
claim covers script execution plus native DeliveryRouter to a recording transport.
Bot Chat delivery starts a separate model turn.

The full run also covered app restart, executor interruption without replay,
authenticated files, approvals, integrations, vault/browser behavior and native
maintenance fencing. These are isolated upstream acceptance receipts, not a
production activation receipt. Deployment still requires the existing private
Google/shared-OAuth regressions and release qualification. No deployment or
physical-phone acceptance ran in this task.

## Visual and iOS checks

An agent exercised real browser controls against the loopback fixture at
1280 x 800 and 390 x 844: goal Resume/Pause, blocked task creation and explicit
Start, loaded skill diffs, goal replacement warning and responsive layout.
The browser never contacted Hermes or external services.

Xcode 27.1 built the native app for an iOS 27.0 iPhone 17 simulator reserved for
this task. The 382 unit tests completed with no failures and two existing skips.
The 17 affected AutomationTests passed again after the final presenter changes.
Seven UI flows passed across the corresponding implementation states:
advanced routine save/reopen, reviewed interruption Resume/Pause, rejected resume,
loaded skill diff/content with read-only policy, policy failure recovery, blocked
task creation followed by explicit Start, and trigger keyboard entry followed by
Cancel. The task and trigger flows passed again on the final presenter code.
Those checks caught lazy Form sections losing sheet ownership during keyboard
layout changes. Task and trigger sheets now belong to the enclosing Work form.
Native UI switch tests use one actual thumb drag, with starting and final state
assertions. The task-local xctestrun limits crash-report collection to 15 seconds;
this host otherwise waits 300 seconds after every UI test. This changes neither
app behavior nor test assertions. Simulator access was coordinated with the other
WildBots checkout through the shared iOS validation lock.

## Review

Independent review found and the implementation addressed native lifetime-lease
recognition, durable resume refusal/recovery and replay identity, overly broad
memory refresh, native prompt rewrites, profile-scoped skill locking, known versus
uncertain skill refusals, assignment clearing, task-list bounds, path redaction,
admin policy permissions and misleading script-only copy. Replacing a goal now
requires explicit confirmation before discarding native subgoals and verification
state. The final review reported no remaining bugs in those fixes or the probe
contracts. A separate final review approved stable task and trigger presentation.
Native UI acceptance is recorded above.
