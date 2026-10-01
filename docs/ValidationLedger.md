# Validation ledger

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
