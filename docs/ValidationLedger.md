# Validation ledger

## September 30 native app and deployment

This follow-up adds the native iPhone/iPad app, native authentication and APNs,
qualifies the deployed Hermes revision, and hosts the web app under Nicolas's
explicit September 30 authorization. Earlier sections remain historical evidence
for their recorded code states.

### Code and integration

- Final source fingerprint, 138 files: `sha256:052decf29d2d3430a241e24ababb8459763704d211bf454fdeeb440237edea1f`.
  The source-state tool excludes this ledger, private data and ignored build files.
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
  settings were preserved. The new app's Google button loads, but its account
  chooser is inaccessible to the shared browser tools; household confirmation
  remains pending. The old Hermes Google session is independently verified.

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

- Configure Google and complete real allowlisted sign-in on the intended origin.
- Configure a live image backend, generate a portrait and a chat image, and verify
  delivery through authenticated app routes. No generated-image success is claimed
  from the deterministic provider.
- On the intended HTTPS installation, install the PWA on the actual phones, grant
  notification permission, close it, and verify completion and approval pushes
  open the correct bot. Simulated delivery and viewport checks cannot prove this.

Tracked in [external acceptance issue #1](https://github.com/NicL9923/agent-interface/issues/1), alongside live MCP, unattended timers, goal continuation and compressed-history checks.

These checks require external configuration or physical devices. Deployment and
infrastructure changes remain separately authorized work.
