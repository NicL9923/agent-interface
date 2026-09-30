# Native parity and acceptance

The native implementation uses the web client's settled scope in
[`docs/Plan.md`](../docs/Plan.md) and the same server endpoints. "Implemented"
means the native control and authenticated request path exist. The validation
ledger remains the repository's single source for tested code-state hashes.

The native unit run passed 22 tests on Xcode 27 and iOS 27. Focused phone fixture
UI checks covered upgrade qualification, uncertain install recovery, verification,
and live activity with exposed reasoning and tool arguments. Previous tablet fixture
UI checks passed in light and dark appearance. The root agent also validated
system-browser sign-in, Keychain storage, canonical chat, the full tool catalog,
and avatar settings against the isolated real Hermes instance.

![Tablet avatar specimen in both themes, using explicit fixture content](evidence/tablet-avatar-review.png)

These screenshots show static reduced-motion states. They do not establish live
motion fidelity or notification delivery.

![Native Hermes updates with explicit simulator fixture content](evidence/hermes-upgrade-fixture-review.png)

These upgrade screenshots establish native controls and recovery behavior with
fixture responses. They do not establish a real Hermes upgrade. The
[native activity fixture](evidence/native-live-activity-fixture.png) shows visible
working avatars and Advanced disclosures using explicitly exposed fixture data.

| Feature | Native implementation | Validation |
| --- | --- | --- |
| Connection onboarding | Pasted/bare HTTPS address, origin normalization, compatibility check, retry, change server | Simulator address validation; native origin/PKCE contract tests |
| Household sign-in | System browser handoff, S256 PKCE and callback state validation, Keychain bearer, proactive expiry, revoking sign-out | Real ad hoc signed simulator system-browser/local-member handoff and Keychain storage; native token/header/expiry/revocation tests |
| Personal and shared bots | Persistent roster, attribution, per-user personalization, create/edit/delete | Native forms and roster-to-conversation simulator path; server configuration integration in main ledger |
| Conversation and activity | Canonical transcript polling, Markdown/code/tables, read-only task lists, inline live animated avatar, Advanced exposed reasoning and actual tool arguments/status/results, deduplicated current calls, nine activity states | Native real-Hermes chat simulator path; Markdown/date/geometry and current-tool deduplication tests; focused live activity/details fixture UI pass |
| Steering and stop | Active-work guidance default, explicit stop confirmation | Same tested server admission/steering/stop routes; native controls implemented |
| Approvals and clarification | Household approve/deny, stale-server errors, answer options and text, official-interface fallback | Native controls implemented; server enforcement and clarification integration in main ledger |
| Interrupted/uncertain work | Per-run review, durable request IDs, lookup, reviewed same-ID retry, definitive-rejection recovery | Native unit tests for rejection vs uncertainty, new interruptions, identity changes and accepted-draft clearing |
| Offline recovery | Loaded roster/transcript cache in memory, scoped local drafts/read positions, backoff, manual reconnect, no automatic message replay | Native disconnect, canonical-read outage, read-anchor and identity-race tests |
| Uploads and delivery | Images, PDFs and text, ten attachments, 20 MB bound, authenticated image/Quick Look preview and share | Native multipart transport and identity-race tests; server upload/download integration in main ledger |
| Model/provider/instructions/MCP | Shared-model confirmation, existing model choices/identifiers, instructions, existing MCP identifiers | Native forms implemented; server configuration integration in main ledger |
| Tools and skills | Catalog reads, required-skill locking, explicit save, save disabled until successful catalog read, retry | Native catalog-failure simulator test; real-Hermes native tool-catalog read; server catalog integration in main ledger |
| Routines | Create/edit/delete/pause/resume, schedules, explicit persisted household recipients | Native forms implemented; server routine integration in main ledger |
| Three avatar modes | All nine original geometric silhouettes, palette/custom color, eyes/spacing/size, accessories, sprout/fox/bear mascot, generated/uploaded portrait | Native shape geometry tests; avatar specimen available for motion review |
| Avatar motion | 280 ms shape/expression transitions, idle blink/drift, depth orbit/back-face occlusion, thinking dots, blocked exclamation, working trails, 600 ms waiting settle, brief done celebration | Same independent formulas and artwork as web; native specimen inspection remains recorded separately from web reference acceptance |
| Reduced motion and accessibility | System reduced motion halts loops/rotation/trails, stable state language, native Dynamic Type and controls, labelled actions | Native specimen toggle; physical VoiceOver and large Dynamic Type acceptance remains external |
| Preferences | Simple/advanced presentation, system/light/dark themes, favorites, sections, default bot, follow all activity | Native preferences forms and tablet visual inspection; same persisted per-user server contract |
| Hermes updates | Preferences entry, installed/candidate versions, check and compatibility details, confirmed pinned-revision install, progress polling, rollback/failure guidance, busy-bot/admin/unavailable guidance; shared server bearer authorization | Native contract tests for authenticated requests, stale candidates, uncertain install recovery and identity fences; focused phone fixture UI covered qualification, uncertain admission, progress and verification |
| Native notifications | APNs device registration/opt-out/test, task/routine/follow recipients, validated cold/warm conversation tap | Native route tests and simulated server delivery tests; signed physical-phone delivery remains external |
| iPad | Adaptive native NavigationSplitView, readable-width transcript, native sheets | Tablet fixture UI navigation, settings and nine-state specimen exercised; portrait/landscape screenshots inspected in both themes |

## External acceptance

These checks require an installed signed build or configured external services:

- Complete real Google household sign-in on the configured production origin.
- Install the app on a physical iPhone, register its APNs token, close the app,
  receive a real completion and approval notification, and confirm each opens
  the correct saved conversation. Test native notification opt-out after relaunch.
- Inspect the native avatar specimen in motion at sidebar and expanded sizes,
  comparing all nine states with the original web specimen and reference
  inventory. Quantitative pixel equality with proprietary upstream animations is
  not claimed.
- Verify VoiceOver, large Dynamic Type, and the simulator-reviewed layouts on a physical iPad.
- Verify provider-generated images and generated portraits using a configured
  real image provider. Deterministic fixture images do not prove provider output.

XCTest fixture UI results, server transport tests, real Hermes probes, and
physical APNs delivery are different evidence classes. None substitutes for the
others.
