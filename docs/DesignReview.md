# Full app design review

This pass covers the web client at desktop and phone widths and the native iOS
client. Nicolas requested a separate Claude Opus 5.5 review at High effort for
each screen. A screen must score at least 9/10 with no obvious remaining issues
before implementation moves to the next screen. Scores are reviewer judgments,
not objective measurements of design quality.

## Direction

Keep WildBots' warm neutral backgrounds, green accent and original animated
characters. Give primary tasks stronger hierarchy, use consistent type and
control sizes, keep reading widths comfortable, and preserve native iOS behavior.
Use spacing to group related content and reserve borders for useful separation.

## Accessibility checks

Normal text uses the [WCAG 2.2 contrast criterion](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum)
of at least 4.5:1. Pointer controls are checked against [WCAG 2.2 target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum),
with 44-pixel controls retained on phones. Native text uses semantic fonts and
large Dynamic Type layouts, following [Apple's font scaling guidance](https://developer.apple.com/documentation/uikit/scaling-fonts-automatically).
These references were checked October 25, 2026. They set measurable accessibility
requirements; the visual score remains an independent design judgment.

## References

References collected October 25, 2026. External artwork is reference material only.

- [OpenAI dots](https://openai.com/index/introducing-dots/): the published feedback
  screenshot shows a compact conversation beside a working document. Study the
  separation between conversation, composer and work, and the restrained chrome.
- [Meta Muse](https://www.testingcatalog.com/metas-muse-agent-enters-closed-alpha-with-invite-codes/):
  the published phone screenshot shows an avatar header, compact file cards and a
  persistent composer. Study spacing and the hierarchy of actions inside chat.
- [Claude Duet](https://venturebeast.tech/articles/claude-duet-first-look): the
  published conversation and Make screenshots show separate content groups,
  compact navigation and a persistent composer. The official launch article
  embeds video rather than still product screenshots.
- [Grok Bot](https://techdevnotes.com/apps/ios/grok-bot/6794501026): the App Store
  screenshots show a clear sign-in action and an avatar creator with tightly
  grouped controls. Images were retrieved from Apple's image CDN. The official
  product page blocks automated browsing with Cloudflare.

## Screen ledger

| Screen | Baseline | Implementation | Opus 5.5 High rating |
| --- | --- | --- | --- |
| Today, web and iOS | Web, iPhone and iPad captured | Complete | Web 9.2; iPhone 9.1; iPad 9.1 |
| Assistants home | Web, iPhone and iPad captured | Complete | Web 9; native 9 |
| Home context menus | Keyboard, touch and native submenus captured | Complete | Web 9.5; native 9.5 |
| Conversation and composer | Web, iPhone and iPad captured | Complete | Web conversation 9; web composer 9.5; iPhone/iPad conversation and composer 9 |
| Questions | Web, iPhone and iPad captured | Complete | Web desktop/phone and iPhone/iPad 9 |
| Approvals | Web, iPhone and iPad captured | Complete | Web desktop/phone and iPhone/iPad 9 |
| Failed and interrupted turns | Web, iPhone and iPad captured | Complete | Web desktop/phone and iPhone 9.2; iPad 9.1 |
| Assistant details and artifacts | Web, iPhone and iPad captured | Complete | Web details 9.1; artifacts desktop 9.2, phone 9; iPhone profile/artifacts 9.1, preview 9; iPad 9 |
| Assistant creation and settings | Web, iPhone and iPad captured | Complete | Web creation/details 9.1, confirmations 9.2; iPhone creation/details/confirmations 9.2; iPad creation/details 9.1, confirmations 9 |
| Avatar editor | 17 web and 15 native baseline states; 24 web and 19 each on iPhone/iPad after states | Complete | Web desktop/phone, iPhone and iPad 9 |
| Models and capabilities | 35 web before, 43 web after; 26 native before and after states per device | Complete | Models, Tools and Skills: web desktop/phone, iPhone and iPad 9 |
| Memory | 20 web before, 35 after; 18 native before, 26 after per device | Complete | Web desktop, tablet, phone, dark and 200% text 9; iPhone and iPad normal, dark, AX3 and recovery 9 |
| Work and learning | Pending | Pending | Pending |
| Routines and results | Pending | Pending | Pending |
| Logins and secure requests | Pending | Pending | Pending |
| Search, saved items and automations | Pending | Pending | Pending |
| Group chats and threads | Pending | Pending | Pending |
| Settings, following and home sections | Pending | Pending | Pending |
| Integrations | Pending | Pending | Pending |
| Computer and terminal | Pending | Pending | Pending |
| Hermes updates and recovery | Pending | Pending | Pending |
| Sign-in and connection recovery | Pending | Pending | Pending |
| Command palette and keyboard help | Pending | Pending | Pending |
| Attachments, upload failures and large paste | Pending | Pending | Pending |
| Find in conversation | Pending | Pending | Pending |
| Voice recording and playback | Pending | Pending | Pending |
| Status dock, connection notices and app updates | Pending | Pending | Pending |
| Toasts, undo and stop confirmation | Pending | Pending | Pending |
| Notification setup and settings | Pending | Pending | Pending |
| Apple device connections | Pending | Pending | Pending |
| Offline library | Pending | Pending | Pending |
| iOS quick switcher | Pending | Pending | Pending |
| Empty conversation | Pending | Pending | Pending |
| Empty household, app loading and load failure | Pending | Pending | Pending |
| iOS share extension | Pending | Pending | Pending |
| Widgets, Live Activity and notification content | Pending | Pending | Pending |
| Standalone computer page | Pending | Pending | Pending |

The avatar specimen is a developer tool and is outside this product design pass.
Native layouts also need a representative iPad check.

## Today review history

The initial independent review rated Today 5/10. The delegate result confirmed
`claude-opus-5-5` with `effort: high`. The reviewer made no implementation edits.
It identified flat hierarchy, names taking priority over requests, excessive
desktop width, inconsistent row alignment and empty-state overhead.

The first implementation leads with the request or result, includes written
reason and action labels, constrains the desktop column to 720 pixels, groups
pending decisions, preserves recognizable characters, and avoids listing the
same pending task again under current work. The empty state no longer creates
a separate attention card. The native regression test preserves acknowledgement
of the server's exact returned frontier.

The web and native capture tools share `.agents/fixtures/today-design.json` for
the populated state. Each platform also retains its original baseline fixture.

Screenshots use the repository's synthetic fixtures. Raw screenshots, annotated
comparisons and reviewer reports are staged under the task's DevSSD scratch
directory until the PR attachments are uploaded.

The first revised screen scored 8.5/10 on web and a provisional 8/10 on native.
The reviewer found that disconnected assistants lost their named errors and
conversation route, and that the work count included a task already listed under
decisions. Both now have focused regression coverage. The native screenshot
runner also corrected its large-text setting from AX2 to AX3. The current native
regression and capture tests passed, including opening a disconnected assistant.

Today passed the second independent review with no obvious remaining issues.
Scores were 9.2/10 on web and 9.1/10 on iPhone and the loaded iPad view. The
[review report](evidence/design-review/today-review.md) records the resolved
findings, accepted decisions and actual coverage.

## Home review history

Home passed the second independent review at 9/10 on web and native, with
9.5/10 for its context menus. The review covered iPhone and iPad. It confirmed
that unread indicators stay with dates, pinned labels and activity align, large
text stays readable, and outside touch dismissal cannot activate assistants
underneath the menu. The [report](evidence/design-review/home-review.md) records
the evidence and accepted limits. A stable home-list identifier now lets the
screenshot tour scroll the sidebar itself on iPad.

## Conversation review history

Conversation passes at 9/10 on web, iPhone and iPad. The web composer scores
9.5/10 and both native composers score 9/10. The
[web review](evidence/design-review/conversation-web-review.md) and
[native review](evidence/design-review/conversation-native-review.md) retain
the ratings, resolved findings and actual coverage.

Web messages use a consistent reading size, with a narrower desktop column
and larger metadata and code. Native chat uses a matching width limit and
a readable composer placeholder. Message metadata now passes contrast on
the user bubble. Native code uses real fixed-width glyphs despite the rounded
app font, verified by a rendering regression that first failed on the old font.
The start notice and related captions now use the app's muted text color.

Review 08 also found low-contrast captions in states not shown by these
conversation captures. Those remain assigned to their own screens, including
the empty conversation, reduced-motion activity, approvals, assistant handoffs
and stop confirmation. The final full-app review must include those states.


## Questions review history

Questions passes at 9/10 on web desktop, web phone, iPhone and iPad. The
[Opus recheck](evidence/design-review/questions-review.md) gave iPhone a conditional
9 pending a first-choice capture. That check passed without changing app code in
`.private/ios-test-20261026T131110Z-19892.xcresult`. The selected choice remained
visible with no jump control over the card. The
[acceptance note](evidence/design-review/questions-acceptance.md) records this
last check separately from the independent review.

The screen now opens at the question, keeps its first choice visible at normal
text sizes, and provides multiline writing with readable prompts. Failed answers
stay intact for retry. Accepted answers cannot submit twice. Both platforms clear
the old error and announce success. Web error instructions use 14-pixel text.
Native follows the next reply after submission, including a reply taller than
the iPad viewport. The decision count wraps at accessibility text sizes.

Seven annotated before/after comparisons are staged for attachment. The shared
fixtures exercise light, dark, narrow widths, large text, written answers,
failure and retry. Web refreshes its private fixture explicitly after checking
the accepted local state; this does not establish live server event delivery.
Native checks use simulators, with no manual VoiceOver or physical-device run.


## Approvals review history

Approvals passes at 9/10 on web desktop, web phone, iPhone and iPad. The
[web recheck](evidence/design-review/approvals-web-review.md) closes its layout,
opening and confirmation findings. The
[native recheck](evidence/design-review/approvals-native-review.md) closes the
last disabled-label regression and permits the next screen.

Decisions now have their own layout class, readable expiry text, consistent
spacing and 44-point actions. Native actions stack at accessibility text sizes.
Unavailable decisions explain the next step. Failed submissions keep the intended
decision for retry, clear the stale error and prevent duplicate sends. A separate
confirmation stays readable while the server's pending snapshot catches up.
Native primary actions use 5.91:1 label contrast in light mode and 9.32:1 in dark.
Disabled actions retain the system treatment.

The native opening fix measures the card, viewport and content end in one layout
snapshot. It waits until the card reaches the top or the transcript reaches its
end. Captures and frame assertions cover the complete action and unavailable
reason. Questions and find-in-chat regressions passed during this work.
Ten annotated comparisons and the held confirmation captures are staged for the
PR. The web fixture refreshes explicitly after checking the accepted local state;
live server events, the expiry race, physical devices and manual VoiceOver were
not exercised. Later passes retain the Connection spinner, Home empty-state
opacity and status-dock followups listed by the reviewers.

## Failed and interrupted turns review history

[Initial review](evidence/design-review/recovery-review.md) identified a replaced
web live region, weak web action hierarchy and an undersized native accessibility
frame. The status region now retains the title and failure reason through the
working-to-failed transition. Both clients use primary recovery actions, and the
native acknowledgment owns its padding and full 44-point target.

[The scoped recheck](evidence/design-review/recovery-recheck.md) accepted web
desktop/phone and iPhone at 9.2, iPad at 9.1, with no remaining blockers. All 105
focused web tests pass, including an independent rerun on the final source.
Native tests tap padding and trailing whitespace in normal, dark and AX3 layouts.
[Acceptance evidence](evidence/design-review/recovery-acceptance.md) records
captures, source fingerprints and limits. Twelve annotated comparisons are ready
for the final PR. The refused-retry marker was moved off its text after review.

## Assistant creation and settings acceptance

Opus 5.5 High closed this gate in review 23. Web creation and Details score 9.1,
with confirmations at 9.2. iPhone scores 9.2 in each area. iPad creation and Details
score 9.1, with confirmations at 9.0. All blockers are closed. The final scope
fixes stale load errors after Retry and gives the recovery action solid readable
colors on both native surfaces.

The [acceptance note](evidence/design-review/settings-acceptance.md) records the
45 web tests, production build, focused native receipts, composite evidence,
32 annotated comparisons and limits. Native enlarged text is AX3, not AX5.
The final [independent review](evidence/design-review/settings-final-review.md)
recomputed the source and measured both Retry labels at 5.91:1.


## Avatar editor acceptance

Avatar passes Opus 5.5 High at 9.0 on web desktop, web phone, iPhone and iPad.
The [web review](evidence/design-review/avatar-web-review.md) and
[native recheck](evidence/design-review/avatar-native-review.md) close all blockers.
The [acceptance note](evidence/design-review/avatar-acceptance.md) records the
76 focused web tests, production build, native receipts and source fingerprints.

A compact preview stays visible while appearance controls scroll. Save remains
the primary action. Portrait upload and generation have separate groups, with
readable progress, recovery and unavailable explanations. Web keyboard navigation
keeps the focused choice and dialog header visible. Native controls respect busy
and load-error states, with visibly disabled preview menus. The wizard retains
its full preview, and the existing artwork, characters and palette are preserved.

The accepted after evidence contains 24 web screenshots and 19 per native device.
All native image hashes and capture windows were verified. Twenty-six annotated
comparisons are staged for the final PR. Enlarged native text uses AX3. The iPad
focused capture shows a software keyboard; the iPhone one does not. Native upload
uses a DEBUG-only file-selection hook followed by the real multipart function.
All portrait images are synthetic fixtures, with no live provider-quality claim.

## Memory acceptance

Memory passes Opus 5.5 High at 9.0 on web, iPhone and iPad. The
[web review](evidence/design-review/memory-web-review.md) accepts all six layouts.
The [native recheck](evidence/design-review/memory-native-review.md) closes the
Add styling and Forget confirmation blockers, and the
[final iPad check](evidence/design-review/memory-native-final-review.md) accepts
the remaining reload sequence. No blocker remains in this screen.

Shared profile ownership, document labels and readable captions establish scope.
Saved notices follow actual writes. Conflict drafts stay readable; failed reloads
retain edits and successful retries restore saved entries. Close, tab changes and
reload protect drafts. Native confirmation quotes the exact entry and offers
Keep before deletion. Web long fields grow within the viewport and explain their
scrolling. Counts account for Unicode scalars and known saved overhead while
Hermes remains authoritative.

The [acceptance note](evidence/design-review/memory-acceptance.md) records the
75 focused web tests, typecheck, production build, passing native segments,
87 accepted after images and 13 annotated comparisons. Earlier native image
reuse was independently checked against reconstructed source states. Failed and
interrupted attempts stay excluded. Native enlarged text is AX3; physical
devices, VoiceOver output and the Copy menu remain unverified.

The [shared settings navigation recheck](evidence/design-review/memory-settings-navigation-review.md)
retains the earlier Details, Avatar, Models, Tools and Skills scores after fresh
200% captures. The five target images match their previously accepted pixels.
