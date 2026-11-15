# November 15 iOS accessibility findings

The implementation source fingerprint is `sha256:ac0a48216b66891599c0cd8ea1a4e590b0e7858aba17e7373460d6c7d82d6f5b`. The simulator was iPhone 18 Pro on iOS 27.0. The screenshots in `ios/evidence/issue-412-before-*` show the baseline, and `issue-412-after-*` show an intermediate build. That intermediate build also changed the toolbar buttons and navigation headers; those changes were reverted before the fingerprint above, so those images are not evidence of the final toolbar or header appearance.

The unfiltered XL audit failed on the home initials with `Dynamic Type font sizes are partially unsupported`. A diagnostic pass logged the remaining issue descriptions with a temporary handler, including nil elements for Settings element detection and the three Details clipping reports. It did not establish the identities of those elements or prove the remaining findings false positives.

For the email regression red run, the sufficient-element-description filter was removed and the new email accessibility label was temporarily removed. `bash .agents/tools/validate-ios.sh 39F5329D-FA70-4259-9B8A-6AECECDE2227 test -only-testing:AgentInterfaceUITests/AccessibilityAuditTests` failed with `Label not human-readable` at the Settings audit. The label was then restored. Output: `.private/ios-test-20261115T194404Z-20201.xcresult` and `/Volumes/DevSSD/scratch/a11y-email-red.log` on the Mac mini.

Physical-device, VoiceOver, light-appearance contrast, and contrast pixel measurements were not exercised. Full validation results are reported in the PR.
