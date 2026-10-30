# Full app design review

This pass covers the web client at desktop and phone widths and the native iOS
client. Nicolas requested a separate Claude Opus 5.5 review at High effort for
each screen. Review each screen as a whole, with one score and annotated issues.
Allow at most three review rounds. If it remains below 9/10 after round three,
record the remaining issues in the PR and continue. Scores are reviewer judgments,
not objective measurements of design quality.

Twenty-three of 25 grouped screen areas have passed. Ship these changes in a draft PR and add
subsequent screens in separate commits. Reuse screenshots where the product UI
has not changed. Capture-script changes do not invalidate screenshots or reviews.
Capture web at desktop and phone widths, and native on one iPhone plus iPad only
where its layout differs. Run native work through `~/.agents/tools/mac-heavy-lock.sh`
with simulator boot and shutdown inside the locked command. Keep one Playwright
browser open at a time and close it after capture.

The previous cross-thread coordination and capture-proof workflow is retired.
Capture tools need ordinary debugging and checks, not independent design reviews.

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
| Work frame and standing goal | 21 web and 20 native before frames per device verified | Complete | Web, iPhone and iPad 9 |
| Work task board and actions | 67 shared before frames; 19 web, 23 iPhone and 23 iPad after frames | Complete | Web refusal 9.5; remaining web states, iPhone and iPad 9 |
| Work task editors | Shared before baseline; 16 web, 13 iPhone and 9 iPad after frames reviewed | Complete | Every frame 9 |
| Work event triggers | Web, iPhone and iPad comparisons available | Complete | Whole-screen rounds: 7.6, 9.1. Six native large-text frames remain accepted |
| Learning | Desktop/phone web and current iPhone views captured | Complete | Whole-screen rounds: 7.0, 8.5, 9.0 |
| Routines and results | Desktop/phone web and current iPhone views captured | Complete | Whole-screen rounds: 7.2, 8.6, 9.1 |
| Logins and secure requests | Desktop/phone web and current iPhone logins captured | Complete | Combined whole-area rounds: 7.8, 8.8, 9.1 |
| Search, saved items and automations | Desktop/phone web and current iPhone captures | Complete | Whole-area rounds: 8.2, 8.8, 9.0; final CSS and Back-state fixes applied directly |
| Group chats and threads | Desktop/phone web and iPhone conversation captured | Complete | Whole-area rounds: 7.0, 8.6, 9.0; final scroll follow-ups applied directly |
| Settings, following and home sections | Desktop/phone web and current iPhone front captured | Complete | Whole-area rounds: 8.0, 8.5, 9.0 |
| Integrations | Desktop/phone web and current iPhone captured | Complete | Combined whole-area rounds: 7.8, 8.8, 9.1 |
| Computer and terminal | Desktop/phone web and current iPhone viewer captured | Complete | Whole-area rounds: 7.6, 8.6, 9.0 |
| Hermes updates and recovery | Pending | Pending | Pending |
| Sign-in and connection recovery | Pending | Pending | Pending |
| Command palette and keyboard help | Desktop/phone web captured | Complete | Included in Settings final whole-area score: 9.0 |
| Attachments, upload failures and large paste | Pending | Pending | Pending |
| Find in conversation | Desktop/phone web captured and exercised | Complete | Included in Settings final whole-area score: 9.0 |
| Voice recording and playback | Pending | Pending | Pending |
| Status dock, connection notices and app updates | Pending | Pending | Pending |
| Toasts, undo and stop confirmation | Pending | Pending | Pending |
| Notification setup and settings | Pending | Pending | Pending |
| Apple device connections | Pending | Pending | Pending |
| Offline library | Pending | Pending | Pending |
| iOS quick switcher | Source reviewed; gestures not captured | Complete in Settings scope | Settings whole-area score 9.0; native interaction remains unverified |
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

## Work frame and standing-goal acceptance

Work's frame and standing goal pass Opus 5.5 High at 9 on web, iPhone and iPad.
The [web review](evidence/design-review/work-web-review.md),
[iPhone review](evidence/design-review/work-phone-review.md) and
[iPad review](evidence/design-review/work-ipad-review.md) close every blocker.
Task boards, task editors, event triggers and Learning remain separate pending gates.

The goal has one primary action, grouped status and turn counts, persistent
resume receipts and review controls beside the action they permit. Native Replace
and Clear use readable confirmation sheets with explicit Keep actions. Three
presenter cycles on each native device verify Cancel, draft retention, replacement,
and keeping or clearing a goal after a fresh read.

The [evidence record](evidence/design-review/work-acceptance.json) binds the
26 focused web tests, typecheck, production build, isolated native runs and
source proofs. It records 61 before frames, 74 after frames and 19 annotated
comparisons. The after total includes two unscored Learning smoke frames.
Failed and interrupted attempts are excluded; unchanged image reuse was reviewed.
Native before images follow the essential presenter repair and precede visual
changes. Enlarged text uses AX3 on native and a 200% root font on web. Physical
devices, VoiceOver output, hardware keyboards, iOS 17, AX4/AX5 and compact iPad
widths remain unverified.

## Work task board and actions acceptance

The task board and actions pass Opus 5.5 High on all four layouts. The web
refusal result scores 9.5; the remaining 18 web states and all 23 frame records
on each native device score 9.0. Review 92 closes the gate and allows the
separate task create and edit pass.

Tasks now have readable status groups, one copy of their metadata, conditional
move forms, dependency status labels and a visible start-note disclosure.
Refusals stay beside the action that produced them and leave goal controls
usable after a successful refresh. Keyboard focus moves to the visible result.
Running tasks show a read-only explanation.

The [closing evidence record](evidence/design-review/work-task-acceptance.json)
binds 65 after frames, 14 annotated comparisons, the source reuse proofs and
reviews 82 through 92. The shared before baseline contains 67 images, including
the separate editor states. The 31 focused web UI tests, 25 adapter tests and
35 native functional tests passed. Unaffected results were reused after the
later screenshot-framing changes. The web test result is retained in the
orchestration transcript rather than a standalone log.

The iPhone matrix contains 6 R3, 2 R5, 13 R4 and 2 R6 records. Its top and
dependencies frames show the same content apart from the backdrop, so 23
records do not represent 23 different layouts. The iPad matrix contains
2 R3, 6 R4, 14 R5 and 1 R6 record. The final supplement shows the start-note
label, prompt and footer inside the sheet. Retired and failed images are
excluded from both matrices.

Native enlarged text is AX3. Web enlarged text is a 200% root font, not browser
zoom. Production Hermes transition rules, physical devices, VoiceOver, hardware
keyboards, iOS 17, AX5 and compact iPad windows remain unverified. The trigger
contrast follow-up belongs to its upcoming pass. This acceptance covers W2a
only; task editors and the rest of the app remain pending.

## Work task-editor acceptance

Task creation and editing pass Opus 5.5 High at 9 on web, iPhone and iPad.
The reviewer scored all 38 actual after frames individually, with no averaging
or projection. Six annotated comparisons use the pinned shared before baseline.
The [closing evidence record](evidence/design-review/work-task-editor-acceptance.json)
contains the image hashes, source bindings, validation receipts and review links.

Forms now keep visible field labels, mark optional inputs and explain the blocked
state of a newly created task. Web dependency rows align their checkboxes and show
status. Editing disables inputs during a save and keeps refusals with the task.
After a lost create response, Refresh reviews the existing request. A likely title
match locks the draft and offers Close, without sending another create. The copy
does not claim that a title match proves the server saved this request.

Validation includes 41 focused web tests, typecheck, production build and the
16-frame browser tour. The original 38 native functional checks passed, and the
two affected task UI tests passed again after adding the keyboard control.
Their original source bindings are retained. Five phone tours and five iPad tours
passed with zero skips. The final test-helper change checks the position reached
by the last permitted drag; it adds no gesture or relaxed visibility rule.

The iPhone keyboard control measured 44 by 44 points and passed light and dark
contrast checks. The iPad extra frame shows its keyboard accessory and Hide
button, but no on-screen key grid. That layout remains a whole-app follow-up.
The toolbar's unlocated frame-dimension runtime warning has no observed visual
effect and is also retained for that pass.

These are synthetic fixtures and simulator images. Enlarged native text is AX3;
web 200% uses root-font scaling. Physical devices, VoiceOver, hardware keyboards,
AX5, iOS 17 and compact iPad widths remain unverified. Work event triggers are next.

## Work event triggers

The finished product changes improve signing-secret readability and copying,
place results beside the affected trigger, explain routine availability, label
editors and handle an uncertain create without resending it. The native routine
menu wraps its selected name at large text sizes.

Six native large-text frames remain accepted at 9/10, three each on iPhone and
iPad. Reviews 173 and 178 accepted the create top, create bottom and revealed
secret frames. Review 174 also accepted three hidden-secret supplements. The
later tour-script repair does not change that product UI or its acceptance.
The web after views were reviewed at 9/10 in review 151.

The phone create hint middle and footer tail, the iPad create-form tail,
VoiceOver and clipboard behavior still need coverage. These limits do not erase
accepted screenshots or prevent work on other screens. Normal-size native
captures and the remaining whole-screen review continue under the bounded loop.

[Whole-screen round 1](evidence/design-review/event-triggers-screen-review.md)
scored 7.6. The follow-up explains why Edit is locked while creating another
trigger, groups the web metadata more tightly and strengthens the secret heading.
Native secret rows now have visible labels, and closing the create sheet scrolls
the new secret panel to the top. The native app compiles. Targeted native capture
is blocked by the host CoreSimulator update, so round 2 waits for those pixels.

## Remaining review areas

Group the remaining screen details above into ten working areas: event triggers;
Learning and routines; secure requests and integrations; search and conversation
tools; group conversations; app settings and navigation; computer and terminal;
connection and update recovery; notifications and Apple devices; and empty states,
offline content, share extensions and widgets. Use one whole-screen score per
review, with at most three rounds for each screen within those areas.

## Learning

[Round 1](evidence/design-review/learning-screen-review.md) scored 7.0. The
follow-up keeps the policy checkbox with its label, confirms before turning off
required approval, adds readable diff colors and a collapse control, and reduces
section spacing. Pending changes show a count and labeled source. The API does
not provide the affected skill name, so the client does not invent one. Native
Learning adds a short introduction and uses the shared muted text color.

The desktop and phone browser check exercised cancelling the policy confirmation,
confirming the change, restoring required approval and opening a diff. Targeted
tests cover confirmation, re-enabling approval, collapse and fresh revision loads.
The native app compiles. Round 2 used the changed web views and kept the native
visual limit explicit. Direct captures of the compiled Debug app now run on the
installed simulator without XCTest, so the current iPhone view is available for
round 3, including its introduction, pending count and labeled source.

[Learning round 2](evidence/design-review/learning-screen-round2.md) scored 8.5
and confirmed the six original web findings fixed. The final refinement clears
old success feedback before reading a change, names policy and review results
specifically, fills complete diff lines with their change color, and stacks only
this policy dialog's buttons. Native pending rows and review headers now label
the source consistently. Round 3 is the final review for this screen. Any issues
remaining below 9 will be recorded in the PR before moving on.

The current native Learning capture shows a populated pending row and installed
skill. The introduction sits in the first section header. Learning, Routines,
Connections and Logins were captured in one locked iPhone batch, with shutdown
before the command returned. This removes the visual-capture blocker; XCTest's
platform update is still separate from these direct app captures.

[Learning round 3](evidence/design-review/learning-screen-round3.md) passed at
9.0, closing the screen after its third and final round. Two small polish notes
were applied directly: the terminal newline no longer creates a blank diff row,
and the native policy explanation is a section footer. These do not start a
fourth review round. Native review-sheet interaction, clipboard and VoiceOver
remain outside the screenshot coverage. Routines is next.


## Routines and results

[Round 1](evidence/design-review/routines-screen-review.md) scored 7.2.
The next revision labels schedule and status, groups trial and inspection actions
apart from routine management, and names the trial warning explicitly. Recipes
have their own heading and focus the populated editor. Namespaced React keys fix
the duplicate schedule preview when switching between an edit and a recipe.
Results now name the routine, put the run selector before Refresh, and separate
Save output from the saved content. Native recipe descriptions use the shared
muted color and the trial explanation follows Try once.

The agent exercised Edit, recipe selection and focus, schedule previews, and
opening saved results at desktop and phone widths using synthetic data. A fresh
iPhone capture covers the routine list, labels, recipe and trial explanation.
Native editor and result interactions, VoiceOver, large text and live execution
are outside these captures.


[Round 2](evidence/design-review/routines-screen-round2.md) scored 8.6.
The final revision fixes the instruction font cascade, makes the preview footnote
muted, distinguishes Paused with a badge on both clients, restores focus to
the edited card on Cancel and Save, and uses one results-button size. The trial
explanation changes when Check run status replaces Try once. The schedule input
now uses monospace. Preview fixtures use UTC so the examples do not suggest a
seasonal schedule change.

The agent checked the instruction size in Chromium, canceled an edit and checked
focus, and paused and resumed the synthetic routine at both widths. Fresh native
captures show the paused-state badge. Pending-run help and saved-edit focus have
focused behavioral coverage; no live routine execution is claimed.


[Round 3](evidence/design-review/routines-screen-round3.md) passed Routines
and results at 9.1. The two small follow-ups were applied directly: native routine
instructions use body text, and Retry has its own explanation that resending may
run the routine. Recipient checkbox spacing remains a minor polish item in
[issue 206](https://github.com/NicL9923/agent-interface/issues/206). Focus restoration
currently relies on retaining the cards during reload; preserve that behavior if
the loading presentation changes. Native editor/results interaction, VoiceOver,
dark mode, large text and live routine execution remain outside the captures.


## Secure requests, logins and integrations

[Round 1](evidence/design-review/security-integrations-screen-review.md) scored
this area 7.8. The follow-up gives vault unlock its own full-width form and one
primary submit, labels source checkboxes by service, and separates item titles,
website addresses and vault-source tags. Add login focuses its first field, and
inline removal/disconnect confirmations focus the safe choice. Cancel returns to
the trigger; after successful removal, focus moves to a surviving control.

Both clients recommend checking configured or unavailable connections and
reconnecting expired or permission-limited ones. Connection card text is larger.
Expired uses one status name, with warning color on native. New sign-in flows name
the service, align their cancel control and offer a copy-code button with explicit
success or failure feedback.

The agent used desktop and phone Chromium to open and cancel add/unlock forms,
check focus recovery, open and cancel both confirmations, inspect recommended
connection actions and open the synthetic GitHub sign-in flow. A new compiled
iPhone screenshot shows the native action emphasis and Expired tint. Existing
secure-request and native Logins captures remain valid. Clipboard success/failure
has a focused mock test; actual clipboard access, real provider sign-in, native
forms/dialogs, VoiceOver, dark mode and large text were not exercised.


[Round 2](evidence/design-review/security-integrations-screen-round2.md) scored
8.8. The final revision puts the recommended connection action first on both
clients, uses amber for recoverable web connection states, and matches account
identifiers at 14px below the entry title. Source tags stay in a wrapping heading
row. Inline confirmations have a light background, and action rows have less
trailing space.

Reload logins now stays in the top toolbar. An uncertain write focuses it and
brings the error into view. A successful unlock focuses that source's Lock
control; locking returns focus to Unlock. Focused tests cover those paths and
recommended-action reading order. The agent also exercised an injected unlock
failure and a successful unlock/lock cycle against the synthetic preview at both
web widths. No real vault or provider was contacted. A fresh iPhone capture
confirms the native action order. Clipboard and the previously unobserved native
forms, VoiceOver, dark mode and large text remain outside runtime coverage.


[Round 3](evidence/design-review/security-integrations-screen-round3.md) passed
the combined area at 9.1. The contrast miss was fixed directly after the final
review. Amber chips use a darker adaptive mix, and gray chips use the existing
metadata ink. Browser measurements of the inspected chips are at least 4.8:1 in
light mode and 6.05:1 in dark mode. This is a chip contrast check, not a full dark
mode review.

The final polish also gives desktop cards a 20rem minimum column when space
allows, uses one recommendation calculation per card, increases the source toggle
label to 14px and folds duplicate CSS overrides into the original rules. New
web captures show the wider desktop cards. The existing native capture remains
valid. Real clipboard, provider sign-in, native forms/dialogs, VoiceOver, full
dark mode and large text remain outside the observed coverage. Search, Saved
items and Automations are next.


## Search, Saved items and Automations

Baseline captures cover Search results, read-only conversation history, Saved
items and Automations at desktop and phone web widths. The agent opened a search
result, saved the conversation pointer, reopened it from Saved items, and paused
then resumed the synthetic routine. Native captures render each discovery tab
from the compiled Debug app. A fixture-only startup shortcut opens the requested
tab without XCTest navigation; it is excluded from Release behavior.

These are synthetic search/history/schedule/usage examples. Native interaction,
real search providers, scheduling, notifications, VoiceOver, dark mode and large
text have not been exercised for this area.

Round 1 scored 8.2/10. The fixes add conversation and speaker context, a pinned
Back to results control, in-place Saved feedback, reply labels and saved dates,
and destination labels on search hits. Known routine statuses now use plain
words, paused routines explain their state, and the Automations tab announces
usage. Desktop usage is a compact table. Native Remove is a quiet destructive
action. Bookmark removal also clears the local saved state so the reply can be
saved again.

The agent exercised both web widths, saved replies and conversations, reopened
saved pointers, checked Back preserved the query, and paused then resumed the
fixture routine. Current iPhone captures include Search, Saved items,
Automations and read-only history. Focused checks cover stale pagination after
Back, save dedupe and removal, destination labels, sender names, exact message
pointers, and unknown or partial usage costs. Native compiled, but its added
unit cases were not executed because this host has an Xcode/CoreSimulator
version mismatch. The direct simulator capture path works.

Round 2 scored 8.8/10. The final pass covers the scrollport padding above the
pinned history heading, keeps save and paging errors in that heading, and
turns the first reply line into a clean saved title. Both clients retain
identifier underscores, remove markdown markers and shorten at a word boundary.
The subtitle names automations again. Native Save reply uses a neutral tone;
web timestamps stay together and the last result has its own line. Leaving
history clears Saving so a return trip cannot leave a stuck label.

The agent triggered a failed save in both web widths, confirmed its error stayed
visible, then retried and saved successfully. All 28 focused checks cover these
changes and the prior discovery behavior. New web and native captures are ready
for the third and final whole-area review. Native unit execution, live providers,
VoiceOver, dark mode and large text remain unverified.

The third and final review passed at 9.0/10. It confirmed the visible history
errors, clean title formatting, pinned top edge and neutral native Save controls.
Two small follow-ups were applied directly: remove the negative header margin
that clipped the tab strip or save notice before scrolling, and clear native
history errors and notices on Back. The agent checked the header at scroll zero
with a save notice and again at the end of history at both web widths. No fourth
review is planned. Group conversations are next.


## Group conversations

Round 1 captures cover the conversation, mention suggestions, a thread reply and
new-group form at desktop and phone web widths, plus an iPhone conversation.
The agent selected a mention with Enter without sending, switched between a
thread reply and a new topic, selected two assistants in the create form,
cancelled while preserving the conversation draft, and sent one synthetic group
message. The confirmed send cleared its draft and appeared in the transcript.
The native capture renders the compiled app with a fixture-only startup shortcut.

The examples use in-memory household data. Creating a real room, uncertain-send
recovery, approvals, Stop, native interaction, VoiceOver, dark mode and large
text were not exercised for this round. The first whole-area review is pending.

Round 1 scored 7.0/10. The follow-up names the selected message in the thread
banner, highlights it and labels related replies. The UI uses the first loaded
message as thread context; it does not invent a backend parent-message ID.
Assistant avatars and larger speaker names distinguish participants, and the
signed-in person's messages say You. Selecting Reply focuses the composer.
Native members are a section header, and a short composer placeholder leaves
the mention hint readable below it. Approval cards name the requesting assistant.
The create form shows a selection count and explains the six-assistant limit.

The agent repeated the web mention, thread, create/cancel and send interactions,
checked the six-assistant limit, and captured a named pending approval at both
widths. Focused tests cover the exact selected thread ID, composer focus, draft
preservation, request identifiers on Deny and the selection limit. Existing
uncertain-write, room-revocation, stream and background-poll checks still pass.
Both clients compile. Native interaction and unit execution, real coordinator
behavior, VoiceOver, dark mode and large text remain unverified. Round 2 is pending.

Round 2 scored 8.6/10. The final pass scrolls a confirmed send above the sticky
composer using its measured height and the scrollport padding. Incoming replies
follow only while the reader is at the bottom. Native uses the List's reserved
composer inset and a matching scroll request after confirmation. A stronger
accent bar marks the reply selection. The desktop mention popup now covers the
underlying link cleanly, disabled create rows dim together, and approval padding
is balanced. The mention hint stays steady while typing.

All 42 focused checks pass, including staying put while reading older replies,
following at the bottom, revealing a confirmed send and preserving an uncertain
send. The agent repeated the web interactions and checked that the sent message
and its Reply control fit above the composer. Current desktop, phone and iPhone
renders are captured. Native scroll behavior is source-only; the capture does
not claim native interaction. The third and final review is pending.

The third and final Group conversations review passed at 9.0/10. It confirmed
that sent cards clear the composer, the mention popup leaves no glyph fragment,
and selected replies have an accent bar. Two source follow-ups were applied
directly: follow the conversation end, including decisions after the messages,
and suppress following while loading the next oldest history page. All 43
focused checks pass. The agent confirmed trailing approvals stay visible after
Send at both web widths and Load more retains the reading position. Native
compiled; its scroll behavior remains source-only. Repeated quotes in long
single-thread runs and initial-position consistency remain optional polish.
App settings and navigation are next. No fourth group review is planned.


## Settings and navigation, round 1

Nineteen of 25 grouped areas have passed. Learning and Routines are counted
separately, correcting the earlier total of 24. Groups completed its third round
at 9.0. Six areas remain, including event triggers.

Settings now has desktop and phone web captures of its main page, Following,
section membership, section ordering, keyboard help, the command palette and
Find in chat. The agent toggled and restored Advanced details, followed and
unfollowed an assistant, created and renamed a section, moved an assistant into
it, reordered it, then deleted it. These operations used the loopback fixture.
The agent also opened Settings through the filtered palette and moved between
Find matches before closing Find with Escape.

Using the Mac shortcuts exposed a platform-detection bug: Chromium reports
`macOS`, which did not match the case-sensitive `Mac` check. Detection is now
case-insensitive. The 26 shell-logic checks cover modern and fallback Apple
platform strings, Windows and Linux, displayed shortcut hints and the actual
modifier matching. The web build completed. All 16 capture interactions
completed, and the agent inspected representative main-page and palette images.

The iPhone capture shows the actual compiled Settings front through a Debug-only
fixture route. The native build and the capture ran under the machine-wide lock;
the simulator was shut down afterward. Following and section editing on native,
Quick Switcher interaction, notification delivery, live account changes,
VoiceOver, dark mode and large text remain unverified. Native and web fixture
account names, update dates and start-page values differ by fixture setup.
No product parity claim comes from those values. Both browser and preview
server were closed after capture. The first whole-area review is pending.


Settings round 1 scored 8.0. Find now shares its text-range lookup with the
highlight renderer and reveals the actual match inside a long message. It uses
the shared platform matcher, so Control+F remains a text-editing key on Mac.
Web section deletion asks first with Keep section focused. A valid rename saves
on Back or Escape; an invalid name keeps the page open with its error. Section
summaries distinguish assistants in the section from pinned members. The web
add row stops at 30 sections, touch reorder buttons are 44px, and the rename
card is rounded. Find has one explicit close button, and Appearance and Following
wording now agree with native.

Native section summaries also explain pinned members, invalid rename text stays
local with an inline error, and the Quick Switcher includes Settings. That
action waits for the switcher sheet to dismiss before opening Settings. These
subpage changes are source-only so far. The current iPhone front capture remains
valid because its visible layout is unchanged. Native compilation and a refreshed
iPhone front capture completed under the machine-wide lock. The simulator
was shut down by the capture command. Native unit execution and subpage
interaction remain unverified.

All 104 focused checks pass, including rename leave paths, cancellation and
confirmation, pinned summaries, the section limit, platform-specific Find and
text-range scrolling. The web build completed. The agent repeated the web
interactions at both widths, canceled a deletion, tried a duplicate rename,
returned with a valid unsent rename, then deleted the temporary section. Both
initial and Older-match captures show selected text; the capture also checks
its range lies within the transcript viewport. Browser and preview server are
closed. The second review is pending. Palette links to deeper Settings pages
remain optional navigation work; live saves, native subpage gestures, quiet-hour
menus, Sign out, VoiceOver, dark mode and larger text are not newly verified.


## Computer and terminal, round 1

The agent captured the shared desktop and system terminal at both web widths.
It took control and handed it back, opened the phone text-entry form, pasted
fixture text into the terminal, sent Control+C, canceled End shell, then confirmed
End shell. These use the preview's simulated RFB and WebSocket streams. No real
shell command ran and no real remote desktop was contacted. The canvas contains
explicit fixture graphics, not a live application.

The actual compiled iPhone viewer is also captured using its existing Debug
desktop transport. A small Debug-only navigation entry opens it directly from
Settings for capture. The native build and capture completed under the machine
lock, and the simulator shut down afterward. This frame shows Watching with
Take over and the Safari and Terminal links. Native takeover and Safari gestures,
identity confirmation, unavailable and reconnecting states, provider access,
VoiceOver, dark mode and large text remain unverified. The browser and preview
server are closed. This is a baseline for the first whole-area review.


Settings round 2 scored 8.5. The final pass always finishes a native dialog close
so the app can reopen Settings, even when a local name is invalid. Keep original
name restores the saved text without sending an edit. Find pins its selected
message for the query, so a newly arriving matching reply does not replace it.
Section rows show total membership with an unbroken pinned summary; the section
page labels pinned members. More assistants and Following wording now agree
across clients, and the palette uses keyboard and sun icons for those actions.

Native Add refuses a duplicate section name with inline feedback. The first
rename error is announced through the accessibility announcement API. Settings
also has a Command-comma action, and the quick-switch sheet handoff waits for
dismissal. These native interactions remain source-only. The app compiled, the
Settings front was captured, and the final incremental build completed under
the machine lock after a small empty-note rendering correction.

All 108 focused checks pass. New regressions cover forced native close with
valid and invalid drafts, restoring the original name and keeping Find's
selection when a matching reply arrives. The agent repeated the web flows at
both widths and reopened Settings after explicitly calling native dialog close.
This Chromium allowed both Escape cancellations, so the agent does not claim
Escape forced that close. The noncancelable close is also covered by the focused
UI test. A first capture stopped on that browser difference; a second stopped
on a temporary section left by the first. The fixture was reset, and the tool
now restores its initial preferences even after failure. The completed capture
contains both widths; the error frames were refreshed after their final CSS
polish. Browser and preview server are closed. The third review is final; any
remaining issues will be recorded in the PR and the review will move on.


Settings finished its third and final round at 9.0/10, so 20 of 25 grouped areas
have passed. The review confirmed all seven round-2 findings were addressed,
with native interactions and incoming-Find behavior explicitly labeled as
source or test evidence. Four small follow-ups were applied directly: align the
rename help with its field, clear the native Add error as the name changes, use
the same Following explanation, and pin a replacement Find result if its
previous message stops matching. A regression edits the selected message then
adds a new matching reply, checking that the replacement remains selected.
All 109 focused checks and the web and native builds pass. Native gestures,
VoiceOver, live saves, dark mode and large text remain unverified. No fourth
Settings review is planned. Computer and terminal's first review is underway.


Computer round 1 scored 7.6. The phone desktop stage now follows the remote
canvas dimensions, including resolution changes. An accent border and badge
show confirmed local control. Another member's lease has a matching disabled
Take over explanation on both clients. A signed-in member's lease alone is not
proof that it belongs to another window, so the watch-mode copy says Watching
your desktop session instead. Reconnect still disables input until another
explicit takeover.

The terminal viewport matches its canvas background, secondary text is larger,
and the persistent-shell warning sits next to the terminal status. The end
confirmation keeps both choices on one row on phone. Expanded text tools show
their state, and their submit buttons align consistently. Initial focus goes to
the selected tab rather than Close. The native Terminal link now names Terminal
in the app URL; opening it attaches only the terminal until Desktop is visited.

All 40 focused computer, API, chunk-failure and native-viewer checks pass. They
include direct terminal routing, lazy desktop attachment, framebuffer geometry
and resolution changes, lease fencing and reconnect behavior. Web and native
builds completed under the applicable lock. The agent repeated the web flows,
captured another member in control and Shell ended, and verified the terminal
link opens the selected Terminal tab. These remain simulated streams; no real
computer or shell was used. The compiled iPhone viewer was captured again.
Native gestures, Safari interaction, VoiceOver, dark mode, large text, live
hosts, identity confirmation and reconnecting-state pixels remain unverified.
The browser, server and simulator are closed. Round 2 is pending.


Computer round 2 scored 8.6. The final pass hides the persistent-shell warning
when the shell has ended, with an assertion in the existing ended-shell test.
The control badge no longer covers remote controls. The toolbar label and
canvas outline show control on web and native, without adding a timer or motion.
The hint says Take over to use it here, and the native link explicitly says
Terminal in Safari. Two unused terminal-tool span rules were removed.

All 40 focused checks and both builds pass. The agent repeated the web flows
and inspected fresh control and Shell ended frames at both widths. The native
Watching view was captured again; native after-takeover remains source-only.
The browser, preview server and simulator are closed. The third review is final;
remaining issues will go into the PR without a fourth review.


Computer finished at 9.0 in its third and final round, bringing progress to
21 of 25 grouped areas. The review confirmed the ended-shell warning is gone
and no label obscures remote controls. Small follow-ups move the web outline
outside the stage, test its connection to confirmed control and lost ownership,
and let native browser links stack when their row cannot fit. Swift overlay
cleanup is included. The watch-mode headline deliberately emphasizes local
Watching, rather than account ownership; Take over to use it here explains the
next action. All 40 focused checks and both builds pass. Native large-text
rendering and gestures remain unverified. No fourth review is planned.


## Event triggers, round 2

The earlier web fixes and eight desktop/phone captures remain valid because
their product UI has not changed. They explain why Edit is locked during a new
trigger, tighten metadata and strengthen the secret heading. The compiled
iPhone and iPad now also show the secret panel after the normal create-control
and editor-dismissal paths, driven by a Debug-only synthetic transport. No
XCTest navigation or real trigger was used.

The targeted capture exposed that scrolling a Form section can hide its header.
The safety heading is now part of the first row and the scroll target, so it
stays visible. The acknowledgement and its disabled explanation share one row,
which keeps the explanation inside the iPad sheet. Both field labels, the
heading and actions are visible on both devices. API, lifecycle, reveal/copy
and acknowledgement guards are unchanged. No clipboard or native gesture
claim comes from the capture.

All 64 automation UI checks pass. Native compilation and both captures completed
inside one machine-lock command, with simulators booted and shut down in turn.
The six accepted native large-text frames remain accepted. Their uncovered form
tails, VoiceOver, real clipboard behavior and current large-text layout remain
unverified. The second whole-screen review is pending.


Event triggers passed at 9.1 in round 2, bringing progress to 22 of 25 grouped
areas. The review confirmed all five principal findings were fixed. The web
secret labels were then made small and muted to match the list and native;
only those two web states were recaptured and inspected after the CSS change.
No third review is needed. Native create-field label hierarchy, example-copy
parity and the shared-shell scroll strip remain optional follow-ups in issue
206. Native gestures, revealed-normal state, real clipboard behavior, VoiceOver
and current large-text layout remain unverified. The six accepted native
large-text frames remain accepted. Connection and update recovery are next.


## Connection, sign-in and update recovery, round 1

Baseline web captures cover sign-in, setup guidance, a lost Hermes connection,
a failed update, Restart confirmation and recovery at 1440 and 390 pixels.
The agent cancelled Restart once, then confirmed it against the preview fixture.
No provider sign-in or Hermes installation was invoked. The capture uses a
loopback-only isolated browser context and closes it afterward.

The compiled iPhone Debug app shows the sign-in view with an existing server
and the failed-update page. New fixture entry points are Debug-only. The address
setup form, provider flow, native gestures and actual update recovery remain
unverified. Native compilation and capture ran under the machine-wide lock,
with shutdown in the capture trap. The build still reports the existing
CoreSimulator/Xcode service-version mismatch, so these are direct app captures,
not XCTest navigation or native unit-test coverage.

The agent inspected the saved frames. The browser and preview server are closed.
The first whole-area review is pending. Progress remains 22 of 25 grouped areas.

## Connection and update recovery, round 2

Round 1 scored 7.0. Failed-install recovery now leads with Restart Hermes on
both clients. The disabled check button and its unrelated hint are hidden in
that state. Native recovery precedes the stepper and versions, so all three
actions fit on the first screen. Failed and blocked native icons use red.
Restoring and verification use their own action labels. Check details includes
restart checks without calling them staged-copy tests.

The web confirmation pins the operation shown when it opens. A newer operation
dismisses the old prompt with a notice. Opening focuses the prompt, Not now
returns focus to its trigger, and confirmation focuses the status title. The
choices have distinct styling and stack on phone. The dialog keeps its top
position across state changes. Native uses Not now too. Sign-in recovery links
have 44-point targets, and changing servers always asks before signing out.

Disconnected approvals stay disabled with local guidance. The connection notice
precedes the decision notice, whose Review button becomes secondary. An unclear
approval failure retains the attempted choice in tab-scoped, account-specific
storage across navigation and reloads. Only an explicit resend of that same
choice is allowed. A still-pending read never unlocks the opposite choice.
Definite initial refusals still allow correction. A refused resend keeps the
opposite choice locked. No approval is resent automatically.

All 289 focused web checks pass, including outage, ambiguous decision, remount,
confirmation focus and operation-change cases. Web and native builds completed.
The agent repeated the web flows at both widths and checked focus in Chromium.
Fresh iPhone captures show the recovery actions and sign-in view. The browser,
preview server and simulator are closed. Native gestures, the confirmation sheet,
real providers, actual installations, VoiceOver, dark mode and large text remain
unverified. The existing CoreSimulator/Xcode mismatch still prevents XCTest
coverage. Whole-area round 2 is pending; progress remains 22 of 25.

## Connection and update recovery, round 3

Round 2 scored 8.6. Web recovery confirmation now pins the phase as well as the
operation, and dismisses itself when its action loses permission. Returning to a
failed phase never resurrects the old prompt. The changed-status notice clears
on close or a later phase. Tests cover phase changes, permission loss and notice
lifetime. The agent also exercised the same-operation phase change and return
in Chromium without sending the stale confirmation.

The native dev-account note wraps again. Recovery buttons have equal heights,
the duplicate web divider is gone, the native Restart separator is hidden, and
confirmation padding is balanced. A 409 approval response removes the choices
and explains that the request is no longer available to answer. Both initial and
resend conflicts refresh the conversation, without claiming a decision succeeded.

All 134 affected checks pass, and both builds completed. The other successful
checks from round 2 are reused because their inputs did not change. Fresh web
captures cover both widths, and the compiled iPhone frames show the restored
note and recovery section. The browser, preview server and simulator are closed.
The third review is final. Any remaining issues go into issue 206, with no fourth
round. Native interaction, real sign-in/update operations, VoiceOver, dark mode
and large text remain unverified. Progress stays 22 of 25 until that review.


Connection and update recovery finished at 9.0 in round 3, bringing progress to
23 of 25 grouped areas. The final review confirmed the eight round-2 fixes.
Its maintenance edge case is fixed directly: a definite first-request
hermes_maintenance refusal permits a later decision, while a prior ambiguous
choice remains fenced if its resend meets maintenance. Both cases have tests.
All 48 transcript checks pass and the web build completed. The confirmation
question uses 14px text, and closed cards say Decision status. No fourth review.
Notifications and Apple devices are next, followed by empty/offline states,
share extensions and widgets. Native gestures, real providers, VoiceOver,
dark mode and large-text gaps stay recorded.

## Notifications and Apple devices, round 1

Baseline captures cover the notification invitation, disabled and enabled device
settings, five-minute batching with quiet hours, blocked permission guidance and
the Apple Calendar/Reminders handoff at desktop and phone widths. The agent
clicked Not now, enabled and disabled a fake browser subscription, saved batching
and quiet-hours preferences, then checked the blocked switch. The service worker,
permission and subscription objects are explicit browser fakes; the preview
subscription endpoints are synthetic. No real permission prompt or push delivery
was invoked. Fixture preferences are reset between widths.

The compiled iPhone app shows its actual notification settings with the existing
fake permission system. A Debug-only scroll entry point positions that section.
The real Calendar and Reminders view is shown without requesting access or reading
events. It is opened directly for capture, so the frame does not demonstrate the
normal Integrations back-navigation path. Selection, snapshot preview, adding to
a draft, native permission prompts and delivery remain unverified. The lower
Apple date-window controls are not visible in the captured frame.

Native compilation and both captures ran in one machine-lock command and shut
the simulator down. Browser captures completed and the browser and preview server
are closed. Only capture entry points changed; notification and Apple product
behavior is unchanged. The first whole-area review is pending. Progress stays
23 of 25 grouped areas. The final Connection prompt wording was also recaptured
at both widths after its small text-size adjustment.

## Notifications and Apple devices, round 2

Round 1 scored 7.5. Device status now says On, Off or Blocked. Blocked guidance
uses an attention color and icon. Device-only controls and account preferences
have separate groups, with one device-status message. Batching always explains
that decisions and failures skip it. Quiet-hours copy names the timezone in a
sentence. Native orders Following before Quiet hours, matching web. The desktop
install hint is gone; platform-specific guidance stays beside the device switch.

The browser invitation is account-scoped and remembered only after Enable or
Not now. It survives a reload before an answer. Another account can receive its
own invitation even if browser permission was granted earlier. Neither account
change nor invitation display requests permission or registers push by itself.
Equal quiet-hour times are rejected locally with an inline explanation on both
clients, preserving the last valid preferences instead of making a refused save.

The native Apple catalog row is a link to the local selection screen. Web calls
it On iPhone and omits a permanent unchecked status and empty action row. Server
and fixture copy use Calendar & Reminders, Your iPhone and assistant/draft wording.
The Apple form uses the household background and hides the undated-reminder
option until access is allowed. The Add to draft button describes its action;
small previews expand initially, show event ranges and reminder due dates, and
the confirmation repeats counts and the selected dates. The footer includes
calendar names among the shared fields.

All 67 focused web checks and 11 Python checks pass. Both builds completed.
The agent repeated simulated push enable/disable, Following and quiet-hours
editing, including the equal-time error, at both widths. Native captures show
ready and denied permission fixtures plus the Apple form and its date window.
The agent caught and corrected a native footer layout that hid its timezone
sentence, then recaptured both settings states. The browser, preview server and
simulator are closed.

Snapshot preview, its confirmation, real EventKit permissions/data and actual
push delivery remain unverified in the app. The new snapshot UI is reviewed as
source only. Apple's [due-date contract](https://developer.apple.com/documentation/eventkit/ekreminder/duedatecomponents)
requires Gregorian components; its [date conversion](https://developer.apple.com/documentation/foundation/nsdatecomponents/date)
needs a calendar. No data-filter change was made without a real-device finding.
Dated-reminder inclusion remains a device coverage question. Native XCTest,
VoiceOver, dark mode and large text are still unverified. Round 2 is pending;
progress remains 23 of 25 grouped areas.


## Notifications and Apple devices, round 3 preparation

Round 2 scored 8.7. Quiet-hours errors now have their own spacing and explain
that start and end times cannot match. Both notification groups name their scope.
On, Off and invitation text describe the same alerts. Native blocked guidance
aligns with its icon, batching help stays with its picker, and the Apple form
explains why preview is disabled. The agent deliberately kept iPhone Safari's
Add to Home Screen guidance in Settings instead of showing an invitation whose
Enable action cannot work there.

The Apple snapshot model now preserves date-only reminders as a YYYY-MM-DD
`dueDate`, with no fabricated time. Timed reminders resolve floating components
in the capture timezone. The snapshot records that timezone and encodes instants
with its UTC offset. Preview and confirmation use the same zone. Event ranges
collapse repeated dates, all-day ranges respect the exclusive end even across
DST, and counts use singular or plural wording. Filtering uses the same converted
date key as the payload, keeps the selected half-open window, and leaves undated
inclusion under the existing toggle. Overdue reminders outside that window are
not silently added.

The production Foundation model passes standalone Swift 6 strict-concurrency
checks for conversion, window boundaries, sorting, JSON and presentation,
including Sydney offsets and the 25-hour fall-back day. All 32 affected web tests
pass. Web and native builds completed, and the agent repeated the simulated
notification interactions at both widths. Fresh captures show all eight web
states per width and four compiled iPhone settings/Apple states. Native work ran
under the machine lock. The browser, preview server and simulator are closed.

The preview and sharing confirmation remain source-only observations. Real
EventKit permissions/data, push delivery, native gestures, XCTest, VoiceOver,
dark mode and large text remain unverified. Round 3 is the final review round;
progress remains 23 of 25 grouped areas until its result.


## Notifications and Apple devices complete

Round 3 scored 9.1 with no blockers. Progress is 24 of 25 grouped areas.
The final review confirmed the quiet-hours spacing, scope labels and date model.
Small follow-ups connect both web time fields to the error for assistive tools,
fix device-only failure wording, clarify the native selection footer and document
exclusive range ends in the shared snapshot. The existing ISO fields remain
unambiguous without a second representation of event dates.

Native batching still places its selected value below the captioned label. This
is recorded as a minor layout follow-up, especially for large text, rather than
starting a fourth review. Real EventKit integration, push delivery, native
preview/confirmation gestures, VoiceOver, dark mode and large text remain gaps.
The final area is empty/offline content, share extensions and widgets.


## Empty/offline content, shared drafts and widgets baseline

The final area now has desktop and phone captures for an empty assistant list,
an empty conversation, its draft-starting action, offline reading and the draft
after reconnection. The agent typed a draft, disabled the fixture browser's
network, checked that sending was disabled, then restored the network and
confirmed the same draft remained. No message was sent. A capture selector first
expected Send message after reconnection even though the working fixture exposes
Send guidance. The script was corrected and the full capture completed.

Compiled iPhone captures show the empty assistant list and the real shared-draft
review form with sample text. Widget captures use the production small and medium
views with fresh, stale and empty sample snapshots in a Debug-only app screen.
They do not show a Home Screen host, actual WidgetKit timelines or widget taps.
The share extension's system-hosted page and file import remain source-only.
Native cold-start reading from the offline library, the real share-sheet flow,
permission decisions, VoiceOver, dark mode and large text are not demonstrated.

The existing service-worker suite passes 35 checks. Both builds completed; native
build and captures used the machine lock and shut the simulator down. Browser
and preview server are closed. This commit adds capture entry points rather than
changing product behavior. Progress remains 24 of 25 grouped areas, with the
first whole-area review pending. The final Notifications footer wording was
also recaptured after its small follow-up.


## Empty/offline content, shared drafts and widgets, round 2

Round 1 scored 8.3. Shared-draft discard now has its own section and a system
alert with a Keep draft choice. The form explains why adding is unavailable,
labels its text editor for assistive tools and uses the household background.
Share-extension Save stays disabled until preparation succeeds; shared links
say Ready to save instead of reporting zero attachments. Failed preparation
removes its temporary files. The inbox also prunes unsaved UUID directories
older than one day while preserving current work and saved drafts.

Offline web panels omit an unusable Reconnect button. Avatar captions and the
conversation activity say Offline when the device has no network. The native
saved-copy banner makes the same distinction. Empty assistant lists now have
a heading and a useful next step; empty conversations name the assistant's role.
Widgets distinguish signing in from creating a first assistant, and stale
footers retain an age instead of only asking for a refresh.

The review's proposed navigation fix was not applied. AppStore.select already
sets conversationRequest by default, and RootView observes it to open the chat.
The existing import calls that path. This is source evidence; the capture does
not demonstrate a real import gesture or file transfer.

All 89 affected web checks pass, including offline status and reconnect behavior.
Both builds completed. Production share-inbox code also passes standalone Swift
checks that remove old unsaved files and preserve fresh work, saved drafts,
unrelated directories and symlinks. Fresh web captures repeat draft preservation
through outage and reconnection at both widths. Empty desktop Today data now
matches the empty roster. Compiled iPhone captures show the updated empty list,
share form, offline guidance, discard alert and fresh/stale/empty widget views.
The alert is opened by a Debug entry point, so no native tap is claimed.

The browser, preview server and simulator are closed. Real share-sheet import,
file transfer, cold-start offline reading, system-hosted widgets, VoiceOver,
dark mode and large text remain unverified. Progress remains 24 of 25 grouped
areas, pending the second whole-area review.
