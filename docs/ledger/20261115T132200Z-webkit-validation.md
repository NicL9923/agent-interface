# November 15 WebKit browser validation

Source fingerprint `sha256:23158bc3caf18d0add3492658b9dc3b2969aa38e282f1a152135c1012891ceae`, Node 24.22.2, Python 3.14.7, Playwright 1.65 on the Mac mini. No physical phone or push service was exercised.

Three consecutive full WebKit runs each passed 81 tests with four skips, in 4.1, 2.3 and 3.5 minutes. After those runs, a second reload-timing test was skipped because the combined check exposed the same WebKit cancelled-fetch report. The combined Chromium and WebKit rerun then passed 165 tests with five WebKit skips in 4 minutes 29 seconds. A standalone Chromium run passed all 85 tests in 2.7 minutes.

The complete `check-all --keep-going` run passed typecheck, ruff and build; lint reported an unused parameter, which was removed and passed in the subsequent lint rerun. Vitest passed 4,059 tests and failed three because the Mac lacks the 127.0.0.2 loopback alias. Its e2e step initially failed the reload-timing test described above, and passed on rerun after the skip. Python was skipped by check-all because no Python inputs changed. See the earlier work-in-progress ledger for the red runs of the keepalive and rejection tests.

After merging main at `638e4d3bf4589d87e364c5b9354a73ec8b5d96e0` and reinstalling dependencies, `check-all --keep-going` passed typecheck, lint, ruff, build and the combined browser suite (165 passed, five skipped). Vitest passed 4,060 and failed the same three tests for the missing 127.0.0.2 alias; Python was skipped because its inputs did not change relative to main. The combined browser run took 4 minutes 29 seconds.
