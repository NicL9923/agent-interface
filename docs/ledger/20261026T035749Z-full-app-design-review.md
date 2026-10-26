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
