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
