# October 25 full app design review

This is the validation ledger for the screen-by-screen design pass requested by
Nicolas. The screen inventory and review history are in [Design review](../DesignReview.md).
The work started from `383bde4` on `nic/full-app-design-review`.

## Today, revision 2

The web source fingerprint is
`sha256:a6980c80af64525b527644e222f4f96e06e30135b795c20be8510afdec3c6e73`
for `src/`. The native fingerprint is
`sha256:33b0b971e07b0bbcf5561e30d95214a2c6b1c2318d09273611b1121df5eaf437`
for `ios/`. The runtime is Node 26.10.0 and npm 11.19.1. Native builds use
Xcode 27.1, build 27A9275, and the reserved ChatUX-I1 iPhone 17 simulator on
iOS 27.0. The repository's shared native validation lock controls each build
and test run.

The focused web tests passed all 12 cases, including request routing, secure
request labels, deduplicated work counts, disconnected assistants and exact
frontier acknowledgement. The production build completed. The current full web
suite passed 1,269 tests across 100 files with two workers. The native Today
regression and capture tests passed in `.private/ios-test-20261026T035713Z-26234.xcresult`.
The representative iPad Pro 11-inch capture passed in
`.private/ios-test-20261026T040036Z-28721.xcresult`, using the same native inputs
and the populated design fixture.

Agent browser checks use the synthetic loopback preview and a shared populated
fixture, with no household accounts or Hermes connections. They cover widths
320, 390, 768 and 1440, light and dark themes, empty, partial, paged, stale-error
and loading states, keyboard focus and Enter activation. The capture report found
no horizontal overflow at those widths. The disconnected row opens the correct
conversation. Annotated desktop, phone and native before/after images are staged
on DevSSD for PR attachment.

The baseline native screenshot tour passed. The first native Today regression run
failed because its expected paging sentence still used the old copy. That
expectation was corrected. The rerun passed and captured AX3, the content below the
first viewport, partial availability, stale errors and loading.

Independent Claude Opus 5.5 reviews used High effort. Today started at 5/10. The
first revision scored 8.5/10 on web and a provisional 8/10 on native. The reviewer
found a native regression that hid named disconnected-assistant errors, and a
work count that included an assistant already shown under decisions. Revision 2
restores named, actionable disconnected rows on both platforms and counts only
the work listed in the work section. The second review closed the Today gate at 9.2/10 on web and 9.1/10 on
iPhone and the loaded iPad view, with no obvious remaining issues. The
[review report](../evidence/design-review/today-review.md) retains the findings
and accepted decisions.

No real Hermes execution, deployment, physical-phone acceptance or external
service interaction has run as part of this design pass.

## Assistants home and context menus

The web source fingerprint is
`sha256:3f8180af950440ba9350201fc663921eec795e4cce8964ada9acd9f084187ac1`
for `src/`. The native fingerprint is
`sha256:90204decb57ca54237729c69a16a0ae487747d5c519fe0abdd4306371e8f33b5`
for `ios/`. Both builds use the same runtimes as Today.

The 93 focused web tests passed across sidebar, application shell, shortcuts and
font scaling checks. The production build completed. Home captures cover light
and dark, narrow phones, 200% text, scrolled large text, no pins, three pins,
empty home and context menus. Keyboard Shift+F10 opens the menu and the section
submenu opens by pointer. The capture report found no horizontal page overflow.

The native home tour passed on iPhone in
`.private/ios-test-20261026T041611Z-42587.xcresult` and on iPad in
`.private/ios-test-20261026T041759Z-45204.xcresult`. It captured light, dark, the
context menu and AX3 text, including a scrolled view. Before and after captures
use the same populated fixture. Its portrait now uses the authenticated file
route with a PNG on both platforms, rather than a web-only data SVG.

The first Home review scored web Home 8/10, web menus 8.5/10, native Home 8/10
and native menus 9/10. It found detached unread indicators, extra space under
single-line pinned names, a browser-colored focus ring, large-text native rows
that did not fill their width, and misaligned pinned tiles. No later screen has
entered implementation.

### Home revision 2

The current web fingerprint is
`sha256:cacd8d580106d17a2111b88309905b1249c526677686b54dd9738c4091434d0e`
for `src/`. The current native fingerprint is
`sha256:4aecadfd39d51804d046187ff8188dc5f2eb2ccae72575d2ba1af05297df81b5`
for `ios/`. All five findings were fixed. The 104 focused web tests and the
production build passed. Native captures and tests passed on iPhone in
`.private/ios-test-20261026T043055Z-56237.xcresult` and iPad in
`.private/ios-test-20261026T043356Z-59113.xcresult`, including the section submenu.

A real Chromium touch check found a pre-existing mobile menu defect. The modal
backdrop was behind the fixed home panel, so an outside tap could open the
assistant underneath. Giving the portal its own positioned layer puts the
backdrop and popup above home. The repeated check confirmed that the outside tap
hits the backdrop, closes the menu and keeps home open. The first touch harness
attempt also tapped during Base UI's 500-millisecond dismissal guard; the helper
now waits for that documented implementation guard before checking dismissal.

The second independent Home review passed at 9/10 for web and native Home,
and 9.5/10 for web and native context menus. No blockers remain. The report is
[retained here](../evidence/design-review/home-review.md). The reviewer noticed
that the large-text iPad screenshot swiped the conversation instead of the
sidebar. A stable `assistantHome` identifier now directs that capture to the
correct scroll view. The updated iPad capture passed in
`.private/ios-test-20261026T044254Z-67044.xcresult`.

## Conversation and composer, revision 1

The web fingerprint is
`sha256:bf173710ea98fb8b7bc53ee2f1c126208d00d9c695c44c2db68284ccadead157`
for `src/`. The native fingerprint is
`sha256:71a941c1f94e05cfc6fc1b171b1b21c56080ee61b8e9f5818cd236c0cde1abdf`
for `ios/`. Web message text and the composer use 16 px at the default text size,
with 12 px sender labels, 11 px timestamps and 14 px code. The desktop reading
column is capped at 720 px. Native transcript and composer frames are capped at
752 points, including their padding, and the composer placeholder uses the
existing muted palette color. All text still follows browser text sizing or
Dynamic Type.

All 76 focused web tests passed across Markdown, transcript rendering and logic,
composer model selection and relative font sizing. The production build passed.
The browser capture checks verified draft-enabled Send and the actual copied code
on the clipboard. Screenshots cover 320, 390, 768 and 1440 px, dark appearance,
200% text, code copy feedback and keyboard focus. The geometry report found no
horizontal page overflow.

Baseline native captures passed on iPhone in
`.private/ios-test-20261026T044608Z-69332.xcresult` and iPad in
`.private/ios-test-20261026T045023Z-73221.xcresult`. The shared synthetic fixture
contains user messages, paragraphs, headings, lists, a table and a code block.
Native capture tests do not establish physical-device keyboard behavior.

The first independent Conversation review scored web conversation 8.5, iPhone
conversation 7.5, and both composers 9. The iPad remained unscored without current
captures. It found low-contrast metadata on both platforms and native code
rendering with proportional glyphs despite its requested monospaced font.

### Conversation revision 2, native capture pending

The web fingerprint is
`sha256:6a12ac82746b7525e0b94030b86d7271c7051d88bb3057d418cd0ba5c2604c1d`.
The native fingerprint is
`sha256:51c9f10ff40dea854431627986f9cdf30fc733cceb9c635811e4e61f0ae8e7f2`.
Message metadata now uses a dedicated color on both platforms, including delivery
labels. Browser checks read computed colors and measured 4.891:1 in light mode
and 5.569:1 in dark mode against the actual user bubble. The production build
and conversation capture checks passed. The code-focus check uses actual Tab
navigation and asserts `:focus-visible`. The composer minimum height now scales
with text, and the 200% capture shows the full placeholder.

Native code blocks, tool output and raw agent responses explicitly override the
app's rounded font design. The native capture helper now waits for input focus
and keyboard layout, and checks visible code-copy feedback. Fresh native
captures are pending the shared Mac build slot requested by SteadLog's urgent
fix task. No additional native build has started during that hold.

The web recheck passed at 9/10 for Conversation and 9.5/10 for Composer. The
[report](../evidence/design-review/conversation-web-review.md) records the resolved
contrast and focus findings. Native remains gated.

Before resuming native work, process and simulator inspection found no active
`xcodebuild`, no remaining SteadLog test simulators, and only the user-owned
iPhone 17 booted. Memory pressure reported 53% free. The incremental native
build resumed with two jobs under this repository's validation lock, with phone
and tablet captures kept sequential.

The revision 2 native capture tests passed on iPhone in
`.private/ios-test-20261026T050734Z-89740.xcresult` and iPad in
`.private/ios-test-20261026T050938Z-91988.xcresult`. The captures confirmed
darker metadata and the iPad width limit, but code still rendered with
proportional glyphs. Passing the capture test did not establish the visual fix.
The next revision moves the monospaced request from the surrounding `Group`
onto both code `Text` branches, using Apple's
[`Text.monospaced`](https://developer.apple.com/documentation/swiftui/text/monospaced(_:)).
Its native fingerprint is
`sha256:0f8ebc3ae06d2ec5bd84c7c5453a7385ecc2b89da200cd3b617e7ef60bf92654`.

The new `capture-design.py` driver replaces repeated manual wrapper generation.
Its end-to-end run captured all 18 conversation images and saved the browser
report with no overflow. It requires an existing owned browser session, existing
artifact directory and an HTTP loopback origin without credentials.

The direct `Text.monospaced()` attempt also left the glyphs proportional.
An Opus rubber-duck compared the actual conversation crop with the existing
working revision hashes in `HermesUpgradeView`. That screen applies
`monospaced()` to the `Font` value rather than specifying a font design.

A rendering regression first failed on the old font. Under the rounded app
design, eight `i` characters measured 26 points while eight `M` characters
measured 91. At AX3 they measured 57 and 223. The failed run is
`.private/ios-test-20261026T051630Z-95711.xcresult`.
The replacement uses `Font.footnote.monospaced()` for code. Tool output applies
the same transformation to its inherited font so each caller keeps its semantic
text size. The regression checks equal glyph widths and actual Dynamic Type
growth, rather than just comparing font declarations.

The current native fingerprint is
`sha256:5d3eab870c3b705b4431286433c89aa90b9a7a25e5491a9ed3638d96802f31a6`.
All 13 native Markdown tests and the iPhone conversation capture test passed
in `.private/ios-test-20261026T051720Z-96128.xcresult`. The new glyph-width
regression passed, including AX3 growth. The fresh screenshot visibly uses
fixed-width glyphs and preserves syntax colors, italic comments, and copy
feedback. The code-font change reuses the same font-value transformation as
the existing revision hashes in the native updates screen.

The iPad font-fix capture passed in
`.private/ios-test-20261026T051856Z-97895.xcresult`. A final styling adjustment
uses `Palette.muted` for the visible code-language label, copy confirmation and
folded work summary, replacing the same low-contrast system secondary style.
The final native fingerprint is
`sha256:b744ec46c542c0d61b881831868f005815a6e228ef9b2fa04656c16301eb8226`.
The updated iPhone capture passed in
`.private/ios-test-20261026T052237Z-98983.xcresult`. The 13 successful Markdown
checks are reused because only these three colors changed afterward.

The final iPad capture passed in
`.private/ios-test-20261026T052407Z-205.xcresult` with the same native fingerprint.
Both final native runs cover light, dark, AX3, earlier history, a typed draft
that enables Send, and visible code-copy confirmation. The final native
before/after annotations are staged for iPhone and iPad. Ruff passed on the new
capture driver.

The native review scored both conversations 8.5 and both composers 9. It
confirmed fixed-width glyphs and passing metadata colors, but found the
start-of-conversation notice at 3.37:1. That notice and its related surface
captions now use `Palette.muted`, which measures 4.7:1 on the surface and
4.91:1 on the raised card. User-bubble metadata retains its separate darker
color. The updated native fingerprint is
`sha256:a2e96d0e115a2ede6d7f09f258e188ac42e5a7e13b4a29a2a1ee44cad147928d`.
The targeted iPad loaded-state capture passed in
`.private/ios-test-20261026T053457Z-4791.xcresult`. It now captures earlier
history before the copy and draft actions, then returns to the latest reply.
The review explicitly allowed source verification for the shared iPhone notice.

The capture driver now prefers PATH, pins its npm fallback to Playwright CLI
0.1.22, limits screen names to existing shared fixtures, and atomically replaces
a report only after a successful run and valid JSON. A fake CLI failure
preserved a seeded good report; a successful response replaced it. The real
CLI version and cached package metadata both report 0.1.22. The initial pinned
invocation could not find the browser because an npx package specification has
a different session namespace. The existing browser was still open under its
original cached CLI, so the driver reused that installation through PATH.
No browser was restarted. The real before and after runs then passed, with
18 screenshots each and no viewport overflow. Baselines record low contrast
instead of failing the post-change contrast gate. The shared sidebar preview
now uses the actual last reply and timestamp from its transcript.

The final native recheck passed iPhone and iPad Conversation at 9/10, with
both composers remaining at 9/10. The fresh start notice measures 4.70:1.
The [native report](../evidence/design-review/conversation-native-review.md)
records the closed findings and the uncaptured states still assigned to
later screens. No obvious issues remain in the reviewed conversation states.

Two capture safeguards were then completed without changing app rendering.
A successful run deletes its stale failure log, confirmed by a real driver
rerun. Invalid Today and Conversation variant names now fail instead of
passing with zero captures. The native build succeeded and an intentional
negative run failed with both expected `Unknown ... capture variant` messages
in `.private/ios-test-20261026T054849Z-11453.xcresult`. The resulting native
fingerprint is
`sha256:a2c96d3608635c4154cc06dccbbf6aa19b1a8e05c200b47b0144675c2092e6c0`.
These are test-harness changes; the reviewed app rendering is unchanged.

## Questions

The shared fixture is `.agents/fixtures/questions-design.json`. It contains
one route choice, several optional preparations and a written note. The first
submission fails, then the retry accepts the same answer payload. The web
fixture has a private snapshot, so its accepted view is refreshed explicitly
after checking the local "Answers sent" state. Native refreshes its snapshot
after the response. Neither fixture executes Hermes or any household action.

The web fingerprint is
`sha256:fb603c0bb3c1db8d0c58c514efa8f32a7d27362060a6d71f066cbce64e627b90`.
All 52 focused tests and the production build passed. Regression cases cover
multiline answers, typed number keys, duplicate-submit prevention, preserved
answers after failure, stale-error removal, initial question placement and
keeping the reader's position during refresh. The browser run captured 20
images with no viewport overflow, including actual coarse-pointer media,
320/390/768/1440 widths, dark, 200% text, own answers, failure, retry and
acceptance. Its two submissions contain identical payloads.

The native baseline passed on iPhone in
`.private/ios-test-20261026T060323Z-17299.xcresult`. The first iPad baseline
failed because the general screen swipe hit the composer while the keyboard
was visible. Targeting `conversationTranscript` fixed the capture; the iPad
baseline passed in `.private/ios-test-20261026T061547Z-26820.xcresult`.

The first native placement attempt opened above the card, leaving its first
choice clipped. A new frame assertion caught that despite successful builds
and the earlier capture run. Binding the scroll position did not fix it. An
Opus rubber-duck identified the missing layout repeat. The initial card now
has pending placement that follows geometry and viewport changes, and releases
on input, search, send, navigation or request removal. It does not persist a
card ID as a message read position. The frame assertion and question interaction
regression passed on iPhone in
`.private/ios-test-20261026T115749Z-81896.xcresult`, and the iPad capture passed
in `.private/ios-test-20261026T120230Z-83709.xcresult`.

Larger text then exposed a truncated decision count and an oversized stop glyph.
The dock now stacks its action at accessibility sizes, and the glyph scales to
a maximum of 24 points within its 44-point target. The current native fingerprint
is
`sha256:7f8837f3a69bce01c1ba58b0517a0c392748a115539ad35ef0e00c2e7ccbddc4`.
The final iPhone capture and existing question interaction test passed in
`.private/ios-test-20261026T120958Z-88331.xcresult`. The separate iPad capture
passed in `.private/ios-test-20261026T121559Z-91256.xcresult` with the same inputs.


The final question UI also explains the required answers and uses a large native
Send button. Its measured target is at least 44 points. The common native error
banner now uses the passing danger token, has a 44-point dismiss target, and
posts accessibility announcements. No manual VoiceOver session was performed.
Invalid question capture variants now fail explicitly.

A later capture attempt failed because its blind return swipe did not reliably
select the own-answer row. The harness now uses the real Review action, asserts
the row is selected, and waits for its field before typing. One retry used a
mistyped destination UUID and failed before execution. Neither failure is counted
as a passing check. The final iPhone capture passed in
`.private/ios-test-20261026T124147Z-6227.xcresult`. It executed one capture test;
an extra nonexistent test selector selected no test. The final iPad run passed
both the capture and the correctly named existing question regression in
`.private/ios-test-20261026T124334Z-7695.xcresult`.
Both final runs have native fingerprint
`sha256:ed92637fb65dd54e3dd16fe9391fbdc1756772e4ba77dfee0a0d9c03bfb6c29f`.
They include light, dark, accessibility text, custom writing, failed submission,
kept answers and successful retry. The iPad failure capture includes the software
keyboard. These are simulator fixture checks, not physical-device acceptance.

The latest browser run retains 20 screenshots with no overflow, passing initial
choice visibility and actual coarse-pointer media. Its accepted button state is
checked before explicitly refreshing the synthetic snapshot. The 52 focused web
tests and production build passed after the required-answer guidance change.
The fingerprint for `src/`, `tests/`, `.agents/tools/capture-design.js` and the
question fixture is
`sha256:4cc69dd7ed8ff46d89de393d1a234de75c5165cf3b3ca623840cba2ca413f4f4`.
Six annotated comparisons cover web opening and writing, native opening, large
text, retry cleanup, and iPad fields. Independent review 09 is next.


### Questions, review 09 fixes

Opus rated web desktop 8.5, web phone 7.5, iPhone 8 and iPad 8.5.
The jump control covered opening choices, native could stop following after an
answer, and the web failure instruction was 11 pixels. Questions remains gated.

The web hook now distinguishes opening at a question from reading older messages.
Scroll intent clears that position and restores the normal jump control. Removing
the opened question resumes following. The regression checks no jump on opening
and its return after a wheel gesture. Web validation passed 51 transcript tests
plus the separate font-size test, 52 in total. The production build passed.
The browser driver now reloads for each opening, including the 200% state before
answering or failing. All eight openings have no jump control, and the first
choice fits at every normal text size. The current report
`questions-v2-after.json` has 21 screenshots with no overflow, preserved identical
retry payloads and a measured 14-pixel error instruction. Its first attempt caught
a wrong parent selector on the error rule; the corrected rule and rerun passed.

Native separates pending placement from the opened question's reading position.
A card that fits in the viewport can finish placement even when it cannot reach
the top. Submission resumes following before the refresh. Scroll phases release
pending placement for keyboard or accessibility scrolling as well as dragging.
This is source coverage, not a manual VoiceOver acceptance claim. Success now has
an announcement on both platforms, and the helper changes to "Ready to send."
Old errors no longer announce whenever the common banner reappears; conversation
announcements observe newly changed errors instead.

The new short-question regression answers by tap, receives a reply taller than
the viewport and asserts its final message is fully visible without a jump.
It and the full iPad question capture passed in
`.private/ios-test-20261026T130042Z-14068.xcresult`. Native fingerprint:
`sha256:6011156a75c1708ecfbfdf746607ea729ba8341570d655c15194e1a6eca17c92`.
The same two iPhone checks passed in
`.private/ios-test-20261026T130242Z-15275.xcresult`. Web source, tests, capture driver and fixture
fingerprint:
`sha256:9e574d794e07a81f659c95eb5fb537d8a6556bcd11d5623540688259c105a17a`.


Opus recheck 10 closed all three must-fix findings and scored web desktop,
web phone and iPad 9/10. iPhone was conditional on a first-choice capture.
That capture passed without app changes in
`.private/ios-test-20261026T131110Z-19892.xcresult`. The choice is selected and no
jump button covers it. The updated native harness fingerprint is
`sha256:19572e5e4c3eb115b90e0f340e85bb98444f1c74ced5ba0ce13a85e9ade87274`.
The conditional iPhone score is therefore 9/10. The original report and the
implementer's acceptance note are kept separately under `docs/evidence/design-review/`.

The recheck's small web coverage gap now has a regression: removing the opened
question resumes following the new reply. The focused suite passed 53 tests in
`questions-final-tests.log`. No app source changed after the passing production
build or browser run. The source, tests, capture driver and fixture fingerprint
including this added test is
`sha256:0086586826dfe59b702aeffe4a116c5b4e88361aff17e8c822e43afb7d74e857`.
Questions can proceed to Approvals. Seven annotated comparisons and the extra
first-choice screenshot are staged for the final PR attachments.


## Approvals

The shared `.agents/fixtures/approvals-design.json` contains one pending calendar
reminder, a first-send failure and separate accepted/declined snapshots. It uses
only synthetic household data. Native baselines passed on iPhone in
`.private/ios-test-20261026T131709Z-22986.xcresult` and iPad in
`.private/ios-test-20261026T131858Z-24116.xcresult`. The web baseline has 16 images
and no overflow in `approvals-before.json`.

Initial changes enlarge and align web approval typography and spacing, make
native actions at least 44 points, stack them at accessibility text sizes, use
passing muted text for expiry, and explain disabled unsupported decisions. Retry
clears the old error, and native announces a confirmed decision. The opening
placement code now covers approvals as well as questions and retains search and
reader-scroll priority. The state name changed from question to attention to
match its broader use; the frame-placement helper is shared by both card types.

The 55 focused web tests and production build passed. New approve and decline
regressions check preserved decision payloads after failure, stale-error removal
and duplicate prevention. `approvals-after.json` contains 16 screenshots, no
overflow and exactly four payloads: approve, approve retry, decline, decline retry.
The final private fixture snapshot still refreshes explicitly on web, after
checking the accepted button state. No live event delivery is claimed.
The web source, tests, capture driver and approval fixture fingerprint is
`sha256:5852f4b6716c6058e65a6266376deb4be5d7fc0b21a0397885a6c3819b9dff2d`.

The initial native after runs passed on iPhone in
`.private/ios-test-20261026T132121Z-25889.xcresult` and iPad in
`.private/ios-test-20261026T132322Z-26777.xcresult`. The iPad run also passed the
short-question/long-reply and existing multi-question regressions. These runs
used native fingerprint
`sha256:f4f2bbe62af93aa95dcf32ffc1f0cb371af99a601c26f41844ea075b4cbc418e`.

Visual inspection then found that normal-size iPhone actions sit below the
viewport despite the title being visible. The previous capture assertion had
checked only the title. A new full-action frame assertion failed as expected:
the button ends at 679 points while the viewport ends at 619.33 points. The
failure is `.private/ios-test-20261026T132618Z-28344.xcresult` with unchanged app
code and fingerprint
`sha256:07c637236041bf3ab847ecbac03d26c5d5112e71680dd66d437a0bb3ed5286ed`,
which includes the updated harness. An Opus rubber-duck is pressure-testing the
opening placement before the final native capture and design review.

The annotation renderer now wraps narrow panel titles instead of clipping them.
Ruff passed, and existing comparisons are being regenerated. This only affects
review evidence, not app rendering.


Opus diagnosed the opening failure without running builds or tests. The old
"card fits" branch could cancel the queued scroll before it ran because it
combined values from separate geometry callbacks. The revised
`OpeningCardMetrics` reads the card top, viewport and padded content end from
one geometry proxy. Placement completes only at the top or the actual clamped
end. It derives following from that same snapshot. The padded content has its
own coordinate-space name, so the check does not duplicate its padding constant.

The targeted phone run now passes the previously failing action assertion in
`.private/ios-test-20261026T133351Z-32666.xcresult`. The complete request and both
actions are visible in the updated capture. The harness now also checks Decline
and the unavailable reason, and rejects misspelled approval capture variants.
Full phone approval and related question/find regressions are running against
`sha256:18abe53f0ee1e4d0a849d44f32962257850954d8d15b5454c6fbbb05135402d7`.

A rendered-size check also caught the old web expiry rule overriding its new
size. Approval styles now live together in `styles.css` with the expiry set to
14 pixels. The updated production build, font-size check and 16-image browser
run passed; the report measures 14 pixels. The current web source, tests,
capture driver and approval fixture fingerprint is
`sha256:596f0ac87f6604e5fb920962539f50ca0f9f9a9ec9a210df3ff85ba3a5a0c8fe`.
The earlier 55 behavioral tests remain applicable because only CSS and capture
assertions changed afterward.


The final phone run passed all five selected checks in
`.private/ios-test-20261026T133602Z-33663.xcresult`: approval captures with full
button/reason bounds, question captures, the short-question long-reply check,
multiple-answer submission and find across unloaded history. All use the same
native fingerprint `18abe53f...` above. The iPad capture and corresponding
question regressions are running next. No native source changed between them.


The final iPad run passed all four checks in
`.private/ios-test-20261026T133951Z-36765.xcresult`: full approvals and questions
captures, short-question follow, and multiple-answer submission. Its native
fingerprint matches the phone exactly. Both final approvals sets cover light,
dark, accessibility text, unsupported decisions, approve failure/retry and
decline failure/retry. Button labels and the unavailable explanation fit their
asserted bounds at normal text size. Native expiry contrast uses the existing
muted token; VoiceOver announcements remain source-verified only.

Eight annotated approval comparisons cover web card hierarchy, unavailable
controls, retry cleanup, native opening, large-text actions, unsupported controls,
retry cleanup and iPad actions. Review 11 is next. Expired-server transitions,
physical devices and manual VoiceOver were not exercised by these fixtures.


### Approvals, review 11 fixes

Opus rated web desktop/phone 8.5 and native iPhone/iPad 8. Three blockers remain:
the shared `.approval-card` class spread the new layout to questions and secure
cards; accepted decisions lacked a readable visible confirmation; and native
prominent buttons used white on mint in dark mode at 1.76:1.

The decision layout now has a dedicated `.decision-card` class. The shared
request shell has its accepted rules again. Opening selection explicitly matches
clarify and approval data hooks. New tests cover an opened approval, following
when it is removed, and an official card before a question. A real secure card
has its own pre-existing reveal path at `use-conversation.ts:168-171`, which takes
priority on opening. A new test confirms that behavior. Thus the review's claim
that a real secure card previously lost to a question was incorrect; its existing
explicit reveal remains intact. The overly broad ordinary selector is fixed.
The 58 focused web tests pass.

Both platforms now show a full-contrast sent confirmation separately from the
disabled action. The browser measures 14-pixel text at opacity 1 for both
"Approval sent." and "Decline sent.". Native fixtures can hold the old pending
snapshot after acceptance, and new capture variants cover both confirmations,
including dark mode.

Native `Palette.onAccent` pairs off-white with the light-mode green and dark ink with
mint. A shared primitive button style keeps the native prominent control and
sets the label color. All native app prominent buttons use it, including the
accepted Questions action and the future screens that had the same defect.
An actual dark approval capture verifies #1B211E ink on #8BD2B2 at 9.32:1,
replacing white on the same background at 1.76:1. The targeted dark capture
passed in `.private/ios-test-20261026T140234Z-50502.xcresult`. The shared style
preserves control size, tint, role and the button trigger. Full approval and
question runs will check interaction as well as rendering.


The final phone rerun passed three checks in
`.private/ios-test-20261026T140511Z-51708.xcresult`: approval captures including
held approved/declined states, Questions including an enabled dark Send action,
and short-question long-reply following. Its native fingerprint is
`sha256:bf7df434f1d19287a361ddfeca3a79bb0df7a1395faf32d0bb0f3eaaaf09f917`.
The same iPad checks passed as recorded below. Control actions still execute through the shared
style, and existing 44-point and frame assertions pass.

The web production build and 58 tests pass. `approvals-v2-after.json` retains
16 images with no overflow, measured 14-pixel expiry and confirmations at opacity
1. `questions-approvals-v2-regression.json` recaptures all 21 question states,
including desktop/phone openings, with no overflow and no initial jump overlay.
These are fresh after the shared-shell fix. The current source, tests, capture
driver and approval fixture fingerprint is
`sha256:0c07b28281d76e24d57d611cf2fd91f8481aaf488b49a1334cb488ac1da73b5a`.


The matching iPad rerun passed all three checks in
`.private/ios-test-20261026T140949Z-55869.xcresult` with the same native fingerprint.
Both devices now have held approved/declined confirmations and enabled dark
Questions actions, in addition to the existing opening, large-text, unavailable,
failure/retry and follow checks. No manual VoiceOver or physical-device run was
performed. The native shared style changes only prominent label color; its
system appearance, role, tint, control size and trigger are retained.

Ten annotated approval comparisons now include the dark-label contrast and the
visible sent confirmation. All existing comparisons are refreshed from current
raw captures. Review 12 will recheck M1 to M3 and the newly changed shared style.


### Approvals, review 12 disabled-label correction

Opus closed web desktop and phone at 9/10. Native stayed at 8.5 because the new
shared label color also overrode disabled labels. The helper now observes
`isEnabled` in a View and applies the accent-pair label only to enabled buttons.
Disabled controls retain the system label and fill. No other app behavior changed.
The native fingerprint is
`sha256:568ea7d82fdee21114b782812e6f6ab45ec2c907dde8d1baec79873ac3d47a12`.

The phone approval and question capture flows passed in
`.private/ios-test-20261026T143204Z-66530.xcresult`. Pixel sampling of the actual
held images shows #C2C2C0 on #E9E8E4, 1.45:1 light, and #65696A on #3E4442,
1.79:1 dark. Both match the baseline system treatment and the sibling disabled
Decline action. Enabled dark approval stays #1B211E on #8BD2B2, 9.32:1.
Disabled controls are contrast-exempt; the readable sent-status line still
carries the confirmation. The iPad matching capture is running. Web checks are
reused because no web source changed. The contrast annotation's marker now sits
off the button label.


The iPad approval and question rerun passed in
`.private/ios-test-20261026T143540Z-68274.xcresult` with the same native fingerprint.
Both devices' held light, held dark, unsupported and disabled dark Questions
captures now match the system disabled colors. The measured pairs and exact
sampling regions are retained in `reviews/13-disabled-samples.txt` on DevSSD.
The enabled approval and Questions colors remain 5.91:1 light and 9.32:1 dark;
those samples are in `reviews/13-enabled-samples.txt`. The restored disabled
labels are contrast-exempt, and the full-contrast sent-status text remains.
No web source or checks changed after its accepted review 12 score of 9/10.
The final native R1 recheck is next.


Review 13 independently reproduced the native pixel samples and closed R1.
Both native layouts score 9/10; web's accepted 9/10 is unchanged. No obvious
remaining issue was found within Approvals. The final reports are retained at
`docs/evidence/design-review/approvals-web-review.md` and
`docs/evidence/design-review/approvals-native-review.md`. Approvals can proceed
to Failed and interrupted turns. Existing nonblocking findings remain assigned
to their later screens, not silently discarded.

### Failed and interrupted turns, in progress

Baseline app source is accepted Approvals commit `098c9b1`. The shared recovery
fixture covers a failed gate check, its refused or unconfirmed retry, and an
interrupted two-gate check whose last completed action remains visible. Browser
baselines were regenerated against an archived build of that commit at loopback
port 3043. `recovery-final-before.json` records 19 distinct captures with no overflow.
The separate original-branch experiment is superseded by that accepted baseline.

Both clients now show the actual failure/interruption reason, a distinct task
heading, readable recovery guidance, and larger retry controls. Recovery keeps
the existing retry implementation and submission contract. The fixture driver
checks draft preservation, append-on-request after refusal, the same request ID
for an unconfirmed retry, and the required interruption acknowledgment. Browser
accepted-state capture uses an explicit reload because the private snapshot
route cannot stream events. This is not live Hermes acceptance evidence.

Web: 104 focused transcript and app interaction tests passed in
`recovery-tests-v2.log`. The production build passed. The first native baseline
failed on a test locator that treated the custom toggle as a button; the actual
accessibility control is a switch. Corrected baseline runs passed on iPhone
`.private/ios-test-20261026T151404Z-94637.xcresult` and iPad
`.private/ios-test-20261026T151651Z-96265.xcresult`.

Native first after run passed 28 tests, including all 27 transcript feature
tests and the recovery capture flow, in
`.private/ios-test-20261026T151942Z-97921.xcresult`. Source fingerprint was
`f8bb9f354c3d7185e3aa552c0b6e1fc107abe25dc2ca7cabb6fbea765b9b0741`.
Visual inspection then found the long acknowledgment truncated at AX3. A shorter
acknowledgment and native wrapping fix require fresh captures before review.

No physical-device, VoiceOver, hardware-keyboard or real provider run is claimed.

The final web build and all 104 focused tests pass in `recovery-v3-build.log`
and `recovery-v3-tests.log`. `recovery-final-after.json` has 19 distinct images
with no document overflow at 320, 390, 768 and 1440 px, light/dark and 200% text.
It records five retry submissions, draft preservation, request ID reuse for an
unconfirmed retry, disabled resend without idempotency support, keyboard focus,
and the interruption review gate. The web fingerprint is
`9026d15f926e44d7863866c9baf92c1acd33d28828cf47d3bff55967329fc72d`.

The native acknowledgment now reads "I've reviewed the task's last actions."
and grows vertically. Its full label is visible at AX3 on iPhone. The final
iPhone capture flow passes all nine variants in
`.private/ios-test-20261026T152555Z-1366.xcresult`. Native fingerprint is
`6d9b25f32695d7c85296b152dab146c704ebe82cdac9ae641363274ccf4f3e6d`.
The 27 transcript feature tests passed before the subsequent acknowledgment-only
change and remain applicable to the unchanged retry/store implementation.

The iPad acknowledgment run also passed, in
`.private/ios-test-20261026T152846Z-2989.xcresult`, on the same `6d9b25f3`
native inputs. A subsequent pixel check found the native bordered Retry label
was 4.38:1 in light mode, below the 4.5:1 target. Recovery actions now use the
already-reviewed accent-prominent button style. New native inputs are
`f4bfe94e17660cc83d0759d732c369bc67e64adbc2706a458bca1c12b50fffb8`;
final iPhone/iPad reruns and button pixel checks are required before sign-off.

Final native v4 capture flows passed on iPhone
`.private/ios-test-20261026T153244Z-4851.xcresult` and iPad
`.private/ios-test-20261026T153524Z-7345.xcresult`, each on the exact `f4bfe94e`
inputs. Each flow covers nine variants and writes 16 images. The acknowledgment
wraps fully at AX3 on both layouts. The enabled recovery action measures 5.91:1
in light mode and 9.32:1 in dark on both devices. The sampled regions, colors
and ratios are in `recovery-final-button-samples.txt`, with four label crops.
Twelve annotated before/after comparisons are staged. Opus review is pending.

### Recovery review 14 and recheck preparation

Opus rated web desktop/phone 8.5 and native iPhone/iPad 8.8. The gate remains
closed. It requested a stable web activity status region including the reason,
primary web recovery actions, and the native acknowledgment target inside the
button label. The first two are implemented. All 105 focused web tests and the
production build pass in `recovery-v5-tests.log` and `recovery-v5-build.log`. A
working-to-failed regression checks that the same live-region DOM node retains
the failure heading and reason. `recovery-v5-after.json` has 19 fresh distinct
captures with no overflow, including the filled primary action and keyboard ring.

The native baseline edge tap and a tap five points below the text both passed
on iPhone. Thus the reported dead area was not reproduced, and no failed tap is
claimed. The baseline geometry does confirm an 18 pt accessibility frame:
`REVIEW_PADDING row=(14.0, 646.0, 261.6667, 18.0)` in
`ios-recovery-padding-baseline-below-text.log`. Both baseline probes passed in
`.private/ios-test-20261026T154703Z-13512.xcresult` and
`.private/ios-test-20261026T154902Z-14495.xcresult`.

The label now owns its padding, 44 pt minimum and rectangular content shape.
The native test asserts the accessible row is at least 44 pt tall, then taps
trailing whitespace five points below the caption and checks Send becomes enabled.
Full capture reruns verify that check in light, dark and AX3 on both layouts.
One invalid-destination launch was stopped before tests and is not counted.

The exact post-review code diff is staged at
`reviews/15-recovery-delta.patch` in the artifact directory, with reviewed source
snapshots under `reviews/14-reviewed-source/`. Current web fingerprint is
`3ba66376ceaeb0b58aa03aea189da79dbc87c588c48a5411f06af40e6917c296`;
native is `565807ca2d5ccb5a5f942f1bc35fa5a8bc53bb6ede2aff7ea6abe3bfa341af53`.

The final M1-M3 native runs passed:
iPhone `.private/ios-test-20261026T155048Z-15908.xcresult` and
iPad `.private/ios-test-20261026T155320Z-17266.xcresult`, both exact `565807ca`
inputs. Normal/dark row frames are 44 pt on both layouts. AX3 row heights are
98 pt on iPhone and 55 pt on iPad. Every padding/blank-space tap enables Send.
All nine fixture variants passed on both devices. All twelve annotations were
regenerated after the final captures. Web primary labels sample at 5.66:1 light
and 9.32:1 dark. Opus M1-M3 recheck remains pending; no screen advancement.

Opus review 15 accepted web desktop/phone and iPhone at 9.2, iPad at 9.1, with
no blockers. It independently reconstructed the six-file patch, recomputed both
fingerprints and reran all 105 focused web tests on the final source. That run
passed in `reviews/15-opus-vitest.log`. It withdrew the predicted dead-tap claim
for the old native control. The refused-retry annotation marker was moved clear
of the text. No app code changed after the passing recheck.

### Assistant details and artifacts, in progress

The accepted starting commit is `af3e8fd`. Shared fixture
`.agents/fixtures/details-design.json` has seven synthetic files, a long model
identifier and a Markdown last-message preview. Its SHA-256 is
`548b984cc72ce0fea638243ed667580cc825e2e8023b43b15fccda32151b16f5`.
Web baseline `details-before.json` has 25 distinct captures with no document
overflow. Native before flows passed on iPhone
`.private/ios-test-20261026T185544Z-18619.xcresult` and iPad
`.private/ios-test-20261026T185825Z-20547.xcresult`. Those baseline flows explicitly
record `DESIGN_PREVIEW_OPENED false`; passing baseline capture does not claim
working previews. Native product changes before these baselines were only
accessibility identifiers for the two lists.

Baseline problems included a model label squeezed into single-letter lines,
overlapping quick-action labels at 200%, small artifact metadata, raw Markdown
in the last message, low-contrast native captions and a white count on mint.
The web now uses stacked facts, plain excerpts, responsive quick-action and
filter grids, readable metadata and code, and semantic status colors. Both
clients show friendly file categories without changing MIME safety checks.
Native profile labels and file names grow at accessibility sizes, and file
icons share a fixed column.

A focused Opus rubber-duck, with no code edits, identified competing native
preview presenters. The baseline accessibility tree had no Quick Look. A
scoped presenter inside the artifact sheet then displayed the file, but exposed
a separate missing-toolbar problem. Quick Look now has a native navigation
container and explicit Done control, plus its standard share action.
Artifact downloads keep their existing generation/cancellation guards, deliver
a preview to the requesting sheet, and report download errors in that sheet.
The row shows progress for its own file. Unit tests verify scoped delivery and
scoped errors. UI captures verify the file body and return to the artifact list.

Early capture failures were corrected for iOS 27's lowercase search "close"
control, the switch thumb rather than its inert label, and taps on partly hidden
items. Capture navigation now checks visible bounds before tapping quick actions
and chat attachments. No console log was available in the baseline xcresult,
so a UIKit warning was not observed and is not claimed.

The annotation renderer now accepts an explicit batch manifest. It preflights all
specs/images and confines output paths to the manifest directory, avoiding the
unrelated matches that a filename glob could include.

The iPhone final-layout run passed all six artifact unit tests and the five-variant
capture flow in `.private/ios-test-20261026T192002Z-35023.xcresult`. The flow
verified scoped and chat previews, visible document contents, Done, a scoped
404 alert, pin/follow, search, empty/error and AX3 layouts. The iPad run then
stopped at a test assumption that a phone-style search cancel control existed.
The app now binds native search presentation explicitly; Clear filters also
leaves search mode. This uses an iOS 17 API verified in the selected SDK.
That small change still needs the planned final phone and iPad runs.

### Cross-project runtime coordination

SteadLog coordinator thread `672d6b62-638e-4247-b4a7-a455d2d3a2ba` requested a
shared native window. No native process was running at handoff. SteadLog has
the next 40-minute bounded window for eight iOS and fifteen Android baseline
rows plus a web supplement. No further native work starts here before its
explicit release. Two native capture runs remain planned.

Both tasks now agree on the exact `fcntl.flock` file
`/Volumes/DevSSD/scratch/steadlog-design-audit-20261025/machine-heavy.lock`.
`.private/ios-machine-lock` configures this task. `validate-ios.sh` automatically
acquires that lease before its existing repo lock, so a direct invocation cannot
accidentally skip cross-project admission. The helper refuses immediately with
exit 75 while held. A harmless probe confirmed that refusal; a separate owned
probe verified the lease survives exec and releases after the command exits.
No SteadLog process, device or admission file was altered.

While native validation is paused for the coordinated window, the final AX3
image review found decorative file icons growing beyond their fixed columns.
They now use an explicit 20 pt symbol in the 24 pt column and align with the
first filename line. That change is included in the two pending native runs.
Web validation is complete: 17 focused tests, a passing build and 26 distinct
captures with no overflow in `details-v3-after.json`. The explicit annotation
manifest currently renders eleven web/iPhone comparisons; three iPad comparisons
wait for the final iPad preview capture. Python tooling lint passes.

### Details review 16 fixes, native runtime still queued

Review 16 rejected the screen for five local issues. Web status colors now
match the app vocabulary; selected metadata passes AA; code previews share the
chat monospace token; the file badge scales beside its icon. Native quick-action
icons now use equal ScaledMetric heights. The native change is unbuilt.

The browser's platform-font probe found Courier behind the previous chat stack.
The shared token adds an explicit Menlo fallback. Actual Menlo glyphs are recorded
in both details and conversation capture reports. This small conversation font
delta is included in the next scoped review. Text previews are now top-aligned,
and the phone file list reveals the next row at 200% text.

Current web checks: 34 focused tests in details-tests-v6.log, production build
in details-build-v7.log, 27 details captures in details-v6-after.json, and 18
conversation captures in conversation-details-font-after.json. Neither report
has page overflow. Selected metadata contrast is 4.62:1 light and 4.91:1 dark.
Six web comparisons were regenerated. Reviewed source snapshots and the delta
are in reviews/16-reviewed-source and reviews/17-details-web-delta.patch.
Web fingerprint: 89e1421c65eae66af87e944db9b8cf87e54a3efc7df2e584d26e03cf962b0e38.
Native pending fingerprint: 25093311a89e33294f89677163d57beb87d27582b257660c89925264b5be0dc9.

No native run has started since the handoff. Two final runs remain queued until
SteadLog explicitly releases its coordinated window. No screen gate is accepted
from expected scores, old native captures or source inspection alone.

### Final details native batch and runtime handback

SteadLog explicitly released its window at 20:10:11Z. The two serialized runs
acquired the exact shared fcntl lock before the repo lock. iPhone result
.private/ios-test-20261026T201139Z-62759.xcresult and iPad result
.private/ios-test-20261026T201438Z-63728.xcresult each passed 7/7 without skips.
Both report exact native fingerprint 25093311, unchanged throughout the runs.
Each device has 21 fresh screenshots inside its result's start/finish times.
details-native-evidence.json lists every hash and timestamp.

All fourteen explicit before/after comparisons now render. The final iPad
captures cover the previously missing dark, AX3, empty/error, 404 alert, search
clear and both document previews. Fresh iPhone and iPad AX3 captures show aligned
Find/Pin labels. The fixed-size file glyph stays within its column.

At 20:17:31Z, both task simulators were Shutdown, no owned xcodebuild remained,
and a nonblocking probe confirmed the machine lock free. The explicit handback
was sent to SteadLog before gallery postprocessing. Its four Android rows now
have the next bounded window. More native work requires coordination after that
window; none is planned for this screen pending Opus findings. No protected
user device or unrelated resource was changed.

The screen gate still awaits the new Opus review. Passing tests and screenshots
do not substitute for its ratings. Details review 16 is archived in the repo.

SteadLog sent its final runtime release at 20:26:53Z, reporting cleanup and a
free nonblocking lock probe. Its remaining captures require a new coordinated
window. Our native checks remain complete; the current Opus recheck is pending.
Any later native batch must still acquire the exact shared lock.

### Details and artifacts accepted by Opus 5.5 High

Review 17 independently verified both patches, exact source fingerprints, all
42 native image hashes and timestamps, test summaries, rendered typography,
contrast and annotations. Every screen passes separately: web details 9.1;
web artifacts/preview 9.2 desktop and 9.0 phone; iPhone profile/artifacts 9.1
and preview 9.0; iPad profile/artifacts/preview 9.0. The web conversation font
delta preserves its accepted 9. No blocker remains. Reports are archived under
docs/evidence/design-review/details-{review,recheck,acceptance}.md.

The optional blocked-avatar morph, standard iPad form-sheet height at AX3 and
tile padding remain accepted nonblocking notes. Two remaining web Courier
fallbacks belong to the later work-details and keyboard-hints passes. No native
rerun is needed for this accepted gate. Assistant creation/settings is next.

### Assistant creation and settings, awaiting screen review

Opus 5.5 High pressure-tested confirmation behavior in review 18. Implementation
uses modal privacy/model/delete confirmations with safe choices, larger helper
text, separate primary and destructive actions, wrapping descriptions and saved
names in headings. Native navigation adapts to accessibility text sizes. The
separate Avatar editor and settings tab bodies remain queued for their own gates.

Web settings-tests-v7.log passes 44 tests and settings-build-v5.log passes the
production build. settings-v3-after.json has 63 screenshots with no overflow,
12 modal bounds inside the viewport and 32 real keyboard field checks with no
obscured fields. settings-before-expanded.json records 63 original client images
from 6fc7384. Web fingerprint a393ec654f68989a25f2044e3634d711e32594914d6f0f09f263f4e2962a2481.

Final native changes remain unaccepted until the current bounded batch and a
new independent screen review finish. Frozen native fingerprint is
baccf1aaffc292255a3b07ce157120ad3bada4904ad9d878d667c52e11762015.
The prior 56 after images are intermediate. The current batch captures the old
model warning on both devices and then all six final variants on both devices.
Automatic cleanup verification and coordinator handback run when the batch ends.
Its work cutoff is thirteen minutes and cleanup deadline is fifteen minutes.
No extension or silent retry is authorized by the reservation.

The frozen final iPhone flow passed, with 33 fresh images verified against its
receipt .private/ios-test-20261026T222126Z-13690.txt. Its native alert presentation
revealed a real remaining failure: body contrast 3.63:1 and green safe-action text
on a blue default fill at 1.59:1. Native creation/settings is not accepted. The
current iPad run will finish without source changes, then automatic cleanup and
handback will release this reservation. No same-slot extension is planned.
Opus review 19 is a read-only rubber duck on native confirmation presentation.

### Native alert attempt rejected and runtime released

The native iPhone flow passed 33 images on baccf1aa. The iPad flow reached the
thirteen-minute work cutoff in its last model variant and produced 30 partial
images without a passing result. The cutoff remained in force. Automatic cleanup
and coordinator handback finished at 22:32:00Z within the fifteen-minute bound.
Both task simulators are Shutdown, no owned xcodebuild remains, and the exact
machine lock probed free. settings-recapture-heavy-release.json is the receipt.
SteadLog has the next separately authorized twenty-minute supplement window.

Opus discussion 19 confirmed the UIKit alert message cannot take an explicit
SwiftUI color and also found the old discard prompt's low contrast. All four
native prompts now use one local themed sheet, with the accepted action executed
after dismissal. Associated warning text cannot disappear when a banner clears.
Native source 29f713df is UNBUILT and unaccepted. Two final full after runs are
queued after SteadLog's release, capped at twenty minutes including cleanup.
Each should capture 37 images and test chained privacy/model prompts, fresh consent
after re-sharing, swipe cancellation, and dark/AX Delete and safe discard actions.

The stale private-consent flag is also fixed on web. 45 tests in settings-tests-v8.log
and production build in settings-build-v6.log pass. Current web fingerprint is
b6a31dc0180458babd3a0cad42c36f9c314d884310fbef2a050ad75365ce4001.
The 63 existing web captures remain visually unchanged by this logic-only guard.
Independent Opus 20 is reviewing web design and the new native implementation.
It cannot close the native visual gate before fresh captures. 16 comparisons are
rendered; rejected alert captures and source are preserved in an immutable archive.

### Review 20 fixes and final settings batch admitted

Opus 20 scores the web wizard 9.1 on desktop and phone. Phone Details is 8.8
because loading/error had no gutters. W1 now has form gutters and a normal-width
Retry button. Focused before/after reports each cover 390 and 1440 px. The after
report measures 21 px phone gutters and at least 27 px desktop gutters, 128 px
Retry, no overflow and a working retry. The composite web manifest reuses the
62 unaffected frames and adds both new error captures, for 64 total. 45 tests
and the production build pass in settings-tests-v9.log and settings-build-v7.log.

Before native execution, N1 added real fixture deletion plus a positive delete
control after swipe cancellation, making the roster assertion falsifiable. Keep
also preserves the form and notices. N2 switches sizing to horizontal size class.
N3 fills step one's Next action. Current frozen native fingerprint is
3dd5c0a5a8fdbbd432d556705096b2385e5e9f5988b968815bb8fc757f8fb68d.
No final native score exists yet.

The final batch acquired the shared inherited fcntl lease at 22:59:55.833605Z,
queued less than 0.001 seconds. Work cutoff is 23:17:55.833601Z and cleanup deadline
is 23:19:55.833601Z. The focused web supplement passed first and closed its browser
contexts. The serialized iPhone/iPad runs are active. Cleanup and coordinator
handback are automatic. No reservation extension is assumed.

### Final settings captures passed and runtime handed back

Both final flows passed with zero skips. iPhone result is
.private/ios-test-20261026T230006Z-35789.xcresult; iPad is
.private/ios-test-20261026T230606Z-39651.xcresult. Each produced 37 fresh images.
The evidence tool verifies all 74 hashes and capture times inside the passing run
windows. Both receipts match current native 3dd5c0a5. All 28 comparisons are rendered.
The five-file delta since review 20 reverse-applies cleanly to the current tree.

All sampled native Delete text pairs pass on both devices: light title 20.65,
message 5.69, accept 6.35, Keep 5.91; dark title 14.43, message 6.67, accept 8.04,
Keep 9.32. The fitted sheet and actions render at normal and AX3 sizes. No final
native score is claimed before the independent recheck.

Automatic cleanup and coordinator handback completed 23:12:38.526188Z. Execution
including cleanup was 762.693 seconds, with under 0.001 seconds queued, inside the
20-minute bound. Both owned devices were Shutdown, no owned xcodebuild remained,
and the exact shared lock probed free. SteadLog acknowledged the handback and
has no heavy work active. Future captures require separate coordination.

A wording correction: the enlarged native captures use AX3, the third
accessibility category, not the system maximum AX5. The evidence labels now say
AX3. Physical device, VoiceOver focus/escape, hardware keyboard Escape/Return,
iPad compact multitasking and iOS 17 fallback remain unverified. Opus 21 is the
scoped recheck for W1, N1-N3 and the final native pixels. No next screen or PR
is authorized by test passes alone.

### Review 21 passes all but native settings load failure

Review 21 independently verified the five-file patch, both fingerprints, both
37-frame native receipts, all 16 contrast pairs and the annotations. Web wizard
and Details score 9.1, confirmations 9.2. Native creation scores 9.2 on iPhone
and 9.1 on iPad; confirmations score 9.2 and 9.0. Native Details remains 8.6
on both because a failed load displays two copies of its error, N4.

The two-file N4 fix skips the normal dismissable banner until detail is loaded,
and gives the loader one padded banner with a bordered Retry whose label has a
44 pt minimum. The capture test now requires exactly one matching error text.
The reconstruction of the source before these edits matches the reviewed
3dd5c0a5 fingerprint exactly. No unrelated app source changed.

Only settings-error is being rerun, seven frames per device, in a separate
artifact directory. The 30 unaffected images per device retain their accepted
review 21 receipts; the strict evidence checker will validate the seven fresh
images against each new run. The composite dataset will still have 37 states per
device, with each state linked to its actual receipt rather than pretending all
37 belong to the focused run.

The exact shared inherited lease was acquired at 23:30:51.875225Z, queued under
0.001 seconds. Work cutoff is 23:38:51.875220Z and cleanup deadline is
23:40:51.875220Z. Source is cd41240f91ed59a901922fdd88dc35adecff890420c12c327cd1cc5752585897.
Automatic cleanup and coordinator handback are wired to completion. SteadLog's
prepared web-only W1 has the next separately authorized ten-minute slot.

### N4 focused flows pass, awaiting scoped review 22

Both focused settings-error flows pass with zero skips. iPhone result is
.private/ios-test-20261026T233052Z-47912.xcresult; iPad result is
.private/ios-test-20261026T233230Z-49480.xcresult. The exact-one-error assertion,
Retry, save-error and saved states all passed. The strict evidence checker
validates seven fresh images per device, each inside its passing run window.
Current native source is cd41240f91ed59a901922fdd88dc35adecff890420c12c327cd1cc5752585897.

The prior 37-frame sets remain intact. A separate composite manifest verifies
37 current states per device: 30 accepted review 21 frames and seven fresh N4
frames. Each keeps its actual source fingerprint and receipt. This preserves
the checker's strict freshness requirement instead of pretending a focused run
produced all 37 frames. All 30 annotated comparisons use the composite data.
The new Retry label samples at 4.64:1 on its native fill on iPhone.

Automatic cleanup and coordinator handback completed at 23:34:20.671635Z,
208.796 seconds including cleanup, inside the ten-minute bound. Both devices
were Shutdown, no owned xcodebuild remained and the exact shared lock probed
free. SteadLog verified the receipt and is preparing its authorized ten-minute
web-only W1. No new heavy work starts here during that window.

Review 22 covers only N4 and its affected error/save states. All other scores
from review 21 are reused. No final Details score or next-screen acceptance
is inferred from passing tests.

### Review 22 Retry fixes and focused validation

Review 22 closed N4 but found N5, the stale load error after successful Retry,
and N6, the translucent iPad Retry label at 4.25:1. Other scores stay accepted.
Retry now clears self.error before loading and uses the shared solid accent
style. The test waits until Name is enabled and requires the old error to be
absent before capture. The patch remains two files; its reconstructed before
source matches cd41240f exactly.

The first compile attempt stopped before captures because the local error
binding shadowed the state property. The failed log and 5.953-second cleanup
receipt remain preserved. The explicit self.error correction ran under a NEW
bounded reservation, never extending the ended one.

Both corrected seven-frame flows pass with zero skips. Phone result is
.private/ios-test-20261026T235051Z-56342.xcresult; iPad is
.private/ios-test-20261026T235227Z-57066.xcresult. Exact current source is
a9d2bdfdd510b270043687545f649b2518985685acbe7246a0e79db3ce8be516.
Strict count-seven validation and the composite retain actual image/source/receipt
bindings. The new fourteen frames replace N4's fourteen; sixty accepted base
frames remain reused. Retry measures 5.91:1 on both devices, sampled inside its
solid fill. The recovered form has no error. All 32 comparisons are regenerated.

Automatic cleanup and coordinator handback completed at 23:54:26.086177Z,
215.108 seconds including cleanup, within the new ten-minute bound. Both owned
devices were Shutdown, no owned xcodebuild remained, and the exact shared lock
probed free. SteadLog's subsequent web-only W1 passed all 35 cases and released
at 23:57:34.062903Z. No heavy work remains active here. Review 23 is scoped to
N5 and N6. The native Details score is not inferred from these passing checks.

### Creation/settings accepted by Opus 5.5 High

Review 23 closes the full gate, with no blocker. Actual final Details scores are
9.2 on iPhone and 9.1 on iPad. Reused accepted scores are web creation/Details
9.1 and confirmations 9.2, native creation 9.2/9.1, and confirmations 9.2/9.0.
Every row is at least 9.0. No projection or averaging was used.

The reviewer independently reconstructed the patch, recomputed source a9d2bdfd,
verified both focused passes, all fourteen fresh hashes and times, all 74 composite
hashes, the absent stale banner, and the 5.91:1 opaque Retry on both devices.
Composite window bindings were not rechecked by this reviewer; the deterministic
composer had already verified them. Physical device, VoiceOver, hardware keyboard,
iOS 17 fallback, iPad compact widths and AX5 remain unverified.

The final report is archived in docs/evidence/design-review/settings-final-review.md.
No native rerun is needed for this accepted screen. The next screen is Avatar
editor, whose baseline scope and fixtures are being prepared offline. SteadLog
has requested its next separately coordinated iOS baseline window once ready.
No heavy work is active or imminent here during that preparation.
