# Validation ledger

## October 8 app release 1eb2caf

PR #49 merged at `1eb2caf98be9bf06219d8c215332ae280750a73c`. The release is live at `https://agentui.wildflowersranch.com`,
web build `7f083a6428df7ac4`, from the archive with SHA256
`c86ee0c9f9acd3648a53cf64b5a702277713c94bf250201c839d766279fb5cd9`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-1eb2caf9-20261008T122759Z.json) records the result. Hermes remains
at `1298c8e74baa`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.

The [fresh native qualification](evidence/wildbots-qualification-2026-10-08/manifest.json)
completed in disposable homes, including private authentication regressions.

## October 8 WildBots name

Source fingerprint `sha256:66ad62ac90350fe72324e48341a4962081c7da9c3a1779643139753a79cfb143`.
The complete web suite passed 493 tests across 47 files, with type checking, the
production build, the Python compile check and the dashboard contract test.
User-visible names on web, iOS, notifications, the native sign-in page and the
Hermes add-on messages now say WildBots. Repository, storage keys, add-on RPC
names, bundle identifiers and hosts keep `agent-interface`. Copy-only change; no
independent review or device check.

## October 8 app release 991e0bd

PR #47 merged at `991e0bdb7a8de325ca5361d382ece729f7a9bbad`. The release is live at `https://agentui.wildflowersranch.com`,
web build `a7add27770b5bf11`, from the archive with SHA256
`be136fb10d2ff593bc7222119cf119dc9b768262646e47ad2eec70bc69af1b15`. The host build reproduced the local web build.

The app integration inputs were unchanged, so the existing qualification receipt validated against the release and was reused. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-991e0bdb-20261008T115744Z.json) records the result. Hermes remains
at `1298c8e74baa`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.

## October 8 save feedback and conversation position

Source fingerprint `sha256:e6dcb42403711925184c54f81264644c72c9c1436183eb63497a5274e0525515`.
The complete web suite passed 493 tests across 47 files on Node 26 and Node
24.21. Type checking and the production build passed.

Agent WebKit checks at 390×844 confirmed the avatar save button shows Saving and
then Saved, the working message centers on its avatar, and opening three chats
in turn from the phone home lands each at the latest message. Switching
assistants had saved the transcript's clamp to the top as the next assistant's
reading position; regressions cover both event orderings.

The independent GPT-6.1 Sol review found that a clamp delivered after the new
conversation arrived could still save the top. Persistence now waits for the
restore, covered by the same regression.

## October 8 app release 964caba

PR #45 merged at `964caba3a17792143ae67885cff5d3f39b2d5bdd`. The release is live at `https://agentui.wildflowersranch.com`,
web build `381723bbbe57154b`, from the archive with SHA256
`bc0dfeb81321b53092f2433e5e698cf0553c99fc5eaa1f21652d99b05bb1e81e`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-964caba3-20261008T033421Z.json) records the result. Hermes remains
at `1298c8e74baa`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.

The [fresh native qualification](evidence/home-settings-qualification-2026-10-08/manifest.json)
completed in disposable homes, including private authentication regressions and
the new check that completion events carry the reply text. The first preflights
refused while an assistant was busy; activation followed fresh idle admission.

## October 8 home, settings and notification copy

Source fingerprint `sha256:a61eef8bf5fa5487619bedffa1dc97b0fa9c3d256d2c5cb6779aec6ed736d354`.
The complete web suite passed 491 tests across 47 files on Node 26 and Node
24.21. Type checking, the production build and the Python compile and contract
checks passed.

Agent WebKit checks used synthetic fixtures at 390×844 and 1280×800 in light and
dark appearances. Checked the phone home with pinned assistants, previews and
dates, push into a conversation and Back, the long-press pin menu with click
suppression, right-click pinning on desktop, the grouped settings sheet and its
rows into Hermes updates, Computer and Integrations, and the reasoning accordion.
Only the inline work avatar animates; header, home, Today and settings avatars stay still.
Notification copy is covered by unit and payload tests; the qualification probe
now requires completion events to carry reply text. A physical iPhone and a live
push delivery were not exercised.

The independent GPT-6.1 Sol review of the redesign found lost focus during phone
navigation, slow drags opening the pin menu, and base styles overriding home
sizing. All three were fixed and the first two are covered by regressions. A
focused review of the notifications and shapes found approval commands, which can
carry credentials, reaching notification text, and private assistants' previews
reaching other members. Approval notifications now say only that a decision is
needed, and previews follow notification visibility; both are covered by tests.

## October 7 new avatar shapes

Source fingerprint `sha256:5ec24a0aca06247bf6f8eae5c70bfb631656d50a04b93848c74e8b229cff38cf`.
The complete web suite passed 479 tests across 46 files on Node 26 and Node
24.21. Type checking and the production build passed. The native simulator run
passed 69 unit tests and 25 UI tests, with 2 skipped, on an iPhone 18 Pro.

Geometric avatars gain diamond, sparkle, clover, heart, cookie, pentagon, burst,
alien, ghost, flower and sun on web and iOS. Each is one closed cubic outline
that morphs like the original nine. The sun is a round disc with 12 short
triangular rays, so it does not read as a germ. A web test checks that every native path
and face anchor matches the web and stays within the native parser's commands.
WebKit renders of all 20 shapes with idle eyes, and of each new shape with
glasses and the hat, were reviewed at 120 px.

## October 8 app release f15d46c

PR #43 merged at `f15d46c80847568ded64846e4db2f7667f46ef78`. The release is live at `https://agentui.wildflowersranch.com`,
web build `10d94c8630a564e0`, from the archive with SHA256
`144af551f1aff0ee83b8457adbb67852ef9c57d87df975093aa248869f0f3063`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-f15d46c8-20261008T020304Z.json) records the result. Hermes remains
at `1298c8e74baa`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.

The [fresh native qualification](evidence/live-reply-qualification-2026-10-08/manifest.json)
completed in disposable homes, including private authentication regressions.

## October 7 live reply replay fix

Source fingerprint `sha256:1e7045178492ab73005545336baf4b44bd8e97b8af36aabd12b5dc34a0ca81c5`.
The complete web suite passed 458 tests across 46 files on Node 26 and Node
24.21. Type checking and the production build passed.

Hermes accumulates a turn's streamed text and exposed reasoning across tool
calls while persisting each earlier segment as a history row, so the live bubble
replayed old text between tool calls. Adapter regressions cover persisted segment
removal, reasoning separator differences, preserved code indentation, image-only
turns without a persisted boundary, queued follow-ups sharing a run ID, emoji and
a mismatched rewrite. No browser or physical device check was run against live
Hermes streaming.

The independent GPT-6.1 Sol review ran four rounds. It found image-only turns
subtracting the previous answer, steering and attachment prompt mismatches,
differing reasoning separators, lost indentation, queued follow-up boundaries and
emoji mismatches. All were fixed and covered. A steering correction persisted
mid-turn still replays the earlier segment, the previous behavior, because history
rows do not identify steering.

## October 7 app release b2f2f72

PR #41 merged at `b2f2f720b758696762edae801dbeb398271d42c8`. The release is live at `https://agentui.wildflowersranch.com`,
web build `10d94c8630a564e0`, from the archive with SHA256
`a64366a33984207db8e2534e11abfb9f14ea874a08976dff89e6ee40eed441e9`. The host build reproduced the local web build.

The app integration inputs were unchanged, so the existing qualification receipt validated against the release and was reused. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-b2f2f720-20261007T232909Z.json) records the result. Hermes remains
at `1298c8e74baa`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.

## October 7 chat transcript and composer fixes

Source fingerprint `sha256:3d03cace4d81f7d2e45955e4ff4df9abf73863e702ea658a1619673736fa16e4`.
The complete web suite passed 455 tests across 46 files on Node 26 and Node
24.21. Type checking and the production build passed, web build `10d94c8630a564e0`.

Agent WebKit checks used synthetic fixtures with an iPhone 15 Pro viewport in
dark appearance. Checked that tool-call-only replies no longer leave name-only
blocks, replies omit the assistant's name with one timestamp per turn, a delayed
send spins Send without a status bar and clears on acceptance, and all four held
props render and animate. A regression proves typing no longer re-renders the
transcript. The iOS tap fix replaces the invisible file input overlay with a real
button and wider spacing. Device control was unavailable, so a physical iPhone tap
was not retested.

The independent GPT-6.1 Sol review found that clearing the draft during an
in-flight guidance send swapped the busy Send button for Stop. Stop now waits for
the send to finish, covered by a regression.

## October 6 app release 4c2959e

PR #39 merged at `4c2959ebf6fa8eb4af964934f3306e7e3b86c7e1`. The release is live at `https://agentui.wildflowersranch.com`,
web build `459506b57fe35aae`, from the archive with SHA256
`85d00e2c101631a725f8729258cc56a7934e35d95ed1195aa9a252794b0ccf58`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-4c2959eb-20261006T012028Z.json) records the result. Hermes remains
at `1298c8e74baa`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear.

The [fresh native qualification](evidence/chat-polish-qualification-2026-10-06/manifest.json)
completed in disposable homes, including private authentication regressions.
An [authenticated app check](evidence/chat-polish-inference-acceptance-2026-10-06.json)
read reasoning and speed settings for both household profiles, rejected invalid
changes, and confirmed the settings stayed unchanged. Its temporary app session
was removed before the receipt was issued. A fresh browser sign-in and physical
phone voice controls were not exercised.

The first preflight refused deployment while the default Bot Chat awaited a
clarification answer. Nicolas authorized cancelling that turn, but it had already
ended when checked again. No interrupt was sent; activation followed fresh idle
admission.

## October 5 web chat controls and activity

Source fingerprint `sha256:7cd53d6fea80a8e5c1d011221072b9f597ef8f22f6eae16648f8ebc962645045`.
The complete web suite passed 437 tests across 46 files. Type checking and the
production build passed, web build `459506b57fe35aae`.

Agent browser checks used synthetic fixtures with the production CSP at 1280×800
and 390×844 in light/dark appearances. Checked counted tool accordions and
expanded arguments, subagent grouping, approval busy feedback, empty role
discussion, reasoning persistence, compact model dialog bounds, and Stop/Send
switching as draft text changes. Voice capture was unavailable on the HTTP LAN
fixture; actual microphone and speaker execution were not retested.

The independent GPT-6.1 Sol review found historical tool-ID collisions, model
confirmation during an inference save, and pending Stop state leaking between
assistants. All three were fixed and covered by regressions. The reviewer
verified the corrections and native Hermes configuration contracts.


## October 5 app release f8dac19

PR #36 merged at `f8dac1949829a4cc527a4bb9f72e4a7c2f1a3484`. The release is live at `https://agentui.wildflowersranch.com`,
web build `adedc5d03eafb410`, from the archive with SHA256
`dbd55a73044d4a3aa5151b12ad826516175ec93b33d5553f6783d3c119f28ca7`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-f8dac194-20261005T183331Z.json) records the result. Hermes remains
at `1298c8e74baa`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.

The release includes PRs #34, #35 and #36. Qualification also required the native
dashboard's update switch; the first attempt failed on a Chromium startup race in
the vault probe, fixed separately, and the retry passed. Each stage removed its
disposable checkout and runtime afterwards. The shared computer predated #36, so
it was restarted once by hand while idle, outside the guarded activation. Its
browser was ready on Hermes `1298c8e74baa`.

## October 5 external native update recovery

An outside `hermes update` on October 4 at 12:42 UTC moved Hermes from
`5bba024d8ddd` to `1298c8e74baa` after the in-app check had refused
`agent_interface_computer_host.py` as an untracked source file. The restarted
dashboard disabled the unqualified add-on, and the app reported a rejected service
credential for about 25 hours. The gateway kept running the earlier generation.

The host disk was full, from eleven retained qualification stages of about 3 GB
each. Their disposable `source` and `pm-home` trees were removed, keeping receipts,
logs and probe evidence. The unchanged release `48b68ad` then qualified against
`1298c8e74baa73e1a2b90124228d017261ac6bc4` with the tracked repair
`50aaad61643d004d955a93a336bb1466578e0d95fd1b2b9a1b52bccda98d8acb` unchanged.
The reviewed recovery helper's read-only check passed, then recovery restarted the
app, dashboard and gateway under an owned lease. It verified original Google HTTP
and fresh WebSockets, both Discord connections and the installer maintenance route
before clearing maintenance. The app doctor then reported Hermes ready.

## October 4 app release 48b68ad

PR #32 merged at `48b68ad6d56649f8689223f32a33f38f8d6ac8bf`. The release is live at `https://agentui.wildflowersranch.com`,
web build `adedc5d03eafb410`, from the archive with SHA256
`76338a853a0a83452f0f169d16e46e0beaab05f4c94ec8c43a1f30e3bd4e8ebd`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-48b68ad6-20261004T021449Z.json) records the result. Hermes remains
at `5bba024d8ddd`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.

The full repaired-source qualification bound integration digest
`53cce604230c301023dfcd2ccb3db240c437e9b4fd02e73b3d5df06ca3f97692` with production
source unchanged. Before activation, `APP_BACKUP_DIR` was added to the private app
environment, after a private copy of the previous file was kept.

After activation the app started on Node 24.21 at schema version 2. The worker
expired the 10 queued notifications older than a day and delivered the 5 newer ones
that the previous release had been holding behind test pushes, and push delivery
resumed. Loopback readiness reported the database, Hermes, worker, push and backup as
OK. The public readiness endpoint returned only `{"ok":true}`. Pages carried the new
CSP, HSTS and Permissions-Policy, JSON responses the API policy, and native sign-in its
own nonce policy. The administrator's existing terminal session was kept and no shell
was pruned.

## October 3 production hardening

This change versions the app database, restricts the system terminal to
confirmed administrators, adds logging, readiness and retention, sends a
content security policy, revalidates polled reads with ETags, splits the web
app shell, formats timestamps in one place and checks the iOS contract against
server-generated fixtures.

The source state covers 616 files:
`sha256:2105a03753145cc72c6e8ecc6b384b1982cd251b9ae2a433c731cbb7dc167b8d`.
All 427 application tests passed on Node 24.21 and 26.10, along with the
production build and the CI Python contract checks. The tmux-backed computer and terminal checks run in CI only.
Every new rule was broken on purpose at least once to confirm its test fails.
The migration tests open a copy of the exact previous schema, check the indexes
in query plans and check that the previous release's positional writes still
work on a migrated database.

The real server ran locally with explicit local accounts, a fake Google client
ID and a stand-in tmux whose shell is `cat`. Headless Chromium recorded no CSP
violations across sign-in, Today, preferences, the desktop, the confirmation
step and an open shell, and observed real 304 responses on bootstrap and
computer polls. Fixture previews covered conversations, artifacts, the avatar
editor and voice with no violations. Logs showed terminal audit lines and no
ticket values. Old and new web builds produced identical screenshots, except
for clock-driven text, and identical URL and history behavior.

On Xcode 27 with the iOS 27 simulator, all 69 native unit tests passed, including
decoding of all 60 server-generated contract fixtures. Ten of the 11 phone flows
passed. The seasonal avatar flow is flaky before and after this change: it passed
2 of 5 runs here and 2 of 3 on unchanged `main`, always failing to resolve the
Save avatar button's hit point after swiping.
The new CI job runs the unit tests with the `macos-26` image's default Xcode 26.6.
Its first run could not type-check the chip layout in reasonable time; splitting
that sum into typed helpers fixed it.

An independent GPT-6.1 Sol review found no blockers. Its five findings were
fixed: error logs now keep only fields the app sets, iOS no longer caches a
response that arrives after an identity change, the confirmation step works
under development Strict Mode, the documented journal filter matches the JSON
level and the quiet-hours copy mentions security alerts.

The first Node 24 CI run exposed a production defect present before this change.
`node:sqlite` on Node 24 refuses to bind `undefined`, so a queued push without an
assistant, such as a test push, threw during its visibility lookup and aborted
every worker pass. Production had been holding 15 real notifications behind five
test pushes for about 33 hours. Notifications without an assistant are now
visible, a notification that cannot be processed no longer blocks later ones, and
pending notifications expire after a day to match the Web Push TTL.

Not covered here: a real Google confirmation, Safari, live Caddy headers,
prune against real tmux and push alerts reaching a phone. Production activation
requires a fresh repaired-source qualification because integration inputs changed.

## October 2 app release e9003ae

PR #30 merged at `e9003aeb6a741462eb13f797cf8c61a246efbf4d`. The release is live at `https://agentui.wildflowersranch.com`,
web build `4a81f4c3df4b5b16`, from the archive with SHA256
`7c76028e881801be6e893761e13e68b23536c387060eaebe7abbf81a09ed6a73`. The host build reproduced the local web build.

The app integration inputs were unchanged, so the existing qualification receipt validated against the release and was reused. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-e9003aeb-20261002T180101Z.json) records the result. Hermes remains
at `5bba024d8ddd`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.

## October 2 app release cea1934

PR #28 merged at `cea1934d7af5aef6a2a43dcfce822ea085ed68ca`. The release is live at `https://agentui.wildflowersranch.com`,
web build `6a1f6107dfd4e9b8`, from the archive with SHA256
`4d3c9447d0c45c6a8baac4ae26698ef3546b01bee0d8ad1ae6f09600685a294c`. The host build reproduced the local web build.

The app integration inputs were unchanged, so the existing qualification receipt validated against the release and was reused. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-cea1934d-20261002T155445Z.json) records the result. Hermes remains
at `5bba024d8ddd`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. A signed-in household session was not exercised.

## October 2 app release 75a37f3

PR #26 merged at `75a37f3c51482e0aa8ff93b26fdc86c1e0e832c2`. The release is live at `https://agentui.wildflowersranch.com`,
web build `e64054bf241db021`, from the archive with SHA256
`38f14c5f3d974fb8b787c9e2448736e63e792159dab9422bc68ca3e5345219a5`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-75a37f3c-20261002T151724Z.json) records the result. Hermes remains
at `5bba024d8ddd`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear.

[Authenticated acceptance](evidence/household-discovery-app-20261002.json) now
passes for both native profiles: original history from search, all five routine
history listings, saved-pointer reads, scheduler previews, enabled starters,
automation usage, native memory/vault metadata, Today and hosted group readiness.
Both canonical conversations stayed unchanged, and the temporary app session was
removed. It did not create a production group, send messages, pause a routine,
or change memory or vault entries.

The [full repaired-source qualification](evidence/native-history-renderer-release-5bb-20261002/manifest.json)
and all 18 private authentication regressions passed, binding integration digest
`da5c11ec2514792874971c5c5338866e175bf848d3a4825467b321cbc9dd25a5`.
An earlier disposable attempt hit a Chromium page-startup race and issued no
receipt; a fresh complete run succeeded. Both attempts remain in owner-private
operation records. The active qualification receipt's staging directory is
retained on the VPS. Signed physical-device installation and push delivery remain
external acceptance.

The operations README records this active release and matching qualification;
its prior copy remains in the private activation directory. The documentation
follow-up covers 525 source files:
`sha256:9109eafaa4a3dca2945340d57a8c32aa00c428a345396c113e37938a836f3717`.
It changes only sanitized evidence and this ledger. Implementation, native and
CI checks remain applicable to unchanged product inputs.

## October 2 production history renderer follow-up

Authenticated post-release acceptance exposed an entrypoint mismatch: disposable
qualification supplied Hermes's renderer, while the production dashboard wrapper
left it unset. The follow-up supplies the patched native renderer in production
and requires a callable renderer before installing any experience route. The
existing dashboard contract now exercises this dependency and checks early
failure for an absent renderer.

The source state covers 512 files:
`sha256:b82c12dddace1883bd349d023ac292129b421a441d8e404097ce82b0b5d8ab2e`.
Six production-startup contracts and twelve experience regressions passed.
Independent GPT-6.1 Sol review confirmed the patched renderer is read after
extension installation, both entrypoints supply it, and no blockers remain. Web,
iOS and other successful checks apply to their unchanged inputs. Production
activation requires another full repaired-source qualification. The complete
68-test native result bundle is retained privately; Xcode's later simulator
diagnostic collection timed out after the tests, and the final result remained
successful.

## October 2 app release 3b9263f

PR #25 merged at `3b9263ff0dc10c11a5ddacb5395dca1021a15d71`. The release is live at `https://agentui.wildflowersranch.com`,
web build `e64054bf241db021`, from the archive with SHA256
`8b2185b5f25f4eaaede3eb77b30790598a0e86bfcdeead4ca3b8f27b91535a6a`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-3b9263ff-20261002T145601Z.json) records the result. Hermes remains
at `5bba024d8ddd`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. Authenticated acceptance then exercised Today, native
memory/vault metadata, search, automation usage, saved-item listing and hosted
group readiness. Opening original history failed because the production wrapper
omitted the native renderer; the follow-up requires that renderer at startup and
adds a production-entrypoint regression. The interim release was not accepted as
complete. Its successful [repaired-source qualification](evidence/native-household-release-5bb-20261002/manifest.json)
binds integration digest `d4012b7a59c727ab87f832028e25572f8382a91cd40c3e52ae1510393c549751`.
The original receipt directory is retained on the VPS.

## October 2 household discovery, sharing and oversight

The final implementation adds native conversation and attachment-name search,
per-account saved conversations/replies/routine outputs, a reviewed iOS share
inbox, Today as the default landing page, scheduler-reported upcoming work,
quiet hours and durable notification batches, editable task starters, truthful
tool receipts, and automation controls with recorded usage. It includes the
agent messages, routine results and hosted group chats described below.

The final source state covers 500 files:
`sha256:f7e7dfea7fa07a297086133bfacfa92eb94166ba817523b9cae1cb7befb53356`.
The web build is `e64054bf241db021`; 364 web tests and 106 Python tests passed,
with one Python skip. The final Xcode 27/iOS 27 run completed 60 unit tests and
eight phone UI flows with no failures. The native flows exercise search,
bookmarks, automation oversight, share-to-draft review, routine recovery, and
group creation/messaging. Physical-device signing, App Group provisioning and
push delivery remain external acceptance.

The [disposable qualification](evidence/native-household-5bb-20261002/manifest.json)
passed against clean Hermes `5bba024d8ddd388f56f354c1f789be825e3d8a3c`, app probe source
digest `5ae031c6671d2b7ccef5dca00ef55c1d8360f0470ec0266501a9200164f20d69`.
It exercises native search, scoped read-only history, recorded usage, routine
outputs, persistent group replies and all existing integration probes. The
production release requires another qualification against its approved repair.

Agent browser acceptance exercised Today, search, history, bookmarks,
pause/resume, editable starters preserving an existing draft, and tool receipt
expansion. Desktop and phone fixtures were inspected without horizontal overflow.
An independent GPT-6.1 Sol review verified fixes for notification navigation,
visibility changes in digests, native image formats, stale navigation, compacted
history and attachment attribution across native session clones. Its final pass
reported no blockers. Successful checks were reused for unchanged inputs.

## October 2 agent messages, routine results and group chats

The working branch implements distinct incoming agent messages and outgoing
handoffs in Simple mode, profile-scoped routine history/output, routine
notification links, and local 2–6 assistant group creation and messaging on web
and iOS. Group replies, approval and stop controls use Hermes's own persistent
coordinator. Unsupported coordinators keep history readable and disable sending.
Uncertain sends and room creation retain their original request for an explicit
duplicate-safe retry. No production service or release changed.

The final source state covers 471 files:
`sha256:f08bb89844db777f472feda737153d6b6274ac83b4b73efaeb020034b16c5651`.
The web build and 350 tests passed. The Python suite passed 101 tests with one
skip; the subsequently changed routine reader passed all eight affected tests,
including absent jobs, exact profile scope, symlink previews disguised as
synthetic metadata, cross-profile fallback rejection and bounded output. Checks
for unchanged inputs were reused.

Xcode 27/iOS 27 passed 56 native unit tests and five existing household experience
UI flows. The final focused phone flow passed saved routine output, two-assistant
room creation and sending. It fixed a cancelled List load during compact split
navigation by using the existing Today appearance/load-generation pattern. The
test now taps the actual toggle switches and checks membership before creating.
The [phone screenshots](../ios/evidence/native-collaboration-phone-review.png)
use synthetic Debug fixtures. Web screenshots at 1280×800 and 390×844 were
inspected in the private T3 artifacts, with no horizontal overflow. Escape closes
the results dialog; coordinator-off fixtures keep history visible and actions
disabled. Signed physical-device push delivery remains external acceptance.

The [final disposable native qualification](evidence/native-collaboration-final-5bb-20261002/manifest.json)
passed against clean Hermes `5bba024d8ddd388f56f354c1f789be825e3d8a3c`, app probe source
digest `ad029a3047bb61de06c5c1dcf965bce79d60fa5acce7b43651fa7d006e276a6a`.
Its native experience probe proves profile-scoped routine output, group creation,
send deduplication, a saved assistant reply, log reads and stopping. The full run
also passed native durability, private service/vault, shared computer,
maintenance and authenticated app probes. The Mac fixture paths now resolve to
their canonical temporary directories before the owner-directory checks.

An independent GPT-6.1 Sol review found and verified fixes for native non-UUID
thread replies, stale iOS polling errors, notification navigation and synthetic
routine-preview symlinks. Its final pass reported no additional findings.

## October 2 app release 2d26cae

PR #23 merged at `2d26caea07c2a7eb44d637ff5cd3e69d2862a404`. The release is live at `https://agentui.wildflowersranch.com`,
web build `2a6c12fa49203452`, from the archive with SHA256
`3024cfded5ab0f059fdcdc10f2904a5f56309901ad19970371947584eb5aba7e`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-2d26caea-20261002T042938Z.json) records the result. Hermes remains
at `5bba024d8ddd`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear.

The [authenticated app acceptance](evidence/vault-app-20261002.json) used a
temporary session for an existing allowed member. Both installed profiles returned
native vault metadata, memory and schedule previews. Today retained its durable
frontier, synthetic Edge speech was recognized through the app's xAI route, and
both canonical conversations stayed unchanged. The temporary session was removed.
This did not submit a production password, edit a vault entry, execute a routine,
or exercise a fresh Google browser sign-in.

The public page loaded the final JS/CSS and Google sign-in button at 375×667 and
1280×800 without horizontal overflow. Screenshots were inspected in the private
T3 browser artifact directory. Native phone/iPad simulator evidence remains
applicable to unchanged native inputs; signed physical-device distribution and
actual microphone capture/audibility remain external acceptance work.

The evidence follow-up covers 439 source files:
`sha256:d2a7f742b7ba7f17fb6ae4bf8c26d8c48edfb823a475ffca2b1357edfd38202e`.
It changes documentation and sanitized receipts only. Implementation, native and
CI validation remains applicable to unchanged product inputs.

## October 2 external native update recovery

The separately completed Hermes update left the current app at release `9273f8a`
with its earlier d23 qualification. The restarted dashboard correctly disabled
the unqualified private hooks, while the gateway still ran its earlier generation.
The new app's guarded preflight refused HTTP 401 from the unavailable maintenance
route. It changed no services or active release.

Full disposable qualification completed against native `5bba024d8ddd388f56f354c1f789be825e3d8a3c`
and tracked repair `50aaad61643d004d955a93a336bb1466578e0d95fd1b2b9a1b52bccda98d8acb`
for both the unchanged current app and merged login implementation. Each run
completed the native/app probes and all 18 private shared-OAuth/Google checks.
Their public archives are
[current app recovery evidence](evidence/native-recovery-927-5bb-20261002/manifest.json)
and [login release evidence](evidence/native-vault-5bb-20261002/manifest.json).
The corresponding integration digests are
`3d0359d2cae0b100917202e55606c4643f50460a1cd8a72a83714f0c938db809`
and `4f150ba50f8fa34ce8e5e8bca87743ff555fa478fe0f5d768920db4176085f38`.
Both runs proved live native source continuity. The read-only Chromium input
remained at SHA256 `481fea1516a1f2b76454664272f12cd9dd1f20117b21e1f1498e08bc7f872c00`.

The recovery helper keeps the current app release, qualifies its receipt, binds
native retirement and drain to the actual running generations, and installs the
receipt only after clean service stops and a persistent owned maintenance lease.
It fences household settings, service configuration, update ownership, source
and the untouched computer/terminal supervisors. Independent review added exact
pending-ingress and maintenance-path checks, plus binding to the app's actual
worker state and configuration. Uncertain recovery retains its phase for review
and refuses replay. Production recovery and login activation completed as recorded
here and in the release section above.

The frozen follow-up source covers 435 files:
`sha256:29df91c3f8e804d6eaa1202f81773a2654264d92908e7db03afdfb88af66f3bd`.
All 12 focused recovery checks, Python syntax and whitespace checks completed.
The helper SHA256 is
`3197324fb9385d2f03ce85633fda142da957e18c7135f949daff6d929f4c0076`.
Product and integration inputs are unchanged, so their successful checks and
fresh full qualification remain applicable.

PR #21 merged at `8e96d855821117de5966f8e499cfdc378523ca32` after both
Node 24.21.0 and 26.10.0 CI jobs completed. The merged helper's live read-only
preflight completed. Its first execution then stopped before mutation because
the old gateway's normal 60-second heartbeat exceeded the strict ten-second
freshness bound. Independent inspection confirmed the receipt, worker status,
service owners and admission were unchanged. The failed audit was preserved.
A new operation changed only its ID and waited for a fresh idle heartbeat.

That operation committed native retirement and stopped all three services, then
halted before receipt installation. The dashboard returned systemd's successful
SIGTERM verdict, while the helper required an ordinary zero exit. The app and
gateway returned zero exits; the old gateway's matching stopped acknowledgment
and clean-shutdown marker followed its owned drain. No receipt or lease changed.
Native 5b's server explicitly re-raises SIGTERM after graceful Uvicorn shutdown,
preserving that termination disposition; review checked the installed source.
The follow-up accepts only that dashboard SIGTERM verdict and adds a one-use
continuation of this exact stopped operation. It checks the original baseline,
unchanged receipt, stopped owners, owned drain and all existing source/config
fences before proceeding. It does not repeat native retirement or drain.

The stopped-continuation follow-up covers 435 source files:
`sha256:0c9aed122ad2f3c0d4282705f6b717780ca1882d9d74b4ded55324dc36ba1dbc`.
All 16 recovery checks, syntax and whitespace checks completed. The helper SHA256
is `17fefa55fc639dd9a97b71df49bbe496f5ce7c4602378c1a944ab7dfc76b4035`.
Independent review approved this freeze; the unchanged product qualification and
prior application checks remain applicable.

PR #22 merged at `e4a3cb32bcbdf799e9efd1a75a4ce3278f681248` after both Node
CI jobs completed. The one-use stopped continuation installed the qualified
receipt and started all three services. Native 5b gateway readiness, original
Google HTTP/fresh WebSockets, the owned maintenance RPC and all source/settings
fences completed. Verification halted at the old app's doctor command, which did
not pass its configured qualification file to the runtime. That command accepted
the earlier built-in d23 revision but falsely rejected newly qualified 5b.
Services remained running under the same owned maintenance lease and drain.

A read-only runtime check using the unchanged current app's modules and its actual
qualification file returned `ready` at native 5b. The follow-up forwards the
receipt in normal setup/doctor and uses that same qualified check during recovery.
A separate one-use finish verifies the existing running, guarded operation and
opens admission without repeating stops, starts, retirement or receipt writes.
All 17 setup checks, 21 recovery checks, typecheck, Python syntax and whitespace
checks completed. The frozen follow-up covers 436 source files:
`sha256:a724c9ba095d671f7a50715269cbf8fc403b26332183019dbb513ce2ce456bd5`.
Its helper SHA256 is
`ba48d425da936ac368816e3e71ef6cd6aec5c8115c38096c4577ba1fce46ee7b`.
The staging tool replaces repeated manual uploads with exact merged Git bytes,
hash verification and provenance in a fresh private audit directory. The native
integration digest remains `4f150ba50f8fa34ce8e5e8bca87743ff555fa478fe0f5d768920db4176085f38`;
successful product qualification remains applicable.

PR #23 merged at `2d26caea07c2a7eb44d637ff5cd3e69d2862a404` after both Node
CI jobs completed, including all 340 application checks. The merged staging tool
verified exact helper hashes and provenance. The same operation's one-use guarded
finish completed without service restarts or another receipt write. Its
[sanitized recovery receipt](evidence/native-recovery-20261002.json) confirms the
unchanged current app at that checkpoint, native repair, household settings and
guards, original Google/fresh WebSockets, Discord and restored maintenance RPC.
Admission cleared before the subsequent guarded login deployment. Both failed
phases and consumed continuation markers remain in the private host audit.

## October 2 native passwords and logins

Branch `feature/native-vault-logins` starts from merged PR #19, `9273f8a`.
Final full source fingerprint, 411 files:
`sha256:120333f4f2b140773881571120cd198931dd2ee601b94eacf2d5b111bac09c5c`.
Independent GPT-6.1 Sol high review approved this exact source with no unresolved
findings.
The implementation follows Hermes profile ownership and the existing household
access model. Local login secrets stay in the native encrypted vault; named API
secrets retain Hermes's separate environment store. The app exposes metadata and
finite source controls without a password reveal or chat-based credential path.

The complete application run covered 338 checks, with one outdated settings-tab
count corrected for the added Logins destination. Its ten settings checks then
completed. Independent review found a pending-submission reopening race; the
new regression and all 19 affected vault/conversation checks completed after
registering the volatile binding before transport dispatch. Unchanged successful
checks are reused. Typecheck and production build completed on the final web
inputs, web build `2a6c12fa49203452`. Web component fingerprint, six inputs:
`sha256:41c5fe9af08cf12ac7b28430c38e79ab6e7e5d99f8558ada4b5ca356d7d88a00`.

T3 browser interaction exercised inline synthetic login capture, saved metadata,
local removal confirmation, external source lock/unlock controls, and uncertain
settlement with cleared fields and disabled submission. Desktop 1280×1000 and
phone 390×844 layouts had no document or dialog horizontal overflow. A new
secure request scrolls its exact website into view before entry. The
[desktop review](evidence/vault-web-desktop-review.png) and
[phone review](evidence/vault-web-phone-review.png) contain explicit transport
fixtures, not real account passwords or external-manager acceptance.

The final compiled native fingerprint covers 37 inputs:
`sha256:2921a5814c6b457f8193ec19e4ae0800146b3ec7b78ac88f80abe2a01f920a55`.
Ten focused unit checks and the three vault/inline/background simulator flows
completed on phone and iPad. Later changes reused unaffected results and repeated
the affected uncertainty checks on both devices, asserting disabled fields.
Review's cancelled-add case uses a fixture that saves before reporting transport
cancellation; both devices verify cleared fields, disabled Save and a refreshed
list showing the already stored login. The unchanged management regression also
completed on both. One initial iPad test could not inspect its virtualized Save
row until scrolling; the scoped test was corrected and the affected flow repeated.
[Native fixture reviews](../ios/Parity.md) distinguish these controls from real
password-manager sessions and signed physical-device distribution.

All 58 Python Hermes contract checks and 65 focused Node checks completed on the
backend's frozen inputs, fingerprinted in the
[native input manifest](evidence/native-vault-inputs-20261002.json).
Backend fingerprint, 59 inputs:
`sha256:1788260309647c51bff439233442c563ed5f18cb6aefd6656f8d38315505c955`.
The integration digest is
`4f150ba50f8fa34ce8e5e8bca87743ff555fa478fe0f5d768920db4176085f38`.
CI initially found the dashboard startup fixture did not stub the new vault hook.
The corrected fixture now covers failed vault installation as well; all five
startup checks and three qualification-boundary checks completed. Vault contract
checks are included in CI alongside native memory ownership.
PR #20 merged at `6b65d7864624dd9899abd59f6031ddefe458c39c` after the final
Node 24.21.0 and 26.10.0 CI jobs completed, including all 339 application checks.
The release wrapper completed 18 checks. The unchanged installer's approved-tree
provenance suite completed 34 checks with one skipped test. The release qualifier
now reuses that provenance proof so upstream changes to diff headers cannot be
mistaken for a changed repair. It still reconstructs the exact tracked source in
an isolated checkout and checks live source continuity before issuing a receipt.
The installed native Chromium executable and its registry are read-only inputs,
fingerprinted before and after qualification; only disposable browser homes and
ports are used.

During a manual native fixture setup, an early native import latched the live
profile root before the marked test HOME was applied. The two uniquely named
synthetic profiles were removed. Before/after household profile hashes matched
and all five services remained active. The probe now checks native root and
profile directory resolution before creating profiles, and fixture launch applies
HOME before native imports. This failed setup is not acceptance evidence.

The [protected d23 native Google-gated service probe](evidence/native-vault-d23-20261002.json) completed 21 checks, including
an actual deterministic model-wire task invoking native `browser_vault_save_login`,
a locally owned secure prompt, scoped HTTP settlement and actual CDP password
filling on a synthetic page. A second real task took and released human control
during the wait and could neither save nor fill credentials afterwards. Model
requests, canonical history and event frames stayed canary-free. Native file and
terminal tools produced an explicit redaction marker for a newly saved named
secret, while the other profile retained separate redactor and environment state.
The native browser also refused an actual mid-fill navigation, leaving the new
page's password field empty. Full qualification of the merged release repeated
all 21 service checks against updated native 5bba024, as archived above.

Nicolas confirmed a separate session completed the live native update to
`5bba024d8ddd388f56f354c1f789be825e3d8a3c`. Its tracked diff hash is
`50aaad61643d004d955a93a336bb1466578e0d95fd1b2b9a1b52bccda98d8acb`.
A read-only exact-tree check proved it retains the approved repair. This branch
does not change the native checkout. The deployed release uses the fresh full
receipt for this revision, repair and final application integration, as recorded
above.

## October 2 app release 9273f8a

PR #19 merged at `9273f8a00a691b43892a019ebb9910b80009c275`. The release is live at `https://agentui.wildflowersranch.com`,
web build `fb52f56f6b997241`, from the archive with SHA256
`e00d37d1badcfa982a85dca356d8b3811ccdff7ccaead67504da7f52a3160f30`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-9273f8a0-20261002T032132Z.json) records the result. Hermes remains
at `d23cc6b06455`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear.

The full disposable qualification produced ten
[archived native and app receipts](evidence/household-d23-20261002T032132Z/manifest.json)
and completed all 18 private shared-OAuth/Google regressions. Its integration
digest was `3d0359d2cae0b100917202e55606c4643f50460a1cd8a72a83714f0c938db809`.
The public archive redacts the disposable qualification directory, including its
separate source checkout and runtime homes.

After activation, the [authenticated app acceptance](evidence/household-app-20261002.json)
checked Today, native memory and schedule previews on both installed profiles.
Synthetic Edge speech was recognized through the deployed app's xAI transcription
route. Both canonical conversations stayed unchanged, and the temporary allowed
member session was removed. This did not exercise physical microphone capture,
device audibility, a calendar Save or a fresh Google browser sign-in.

## October 2 app release b191747

PR #15 merged at `b191747771e3eb29691549c422f88956f97dcd68`. The release is live at `https://agentui.wildflowersranch.com`,
web build `a5279f6bae696ddc`, from the archive with SHA256
`3fb8789e56999012a3baf135b62501547c11ed29bde2f73bf72b87576b212631`. The host build reproduced the local web build.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-b1917477-20261002T015855Z.json) records the result. Hermes remains
at `d23cc6b06455`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear.

Full staged qualification used the exact merged integration inputs in a disposable
repaired d23 checkout and independent PM generation. The nine
[archived probe receipts](evidence/managed-shared-computer-d23-20261002T015434Z/manifest.json)
include the mandatory native computer checks. All 18 private shared-OAuth/Google
regressions completed. The qualification digest is
`c2306c2a41bdea9fd15b68e26c89cdda8cf52600a87e1c2aaf480b420756277b`.
The raw qualification directory remains private and retained for future audit;
the public archive redacts its disposable HOME.

After guarded activation, the final `hermes-computer` and
`agent-interface-terminal` user units were enabled and started. Both are independent
of the app unit. Actual checks confirmed all five app/Hermes/computer/terminal
services active, Caddy and WireGuard active, a loopback-only Chrome endpoint,
no TCP VNC listener, and the tmux foreground server's `exit-empty off` state.

The [authenticated app acceptance](evidence/shared-computer-app-20261002.json)
used a temporary session for an existing allowed household member, then deleted it.
Through actual app routes it verified native RFB streaming, takeover/handback,
a real resized system shell, preserved exported shell state after detach/reconnect,
and explicit end. It refused to touch an existing human shell or control lease.
This host acceptance did not exercise a fresh Google browser sign-in.

The public production page rendered at 375×667 and 1280×800 without horizontal
overflow, loading the final JS/CSS and its Google button. T3 screenshot capture
recovered on the production page. No physical iOS distribution was performed.

Follow-up source fingerprint, 342 files: `sha256:f62c365dd59ff3514a7399c07ec7fdaba6c73394636fafbf4cb009a4e834748e`.
This follow-up changes documentation and evidence only, so the implementation's
application, native and CI checks remain applicable.

## October 2 shared computer and system terminal

Branch `t3code/hermes-shared-browser-console`, based on latest main
`613a897c41cd53c44bf3a58f257fd4c065ffaaad`. Final source fingerprint, 330 files:
`sha256:79c41374c1dc7a6d2f269404c9b2778cf758f9e1ac12c4af10138edb00e16045`.
Web build `a5279f6bae696ddc`.

All 285 application checks, typecheck, production build and Python syntax checks
completed on the frozen source. The new checks cover session-bound one-use
stream tickets, Origin/CSRF and ownership, expired/revoked sessions, maintenance,
desktop reconnects, bounded terminal input and the phone text controls. Twelve
Python coordinator checks cover full-call cross-process control and recovery.
Existing integration, dashboard, qualification, gateway, worker, Linux-hook,
managed-fingerprint and release-wrapper checks remain applicable to their final
inputs. Dependency audit reported zero vulnerabilities.

The [native computer evidence](evidence/shared-computer-native-20261002.json)
binds nine native contract checks and four actual headed-browser checks to the
computer module hash and the repaired Hermes d23 revision. The real native
`browser_exec` kept separate bot tabs in one supervised Chrome, blocked bot input
during human control, and recovered an actual caught IPC timeout by closing the
interrupted targets while preserving sibling tabs and Chrome. Contract fixtures
alone do not establish display hardware behavior.

The real VPS PTY check used tmux 3.4 under its independent foreground supervisor.
It covered environment scrubbing, resize, interrupt, abrupt attachment death,
reattachment with preserved shell state, explicit end, and more than 128 KB of
Unicode paste with a stalled reader and matching content hash. Client `-N`
prevents an app attachment from spawning a server inside the app's systemd unit.
The separate supervisor keeps shell processes outside app deployment shutdown.

T3 browser use exercised the fixture desktop and terminal at 1440×900, 1280×800,
390×844 and 375×667, light and dark, including takeover, handback, reconnect,
terminal paste/end and mobile Unicode desktop typing. Documents did not overflow
horizontally. The fixture terminal does not execute system commands; the real
PTY check above supplies that evidence. Final T3 screenshots/recording failed
with PreviewAutomationExecutionError; earlier successful screenshots remain
available, and final mobile controls were checked with T3 DOM and interaction
tools. Native iOS built for the phone simulator; the browser shortcut was readable
and hittable on phone and iPad. The unrelated avatar tour failure was not counted
as a successful full tour. No new physical-device distribution is claimed.

Independent GPT-6.1 Sol high review approved the complete implementation and the
separate terminal supervisor. Review corrections cover recovery fencing, stream
lifecycle/ownership, useful native conflict messages and large-paste flow control.
The private host setup is staged; production activation and authenticated app
acceptance are recorded separately after the guarded release procedure.

## October 2 app release ae7528a

PR #13 merged at `ae7528a41f9cb29a5f6baa3fdcf2078d3170dcdf`. The release is live at `https://agentui.wildflowersranch.com`,
web build `a0fb842bb2ab828e`, from the archive with SHA256
`0ae02f34b6bff93e4a05ed3a897eb36c5d12b565fe2e255360b0dfbca82e72a1`. The host build reproduced the local web build.

The avatar schema/API changes invalidated the prior receipt, so preparation
stopped before service changes. Full qualification ran against a staged release of the same merged commit and
integration inputs, with an independent repaired d23 checkout and disposable
app/Hermes homes. The preparation archives have different byte hashes; the
qualified integration digest and reproduced web build are the matching inputs.
All eight integration probe groups and the 18 private shared-OAuth/Google
regressions completed. Production source and repair hashes remained unchanged.
The [managed evidence](evidence/managed-seasonal-avatars-d23-20261002T002305Z/manifest.json)
binds the public probe files. Its disposable HOME is redacted and raw evidence
remains private. Integration digest:
`cfbb15bcb7ddaf74c7c56a6a4bfaa7333e16605b2fb270ec69b928035731bd9c`.

Follow-up source fingerprint, 310 files:
`sha256:32941c061d1eb05c91c6e432149722e442a8fefc69d85c6e2baf363a83e01252`.
Application, native and CI checks from PR #13 remain applicable because this
follow-up changes documentation and release evidence only.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-ae7528a4-20261002T002339Z.json) records the result. Hermes remains
at `d23cc6b06455`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. Production T3 checks at 402×874 and 1280×800 found the
sign-in page filled each viewport without horizontal overflow. The Google button
rendered within bounds; final JS/CSS returned 200. Only the expected anonymous
bootstrap 401 appeared. A signed-in household session was not exercised.

## October 1 seasonal avatars and model discovery

Branch `t3code/seasonal-avatars`, based on `0e42a3f44c4098aa8bc0af531ce55124d23c3303`,
then merged latest main `dbcc06d4659b031f04d43829a52b814196350112` before PR creation.
Final source fingerprint, 300 files:
`sha256:047b79b24e43614a415cef03c6c57b8784201d8bd43656d4386c359cab836dd0`.
Web build `a0fb842bb2ab828e`.

All 262 application tests, typecheck and production build passed on the frozen
product source. Coverage includes each seasonal family's API persistence, editor
selection with preserved customization, shared animation/motion gates and model
catalog refresh preserving saved aliases, selection and collapsed disclosures.
The subsequent main merge changes only previously reviewed release tools,
CI syntax coverage and evidence; product validation remains applicable.

The native iOS client passed all 36 unit checks and six affected simulator UI
flows on the final source. These cover each seasonal family's selection/save/
reopen, all four More destinations with active section labels, conversation send,
failed tool catalog, connection checks, Apple permission denial and disconnect.
Native Details and Avatar remain visible; More replaces horizontal tab scrolling.
The live-connection test's Tools selector was updated but its external-service
run was not repeated. Exported simulator screenshots show all five characters
clearly. The native app was not distributed to physical devices in this pass.

The web specimen was inspected with all five characters at 90 and 44 pixels.
Reduced-motion SVG output was stable over 600 milliseconds for each character.
Final T3 checks covered the seasonal picker at 402×874, 320×568 and 874×402.
Every label fit, each seasonal target was at least 74×85 px, all five choices
selected their canonical colors, and document/dialog/content had no horizontal
overflow. Santa retained a Cowboy hat while working; sampled transforms changed.
The existing web More overflow menu remains usable. The selected provider opened
initially and catalog refresh completed without changing the saved selection.
The first snapshot retained an earlier color frame; opening the explicit tab and
recapturing produced the correct final artwork. Earlier full-interface viewport
coverage from PR #11 remains applicable outside the changed avatar/model areas.
Physical Safari keyboard/insets and Web Push delivery remain external acceptance.

Independent GPT-6.1 Sol high review approved the seasonal implementation and
model picker changes without blockers. Documentation review corrected a claim
that the native picker had a separate Seasonal group; only the web picker does.
[OpenBot design notes](OpenBotDesignNotes.md) record the pinned references and
adopted behaviors. No external code or artwork was copied.

## October 1 app release 0e42a3f

PR #11 merged at `0e42a3f44c4098aa8bc0af531ce55124d23c3303`. The release is live at `https://agentui.wildflowersranch.com`,
web build `f1e15cb6a74e9439`, from the archive with SHA256
`d2afecadff0529f614965e6135e625f63f2d793d7c7e06c11a99f96c86786a4a`. The host build reproduced the local web build.

The initial preparation stopped before service changes because adapter/API/type
changes invalidated the previous integration receipt. Full qualification then
ran against the exact staged release, an independent repaired d23 checkout,
a separate native PM generation and disposable app/Hermes homes. All eight
probe groups and the 18 private shared-OAuth/Google authentication regressions
completed. The [managed evidence](evidence/managed-assistant-controls-d23-20261001T233630Z/manifest.json)
binds the source and successful probe files. Integration digest:
`4f8b9446f59c800296f75675647c200d92baeaa771119ffa1483a252f78eabd8`.

Follow-up source fingerprint, 297 files:
`sha256:135e034fd3474aebfc3b3f552a10b146dc0acf7c07c3dfd4a129641f31ca1af3`.

The new repository qualification tool automates that procedure, checks its
archive, source, repair, regression files and dependency fingerprint, and issues
a private receipt only after the complete run. Independent GPT-6.1 Sol high
review approved it; local/remote program syntax and the 18 release-wrapper tests
also passed. Review found a staged HOME path in the new native probe receipt.
The archive tool now redacts that disposable HOME, refuses remaining raw home
paths before writing, and hashes the public bytes. Raw private evidence remains
intact. The new public receipt and its manifest were regenerated. CI now compiles
the repository's Python tools. Application checks
from PR #11 remain applicable because this follow-up changes deployment tools,
documentation and evidence only.

A fresh qualification receipt was activated with the release. The guarded release tool's no-change preflight passed.
Activation drained idle native work, switched the release and verified original
Google HTTP and fresh WebSockets, the configured Discord connections and the
gateway guard before clearing maintenance. The
[production receipt](evidence/production-release-0e42a3f4-20261001T234055Z.json) records the result. Hermes remains
at `d23cc6b06455`. Afterwards the public service worker reported the new
build, API requests required sign-in, the app and Hermes services were active and
maintenance was clear. The production sign-in page and Google button rendered
at 402×874 and 1280×800, filling both viewports without horizontal overflow.
A signed-in household session was not exercised.

## October 1 assistant controls, artifacts and device notifications

Branch `t3code/animated-avatar-model-selector`, based on
`84f143a8e58f607e84784a78a2eed96f059a226a`. Final source fingerprint, 286 files:
`sha256:ebba534861498fa17a517354bbb4cbabea95e63620802b8cbf220854f73d773b`.
Web build `f1e15cb6a74e9439`.

All 245 application tests passed. Final typecheck, production build, fixture
script syntax and diff whitespace checks passed. Earlier Python syntax checks
remain applicable because Python inputs are unchanged. Tests cover native model
catalogs, saved aliases, unavailable choices, search, personal favorites, older
clients and confirmation resets. Activity tests cover working/thinking characters,
settled replies and failure, interruption and disconnect guidance. Existing
reduced-motion and animation-loop tests remain applicable.

New behavioral checks cover the settings overflow menu and its keyboard focus,
artifact deduplication, filtering, source labels, bounded text previews,
cancellation, errors/retry, safe MIME handling and controlled media. Notification
checks cover account-owned status, CSRF, subscription registration, explicit
permission gestures, one-time onboarding, account changes, failed registration,
uncertain disable responses and signout cleanup. Browser subscription behavior
uses mocks; physical Web Push delivery was not exercised.

A read-only native RPC on the installed Hermes d23 source returned 105 model
identifiers across four authenticated providers, including `gpt-6.1-sol`.
No paid inference or profile mutation was part of that check. The Python Hermes
add-on and upgrade helper are unchanged. The model adapter, API and shared types
change the integration fingerprint, so deployment requires a fresh qualification
receipt. The release guard rejected reuse of the previous receipt before cutover.

The T3 collaborative browser exercised 402×874 portrait, 874×402 landscape,
320×568 narrow layouts and desktop widths. The phone dimensions use Apple's
iPhone 18 Pro display resolution with inferred 3× CSS scaling. Checks covered
full-screen light/dark sign-in, assistant navigation, working/thinking and
attention states, all six settings sections, the keyboard-operated More menu,
avatar controls, routines, preferences, integrations, failed-update recovery,
disconnected guidance, Markdown tables and oversized media. Documents did not
overflow horizontally; phone fields use 16px text. Provider disclosures, model
search, favorites and selection were exercised directly. Avatars changed across
sampled frames; PR screenshots and a recording show their motion.

Final artifact checks verified image layout, scrolling actions, text errors/retry
and download-only active content at all three phone sizes. Notification
preferences showed the truthful unsupported/disabled state. A visual-only
first-use fixture showed the invitation at 402 and 320 px; dismissal persisted
after reload and the composer stayed reachable. Independent GPT-6.1 Sol high
review approved this exact source fingerprint with no blockers. These fixture
and Chromium layout checks do not establish physical Safari keyboard behavior
or nonzero notch insets.
Native iOS client code was not changed or revalidated in this pass.

## October 1 interface and avatar deployment

PR #8 merged at `7fac68e44e7dbe9b28885a03eed2782778e3fbea`. The release is live
at `https://agentui.wildflowersranch.com`, web build `3dc4598be2f7b72b`, from the
archive with SHA256
`6aea21c1bd4824d97c948d0a9e077f4c2d85c020728898b0062d4c4800c547ae`. The host
build reproduced the locally verified web build.

The release changes clients only, so the existing qualification receipt validated
against it and was reused. The upgrade helper and profile settings were unchanged.
The guarded release tool's no-change preflight passed. Activation then drained
idle native work, switched the release and verified original Google HTTP and
fresh WebSockets, both Discord connections and the gateway guard before clearing
maintenance. The [production receipt](evidence/production-ui-avatars-activation-20261001.json)
records the result. Hermes remains at d23. The public service worker reports the
new build, the sign-in page renders without errors, and API requests still
require sign-in. A signed-in household session was not exercised after
activation.

## October 1 interface and avatar pass

Branch: `t3code/ui-avatar-animation-improvements`, based on
`15feb86989dab91072974ceb70d7235ed7125033`. Source fingerprint, 270 files:
`sha256:10d5ff5825eebf1389025b088a3faa108dc13aafd96247b5c57e1ade44ee992f`.
This pass changes clients, fixtures and documentation only. Server, Hermes
extension and deployment inputs are unchanged, so earlier Hermes and production
evidence still applies.

Web: 205 application tests, typecheck, production build, Python syntax and
script syntax checks passed. New tests cover the avatar motion model, the
animation loop lifecycle (frozen states, reduced motion, offscreen, unmount) and
the avatar editor. Chromium checks used the fixture-only
`.agents/tools/preview-app.mjs` at 1440, 820 and 390 px in light and dark themes.
They covered every dialog, keyboard operation of the editor, reduced motion
freezing all avatars, and composer growth. Avatar motion was reviewed from frame
strips and a recording of every state.

Native: on an iPhone 18 Pro simulator (iOS 27.0), 35 unit tests passed. UI tests
had 8 passes and 0 failures; the iPad-only and screenshot-tour tests skip by
design there. The iPad layout test passed on an iPad Pro 11-inch (M5) simulator.
The screenshot tour, `.agents/tools/ios-screenshot-tour.sh`, captured before and
after states, and a simulator recording confirmed native working motion.

Independent GPT-6.1 Sol high reviews of the web and native diffs found 14 issues;
all were fixed. They covered render-phase animation writes, frozen-state badge
motion, eye contrast for light custom colors, the reconnecting label color,
composer width changes, portrait restore, jump-to-latest after restoring a read
position, Dynamic Type tile labels, per-frame path allocation and missing
scheduling tests. The fixture renders, simulator runs and screenshots do not
cover a physical phone, closed-app notifications or real Hermes activity
timing.

## October 1 integrations deployment

PR #6 merged at `8515fff1eecbf5458e5085c8b9e97bbebb12790e`. The release is live
at `https://agentui.wildflowersranch.com`, web build `974365546ec56e79`.
Source fingerprint including the installer follow-up and receipts, 261 files:
`sha256:5c3cb2f49b6b8ac206e28d85dabbf163f353e32f9dab08f74659863409d01704`.
The [production receipt](evidence/production-integrations-activation-20261001.json)
binds the reviewed deployment helper, all 104 packaged inputs and archive SHA256
`a2dc6478f866d7297bc42ec3defa5a6837a423589637144256ea39730676f1ab`.

The [managed-runtime evidence](evidence/managed-integrations-d23-20261001T183800Z/manifest.json)
records the full native, extension, routines, integration, service, maintenance
and application run using an isolated PM generation and an exact copy of the
installed Hermes source. It includes the original approved OAuth repair
`2b8335c692f100640e375ffd338f26f6d86195a4ff91c2000e3306bcea9d671c`.
All probe groups and 18 private shared-OAuth/Google-plugin regressions passed.
The integration digest remains
`a9f21dad6508db87c43ee5eede29015526eccc1ca62bb510a2965c577681d885`.
Earlier application/iOS checks remain applicable because the follow-up changes
only the deployment tool and evidence, not runtime or client inputs.

Installer preflight verified both updater locks, idle native work and original
Google HTTP/fresh-ticket WebSockets before service changes. Independent GPT-6.1
Sol high review corrected the native guardian PID handoff and verified the receipt
activation sequence. The first cutover stopped cleanly and paused before changing
the release because the legacy installation had no qualification file. The tool
now records that absence explicitly instead of assuming a previous receipt exists.
An independently reviewed continuation rechecked operation, release, lease, drain,
inactive services, source/repair and settings under both locks. It resumed the
same owned operation without replaying shutdown, activated the verified receipt,
started the new release, verified recovery and cleared maintenance.

Production checks verified original Google HTTP and fresh WebSockets, both Discord
connections, both profile model responses in canonical history, actual terminal
output in canonical tool messages, both integration inventories and a live provider
health check. App, dashboard, gateway, backup timer, Caddy and WireGuard are active.
Both profile settings and the approved repair stayed unchanged. The public sign-in
page and Google button render; a fresh household app sign-in was not repeated.
Hermes remains at d23; deployment did not install a new Hermes version. Live new
vendor consent and physical-iPhone acceptance remain in external acceptance issue #1.

## October 1 integrations and failed-update controls

Branch: `feature/integrations-update-recovery`, based on
`30a56c54a0478ec363628106bde096f5014b3daa`.
Final source fingerprint, 251 files:
`sha256:db56714802da303db0e9a0a840b1b99cd7751d29b01f1a79d864c0b28c82793a`.
The source-state tool excludes this ledger, private fixtures and ignored build
products. Python and TypeScript independently computed the same integration
digest: `a9f21dad6508db87c43ee5eede29015526eccc1ca62bb510a2965c577681d885`.

### Native evidence

The [eight receipts and manifest](evidence/integrations-update-recovery-20261001T175600Z/manifest.json)
record a fresh isolated run against clean upstream Hermes
`d23cc6b06455b8551fb6f61d3cad040a0e82f5b6`. This run used the actual native
implementation and Google dependency extra, a disposable home and deterministic
provider. It did not use production accounts, mutate production, or qualify the
production OAuth repair or managed runtime.

Native checks passed: 15 native execution checks, 14 extension checks, four
routine groups, 15 integration checks, nine service checks, 13 maintenance checks
and 13 authenticated application groups. The app run started at
`2026-10-01T17:55:01.450Z`; its source digest stayed
`2c5b20bf66f56d6fc21ade9d80516131c0253ffcddc4bc629e14cdef3a27434f`.
Executor restart recovered automatically in 824 ms in this local run, preserved
the interrupted state and required explicit review before new admission. That
timing is an observation, not a latency guarantee.

The integration probe exercises native credential ownership, effective bearer
rotation, cancellation of original-dashboard OAuth workers before removal, a
concurrent start/removal fence, private sensitive-handler authentication, lost
authorization flows, protected-file and special-file rejection, and independent
Google Tasks/Selected files toolsets through actual native profile configuration.
Google OAuth construction uses the real library, PKCE and scopes without a live
token exchange. Original native sensitive endpoints still reject the service
principal outside the finite private integration bridge.

### Application, recovery and clients

- 182 application tests and the production build passed on Node 26.10.0.
- Python checks passed: 35 worker recovery tests, 19 Linux hook tests, ten
  managed-dependency fingerprint tests, ten integration tests, five dashboard
  contract tests, three qualification contract tests and six gateway guard tests.
  Python compilation and whitespace checks passed.
- Worker coverage includes durable control replay, safe cancellation, recovery
  after process death, inherited worker locks, actual native update-lock ownership
  through a guardian, rollback verification and admission-release uncertainty.
  Two Node/Python checks read the actual persisted recovery output and cover the
  cleared-error compatibility regression.
- Native iOS: 25 contract tests passed. The final reminder-window adjustment was
  followed by its focused boundary test and a native build. Simulator UI exercises
  covered account health, actual Calendar permission denial, guarded service
  restart and disconnect refresh after the native flow response.
- Browser exercises covered desktop and phone layouts in both themes, check and
  reconnect, device-code cancellation, recovery confirmation and progress. T3's
  remote preview could not reach this Mac's loopback fixture; Playwright CLI with
  installed Chromium exercised the local app. The PR includes sanitized web and
  native screenshot collages.

Successful checks were reused when their inputs stayed unchanged. The full app
suite and build ran after the worker fixes; final native-only changes were
followed by the native integration probe, dashboard/gateway checks and complete
isolated spike. No runtime edits occurred during that final spike. Documentation
and the evidence archive were finalized afterward.

### Review and limits

Independent GPT-6.1 Sol high review covered the full branch and subsequent fixes.
Findings addressed recovery JSON parsing, iOS disconnect response decoding,
reminder end-date inclusion, authorization writes after disconnect, concurrent
native MCP starts, stale bearer headers, protected folders, broad toolset
enablement, lost flows and gated native OAuth compatibility. The reviewer verified
the fixes and reported no outstanding findings.

Live vendor OAuth, installed MCP services, physical-iPhone permission behavior and
the intended production configuration remain in
[external acceptance issue #1](https://github.com/NicL9923/agent-interface/issues/1).
Apple integration shares explicit snapshots with a draft; it does not provide
unattended server access to the phone. Google grant commits fence the native
dashboard, not independent gateway or legacy CLI credential writers. Recovery
without sufficient saved qualification or with uncertain admission release still
requires installer repair. This branch has not been deployed, and it did not
install a production Hermes upgrade.

## October 1 updater recovery

Source digest: `fb157509ca509af5276fba76b6a442dda7474a02c58912281b22141e35b74783`.
Release archive SHA256: `4641949a65eb8865d8df4861d72d474bad7257fa3f2454bfe4a060b074b04730`.
Integration digest: `d16a95803957b63b83d1071715d6176821868e72da40eafc45388e35dfaa26d5`.

The failed install stopped at its first systemd user-service query before taking
native maintenance or changing source. Recovery held the app worker and native
updater locks, verified the source, repair and qualification inputs, completed
the pending install request, and cleared application maintenance.

Validation passed: 159 application tests, production build, 15 Linux hook tests,
10 managed-fingerprint tests, 29 worker tests, five dashboard contract tests,
three qualification contract tests and six persistent gateway tests. Application
checks were reused after Python-only follow-up changes. The final fingerprint
tests cover checkout metadata, PM workspace snapshots, external `.pth`
dependencies and missing installed records.

Real isolated integration passed against candidate
`663362680b6ffa4fbffeb58f6682564239a1953b` with its retained repair. The live
sanitized-environment check reached the user service manager, attested the
installed runtime, acquired and released native maintenance, and confirmed a
fresh gateway drain acknowledgement without stopping services.

The guarded release procedure deployed the repair and verified original Google
protected HTTP, fresh-ticket WebSockets, both Discord connections, unchanged
profile settings and cleared maintenance. Hermes remains at its prior working
revision `d23cc6b06455b8551fb6f61d3cad040a0e82f5b6`; no new Hermes version was
installed. The web build and dependencies are unchanged.

Independent GPT-6.1 Sol high review found an external-dependency attestation gap
in the first implementation. Preserving active-distribution enumeration and
adding `.pth` regression coverage addressed it. Final review reported no findings.

## September 30 production activation and upgrade hardening

PR #3 merged at `9fd1b88335ec179ac1d4ef787a3f2376cefbdf24`. The web release
is deployed at `https://agentui.wildflowersranch.com`. Upgrade controls, working
avatar animation and Advanced activity details are live. The installed Hermes
revision remains `d23cc6b06455b8551fb6f61d3cad040a0e82f5b6`; this work has not
performed a production Hermes upgrade. Earlier sections record their original
code states.

### Integration and source state

- Final source fingerprint, 228 files:
  `sha256:4fb3aa0d0acff2199589fdc2b2526e83a61c229ca04210a0950e13e5e2c13932`.
  The source-state tool excludes this ledger, private data and ignored build products.
- Final integration digest:
  `8099c54b0edcee869cdb947f3d56ef49a539f502167b50354a2f845a25b1b406`.
  Its [nine receipts and manifest](evidence/managed-approved-repair-d23-20261001T004802Z/manifest.json)
  record the complete managed d23 native, recovery, routine, service9,
  maintenance13 and app13 run. Digest and the exact original repair were
  unchanged before and after the run.
- The earlier deployment hardening qualification bound digest
  `7d7d8d81513e47ad487c4ae29f857abcea39104a7fdf12417a73d2dac349629d`.
  Its [11 receipts and manifest](evidence/managed-independent-source-d23-20261001T000702Z/manifest.json)
  preserve the complete managed d23 run separately from earlier evidence.
  Native execution, actual executor death/recovery without replay, routines,
  service transport, maintenance and authenticated application checks passed.
- The mandatory nine-check service probe launches the actual native listener and
  runs the exact Linux installer helper. It proves the `/api/ws` maintenance
  route, rejects the former route, wrong keys and foreign lease releases, and
  retains fixture Google authentication under maintenance. Both integration
  digest implementations bind this probe.
- The candidate Git checkout fetches complete official objects and the 106 exact
  installed tag identities. An actual independent fetch passed full `git fsck`.
  Native current-version metadata matched the installed source, including commit
  distance. The installed partial checkout stayed unchanged.
- Candidate object import precedes native shutdown. A real partial-clone fixture
  removed upstream access at the first service stop and completed install,
  verification and release offline. Missing objects refuse service shutdown.
- Nine focused Node qualification/update checks passed on the final source state.
  The pinned Linux Node 24.21.0 build and full type checking passed. CI runs the
  complete 159 Node tests and 64 Python checks on its two Node versions.
- All 29 worker checks and 14 Linux checks passed. They cover
  exact approved repair trees, changed diff headers, a second update after the
  first repair fingerprint shifts, content/mode/binary/added-file changes,
  conflict refusal, archive integrity, separate candidate/rollback fingerprints,
  and a repair edit between verification and admission release.
- The new bootstrap deployment tool passed ten isolated fault injections against
  the actual native retirement fence and exact recovery code. Lost commit replies
  recover through confirmed retirement ownership. Expired busy permits,
  unavailable proof and stale or mismatched gateway records preserve native
  processes. [Recovery receipt](evidence/app-release-retirement-recovery-20261001T002203Z.json).
- The subsequent guarded deployment tool rejected an install request created
  during app shutdown, preserving the request and native owners before lease
  acquisition. [Pending-request race receipt](evidence/guarded-app-release-pending-install-20261001T004552Z.json).
- [Actual provenance checks](evidence/approved-repair-provenance-20261001T004552Z.json)
  prove the same original approved repair on installed d23 and staged official
  `663362680b6ffa4fbffeb58f6682564239a1953b`. Independent object stores preserve
  installed Git metadata, object bytes and object modification times.
- Native source and artwork are unchanged from the recorded 24-file fingerprint
  `d2ecb032929967e44450107ebf23b210e2b6eea7ac9f8685cd724bf05e0987db`.
  The prior 22 native unit tests and affected simulator interactions remain
  applicable. The web assets still have build `404c0d099b21f1bb`.

These execution probes use a deterministic provider. Hermes execution, persistence
and recovery are real; they do not establish live model quality.

### Production checks

- A guarded cutover held the worker and native updater locks, owned the persistent
  maintenance lease, required a fresh drain acknowledgement and exact idle work
  record, and proved a clean native gateway shutdown before switching releases.
- Original Google protected HTTP and two fresh authenticated WebSockets passed
  before and after restart. Both Discord connections, profile settings and the
  approved OAuth repair were preserved. App, dashboard, gateway, backup timer,
  Caddy and WireGuard are active. Maintenance and the owned drain were released.
- The [final production activation receipt](evidence/production-upgrades-repair-activation-20261001.json)
  records 93 files matching the reviewed, qualified archive and the final digest.
  The exact approved repair artifact is bound to the private host configuration.
- The [first hardening activation receipt](evidence/production-upgrades-activation-20261001T002047Z.json)
  records 92 files matching the qualified archive. Public anonymous bootstrap
  returns 401 and local development sign-in returns 403. An actual Google identity
  authenticated to the app and read canonical bots with Hermes connected. The
  administrator update endpoint is enabled.
- The shared production browser loads the matching JavaScript, Google sign-in
  button and healthy API without horizontal overflow. The unchanged activity
  and upgrade layouts reuse PR #3's reviewed screenshots.
- The actual update check exposed a diff-header false refusal after applying the
  original OAuth patch to a newer official candidate. Upstream moved the repair
  hunk six lines; all repair body, context, paths and modes were identical.
  The fix keeps the original approved artifact immutable, proves its full tracked
  tree result, and binds the candidate's resulting diff fingerprint separately.

- The [actual production update check](evidence/production-upgrade-qualification-20261001.json)
  reached `ready` for official candidate
  `663362680b6ffa4fbffeb58f6682564239a1953b`. All seven source, repair, upstream,
  staging, dependency, integration and host regression checks passed.
  The candidate binds resulting patch
  `2d92905c98fd12e5a2e3035c5a1ea088fca0accba78560dcb7963aaf3335e425`;
  the original approved artifact remains
  `2b8335c692f100640e375ffd338f26f6d86195a4ff91c2000e3306bcea9d671c`.
  Installation was available to the administrator. The live source stayed on d23.
  [Eight full candidate receipts and manifest](evidence/official-upgrade-663-20261001T010552Z/manifest.json)
  preserve this official candidate separately from the known-d23 runs.

Independent GPT-6.1 Sol high reviews found and resolved the lost retirement-reply
recovery issue and tightened repair verification through final admission release.
No production Hermes install or physical-device acceptance is claimed. External
acceptance remains in [issue #1](https://github.com/NicL9923/agent-interface/issues/1).

## September 30 Hermes upgrades and live activity

PR #2 was merged at `1ec8ff5f3ff58afcc9c03b60c5161fc400bceccd` before this
follow-up. The new implementation qualifies an exact official Hermes revision,
offers an explicit administrator upgrade in web and iOS, and shows working
avatars with actual exposed reasoning and tool details. Production services and
the installed Hermes version were not changed by this follow-up.

### Code state and checks

- Final source fingerprint, 179 files:
  `sha256:9326a919fb45447b5b374ff97c38448656d9ac2384ab641cf7cc1d9ed3c3fe5b`.
  The source-state tool includes new files and evidence, and excludes this ledger,
  private data and ignored build products.
- Native implementation fingerprint, 24 files:
  `sha256:d2ecb032929967e44450107ebf23b210e2b6eea7ac9f8685cd724bf05e0987db`.
  This hashes sorted native source/asset paths and their SHA256 content hashes.
- All 159 Node tests passed against the final product changes. Type checking and
  the production build passed. Web build `404c0d099b21f1bb` caches seven static
  files. No transcript or API data is added to the service-worker cache.
- The 49 Python checks cover dashboard startup, receipt authority, the upgrade
  worker, Linux cutover hooks, the persistent gateway guard and managed-runtime
  fingerprints. They exercise staged additions, rollback, ownership loss,
  interrupted release, source/configuration changes, plugin dependency inputs,
  console script changes and an external virtual-environment interpreter alias.
  CI runs these alongside the existing Node version matrix.
- The worker's 18 tests use real temporary Git checkouts and fixture host hooks.
  The 10 Linux and six gateway guard tests use isolated host fixtures. These are
  control-plane checks, not a production systemd or Google acceptance receipt.

### Real Hermes qualification

- A final unknown-revision qualification run passed the complete native,
  add-on, executor-kill/recovery, routine, 13-group app and 13-check maintenance
  suites. Revision `c3a0ee37c8a60624433e19fe295bdaf910532731` is an empty local
  commit over `b9cb268deffc97946ec11645aa622a7353dd0591`, with identical upstream
  code. This proves the isolated unknown-revision path, not compatibility with
  a new official release. Its [receipt](evidence/hermes-upgrade-unknown/qualification-probe.json)
  and content manifest preserve the final run separately from historical evidence.
- The final real managed-runtime run passed the same full suites on
  `d23cc6b06455b8551fb6f61d3cad040a0e82f5b6`, with exact OAuth repair
  `2b8335c692f100640e375ffd338f26f6d86195a4ff91c2000e3306bcea9d671c`.
  It used native PM Python 3.14.7 and Node 24.21.0 in disposable VPS homes.
  [Managed runtime receipt](evidence/hermes-upgrade-managed/hermes-managed-python-probe.json)
  and [app receipt](evidence/hermes-upgrade-managed/app-probe.json) record the result.
- Both runs bind integration digest
  `c9bb7d65223d0b4fec2e6dbb1323eb0a2c734ff7f2a8735ff267424f6c577e48`.
  The application source digest was unchanged before and after each full run:
  `fa906aef5fb6cb9ddd0b7499adf5deb4c87ba623a9cdca93d5528c0227a97047`.
- The qualified managed generation matched an independently built native
  generation before and after the suite. Actual installed library and executable
  console script mutations changed its fingerprint; restoring the bytes restored
  the original fingerprint. A completed staging marker still allowed launch.
  The interpreter digest is
  `8dfa9757a52b9c3edf1dedaaa2a7a8c40ea4beb058f20e90bdd47b48f3b1b176`;
  dependency digest is
  `d3cfa55424cc1990eaf1523872225e397759dfd8ed9a68daed3e6a31a27f828e`.
- The repository evidence archiver now rejects failed/mismatched app receipts
  and refuses to replace older evidence with different bytes. Historical default
  receipt paths remain intact. New run directories include SHA256 manifests.

The provider in these probes is deterministic. Native Hermes execution, tools,
session persistence, admission, scheduler and restart recovery are real. Model
quality, live image providers and paid-provider behavior are not established.
The staged managed selection contained zero plugin dependency members. Plugin
dependency copying has focused unit coverage; the real runtime check does not
claim that branch was exercised.

### Native and browser checks

- Xcode 27 and iOS 27 passed 22 native contract/presentation unit tests. Focused
  iPhone UI checks exercised upgrade qualification, an uncertain install request,
  progress, verification and live activity with exposed reasoning/tool inputs.
  The final human-error presentation change passed an incremental build and its
  affected upgrade UI check in `ios-upgrade-human-error-20260930-r8.xcresult`.
  Unchanged tests from the recorded r4, r6 and r7 results were reused.
- The T3 collaborative browser exercised the actual web components with explicitly
  labeled fixture upgrade states and tool data at 1280 × 800 and 390 × 844, in
  light and dark themes. The agent inspected the screenshots. The inline avatar
  had an active animation and visibly changed. Phone layouts had no horizontal
  overflow; Escape restored focus and the closed drawer remained inert.
- Human status text remains primary. The diagnostic update reference stays inside
  collapsed checks. Advanced view exposes actual supplied reasoning and tool
  arguments/results; Simple view hides their payloads. Native spinner text is
  activity guidance and is not presented as model reasoning.
- [Web review](evidence/hermes-upgrade-web-review.png),
  [native upgrade review](../ios/evidence/hermes-upgrade-fixture-review.png) and
  [native activity review](../ios/evidence/native-live-activity-fixture.png)
  contain fixture content. They do not establish a completed live Hermes upgrade.
  Existing unchanged avatar artwork and reduced-motion checks remain applicable.

### Independent review and production limits

Independent GPT-6.1 Sol high reviewers inspected each other's implementation and
the root integration changes. Verified fixes addressed queued native RPC admission,
session/admission lock ordering, scheduled/deferred work, persistent gateway
ingress, staged repair files, exact runtime fingerprints, strict receipt booleans,
hidden/reused tool rows and status copy. Further native checks covered Codex's
completion-before-persistence ordering and repeated tool IDs. Adapter recovery
now discards old streamed details across an offline task switch. All reported
findings were verified resolved; no concrete code finding remains open.

Host upgrade activation is still opt-in. It requires the private installer
configuration, original Google HTTP/fresh-WebSocket verifier, shared OAuth and
Google-plugin regressions, and supervised gateway guard in
[HermesUpgradeLinux.md](HermesUpgradeLinux.md). Those host regressions are required
before the worker can issue a production qualification receipt. This follow-up
has not independently completed them on a new official candidate, exercised a
production systemd cutover, or upgraded the household Hermes installation.
Existing production sign-in/chat acceptance and issue #1 remain recorded below.

## September 30 native app and deployment

This follow-up adds the native iPhone/iPad app, native authentication and APNs,
qualifies the deployed Hermes revision, and hosts the web app under Nicolas's
explicit September 30 authorization. Earlier sections remain historical evidence
for their recorded code states.

### Code and integration

- Tested source fingerprint, 138 files: `sha256:052decf29d2d3430a241e24ababb8459763704d211bf454fdeeb440237edea1f`.
  The source-state tool excludes this ledger, private data and ignored build files.
- Final fingerprint after recording Nicolas's production sign-in/chat confirmation:
  `sha256:206566ba16d76abe7126e32589cb001785e0cfebff7d8c3b52ffdcb70b0c4ff3`.
  Only hosting documentation and the acceptance receipt changed; application code
  and the deployed runtime remain identical. The successful checks are reused.
- All 137 Node tests and the production build passed at 10:03 local time.
  The final web build is `09520ac38712c923`, with seven static cache entries.
  Linux Node 24.21.0 produced the same web artifact as the Mac build.
- Both clean Hermes `b9cb268deffc97946ec11645aa622a7353dd0591` and production
  `d23cc6b06455b8551fb6f61d3cad040a0e82f5b6` passed the isolated native, admission,
  restart, scheduler and application probes. The production checkout included
  the exact preserved OAuth repair recorded in the capability matrix.
- Final application probes passed 13/13 groups on each revision with unchanged
  start/end digest `d680d2c0e5c874a99fb5ef9d3efcd1b62be9befb910f2bb1b886db571545c900`.
  Separate `app-probe-b9-qualified.json` and `app-probe-d23-qualified.json` retain
  those receipts. Real Hermes execution used a deterministic provider.
- Six service-authentication groups passed on both revisions behind the actual
  native Google gate with fixture identities. Original cookie/native HTTP and
  WebSocket authentication remained separate from the private service key.
- The actual VPS managed-runtime probe passed six checks in a disposable home:
  original CLI startup, native profile home, private ticket, dashboard HTML and
  child-only shutdown. Five dependency-free wrapper tests verify qualification,
  safe fallback before hooks and failure after partial installation. CI runs them.
- Native API smoke rechecked one-use PKCE exchange, canonical conversation reads,
  browser-Origin rejection and logout revocation. Its current source hashes are
  in `native-api-probe.json`.

### Native and visual validation

- Xcode 27.0 on the Mac mini built the SwiftUI app with local ad hoc signing.
  Final native contract/presentation tests: 18 passed. Earlier phone fixture interactions, a dark iPad interaction test and a light
  iPad interaction test passed. Their unchanged controls, themes and artwork
  reuse those checks; the final navigation fix uses the real-server test below.
- A real-server iPhone UI test completed system-browser sign-in, PKCE callback,
  Keychain storage, fresh bot creation, a complete new canonical reply, the real
  Hermes tool catalog, avatar settings and deletion of the owned test bot. It
  used the isolated app server and deterministic provider. The empty-chat
  welcome is checked after leaving a long conversation, preventing stale-scroll
  and old-reply matches in the evidence. The final live suite passed one test
  with zero failures in 43.115 seconds at 10:41 local time, with the welcome
  required to be hittable without scrolling.
- The agent inspected native portrait/landscape layouts, native configuration,
  both themes, nine avatar state poses and reduced motion. Evidence lives in
  `docs/evidence/ios-live-review.png` and `ios/evidence/tablet-avatar-review.png`.
- Independent GPT-6.1 Sol high review covered the full branch, including new files.
  Fixes addressed identity races and in-flight flags, optional read-position
  pixels and hidden tool anchors, canonical-read failures, safe admission recovery,
  catalog save gating, empty/cached conversation scrolling, Markdown task lists
  and dark-mode contrast. No product or
  integration code finding remains open.
- Existing web visual checks remain valid for the unchanged layouts. The 32-test
  targeted read-position follow-up covered anchor-only native writes, web anchor
  restoration and visible-message recording; these are included in the final 137.

### Production

- `https://agentui.wildflowersranch.com` serves valid HTTPS through the existing
  Caddy installation. Cloudflare has the new A record. The application service
  starts automatically, passes doctor and uses the private loopback service key.
- All 28 deployed runtime source/package files match the local frozen files;
  `production-probe.json` records that manifest digest and sanitized checks.
- Anonymous bootstrap returned 401; local test sign-in returned 403. Production
  auth configuration reports Google configured, local identities disabled and
  native authentication version 1. The private Hermes service prefix returned 404
  through the public proxy.
- Existing Hermes Google HTTP remained authenticated. Two fresh ticket WebSocket
  connections succeeded after restart. The gateway process, both Discord
  connections and both profile configuration hashes were preserved. Caddy and
  WireGuard are active; unrelated proxy routes were retained.
- A missing setup template in the first release archive triggered the guarded
  rollback. It stopped the app, removed its new unit/drop-in files and verified
  the original dashboard before the corrected activation. The archive tool now
  includes the template and excludes ignored data and macOS metadata.
- The online backup tool recovered a committed WAL row locally with the source
  database open and produced owner-only files. The production daily timer is
  enabled; its first checked backup succeeded. Copies remain on the same host.
- Google authorized origins were saved and verified in the shared browser after
  Nicolas completed phone/email challenges. Existing origin/callbacks and account
  settings were preserved. Nicolas subsequently confirmed successful Google
  sign-in and a quick chat through the production app on September 30. This is
  user-reported production acceptance; the original Hermes Google session was
  independently verified by the agent. The second household identity and an
  unlisted identity still need production acceptance in issue #1.

Physical APNs/PWA delivery, Apple signing, physical accessibility/motion, live
image/MCP providers, unattended timed routines, goal continuation and compressed
history remain external acceptance in issue #1. Simulator and fixture checks do
not establish those behaviors.

The original local implementation record follows.

Local validation on September 29, 2026. Application tests, real Hermes execution,
visual checks, and physical-device acceptance are recorded separately. Production
was not changed.

## Code state

- Baseline: `8832778`, branch `implement/hermes-client`.
- PR source fingerprint, 68 files: `sha256:0548548282235d8f442a139d5a973c5782478a98a3e4adeff3f59fc934ac1b66`. The source-state tool excludes this ledger.
- Follow-up CI/documentation fingerprint, 69 files:
  `sha256:c9c673729e51ba63d7365e99ab31d8acd4bab85fb27b839805366e467228f385`.
  Application code is unchanged from `1e3d417`; the successful checks above are reused.
- Hermes: `b9cb268deffc97946ec11645aa622a7353dd0591`, isolated Python 3.14.7.
- Application: Node 26.10.0; backend tests also exercised Node 24.21.0.
- Final setup/recovery follow-up fingerprint, 77 files:
  `sha256:2032b612d9437d6533a9445c686f4efd6d2dd37581dc89ddcd03aed6d06c2aed`.
  Final product validation is recorded in "Connection and setup follow-up" below.
- Provider: deterministic local OpenAI wire fixture. Hermes execution, native
  tools and canonical persistence are real. Model answers are synthetic.

## Acceptance record

| Requirement | Evidence | Status |
| --- | --- | --- |
| Canonical bots, persistent conversations, shared model and instructions | App probe and browser round trips | Passing |
| Answers and actual tools | Native probe and canonical browser replies | Passing with fixture provider |
| Streaming and exposed reasoning | Native streaming probe; adapter tests for exposed string fields | Passing transport; no live reasoning model tested |
| Steering, attribution, approvals and stale requests | Application tests; native and authenticated app probes | Passing |
| Browser close, reconnect and app-server restart | App probe with active work | Passing |
| Executor interruption and explicit review without replay | Actual executor kill, provider-execution log and app gate | Passing |
| Uncertain submission recovery without duplicate execution | Durable receipts, native duplicate proof and application tests | Passing |
| Image, PDF and text upload with authenticated download | App probe | Passing |
| Generated-file provenance and download | Native tool and authenticated app probes; browser download | Passing |
| Bot, tool, skill and routine configuration | App probe | Passing; Hermes-required skills stay enabled |
| Routine execution, canonical delivery and durable discovery | Native scheduler provider and app recipient-only outbox | Passing; immediate native trigger, not calendar timer |
| Google verification, household allowlist and authenticated same-origin API | Application tests with identity verifier double | Passing; live Google sign-in not exercised |
| Per-person preferences, drafts, read positions and default bot | Application tests and browser checks | Passing |
| Durable notifications, task participants, followers and routine recipients | Application tests | Passing; push transport simulated |
| PWA static caching, updates and conversation deep links | Worker tests and browser cache inspection | Passing |
| Installed-phone push with app closed | Physical phone | Requires device acceptance |
| Geometric shapes, eye controls, transitions and state animation | Reference inventory, specimen review and browser | Passing visual review; original approximation |
| Mascot family and uploaded portraits | Browser configuration round trips | Passing |
| Generated portraits and live image generation | Native capability probe; UI handles unavailable backend | Requires configured image provider |
| Backend-driven states and reduced motion | Browser specimen, reconnect and task-settlement regressions | Passing |
| Phone and desktop layouts in light and dark | T3 browser, 390 × 844 and 1280 × 800 | Passing |

## Application checks

The initial PR implementation at `1e3d417` passed all 58 application tests. Coverage includes identity and
allowlist enforcement, Origin and CSRF, separate personal state, uncertain admission,
notification recovery, worker privacy, and the Hermes transport contract. Twelve
DOM tests cover safe Markdown, clipboard success/failure, deletion confirmation,
draft recovery during executor outage, and per-task interruption review.

`npm run build` passed full type checking and the production build. That UI
build is `c474588de95617ad`, with seven static files in its worker cache.

The full isolated native pipeline passed, including image-only canonical binding,
definite preparation failure and cleanup, cross-member approval, clarification,
generated files, steering, durable discovery, actual executor death without
automatic replay, and native routine execution with canonical delivery.

The initial authenticated app probe passed all 13 groups.
It started at `2026-09-30T01:34:02.619Z` and recorded the same application source
digest before and after:
`5130e0477f038a2f8e898d29d8d1051eeaeaa3dc73e7e468e56ce39a7ad26fd1`.
This includes the final image-only projection, sender and authenticated-byte
regressions, real routine execution with recipient-only outbox delivery, app
restart during active work, and executor interruption with explicit review.
The disposable probe bot was deleted. Native evidence and reproduction commands
are linked from the [capability matrix](HermesCapabilityMatrix.md).

## Browser checks

The [browser record](evidence/browser-probe.json) contains UI source hashes and
check results. The [review collage](evidence/browser-review.png) shows desktop and
phone layouts in both themes. The browser used the real isolated Hermes gateway.

Verified actions include two local identities and sign-out, a shared canonical
conversation with both sender names, bot creation and instructions, geometric
shape and color changes, mascot saving, authenticated portrait upload and reload,
drafts across bot switches, per-person theme and sections, and user-triggered
service-worker replacement. Cache inspection found only the static shell, hashed
assets, icons and manifest. No API responses, files or conversation data appeared
in that cache.

The standalone specimen visibly changed in its working state. Its SVG remained
unchanged with the reduced-motion control enabled. Disconnection also settled to
a static expression. Phone and desktop checks found no horizontal overflow. The
specimen control exercises the component's reduced-motion path; the T3 browser
has no native OS reduced-motion emulation control.

After review, the UI gained a visible explanation for definite rejected messages
and cleanup of delayed scroll saves when identities change. The final smoke check
verified approval cleanup, a visible rejected-image reason with its draft
retained, a fresh native portrait save, and the exact bytes behind a generated-file
link while tool details were collapsed. Image-only messages show the correct
sender, a loaded image preview and no raw server path. The final phone check
confirmed a 390-pixel document at a 390-pixel viewport.

## PR review and follow-up

An independent GPT-6.1 Sol reviewer at high reasoning effort inspected the full
implementation, including untracked files. Seven findings were fixed before the PR:

- Load personal drafts independently from Hermes so an executor outage cannot
  overwrite a server draft with empty content.
- Create paused routines atomically and use native pause/resume state transitions.
- Keep delete/cancel controls from submitting unfinished assistant edits.
- Definitely reject invalid registered attachments before native admission.
- Reset interruption acknowledgement for each task.
- Render untrusted Markdown images as explicit links, preventing automatic external requests.
- Require the verified add-on before paid portrait generation.

A native probe then hit a routine-list timeout under heavy host load. Tool-facing
cron listing performs machine-wide liveness checks and can delay the socket's
request queue. Routine listing and event discovery now use the official dashboard
job reader. The fresh 13-group app probe passed, including pause/resume/pause/resume,
actual scheduler execution, canonical delivery, recipient-only notifications, and
executor recovery. No request timeout was increased and no deadlock was claimed.

Fresh browser checks exercised formatted fixture answers, actual code copying,
scrollable code blocks on a 390-pixel phone viewport, a 1280-pixel desktop layout,
phone drawer focus wrapping, Escape, and native preferences modality. The closed
phone drawer is inert. The PR includes a labeled screenshot collage. These checks
used the T3 collaborative browser and the real isolated Hermes gateway.

## Continuous checks

GitHub Actions runs `npm ci`, the complete application suite, the production build,
and Python syntax compilation on Node 24.21.0 and 26.10.0. Actions are pinned to
verified upstream commit SHAs and use read-only repository permissions. Native
Hermes execution probes remain explicit local checks; CI does not claim them.

## Connection and setup follow-up

The guided `npm run setup` flow now checks the actual native gateway and pinned
add-on before atomically saving a private environment file. A successful CLI smoke
check used a disposable directory and the isolated browser gateway. Token entry
was masked, the saved file had mode `0600`, and `npm run doctor` succeeded without
printing the token. An unreachable candidate left the environment file absent.
Malformed app origins now prompt for an explicit correction; production bindings
and authentication requirements remain enforced.

The final application suite passed **117 tests** at 21:15 local time. The production
build and full type checking passed against the same product state. UI build:
`9c6158d21fec48b5`. Coverage includes socket ownership, handshake/read/mutation
deadlines, silent-socket recovery, reconnect backoff, read coalescing, auth and
compatibility diagnostics, preserved rosters, body-inclusive browser timeouts,
identity changes during a send, offline drafts, configuration checks and Google
script failure recovery. Snapshot coalescing preserves separate user identity,
preferences and CSRF tokens.

The final [authenticated app probe](evidence/app-probe.json) passed all 13 groups,
including physical executor restart and explicit interruption review. It started
at `2026-09-30T02:12:54.738Z`; the source digest was unchanged before and after:
`4bfd22e910e9a9d5c011ac56b804ead561e451af122e0e9ff2325e69c2dcb0e0`.
Automatic connection recovery after executor restart took 2,950 ms in this run.
This is an observed local result, not a latency guarantee.

An early isolated launch exceeded its startup deadline under concurrent host load.
Another probe expected an immediate read after executor restart, before the new
backoff expired. The probe now polls read-only bootstrap state with a bounded
recovery deadline, then verifies interruption and no automatic replay. A run during
review edits was correctly rejected by the source-stability check. The final run
above uses the frozen product state.

The [connection browser record](evidence/connection-browser-probe.json) covers the
unconfigured landing page, signed-in missing-Hermes guidance, offline edits and
server persistence after reconnect, and an actual stalled isolated gateway.
Existing conversation content and drafts remained visible, sending was disabled
during the outage, and automatic recovery restored sending. Phone width remained
390 pixels; desktop width was 1280. The closed phone drawer was inert. T3's browser
reported no available automation host, so these checks used Playwright CLI with
installed Chromium. The PR includes a new labeled setup/offline/recovered collage.
The browser recovered before the manual reconnect click; manual reconnect itself
is covered by transport and authenticated API checks, not claimed as a browser pass.

Independent GPT-6.1 Sol high reviews covered the full branch and separately reviewed
the setup author's work. Three findings were addressed:

- Native Hermes avatar metadata takes precedence over stale app presentation data.
- Confirmed admission clears only the matching sender draft inside the first
  accepted receipt transaction. Newer drafts survive, repeated receipts do not
  clear retyped content, and clean cached drafts never trigger autosaves.
- Invalid `APP_ORIGIN` values can be corrected by guided setup and produce named
  diagnostics in doctor and server startup.

The reviewers verified the final fixes and reported no outstanding findings.
Unchanged avatar and external-service acceptance records above remain applicable.

## Household experience, October 1, 2026

Nicolas requested all five proposed features for the next PR and authorized merge
and deployment. GPT-6.1 Sol high agents implemented native iOS, voice and backend
work; an independent agent reviewed the complete change.

- Frozen source, 374 files: `sha256:8b954c890567749cda1cdf196978813e1773e7122993cb34f141fe6b8b94e6c6`.
- Native compile inputs, 34 files: `sha256:f9e10e500813ffbffe027524b976fdf2f1b28f686ddcce36872e992f242d69d2`.
  Reproduce with the source-state tool and the four iOS source/project prefixes.
- `npm test`: 323 checks in 33 files. `npm run build`: web build
  `d6b58b54d729dd38`. The existing large-bundle notice remains.
- Python syntax and dashboard startup (5), qualification (3), integrations (10),
  native memory/manual scheduler (4), upgrade worker (35), Linux hooks (19),
  gateway guards (6), computer (12), managed Python (10), and release wrapper (18)
  checks completed successfully. The existing system-terminal check requires
  Linux/tmux and was skipped on this Mac; CI runs it on Linux. One existing
  upgrade-worker environment check also skipped.
- Archive boundary checks retained legacy compatibility, included the experience
  receipt in the manifest, and refused wrong-revision and failed native receipts.

The initial native run completed 43 unit checks and the core phone flows. The
final affected runs covered microphone review/cancellation, read aloud/stop,
memory revision conflicts, matching schedule previews, uncertain routine receipt
recovery and fresh request IDs. Three focused iPad flows completed. After the
frontier correction, eight affected units and two phone Today flows completed;
the exact snapshot-payload unit was rechecked against the final native inputs.
Result bundles remain in task-specific `/tmp/household-native-*.xcresult` files.

Agent browser use through T3 covered Today navigation and catch-up, checklist
save, itinerary note editing/save, memory editing/save, schedule preview,
explicit fixture trial completion, and calendar proposal review at desktop and
390-pixel width. The final labeled
[desktop](evidence/household-web-desktop-review.png) and
[phone](evidence/household-web-phone-review.png) collages were inspected. Native
[phone](../ios/evidence/native-household-phone-review.png),
[iPad](../ios/evidence/native-household-ipad-review.png) and
[late-event paging](../ios/evidence/native-today-frontier-review.png) evidence
was inspected separately. The preview uses synthetic fixtures; it executes no
external calendar save or native routine. Its insecure LAN cannot prove browser
microphone capture.

Actual native speech was checked sequentially on both installed profiles with a
short synthetic phrase. Edge produced audio and existing xAI transcription
recognized the expected words. Edge's supported first-use dependency installation
ran on the first call. No provider, profile or service configuration changed,
and no household content was submitted by the smoke check.

Independent review fixes preserve unsaved reply notes across polling, preserve
another memory document's original revision and draft, reject stale schedule
previews, tolerate native timezone abbreviations, fence paused manual-trial
admission under native locks, and keep late events unread using a durable
ingestion frontier. Every acknowledged event page is shown, including an empty
page acknowledgment. Removed profiles cannot obstruct the event backlog. Exact
canonical run attribution supplies late completion artifacts. Calendar Close
remains readable at phone width. New native qualification and subsequent
production activation receipts will be recorded after merge.

The first full staged qualification stopped in the experience probe after the
existing lifecycle and routine probes completed. The native RPC routine listing
defaults to active jobs; the probe incorrectly expected its paused trial in that
listing. A marked-home reproduction confirmed the exact lookup failure. The
follow-up requests disabled jobs explicitly and asserts the default listing still
omits the paused job. No native execution or product scheduler change was needed,
and no qualification receipt was issued for the failed run. Production retained
the previous release throughout this investigation.

The source check also clarified native manual-trigger behavior. Hermes applies
its normal schedule and repeat rules, which can move an interval's next run or
finish a one-time routine. Web and native copy now explain that behavior before
the action; paused recurring routines remain paused. This replaces the initial
blanket promise that the regular schedule would stay unchanged.

The follow-up adds a reviewed host acceptance tool for repeated speech checks.
It uses a short-lived allowed-member session, reads Today/native memory/schedule
previews, transcribes synthetic speech through the deployed app, and compares
canonical history before and after. It refuses maintenance, keeps credentials
and household content out of its output, and removes its session before issuing
a receipt. It does not edit memories, acknowledge a real person's Today page,
send chat messages or execute a production routine.

Follow-up frozen source, 375 files:
`sha256:245149decb5c02827c3f8ad011a0e72dd2d5b80307fd46360c8f2ee4dfa03748`.
The corrected real native experience probe completed in the marked disposable
environment. The eight focused web experience checks and rebuilt web
`fb52f56f6b997241` completed. The native copy-only follow-up compiled on the phone
simulator, at input digest
`sha256:809b8cfc3cb394cfa10aff09eb01106259e83810ee2f3e26212423f9abd00309`.
Existing product checks remain applicable to their unchanged logic. The new
acceptance helper passed its syntax check and independent review at SHA256
`a3fa36bcbdb613ff341ec8a2f6ec96912b127b276d28f725563a052b0f6f3b70`.

The second full qualification completed the experience, integration, service,
computer and maintenance probes, then stopped at the app's connection assertion.
The app probe forced service tickets against a headless loopback gateway. Native
Hermes deliberately accepts static tokens in that mode and enables tickets only
when public authentication is gated. A marked-home reproduction identified the
HTTP 403 during WebSocket upgrade. Both fixture runtime instances now explicitly
use static authentication; production service authentication is unchanged. The
separate gated service probe retains its finite HTTP and one-use ticket checks.
Connection assertions now include the existing sanitized diagnosis.

Independent review approved the correction at source fingerprint, 375 files,
`sha256:9728ada43cef8a9380aff959f2a0fd8bab0f770043c35c712fa547158c1876e4`.
All 13 app-only checks completed in the marked disposable native environment,
including shared chat, approvals, files, scheduler delivery and both app and
executor restart recovery. Its stable app input digest was
`6455465b5445e3eae51c43142084914c1db19733eb8e45865ddaefe0d5b9ddc0`;
the reviewed probe SHA256 was
`0a62b816939ef281dcb2fca5a4d2affc481cf2e32b11ab4d39037ef408ec05ce`.
Syntax and diff checks completed. Owned fixture processes were stopped afterwards.
No qualification receipt or production cutover was issued for either failed run.

Physical-phone microphone capture/audibility, native calendar Save, and signed
iOS distribution remain separate acceptance work. Existing image, push and live
external integration gaps remain tracked in issue #1. Server speech success does
not establish device microphone permission or audio behavior.

## Remaining external acceptance

- Google configuration and the first household sign-in/chat were confirmed on
  September 30. Verify the second household identity and rejection of an unlisted
  identity in production.
- Configure a live image backend, generate a portrait and a chat image, and verify
  delivery through authenticated app routes. No generated-image success is claimed
  from the deterministic provider.
- On the intended HTTPS installation, install the PWA on the actual phones, grant
  notification permission, close it, and verify completion and approval pushes
  open the correct bot. Simulated delivery and viewport checks cannot prove this.

Tracked in [external acceptance issue #1](https://github.com/NicL9923/agent-interface/issues/1), alongside live MCP, unattended timers, goal continuation and compressed-history checks.

These checks require external configuration or physical devices. Deployment and
infrastructure changes remain separately authorized work.
