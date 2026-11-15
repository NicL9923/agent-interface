# November 15 accessibility gate red run

The accessibility change was checked at source fingerprint `sha256:2725c334b5824171d85e2ec07dd5a3efe4b9dbe06defadaf82241643d771f2ad`, based on commit `f271c5fa997e32f2c77d1cded4b98bc77ba586c7`. The browser ran on macOS arm64 with Node 24.22.2 and Playwright 1.64.1.

To check that axe catches an accessible-name regression, temporarily replaced the account button's name with `Account`, built the client, and ran `npx playwright test e2e/accessibility.spec.ts --project=chromium --grep '390px in light'`. The home scan failed with `label-content-name-mismatch` on `.home-account`. Restored the name and rebuilt. The final `check-all` browser suite passed all 83 tests, including all four accessibility combinations.

The full local check had three application-test failures because the Mac lacked the `127.0.0.2` loopback alias. It did not exercise a physical phone, real Hermes, or external services.
