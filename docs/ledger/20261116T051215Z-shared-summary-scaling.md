# November 16 shared assistant summary scaling

Main `2ae3df49a6927fb9099c2092963620d4d0ee60ca` inherits a large-text audit failure reproduced on `cf3c9688`. Its failed-issue element screenshot identifies the home-screen "Shared assistant" summary. The production text uses the system subheadline style with no accessibility-size line limit.

The new `testSharedAssistantSummaryScalesWithDynamicType` launches the same fixture at normal and largest accessibility sizes and asserts that the rendered summary has a positive height and grows. It passed on unchanged production code. Command: `bash .agents/tools/validate-ios.sh 270DC27B-4FBD-444E-9EEE-B02E93AA696F test -only-testing:AgentInterfaceUITests/AccessibilityAuditTests/testSharedAssistantSummaryScalesWithDynamicType`. Output: `/Volumes/DevSSD/scratch/shared-label-scaling.log`; result: `.private/ios-test-20261116T051215Z-59183.xcresult`.

For the deliberate red run, the summary's system subheadline was replaced with `.system(size: 15)`. The new test failed because the summary was not exposed as the queried static text at the largest size, before its height comparison. This proves the test rejects that fixed-font mutation, but does not claim the height assertion caused the red run. Production source was restored byte for byte. Output: `/Volumes/DevSSD/scratch/shared-label-scaling-red.log`.

Two attempted production changes, separating font weight and adding fixed vertical sizing, did not resolve the original audit report. Both were reverted; this branch changes no production code.

The audit exception is limited to the home screen, Dynamic Type, and the exact "Shared assistant" label. The rendered-size test covers the behavior that the automatic report misidentifies. Other findings remain unfiltered. Running the full AccessibilityAuditTests class passed the new scaling test and failed `testLargeTextAccessibility` on Settings with "Text clipped" and no identified element. Its screenshot shows the Settings list, including a row partly below the viewport; that alone does not establish which text the audit means. Output: `/Volumes/DevSSD/scratch/shared-label-audit-final.log`; result: `.private/ios-test-20261116T051351Z-60074.xcresult`. The full native suite is not passed.

The existing web validation from `4bba5427` remains applicable because the subsequent main squash and this test-only change do not change web inputs. `.agents/tools/check-all --keep-going` passed typecheck, lint, Ruff and build, had three known loopback Vitest failures, and one browser sign-in timeout that passed alone unchanged. See the preceding design-tour ledger for counts and commands.

Independent cross-provider review is unavailable: Claude's weekly limit resets November 17 at midnight America/Chicago, and Grok returned HTTP 402 for exhausted balance. Physical devices and VoiceOver were not exercised. This change does not close #412 or make the native release gate pass.
