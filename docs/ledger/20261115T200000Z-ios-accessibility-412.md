# November 15 iOS accessibility findings

The implementation source fingerprint is `sha256:ac0a48216b66891599c0cd8ea1a4e590b0e7858aba17e7373460d6c7d82d6f5b`. The simulator was iPhone 18 Pro on iOS 27.0. The retained `ios/evidence/issue-412-before-settings-default.png` shows the baseline Settings toolbar. `ios/evidence/issue-412-after-home-xl.png` shows the corrected home-card wrapping in an intermediate build. That build also changed toolbars and navigation headers, which were reverted; the home image is evidence only of message wrapping. Other intermediate screenshots were removed from the branch.

The unfiltered XL audit failed on the home initials with `Dynamic Type font sizes are partially unsupported`. A diagnostic pass logged the remaining issue descriptions with a temporary handler, including nil elements for Settings element detection and the three Details clipping reports. It did not establish the identities of those elements or prove the remaining findings false positives.

For the email regression red run, the sufficient-element-description filter was removed and the new email accessibility label was temporarily removed. `bash .agents/tools/validate-ios.sh 39F5329D-FA70-4259-9B8A-6AECECDE2227 test -only-testing:AgentInterfaceUITests/AccessibilityAuditTests` failed with `Label not human-readable` at the Settings audit. The label was then restored. Output: `.private/ios-test-20261115T194404Z-20201.xcresult` and `/Volumes/DevSSD/scratch/a11y-email-red.log` on the Mac mini.

Physical-device, VoiceOver, and light-appearance contrast checks were not exercised. A later screenshot pixel measurement found 5.2:1 contrast for Settings Close on dark glass; this does not establish light-mode contrast. Full validation results are reported in the PR.

## Final cleanup and baseline comparison

The implementation and audit diff against `92b3fadc` has SHA256 `5bbe2f711d869ed9c346ea4eaea3f1f8788314c3238e601563a57682aa7e4591`. The cleanup restores the original fixed-size decorative avatar initials, removes the diagnostic print, and retains two relevant screenshots. The avatar is hidden from VoiceOver and its parent button is named "Account menu". The home card, account email, and Today text changes remain.

On that source state, `validate-ios.sh` ran the accessibility audit plus the four previously failing flow tests. The audit, AutomationFlowTests.testTaskEditRefusalRefreshesRunningState, and VaultFlowTests.testProfileLoginAddRemoveAndAvailableExternalSourceUnlock passed. ChatCardsFlowTests.testThreadCardEmailDraftAndFormSend and NativeFlowTests.testSeasonalAvatarChoicesSaveAndRemainSelected failed with seven failure reports. Output: `/Volumes/DevSSD/scratch/a11y-crops/ios-run.log`, result `.private/ios-test-20261115T214333Z-44981.xcresult`.

The same two failing tests were run on main `92b3fadc4f712a4338166c5f6184183fae54ca6c`. Both failed there with the same seven failure reports about controls behind the message box or not visible. These are baseline failures, not passes. Output: `/Volumes/DevSSD/scratch/a11y-crops/ios-main.log`; result: `/Volumes/DevSSD/scratch/ai-ios-main/.private/ios-test-20261115T223241Z-73771.xcresult`. No assertions were weakened.

The earlier check-all results remain applicable because cleanup changed only native code and audit comments. The existing #412 filters for unresolved findings remain; this PR does not close #412. Claude reviewed the original OpenAI implementation and made the cleanup; GPT-6.1 Sol reviewed that cleanup against main and the recorded baseline run. No additional external review was available because xAI had exhausted its balance and Claude had reached its weekly limit.
