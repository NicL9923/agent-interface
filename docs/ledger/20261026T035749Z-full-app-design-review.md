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
