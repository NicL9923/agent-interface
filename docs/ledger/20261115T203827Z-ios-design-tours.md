# November 15 iOS design tour validation

The baseline was commit `b76653696947476f068536a04f05ad4089fd4b68`, using Xcode 27.2 build 27B52 and an iPhone 18 Pro Max simulator running iOS 27.0. The 13 selected design tours ran with `TEST_RUNNER_AGENT_INTERFACE_SCREENSHOT_DIR` set through `.agents/tools/validate-ios.sh` and `-only-testing` for each tour. The run failed with 12 failures and one pass. Its local result bundle is `.private/ios-test-20261115T183549Z-42179.xcresult`.

The baseline did not exercise physical devices or the full iOS suite.

The selected recheck recorded iOS input fingerprint `b3f163795477b2c87870e3be27b593628a55284c579c531ac93f99d6d19748ac`. `testModelsDesignReview` passed, including the successful tools retry after the old error banner was cleared. The selected run failed overall; its local result bundle is `.private/ios-test-20261115T232712Z-67996.xcresult`.

For the deliberate red run, the retry button’s `error = nil` line was removed and `TEST_RUNNER_AGENT_INTERFACE_DESIGN_VARIANT=models-errors bash .agents/tools/validate-ios.sh 270DC27B-4FBD-444E-9EEE-B02E93AA696F test -only-testing:AgentInterfaceUITests/ScreenshotTourTests/testModelsDesignReview` failed at the assertion that the prior failure disappears. Its iOS input fingerprint was `b0b62c2e932453cff1d4b12f741c779821d68d4ec0289eebc0de2b2a0599aaa1`. The app file was restored byte for byte. The local result bundle is `.private/ios-test-20261116T022434Z-31340.xcresult`.
